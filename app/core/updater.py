import hashlib
import json
import os
import subprocess
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
    state.setdefault("current_version", APP_VERSION)
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
    if not expected_sha256:
        raise RuntimeError("Update manifest is missing sha256.")

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


def apply_downloaded_update():
    status = get_update_status()
    installer_path = status.get("installer_path")
    if not status.get("downloaded") or not installer_path or not Path(installer_path).exists():
        return False

    subprocess.Popen(
        [
            installer_path,
            "/VERYSILENT",
            "/SUPPRESSMSGBOXES",
            "/NORESTART",
        ],
        close_fds=True,
    )
    return True


def start_background_updater():
    global _background_started
    if _background_started:
        return
    _background_started = True

    def worker():
        while True:
            try:
                info = check_for_update()
                with _lock:
                    state = {**info, "downloaded": False}
                    _save_state(state)
                if info.get("available"):
                    download_update(info)
            except Exception as exc:
                logger.warning(f"Background update check failed: {exc}")
            time.sleep(UPDATE_CHECK_INTERVAL_SECONDS)

    threading.Thread(target=worker, name="beabots-updater", daemon=True).start()
