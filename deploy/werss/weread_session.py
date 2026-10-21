"""Maintain the authorized WeRead web session through its normal bookshelf page."""
import asyncio
import json
import time
from http.cookies import SimpleCookie
from pathlib import Path


def healthy_shelf(payload):
    return (isinstance(payload, dict) and not payload.get('errCode', payload.get('errcode', 0))
            and any(key in payload for key in ('books', 'bookCount', 'synckey')))


async def _refresh():
    from core.config import Config
    from playwright.async_api import async_playwright
    path = '/app/data/wx.lic'
    config = Config(path)
    data = config.get('weread_data', {})
    data = json.loads(data) if isinstance(data, str) else data
    before = data.get('cookie', '')
    if not before:
        return {'valid': False, 'reason': 'authorization_missing'}
    jar = SimpleCookie()
    jar.load(before)
    async with async_playwright() as playwright:
        browser = await playwright.webkit.launch(headless=True)
        try:
            context = await browser.new_context()
            await context.add_cookies([{'name': k, 'value': v.value, 'domain': '.weread.qq.com',
                                       'path': '/', 'secure': True} for k, v in jar.items()])
            page = await context.new_page()
            await page.goto('https://weread.qq.com/web/shelf', wait_until='domcontentloaded', timeout=30000)
            await page.wait_for_timeout(4000)
            response = await context.request.get('https://weread.qq.com/web/shelf/sync',
                                                params={'userVid': '', 'synckey': 0}, timeout=20000)
            if response.status != 200 or not healthy_shelf(await response.json()):
                return {'valid': False, 'reason': 'authorization_rejected'}
            cookies = await context.cookies('https://weread.qq.com/')
            # Preserve a newer manual login and unrelated authorization fields.
            config.reload()
            current = config.get('weread_data', {})
            current = json.loads(current) if isinstance(current, str) else current
            if current.get('cookie', '') != before:
                return {'valid': False, 'reason': 'credentials_changed_during_refresh'}
            current['cookie'] = '; '.join(c['name'] + '=' + c['value'] for c in cookies)
            current['user_agent'] = await page.evaluate('navigator.userAgent')
            config.set('weread_data', current)
            config.save_config()
            return {'valid': True, 'reason': 'browser_session_refreshed'}
        finally:
            await browser.close()


def refresh_weread():
    try:
        result = asyncio.run(_refresh())
    except Exception as exc:
        result = {'valid': False, 'reason': type(exc).__name__}
    result['checked_at'] = time.time()
    target = Path('/app/data/psyhot-weread-session-check.json')
    target.write_text(json.dumps(result))
    target.chmod(0o600)
    print(json.dumps({'wereadSession': result}))
    return result
