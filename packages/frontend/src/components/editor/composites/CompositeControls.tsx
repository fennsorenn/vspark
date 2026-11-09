/**
 * Setting controls of the stream widgets (see @vspark/shared/composites and
 * dev-notes/plans/stream-widgets.md) that do more than edit one field:
 *  - `duration`: seconds edited as H:MM:SS;
 *  - `timer`: Start / Pause / Resume / Reset of a `deadline` node's timer,
 *    written straight into its variable (the node follows the change);
 *  - `variable`: a number kept in a project variable (a goal set by hand);
 *  - `stages`: the subathon's soft-limit stages, with the end time each one
 *    corresponds to given the planned start.
 * Variable writes stay off the undo stack (runtime state, not an edit).
 */
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { toGraphDescriptor } from '@vspark/shared/signal';
import {
  partDoc,
  type CompositeSetting,
  type CompositeTypeDef,
  type CompositeView,
} from '@vspark/shared/composites';
import {
  deadlineOps,
  deadlineStateOf,
  parseDateTime,
  runtimeVariableId,
  variableRef,
  type VariableRef,
} from '@vspark/shared/variables';
import { useEditorStore } from '../../../store/editorStore';
import { Countdown, formatCountdown } from '../../../lib/feedTemplate';
import { useVariable, writeVariable } from '../../../mesh/variables';
import { collectionOf } from '../../../mesh/docs';
import { DraftNumber, DraftText } from '../actions/draftInputs';
import { inputStyle } from '../actions/styles';

type Doc = Record<string, unknown>;

// ── Durations ───────────────────────────────────────────────────────────────

/** Seconds as H:MM:SS (hours keep counting past 24). */
export const formatDuration = (seconds: number): string =>
  formatCountdown(seconds, 'hh:mm:ss').replace(/^0(\d):/, '$1:');

/**
 * A typed duration → seconds: `1:30:00` / `5:00` (h:mm:ss / m:ss), `1h 30m`,
 * `90s`, or a plain number of minutes. null when it isn't one.
 */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === '') return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) * 60;
  if (/^\d+(:\d{1,2}){1,2}$/.test(t)) {
    const parts = t.split(':').map(Number);
    if (parts.slice(1).some((p) => p > 59)) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  const units = /(\d+(?:\.\d+)?)\s*(h|m|s)/g;
  let total = 0;
  let matched = '';
  for (const m of t.matchAll(units)) {
    total += Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
    matched += m[0];
  }
  return matched.replace(/\s/g, '') === t.replace(/\s/g, '') && matched
    ? total
    : null;
}

export function DurationInput({
  className,
  value,
  onCommit,
}: {
  className: string;
  value: number;
  onCommit: (seconds: number) => void;
}) {
  return (
    <DraftText
      className={className}
      value={formatDuration(value)}
      placeholder="h:mm:ss"
      onCommit={(text) => {
        const s = parseDuration(text);
        if (s !== null && s >= 0) onCommit(s);
      }}
    />
  );
}

// ── The variable a graph node names ─────────────────────────────────────────

interface NodeVar {
  ref: VariableRef | null;
  cfg: Doc;
  /** The graph's other nodes, for settings that depend on them. */
  nodes: { id: string; kind: string; defaultConfig?: unknown }[];
  edges: { fromNodeId: string; fromPort: string; toNodeId: string; toPort: string }[];
}

/** The project variable a `deadline` / `variable` node addresses: its
 *  `name`, and its `scope` — the graph's own id when a `logic_id` node is
 *  wired into it. */
function useNodeVariable(
  view: CompositeView,
  def: CompositeTypeDef,
  setting: CompositeSetting
): NodeVar | null {
  const projectId = useEditorStore((s) => s.projectId);
  const at = setting.node;
  const part = at ? partDoc(view, def, at.part) : undefined;
  if (!at || !part) return null;
  const g = toGraphDescriptor(
    part.doc.descriptor as Parameters<typeof toGraphDescriptor>[0]
  );
  const node = g.nodes.find((n) => n.id === at.id);
  if (!node) return null;
  const cfg = (node.defaultConfig ?? {}) as Doc;
  const scopeFrom = g.edges.find(
    (e) => e.toNodeId === at.id && e.toPort === 'scope'
  );
  const scope =
    scopeFrom &&
    g.nodes.find((n) => n.id === scopeFrom.fromNodeId)?.kind === 'logic_id'
      ? part.id
      : typeof cfg.scope === 'string'
        ? cfg.scope
        : '';
  return {
    ref: variableRef(projectId, scope, cfg.name),
    cfg,
    nodes: g.nodes,
    edges: g.edges,
  };
}

const buttonStyle: CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
  padding: '3px 8px',
};

// ── Timer buttons ───────────────────────────────────────────────────────────

