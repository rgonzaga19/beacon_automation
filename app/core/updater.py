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
_INSTALL_RESULT_FILE = _UPDATE_DIR / "install-result.json"
_INSTALL_LOG_FILE = _UPDATE_DIR / "installer.log"
_lock = threading.Lock()
_background_started = False
_claim_install = None
_release_install = None
_close_for_update = None
_apply_lock = threading.Lock()
_progress = {"phase": "idle", "message": "Waiting to check for updates.", "percent": None}


def _set_progress(phase, message, percent=None):
    with _lock:
        _progress.update(phase=phase, message=message, percent=percent)


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
        value = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_state(state):
    _UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = _STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2), encoding="utf-8")
    temporary.replace(_STATE_FILE)


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _install_attempt_count(state):
    try:
        return max(0, int(state.get("install_attempts") or 0))
    except (TypeError, ValueError):
        return 0


def check_for_update():
    _set_progress("checking", "Checking for updates?")
    response = requests.get(UPDATE_URL, timeout=20)
    response.raise_for_status()
    info = response.json()
    info["available"] = _is_newer(info.get("version"))
    info["current_version"] = APP_VERSION
    return info


def get_update_status():
    with _lock:
        state = _state()
        state.update(_progress)
        state["desktop_updates_enabled"] = _background_started
    state["current_version"] = APP_VERSION
    if not _is_newer(state.get("version")):
        state.update(available=False, downloaded=False)
    state.setdefault("available", False)
    state.setdefault("downloaded", False)
    state["retry_available"] = bool(state.get("downloaded") and state.get("install_state") == "failed")
    return state


