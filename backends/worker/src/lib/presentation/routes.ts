import { Hono } from 'hono';
import { PAGE_KINDS, parsePresentation, type PresentationConfig } from '../../../../../shared/presentation';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { pageTheme, validatePageTheme } from '../theme/registry';
import { loadPresentation, savePresentation } from './store';

export const presentationRoutes = new Hono<{ Bindings: Env }>();
async function pruneReferences(env: Env, config: PresentationConfig): Promise<PresentationConfig> {
  const result = structuredClone(config), db = getDB(env);
  for (const kind of PAGE_KINDS) {
    const page = result.pages[kind];
    const selected = await pageTheme(env, kind, page);
    for (const option of selected?.definition.options ?? []) {
      if (option.type !== 'monitor' && option.type !== 'agent') continue;
      const value = page.themeOptions[option.key];
      if (typeof value !== 'string') continue;
      const table = option.type === 'agent' ? 'agents' : 'monitors';
      if (!await db.queryOne(`SELECT id FROM ${table} WHERE id=${db.type === 'postgres' ? '$1' : '?'}`, [value])) delete page.themeOptions[option.key];
    }
  }
  return result;
}
presentationRoutes.get('/api/admin/presentation', async c => {
  const state = await loadPresentation(c.env);
  return c.json({ ...state, config: await pruneReferences(c.env, state.config) }, 200, { 'cache-control': 'private, no-store' });
});
presentationRoutes.put('/api/admin/presentation', async c => {
  const body = await c.req.json().catch(() => null);
  const config = parsePresentation(body?.config);
  if (!config || typeof body.revision !== 'string' || Object.keys(body).some(key=>!['config','revision'].includes(key))) return c.json({ error: 'invalid_presentation' }, 400);
  const previous = await loadPresentation(c.env);
  for (const kind of PAGE_KINDS) {
    const page = config.pages[kind];
    const old = previous.config.pages[kind].theme;
    if (old?.short !== page.theme?.short || old?.version !== page.theme?.version || old?.theme !== page.theme?.theme) {
      delete page.headCode;
      delete page.contentHtml;
      if (page.theme === null) page.themeOptions = {};
    }
    if (!await validatePageTheme(c.env, kind, page)) return c.json({ error: 'theme_unavailable', page: kind }, 409);
  }
  if (!await savePresentation(c.env, config, body.revision)) return c.json({ error: 'presentation_conflict' }, 409);
  return c.json(await loadPresentation(c.env));
});
