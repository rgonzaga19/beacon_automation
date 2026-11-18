import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from server import app


class AuthIdleTimeoutTests(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        self.client = app.test_client()

    def set_authenticated_session(self, last_activity_at):
        with self.client.session_transaction() as browser_session:
            browser_session["user_id"] = 1
            browser_session["last_activity_at"] = last_activity_at
            browser_session.permanent = True

    def test_idle_session_is_rejected_by_protected_route(self):
        timeout = app.permanent_session_lifetime.total_seconds()
        self.set_authenticated_session(time.time() - timeout - 1)

        response = self.client.get("/api/chat/latest")

        self.assertEqual(response.status_code, 401)
        self.assertFalse(self.client.get("/api/auth/me").get_json()["authenticated"])

    def test_activity_endpoint_refreshes_session_activity(self):
        previous_activity = time.time() - 60
        self.set_authenticated_session(previous_activity)

        with patch("server.current_user", return_value=SimpleNamespace(is_active=True)):
            response = self.client.post("/api/auth/activity")

        self.assertEqual(response.status_code, 200)
        self.assertIn("Set-Cookie", response.headers)
        with self.client.session_transaction() as browser_session:
            self.assertGreater(browser_session["last_activity_at"], previous_activity)

    def test_auth_status_request_does_not_refresh_session_activity(self):
        last_activity = time.time() - 60
        self.set_authenticated_session(last_activity)

        with (
            patch("server.current_user", return_value=SimpleNamespace(is_active=True)),
            patch("server.user_payload", return_value={}),
        ):
            response = self.client.get("/api/auth/me")

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("Set-Cookie", response.headers)
        with self.client.session_transaction() as browser_session:
            self.assertEqual(browser_session["last_activity_at"], last_activity)

    def test_cookie_lifetime_and_refresh_policy_match_idle_timeout(self):
        self.assertEqual(app.permanent_session_lifetime.total_seconds(), 15 * 60)
        self.assertFalse(app.config["SESSION_REFRESH_EACH_REQUEST"])


if __name__ == "__main__":
    unittest.main()
