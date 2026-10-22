"""Offline regression tests for the current public-platform QR handshake."""
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy' / 'werss'))
from auth_adapter import qr_login


class LoginHandshake(unittest.TestCase):
    def adapter(self, folder, *, uuid='server-session', image=True):
        events = []

        class Adapter:
            def __init__(self):
                self._lock = threading.Lock()
                self.base_url = 'https://mp.weixin.qq.com'
                self.qr_code_path = str(Path(folder) / 'qr.png')
                self.session = SimpleNamespace(cookies={})

                def post(url, **kwargs):
                    events.append(('handshake', kwargs))
                    if uuid:
                        self.session.cookies['uuid'] = uuid
                    return SimpleNamespace(raise_for_status=lambda: None)

                def get(url, **kwargs):
                    events.append(('image', kwargs))
                    return SimpleNamespace(raise_for_status=lambda: None,
                        headers={'Content-Type': 'image/png' if image else 'text/html'},
                        content=b'\x89PNG\r\n\x1a\nfixture' if image else b'login error')

                self.session.post = post
                self.session.get = get

            def check_lock(self): return False
            def _generate_uuid(self): return 'stable-fingerprint'
            def set_lock(self): events.append(('lock', None))
            def _start_login_check(self, value): events.append(('poll', value))

        return Adapter(), events

    def test_server_session_and_fingerprint_are_preserved_for_polling(self):
        with tempfile.TemporaryDirectory() as folder:
            adapter, events = self.adapter(folder)
            result = qr_login(adapter)
            self.assertTrue(result['is_exists'])
            self.assertTrue(Path(result['code']).read_bytes().startswith(b'\x89PNG'))
            self.assertEqual(events[1][1]['params']['uuid'], 'server-session')
            self.assertEqual(adapter.session.cookies['uuid'], 'server-session')
            self.assertEqual(adapter.cookies['fingerprint'], events[0][1]['data']['fingerprint'])
            self.assertIn(('poll', 'server-session'), events)

    def test_failed_handshake_never_fabricates_a_session_or_starts_polling(self):
        with tempfile.TemporaryDirectory() as folder:
            adapter, events = self.adapter(folder, uuid=None)
            self.assertFalse(qr_login(adapter)['is_exists'])
            self.assertEqual([event[0] for event in events], ['handshake'])

    def test_error_page_is_not_saved_or_advertised_as_a_qr_image(self):
        with tempfile.TemporaryDirectory() as folder:
            adapter, events = self.adapter(folder, image=False)
            self.assertFalse(qr_login(adapter)['is_exists'])
            self.assertFalse(Path(adapter.qr_code_path).exists())
            self.assertNotIn('poll', [event[0] for event in events])


if __name__ == '__main__':
    unittest.main()
