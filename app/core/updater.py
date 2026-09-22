import hashlib
import json
import os
import subprocess
import sys
import re
import threading
import time
from pathlib import Path

import requests

from app.core.config import get_data_dir
from app.core.logger import logger
from app.core.version import APP_VERSION


UPDATE_URL = os.getenv(
    "BEABOTS_UPDATE_URL",
    "https://beabot-license.gonzagaromel19.workers.dev/update",
)
UPDATE_CHECK_INTERVAL_SECONDS = int(
    os.getenv("BEABOTS_UPDATE_CHECK_SECONDS", str(6 * 60 * 60))
)

_UPDATE_DIR = get_data_dir() / "updates"
_STATE_FILE = _UPDATE_DIR / "update.json"
_lock = threading.Lock()
_background_started = False
_claim_install = None
_release_install = None
_close_for_update = None
_apply_lock = threading.Lock()


def _normalize_version(value):
    parts = str(value or "").strip().lower().removeprefix("v").split(".")
    if len(parts) != 3:
        return None
    try:
        return tuple(int(part.split("-", 1)[0].split("+", 1)[0]) for part in parts)
    except ValueError:
        return None


def _is_newer(candidate, current=APP_VERSION):
    candidate_parts = _normalize_version(candidate)
    current_parts = _normalize_version(current)
    if candidate_parts is None or current_parts is None:
        return False
    return candidate_parts > current_parts


def _state():
    if not _STATE_FILE.exists():
        return {}
    try:
        return json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_state(state):
    _UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    _STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_for_update():
    response = requests.get(UPDATE_URL, timeout=20)
    response.raise_for_status()
    info = response.json()
    info["available"] = _is_newer(info.get("version"))
    info["current_version"] = APP_VERSION
    return info


def get_update_status():
    with _lock:
        state = _state()
    state["current_version"] = APP_VERSION
    if not _is_newer(state.get("version")):
        state.update(available=False, downloaded=False)
    state.setdefault("available", False)
    state.setdefault("downloaded", False)
    return state


def download_update(info=None):
    info = info or check_for_update()
    download_url = info.get("download")
    latest_version = info.get("version")
    expected_sha256 = str(info.get("sha256") or "").strip().lower()

    if not info.get("available") or not download_url or not latest_version:
        return get_update_status()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", str(latest_version)):
        raise RuntimeError("Update version must use major.minor.patch format.")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise RuntimeError("Update manifest must include a valid sha256.")
    if not str(download_url).startswith("https://"):
        raise RuntimeError("Update downloads must use HTTPS.")
    cached = get_update_status()
    cached_path = Path(cached.get("installer_path") or "")
    if (cached.get("version") == latest_version and cached.get("downloaded")
            and cached_path.is_file() and _sha256(cached_path) == expected_sha256):
        return cached

    _UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    installer_path = _UPDATE_DIR / f"Beabots_Setup_v{latest_version}.exe"
    partial_path = installer_path.with_suffix(".download")

    logger.info(f"Downloading Beabots update {latest_version}.")
    with requests.get(download_url, stream=True, timeout=60) as response:
        response.raise_for_status()
        with open(partial_path, "wb") as file:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    file.write(chunk)

    if expected_sha256:
        actual_sha256 = _sha256(partial_path)
        if actual_sha256.lower() != expected_sha256:
            partial_path.unlink(missing_ok=True)
            raise RuntimeError("Downloaded update did not match the expected checksum.")

    partial_path.replace(installer_path)
    state = {
        **info,
        "available": True,
        "downloaded": True,
        "installer_path": str(installer_path),
        "current_version": APP_VERSION,
    }
    with _lock:
        _save_state(state)
    return state


def configure_desktop_updates(claim_install, release_install, close_for_update):
    global _claim_install, _release_install, _close_for_update
    _claim_install = claim_install
    _release_install = release_install
    _close_for_update = close_for_update


