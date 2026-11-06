/**
 * Form fields shared by the Action kinds' settings forms (account, rank,
 * cooldown, counter, template, response). Every field writes one settings path
 * through `onSetting` (the row decides whether that is a value write or a
 * confirmed rebuild). The draft input primitives live in `draftInputs.tsx`.
 */
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CHAT_RANKS, RESPONSE_TYPE_IDS } from '@vspark/shared/actions';
import { useEditorStore } from '../../../store/editorStore';
import { HelpButton } from '../../../help/HelpButton';
import { FieldEditor, effectiveFields } from '../macros/MacrosPanel';
import type { MacroFieldValue } from '../macros/types';
import { inputStyle, labelStyle } from './styles';
import { SettingCheck, DraftNumber, DraftText } from './draftInputs';

export type OnSetting = (path: string, value: unknown) => void;

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const hintStyle: CSSProperties = { fontSize: 9, color: '#666', marginLeft: 56 };

/** A labelled row: label, control(s), optional help button; optional hint
 *  line underneath. */
export function Field({
  label,
  children,
  hint,
  help,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  help?: { anchor: string; tip: string };
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <label style={labelStyle}>
        <span style={{ minWidth: 52 }}>{label}</span>
        {children}
        {help && (
          <HelpButton
            topic="actions"
            anchor={help.anchor}
            tip={help.tip}
            size={11}
          />
        )}
      </label>
      {hint && <div style={hintStyle}>{hint}</div>}
    </div>
  );
}

/** The overlive account the action listens and replies on; empty = the
 *  project's default account. */
export function AccountField({
  value,
  onSetting,
}: {
  value: unknown;
  onSetting: OnSetting;
}) {
  const { t } = useTranslation('actions');
  const accounts = useEditorStore((s) => s.overliveAccounts);
  const current = typeof value === 'string' ? value : '';
  const known = !current || accounts.some((a) => a.id === current);
  return (
    <Field
      label={t('form.account')}
      help={{ anchor: 'account', tip: t('help.account') }}
    >
      <select
        className="vs-action-account"
        value={current}
        onChange={(e) => onSetting('account', e.target.value)}
        style={{ ...inputStyle, maxWidth: 180 }}
      >
        <option value="">{t('form.defaultAccount')}</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
        {!known && <option value={current}>{t('form.missingAccount')}</option>}
      </select>
    </Field>
  );
}

export function RankField({
  value,
  onSetting,
}: {
  value: unknown;
  onSetting: OnSetting;
}) {
  const { t } = useTranslation('actions');
  return (
    <Field label={t('form.minRank')}>
      <select
        className="vs-action-min-rank"
        value={typeof value === 'string' ? value : 'everyone'}
        onChange={(e) => onSetting('minRank', e.target.value)}
        style={inputStyle}
      >
        {CHAT_RANKS.map((r) => (
          <option key={r} value={r}>
            {t(`rank.${r}`)}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function CooldownField({
  value,
  onSetting,
}: {
  value: unknown;
  onSetting: OnSetting;
}) {
  const { t } = useTranslation('actions');
  const cd = isObj(value) ? value : {};
  return (
    <Field
      label={t('form.cooldown')}
      help={{ anchor: 'cooldown', tip: t('help.cooldown') }}
    >
      <DraftNumber
        className="vs-action-cooldown-seconds"
        value={typeof cd.seconds === 'number' ? cd.seconds : 0}
        min={0}
        onCommit={(v) => onSetting('cooldown.seconds', v)}
      />
      <span>{t('form.seconds')}</span>
      <DraftText
        className="vs-action-cooldown-group"
        value={typeof cd.group === 'string' ? cd.group : ''}
        placeholder={t('form.cooldownGroup')}
        width={90}
        onCommit={(v) => onSetting('cooldown.group', v)}
      />
    </Field>
  );
}

export function CounterField({
  value,
  onSetting,
}: {
  value: unknown;
  onSetting: OnSetting;
}) {
  const { t } = useTranslation('actions');
  const c = isObj(value) ? value : {};
  const enabled = c.enabled === true;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Field
        label={t('form.counter')}
        help={{ anchor: 'counter', tip: t('help.counter') }}
      >
        <SettingCheck
          className="vs-action-counter-enabled"
          checked={enabled}
          label={t('form.counterEnabled')}
          onChange={(v) => onSetting('counter.enabled', v)}
        />
      </Field>
      {enabled && (
        <>
          <Field label="" hint={t('form.counterNameHint')}>
            <DraftText
              className="vs-action-counter-name"
              value={typeof c.name === 'string' ? c.name : ''}
              placeholder={t('form.counterName')}
              onCommit={(v) => onSetting('counter.name', v)}
            />
          </Field>
          <Field label="">
            <span>{t('form.counterStep')}</span>
            <DraftNumber
              className="vs-action-counter-step"
              value={typeof c.step === 'number' ? c.step : 1}
              onCommit={(v) => onSetting('counter.step', v)}
            />
            <SettingCheck
              className="vs-action-counter-persistent"
              checked={c.persistent !== false}
              label={t('form.counterPersistent')}
              onChange={(v) => onSetting('counter.persistent', v)}
            />
          </Field>
        </>
      )}
    </div>
  );
}

/** A reply / message template field: the input (passed as `children`, so its
 *  `vs-` handle is written at the call site) with the placeholders it offers
 *  as a hint. */
export function TemplateField({
  label,
  placeholders,
  children,
}: {
  label: string;
  placeholders: string;
  children: ReactNode;
}) {
  const { t } = useTranslation('actions');
  return (
    <Field
      label={label}
      hint={t('form.placeholders', { list: placeholders })}
      help={{ anchor: 'placeholders', tip: t('help.placeholders') }}
    >
      {children}
    </Field>
  );
}

/**
 * A response picker (type = shape setting) with the type's typed value
 * controls (the Macros panel's field editors, incl. the paramPath-typed
 * property value). `path` is the slot's settings path (`responses.0`,
 * `response`). With `allowNone` the empty choice ("no response") is
 * selectable; otherwise it is only a prompt.
 */
export function ResponseEditor({
  label,
  path,
  slot,
  allowNone,
  onSetting,
}: {
  label: string;
  path: string;
  slot: unknown;
  allowNone?: boolean;
  onSetting: OnSetting;
}) {
  const { t } = useTranslation('actions');
  const values = (isObj(slot) ? slot : {}) as Record<string, MacroFieldValue>;
  const type = typeof values.type === 'string' ? values.type : '';
  return (
    <div
      className="vs-action-response"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        alignItems: 'center',
        padding: 6,
        borderRadius: 4,
        background: '#10101a',
      }}
    >
      <span style={{ fontSize: 10, color: '#888', minWidth: 52 }}>{label}</span>
      <select
        className="vs-action-response-type"
        value={type}
        onChange={(e) => onSetting(`${path}.type`, e.target.value)}
        style={inputStyle}
      >
        <option value="" disabled={!allowNone}>
          {allowNone ? t('form.noResponse') : t('form.chooseResponse')}
        </option>
        {RESPONSE_TYPE_IDS.map((id) => (
          <option key={id} value={id}>
            {t(`responses.${id}`)}
          </option>
        ))}
      </select>
      {type &&
        effectiveFields({ defId: type, values }).map((f) => (
          <FieldEditor
            key={f.key}
            field={f}
            value={values[f.key]}
            values={values}
            className="vs-action-field"
            onChange={(v) => onSetting(`${path}.${f.key}`, v ?? null)}
          />
        ))}
    </div>
  );
}
