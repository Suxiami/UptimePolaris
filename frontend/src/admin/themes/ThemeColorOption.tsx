import { Input } from '@heroui/react';
import { useTranslations } from 'use-intl';
import type { ThemeOption } from './types';

export function ThemeColorOption({ option, value, onChange, compact = false }: {
  option: ThemeOption;
  value: unknown;
  onChange: (value: string | undefined) => void;
  compact?: boolean;
}) {
  const t = useTranslations('admin.themes');
  const color = String(value ?? '');
  const valid = color === '' || /^#[0-9a-f]{6}$/i.test(color);
  const swatch = valid && color ? color : String(option.default ?? '#6366F1');
  return (
    <Input
      label={compact ? undefined : option.label}
      aria-label={compact ? option.label : undefined}
      description={compact ? undefined : option.description}
      size={compact ? 'sm' : 'md'}
      value={color}
      placeholder={String(option.default ?? '#6366F1')}
      maxLength={7}
      spellCheck="false"
      autoComplete="off"
      isInvalid={!valid}
      errorMessage={!valid ? t('optionColorInvalid') : undefined}
      classNames={{ base: compact ? 'w-[8.5rem]' : undefined, input: 'font-mono uppercase tracking-wide', inputWrapper: compact ? 'gap-2' : 'gap-3' }}
      onValueChange={(next) => onChange(next || undefined)}
      startContent={
        <span className={(compact ? 'h-5 w-5 rounded-[5px] ' : 'h-7 w-7 rounded-md ') + 'relative shrink-0 overflow-hidden border border-black/15 ring-offset-2 focus-within:ring-2 focus-within:ring-[var(--polaris-accent)] dark:border-white/20'} style={{ backgroundColor: swatch }}>
          <input type="color" value={swatch} aria-label={option.label} onChange={(event) => onChange(event.target.value.toUpperCase())} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </span>
      }
    />
  );
}
