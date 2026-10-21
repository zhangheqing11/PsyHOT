"""WeRead increment collection with verified publisher, original date and complete body."""
import base64
import hashlib
import json
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import requests
from bs4 import BeautifulSoup


class ReadError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def publisher_url(url, feed):
    match = re.fullmatch(r'MP_WXS_(\d+)', feed)
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    expected = base64.b64encode(match[1].encode()).decode() if match else ''
    if (not expected or parts.scheme not in ('http', 'https') or parts.netloc != 'mp.weixin.qq.com'
            or parts.path != '/s' or query.get('__biz') != [expected]
            or not re.fullmatch(r'\d+', query.get('mid', [''])[0])
            or not re.fullmatch(r'[1-9]\d*', query.get('idx', [''])[0])):
        raise ReadError('publisher_mismatch', 'Original article publisher does not match the fixed feed')
    return 'https://mp.weixin.qq.com/s?' + urlencode({k: query[k][0] for k in ('__biz', 'mid', 'idx', 'sn') if k in query})


def parse_article(html, feed):
    if html.lstrip().startswith('{'):
        payload = json.loads(html)
        code = payload.get('errCode', payload.get('errcode'))
        raise ReadError(code or 'invalid_content', 'WeRead did not return an article body')
    soup = BeautifulSoup(html, 'html.parser')
    canonical = soup.select_one('meta[property="og:url"]')
    title = soup.select_one('meta[property="og:title"]') or soup.select_one('#activity-name')
    body = soup.select_one('#js_content') or soup.select_one('.rich_media_content')
    date = re.search(r'\bvar\s+ct\s*=\s*["\x27]?(\d{10})\b', html)
    if not canonical or not title or not body or not date:
        raise ReadError('incomplete_article', 'Missing original identity, date or article body')
    published = int(date[1])
    if not 1262304000 <= published <= time.time() + 3600:
        raise ReadError('invalid_date', 'Original publication date is invalid')
    for element in body.select('script, style'):
        element.decompose()
    text = body.get_text(' ', strip=True)
    if len(text) < 280 or re.search('当前环境异常|完成验证后即可继续访问|该内容已被发布者删除', text):
        raise ReadError('incomplete_article', 'WeRead returned an incomplete or verification page')
    for img in body.select('img[data-src]'):
        img['src'] = img['data-src']
    return {'title': title.get('content') or title.get_text(strip=True),
            'url': publisher_url(canonical.get('content', ''), feed),
            'publish_time': published, 'content': body.decode_contents(), 'description': text[:500]}


def article_info(row):
    try:
        value = json.loads(row.extinfo or '{}') if row else {}
    except (ValueError, TypeError):
        value = None
    return value if isinstance(value, dict) else {'legacy_extinfo': row.extinfo}


def cache_complete(row, feed):
    if not row or not article_info(row).get('psyhot_weread_verified') or not row.has_content:
        return False
    try:
        publisher_url(row.url, feed)
        return (1262304000 <= int(row.publish_time or 0) <= time.time() + 3600
                and len(BeautifulSoup(row.content or '', 'html.parser').get_text(strip=True)) >= 280)
    except (ReadError, ValueError, TypeError):
        return False


def install():
    from core.db import DB
    from core.models.article import Article
    from core.models.feed import Feed
    from core.wx.model import weread_mp as upstream

    class VerifiedWereadMP(upstream.MpsWereadMP):
        def get_Articles(self, faker_id=None, Mps_id=None, Mps_title='', CallBack=None,
                         start_page=0, MaxPage=1, interval=3, Gather_Content=True,
                         Item_Over_CallBack=None, Over_CallBack=None):
            self.articles = []
            self.start_time = time.time()
            self._load_weread_auth()
            from core.config import Config
            auth_data = Config('/app/data/wx.lic').get('weread_data', {})
            auth_data = json.loads(auth_data) if isinstance(auth_data, str) else auth_data
            if auth_data.get('user_agent'):
                self.user_agent = auth_data['user_agent']
            feed = Mps_id or faker_id
            marker = Path('/app/data/psyhot-weread-cooldown.json')
            credential_id = hashlib.sha256(self._weread_cookies.encode()).hexdigest()
            session = DB.get_session()
            try:
                cooldown = json.loads(marker.read_text()) if marker.exists() else {}
                if cooldown.get('credential_id') == credential_id and cooldown.get('until', 0) > time.time():
                    raise ReadError('authorization_cooldown', 'WeRead authorization requires renewal; collection is paused')
                if not self._weread_cookies:
                    raise ReadError(-2012, 'WeRead authorization is missing')
                cover = self._get_mp_cover(feed)
                review = cover.get('reviewId') or ''
                if not review.startswith(feed + '_'):
                    raise ReadError('publisher_mismatch', 'WeRead review identity does not match the fixed feed')
                stored_id = f'{feed}-{review}'.replace('MP_WXS_', '')
                row = session.query(Article).filter(Article.id == stored_id, Article.mp_id == feed).first()
                info = article_info(row)
                if cache_complete(row, feed):
                    published = row.publish_time
                    session.close()
                    self.update_mps(feed, Feed(update_time=published))
                    return
                time.sleep(max(2, self._get_content_interval()))
                response = requests.get('https://weread.qq.com/web/mp/content', params={'reviewId': review},
                                        headers=self._request_headers(), timeout=(10, 30), allow_redirects=False)
                if response.status_code != 200:
                    raise ReadError(response.status_code, f'WeRead body HTTP {response.status_code}')
                item = parse_article(response.text, feed)
                item.update({'id': review, 'mp_id': feed, 'pic_url': cover.get('pic') or ''})
                if row is None:
                    from datetime import datetime
                    row = Article(id=stored_id, mp_id=feed, created_at=datetime.now(), is_read=0, is_favorite=0)
                    session.add(row)
                for key in ('title', 'url', 'publish_time', 'content', 'description', 'pic_url'):
                    setattr(row, key, item[key])
                row.has_content = 1
                row.status = 1
                row.updated_at = int(time.time())
                row.updated_at_millis = int(time.time() * 1000)
                row.extinfo = json.dumps({**info, 'psyhot_weread_verified': True, 'reviewId': review})
                session.commit()
                self.articles = [item]
                if CallBack:
                    CallBack(item)
                self.update_mps(feed, Feed(update_time=item['publish_time']))
                if Item_Over_CallBack:
                    Item_Over_CallBack(item)
            except (ReadError, upstream.WereadMPAPIError) as exc:
                session.rollback()
                if exc.code in (-2012, -2010, -2041, 401, 403, 429, 499):
                    marker.write_text(json.dumps({'credential_id': credential_id, 'until': time.time() + 1800}))
                    marker.chmod(0o600)
                raise upstream.WereadMPAPIError(exc.code, str(exc), retriable=exc.code not in (-2012, -2010, -2041)) from exc
            finally:
                session.close()
                self.Over(CallBack=Over_CallBack)

    upstream.MpsWereadMP = VerifiedWereadMP
