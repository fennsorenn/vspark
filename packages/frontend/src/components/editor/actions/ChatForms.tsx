/**
 * Settings forms of the chat and redemption Action kinds (chat command, chat
 * pattern, chat keyword, keyword combo, redemption). Every field is a value
 * setting except a response's type (see @vspark/shared/actions), so editing
 * them never rebuilds the graph.
 */
import { useTranslation } from 'react-i18next';
import type { ActionRecord } from '../../../mesh/actions';
import { SettingCheck, DraftNumber, DraftText } from './draftInputs';
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
const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);

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

export function KeywordComboForm(props: KindFormProps) {
  const { t } = useTranslation('actions');
  const { action, onSetting } = props;
  const s = action.settings;
  return (
    <div style={column}>
      <KeywordsField {...props} />
      <Field
        label={t('form.threshold')}
        help={{ anchor: 'keyword_combo', tip: t('help.combo') }}
      >
        <DraftNumber
          className="vs-action-threshold"
          value={num(s.threshold, 5)}
          min={1}
          step={1}
          onCommit={(v) => onSetting('threshold', v)}
        />
        <span>{t('form.within')}</span>
        <DraftNumber
          className="vs-action-window"
          value={num(s.window, 10)}
          min={0}
          onCommit={(v) => onSetting('window', v)}
        />
        <span>{t('form.seconds')}</span>
      </Field>
      <Field label="">
        <SettingCheck
          className="vs-action-unique"
          checked={s.uniqueChatters !== false}
          label={t('form.uniqueChatters')}
          onChange={(v) => onSetting('uniqueChatters', v)}
        />
      </Field>
      <ResponseEditor
        label={t('form.onReached')}
        path="response"
        slot={s.response}
        allowNone
        onSetting={onSetting}
      />
      <TemplateField label={t('form.endMessage')} placeholders="${count}">
        <DraftText
          className="vs-action-end-message"
          value={str(s.endMessage)}
          onCommit={(v) => onSetting('endMessage', v)}
        />
      </TemplateField>
      <AccountField value={s.account} onSetting={onSetting} />
    </div>
  );
}

export function RedemptionForm(props: KindFormProps) {
  const { t } = useTranslation('actions');
  const { action, onSetting } = props;
  const s = action.settings;
  return (
    <div style={column}>
      <Field label={t('form.reward')} hint={t('form.rewardHint')}>
        <DraftText
          className="vs-action-reward"
          value={str(s.reward)}
          onCommit={(v) => onSetting('reward', v)}
        />
      </Field>
      <ResponseEditor
        label={t('form.response')}
        path="response"
        slot={s.response}
        allowNone
        onSetting={onSetting}
      />
      <CounterField value={s.counter} onSetting={onSetting} />
      <TemplateField
        label={t('form.reply')}
        placeholders="${user} ${message} ${reward} ${count}"
      >
        <DraftText
          className="vs-action-reply"
          value={str(s.reply)}
          onCommit={(v) => onSetting('reply', v)}
        />
      </TemplateField>
      <TriggerField {...props} />
      <Field label="">
        <SettingCheck
          className="vs-action-mark-complete"
          checked={s.markComplete === true}
          label={t('form.markComplete')}
          onChange={(v) => onSetting('markComplete', v)}
        />
      </Field>
      <AccountField value={s.account} onSetting={onSetting} />
    </div>
  );
}

/** The settings form per kind (Hotkey's lives in HotkeyForm.tsx). */
export const CHAT_FORMS: Record<string, (p: KindFormProps) => JSX.Element> = {
  chat_command: ChatCommandForm,
  chat_pattern: ChatPatternForm,
  chat_keyword: ChatKeywordForm,
  keyword_combo: KeywordComboForm,
  redemption: RedemptionForm,
};
