import { Drawer, Select } from '@/components/ui/MotionOverlays';
import { requestJson } from '@/api/client';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import {
  Button,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  Input,
  SelectItem,
  Switch,
} from '@heroui/react';
import clsx from 'clsx';
import { Check, Copy, Loader2, Plus, RadioTower, RefreshCw, Server } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  installModesForPlatform,
  safeInstallCommand,
  type InstallMode,
} from '../../../../shared/agent-install';
import { AgentCommandHelp } from './AgentCommandHelp';
import { agentsApi, taxonomyApi } from './api';
import { TaxonomyFields, useAgentTaxonomy } from './Taxonomy';
import { AnimatePresence, motion } from 'framer-motion';
import { CONTENT_TRANSITION, FEEDBACK_TRANSITION } from '@/lib/motion';
import { useReducedMotion } from '@/lib/useReducedMotion';
import type { FleetAgent } from './types';

/** 配置并创建 Agent，展示安装命令并等待首次上报。 / Configure and create an Agent, display installation commands, and wait for its first report. */
export function AddAgentPanel({
  open,
  agent,
  onClose,
  onCreated,
}: {
  open: boolean;
  agent?: FleetAgent;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const t = useTranslations('admin.agents');
  const reduced = useReducedMotion();
  const apiErrorMessage = useApiErrorMessage();
  const ta = useTranslations('admin');

  const taxonomy = useAgentTaxonomy();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [taxonomyPending, setTaxonomyPending] = useState(false);
  const [step, setStep] = useState<'configure' | 'install'>(agent ? 'install' : 'configure');
  const [name, setName] = useState('');
  const [probeEnabled, setProbeEnabled] = useState(true);

  const [installMode, setInstallMode] = useState<InstallMode>('system');
  const [sampleInterval, setSampleInterval] = useState('5');
  const [reportInterval, setReportInterval] = useState('60');
  const [installDir, setInstallDir] = useState('');
  const [filters, setFilters] = useState({ includeNics: '', excludeNics: '', includeMounts: '', excludeMounts: '' });
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [registerCommand, setRegisterCommand] = useState(true);

  const [busy, setBusy] = useState(!!agent);
  const [installAttempt, setInstallAttempt] = useState(0);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  /** Flipped when the first report arrives; unlocks "finish". / 首次上报后设为真，解锁“完成”。 */
  const [detected, setDetected] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pollError, setPollError] = useState('');
  const [pollAttempt, setPollAttempt] = useState(0);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !agent) return;
    const controller = new AbortController();
    const { signal } = controller;
    setBusy(true);
    setError('');
    void agentsApi.agentDetail(agent.id, signal).then((detail) => {
      if (signal.aborted) return;
      if (!detail.install?.token) throw new Error('invalid_response');
      setCreated({ id: agent.id, token: detail.install.token });
      setDetected(detail.agent.last_reported_at !== null);
    }).catch((failure) => {
      if (!signal.aborted) setError(apiErrorMessage(failure));
    }).finally(() => {
      if (!signal.aborted) setBusy(false);
    });
    return () => controller.abort();
  }, [open, agent?.id, installAttempt, apiErrorMessage]);

  const reset = () => {
    setStep('configure');
    setName('');
    setGroupId(null);
    setTagIds([]);
    setTaxonomyPending(false);
    setProbeEnabled(true);
    setInstallMode('system');
    setSampleInterval('5');
    setReportInterval('60');
    setInstallDir('');
    setFilters({ includeNics: '', excludeNics: '', includeMounts: '', excludeMounts: '' });
    setAutoUpdate(false);
    setRegisterCommand(true);
    setBusy(false);
    setError('');
    setCreated(null);
    setDetected(false);
    setChecking(false);
    setPollError('');
    setPollAttempt(0);
    setCopiedKey(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const endpoint = window.location.origin;
  const cadenceInvalid =
    !/^\d+$/.test(sampleInterval) ||
    !/^\d+$/.test(reportInterval) ||
    Number(sampleInterval) < 1 ||
    Number(reportInterval) > 1800 ||
    Number(sampleInterval) > Number(reportInterval);

  const installModes = installModesForPlatform('linux');
  const installCommands = useMemo(() => {
    if (!created || cadenceInvalid) return [];
    return ([
      { os: 'linux', label: 'Linux' },
      { os: 'windows', label: 'Windows' },
      { os: 'darwin', label: 'macOS' },
    ] as const).flatMap(({ os, label }) => {
      if (!installModesForPlatform(os).includes(installMode)) return [];
      const result = safeInstallCommand({
        detectPlatform: true,
        registerCommand,
        endpoint,
        token: created.token,
        mode: installMode,
        sampleInterval: Number(sampleInterval),
        reportInterval: Number(reportInterval),
        ...filters,
        installDir,
        autoUpdate: autoUpdate && installMode !== 'docker' && installMode !== 'manual',
      }, os);
      return [{ key: os, label, ...result }];
    });
  }, [created, cadenceInvalid, installMode, endpoint, sampleInterval, reportInterval, filters, installDir, autoUpdate, registerCommand]);

  const pollRef = useRef<number | null>(null);
  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open || !created || detected) return;
    let cancelled = false;
    const controller = new AbortController();
    const check = async () => {
      if (cancelled) return;
      setChecking(true);
      let found = false;
      try {
        const agents = await requestJson<{ agents: Array<{ id: string; last_reported_at: number | null }> }>('/api/admin/agents', { signal: controller.signal });
        if (cancelled) return;
        setPollError('');
        const row = agents.agents.find((agent) => agent.id === created.id);
        if (row && row.last_reported_at !== null) {
          found = true;
          setChecking(false);
          setDetected(true);
          stopPolling();
          await onCreatedRef.current();
        }
      } catch (failure) {
        if (!cancelled && !controller.signal.aborted && !found) setPollError(apiErrorMessage(failure));
      } finally {
        if (!cancelled && !controller.signal.aborted && !found) {
          setChecking(false);
          pollRef.current = window.setTimeout(() => void check(), 3000);
        }
      }
    };
    void check();
    return () => { cancelled = true; controller.abort(); stopPolling(); };
  }, [open, created, detected, pollAttempt, apiErrorMessage, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const canContinue = name.trim() !== '' && !cadenceInvalid;

  const create = async () => {
    if (busy || !canContinue) return;
    setBusy(true);
    setError('');
    try {
      const result = await agentsApi.createAgent({
        name: name.trim(),
        probe_enabled: probeEnabled,
      });
      setCreated({ id: result.id, token: result.token });
      setStep('install');
      if (taxonomy.enabled && (groupId || tagIds.length)) {
        try { await taxonomyApi.assign(result.id, groupId, tagIds); }
        catch (reason) { setTaxonomyPending(true); setError(apiErrorMessage(reason)); }
      }
      await onCreated();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 2000);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  return (
    <Drawer
      isOpen={open}
      onClose={close}
      placement="right"
      size="xl"
      scrollBehavior="inside"
      classNames={{ base: 'bg-[var(--polaris-canvas)]' }}
    >
      <DrawerContent>
        <DrawerHeader className="flex items-center gap-3 border-b border-[var(--polaris-line)] bg-[var(--polaris-card)] py-4">
          <Server size={18} className="text-default-500" />
          <span className="min-w-0">
            <p className="break-words text-medium font-semibold">{agent ? `${t('install')} · ${agent.name}` : t('addTitle')}</p>
            <p className="text-tiny font-normal text-default-500">
              {step === 'configure' ? t('addSubtitle') : t('addedSubtitle')}
            </p>
          </span>
        </DrawerHeader>

        <DrawerBody className="polaris-scroll-x min-h-0 gap-4 py-5">
          <AnimatePresence initial={false} mode="wait">
          <motion.div key={step} className="flex flex-col gap-4"
            initial={{ opacity: 0, transform: reduced ? 'none' : 'translateX(10px)' }}
            animate={{ opacity: 1, transform: 'none', transition: CONTENT_TRANSITION }}
            exit={{ opacity: 0, pointerEvents: 'none', transition: FEEDBACK_TRANSITION }}>
          {step === 'configure' ? (
            <>
              <div>
                <Input
                  autoFocus
                  isRequired
                  label={t('addName')}
                  placeholder={t('addNamePlaceholder')}
                  value={name}
                  onValueChange={setName}
                />
              </div>

              {taxonomy.enabled ? <TaxonomyFields groups={taxonomy.groups} tags={taxonomy.tags} groupId={groupId} tagIds={tagIds} onGroupChange={setGroupId} onTagsChange={setTagIds} onCreateGroup={taxonomy.createGroup} onCreateTag={taxonomy.createTag} disabled={busy || !!taxonomy.error} /> : null}
              {taxonomy.error ? <p role="alert" className="text-small text-danger">{apiErrorMessage(taxonomy.error)}</p> : null}
              <div className="polaris-well flex items-center justify-between gap-4 px-3.5 py-3">
                <div className="min-w-0">
                  <p className="text-tiny font-medium">{t('addProbeNode')}</p>
                  <p id="add-agent-probe-hint" className="mt-0.5 text-tiny text-default-500">{t('addProbeNodeHint')}</p>
                </div>
                <Switch size="sm" aria-label={t('addProbeNode')} aria-describedby="add-agent-probe-hint" classNames={{ base: 'shrink-0' }} isSelected={probeEnabled} onValueChange={setProbeEnabled} />
              </div>

              <div className="flex flex-col gap-3">
                <p className="text-tiny font-medium text-default-500">{t('installSettings')}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Select
                    items={installModes.map((value) => ({
                      key: value,
                      label: ta(value === 'manual' || value === 'docker' ? `agent.mode_${value}` : `agent.mode_${value}`),
                    }))}
                    label={ta('agent.installMode')}
                    selectedKeys={installModes.includes(installMode) ? [installMode] : []}
                    onChange={(event) => setInstallMode(event.target.value as InstallMode)}
                  >
                    {(item) => <SelectItem key={item.key} textValue={item.label}>{item.label}</SelectItem>}
                  </Select>
                  <Input
                    label={ta('agent.sampleInterval')}
                    type="number"
                    min={1}
                    max={1800}
                    value={sampleInterval}
                    onValueChange={setSampleInterval}
                    isInvalid={cadenceInvalid}
                  />
                  <Input
                    label={ta('agent.reportInterval')}
                    type="number"
                    min={1}
                    max={1800}
                    value={reportInterval}
                    onValueChange={setReportInterval}
                    isInvalid={cadenceInvalid}
                    errorMessage={cadenceInvalid ? ta('agent.cadenceInvalid') : undefined}
                  />
                  <Input label={ta('agent.installDir')} value={installDir} onValueChange={setInstallDir} />
                  <Input
                    label={ta('agent.includeNics')}
                    value={filters.includeNics}
                    onValueChange={(includeNics) => setFilters((current) => ({ ...current, includeNics }))}
                  />
                  <Input
                    label={ta('agent.excludeNics')}
                    value={filters.excludeNics}
                    onValueChange={(excludeNics) => setFilters((current) => ({ ...current, excludeNics }))}
                  />
                  <Input
                    label={ta('agent.includeMounts')}
                    value={filters.includeMounts}
                    onValueChange={(includeMounts) => setFilters((current) => ({ ...current, includeMounts }))}
                  />
                  <Input
                    label={ta('agent.excludeMounts')}
                    value={filters.excludeMounts}
                    onValueChange={(excludeMounts) => setFilters((current) => ({ ...current, excludeMounts }))}
                  />
                </div>
                {/*
                  A row of the same shape as the probe switch above, rather than
                  a bare toggle under the grid: alone in the flow it read as an
                  afterthought, and the explanation it needs had nowhere to go.

                  使用与上方探测开关相同的行样式，而非网格下方的裸开关；
                  单独放置会显得像事后补充，也没有空间展示必要说明。
                */}
                {installMode !== 'docker' ? (
                  <div className="polaris-well flex items-center justify-between gap-4 px-3.5 py-3">
                    <div className="min-w-0">
                      <p className="text-tiny font-medium">{ta('agent.autoUpdate')}</p>
                      <p id="add-agent-auto-update-hint" className="mt-0.5 text-tiny text-default-500">{ta('agent.autoUpdateHint')}</p>
                    </div>
                    <Switch size="sm" aria-label={ta('agent.autoUpdate')} aria-describedby="add-agent-auto-update-hint" classNames={{ base: 'shrink-0' }} isSelected={autoUpdate} onValueChange={setAutoUpdate} />
                  </div>
                ) : null}
                <div className="polaris-well flex items-center justify-between gap-4 px-3.5 py-3">
                  <div className="min-w-0">
                    <p className="text-tiny font-medium">{ta('agent.registerCommand')}</p>
                    <p className="mt-0.5 text-tiny text-default-500">{ta('agent.registerCommandHint')}</p>
                  </div>
                  <Switch size="sm" aria-label={ta('agent.registerCommand')} isSelected={registerCommand} onValueChange={setRegisterCommand} />
                </div>
              </div>

              {error ? <p role="alert" className="text-tiny text-danger-600">{error}</p> : null}
            </>
          ) : created ? (
            <>
              <div
                className={clsx(
                  'flex items-start gap-3.5 rounded-xl border p-4 transition-colors duration-200 motion-reduce:transition-none',
                  detected ? 'border-success/25 bg-success/[0.05]' : pollError ? 'border-warning/30 bg-warning/[0.04]' : 'border-[var(--polaris-line)] bg-[var(--polaris-well)]',
                )}
              >
                <span aria-hidden="true" className={clsx('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', detected ? 'bg-success/10 text-success-700' : pollError ? 'bg-warning/10 text-warning-700' : 'bg-[var(--polaris-canvas)] text-[var(--polaris-ink-3)] ring-1 ring-[var(--polaris-line)]')}>
                  {detected ? <Check size={22} /> : <RadioTower size={21} />}
                </span>
                <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 flex-1 pt-0.5">
                  <p className={clsx('text-small font-semibold', detected ? 'text-success-700' : 'text-[var(--polaris-ink)]')}>
                    {detected ? t('detectedTitle') : t('waitingTitle')}
                  </p>
                  <p className="mt-1 text-tiny leading-5 text-[var(--polaris-ink-3)]">
                    {detected ? t('detectedHint') : t('waitingHint')}
                  </p>
                </div>
                {!detected ? <Button isIconOnly size="sm" variant="light" aria-label={t('refresh')} className="shrink-0 text-[var(--polaris-ink-3)]" isLoading={checking} isDisabled={checking} onPress={() => setPollAttempt((value) => value + 1)}><RefreshCw size={16} /></Button> : null}
              </div>
              {pollError && !detected ? <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/[0.06] px-3 py-2 text-tiny text-warning-700"><span className="min-w-0 flex-1">{pollError}</span><Button size="sm" variant="light" isDisabled={checking} onPress={() => setPollAttempt((value) => value + 1)}>{ta('action.retry')}</Button></div> : null}

              {installCommands.length > 0 ? (
                <div className="flex flex-col gap-3">
                  <p className="text-tiny font-medium text-default-500">{ta('agent.howToInstall')}</p>
                  <p className="text-tiny text-default-500">{ta('agent.autoDetectArch')}</p>

                  {installCommands.map((entry) => (
                    <div key={entry.key} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-medium tracking-wide text-default-600">{entry.label}</span>
                        <Button
                          className="ml-auto"
                          size="sm"
                          color="primary"
                          variant="flat"
                          startContent={copiedKey === entry.key ? <Check size={14} /> : <Copy size={14} />}
                          isDisabled={!entry.command}
                          onPress={() => { if (entry.command) void copy(entry.command, entry.key); }}
                        >
                          {copiedKey === entry.key ? t('installTokenCopied') : t('installTokenCopy')}
                        </Button>
                      </div>
                      {entry.command ? (
                        <code className="break-all rounded-medium bg-content2 px-3 py-2 font-mono text-tiny text-default-700 whitespace-pre-wrap">
                          {entry.command}
                        </code>
                      ) : <p role="alert" className="text-tiny text-danger-600">{entry.error}</p>}
                    </div>
                  ))}

                  {installDir ? (
                    <span className="min-w-0 truncate text-tiny text-default-400">
                      {ta('agent.installDir')}: {installDir}
                    </span>
                  ) : null}
                </div>
              ) : (
                <p className="text-tiny text-danger-600">{ta('agent.cadenceInvalid')}</p>
              )}

              <p className="text-tiny text-default-400">{ta('agent.installNote')}</p>
              {registerCommand ? <AgentCommandHelp mode={installMode} /> : null}
            </>
          ) : busy ? <p role="status" className="flex items-center gap-2 text-small text-default-500"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />{t('loading')}</p> : null}
          {step === 'install' && error ? <div role="alert" className="flex flex-wrap items-center gap-2 text-small text-danger"><span className="min-w-0 flex-1">{error}</span>{agent && !created ? <Button size="sm" variant="light" isDisabled={busy} onPress={() => setInstallAttempt((value) => value + 1)}>{ta('action.retry')}</Button> : null}</div> : null}
          </motion.div>
          </AnimatePresence>
        </DrawerBody>

        {taxonomyPending && created ? <div className="px-5 text-small text-danger"><p>{ta('agentTaxonomy.assignmentFailed')}</p><Button size="sm" variant="flat" isLoading={busy} onPress={() => { setBusy(true); void taxonomyApi.assign(created.id, groupId, tagIds).then(async () => { setTaxonomyPending(false); setError(''); await onCreated(); }).catch(reason => setError(apiErrorMessage(reason))).finally(() => setBusy(false)); }}>{ta('action.retry')}</Button></div> : null}
        <DrawerFooter className="border-t border-[var(--polaris-line)] bg-[var(--polaris-card)]">
          {step === 'configure' ? (
            <>
              <Button variant="light" onPress={close}>{t('cancel')}</Button>
              <Button
                color="primary"
                startContent={<Plus size={15} />}
                isLoading={busy}
                isDisabled={!canContinue}
                onPress={() => void create()}
              >
                {t('continue')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="light" onPress={close}>{t('installLater')}</Button>
              <Button
                color="primary"
                isDisabled={!detected}
                // "Finish" means the agent is reporting; until then the only
                // honest action is to leave and come back.
                // “完成”表示 Agent 已上报；此前只能离开并稍后返回。
                onPress={close}
              >
                {t('finish')}
              </Button>
            </>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