export function TimerControl({
  view,
  def,
  setting,
}: {
  view: CompositeView;
  def: CompositeTypeDef;
  setting: CompositeSetting;
}) {
  const { t } = useTranslation('composites');
  const nv = useNodeVariable(view, def, setting);
  const raw = useVariable(nv?.ref ?? null);
  if (!nv?.ref) return <span style={{ color: '#666' }}>{t('unavailable')}</span>;
  const ref = nv.ref;
  const state = deadlineStateOf(raw);
  const persistent = nv.cfg.persistent === true;
  const put = (next: unknown) => writeVariable(ref, next, persistent);

  // Start length: counting to a time of day when a Date / Time node feeds the
  // duration, else the configured duration.
  const startSeconds = (): number | null => {
    const into = nv.edges.find(
      (e) => e.toNodeId === setting.node!.id && e.toPort === 'duration'
    );
    const src = into && nv.nodes.find((n) => n.id === into.fromNodeId);
    if (src?.kind === 'date_time') {
      const at = parseDateTime(
        ((src.defaultConfig ?? {}) as Doc).text
      );
      return at === null ? null : at - Date.now() / 1000;
    }
    const d = Number(nv.cfg.duration);
    return Number.isFinite(d) ? d : null;
  };

  const status = state.finished
    ? t('timer.finished')
    : state.running
      ? t('timer.running')
      : state.remaining > 0
        ? t('timer.paused')
        : t('timer.idle');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <Countdown
          state={state}
          format="auto"
          className="vs-composite-timer-time"
        />
        <span style={{ color: '#777' }}>{status}</span>
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="vs-composite-timer-start"
          style={buttonStyle}
          onClick={() => {
            const s = startSeconds();
            if (s !== null) put(deadlineOps.start(s));
          }}
        >
          {state.running || state.remaining > 0
            ? t('timer.restart')
            : t('timer.start')}
        </button>
        {state.running ? (
          <button
            type="button"
            className="vs-composite-timer-pause"
            style={buttonStyle}
            onClick={() => put(deadlineOps.pause(state))}
          >
            {t('timer.pause')}
          </button>
        ) : (
          <button
            type="button"
            className="vs-composite-timer-resume"
            style={buttonStyle}
            disabled={state.finished || state.remaining <= 0}
            onClick={() => put(deadlineOps.resume(state))}
          >
            {t('timer.resume')}
          </button>
        )}
        <button
          type="button"
          className="vs-composite-timer-reset"
          style={buttonStyle}
          onClick={() => put(deadlineOps.reset())}
        >
          {t('timer.reset')}
        </button>
      </div>
    </div>
  );
}

// ── A number in a variable ──────────────────────────────────────────────────

export function VariableControl({
  view,
  def,
  setting,
  keyClass,
}: {
  view: CompositeView;
  def: CompositeTypeDef;
  setting: CompositeSetting;
  keyClass: string;
}) {
  const { t } = useTranslation('composites');
  const nv = useNodeVariable(view, def, setting);
  const raw = useVariable(nv?.ref ?? null);
  if (!nv?.ref) return <span style={{ color: '#666' }}>{t('unavailable')}</span>;
  const ref = nv.ref;
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  return (
    <DraftNumber
      className={`vs-composite-setting ${keyClass}`}
      value={value}
      step={1}
      onCommit={(v) => {
        // Keep it where it lives; a new one is persistent (counts survive a
        // restart, like the counting node keeps them).
        const runtime = collectionOf('runtime_variable').get(
          runtimeVariableId(ref)
        );
        writeVariable(ref, v, !runtime);
      }}
    />
  );
}

// ── Subathon stages ─────────────────────────────────────────────────────────

interface Step {
  at: number;
  value: number;
}

const stepsOf = (v: unknown): Step[] =>
  (Array.isArray(v) ? v : [])
    .filter(
      (s): s is Step =>
        !!s &&
        typeof (s as Step).at === 'number' &&
        typeof (s as Step).value === 'number'
    )
    .sort((a, b) => a.at - b.at);

export function StagesControl({
  value,
  onValue,
  readOther,
  setting,
}: {
  value: unknown;
  onValue: (v: unknown) => void;
  readOther: (key: string) => unknown;
  setting: CompositeSetting;
}) {
  const { t, i18n } = useTranslation('composites');
  const steps = stepsOf(value);
  const startText = setting.plan ? readOther(setting.plan.start) : undefined;
  const initial = setting.plan ? Number(readOther(setting.plan.initial)) : NaN;
  const start = parseDateTime(startText);
  const when = (at: number) =>
    start === null
      ? null
      : new Date((start + at) * 1000).toLocaleString(i18n.language, {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
        });
  const commit = (next: Step[]) =>
    onValue([...next].sort((a, b) => a.at - b.at));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
      <div style={{ color: '#777' }}>
        {start === null
          ? t('stages.noPlan')
          : t('stages.plan', {
              start: when(0),
              initial: Number.isFinite(initial) ? formatDuration(initial) : '–',
              end: Number.isFinite(initial) ? when(initial) : '–',
            })}
      </div>
      {steps.map((s, i) => (
        <div
          key={`${i}:${s.at}`}
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <span style={{ color: '#888' }}>{t('stages.past')}</span>
          <DurationInput
            className="vs-composite-stage-at"
            value={s.at}
            onCommit={(at) =>
              commit(steps.map((x, j) => (j === i ? { ...x, at } : x)))
            }
          />
          <span style={{ color: '#888' }}>×</span>
          <DraftNumber
            className="vs-composite-stage-factor"
            value={s.value}
            min={0}
            step={0.05}
            onCommit={(v) =>
              commit(steps.map((x, j) => (j === i ? { ...x, value: v } : x)))
            }
          />
          {when(s.at) && (
            <span style={{ color: '#777', whiteSpace: 'nowrap' }}>
              {t('stages.endsAt', { when: when(s.at) })}
            </span>
          )}
          <button
            type="button"
            className="vs-composite-stage-remove"
            style={buttonStyle}
            title={t('stages.remove')}
            onClick={() => commit(steps.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="vs-composite-stage-add"
        style={{ ...buttonStyle, alignSelf: 'flex-start' }}
        onClick={() => {
          const last = steps[steps.length - 1];
          const base = last?.at ?? (Number.isFinite(initial) ? initial : 0);
          commit([
            ...steps,
            { at: base + 12 * 3600, value: last ? last.value / 2 : 0.5 },
          ]);
        }}
      >
        {t('stages.add')}
      </button>
    </div>
  );
}
