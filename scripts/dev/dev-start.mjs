import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configOption, envOption, persistOption, wrangler } from '../wrangler-cli.mjs';
import { startDevRuntime } from './dev-runtime.mjs';
import { demoSkipReason } from './live-demo-data.mjs';

const args = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const remote = args.some(value => value === '--remote' || value.startsWith('--remote=') && value !== '--remote=false');
const option = (name, fallback) => {
  const inline = args.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

if (!remote) {
  const seedArgs = [join(here, 'seed-dev.mjs'), '--quiet'];
  const persist = persistOption(args);
  if (persist) {
    if (persist.duplicate || !persist.value || persist.value.startsWith('-')) throw new Error('Provide one path after --persist-to');
    seedArgs.push(`--persist-to=${persist.value}`);
  }
  const config = configOption(args);
  if (config) {
    if (config.duplicate || !config.value || config.value.startsWith('-')) throw new Error('Provide one path after --config / -c');
    seedArgs.push(`--config=${config.value}`);
  }
  const env = envOption(args);
  if (env) {
    if (env.duplicate || !env.value || env.value.startsWith('-')) throw new Error('Provide one name after --env / -e');
    seedArgs.push(`--env=${env.value}`);
  }
  const seed = spawn(process.execPath, seedArgs, { stdio: 'inherit', windowsHide: true });
  const code = await new Promise(resolve => { seed.once('error', () => resolve(1)); seed.once('close', code => resolve(code ?? 1)); });
  if (code !== 0) {
    console.error('[dev] Local database preparation failed; fix the error above before starting monitoring.');
    process.exit(code);
  }
}

const scheduled = !remote && !args.includes('--test-scheduled=false');
const serverArgs = ['dev', ...args];
if (scheduled && !args.some(value => value.startsWith('--test-scheduled'))) serverArgs.push('--test-scheduled');
if (!remote && process.env.UPTIME_DEV_NOTIFICATIONS === 'off') {
  serverArgs.push('--var', 'AUTOMATIC_NOTIFICATIONS_DISABLED:true');
  console.log('[dev] Automatic notifications are paused for this local session; monitoring and events remain enabled.');
}
/**
 * 本地开发需要 `CONFIG` KV 才能通过部署检查，但 `wrangler dev` 没有绑定参数。
 * 因此在临时目录生成一份配置副本，持久化路径指向临时状态；配置文件原地保留。
 * Local development needs a `CONFIG` KV binding to pass the deployment check, and `wrangler dev` has no binding flag.
 * A throwaway config copy with a temp state directory is used instead, leaving the tracked config untouched.
 */
function localConfig() {
  const selected = configOption(serverArgs);
  const source = selected ? resolve(selected.value ?? '') : join(here, '..', '..', 'backends', 'worker', 'wrangler.toml');
  if (!existsSync(source)) return null;
  const text = readFileSync(source, 'utf8');
  if (/^\s*\[\[kv_namespaces\]\]\s*\n\s*binding\s*=\s*"CONFIG"/m.test(text)) return null;
  const directory = mkdtempSync(join(tmpdir(), 'polaris-dev-'));
  const target = join(directory, 'wrangler.toml');
  writeFileSync(target, `${text.trimEnd()}\n\n# 本地开发注入：初始化检查要求 CONFIG 绑定。\n# Injected for local development: the setup check requires a CONFIG binding.\n[[kv_namespaces]]\nbinding = "CONFIG"\nid = "local-dev-config"\n`, 'utf8');
  return { target, directory };
}
const injected = remote ? null : localConfig();
if (injected) {
  const index = serverArgs.indexOf('--config');
  if (index >= 0) serverArgs.splice(index, 2);
  const inline = serverArgs.findIndex(value => value.startsWith('--config=') || value.startsWith('-c=') || /^-c./.test(value));
  if (inline >= 0) serverArgs.splice(inline, 1);
  serverArgs.push('--config', injected.target);
  console.log('[dev] Injected a local CONFIG KV binding for the setup check.');
}
const server = spawn(...wrangler(serverArgs), { stdio: 'inherit', windowsHide: true });
const serverClosed = new Promise(resolve => {
  server.once('error', error => { console.error(`[dev] Could not start Wrangler: ${error.message}`); resolve({ code: 1 }); });
  server.once('close', (code, signal) => resolve({ code: code ?? (signal === 'SIGINT' ? 130 : 1) }));
});
const port = Number(option('--port', 8787));
let runtime;
let stopping = null;
let startupFailed = false;
const stop = signal => {
  if (stopping) return;
  stopping = signal;
  if (server.exitCode === null && (signal === 'SIGTERM' || !process.stdin.isTTY)) server.kill(signal);
  void runtime?.close();
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

if (!remote) {
  try { runtime = await startDevRuntime({ origin: process.env.UPTIME_DEV_WORKER_URL ?? `http://127.0.0.1:${port}`, demo: !demoSkipReason(), scheduled }); }
  catch (error) {
    console.error(`[dev] Local monitoring could not start: ${error.message}`);
    startupFailed = true;
    stop('SIGTERM');
  }
}
const outcome = await serverClosed;
await runtime?.close();
if (injected) rmSync(injected.directory, { recursive: true, force: true });
process.exitCode = startupFailed ? 1 : stopping === 'SIGINT' ? 130 : outcome.code;
