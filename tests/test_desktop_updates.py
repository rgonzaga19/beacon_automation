"""Updater regression checks; never launches an installer or touches app data."""
import ast
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]


class DesktopUpdatesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        config = types.ModuleType("app.core.config")
        config.get_data_dir = lambda: Path(self.temp.name)
        logger = types.ModuleType("app.core.logger")
        logger.logger = Mock()
        version = types.ModuleType("app.core.version")
        version.APP_VERSION = "4.0.5"
        spec = importlib.util.spec_from_file_location("tested_updater", ROOT / "app/core/updater.py")
        self.updater = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {
            "app.core.config": config, "app.core.logger": logger,
            "app.core.version": version,
        }):
            spec.loader.exec_module(self.updater)
        self.updater._UPDATE_DIR.mkdir()
        self.installer = self.updater._UPDATE_DIR / "Beabots_Setup_v4.0.6.exe"
        self.installer.write_bytes(b"test installer, never execute")
        self.info = {
            "version": "4.0.6", "available": True, "downloaded": True,
            "download": "https://example.com/setup.exe",
            "sha256": hashlib.sha256(self.installer.read_bytes()).hexdigest(),
            "installer_path": str(self.installer),
        }
        self.updater._save_state(self.info)
        self.claim, self.release, self.close = Mock(return_value=True), Mock(), Mock()
        self.updater.configure_desktop_updates(self.claim, self.release, self.close)

    def test_current_version_clears_stale_download_status(self):
        self.updater.APP_VERSION = "4.0.6"
        # _is_newer's default is bound at import, matching a real fresh process.
        self.updater._is_newer.__defaults__ = ("4.0.6",)
        status = self.updater.get_update_status()
        self.assertFalse(status["downloaded"])
        self.assertFalse(status["available"])

    def test_verified_download_is_reused(self):
        with patch.object(self.updater.requests, "get") as get:
            self.assertEqual(self.updater.download_update(self.info)["version"], "4.0.6")
            get.assert_not_called()

    def test_manifest_rejects_unsafe_version_and_missing_hash(self):
        for changes in ({"version": "../escape"}, {"sha256": ""}, {"download": "http://example.com"}):
            with self.assertRaises(RuntimeError):
                self.updater.download_update({**self.info, **changes})

    def test_development_does_not_install(self):
        with patch.object(sys, "frozen", False, create=True):
            self.assertFalse(self.updater.apply_downloaded_update())
        self.claim.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows desktop flow")
    def test_busy_jobs_defer_installation(self):
        self.claim.return_value = False
        with patch.object(sys, "frozen", True, create=True):
            self.assertFalse(self.updater.apply_downloaded_update())
        self.close.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows desktop flow")
    def test_tampered_installer_never_closes_app(self):
        self.installer.write_bytes(b"modified")
        with patch.object(sys, "frozen", True, create=True), self.assertRaises(RuntimeError):
            self.updater.apply_downloaded_update()
        self.claim.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows desktop flow")
    def test_helper_handoff_and_retry_backoff(self):
        def launch(*args, **kwargs):
            (self.updater._UPDATE_DIR / "install-update.ready").write_text("ready")
            return Mock()
        with patch.object(sys, "frozen", True, create=True), patch.object(self.updater.subprocess, "Popen", side_effect=launch) as popen:
            self.assertTrue(self.updater.apply_downloaded_update())
            self.close.assert_called_once()
            self.assertFalse(self.updater.apply_downloaded_update())
            popen.assert_called_once()

    @unittest.skipUnless(os.name == "nt", "Windows desktop flow")
    def test_helper_failure_releases_job_gate(self):
        with patch.object(sys, "frozen", True, create=True), patch.object(self.updater.subprocess, "Popen", side_effect=OSError("failed")):
            with self.assertRaises(OSError):
                self.updater.apply_downloaded_update()
        self.release.assert_called_once()
        self.close.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "PowerShell parser")
    def test_helper_powershell_syntax(self):
        result = subprocess.run([
            "powershell.exe", "-NoProfile", "-Command",
            "$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors); if ($errors.Count) { $errors; exit 1 }",
        ], input=self.updater._UPDATE_HELPER, text=True, capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_job_gate_defers_until_all_task_types_are_idle(self):
        tree = ast.parse((ROOT / "server.py").read_text())
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in (
            "claim_update_installation", "release_update_installation",
        )]
        scope = {"_job_start_lock": threading.RLock(), "_update_installing": False,
                 "_cf2_runs": {}, "_soa_runs": {}, "_beacon_runs": {}}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), scope)
        for runs in ("_cf2_runs", "_soa_runs", "_beacon_runs"):
            scope[runs][1] = {}
            self.assertFalse(scope["claim_update_installation"]())
            scope[runs].clear()
        self.assertTrue(scope["claim_update_installation"]())
        self.assertFalse(scope["claim_update_installation"]())
        scope["release_update_installation"]()
        self.assertTrue(scope["claim_update_installation"]())


if __name__ == "__main__":
    unittest.main()
