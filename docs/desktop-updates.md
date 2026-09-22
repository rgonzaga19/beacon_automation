# Automatic desktop updates

Packaged Windows builds check the configured update manifest at startup and every
six hours. Development runs and hosted web servers do not download or install
Windows updates.

Publish the installer first, then update the manifest at `BEABOTS_UPDATE_URL` with:

```json
{
  "version": "4.0.6",
  "download": "https://your-download-host/Beabots_Setup_v4.0.6.exe",
  "sha256": "<64-character SHA-256 hash of the published installer>"
}
```

Set matching release versions in `app/core/version.py` and `BeaconInstaller.iss`
before building. Keep the installer AppId unchanged. The example version above
does not publish or change the current release.

The app downloads and verifies the installer, waits until CF2, SOA, and CF4 jobs
are idle, then prevents new jobs from starting. Users see a brief “Installing an
update” message without an install or postpone button. A separate helper waits
for Beabots to exit, verifies the installer again, installs into the existing
application directory, and reopens Beabots as the original Windows user.

The existing installer requires administrator privileges. Windows can display a
UAC approval/credential prompt; silent installer flags cannot bypass that OS
requirement. If elevation is declined or installation fails, the helper attempts
to reopen the existing executable. An installation attempt is limited to once
per version per six hours to avoid restart loops. Failed downloads retry at the
next scheduled check. Successfully downloaded installers are reused.

Updater files and `install-result.txt` are stored in the app data directory's
`updates` folder (normally `%LOCALAPPDATA%/Beabots/updates`). User data, login
cookies, and settings remain in the app data directory.

Existing releases without the automatic handoff need this release installed once
before they can install later updates automatically. Test a real packaged upgrade
on Windows before distributing: active-job deferral, successful install/relaunch,
UAC cancellation, installer failure, and retained login/settings. Automated tests
mock the installer and do not verify actual Windows installation.
