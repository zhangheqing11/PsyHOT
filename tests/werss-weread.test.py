"""Run with python tests/werss-weread.test.py (requires beautifulsoup4 and requests)."""
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy' / 'werss'))
from verified_weread import ReadError, parse_article, cache_complete


class ArticleVerification(unittest.TestCase):
    feed = 'MP_WXS_12345'
    published = int(time.time()) - 86400

    def page(self, biz='MTIzNDU=', date=None, body=None):
        date = self.published if date is None else date
        return (f'<meta property="og:url" content="http://mp.weixin.qq.com/s?__biz={biz}&amp;mid=123&amp;idx=1&amp;sn=abc">'
                '<meta property="og:title" content="心理学研究">'
                f'<script>var ct = "{date}";</script>'
                f'<div id="js_content">{body or "正文中的研究方法和结果。" * 30}</div>')

    def test_original_date_and_canonical_identity_survive(self):
        item = parse_article(self.page(), self.feed)
        self.assertEqual(item['publish_time'], self.published)
        self.assertTrue(item['url'].startswith('https://mp.weixin.qq.com/s?'))
        self.assertGreater(len(item['content']), 280)
        self.assertNotIn('<script', item['content'])

    def test_wrong_publisher_cannot_enter_cache(self):
        with self.assertRaises(ReadError):
            parse_article(self.page(biz='OTk5'), self.feed)

    def test_auth_error_keeps_original_code(self):
        with self.assertRaises(ReadError) as ctx:
            parse_article('{"errCode":-2012,"errMsg":"登录超时"}', self.feed)
        self.assertEqual(ctx.exception.code, -2012)

    def test_missing_body_or_original_date_is_not_success(self):
        for html in [self.page(body='环境异常'), self.page(date=''), self.page(date=int(time.time()) + 7200)]:
            with self.subTest(html=html[:50]), self.assertRaises(ReadError):
                parse_article(html, self.feed)

    def test_short_link_is_not_accepted_as_publisher_proof(self):
        with self.assertRaises(ReadError):
            parse_article(self.page().replace('/s?__biz=MTIzNDU=&amp;mid=123&amp;idx=1&amp;sn=abc', '/s/unverified'), self.feed)

    def test_existing_title_only_article_must_retry(self):
        row = SimpleNamespace(**parse_article(self.page(), self.feed), extinfo='{}', has_content=0)
        self.assertFalse(cache_complete(row, self.feed))
        row.extinfo = '{"psyhot_weread_verified":true}'
        self.assertFalse(cache_complete(row, self.feed))
        row.has_content = 1
        self.assertTrue(cache_complete(row, self.feed))
        row.content = ''
        self.assertFalse(cache_complete(row, self.feed))


if __name__ == '__main__':
    unittest.main()
