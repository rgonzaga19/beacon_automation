# License and update Worker

`worker.js` is based on the supplied Worker and retains its license entries and
license request/response format. Treat this file as private: it contains license
keys. Deploy it to the existing Cloudflare Worker, not a new endpoint.

Edit the `RELEASE` block near the top of `worker.js` for every release, then
paste/deploy the updated Worker. Cloudflare release variables are no longer used.

- `version`: the actual installer version.
- `download`: HTTPS URL of that exact installer.
- `sha256`: the actual installer's SHA-256 hash.
- `minimum_version`: oldest version permitted to run automation.
- `mandatory`: enable minimum-version enforcement when true.
- `notes`: array of release notes.

The block is populated for the local `Output/Beabots_Setup_v4.0.6.exe`, including
its computed checksum. Upload that exact file to the configured URL before
publishing this Worker; the remote asset has not been verified.

```powershell
Get-FileHash -LiteralPath 'Output\Beabots_Setup_v4.0.6.exe' -Algorithm SHA256
```

Recompute the hash after every build. To update an installed 4.0.6 app, build and
publish a higher version and update this block to match it.

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
