/**
 * The generated settings form of a plugin Action kind: one row per declared
 * `FormField` (@vspark/shared/actions). Built-in kinds keep their hand-written
 * forms (HotkeyForm, ChatForms). Labels and hints are i18n keys already
 * qualified with the plugin's namespace at registration.
 */
import { useTranslation } from 'react-i18next';
import type { FormField } from '@vspark/shared/actions';
import type { PluginAccountDoc } from '@vspark/shared/types';
import { useCollection, useMeshAll } from '@vspark/mesh-react';
import type { ActionRecord } from '../../../mesh/actions';
import { DraftNumber, DraftText, SettingCheck } from './draftInputs';
import {
  AccountField,
  CooldownField,
  Field,
  RankField,
  type OnSetting,
} from './fields';
import { inputStyle } from './styles';

/** Read a dotted path from the settings. */
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** i18n key of a select option: `option.<path>.<value>` in the field's
 *  namespace (the value itself is shown when there is no translation). */
export function optionKey(field: FormField, value: string): string {
  const ns = field.label.includes(':') ? `${field.label.split(':')[0]}:` : '';
  return `${ns}option.${field.path}.${value}`;
}

/** `vs-` handle of a generated control: shared base + per-path suffix. */
const handle = (path: string) =>
  `vs-action-schema-field vs-action-schema-field-${path.replace(/\./g, '-')}`;

/** The built-in field widgets write fixed paths (`minRank`, `cooldown.*`,
 *  `account`); re-target their writes to the declared path. */
const retarget =
  (onSetting: OnSetting, fixed: string, path: string): OnSetting =>
  (p, v) =>
    onSetting(path + p.slice(fixed.length), v);

/** A plugin provider's accounts in this project; empty = the default one. */
function PluginAccountSelect({
  className,
  provider,
  projectId,
  value,
  onChange,
}: {
  className: string;
  provider: string;
  projectId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation('actions');
  const accounts = useMeshAll(useCollection<PluginAccountDoc>('plugin_account')).filter(
    (a) => a.projectId === projectId && a.provider === provider
  );
  const known = !value || accounts.some((a) => a.id === value);
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
      <option value="">{t('form.defaultAccount')}</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.label}
        </option>
      ))}
      {!known && <option value={value}>{t('form.missingAccount')}</option>}
    </select>
  );
}

function SchemaRow({
  field,
  value,
  onSetting,
  projectId,
}: {
  field: FormField;
  value: unknown;
  onSetting: OnSetting;
  projectId: string;
}) {
  const { t } = useTranslation('actions');
  const label = t(field.label);
  const hint = [
    field.hint ? t(field.hint) : '',
    field.placeholders?.length
      ? field.placeholders.map((p) => '${' + p + '}').join(' ')
      : '',
  ]
    .filter(Boolean)
    .join(' — ');
  const set = (v: unknown) => onSetting(field.path, v);
  const str = typeof value === 'string' ? value : '';
  const num = typeof value === 'number' ? value : (field.min ?? 0);

  switch (field.control) {
    case 'rank':
      return <RankField value={value} onSetting={retarget(onSetting, 'minRank', field.path)} />;
    case 'cooldown':
      return <CooldownField value={value} onSetting={retarget(onSetting, 'cooldown', field.path)} />;
    case 'account':
      if (!field.provider || field.provider === 'overlive')
        return <AccountField value={value} onSetting={retarget(onSetting, 'account', field.path)} />;
      return (
        <Field label={label} hint={hint || undefined}>
          <PluginAccountSelect
            className={handle(field.path)}
            provider={field.provider}
            projectId={projectId}
            value={str}
            onChange={set}
          />
        </Field>
      );
    case 'toggle':
      return (
        <Field label="" hint={hint || undefined}>
          <SettingCheck className={handle(field.path)} checked={value === true} label={label} onChange={set} />
        </Field>
      );
    case 'number':
    case 'slider':
    case 'duration':
      return (
        <Field label={label} hint={hint || undefined}>
          <DraftNumber className={handle(field.path)} value={num} min={field.min} step={field.step} onCommit={set} />
          {field.control === 'duration' && <span>{t('form.seconds')}</span>}
        </Field>
      );
    case 'select':
      return (
        <Field label={label} hint={hint || undefined}>
          <select
            className={handle(field.path)}
            value={str}
            onChange={(e) => set(e.target.value)}
            style={inputStyle}
          >
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {t(optionKey(field, o), { defaultValue: o })}
              </option>
            ))}
          </select>
        </Field>
      );
    case 'color':
      return (
        <Field label={label} hint={hint || undefined}>
          <input
            type="color"
            className={handle(field.path)}
            value={str || '#ffffff'}
            onChange={(e) => set(e.target.value)}
          />
        </Field>
      );
    default: {
      // text / textarea / list: a list is kept as text (comma / newline
      // separated) and split by the kind's normalize.
      const text = Array.isArray(value) ? value.join(', ') : str;
      return (
        <Field label={label} hint={hint || undefined}>
          <DraftText className={handle(field.path)} value={text} onCommit={set} />
        </Field>
      );
    }
  }
}

export function SchemaForm({
  form,
  action,
  onSetting,
}: {
  form: readonly FormField[];
  action: ActionRecord;
  onSetting: OnSetting;
}) {
  const projectId = action.projectId;
  const s = action.settings;
  const read = (path: string) => readPath(s, path);
  return (
    <div className="vs-action-schema-form" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {form
        .filter((f) => !f.when || f.when(read))
        .map((f) => (
          <SchemaRow key={f.path} field={f} value={read(f.path)} onSetting={onSetting} projectId={projectId} />
        ))}
    </div>
  );
}
