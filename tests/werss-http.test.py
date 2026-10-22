"""Run directly; requires fastapi and httpx in the private WeRSS test environment."""
import asyncio
import sys
import threading
import unittest
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy' / 'werss'))
from async_collect import install


class CollectionHttp(unittest.IsolatedAsyncioTestCase):
    async def test_offload_preserves_authentication_and_body_validation(self):
        app = FastAPI()
        calls = []

        def user(authorization: str | None = Header(default=None)):
            if authorization != 'Bearer test-only':
                raise HTTPException(401)
            return 'operator'

        @app.post('/api/v1/wx/weread/collect')
        async def collect(req: dict, current_user=Depends(user)):
            calls.append(req)
            return {'operator': current_user, 'mp_id': req['mp_id']}

        install(app)
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            self.assertEqual((await client.post('/api/v1/wx/weread/collect', json={})).status_code, 401)
            headers = {'Authorization': 'Bearer test-only'}
            self.assertEqual((await client.post('/api/v1/wx/weread/collect', headers=headers, json=[])).status_code, 422)
            self.assertEqual(calls, [])
            response = await client.post('/api/v1/wx/weread/collect', headers=headers, json={'mp_id': 'MP_WXS_123'})
        self.assertEqual(response.json(), {'operator': 'operator', 'mp_id': 'MP_WXS_123'})

    async def test_slow_collection_does_not_block_status_and_remains_serial(self):
        app = FastAPI()
        started = threading.Event()
        release = threading.Event()
        completed = threading.Event()
        active = 0
        maximum = 0
        worker_threads = []

        @app.post('/api/v1/wx/weread/collect')
        async def collect():
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            worker_threads.append(threading.get_ident())
            started.set()
            release.wait(1)
            active -= 1
            completed.set()
            return {'collected': 1}

        @app.get('/status')
        async def status():
            return {'collector_finished': completed.is_set()}

        install(app)
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            first = asyncio.create_task(client.post('/api/v1/wx/weread/collect'))
            await asyncio.to_thread(started.wait, 1)
            second = asyncio.create_task(client.post('/api/v1/wx/weread/collect'))
            response = await client.get('/status')
            release.set()
            results = await asyncio.gather(first, second)
        self.assertFalse(response.json()['collector_finished'])
        self.assertEqual([r.json() for r in results], [{'collected': 1}, {'collected': 1}])
        self.assertEqual(maximum, 1)
        self.assertTrue(all(t != threading.get_ident() for t in worker_threads))

    async def test_exception_does_not_leave_the_collection_gate_locked(self):
        app = FastAPI()
        calls = 0

        @app.post('/api/v1/wx/weread/collect')
        async def collect():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError('upstream unavailable')
            return {'collected': 0}

        install(app)
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            with self.assertRaises(RuntimeError):
                await client.post('/api/v1/wx/weread/collect')
            result = await asyncio.wait_for(client.post('/api/v1/wx/weread/collect'), 1)
        self.assertEqual(result.json(), {'collected': 0})

    async def test_cancelling_http_does_not_overlap_the_still_running_collector(self):
        app = FastAPI()
        started = threading.Event()
        release = threading.Event()
        active = 0
        maximum = 0

        @app.post('/api/v1/wx/weread/collect')
        async def collect():
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            started.set()
            release.wait(2)
            active -= 1
            return {'collected': 0}

        install(app)
        self.assertEqual(install(app), 0)
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            first = asyncio.create_task(client.post('/api/v1/wx/weread/collect'))
            await asyncio.to_thread(started.wait, 1)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            second = asyncio.create_task(client.post('/api/v1/wx/weread/collect'))
            await asyncio.sleep(0.02)
            release.set()
            await second
        self.assertEqual(maximum, 1)


if __name__ == '__main__':
    unittest.main()
