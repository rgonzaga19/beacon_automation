import os
import sys
import threading
import time
import webbrowser

import requests
import webview

from server import (
    app,
    init_database,
    socketio,
    start_background_license_checker,
    start_background_updater,
)


APP_MUTEX_NAME = "Beabots-D2A91D2F-0B2F-4B8E-9B79-4B2B5A8D7F01"
_mutex_handle = None


class WindowAppearance:
    """Expose only theme selection to the web UI."""

    def __init__(self):
        self._window = None

    def set_titlebar_theme(self, theme):
        if theme not in ("dark", "light") or os.name != "nt" or self._window is None:
            return False

        import ctypes
        from ctypes import wintypes

        try:
            hwnd = wintypes.HWND(self._window.native.Handle.ToInt64())
            set_attribute = ctypes.windll.dwmapi.DwmSetWindowAttribute
            set_attribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
            set_attribute.restype = ctypes.c_long

            dark = wintypes.BOOL(theme == "dark")
            set_attribute(hwnd, 20, ctypes.byref(dark), ctypes.sizeof(dark))

            # COLORREF is 0x00BBGGRR; match theme.css background and text.
            colors = (0x160E0A, 0xF6F2EE) if theme == "dark" else (0xFBF7F5, 0x281810)
            results = []
            for attribute, color in zip((35, 36), colors):
                value = wintypes.DWORD(color)
                results.append(set_attribute(hwnd, attribute, ctypes.byref(value), ctypes.sizeof(value)))
            return all(result == 0 for result in results)
        except (AttributeError, OSError):
            # Other backends/older Windows versions keep their native appearance.
            return False


def _claim_single_instance():
    """Allow only one packaged Beabots process at a time on Windows."""
    if os.name != "nt":
        return True

    import ctypes

    global _mutex_handle
    kernel32 = ctypes.windll.kernel32
    _mutex_handle = kernel32.CreateMutexW(None, False, APP_MUTEX_NAME)
    already_exists = kernel32.GetLastError() == 183
    return not already_exists


def _wait_for_server(url, timeout_seconds=20):
    deadline = time.time() + timeout_seconds
    health_url = f"{url}/api/health"
    while time.time() < deadline:
        try:
            response = requests.get(health_url, timeout=1)
            if response.ok:
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def _run_server(host, port):
    socketio.run(
        app,
        host=host,
        port=port,
        allow_unsafe_werkzeug=True,
        use_reloader=False,
    )


def _open_fallback_browser(url):
    webbrowser.open(url)


if __name__ == "__main__":
    if not _claim_single_instance():
        sys.exit(0)

    init_database()
    start_background_license_checker()
    start_background_updater()

    port = int(os.environ.get("PORT") or os.environ.get("BEABOTS_PORT", 5417))
    host = os.environ.get("HOST", "127.0.0.1")
    url = f"http://127.0.0.1:{port}"

    threading.Thread(target=_run_server, args=(host, port), daemon=True).start()
    _wait_for_server(url)

    try:
        appearance = WindowAppearance()
        window = webview.create_window(
            "Beabots",
            url,
            width=1280,
            height=820,
            min_size=(980, 640),
            confirm_close=False,
            js_api=appearance,
        )
        appearance._window = window
        webview.start()
    except Exception:
        _open_fallback_browser(url)
        while True:
            time.sleep(60)
    finally:
        os._exit(0)
