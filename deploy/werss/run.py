"""Private WeRSS instance with redacted diagnostics and a bounded fixed-account schedule."""
import json
import os
import re
import runpy
import sys


class RedactedStream:
    def __init__(self, stream):
        self.stream = stream
        self.secrets = [v for k, v in os.environ.items() if re.search(r'PASSWORD|SECRET|TOKEN|COOKIE|API_KEY', k, re.I) and len(v) >= 8]

    def write(self, text):
        for value in self.secrets:
            text = text.replace(value, '[redacted]')
        text = re.sub(r'[^\n]*(?:token|cookie|secret|password|authorization|slave_sid|slave_user|bizuin|data_ticket|uuid|fingerprint|binduin)["\x27]?\s*[:=][^\n]*', '[redacted sensitive diagnostic]', text, flags=re.I)
        self.stream.write(text)
        return len(text)

    def __getattr__(self, name):
        return getattr(self.stream, name)


sys.stdout = RedactedStream(sys.stdout)
sys.stderr = RedactedStream(sys.stderr)
sys.path.insert(0, '/app')
import apis.auth
from driver.base import WX_API
from auth_adapter import install, restore_saved_session
apis.auth.WX_API = WX_API
install(WX_API)
from verified_weread import install as install_verified_weread
install_verified_weread()
from web import app
from async_collect import install as install_async_collect
install_async_collect(app)


def install_fixed_jobs(accounts):
    # Keep the operator's selected collector for the fixed registry.
    import jobs.mps as jobs
    from core.wx import WxGather
    from jobs.article import UpdateArticle, Update_Over
    fixed_ids = {account['feedId'] for account in accounts}
    original = jobs.do_job

    def collect(mp=None, task=None, isTest=False):
        if isTest or not mp or mp.id not in fixed_ids:
            return original(mp, task, isTest)
        collector = WxGather().Model()
        try:
            collector.get_Articles(mp.faker_id, Mps_id=mp.id, Mps_title=mp.mp_name,
                                   CallBack=UpdateArticle, Over_CallBack=Update_Over,
                                   MaxPage=1, interval=30)
        finally:
            print(json.dumps({'werssFeed': mp.id, 'cachedArticles': collector.all_count()}))

    jobs.do_job = collect


async def initialize():
    import asyncio
    from datetime import datetime
    from core.db import DB
    from core.models.feed import Feed
    from core.models.message_task import MessageTask
    from jobs.mps import start_job, scheduler
    accounts = json.load(open('/app/psyhot/accounts.json'))['sources']
    install_fixed_jobs(accounts)
    session = DB.get_session()
    try:
        for account in accounts:
            if not session.query(Feed).filter(Feed.id == account['feedId']).first():
                session.add(Feed(id=account['feedId'], mp_name=account['name'], faker_id=account['biz'], mp_cover='', mp_intro='', status=1,
                                 sync_time=0, update_time=0, created_at=datetime.now(), updated_at=datetime.now()))
        task = session.query(MessageTask).filter(MessageTask.id == 'psyhot-fixed-wechat').first()
        if not task:
            task = MessageTask(id='psyhot-fixed-wechat', name='PsyHOT 固定公众号（09:15、18:15）', message_type=0,
                               message_template='', web_hook_url='', headers='', cookies='',
                               mps_id=json.dumps([{'id': a['feedId']} for a in accounts]), cron_exp='15 9,18 * * *', status=1)
            session.add(task)
        session.commit()
        # Only enable this fixed feed task; no third-party notification or broad automatic discovery.
        if not scheduler._scheduler.get_job(task.id):
            start_job(job_id=task.id)
        from core.config import cfg
        if cfg.get('gather.model') == 'weread_mp':
            from weread_session import refresh_weread
            if not scheduler._scheduler.get_job('psyhot-weread-session'):
                scheduler.add_cron_job(refresh_weread, cron_expr='*/30 * * * *',
                                       job_id='psyhot-weread-session', tag='微信读书会话维护')
            asyncio.create_task(asyncio.to_thread(refresh_weread))
        print(json.dumps({'werssFixedAccounts': len(accounts), 'scheduled': bool(scheduler._scheduler.get_job(task.id))}))
    finally:
        session.close()
    await asyncio.to_thread(restore_saved_session, WX_API)


app.add_event_handler('startup', initialize)
runpy.run_path('/app/main.py', run_name='__main__')
