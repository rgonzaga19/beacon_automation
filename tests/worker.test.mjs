import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

// Import the ES-module Worker without changing the repository's package type.
const source = await readFile(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const env = {
  UPDATE_VERSION: '4.0.6', MIN_SUPPORTED_VERSION: '4.0.6',
  UPDATE_DOWNLOAD_URL: 'https://example.com/Beabots_Setup_v4.0.6.exe',
  UPDATE_SHA256: 'a'.repeat(64), ENFORCE_MINIMUM_VERSION: 'true',
};
// Read a fixture key from the supplied worker without copying it into tests/output.
const key = source.match(/key:\s*"([^"]+)"/)[1];
const request = (body) => new Request('https://worker.example/', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('update manifest matches the desktop updater contract', async () => {
  const response = await worker.fetch(new Request('https://worker.example/update'), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.version, '4.0.6');
  assert.equal(body.sha256, env.UPDATE_SHA256);
  assert.equal(body.download, env.UPDATE_DOWNLOAD_URL);
  assert.equal(body.mandatory, true);
});

test('missing checksum does not advertise an unusable update', async () => {
  const response = await worker.fetch(new Request('https://worker.example/update'), {});
  assert.equal(response.status, 503);
});

test('invalid release configuration is rejected', async () => {
  for (const change of [{ UPDATE_VERSION: '../4.0.6' }, { UPDATE_SHA256: 'bad' },
    { UPDATE_DOWNLOAD_URL: 'http://example.com/setup.exe' }, { MIN_SUPPORTED_VERSION: '9.0.0' }]) {
    const response = await worker.fetch(new Request('https://worker.example/update'), { ...env, ...change });
    assert.equal(response.status, 503);
  }
});

test('valid published release enforces minimum version', async () => {
  const body = await (await worker.fetch(request({ license: key, app_version: '4.0.5' }), env)).json();
  assert.equal(body.code, 'UPDATE_REQUIRED');
  assert.equal(body.latest_version, '4.0.6');
});

test('current client retains license compatibility', async () => {
  const body = await (await worker.fetch(request({ license: key, app_version: '4.0.6' }), env)).json();
  assert.equal(body.valid, true);
  assert.ok(body.owner && body.plan && body.expires);
});

test('incomplete release does not lock out older clients', async () => {
  const body = await (await worker.fetch(request({ license: key, app_version: '4.0.4' }), { ...env, UPDATE_SHA256: '' })).json();
  assert.equal(body.valid, true);
});

test('invalid licenses and malformed JSON remain rejected', async () => {
  assert.equal((await (await worker.fetch(request({ license: 'not-a-license' }), env)).json()).code, 'INVALID_LICENSE');
  const response = await worker.fetch(new Request('https://worker.example/', { method: 'POST', body: '{' }), env);
  assert.equal(response.status, 400);
});

test('CORS preflight is supported', async () => {
  const response = await worker.fetch(new Request('https://worker.example/', { method: 'OPTIONS' }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});
