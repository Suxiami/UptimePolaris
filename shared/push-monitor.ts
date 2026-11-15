export const PUSH_MESSAGE_MAX_LENGTH = 200;
export const PUSH_BODY_MAX_BYTES = 4096;

export interface PushCredentials {
  id: string;
  push_token: string;
}

export function isPushCredentials(input: unknown): input is PushCredentials {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).length === 2 &&
    typeof value.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id) &&
    typeof value.push_token === 'string' && /^[0-9a-f]{48}$/.test(value.push_token);
}

export interface PushReport {
  status: 0 | 1 | 2;
  message: string;
}

export function parsePushReport(input: unknown): { report: PushReport; error?: never } | { report?: never; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => key !== 'status' && key !== 'message')) return { error: 'invalid_request' };
  const body = input as Record<string, unknown>;
  if (body.status !== undefined && body.status !== 0 && body.status !== 1 && body.status !== 2) {
    return { error: 'push_status_invalid' };
  }
  if (body.message !== undefined &&
      (typeof body.message !== 'string' || Array.from(body.message).length > PUSH_MESSAGE_MAX_LENGTH)) {
    return { error: 'push_message_invalid' };
  }
  return { report: { status: (body.status ?? 1) as PushReport['status'], message: (body.message ?? '') as string } };
}
