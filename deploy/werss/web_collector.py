import json
import requests
import time
import random
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
import yaml
import re
from bs4 import BeautifulSoup
from core.wx.base import WxGather
from core.print import print_error, print_warning, print_info
from core.log import logger
# 继承 BaseGather 类
class MpsWeb(WxGather):

    # 重写 content_extract 方法
    def content_extract(self,  url):
        try:
            from driver.wxarticle import Web as App
            r = App.get_article_content(url)
            if r!=None:
                text = r.get("content","")
                text=self.remove_common_html_elements(text)
                return  text
        except Exception as e:
            logger.error(e)
        return ""
    def fix_header(self, url):
        # Keep the HTTP login adapter's request identity and send the actual header name.
        headers = self.headers.copy()
        headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=" + self.token,
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9",
        })
        headers.pop("Refer", None)
        return headers

    # 重写 get_Articles 方法
    def get_Articles(self, faker_id:str='',Mps_id:str='',Mps_title="",CallBack=None,start_page:int=0,MaxPage:int=1,interval=10,Gather_Content=False,Item_Over_CallBack=None,Over_CallBack=None):
        from driver.token import _get_token_data
        auth = _get_token_data() or {}
        expiry = (auth.get('expiry') or {}).get('expiry_timestamp', 0)
        if not auth.get('token') or not expiry or expiry <= time.time():
            print_warning('PsyHOT: WeChat authorization expired; waiting for operator login')
            return
        # One shared cooldown: a rate limit on any account pauses all account requests.
        limit_file = Path('/app/data/psyhot-rate-limit.json')
        if limit_file.exists():
            if float(json.loads(limit_file.read_text()).get('until', 0)) > time.time():
                print_warning('PsyHOT: account collection paused during shared cooldown')
                return
        super().Start(mp_id=Mps_id)
        Gather_Content = self.Gather_Content
        print(f"Web浏览器模式,是否采集[{Mps_title}]内容：{Gather_Content}\n")
        # 请求参数
        url = "https://mp.weixin.qq.com/cgi-bin/appmsgpublish"
        count=5
        params = {
        "sub": "list",
        "sub_action": "list_ex",
        "search_field": "null",
        "query": "",
        "type": "101_1",
        "free_publish_type": 1,
        "begin":start_page,
        "count": count,
        "fakeid": faker_id,
        "token": self.token,
        "lang": "zh_CN",
        "f": "json",
        "ajax": 1
    }
        # 连接超时
        session=self.session
        # 起始页数
        i = start_page
        retry_count = 0
        max_retries = 1
        while True:
            if i >= MaxPage:
                break
            begin = i * count
            params["begin"] = str(begin)
            print(f"第{i+1}页开始爬取\n")
            # 随机暂停几秒，避免过快的请求导致过快的被查到
            time.sleep(random.randint(0,interval))
            try:
                headers = self.fix_header(url)
                resp = session.get(url, headers=headers, params = params, verify=True, timeout=(10, 30))

                msg = resp.json()
                self._cookies =resp.cookies
                # 流量控制了, 退出
                if msg['base_resp']['ret'] == 200013:
                    limit_file.write_text(json.dumps({'until': time.time() + 21600, 'ret': 200013}))
                    limit_file.chmod(0o600)
                    retry_count += 1
                    if retry_count < max_retries:
                        print_warning(f"频率限制, 第{retry_count}次重试...")
                        time.sleep(60 * retry_count)
                        continue
                    super().Error("frequencey control, stop at {}".format(str(begin)))
                    break

                if msg['base_resp']['ret'] == 200003:
                    super().Error("Invalid Session, stop at {}".format(str(begin)),code="Invalid Session")
                    break
                # 处理200002错误：参数无效
                if msg['base_resp']['ret'] == 200002:
                    super().Error("Invalid arguments, stop at {}".format(str(begin)), code="Invalid Arguments")
                    # 设置feed状态为0并继续下一个任务
                    self._set_feed_status(Mps_id, 0)
                    # 不break，而是return，这样可以继续下一个任务
                    super().Item_Over(item={"mps_id":Mps_id,"mps_title":Mps_title},CallBack=Item_Over_CallBack)
                    super().Over(CallBack=Over_CallBack)
                    return
                if msg['base_resp']['ret'] != 0:
                    # 检测是否因为接口被限制，尝试降级到 free_publish
                    err_msg = msg['base_resp'].get('err_msg','')
                    print_warning(f"appmsgpublish 返回错误(ret={msg['base_resp']['ret']}): {err_msg}")
                    print_info("检测到 appmsgpublish 接口不可用，自动降级到 free_publish 模式...")
                    self._fallback_to_free_publish(faker_id, Mps_id, Mps_title, CallBack,
                                                    start_page, MaxPage, interval,
                                                    Gather_Content, Item_Over_CallBack, Over_CallBack)
                    return
                # 如果返回的内容中为空则结束
                if 'publish_page' not in msg:
                    super().Error("all ariticle parsed")
                    break
                if msg['base_resp']['ret'] != 0:
                    super().Error("错误原因:{}:代码:{}".format(msg['base_resp']['err_msg'],msg['base_resp']['ret']))
                    break
                if "publish_page" in msg:
                    msg["publish_page"]=json.loads(msg['publish_page'])
                    for item in msg["publish_page"]['publish_list']:
                        if "publish_info" in item:
                            publish_info= json.loads(item['publish_info'])

                            if "appmsgex" in publish_info:
                                # info = '"{}","{}","{}","{}"'.format(str(item["aid"]), item['title'], item['link'], str(item['create_time']))
                                for item in publish_info["appmsgex"]:
                                    link = urlsplit(item.get('link', ''))
                                    if link.scheme != 'https' or link.hostname != 'mp.weixin.qq.com' or parse_qs(link.query).get('__biz') != [faker_id]:
                                        print_warning('PsyHOT: publisher identity mismatch; article discarded')
                                        continue
                                    if Gather_Content:
                                        if not super().HasGathered(item["aid"]):
                                            item["content"] = self.content_extract(item['link'])
                                            super().Wait(3,10,tips=f"{item['title']} 采集完成")
                                    else:
                                        item["content"] = ""
                                    item["publish_info"] = publish_info.get("publish_info","")
                                    item["id"] = item["aid"]
                                    item["mp_id"] = Mps_id
                                    if CallBack is not None:
                                        super().FillBack(CallBack=CallBack,data=item,Ext_Data={"mp_title":Mps_title,"mp_id":Mps_id})
                    print(f"第{i+1}页爬取成功\n")
                # 翻页
                i += 1
            except requests.exceptions.Timeout:
                print("Request timed out")
                break
            except requests.exceptions.RequestException as e:
                print(f"Request error: {e}")
                break
            finally:
                super().Item_Over(item={"mps_id":Mps_id,"mps_title":Mps_title},CallBack=Item_Over_CallBack)
        super().Over(CallBack=Over_CallBack)
        pass
    def _fallback_to_free_publish(self, faker_id, Mps_id, Mps_title, CallBack,
                                   start_page, MaxPage, interval,
                                   Gather_Content, Item_Over_CallBack, Over_CallBack):
        """降级到 free_publish 多端点模式"""
        try:
            print_info("===== 自动降级到 free_publish 多端点模式 =====")
            from core.wx.model.free_publish import MpsFreePublish
            fp = MpsFreePublish()
            fp.token = self.token
            fp.cookies = self.cookies
            fp.session = self.session
            fp.get_Articles(
                faker_id=faker_id,
                Mps_id=Mps_id,
                Mps_title=Mps_title,
                CallBack=CallBack,
                start_page=start_page,
                MaxPage=MaxPage,
                interval=interval,
                Gather_Content=Gather_Content,
                Item_Over_CallBack=Item_Over_CallBack,
                Over_CallBack=Over_CallBack,
            )
        except Exception as e:
            print_error(f"降级到 free_publish 失败: {e}")
            super().Error(f"所有采集方式均失败: {e}")

    # 新增辅助方法用于设置feed状态
    def _set_feed_status(self, feed_id: str, status: int):
        """设置feed状态"""
        try:
            from core.db import DB
            from core.models import Feed
            session = DB.get_session()
            feed = session.query(Feed).filter(Feed.id == feed_id).first()
            if feed:
                feed.status = status
                session.commit()
                print(f"已将feed {feed_id} 的状态设置为 {status}")
            else:
                print(f"未找到feed {feed_id}")
        except Exception as e:
            logger.error(f"设置feed状态失败: {e}")
