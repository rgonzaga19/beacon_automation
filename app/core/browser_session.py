"""Beacon API authentication shared by the direct HTTP clients.

The module name is retained for compatibility with the existing API layers,
but Beabots no longer creates or manages a browser session. Authentication is
performed directly against Beacon's OAuth2 token endpoint.
"""

import sys
import time
import hashlib
from contextlib import contextmanager
from contextvars import ContextVar

import requests

from app.core.login import load_login_settings as _load_legacy_login_settings
from app.core.logger import logger


BEACON_URLS = {
    "s2": "https://beacon-s2.bizbox.ph/",
    "s4": "https://beacon-s4.bizbox.ph/",
}

_auth_context = ContextVar("beabots_auth_context", default=None)
_auth_tokens = {}


def auth_context_key(settings, user_key=None):
    """Return a cache key scoped to one Beabots user and Beacon login."""
    settings = settings or {}
    identity = "|".join(
        str(part or "")
        for part in (
            user_key or "legacy",
            settings.get("server", "s4"),
            settings.get("username", ""),
            settings.get("password", ""),
        )
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    return f"{user_key or 'legacy'}:{settings.get('server', 's4')}:{digest}"


def load_login_settings():
    """Return per-job Beacon settings when present, else legacy settings."""
    context = _auth_context.get()
    if context is not None:
        return dict(context.get("settings", {}))
    return _load_legacy_login_settings()


def _context_key():
    context = _auth_context.get()
    if context is None:
        return "legacy"
    return context.get("key") or "legacy"


@contextmanager
def use_auth_context(settings, key=None):
    """Bind Beacon credentials to the current thread/context."""
    token = _auth_context.set({
        "key": key or auth_context_key(settings),
        "settings": dict(settings),
    })
    try:
        yield
    finally:
        _auth_context.reset(token)


def _get_beacon_url(server=None):
    """Return the Beacon URL selected in the user's settings."""
    if server is None:
        settings = load_login_settings()
        server = settings.get("server", "s4")
    return BEACON_URLS.get(server, BEACON_URLS["s4"])


def login_via_api(username, password, server=None):
    """Authenticate against Beacon's OAuth2 password-token endpoint."""
    response = requests.post(
        _get_beacon_url(server).rstrip("/") + "/token",
        data={
            "grant_type": "password",
            "username": username,
            "password": password,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def _store_auth_token(token_data):
    """Cache an API token and the user ID returned with it."""
    _auth_tokens[_context_key()] = {
        "access_token": token_data.get("access_token"),
        "refresh_token": token_data.get("refresh_token"),
        "token_type": token_data.get("token_type", "bearer"),
        "expires_in": token_data.get("expires_in"),
        "user_id": token_data.get("Id"),
        "issued_at": time.time(),
    }


def _cache_keys_to_invalidate(cache_key):
    if cache_key is not None:
        return {cache_key}

    context_key = _context_key()
    if context_key != "legacy":
        return {context_key}

    return None


def invalidate_auth_token(cache_key=None):
    """Discard cached authentication after credentials or server change."""
    keys_to_invalidate = _cache_keys_to_invalidate(cache_key)
    if keys_to_invalidate is None:
        _auth_tokens.clear()
    else:
        for key in keys_to_invalidate:
            _auth_tokens.pop(key, None)

    for module_name, cache_names in {
        "app.api.cf2": ("_client_id_cache",),
        "app.api.beacon": ("_client_id_cache",),
        "app.api.soa": ("_client_ids_cache",),
    }.items():
        module = sys.modules.get(module_name)
        if module is None:
            continue
        for cache_name in cache_names:
            if hasattr(module, cache_name):
                cache = getattr(module, cache_name)
                if isinstance(cache, dict):
                    if keys_to_invalidate is None:
                        cache.clear()
                    else:
                        for context_key in keys_to_invalidate:
                            cache.pop(context_key, None)
                            for key in list(cache):
                                if (
                                    isinstance(key, tuple)
                                    and key
                                    and key[0] == context_key
                                ):
                                    cache.pop(key, None)
                elif keys_to_invalidate is None:
                    setattr(module, cache_name, None)
                else:
                    for key in list(keys_to_invalidate):
                        if cache == key:
                            setattr(module, cache_name, None)
                            break


def _ensure_auth_token(username=None, password=None):
    """Return a valid cached token or obtain a fresh one from Beacon."""
    auth_token = _auth_tokens.get(_context_key())
    if auth_token is not None:
        issued_at = auth_token.get("issued_at", 0)
        expires_in = auth_token.get("expires_in") or 0
        if time.time() < issued_at + max(expires_in - 60, 0):
            return auth_token.get("access_token")

    if username is None or password is None:
        settings = load_login_settings()
        username = settings.get("username", "")
        password = settings.get("password", "")

    token_data = login_via_api(username, password, server=load_login_settings().get("server", "s4"))
    _store_auth_token(token_data)
    return _auth_tokens[_context_key()].get("access_token")


def get_auth_token():
    """Return a Beacon bearer token, or ``None`` when login fails."""
    try:
        return _ensure_auth_token()
    except Exception as exc:
        logger.warning(f"get_auth_token(): could not obtain a token ({exc}).")
        return None


def get_user_id():
    """Return Beacon's user ID from the current OAuth2 token response."""
    try:
        _ensure_auth_token()
    except Exception as exc:
        logger.warning(f"get_user_id(): could not obtain a token ({exc}).")
        return None
    auth_token = _auth_tokens.get(_context_key())
    return auth_token.get("user_id") if auth_token else None
