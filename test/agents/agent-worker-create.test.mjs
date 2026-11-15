import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { workerBundlePlugins } from '../helpers/bundle-worker.mjs';
import releaseSource from '../../shared/agent-release-repository.json' with { type: 'json' };

const repository = releaseSource.repository;
const tag = 'v0.2.0';
const file = 'polaris-agent-0.2.0-linux-x86_64';
const manifest = { repository, tag, version: '0.2.0', platforms: [
  { key: 'linux-x86_64', file, version: '0.2.0', size: 7, sha256: 'a'.repeat(64) },
] };
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
  import worker from './backends/worker/src/index';
  const manifest = ${JSON.stringify(manifest)};
  const latest = 'https://github.com/${repository}/releases/latest/download/manifest.json';
  const release = 'https://github.com/${repository}/releases/download/${tag}/manifest.json';
  const asset = 'https://release-assets.githubusercontent.com/fixture/manifest.json';
  const requests = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('https://api.github.com/')) return Response.json({ message: 'API rate limit exceeded' }, { status: 403 });
    if (url === latest) return new Response(null, { status: 302, headers: { location: release } });
    if (url === release) return new Response(null, { status: 302, headers: { location: asset } });
    if (url === asset) return Response.json(manifest);
    throw new Error('Unexpected fixture fetch');
  };
  export default { fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/__requests') return Response.json(requests);
    if (new URL(request.url).pathname === '/__configuration') return env.CONFIG.get('database', 'json').then(value => Response.json(value));
    return worker.fetch(request, env, ctx);
  } };
` }, bundle: true, write: false,
  format: 'esm', target: 'es2022', plugins: workerBundlePlugins(), logLevel: 'error' });
const admin = 'agent-create-fixture-admin';
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, host: '127.0.0.1', port: 0,
  compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'], kvNamespaces: { CONFIG: 'agent-create-fixture-config' },
  analyticsEngineDatasets: { UPTIME: { dataset: 'agent_create_fixture' } },
  bindings: { ADMIN_TOKEN: admin, PBKDF2_ITERATIONS: '3000' } });
const request = (path, method = 'GET', body) => mf.dispatchFetch('http://fixture.test' + path, {
  method, redirect: 'manual', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function checked(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
try {
  await checked(await request('/api/auth/setup', 'POST', {
    credential: admin, username: 'agent-create-fixture', password: 'agent-create-fixture-password',
  }));
  assert.equal((await checked(await request('/__configuration'))).type, 'd1');
  const agent = await checked(await request('/api/admin/agents', 'POST', {
    name: 'Terra-Worker Agent creation regression', probe_enabled: true,
  }), 201);
  assert.ok(agent.id && agent.token);
  assert.deepEqual((await checked(await request('/api/admin/agents'))).agents.map(row => row.id), [agent.id]);
  const builds = await checked(await request('/api/public/agent/capabilities'));
  assert.deepEqual(builds, manifest);
  const download = await request(`/api/public/agent/download/${file}`);
  assert.equal(download.status, 302);
  assert.equal(download.headers.get('location'), `https://github.com/${repository}/releases/download/${tag}/${file}`);
  assert.deepEqual(await checked(await request('/api/public/agent/manifest')), manifest);
  await checked(await request(`/api/admin/agents/${agent.id}`, 'DELETE'));
  assert.deepEqual((await checked(await request('/api/admin/agents'))).agents, []);
  const requests = await checked(await request('/__requests'));
  assert.equal(requests.some(url => url.startsWith('https://api.github.com/')), false);
  assert.equal(requests.length, 3);
  console.log('PASS Worker Agent creation and release discovery with D1 + CONFIG KV despite an exhausted GitHub API quota');
} finally {
  await mf.dispose();
}
