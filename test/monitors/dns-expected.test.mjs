import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';

const fixtures = JSON.parse(readFileSync('test/monitors/fixtures/dns-expected.json', 'utf8'));
const core = await build({
  stdin: { contents: `export * from './shared/dns-expected'; export { ApiError, apiErrorMessageKey } from './frontend/src/api/errors';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'error',
});
const { dnsExpectedError, ApiError, apiErrorMessageKey } = await import(`data:text/javascript;base64,${Buffer.from(core.outputFiles[0].text).toString('base64')}`);
for (const fixture of fixtures) {
  assert.equal(dnsExpectedError(fixture.recordType, fixture.expected), fixture.error, fixture.name);
  if (fixture.error) assert.equal(apiErrorMessageKey(new ApiError(fixture.error, 400)), `admin.form.dnsExpectedError.${fixture.error}`);
}
assert.equal(dnsExpectedError('A', '192.0.2.10'), null);
assert.equal(dnsExpectedError('AAAA', '192.0.2.10'), 'dns_expected_ipv6', 'switching record type revalidates the same value');

const form = readFileSync('frontend/src/admin/monitors/MonitorForm.tsx', 'utf8');
const expectedInputs = [...form.matchAll(/<Input\s+label=\{t\('form\.dnsExpected'\)\}[\s\S]*?\/>/g)];
assert.equal(expectedInputs.length, 2, 'standalone DNS and DNS add-on inputs');
for (const [input] of expectedInputs) {
  assert.match(input, /isInvalid=\{Boolean\(dnsError\)\}/);
  assert.match(input, /errorMessage=\{dnsErrorMessage\}/);
  assert.match(input, /description=\{dnsExpectedHint\}/);
}
assert.match(form, /const dnsError = dnsEnabled \? dnsExpectedError\(dnsRecordType, formOptions\.dns\?\.expected\)/);
assert.match(form, /!invalidUdp && !dnsError && canCreateWithSource/);
assert.match(form, /if \(out\.type === 'dns' \|\| out\.check_dns === 1\)/, 'serialize the selected default A for DNS add-ons too');
assert.match(form, /async function handleSave\(\) \{\s*if \(!canSubmit\) return;/);
assert.match(form, /async function handleTest\(\) \{\s*if \(!canSubmit \|\| testRequest\.current\) return;/);

const worker = await build({
  stdin: { contents: `import { api } from './backends/worker/src/api'; export default { fetch: (req, env, ctx) => api.fetch(req, env, ctx) };`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', target: 'es2022', logLevel: 'error',
  plugins: [{ name: 'test-transports', setup(b) {
    b.onResolve({ filter: /^cloudflare:sockets$|^postgres$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'postgres'
      ? `export default function postgres() { throw new Error('unexpected PostgreSQL connection'); }`
      : `export function connect() { throw new Error('unexpected socket probe'); }` }));
  } }],
});
const mf = new Miniflare({
  modules: true, script: worker.outputFiles[0].text, compatibilityDate: '2025-01-01', port: 0,
  bindings: { ADMIN_TOKEN: 'dns-test-admin' }, d1Databases: { DB: 'dns-expected-test' },
});
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  const request = async (method, path, body) => {
    const response = await mf.dispatchFetch(`https://dns.test${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: 'Bearer dns-test-admin' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const payload = dns => ({ name: 'DNS expected fixture', type: 'http', target: 'https://example.com', check_dns: 1, options_json: { dns } });
  const created = await request('POST', '/api/monitors', payload({ recordType: 'A', expected: '192.0.2.10' }));
  assert.equal(created.status, 201, JSON.stringify(created));
  const path = `/api/monitors/${created.body.id}`;
  const invalid = [
    ['A', 'example.com', 'dns_expected_ipv4'], ['A', '::1', 'dns_expected_ipv4'], ['A', '203.', 'dns_expected_ipv4'],
    ['AAAA', '192.0.2.10', 'dns_expected_ipv6'], ['AAAA', '2001:db8', 'dns_expected_ipv6'],
    ['CNAME', '192.0.2.10', 'dns_expected_domain'], ['NS', 'https://ns.example.com', 'dns_expected_domain'],
    ...['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].map(type => [type, null, 'dns_expected_string']),
    ['TXT', { contains: 'text' }, 'dns_expected_string'],
  ];
  for (const [recordType, expected, error] of invalid) {
    for (const [method, url, input] of [
      ['POST', '/api/monitors', payload({ recordType, expected })],
      ['POST', '/api/monitors/check', payload({ recordType, expected })],
      ['PUT', path, { options_json: JSON.stringify({ dns: { recordType, expected } }) }],
    ]) {
      const result = await request(method, url, input);
      assert.equal(result.status, 400, `${method} ${url}: ${JSON.stringify(result)}`);
      assert.equal(result.body.error, error);
    }
  }
  for (const [recordType, expected] of [
    ['A', '192.0.2.10'], ['AAAA', '2001:db8::1'], ['CNAME', 'Alias.Example.COM.'], ['NS', 'ns1.example.com.'],
    ['MX', 'mail'], ['MX', '10 mail.example.com.'], ['TXT', ' v=spf1 -all '], ['TXT', 'Mixed Case'], ['A', ''],
  ]) {
    const result = await request('PUT', path, { options_json: { dns: { recordType, expected } } });
    assert.equal(result.status, 200, JSON.stringify(result));
    const row = await db.prepare('SELECT options_json FROM monitors WHERE id = ?').bind(created.body.id).first();
    assert.deepEqual(JSON.parse(row.options_json).dns, { recordType, expected }, 'expected is stored verbatim');
  }
  assert.equal((await request('PUT', path, { options_json: { dns: { recordType: 'A' } } })).status, 200);
  assert.equal((await request('PUT', path, { name: 'rename with unchanged DNS options' })).status, 200);
  const defaults = await request('POST', '/api/monitors', payload({ expected: 'example.com' }));
  assert.equal(defaults.body.error, 'dns_expected_ipv4', 'omitted record type uses A');
  await db.prepare('UPDATE monitors SET options_json = ? WHERE id = ?').bind(JSON.stringify({ dns: { recordType: 'A', expected: '203.' } }), created.body.id).run();
  assert.equal((await request('PUT', path, { name: 'invalid stored DNS' })).body.error, 'dns_expected_ipv4');
  assert.equal((await request('PUT', path, { check_dns: 0 })).status, 200, 'disabled DNS does not validate unused expectations');
  assert.equal((await request('PUT', path, { check_dns: 1 })).body.error, 'dns_expected_ipv4', 'enabling DNS validates stored expectations');
  const row = await db.prepare('SELECT check_dns, options_json FROM monitors WHERE id = ?').bind(created.body.id).first();
  assert.equal(row.check_dns, 0, 'rejected update does not activate DNS');
  assert.equal(JSON.parse(row.options_json).dns.expected, '203.', 'invalid input is not auto-migrated');
  console.log(`PASS DNS expected: ${fixtures.length} shared format cases, both form inputs, Worker create/update/check and stored-option validation`);
} finally {
  await mf.dispose();
}
