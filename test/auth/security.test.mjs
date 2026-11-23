import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import { workerBundlePlugins } from '../helpers/bundle-worker.mjs';

const built = await build({
  stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { api } from './backends/worker/src/api';
    import { createSession, hashPassword, sessionCookie } from './backends/worker/src/lib/auth/service';
    import { budgetedFetch } from './backends/worker/src/lib/http/request-budget';
    export default { async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (path === '/__seed') {
        await env.DB.prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at, failed_count, locked_until) VALUES (?,?,?,?,?,0,0)')
          .bind('fixture-owner', 'fixture-owner', await hashPassword('fixture-secret', 3000), 1, 1).run();
        const { token } = await createSession(env, 'fixture-owner', 'fixture');
        return Response.json({ cookie: sessionCookie(token, 3600, true).split(';')[0] });
      }
      if (path === '/__redirect') {
        const input = await request.json(), calls = [];
        globalThis.fetch = async (url, init) => {
          calls.push({ url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body });
          const step = input.responses[calls.length - 1];
          if (!step) throw new Error('unexpected request');
          return new Response(null, { status: step.status, headers: step.location ? { location: step.location } : {} });
        };
        try { const response = await budgetedFetch(input.url, input.init); return Response.json({ status: response.status, calls }); }
        catch { return Response.json({ blocked: true, calls }); }
      }
      return api.fetch(request, env, ctx);
    }};
  ` },
  bundle: true, write: false, format: 'esm', target: 'es2022', plugins: workerBundlePlugins(),
});
const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text, compatibilityDate: '2025-01-01',
  bindings: { ADMIN_TOKEN: 'fixture-admin', PBKDF2_ITERATIONS: '3000' },
  d1Databases: { DB: 'security-fixture' }, kvNamespaces: { CONFIG: 'security-fixture' },
});
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  const origin = 'https://status.example.test';
  const { cookie } = await (await mf.dispatchFetch(origin + '/__seed')).json();
  const channel = { name: 'fixture', type: 'webhook', config: { url: 'https://notify.example.test' } };
  const write = (path, body, headers = {}) => mf.dispatchFetch(origin + path, {
    method: 'POST', headers: { cookie, 'content-type': 'text/plain', ...headers }, body: JSON.stringify(body),
  });
  for (const path of ['/api/notifications', '/api/monitors', '/api/themes/install', '/api/admin/agents', '/api/admin/database-migration/execute', '/api/auth/login', '/api/auth/logout']) {
    const response = await write(path, channel, { origin: 'https://untrusted.example.test' });
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).error, 'invalid_origin');
  }
  for (const headers of [{ origin: 'null' }, { origin: 'http://status.example.test' }, { origin: origin + ':444' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await write('/api/notifications', channel, headers)).status, 403);
  }
  assert.equal((await write('/api/notifications', channel, { origin })).status, 201);
  assert.equal((await write('/api/notifications', channel, { cookie: '', origin: 'https://untrusted.example.test', authorization: 'Bearer fixture-admin' })).status, 201);
  assert.equal((await write('/api/notifications', channel, { cookie: '', authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await write('/api/public/push/missing', {}, { origin: 'https://untrusted.example.test' })).status, 401);
  for (const path of ['/api/monitors', '/api/admin/settings', '/api/admin/agents', '/api/notifications', '/api/monitors/%0A', '/api/admin/settings/%E2%80%A8']) {
    const response = await mf.dispatchFetch(origin + path);
    assert.ok([401, 404].includes(response.status), path);
  }
  const redirect = async (input) => (await mf.dispatchFetch(origin + '/__redirect', { method: 'POST', body: JSON.stringify(input) })).json();
  const headers = { 'x-api-key': 'fixture-key', authorization: 'Bearer fixture-token', accept: 'text/plain' };
  const crossed = await redirect({ url: 'https://a.example.test', init: { headers }, responses: [
    { status: 302, location: 'https://b.example.test' }, { status: 302, location: 'https://a.example.test/end' }, { status: 200 },
  ] });
  assert.equal(crossed.status, 200);
  assert.equal(crossed.calls[0].headers['x-api-key'], 'fixture-key');
  for (const call of crossed.calls.slice(1)) {
    assert.equal(call.headers['x-api-key'], undefined);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers.accept, 'text/plain');
  }
  for (const status of [307, 308]) {
    const result = await redirect({ url: 'https://a.example.test', init: { method: 'POST', body: 'fixture-secret', headers }, responses: [{ status, location: 'https://b.example.test' }] });
    assert.equal(result.blocked, true);
    assert.equal(result.calls.length, 1);
  }
  for (const status of [301, 302, 303]) {
    const result = await redirect({ url: 'https://a.example.test', init: { method: 'POST', body: 'fixture-secret', headers }, responses: [{ status, location: 'https://b.example.test' }, { status: 200 }] });
    assert.equal(result.status, 200);
    assert.equal(result.calls[1].method, 'GET');
    assert.equal(result.calls[1].body, undefined);
    assert.equal(result.calls[1].headers['x-api-key'], undefined);
    assert.equal(result.calls[1].headers.authorization, undefined);
  }
  for (const status of [301, 302]) {
    const result = await redirect({ url: 'https://a.example.test', init: { method: 'PUT', body: 'fixture-secret', headers }, responses: [{ status, location: 'https://b.example.test' }] });
    assert.equal(result.blocked, true);
    assert.equal(result.calls.length, 1);
  }
  const downgrade = await redirect({ url: 'https://a.example.test', init: { headers }, responses: [{ status: 302, location: 'http://a.example.test' }] });
  assert.equal(downgrade.blocked, true);
  const same = await redirect({ url: 'https://a.example.test', init: { method: 'POST', body: 'fixture-secret', headers }, responses: [{ status: 307, location: '/next' }, { status: 200 }] });
  assert.equal(same.calls[1].body, 'fixture-secret');
  assert.equal(same.calls[1].headers['x-api-key'], 'fixture-key');
  console.log('Worker security: origin gates, anonymous routes and redirect credentials passed');
} finally { await mf.dispose(); }
