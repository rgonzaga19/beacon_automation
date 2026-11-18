# Beabots

Beabots is a Flask and Socket.IO web application for Beacon automation. It serves browser pages, account authentication, per-user encrypted Beacon credentials, workbook uploads, automation endpoints, and live progress events.

## Run locally

```powershell
py -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python server.py
```

Open `http://127.0.0.1:5417`, create an account, and configure Beacon credentials in Settings. The server binds to `0.0.0.0` by default, so other devices on the same trusted LAN can use `http://<host-pc-ip>:5417`. Allow inbound TCP port 5417 in the host firewall if needed. Do not expose a local server directly to the public internet.

Local data uses SQLite under the current user's application data directory by default. Set `DATABASE_URL` to use PostgreSQL instead. Uploaded files and active automation data are temporary and may be lost on restart.

## Web deployment

The repository includes a Render Blueprint. It uses Gunicorn with one threaded worker and PostgreSQL; provide `DATABASE_URL` and retain stable `SECRET_KEY` and `FIELD_ENCRYPTION_KEY` values. `SESSION_COOKIE_SECURE=true` is set for the HTTPS hosted service. For local HTTP/LAN operation, leave that variable unset.

The Flask/Socket.IO process owns active automation jobs and progress state. Run All status and results can be restored for one hour after completion while the process remains running. A process restart ends active jobs and clears these in-memory snapshots, so deployment services must be configured to allow long-running requests.

## Configuration

- `HOST` (default `0.0.0.0`) and `PORT` (default `5417`) select the bind address and port.
- `DATABASE_URL` selects PostgreSQL; without it, local SQLite is used.
- `SECRET_KEY` signs web sessions.
- `FIELD_ENCRYPTION_KEY` encrypts saved Beacon passwords.
- `BEABOTS_UPLOAD_DIR` selects temporary upload storage.
- `BEABOTS_MAX_UPLOAD_MB` sets the upload limit (default `100`).

Web sessions expire after 15 minutes without user activity. Normal background requests do not extend the session.

Keep the session and encryption keys stable after users save credentials.

## Main files

```text
server.py                 Flask/Socket.IO entry point
web_entry.py              WSGI entry point for hosting
app/core/                 web configuration, database, security, sessions
app/api/                  Beacon, CF2, SOA, and draft API clients
app/automation/           automation runners
app/domain/               parsers, mappers, data objects, and reports
app/models.py             accounts, settings, and automation job models
renderer/                 browser pages, CSS, and JavaScript
templates/                Excel templates
render.yaml               Render web-service blueprint
```
