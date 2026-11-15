import { ApiError } from '@/api/errors';
import { fetchPublicConfig, publicConfigKey } from './api';
import { applyPreviewDraft, usePreviewDraft } from './preview-draft';
import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig, type SWRConfiguration } from 'swr';

export function usePublicConfigResource(key: string | null, options?: SWRConfiguration) {
  const { cache } = useSWRConfig();
  const resource = useSWR(key, fetchPublicConfig, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    shouldRetryOnError: false,
    dedupingInterval: 3000,
    ...options,
  });
  const draft = usePreviewDraft();
  const data = useMemo(() => resource.data && applyPreviewDraft(resource.data, draft), [resource.data, draft]);
  const revoked = resource.error instanceof ApiError && [401, 403, 404].includes(resource.error.status);
  const refresh = useCallback(async () => {
    const data = await resource.mutate();
    const error = key ? cache.get(key)?.error : undefined;
    if (error) throw error;
    return data;
  }, [resource.mutate, key, cache]);
  return { ...resource, data: revoked ? undefined : data, refresh };
}

export function usePublicConfig(pageId?: string) {
  const key = publicConfigKey(pageId);
  return { ...usePublicConfigResource(key), key };
}
