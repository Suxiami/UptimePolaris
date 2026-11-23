import { safeEqual } from './service';

export function trustedWriteOrigin(request: Request, adminToken: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (adminToken && bearer && safeEqual(bearer, adminToken)) return true;
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === new URL(request.url).origin;
  const site = request.headers.get('sec-fetch-site');
  return site !== 'cross-site' && site !== 'same-site';
}
