import unittest
from types import SimpleNamespace
from unittest.mock import patch

import server


class RunAllStatusTests(unittest.TestCase):
    user_id = 987654321

    def setUp(self):
        with server._run_all_status_lock:
            self.previous_status = server._run_all_status.pop(self.user_id, None)

    def tearDown(self):
        with server._run_all_status_lock:
            server._run_all_status.pop(self.user_id, None)
            if self.previous_status:
                server._run_all_status[self.user_id] = self.previous_status

    def test_authenticated_user_can_restore_their_run_snapshot(self):
        server._start_run_all_status(self.user_id, "run-1", total=2, stage="queued")
        server._update_run_all_status(
            self.user_id,
            "run-1",
            index=1,
            stage="soa",
            message="Uploading matched SOA",
            results=[{
                "patient_name": "Test Patient",
                "member_pin": "test-pin",
                "cf2": "success",
                "soa": "running",
                "esoa": "waiting",
                "cf4": "waiting",
            }],
        )
        user = SimpleNamespace(id=self.user_id, is_active=True, is_admin=True, role="admin")

        with patch("server.current_user", return_value=user):
            response = server.app.test_client().get("/api/run-all/status")

        self.assertEqual(response.status_code, 200)
        snapshot = response.get_json()["run"]
        self.assertTrue(snapshot["running"])
        self.assertEqual(snapshot["stage"], "soa")
        self.assertEqual(snapshot["results"][0]["soa"], "running")

    def test_run_snapshot_is_scoped_to_the_authenticated_user(self):
        server._start_run_all_status(self.user_id, "run-1", total=1)
        other_user = SimpleNamespace(
            id=self.user_id + 1,
            is_active=True,
            is_admin=True,
            role="admin",
        )

        with patch("server.current_user", return_value=other_user):
            response = server.app.test_client().get("/api/run-all/status")

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.get_json()["run"])


if __name__ == "__main__":
    unittest.main()
