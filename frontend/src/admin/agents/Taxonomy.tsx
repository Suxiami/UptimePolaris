import { Autocomplete } from '@/components/ui/MotionOverlays';
import { AutocompleteItem, Chip } from '@heroui/react';
import { Plus } from 'lucide-react';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { taxonomyApi, type AgentGroup, type AgentTag } from './api';
import { usePresentation } from '../settings/presentation-api';

export function useAgentTaxonomy() {
  const presentation=usePresentation();
  const enabled=presentation.data?.config.agentEnabled===true;
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [tags, setTags] = useState<AgentTag[]>([]);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      if (enabled) {
        const [groupResult, tagResult] = await Promise.all([taxonomyApi.groups(), taxonomyApi.tags()]);
        setGroups(groupResult.groups);
        setTags(tagResult.tags);
      } else {setGroups([]);setTags([]);}
      setError(null);
    } catch (reason) { setError(reason); }
  }, [enabled]);
  useEffect(() => { void load(); }, [load]);
  const createGroup = async (name: string) => {
    const { id } = await taxonomyApi.save('groups', null, { name, weight: 0 });
    setGroups(items => [...items, { id, name, weight: 0, count: 0 }]);
    return id;
  };
  const createTag = async (name: string) => {
    const color = '#6366f1';
    const { id } = await taxonomyApi.save('tags', null, { name, color });
    setTags(items => [...items, { id, name, color, count: 0 }]);
    return id;
  };
  return { enabled, groups, tags, error: error ?? presentation.error, load, createGroup, createTag };
}

export function TaxonomyFields({ groups, tags, groupId, tagIds, onGroupChange, onTagsChange, onCreateGroup, onCreateTag, disabled }: {
  groups: AgentGroup[]; tags: AgentTag[]; groupId: string | null; tagIds: string[];
  onGroupChange: (id: string | null) => void; onTagsChange: (ids: string[]) => void;
  onCreateGroup: (name: string) => Promise<string>; onCreateTag: (name: string) => Promise<string>; disabled?: boolean;
}) {
  const t = useTranslations('admin');
  const apiErrorMessage = useApiErrorMessage();
  const groupName = groups.find(group => group.id === groupId)?.name ?? '';
  const [groupQuery, setGroupQuery] = useState(groupName);
  const [tagQuery, setTagQuery] = useState('');
  const [creating, setCreating] = useState<'group' | 'tag' | null>(null);
  const [error, setError] = useState('');
  const saving = useRef(false);
  useEffect(() => { setGroupQuery(groupName); }, [groupId, groupName]);
  const createGroupKey = '__create_group';
  const createTagKey = '__create_tag';
  const ungroupedKey = '__ungrouped';
  const canCreateGroup = groupQuery.trim() !== '' && !groups.some(group => group.name.toLocaleLowerCase() === groupQuery.trim().toLocaleLowerCase());
  const canCreateTag = tagQuery.trim() !== '' && !tags.some(tag => tag.name.toLocaleLowerCase() === tagQuery.trim().toLocaleLowerCase());
  const blocked = disabled || creating !== null;

  const create = async (kind: 'group' | 'tag') => {
    const name = (kind === 'group' ? groupQuery : tagQuery).trim();
    if (!name || disabled || saving.current) return;
    saving.current = true;
    setCreating(kind);
    setError('');
    try {
      if (kind === 'group') {
        onGroupChange(await onCreateGroup(name));
        setGroupQuery(name);
      } else {
        const id = await onCreateTag(name);
        onTagsChange([...tagIds, id]);
        setTagQuery('');
      }
    } catch (reason) { setError(apiErrorMessage(reason)); }
    finally { saving.current = false; setCreating(null); }
  };

  return <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
    <Autocomplete className="min-w-0" label={t('agentTaxonomy.group')} placeholder={t('agentTaxonomy.ungrouped')}
      allowsCustomValue isClearable={false} selectedKey={groupId ?? ungroupedKey} inputValue={groupQuery}
      onInputChange={setGroupQuery} isDisabled={blocked} isLoading={creating === 'group'}
      onSelectionChange={key => {
        if (key === null) return;
        if (key === createGroupKey) { void create('group'); return; }
        const id = key === ungroupedKey ? null : String(key);
        onGroupChange(id);
        setGroupQuery(groups.find(group => group.id === id)?.name ?? '');
      }}>
      <>
      <AutocompleteItem key={ungroupedKey} textValue={t('agentTaxonomy.ungrouped')}>{t('agentTaxonomy.ungrouped')}</AutocompleteItem>
      {groups.map(group => <AutocompleteItem key={group.id} textValue={group.name}>{group.name}</AutocompleteItem>)}
      {canCreateGroup ? <AutocompleteItem key={createGroupKey} textValue={groupQuery.trim()} startContent={<Plus size={14} />} className="text-primary">
        {t('groups.createFromQuery', { name: groupQuery.trim() })}
      </AutocompleteItem> : null}
      </>
    </Autocomplete>
    <div className="flex min-w-0 flex-col gap-2">
      <Autocomplete className="min-w-0" label={t('agentTaxonomy.tags')} allowsCustomValue isClearable={false}
        selectedKey={null} inputValue={tagQuery} onInputChange={setTagQuery} isDisabled={blocked} isLoading={creating === 'tag'}
        onSelectionChange={key => {
          if (key === null) return;
          if (key === createTagKey) { void create('tag'); return; }
          if (!tagIds.includes(String(key))) onTagsChange([...tagIds, String(key)]);
          setTagQuery('');
        }}>
        <>
        {tags.filter(tag => !tagIds.includes(tag.id)).map(tag => <AutocompleteItem key={tag.id} textValue={tag.name}>{tag.name}</AutocompleteItem>)}
        {canCreateTag ? <AutocompleteItem key={createTagKey} textValue={tagQuery.trim()} startContent={<Plus size={14} />} className="text-primary">
          {t('tags.createFromQuery', { name: tagQuery.trim() })}
        </AutocompleteItem> : null}
        </>
      </Autocomplete>
      {tagIds.length > 0 ? <div className="flex flex-wrap gap-1.5">
        {tags.filter(tag => tagIds.includes(tag.id)).map(tag => <Chip key={tag.id} size="sm" variant="flat"
          onClose={blocked ? undefined : () => onTagsChange(tagIds.filter(id => id !== tag.id))}>{tag.name}</Chip>)}
      </div> : null}
    </div>
    {error ? <p role="alert" className="text-small text-danger sm:col-span-2">{error}</p> : null}
  </div>;
}
