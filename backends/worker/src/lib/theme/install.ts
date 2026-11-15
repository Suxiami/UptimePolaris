import type { Env } from '../../types';
import { PAGE_KINDS } from '../../../../../shared/presentation';
import { loadPresentation } from '../presentation/store';
import { visibilityRevisionWrite } from '../public/cache';
import { getDB } from '../db/factory';
import { themeSQL } from '../db/sql/themes';
import { isSafeThemePath, parseManifest, validOption, type ThemeManifest } from './manifest';
import { acquireThemeLease } from './lease';
import { contentTypeFor } from './storage';
import { readZip, ZipError } from './zip';

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
export const MAX_INSTALL_REQUEST_BYTES = 64 * 1024;
const MANIFEST_FILE = 'polaris-theme.json';
const ROOT_ASSET_PREFIX = /^(?:assets|static|fonts|img|images)\//;

export interface InstallSuccess { ok: true; id: string; short: string; version: string; versionKey: string; digest: string; prefix: string; files: number; bytes: number; manifest: ThemeManifest; }
export interface InstallFailure { ok: false; error: string; message: string; }
export type InstallResult = InstallSuccess | InstallFailure;
const failure = (error: string, message: string): InstallFailure => ({ ok: false, error, message });

export async function readBoundedStream(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ZipError('request body exceeds ' + maxBytes + ' bytes', 'too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new ZipError('response exceeds ' + maxBytes + ' bytes', 'too_large');
  return readBoundedStream(response.body, maxBytes);
}

function resolveAssetPath(directory: string, path: string, files: Map<string, { name: string; data: Uint8Array }>): string | undefined {
  const parts = directory.split('/').filter(Boolean);
  for (;;) {
    const candidate = [...parts, path].join('/');
    if (files.has(candidate)) return candidate;
    if (!parts.length) return undefined;
    parts.pop();
  }
}

function rewritePackagedAsset(reference: string, fromDirectory: string, files: Map<string, { name: string; data: Uint8Array }>): string | null {
  const splitAt = reference.search(/[?#]/);
  const pathname = splitAt < 0 ? reference : reference.slice(0, splitAt);
  const suffix = splitAt < 0 ? '' : reference.slice(splitAt);
  if (!pathname.startsWith('/') || !ROOT_ASSET_PREFIX.test(pathname.slice(1))) return reference;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname.slice(1)); } catch { return null; }
  const target = resolveAssetPath(fromDirectory, decoded, files);
  if (!target) return null;
  const from = fromDirectory.split('/').filter(Boolean);
  const to = target.split('/').filter(Boolean);
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  return ([...from.map(() => '..'), ...to.map(encodeURIComponent)].join('/') || './') + suffix;
}

function rewriteRootAssets(files: Array<{ name: string; data: Uint8Array }>, entryName: string): string | null {
  const byName = new Map(files.map((file) => [file.name, file]));
  const entry = byName.get(entryName);
  if (!entry) return 'entry_missing';
  const entryDirectory = entryName.includes('/') ? entryName.slice(0, entryName.lastIndexOf('/') + 1) : '';
  let missing: string | null = null;
  const html = new TextDecoder().decode(entry.data).replace(/<(?:script|link|img|source|video|audio)\b[^>]*>/gi, (tag) => tag.replace(/\b(src|href)\s*=\s*(["'])([^"']+)\2/i, (attribute, key: string, quote: string, value: string) => {
    const rewritten = rewritePackagedAsset(value, entryDirectory, byName);
    if (rewritten === null) { missing = value; return attribute; }
    return key + '=' + quote + rewritten + quote;
  }));
  if (missing) return 'root_asset_missing:' + missing;
  entry.data = new TextEncoder().encode(html);
  for (const file of files.filter((item) => item.name.toLowerCase().endsWith('.css'))) {
    const directory = file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/') + 1) : '';
    let css = new TextDecoder().decode(file.data);
    css = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, quote: string, value: string) => {
      const rewritten = rewritePackagedAsset(value.trim(), directory, byName);
      if (rewritten === null) { missing = value.trim(); return whole; }
      return 'url(' + quote + rewritten + quote + ')';
    });
    if (missing) return 'root_asset_missing:' + missing;
    file.data = new TextEncoder().encode(css);
  }
  return null;
}

