import { Button, Input } from '@heroui/react';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { pushEndpointUrl } from './options';

export function PushReportDetails({ id, token }: { id: string; token: string }) {
  const t = useTranslations('admin');
  const apiErrorMessage = useApiErrorMessage();
  const [visible, setVisible] = useState(false);
  const url = pushEndpointUrl(id);
  const command = [
    'curl --fail-with-body -X POST \\',
    `  '${url}' \\`,
    '  -H "Authorization: Bearer $PUSH_TOKEN" \\',
    "  -H 'Content-Type: application/json' \\",
    `  --data '{"status":1,"message":"job-ok"}'`,
  ].join('\n');

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('form.pushCopied'));
    } catch (error) {
      toast.error(apiErrorMessage(error));
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Input
        isReadOnly
        label={t('form.pushUrl')}
        variant="bordered"
        value={url}
        description={t('form.pushUrlHint')}
        classNames={{ input: 'font-mono text-tiny' }}
        endContent={
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={`${t('form.pushCopy')} ${t('form.pushUrl')}`}
            onPress={() => { void copy(url); }}
          >
            <Copy size={16} />
          </Button>
        }
      />
      <Input
        isReadOnly
        label={t('form.pushToken')}
        variant="bordered"
        value={token}
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        description={t('form.pushTokenHint')}
        classNames={{ input: 'font-mono text-tiny' }}
        endContent={
          <div className="flex shrink-0 items-center">
            <Button
              isIconOnly
              size="sm"
              variant="light"
              aria-label={t(visible ? 'form.pushHideToken' : 'form.pushShowToken')}
              aria-pressed={visible}
              onPress={() => setVisible(value => !value)}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              aria-label={`${t('form.pushCopy')} ${t('form.pushToken')}`}
              onPress={() => { void copy(token); }}
            >
              <Copy size={16} />
            </Button>
          </div>
        }
      />
      <div className="min-w-0">
        <p className="mb-2 text-small font-medium">{t('form.pushExample')}</p>
        <pre className="polaris-well whitespace-pre-wrap break-all p-3 text-tiny leading-relaxed"><code>{command}</code></pre>
        <p className="mt-2 text-tiny text-default-500">{t('form.pushExampleHint')}</p>
      </div>
    </div>
  );
}
