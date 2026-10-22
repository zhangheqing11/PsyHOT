"""Compatibility fixes for the pinned upstream HTTP login adapter."""
import time
from pathlib import Path


def qr_login(self, callback=None, notice=None):
    """Backport upstream a76517b's startlogin flow; never invent a server UUID."""
    self.__init__()
    if self.check_lock():
        return {'code': None, 'is_exists': False, 'msg': '登录二维码正在使用'}
    with self._lock:
        self.login_callback = callback
        self.notice_callback = notice
        try:
            self.fingerprint = self._generate_uuid()
            response = self.session.post(
                self.base_url + '/cgi-bin/bizlogin', params={'action': 'startlogin'},
                data={'fingerprint': self.fingerprint, 'token': '', 'lang': 'zh_CN',
                      'f': 'json', 'ajax': '1', 'login_type': '3',
                      'redirect_url': '/cgi-bin/home?t=home/index&lang=zh_CN'}, timeout=15)
            response.raise_for_status()
            uuid = self.session.cookies.get('uuid')
            if not uuid:
                return {'code': None, 'is_exists': False, 'msg': '登录握手未返回会话标识'}
            self.cookies = {'fingerprint': self.fingerprint}
            response = self.session.get(
                self.base_url + '/cgi-bin/scanloginqrcode',
                params={'action': 'getqrcode', 'uuid': uuid, 'random': int(time.time() * 1000)},
                timeout=15, allow_redirects=False)
            response.raise_for_status()
            png_or_jpeg = response.content.startswith((b'\x89PNG\r\n\x1a\n', b'\xff\xd8'))
            if 'image/' not in response.headers.get('Content-Type', '') or not png_or_jpeg:
                return {'code': None, 'is_exists': False, 'msg': '登录服务未返回二维码图片'}
            target = Path(self.qr_code_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(response.content)
            target.chmod(0o600)
            self.set_lock()
            self._start_login_check(uuid)
            if notice:
                notice()
            return {'code': str(target), 'is_exists': True, 'msg': '请扫描并选择微信公众号'}
        except Exception as exc:
            # Remote response text can contain login identifiers; expose the class only.
            return {'code': None, 'is_exists': False, 'msg': '二维码生成失败: ' + type(exc).__name__}


def install(adapter):
    from driver.wx_api import WeChatAPI
    if not isinstance(adapter, WeChatAPI):
        return

    original_account_info = WeChatAPI._get_account_info
    WeChatAPI.get_qr_code = qr_login

    def account_info(self):
        info = original_account_info(self)
        if info:
            return info
        # switchacct metadata is optional. Require a successful authenticated
        # searchbiz response before saving the session through upstream helpers.
        if not self.token:
            return None
        response = self.session.get(
            self.base_url + "/cgi-bin/searchbiz",
            params={"action": "search_biz", "begin": 0, "count": 1,
                    "query": "中国心理卫生协会", "token": self.token,
                    "lang": "zh_CN", "f": "json", "ajax": 1},
            headers={"Referer": self.home_url + "?token=" + self.token},
            timeout=20,
        )
        response.raise_for_status()
        result = response.json()
        code = result.get("base_resp", {}).get("ret")
        print(f"Authenticated search verification returned: {code}")
        if code != 0 or not isinstance(result.get("list"), list):
            return None
        from driver.cookies import expire
        from driver.store import Store
        from driver.token import set_token
        cookies = self._convert_cookies_to_list()
        self.cookies = {c.name: c.value for c in self.session.cookies}
        info = {"wx_app_name": "微信授权会话（账号列表接口不可用）", "wx_logo": ""}
        data = {"cookies": cookies, "cookies_str": self._format_cookies_string(),
                "token": self.token, "fingerprint": self.fingerprint,
                "wx_login_url": self.qr_code_path, "expiry": expire(cookies)}
        Store.save(cookies)
        set_token(data, info)
        if self.login_callback:
            self.login_callback(data, info)
        return info

    def handle_success(self):
        try:
            self._extract_login_info()
            info = self._get_account_info()
            self.is_logged_in = bool(info)
            self._islogin = bool(info)
            if info:
                self._clean_qr_code()
            else:
                self._clean_qr_code()
                print("扫码已确认，但微信授权验证失败；没有保存授权")
            return bool(info)
        except Exception:
            self.is_logged_in = False
            self._islogin = False
            self._clean_qr_code()
            print("微信授权验证失败；没有保存授权")
            return False

    WeChatAPI._get_account_info = account_info
    WeChatAPI._handle_login_success = handle_success


def restore_saved_session(adapter):
    """Restore UI login state only after a real authenticated server response."""
    from driver.wx_api import WeChatAPI
    from driver.token import _get_token_data
    from driver.success import setStatus
    import json, time
    from pathlib import Path
    if not isinstance(adapter, WeChatAPI):
        return
    data = _get_token_data() or {}
    expiry = (data.get("expiry") or {}).get("expiry_timestamp", 0)
    valid = False
    try:
        if data.get("token") and expiry > time.time():
            response = adapter.session.get(
                adapter.base_url + "/cgi-bin/searchbiz",
                params={"action":"search_biz", "begin":0, "count":1,
                        "query":"gh_04251f4c2ba8", "token":data["token"],
                        "lang":"zh_CN", "f":"json", "ajax":1},
                headers={"Cookie":data.get("cookie", "")}, timeout=20)
            response.raise_for_status()
            result = response.json()
            valid = result.get("base_resp", {}).get("ret") == 0 and isinstance(result.get("list"), list)
    except Exception:
        pass
    if valid:
        adapter.token = data["token"]
        adapter.cookies = adapter._cookie_string_to_dict(data.get("cookie", ""))
        adapter.session.cookies.update(adapter.cookies)
    adapter._islogin = valid
    adapter.is_logged_in = valid
    setStatus(valid)
    p = Path("/app/data/psyhot-auth-check.json")
    p.write_text(json.dumps({"valid":valid, "checked_at":time.time()}))
    p.chmod(0o600)
