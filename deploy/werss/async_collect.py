"""Keep the pinned synchronous collector off FastAPI's event loop."""
import asyncio
import functools
import threading


def serialized_endpoint(endpoint, gate):
    @functools.wraps(endpoint)
    async def collect(*args, **kwargs):
        def run():
            # Hold the lock in the worker: cancelling the HTTP request must not
            # release it while its synchronous upstream request is still running.
            with gate:
                return asyncio.run(endpoint(*args, **kwargs))
        return await asyncio.to_thread(run)

    collect.psyhot_offloaded = True
    return collect


def install(app):
    gate = threading.Lock()
    count = 0
    for route in app.routes:
        if (getattr(route, 'path', '').endswith('/weread/collect')
                and 'POST' in getattr(route, 'methods', ())):
            endpoint = route.dependant.call
            if not getattr(endpoint, 'psyhot_offloaded', False):
                # The existing FastAPI handler closes over this Dependant; keep
                # its auth/body dependencies and async return contract intact.
                route.dependant.call = serialized_endpoint(endpoint, gate)
                count += 1
    return count
