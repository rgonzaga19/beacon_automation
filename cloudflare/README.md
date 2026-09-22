# License and update Worker

`worker.js` is based on the supplied Worker and retains its license entries and
license request/response format. Treat this file as private: it contains license
keys. Deploy it to the existing Cloudflare Worker, not a new endpoint.

Set these Worker variables in Cloudflare before publishing an update:

| Variable | Value |
| --- | --- |
| `UPDATE_VERSION` | Exact published installer version, such as `4.0.5` |
| `UPDATE_DOWNLOAD_URL` | HTTPS URL of that version's published installer |
| `UPDATE_SHA256` | SHA-256 of that exact installer; required |
| `UPDATE_NOTES` | Optional release notes, one per line |
| `MIN_SUPPORTED_VERSION` | Oldest version allowed to run automation; default `4.0.4` |
| `ENFORCE_MINIMUM_VERSION` | `true` to reject older clients; default `false` |

Compute the checksum on the actual installer you upload:

```powershell
Get-FileHash -LiteralPath 'Output\Beabots_Setup_v4.0.5.exe' -Algorithm SHA256
```

Replace the example version/path with the release you built. The source currently
reports version 4.0.5. For the new automatic-install changes, increment both
`app/core/version.py` and `BeaconInstaller.iss`, build and publish that installer,
then set matching Worker variables. Advertising 4.0.5 again will not update an
existing 4.0.5 installation.

`GET /update` returns `version`, `minimum_version`, `mandatory`, `notes`, `download`,
and `sha256`. An incomplete or invalid release configuration returns HTTP 503;
normal license validation continues, and minimum-version enforcement stays
inactive until the release configuration is valid. This avoids locking clients
out while no valid update manifest is available. Configuration validation cannot
verify whether the remote installer exists or matches the supplied checksum;
check the published download before enabling enforcement.

`POST /` still accepts `license`, `app_version`, and `machine_id`. Machine binding
is not implemented by this Worker. The app's automatic updater does not require
`mandatory: true`; that flag mirrors the minimum-version policy. Old desktop
builds without automatic installation still need the new build installed once.

This repository change does not deploy the Worker or publish an installer.

Run the local contract checks with `node --test tests/worker.test.mjs`.