def _recover_install_result():
    """Read the installer helper's outcome after the app has relaunched."""
    state = _state()
    result = None
    try:
        result = json.loads(_INSTALL_RESULT_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError):
        result = {"success": False, "message": "The installer result file was unreadable."}
    finally:
        try:
            _INSTALL_RESULT_FILE.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning(f"Could not clear the previous update result: {exc}")

    if result is None:
        # A forced shutdown or helper crash can leave the state marked as
        # installing without ever writing a result. Recover it on next launch.
        try:
            attempted = float(state.get("last_install_attempt") or 0)
        except (TypeError, ValueError):
            attempted = 0
        if state.get("install_state") != "installing":
            return
        if time.time() - attempted < 5 * 60:
            _set_progress("installing", "Waiting for the previous installer to report its result.", 100)
            return
        result = {"success": False, "message": "The installer did not report an outcome. You can retry the update."}

    if not isinstance(result, dict):
        result = {"success": False, "message": "The installer result had an unexpected format."}
    version = str(result.get("version") or state.get("version") or "")
    current_parts = _normalize_version(APP_VERSION)
    target_parts = _normalize_version(version)
    if result.get("success") and current_parts is not None and target_parts is not None and current_parts >= target_parts:
        state.update(
            install_state="succeeded",
            install_error="",
            downloaded=False,
            retry_after=0,
        )
        with _lock:
            _save_state(state)
        _set_progress("up_to_date", f"Beabots {APP_VERSION} updated successfully.", 100)
        return

    message = str(result.get("message") or "The installer failed without providing a reason.")
    attempts = max(1, _install_attempt_count(state))
    retry_delay = min(15 * 60 * (2 ** (attempts - 1)), 6 * 60 * 60)
    if _INSTALL_LOG_FILE.is_file():
        message = f"{message} Installer log: {_INSTALL_LOG_FILE}"
    state.update(
        install_state="failed",
        install_error=message,
        retry_after=time.time() + retry_delay,
    )
    with _lock:
        _save_state(state)
    _set_progress("error", f"Update installation failed: {message} Retry is available now, or automatic retry in {retry_delay // 60} minutes.")


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
        if cached.get("install_state") != "failed":
            _set_progress("ready", f"Update {latest_version} downloaded and verified.", 100)
        return cached

    _UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    installer_path = _UPDATE_DIR / f"Beabots_Setup_v{latest_version}.exe"
    partial_path = installer_path.with_suffix(".download")

    _set_progress("downloading", f"Downloading update {latest_version}?", 0)
    logger.info(f"Downloading Beabots update {latest_version}.")
    try:
        with requests.get(download_url, stream=True, timeout=60) as response:
            response.raise_for_status()
            total = int(response.headers.get("Content-Length") or 0)
            received = 0
            with open(partial_path, "wb") as file:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        file.write(chunk)
                        received += len(chunk)
                        percent = min(100, round(received * 100 / total)) if total else None
                        _set_progress("downloading", f"Downloading update {latest_version}?", percent)
    except Exception:
        partial_path.unlink(missing_ok=True)
        raise

    _set_progress("verifying", "Verifying the downloaded update?")
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
        "install_state": "ready",
        "install_error": "",
        "install_attempts": 0,
        "retry_after": 0,
    }
    with _lock:
        _save_state(state)
    _set_progress("ready", f"Update {latest_version} downloaded and verified.", 100)
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
$result = @{
    success = $false
    version = $config.version
    message = 'The installer helper ended without reporting a result.'
    completed_at = [DateTime]::UtcNow.ToString('o')
}
try {
    $owner = Get-Process -Id $config.pid -ErrorAction SilentlyContinue
    [System.IO.File]::WriteAllText($config.ready, 'ready')
    if ($owner -and -not $owner.WaitForExit(120000)) { throw 'Beabots did not close within 2 minutes.' }
    $hash = (Get-FileHash -LiteralPath $config.installer -Algorithm SHA256).Hash
    if ($hash -ne $config.sha256) { throw 'Installer checksum mismatch.' }
    $installArgs = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS /DIR="' + $config.directory + '" /LOG="' + $config.log + '"'
    $setup = Start-Process -FilePath $config.installer -ArgumentList $installArgs -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw "Installer exited with code $($setup.ExitCode)." }
    $result.success = $true
    $result.message = 'Update installed successfully.'
} catch {
    $result.success = $false
    $result.message = $_.Exception.Message
} finally {
    $result.completed_at = [DateTime]::UtcNow.ToString('o')
    $temporary = $config.result + '.tmp'
    try {
        $encoding = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($temporary, ($result | ConvertTo-Json -Compress), $encoding)
        Move-Item -LiteralPath $temporary -Destination $config.result -Force
    } catch {
        # The next launch will recover a stale "installing" state.
    }
    # Relaunch as the original user, even if elevation or installation failed.
    Start-Process -FilePath $config.executable -WindowStyle Normal
}
'''


def apply_downloaded_update(force=False):
    # Hosted servers and development runs must never execute desktop installers.
    if os.name != "nt" or not getattr(sys, "frozen", False) or _close_for_update is None:
        return False
    with _apply_lock:
        status = get_update_status()
        installer = Path(status.get("installer_path") or "")
        if not status.get("downloaded") or not installer.is_file():
            return False
        if status.get("install_state") == "installing":
            _set_progress("installing", "Waiting for the previous installer to report its result.", 100)
            return False
        retry_after = float(status.get("retry_after") or 0)
        if not force and status.get("install_state") == "failed" and time.time() < retry_after:
            retry_minutes = max(1, round((retry_after - time.time()) / 60))
            _set_progress("error", f"Update installation failed: {status.get('install_error') or 'Unknown installer error'} Retry is available in about {retry_minutes} minutes.")
            return False
        if installer.resolve().parent != _UPDATE_DIR.resolve():
            raise RuntimeError("Installer is outside the update directory.")
        if _sha256(installer) != status.get("sha256", "").lower():
            raise RuntimeError("Installer checksum mismatch before installation.")
        if not _claim_install():
            _set_progress("waiting", "Update ready. Waiting for automation to finish before restarting.", 100)
            return False
        helper = None
        _set_progress("installing", "Installing update. Beabots will close and reopen automatically.", 100)
        try:
            status["last_install_attempt"] = time.time()
            status["install_attempts"] = _install_attempt_count(status) + 1
            status["install_state"] = "installing"
            status["install_error"] = ""
            status["retry_after"] = 0
            _INSTALL_RESULT_FILE.unlink(missing_ok=True)
            _INSTALL_LOG_FILE.unlink(missing_ok=True)
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
                "version": status["version"], "log": str(_INSTALL_LOG_FILE),
                "directory": str(Path(sys.executable).parent),
                "ready": str(ready_path), "result": str(_INSTALL_RESULT_FILE),
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
        except Exception as exc:
            if helper is not None and helper.poll() is None:
                helper.terminate()
            state = _state()
            attempts = max(1, _install_attempt_count(state))
            retry_delay = min(15 * 60 * (2 ** (attempts - 1)), 6 * 60 * 60)
            state.update(
                install_state="failed",
                install_error=f"The update helper could not start: {exc}",
                retry_after=time.time() + retry_delay,
            )
            with _lock:
                _save_state(state)
            _set_progress("error", f"{state['install_error']} Retry is available now, or automatic retry in {retry_delay // 60} minutes.")
            _release_install()
            raise


def start_background_updater():
    global _background_started
    if _background_started or os.name != "nt" or not getattr(sys, "frozen", False):
        return
    _background_started = True
    try:
        _recover_install_result()
    except Exception as exc:
        logger.warning(f"Could not recover the previous update result: {exc}")
        _set_progress("error", f"Could not read the previous update result: {exc}")

    def worker():
        next_check = 0
        while True:
            try:
                _recover_install_result()
                if time.monotonic() >= next_check:
                    next_check = time.monotonic() + max(60, UPDATE_CHECK_INTERVAL_SECONDS)
                    info = check_for_update()
                    if info.get("available"):
                        download_update(info)
                    else:
                        with _lock:
                            _save_state({**info, "downloaded": False})
                        _set_progress("up_to_date", f"Beabots {APP_VERSION} is up to date. Latest offered: {info.get("version", "unknown")}.")
            except Exception as exc:
                _set_progress("error", f"Update failed: {exc} Automatic retry at the next scheduled check.")
                logger.warning(f"Background update check failed: {exc}")
            try:
                if apply_downloaded_update():
                    return
            except Exception as exc:
                _set_progress("error", f"Installation failed: {exc}")
                logger.warning(f"Automatic installation failed: {exc}")
            time.sleep(15)

    threading.Thread(target=worker, name="beabots-updater", daemon=True).start()
