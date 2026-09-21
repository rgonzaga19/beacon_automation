# Beabots

Beabots is a Flask and Socket.IO web application for Beacon automation workflows.
It serves the browser UI, app accounts, per-user Beacon credentials, workbook
uploads, CF2/SOA/CF4 automation endpoints, and live progress logs.

## Current Runtime

- `server.py` hosts the app and API.
- `beabots_launcher.py` is the packaged Windows entry point. It starts the
  local server and opens Beabots in the default browser.
- `renderer/` contains the browser UI.
- `renderer/assets/` contains frontend images and icons.
- `templates/` contains the CF2 Excel templates.
- `Beabots.spec` defines the PyInstaller build.
- `BeaconInstaller.iss` defines the Inno Setup installer. Keep its `AppId`
  unchanged so new installers upgrade existing installs.
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

## License Activation

Automation start endpoints require an active Beabots license. The license is
managed in Settings and validated against:

```text
https://beabot-license.gonzagaromel19.workers.dev/
```

For local testing, sign in to Beabots, open Settings, and activate a test
license key. The app checks the license on activation and then re-checks in the
background every 30 minutes.

The app sends:

```json
{
  "license": "<license key>",
  "app_version": "4.0.5",
  "machine_id": "<hashed machine id>"
}
```

If the license is invalid, expired, or the Worker returns `UPDATE_REQUIRED`,
CF2, SOA, and CF4 automation starts are blocked until the issue is fixed.

## Windows EXE and Installer

The distributable Windows app is built in two steps:

1. PyInstaller creates `dist\Beabots\Beabots.exe`.
2. Inno Setup packages that folder as `Output\Beabots_Setup_vX.X.X.exe`.

Build everything with:

```powershell
.\venv\Scripts\Activate.ps1
.\build_installer.ps1
```

If Inno Setup is installed somewhere else, pass the compiler path:

```powershell
.\build_installer.ps1 -InnoCompiler "C:\Path\To\ISCC.exe"
```

To build only the packaged EXE folder:

```powershell
.\venv\Scripts\Activate.ps1
python -m PyInstaller --clean Beabots.spec
```

To compile only the installer after `dist\Beabots` exists:

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" "BeaconInstaller.iss"
```

Test the packaged EXE directly:

```powershell
.\dist\Beabots\Beabots.exe
```

Test the installer:

```powershell
.\Output\Beabots_Setup_v4.0.5.exe
```

Installed user data remains in:

```text
%LOCALAPPDATA%\Beabots
```

## Releasing a New Version

When preparing a release:

1. Update `APP_VERSION` in `app/core/version.py`.
2. Update `MyAppVersion` in `BeaconInstaller.iss`.
3. Build the installer:

   ```powershell
   .\build_installer.ps1
   ```

4. Compute the installer checksum:

   ```powershell
   Get-FileHash Output\Beabots_Setup_vX.X.X.exe -Algorithm SHA256
   ```

5. Upload the installer to the release location used by the Cloudflare Worker.
6. Update the Worker `/update` response with the new version, download URL, and
   `sha256`.

Example Worker update payload:

```js
const UPDATE_INFO = {
  version: "4.0.5",
  minimum_version: "4.0.5",
  mandatory: false,
  download: "https://github.com/rgonzaga19/beacon_automation/releases/download/Beabots/Beabots_Setup_v4.0.5.exe",
  sha256: "4930215CF473DB4A564F0191E8EAE1E3DD0E609AD8796FE766C1EFA0AC799248",
};
```

The updater downloads newer installers in the background and verifies `sha256`
before applying them. The current installer uses `PrivilegesRequired=admin`, so
silent updates may still require Windows UAC on some machines.

## Environment Variables

```text
PORT=5417
HOST=0.0.0.0
DATABASE_URL=postgresql://...
SECRET_KEY=<long random secret>
FIELD_ENCRYPTION_KEY=<long random secret or Fernet key>
BEABOTS_UPLOAD_DIR=/tmp/beabots_uploads
BEABOTS_MAX_UPLOAD_MB=100
BEABOTS_LICENSE_URL=https://beabot-license.gonzagaromel19.workers.dev/
BEABOTS_LICENSE_CHECK_SECONDS=1800
BEABOTS_UPDATE_URL=https://beabot-license.gonzagaromel19.workers.dev/update
BEABOTS_UPDATE_CHECK_SECONDS=21600
BEABOTS_VERSION=4.0.5
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
beabots_launcher.py       Packaged Windows app entry point
Beabots.spec              PyInstaller build definition
BeaconInstaller.iss       Inno Setup installer definition
build_installer.ps1       Rebuilds EXE folder and installer
app/core/                 configuration, database, security, license, updater
app/api/                  Beacon, CF2, SOA, and draft API clients
app/automation/           CF2, SOA, CF4, and draft automation runners
app/domain/               parsers, mappers, data objects, and reports
app/models.py             users, settings, and automation job models
renderer/                 browser pages, CSS, and JavaScript
renderer/assets/          browser images and icons
templates/                Excel templates
docs/                     project notes
```
