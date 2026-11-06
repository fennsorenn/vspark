/**
 * Settings forms of the chat and redemption Action kinds (chat command, chat
 * pattern, chat keyword, keyword combo, redemption). Every field is a value
 * setting except a response's type (see @vspark/shared/actions), so editing
 * them never rebuilds the graph.
 */
import { useTranslation } from 'react-i18next';
import type { ActionRecord } from '../../../mesh/actions';
import { DraftText } from './draftInputs';
import {
  AccountField,
  CooldownField,
  CounterField,
  Field,
  RankField,
  ResponseEditor,
  TemplateField,
  type OnSetting,
} from './fields';

export interface KindFormProps {
  action: ActionRecord;
  onSetting: OnSetting;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const column = { display: 'flex', flexDirection: 'column', gap: 6 } as const;

export function ChatCommandForm({ action, onSetting }: KindFormProps) {
  const { t } = useTranslation('actions');
  const s = action.settings;
  return (
    <div style={column}>
      <Field label={t('form.command')}>
        <DraftText
          className="vs-action-command"
          value={str(s.command)}
          placeholder="!hug"
          onCommit={(v) => onSetting('command', v)}
        />
      </Field>
      <Field label={t('form.aliases')} hint={t('form.aliasesHint')}>
        <DraftText
          className="vs-action-aliases"
          value={str(s.aliases)}
          placeholder="cuddle, snuggle"
          onCommit={(v) => onSetting('aliases', v)}
        />
      </Field>
      <RankField value={s.minRank} onSetting={onSetting} />
      <CooldownField value={s.cooldown} onSetting={onSetting} />
      <Field
        label={t('form.argsPattern')}
        hint={t('form.argsPatternHint')}
        help={{ anchor: 'patterns', tip: t('help.patterns') }}
      >
        <DraftText
          className="vs-action-args-pattern"
          value={str(s.argsPattern)}
          placeholder="^@?(?<target>\w+)$"
          onCommit={(v) => onSetting('argsPattern', v)}
        />
      </Field>
      <CounterField value={s.counter} onSetting={onSetting} />
      <TemplateField
        label={t('form.reply')}
        placeholders="${user} ${args} ${count}"
      >
        <DraftText
          className="vs-action-reply"
          value={str(s.reply)}
          onCommit={(v) => onSetting('reply', v)}
        />
      </TemplateField>
      <AccountField value={s.account} onSetting={onSetting} />
    </div>
  );
}

export function ChatPatternForm({ action, onSetting }: KindFormProps) {
  const { t } = useTranslation('actions');
  const s = action.settings;
  return (
    <div style={column}>
      <Field
        label={t('form.pattern')}
        hint={t('form.patternHint')}
        help={{ anchor: 'patterns', tip: t('help.patterns') }}
      >
        <DraftText
          className="vs-action-pattern"
          value={str(s.pattern)}
          placeholder={'"(?<quote>.+)" - (?<who>.+)'}
          onCommit={(v) => onSetting('pattern', v)}
        />
      </Field>
      <RankField value={s.minRank} onSetting={onSetting} />
      <CooldownField value={s.cooldown} onSetting={onSetting} />
      <CounterField value={s.counter} onSetting={onSetting} />
      <TemplateField
        label={t('form.reply')}
        placeholders="${user} ${message} ${count}"
      >
        <DraftText
          className="vs-action-reply"
          value={str(s.reply)}
          onCommit={(v) => onSetting('reply', v)}
        />
      </TemplateField>
      <AccountField value={s.account} onSetting={onSetting} />
    </div>
  );
}

function KeywordsField({ action, onSetting }: KindFormProps) {
  const { t } = useTranslation('actions');
  return (
    <Field label={t('form.keywords')} hint={t('form.keywordsHint')}>
      <DraftText
        className="vs-action-keywords"
        value={str(action.settings.keywords)}
        placeholder="LUL, KEKW"
        onCommit={(v) => onSetting('keywords', v)}
      />
    </Field>
  );
}

function TriggerField({ action, onSetting }: KindFormProps) {
  const { t } = useTranslation('actions');
  return (
    <Field
      label={t('form.trigger')}
      hint={t('form.triggerHint')}
      help={{ anchor: 'trigger', tip: t('help.trigger') }}
    >
      <DraftText
        className="vs-action-trigger"
        value={str(action.settings.trigger)}
        onCommit={(v) => onSetting('trigger', v)}
      />
    </Field>
  );
}

export function ChatKeywordForm(props: KindFormProps) {
  const { t } = useTranslation('actions');
  const { action, onSetting } = props;
  const s = action.settings;
  return (
    <div style={column}>
      <KeywordsField {...props} />
      <CooldownField value={s.cooldown} onSetting={onSetting} />
      <ResponseEditor
        label={t('form.response')}
        path="response"
        slot={s.response}
        allowNone
        onSetting={onSetting}
      />
      <TriggerField {...props} />
      <AccountField value={s.account} onSetting={onSetting} />
    </div>
  );
}

/** The settings form per kind (Hotkey's lives in HotkeyForm.tsx). */
export const CHAT_FORMS: Record<string, (p: KindFormProps) => JSX.Element> = {
  chat_command: ChatCommandForm,
  chat_pattern: ChatPatternForm,
  chat_keyword: ChatKeywordForm,
};