# Runs outside the application so the installer can replace all packaged files.
_UPDATE_HELPER = r'''param([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$owner = Get-Process -Id $config.pid -ErrorAction SilentlyContinue
Set-Content -LiteralPath $config.ready -Value 'ready'
if ($owner -and -not $owner.WaitForExit(120000)) { exit 1 }
try {
    $hash = (Get-FileHash -LiteralPath $config.installer -Algorithm SHA256).Hash
    if ($hash -ne $config.sha256) { throw 'Installer checksum mismatch.' }
    $installArgs = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS /DIR="' + $config.directory + '"'
    $setup = Start-Process -FilePath $config.installer -ArgumentList $installArgs -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw "Installer exited with code $($setup.ExitCode)." }
    Set-Content -LiteralPath $config.result -Value 'Update installed successfully.'
} catch {
    Set-Content -LiteralPath $config.result -Value $_.Exception.Message
} finally {
    # Relaunch as the original user, even if elevation or installation failed.
    Start-Process -FilePath $config.executable -WindowStyle Normal
}
'''


def apply_downloaded_update():
    # Hosted servers and development runs must never execute desktop installers.
    if os.name != "nt" or not getattr(sys, "frozen", False) or _close_for_update is None:
        return False
    with _apply_lock:
        status = get_update_status()
        installer = Path(status.get("installer_path") or "")
        if not status.get("downloaded") or not installer.is_file():
            return False
        if time.time() - status.get("last_install_attempt", 0) < 6 * 60 * 60:
            return False
        if installer.resolve().parent != _UPDATE_DIR.resolve():
            raise RuntimeError("Installer is outside the update directory.")
        if _sha256(installer) != status.get("sha256", "").lower():
            raise RuntimeError("Installer checksum mismatch before installation.")
        if not _claim_install():
            return False
        helper = None
        try:
            status["last_install_attempt"] = time.time()
            with _lock:
                _save_state(status)
            helper_path = _UPDATE_DIR / "install-update.ps1"
            config_path = _UPDATE_DIR / "install-update.json"
            ready_path = _UPDATE_DIR / "install-update.ready"
            ready_path.unlink(missing_ok=True)
            helper_path.write_text(_UPDATE_HELPER, encoding="utf-8")
            config_path.write_text(json.dumps({
                "pid": os.getpid(), "installer": str(installer.resolve()),
                "sha256": status["sha256"], "executable": sys.executable,
                "directory": str(Path(sys.executable).parent),
                "ready": str(ready_path), "result": str(_UPDATE_DIR / "install-result.txt"),
            }), encoding="utf-8")
            powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            helper = subprocess.Popen([
                str(powershell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", str(helper_path), "-ConfigPath", str(config_path),
            ], creationflags=subprocess.CREATE_NO_WINDOW, close_fds=True)
            deadline = time.monotonic() + 10
            while not ready_path.exists():
                if helper.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("Update helper did not start.")
                time.sleep(0.1)
            _close_for_update()
            return True
        except Exception:
            if helper is not None and helper.poll() is None:
                helper.terminate()
            _release_install()
            raise


def start_background_updater():
    global _background_started
    if _background_started or os.name != "nt" or not getattr(sys, "frozen", False):
        return
    _background_started = True

    def worker():
        next_check = 0
        while True:
            try:
                if time.monotonic() >= next_check:
                    next_check = time.monotonic() + max(60, UPDATE_CHECK_INTERVAL_SECONDS)
                    info = check_for_update()
                    if info.get("available"):
                        download_update(info)
                    else:
                        with _lock:
                            _save_state({**info, "downloaded": False})
            except Exception as exc:
                logger.warning(f"Background update check failed: {exc}")
            try:
                if apply_downloaded_update():
                    return
            except Exception as exc:
                logger.warning(f"Automatic installation failed: {exc}")
            time.sleep(15)

    threading.Thread(target=worker, name="beabots-updater", daemon=True).start()