function rewriteScriptAssets(files: Array<{ name: string; data: Uint8Array }>, prefix: string): string | null {
  const byName = new Map(files.map((file) => [file.name, file]));
  const encodedPrefix = prefix.split('/').map(encodeURIComponent).join('/');
  for (const file of files.filter((item) => /\.(?:m?js|cjs)$/i.test(item.name))) {
    const assetRoot = file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/') + 1) : '';
    let missing: string | null = null;
    let source = new TextDecoder().decode(file.data);
    source = source.replace(/(["'])(\/(?:assets|static|fonts|img|images)\/[^"'\s]*)\1/g, (match, quote: string, reference: string) => {
      const splitAt = reference.search(/[?#]/);
      const pathname = splitAt < 0 ? reference : reference.slice(0, splitAt);
      const suffix = splitAt < 0 ? '' : reference.slice(splitAt);
      let decoded: string;
      try { decoded = decodeURIComponent(pathname.slice(1)); } catch { missing = reference; return match; }
      const target = resolveAssetPath(assetRoot, decoded, byName);
      if (!target) { missing = reference; return match; }
      const encodedTarget = target.split('/').map(encodeURIComponent).join('/');
      return quote + '/theme/' + encodedPrefix + '/' + encodedTarget + suffix + quote;
    });
    if (missing) return 'root_asset_missing:' + missing;
    file.data = new TextEncoder().encode(source);
  }
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function installFromUrl(env: Env, source: string): Promise<InstallResult> {
  let url: URL;
  try { url = new URL(source); } catch { return failure('bad_url', 'source must be an HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) return failure('bad_url', 'source must be an HTTP(S) URL');
  let response: Response;
  try { response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) }); }
  catch (error) { return failure('download_failed', String(error)); }
  if (!response.ok) return failure('download_failed', 'source returned HTTP ' + response.status);
  let bytes: Uint8Array;
  try { bytes = await readBoundedResponse(response, MAX_PACKAGE_BYTES); }
  catch (error) { return failure(error instanceof ZipError ? error.code : 'download_failed', String(error)); }
  if (!bytes.length) return failure('empty_download', 'package is empty');
  return installPackage(env, bytes, url.toString());
}

export async function installFromUpload(env: Env, stream: ReadableStream<Uint8Array> | null, contentLength?: string | null): Promise<InstallResult> {
  if (Number(contentLength ?? 0) > MAX_PACKAGE_BYTES) return failure('package_too_large', 'package exceeds 32 MB');
  let bytes: Uint8Array;
  try { bytes = await readBoundedStream(stream, MAX_PACKAGE_BYTES); }
  catch (error) { return failure(error instanceof ZipError ? error.code : 'upload_failed', String(error)); }
  if (!bytes.length) return failure('empty_upload', 'package body is empty');
  return installPackage(env, bytes);
}

// 先校验包与资源依赖，再以主题租约串行上传和登记版本。
// Validate the package and asset dependencies before uploading and registering under the theme lease.
export async function installPackage(env: Env, bytes: Uint8Array, sourceUrl: string | null = null): Promise<InstallResult> {
  if (!env.THEMES) return failure('no_storage', 'THEMES storage is not configured');
  if (bytes.byteLength > MAX_PACKAGE_BYTES) return failure('package_too_large', 'package exceeds 32 MB');
  let files: Array<{ name: string; data: Uint8Array }>;
  try { files = await readZip(bytes, { maxEntries: 500, maxTotalBytes: MAX_PACKAGE_BYTES }); }
  catch (error) { return failure(error instanceof ZipError ? error.code : 'invalid_zip', String(error)); }
  const manifestFile = files.find((file) => file.name === MANIFEST_FILE);
  if (!manifestFile) return failure('manifest_missing', MANIFEST_FILE + ' is required at package root');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(manifestFile.data)); }
  catch { return failure('manifest_invalid_json', MANIFEST_FILE + ' is not valid JSON'); }
  const parsed = parseManifest(raw);
  if (!parsed.ok) return failure(parsed.error, parsed.error);
  const manifest = parsed.manifest;
  const lease = await acquireThemeLease(env, manifest.id);
  if (!lease) return failure('theme_busy', 'theme package is being installed or deleted; retry shortly');
  try {
  const packageFiles = files.filter((file) => file.name !== MANIFEST_FILE && !/(^|\/)(node_modules|\.git|__MACOSX)(\/|$)|\.map$/.test(file.name));
  for (const definition of manifest.themes) if (!packageFiles.some(file => file.name === definition.entry)) return failure('entry_missing', 'manifest entry is missing: ' + definition.entry);
  if (packageFiles.some((file) => !isSafeThemePath(file.name))) return failure('unsafe_path', 'package contains an unsafe file path');
  if (packageFiles.length > 500) return failure('too_many_files', 'package contains more than 500 files');
  for (const definition of manifest.themes) {
    const assetError = rewriteRootAssets(packageFiles, definition.entry);
    if (assetError) return failure(assetError.split(':', 1)[0], assetError);
  }
  const totalBytes = packageFiles.reduce((sum, file) => sum + file.data.byteLength, 0);
  if (totalBytes > MAX_PACKAGE_BYTES) return failure('package_too_large', 'expanded package exceeds 32 MB');

  const digest = await sha256Hex(bytes);
  const versionKey = manifest.version + '+' + digest;
  const prefix = 'themes/' + manifest.id + '/' + manifest.version + '/' + digest + '/' + crypto.randomUUID();
  const discardFiles = async () => {
    try { await env.THEMES!.delete(packageFiles.map(file => prefix + '/' + file.name)); } catch { }
  };
  const scriptAssetError = rewriteScriptAssets(packageFiles, prefix);
  if (scriptAssetError) return failure(scriptAssetError.split(':', 1)[0], scriptAssetError);
  try {
    for (const file of packageFiles) {
      await lease.renew();
      await env.THEMES.put(prefix + '/' + file.name, file.data, { httpMetadata: { contentType: contentTypeFor(file.name) } });
    }
    await lease.renew();
  } catch (error) {
    await discardFiles();
    return failure('storage_write_failed', String(error));
  }

  try {
    const db = getDB(env);
    const pg = db.type === 'postgres';
    const arg = (index: number) => pg ? `$${index}` : `?${index}`;
    let committed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await lease.renew();
      const state = await loadPresentation(env);
      for (const kind of PAGE_KINDS) {
        const page = state.config.pages[kind];
        if (page.theme?.short !== manifest.short) continue;
        const definition = manifest.themes.find(item => item.id === page.theme!.theme && item.target === kind);
        if (!definition) {
          await discardFiles();
          return failure('theme_unavailable', 'updated package does not include the active page theme');
        }
        page.theme.version = versionKey;
        page.themeOptions = Object.fromEntries(Object.entries(page.themeOptions).filter(([key, value]) => {
          const option = definition.options.find(item => item.key === key);
          return option && validOption(option, value);
        }));
      }
      const now = Math.floor(Date.now() / 1000), leaseTime = Date.now(), next = crypto.randomUUID();
      const write = `INSERT INTO presentation_state(id,config_json,revision,updated_at)
        SELECT 'main',${arg(1)},${arg(2)},${arg(3)}
        WHERE NOT EXISTS (SELECT 1 FROM themes WHERE (id=${arg(5)} AND (short<>${arg(6)} OR deleting=1)) OR (short=${arg(6)} AND id<>${arg(5)}))
          AND EXISTS (SELECT 1 FROM theme_operations WHERE id=${arg(5)} AND token=${arg(7)} AND expires_at>=${arg(8)})
        ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,revision=excluded.revision,updated_at=excluded.updated_at WHERE presentation_state.revision=${arg(4)}`;
      const registration = [manifest.id, versionKey, digest, prefix, JSON.stringify(parsed.raw), leaseTime, manifest.short, manifest.id, manifest.id, manifest.short, manifest.id, manifest.id, lease.token, leaseTime, next];
      const theme = [manifest.short, manifest.id, manifest.name, manifest.version, manifest.description ?? null, manifest.author ?? null, sourceUrl, JSON.stringify(parsed.raw), now, now, manifest.id, lease.token, leaseTime, next];
      const changes = await db.commit([
        ...(pg ? [{ sql: "SELECT pg_advisory_xact_lock(hashtext('polaris-presentation-theme'))", params: [] }] : []),
        { sql: write, params: [JSON.stringify(state.config), next, now, state.revision, manifest.id, manifest.short, lease.token, leaseTime] },
        { sql: themeSQL[db.type].insertVersion, params: registration },
        { sql: themeSQL[db.type].upsert, params: theme },
        { sql: `UPDATE theme_versions SET installed_at=${arg(1)} WHERE id=${arg(2)} AND version=${arg(3)} AND EXISTS (SELECT 1 FROM presentation_state WHERE id='main' AND revision=${arg(4)})`, params: [leaseTime, manifest.id, versionKey, next] },
        visibilityRevisionWrite(now, pg, next),
      ]);
      const offset = pg ? 1 : 0;
      if (changes[offset] === 1 && changes[offset + 2] === 1 && changes[offset + 3] === 1) { committed = true; break; }
      const conflict = await db.queryOne(`SELECT id FROM themes WHERE (id=${arg(1)} AND (short<>${arg(2)} OR deleting=1)) OR (short=${arg(2)} AND id<>${arg(1)})`, [manifest.id, manifest.short]);
      if (conflict) { await discardFiles(); return failure('theme_id_short_conflict', 'theme id and short are already bound to a different install'); }
    }
    if (!committed) { await discardFiles(); return failure('presentation_conflict', 'page settings changed during installation; retry shortly'); }
    const registered = await db.queryOne<{ prefix: string }>(themeSQL[db.type].version, [manifest.id, versionKey]);
    if (!registered) throw new Error('theme_version_registration_failed');
    if (registered.prefix !== prefix) await discardFiles();
    return { ok: true, id: manifest.id, short: manifest.short, version: manifest.version, versionKey, digest, prefix: registered.prefix, files: packageFiles.length, bytes: totalBytes, manifest };
  } catch (error) {
    const detail = String(error);
    if (detail.includes('theme_busy')) { await discardFiles(); return failure('theme_busy', 'theme operation lease expired; retry shortly'); }
    if (detail.includes('theme_id_short_conflict') || detail.includes('idx_themes_id') || detail.includes('UNIQUE constraint failed: themes.id')) {
      return failure('theme_id_short_conflict', 'theme id and short are already bound to a different install');
    }
    return failure('registry_write_failed', String(error));
  }
  } finally { try { await lease.release(); } catch { } }
}

