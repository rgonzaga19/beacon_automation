import os
import sys
import base64
import re
import threading
import time
import webbrowser
from pathlib import Path

import requests
import webview

from app.core.config import get_data_dir
from app.core.updater import configure_desktop_updates

from server import (
    app,
    init_database,
    socketio,
    start_background_license_checker,
    start_background_updater,
    claim_update_installation,
    release_update_installation,
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

    def save_generated_file(self, filename, data_url):
        safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(filename or "")).strip()
        if not safe_name:
            safe_name = "generated.xlsx"

        suffix = Path(safe_name).suffix.lower()
        if suffix not in {".xlsx", ".zip"}:
            return {"ok": False, "error": "Unsupported generated file type."}

        header, separator, encoded = str(data_url or "").partition(",")
        if not separator or ";base64" not in header:
            return {"ok": False, "error": "Generated file data is invalid."}

        try:
            target = None
            if self._window is not None:
                file_type = "Excel Workbook (*.xlsx)" if suffix == ".xlsx" else "ZIP Archive (*.zip)"
                selected = self._window.create_file_dialog(
                    webview.SAVE_DIALOG,
                    directory=str(Path.home() / "Downloads"),
                    save_filename=safe_name,
                    file_types=(file_type,),
                )
                if selected:
                    if isinstance(selected, (list, tuple)):
                        selected = selected[0]
                    target = Path(selected)
                    if target.suffix.lower() != suffix:
                        target = target.with_suffix(suffix)

            if target is None:
                downloads = Path.home() / "Downloads"
                target_dir = downloads if downloads.is_dir() else get_data_dir() / "Downloads"
                target_dir.mkdir(parents=True, exist_ok=True)

                target = target_dir / safe_name
                stem = target.stem
                for index in range(1, 1000):
                    if not target.exists():
                        break
                    target = target_dir / f"{stem} ({index}){suffix}"

            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(encoded))
            return {"ok": True, "path": str(target)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}


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

        def close_for_update():
            try:
                window.evaluate_js("""(() => {
                    const notice = document.createElement('div');
                    notice.setAttribute('role', 'alert');
                    notice.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;text-align:center;background:var(--bg-dark,#0a0e16);color:var(--text-pri,#eef2f6);font:16px Segoe UI;padding:32px';
                    notice.textContent = 'Installing an update. Beabots will close and reopen automatically.';
                    document.body.appendChild(notice);
                })()""")
                time.sleep(4)
            except Exception:
                pass
            window.destroy()

        configure_desktop_updates(
            claim_update_installation, release_update_installation, close_for_update,
        )
        # Keep the persistent login cookie and theme across desktop restarts.
        webview.start(
            func=start_background_updater,
            private_mode=False,
            storage_path=str(get_data_dir() / "webview"),
        )
    except Exception:
        _open_fallback_browser(url)
        while True:
            time.sleep(60)
    finally:
        os._exit(0)
