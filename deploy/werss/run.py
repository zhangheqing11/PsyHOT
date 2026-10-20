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
from web import app


async def initialize():
    import asyncio
    from datetime import datetime
    from core.db import DB
    from core.models.feed import Feed
    from core.models.message_task import MessageTask
    from jobs.mps import start_job, scheduler
    accounts = json.load(open('/app/psyhot/accounts.json'))['sources']
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
        start_job(job_id=task.id)
        print(json.dumps({'werssFixedAccounts': len(accounts), 'scheduled': bool(scheduler._scheduler.get_job(task.id))}))
    finally:
        session.close()
    await asyncio.to_thread(restore_saved_session, WX_API)


app.add_event_handler('startup', initialize)
runpy.run_path('/app/main.py', run_name='__main__')