export async function checkThemeUpdate(source: string, currentVersion: string, currentDigest: string | null, expectedId: string): Promise<{ available: boolean; current: string; latest: string; digest: string } | InstallFailure> {
  let url: URL;
  try { url = new URL(source); } catch { return failure('bad_url', 'source must be an HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) return failure('bad_url', 'source must be an HTTP(S) URL');
  let response: Response;
  try { response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) }); }
  catch (error) { return failure('download_failed', String(error)); }
  if (!response.ok) return failure('download_failed', 'source returned HTTP ' + response.status);
  let bytes: Uint8Array;
  try { bytes = await readBoundedResponse(response, MAX_PACKAGE_BYTES); }
  catch (error) { return failure(error instanceof ZipError ? error.code : 'download_failed', String(error)); }
  if (!bytes.length) return failure('empty_download', 'package is empty');
  let files: Array<{ name: string; data: Uint8Array }>;
  try { files = await readZip(bytes, { maxEntries: 500, maxTotalBytes: MAX_PACKAGE_BYTES }); }
  catch (error) { return failure(error instanceof ZipError ? error.code : 'invalid_zip', String(error)); }
  const manifestFile = files.find((file) => file.name === MANIFEST_FILE);
  if (!manifestFile) return failure('manifest_missing', MANIFEST_FILE + ' is required at package root');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(manifestFile.data)); } catch { return failure('manifest_invalid_json', MANIFEST_FILE + ' is not valid JSON'); }
  const parsed = parseManifest(raw);
  if (!parsed.ok) return failure(parsed.error, parsed.error);
  if (parsed.manifest.id !== expectedId) return failure('theme_id_changed', 'source package id does not match the installed theme');
  const digest = await sha256Hex(bytes);
  const current = currentVersion.split(/[+-]/, 1)[0].split('.').map(Number);
  const latest = parsed.manifest.version.split(/[+-]/, 1)[0].split('.').map(Number);
  const comparison = latest.findIndex((part, index) => part !== (current[index] ?? 0));
  const isNewerVersion = comparison >= 0 && latest[comparison] > (current[comparison] ?? 0);
  return { available: isNewerVersion || (parsed.manifest.version === currentVersion && digest !== currentDigest), current: currentVersion, latest: parsed.manifest.version, digest };
}
