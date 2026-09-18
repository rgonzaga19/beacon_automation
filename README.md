# Beabots

Beabots is a Flask and Socket.IO web application for Beacon automation workflows.
It serves the browser UI, app accounts, per-user Beacon credentials, workbook
uploads, CF2/SOA/CF4 automation endpoints, and live progress logs.

## Current Runtime

- `server.py` hosts the app and API.
- `renderer/` contains the browser UI.
- `renderer/assets/` contains frontend images and icons.
- `templates/` contains the CF2 Excel templates.
- `docs/` contains project notes, including the current structure map.
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

On Windows, you can also double-click `start_beabots.bat`. It starts the
server, waits until the health check responds, then opens Beabots in your
default browser.

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
app/core/                 configuration, database, security, settings, logging
app/api/                  Beacon, CF2, SOA, and draft API clients
app/automation/           CF2, SOA, CF4, and draft automation runners
app/domain/               parsers, mappers, data objects, and reports
app/models.py             users, settings, and automation job models
renderer/                 browser pages, CSS, and JavaScript
renderer/assets/          browser images and icons
templates/                Excel templates
docs/                     project notes
```
