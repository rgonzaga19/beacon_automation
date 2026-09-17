# Beabots

Beabots is a Flask and Socket.IO web application for Beacon automation workflows.
It serves the browser UI, app accounts, per-user Beacon credentials, workbook
uploads, CF2/SOA/CF4 automation endpoints, and live progress logs.

## Current Runtime

- `server.py` hosts the app and API.
- `renderer/` contains the browser UI.
- `templates/` contains the CF2 Excel templates.
- Local user/account data defaults to `%LOCALAPPDATA%\Beabots\beabots.sqlite3`.
- Uploaded workbooks default to the system temp directory unless
  `BEABOTS_UPLOAD_DIR` is set.

## Local Network Use

Run the app on one host PC:

```powershell
cd "C:\Users\Nephro\Desktop\ROMEL\VS Code\beacon_automation"
.\venv\Scripts\Activate.ps1
python server.py
```

Other users on the same Wi-Fi/LAN can open:

```text
http://<host-pc-ip>:5417
```

If Windows blocks access, allow TCP port `5417` through the firewall:

```powershell
New-NetFirewallRule -DisplayName "Beabots Local Web" -Direction Inbound -Protocol TCP -LocalPort 5417 -Action Allow
```

Do not expose the local server to the public internet with router port
forwarding.

## Setup

```powershell
py -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python server.py
```

Open:

```text
http://127.0.0.1:5417
```

## Environment Variables

```text
PORT=5417
HOST=0.0.0.0
DATABASE_URL=postgresql://...
SECRET_KEY=<long random secret>
FIELD_ENCRYPTION_KEY=<long random secret or Fernet key>
BEABOTS_UPLOAD_DIR=/tmp/beabots_uploads
BEABOTS_MAX_UPLOAD_MB=100
```

`DATABASE_URL` is optional for local use. If it is not set, Beabots uses local
SQLite. For hosted or multi-machine deployment, use Postgres.

`SECRET_KEY` signs browser sessions. `FIELD_ENCRYPTION_KEY` encrypts saved
Beacon passwords. Keep both stable once users start saving credentials.

## Web Deployment

The app can run as a hosted web service with:

```bash
python server.py
```

Recommended temporary cloud setup:

```text
Render web service + Neon Postgres
```

Set `DATABASE_URL`, `SECRET_KEY`, `FIELD_ENCRYPTION_KEY`, and
`BEABOTS_UPLOAD_DIR` in the hosting provider.

## Main Files

```text
server.py                 Flask/Socket.IO entry point
app_config.py             database and secret configuration
database.py               SQLAlchemy extension
models.py                 users, settings, and automation job models
security.py               encrypted field helpers
browser_session.py        per-user Beacon API token handling
beacon.py                 CF4 automation runner
beacon_api.py             Beacon API helpers
cf2_api.py                CF2 Beacon API helpers
cf2_automation.py         CF2 automation runner
cf2_mapper.py             CF2 payload mapping
soa_api.py                SOA API helpers
soa_automation.py         SOA upload runner
renderer/                 browser pages, CSS, and JavaScript
templates/                Excel templates
```
