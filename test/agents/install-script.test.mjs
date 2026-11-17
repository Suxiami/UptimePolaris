// 验证安装脚本的直接传参与下载失败处理。 / Check direct installer arguments and download failures.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bundled = await build({ stdin: { contents: "export {buildInstallCommand,shellQuote,powershellQuote} from './shared/agent-install.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { buildInstallCommand, shellQuote, powershellQuote } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const temp = mkdtempSync(join(tmpdir(), 'polaris-installer-'));
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, ...options });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result;
};
try {
  const commandPath = join(temp, 'copy-command.ps1');

  const token = "fixture'token;$(whoami)";
  const options = { detectPlatform: true, platformKey: 'linux-x86_64', endpoint: 'https://host.test', token, mode: 'user', sampleInterval: 10, reportInterval: 90, installDir: "/opt/O'Brien agent", registerCommand: false };
  const compactSh = buildInstallCommand(options, 'posix');
  const payload = '{\nprintf "arg:%s\\n" "$@"\n}\n';
  const shellFixture = join(temp, 'compact-command.sh');
  writeFileSync(shellFixture, `curl() { printf '%s' ${shellQuote(payload)}; return 0; }\n${compactSh}\nprintf 'parent:%s\\n' "$POLARIS_AGENT_TOKEN"\n`);
  const compactShell = run('sh', [shellFixture], { env: { ...process.env, POLARIS_AGENT_TOKEN: 'before-install' } });
  assert.ok(compactShell.stdout.includes(`arg:${token}\n`));
  assert.ok(compactShell.stdout.includes("arg:/opt/O'Brien agent\n"));
  assert.ok(compactShell.stdout.includes('arg:--no-register-command\n'));
  assert.ok(compactShell.stdout.includes('parent:before-install\n'));
  writeFileSync(shellFixture, `curl() { printf '%s' ${shellQuote(payload.slice(0, payload.lastIndexOf('}')))}; return 22; }\n${compactSh}\n`);
  const interrupted = spawnSync('sh', [shellFixture], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(interrupted.status, 0);
  assert.equal(interrupted.stdout, '', 'an interrupted download must not execute any part of the installer');

  const capturePath = join(temp, 'compact-result.json');
  const encode = source => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString('base64')}'))`;
  const fixturePs = `param($Endpoint,$Token,$Mode,$SampleInterval,$ReportInterval,$InstallDir,[switch]$NoRegisterCommand)\n@{endpoint=$Endpoint; token=$Token; mode=$Mode; sample=$SampleInterval; report=$ReportInterval; directory=$InstallDir; noCommand=[bool]$NoRegisterCommand} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${powershellQuote(capturePath)} -Encoding UTF8\nreturn`;
  const compactPs = buildInstallCommand({ ...options, platformKey: 'windows-x86_64' }, 'windows');
  writeFileSync(commandPath, `$fixture=${encode(fixturePs)}\nfunction Invoke-RestMethod { param($Uri) if ($Uri -ne 'https://raw.githubusercontent.com/XingLingQAQ/Polaris-Agent/main/install.ps1') { throw 'unexpected installer URL' }; $fixture }\n$env:POLARIS_AGENT_TOKEN='before-install'\n${compactPs}\nif ($env:POLARIS_AGENT_TOKEN -ne 'before-install') { throw 'credential environment was modified' }\nWrite-Output 'compact-returned'\n`);
  const compactPowerShell = run(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-File', commandPath]);
  assert.match(compactPowerShell.stdout, /compact-returned/);
  const compactResult = JSON.parse(readFileSync(capturePath, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(compactResult.endpoint, options.endpoint);
  assert.equal(compactResult.token, token);
  assert.equal(compactResult.mode, 'user');
  assert.equal(String(compactResult.sample), '10');
  assert.equal(String(compactResult.report), '90');
  assert.equal(compactResult.directory, options.installDir);
  assert.equal(compactResult.noCommand, true);
  writeFileSync(commandPath, `function Invoke-RestMethod { param($Uri) throw 'fixture download failure' }\n$env:POLARIS_AGENT_TOKEN='before-install'\ntry { ${compactPs}; throw 'installer should have failed' } catch { if ($_.Exception.Message -ne 'fixture download failure') { throw } }\nif ($env:POLARIS_AGENT_TOKEN -ne 'before-install') { throw 'credential environment was modified after failure' }\nWrite-Output 'expected-download-failure'\n`);
  assert.match(run(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-File', commandPath]).stdout, /expected-download-failure/);
  writeFileSync(commandPath, `function Invoke-RestMethod { param($Uri) "throw 'fixture installer failure'" }\ntry { ${compactPs}; throw 'installer should have failed' } catch { if ($_.Exception.Message -ne 'fixture installer failure') { throw } }\nWrite-Output 'expected-installer-failure'\n`);
  assert.match(run(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-File', commandPath]).stdout, /expected-installer-failure/);

} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('PASS direct GitHub installer commands: arguments, quoting and failure propagation');
