"""Offline transport regression tests; no credentials or live Beacon calls."""
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from types import SimpleNamespace
import unittest
import requests  # Load transport dependencies before temporary module stubs.
from unittest.mock import Mock, patch


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(getattr(self.server, 'landing_status', 200) if self.path == '/' else 200)
        if self.path == '/':
            self.send_header('Set-Cookie', 'ARRAffinity=test-worker; Path=/; HttpOnly')
        self.end_headers()
        self.wfile.write(json.dumps({'cookie': self.headers.get('Cookie')}).encode())

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({'access_token': 'test', 'Id': '1',
                                   'cookie': self.headers.get('Cookie')}).encode())


class SessionTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            'session_under_test', Path(__file__).parents[1] / 'app/core/browser_session.py')
        self.auth = importlib.util.module_from_spec(spec)
        with patch.dict('sys.modules', {
            'app.core.login': SimpleNamespace(load_login_settings=lambda: {}),
            'app.core.logger': SimpleNamespace(logger=Mock()),
        }):
            spec.loader.exec_module(self.auth)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.auth.BEACON_URLS['s4'] = self.url + '/'

    def tearDown(self):
        self.auth.invalidate_auth_token()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_login_and_followup_keep_cookie_and_invalidation_clears_it(self):
        with self.auth.use_auth_context({'username': 'a', 'password': 'p'}, 'a'):
            result = self.auth.login_via_api('a', 'p', 's4')
            self.assertEqual(result['cookie'], 'ARRAffinity=test-worker')
            self.assertEqual(self.auth.http_request('GET', self.url+'/read').json()['cookie'],
                             'ARRAffinity=test-worker')
            self.auth.invalidate_auth_token()
            self.assertIsNone(self.auth.http_request('GET', self.url+'/read').json()['cookie'])

    def test_accounts_credentials_and_domains_are_isolated(self):
        with self.auth.use_auth_context({'username': 'a'}, 'a'):
            self.auth.http_request('GET', self.url+'/')
            other_host = self.url.replace('127.0.0.1', 'localhost')
            self.assertIsNone(self.auth.http_request('GET', other_host+'/read').json()['cookie'])
        with self.auth.use_auth_context({'username': 'b'}, 'b'):
            self.assertIsNone(self.auth.http_request('GET', self.url+'/read').json()['cookie'])
        with self.auth.use_auth_context({'username': 'a', 'password': 'changed'}, 'a'):
            self.assertIsNone(self.auth.http_request('GET', self.url+'/read').json()['cookie'])
        with self.auth.use_auth_context({'username': 'a'}, 'a'):
            self.assertEqual(self.auth.http_request('GET', self.url+'/read').json()['cookie'],
                             'ARRAffinity=test-worker')

    def test_landing_500_does_not_block_token_login(self):
        self.server.landing_status = 500
        with self.auth.use_auth_context({'username': 'a', 'password': 'p'}, 'a'):
            result = self.auth.login_via_api('a', 'p', 's4')
            self.assertEqual(result['access_token'], 'test')
            self.assertEqual(result['cookie'], 'ARRAffinity=test-worker')

    def test_landing_timeout_does_not_block_token_login(self):
        with patch.object(self.auth, 'http_request', side_effect=[
            requests.Timeout(), Mock(json=lambda: {'access_token': 'test'})
        ]) as request:
            self.assertEqual(self.auth.login_via_api('a', 'p')['access_token'], 'test')
            self.assertEqual(request.call_args.args[0], 'POST')

    def test_missing_token_blocks_api_authentication(self):
        with patch.object(self.auth, '_ensure_auth_token', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'authentication unavailable'):
                self.auth.require_auth_token()


if __name__ == '__main__':
    unittest.main()
