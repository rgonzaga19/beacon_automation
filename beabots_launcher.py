import os
import threading
import time
import webbrowser

from server import (
    app,
    init_database,
    socketio,
    start_background_license_checker,
    start_background_updater,
)


def _open_browser(url):
    for _ in range(20):
        time.sleep(0.25)
        try:
            webbrowser.open(url)
            return
        except Exception:
            continue


if __name__ == "__main__":
    init_database()
    start_background_license_checker()
    start_background_updater()

    port = int(os.environ.get("PORT") or os.environ.get("BEABOTS_PORT", 5417))
    host = os.environ.get("HOST", "127.0.0.1")
    url = f"http://127.0.0.1:{port}"

    threading.Thread(target=_open_browser, args=(url,), daemon=True).start()
    socketio.run(app, host=host, port=port, allow_unsafe_werkzeug=True)
