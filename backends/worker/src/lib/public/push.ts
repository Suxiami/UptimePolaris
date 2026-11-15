import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { parsePushReport, PUSH_BODY_MAX_BYTES } from '../../../../../shared/push-monitor';
import type { Env, Monitor } from '../../types';
import { safeEqual, sha256Hex } from '../auth/service';
import { getDB } from '../db/factory';
import { heartbeatSQL } from '../db/sql/heartbeat';
import { monitorSQL } from '../db/sql/monitors';

export const pushRoutes = new Hono<{ Bindings: Env }>();

pushRoutes.use('*', async (c, next) => {
  c.header('cache-control', 'private, no-store');
  await next();
});

pushRoutes.post('/:id', bodyLimit({
  maxSize: PUSH_BODY_MAX_BYTES,
  onError: c => c.json({ error: 'payload_too_large' }, 413),
}), async c => {
  const db = getDB(c.env);
  const monitor = await db.queryOne<Monitor>(monitorSQL[db.type].byId, [c.req.param('id')]);
  const token = /^Bearer ([^\s]+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
  const [provided, expected] = await Promise.all([
    sha256Hex(token), sha256Hex(monitor?.push_token || '0'.repeat(48)),
  ]);
  const authorized = safeEqual(provided, expected);
  if (!authorized || !token || !monitor?.push_token || monitor.type !== 'push' || !monitor.active) {
    c.header('www-authenticate', 'Bearer');
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (new URL(c.req.url).search) return c.json({ error: 'invalid_request' }, 400);

  const text = (await c.req.text()).trim();
  let input: unknown = {};
  if (text) {
    const mediaType = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json') return c.json({ error: 'unsupported_media_type' }, 415);
    try { input = JSON.parse(text); } catch { return c.json({ error: 'invalid_request' }, 400); }
  }
  const parsed = parsePushReport(input);
  if (parsed.error !== undefined) return c.json({ error: parsed.error }, 400);

  const now = Math.floor(Date.now() / 1000);
  const saved = await db.execute(heartbeatSQL[db.type].pushUpsert, [
    monitor.id, now, parsed.report.status, parsed.report.message, 0, monitor.id, monitor.push_token,
  ]);
  if (!saved.rowsAffected) {
    c.header('www-authenticate', 'Bearer');
    return c.json({ error: 'unauthorized' }, 401);
  }
  return c.json({ ok: true });
});

pushRoutes.all('/:id', c => {
  c.header('allow', 'POST');
  return c.json({ error: 'method_not_allowed' }, 405);
});
