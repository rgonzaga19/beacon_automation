import hashlib
import json
import os
import platform
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests

from app.core.config import get_data_dir
from app.core.logger import logger
from app.core.security import decrypt_field, encrypt_field
from app.core.version import APP_VERSION


LICENSE_URL = os.getenv(
    "BEABOTS_LICENSE_URL",
    "https://beabot-license.gonzagaromel19.workers.dev/",
)
LICENSE_CHECK_INTERVAL_SECONDS = int(
    os.getenv("BEABOTS_LICENSE_CHECK_SECONDS", str(30 * 60))
)

_STATE_FILE = get_data_dir() / "license.json"
_lock = threading.Lock()
_state = None
_background_started = False


def _utc_now():
    return datetime.now(timezone.utc)


def _iso_now():
    return _utc_now().isoformat()


def _parse_iso(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _default_state():
    return {
        "license_key_encrypted": None,
        "valid": False,
        "code": "LICENSE_REQUIRED",
        "reason": "A license key is required.",
        "owner": "",
        "plan": "",
        "expires": "",
        "last_checked_at": None,
        "next_check_at": None,
        "minimum_version": "",
        "latest_version": "",
        "download": "",
    }


def _load_state_unlocked():
    global _state
    if _state is not None:
        return _state

    if not _STATE_FILE.exists():
        _state = _default_state()
        return _state

    try:
        loaded = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        loaded = {}

    state = _default_state()
    state.update({key: loaded.get(key) for key in state if key in loaded})
    _state = state
    return _state


def _save_state_unlocked(state):
    _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    _STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _license_key_from_state(state):
    return decrypt_field(state.get("license_key_encrypted"))


def _machine_id():
    raw = "|".join(
        [
            platform.node(),
            platform.machine(),
            platform.processor(),
            str(uuid.getnode()),
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _public_status(state):
    has_key = bool(_license_key_from_state(state))
    return {
        "configured": has_key,
        "valid": bool(state.get("valid")),
        "code": state.get("code") or ("OK" if state.get("valid") else "LICENSE_REQUIRED"),
        "reason": state.get("reason") or "",
        "owner": state.get("owner") or "",
        "plan": state.get("plan") or "",
        "expires": state.get("expires") or "",
        "last_checked_at": state.get("last_checked_at"),
        "next_check_at": state.get("next_check_at"),
        "minimum_version": state.get("minimum_version") or "",
        "latest_version": state.get("latest_version") or "",
        "download": state.get("download") or "",
    }


def get_license_status():
    with _lock:
        return _public_status(_load_state_unlocked())


def clear_license():
    with _lock:
        state = _default_state()
        global _state
        _state = state
        _save_state_unlocked(state)
        return _public_status(state)


def _update_state_from_response(state, data):
    now = _utc_now()
    state.update(
        {
            "valid": bool(data.get("valid")),
            "code": data.get("code") or ("OK" if data.get("valid") else "INVALID_LICENSE"),
            "reason": data.get("reason") or "",
            "owner": data.get("owner") or "",
            "plan": data.get("plan") or "",
            "expires": data.get("expires") or "",
            "last_checked_at": now.isoformat(),
            "next_check_at": datetime.fromtimestamp(
                now.timestamp() + LICENSE_CHECK_INTERVAL_SECONDS,
                timezone.utc,
            ).isoformat(),
            "minimum_version": data.get("minimum_version") or "",
            "latest_version": data.get("latest_version") or "",
            "download": data.get("download") or "",
        }
    )


def verify_license(license_key=None, force=False):
    with _lock:
        state = _load_state_unlocked()
        if license_key is not None:
            state["license_key_encrypted"] = encrypt_field(str(license_key).strip())

        key = _license_key_from_state(state)
        if not key:
            state.update(_default_state())
            _save_state_unlocked(state)
            return _public_status(state)

        if not force:
            next_check = _parse_iso(state.get("next_check_at"))
            if state.get("valid") and next_check and _utc_now() < next_check:
                return _public_status(state)

    payload = {
        "license": key,
        "app_version": APP_VERSION,
        "machine_id": _machine_id(),
    }

    try:
        response = requests.post(LICENSE_URL, json=payload, timeout=15)
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        logger.warning(f"License check failed: {exc}")
        with _lock:
            state = _load_state_unlocked()
            if state.get("valid"):
                state["reason"] = "License server unavailable. Last valid license is temporarily accepted."
                state["code"] = "CHECK_DEFERRED"
            else:
                state["valid"] = False
                state["code"] = "LICENSE_CHECK_FAILED"
                state["reason"] = "Could not verify the license."
            state["last_checked_at"] = _iso_now()
            state["next_check_at"] = datetime.fromtimestamp(
                time.time() + min(5 * 60, LICENSE_CHECK_INTERVAL_SECONDS),
                timezone.utc,
            ).isoformat()
            _save_state_unlocked(state)
            return _public_status(state)

    with _lock:
        state = _load_state_unlocked()
        _update_state_from_response(state, data)
        _save_state_unlocked(state)
        return _public_status(state)


def require_valid_license():
    status = verify_license(force=False)
    if status["valid"]:
        return None
    return status


def start_background_license_checker():
    global _background_started
    if _background_started:
        return
    _background_started = True

    def worker():
        while True:
            time.sleep(60)
            try:
                with _lock:
                    state = _load_state_unlocked()
                    has_key = bool(_license_key_from_state(state))
                    next_check = _parse_iso(state.get("next_check_at"))
                if has_key and (next_check is None or _utc_now() >= next_check):
                    verify_license(force=True)
            except Exception as exc:
                logger.warning(f"Background license check failed: {exc}")

    threading.Thread(target=worker, name="beabots-license-checker", daemon=True).start()
