/**
 * The graph row of a behavior's section in the Properties panel: its stored
 * graph's state (Modified / Template update / No graph), Open graph, and Reset
 * with confirmation — the same treatment Actions' graphs get (plan
 * actions.md Phase 4, decided: stored, always editable, Modified badge, Reset
 * with confirmation). See dev-notes/modules/component-managers.md.
 */
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../DialogProvider';
import { HelpButton } from '../../help/HelpButton';
import { useEditorStore, type Behavior } from '../../store/editorStore';
import {
  behaviorGraphStatus,
  commitBehaviorGraphReset,
  useBehaviorGraph,
  useBehaviorTemplate,
} from '../../mesh/behaviorGraphs';

function Badge({
  className,
  label,
  tip,
  color,
}: {
  className: string;
  label: string;
  tip: string;
  color: string;
}) {
  return (
    <span
      className={className}
      title={tip}
      style={{
        fontSize: 9,
        padding: '1px 5px',
        borderRadius: 8,
        border: `1px solid ${color}`,
        color,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

const buttonStyle: React.CSSProperties = {
  background: '#1e1e2a',
  border: '1px solid #333',
  borderRadius: 4,
  color: '#aaa',
  cursor: 'pointer',
  fontSize: 11,
  padding: '3px 8px',
};

export function BehaviorGraphBar({
  behavior,
  label,
}: {
  behavior: Behavior;
  /** The behavior kind's display name, for the confirmation. */
  label: string;
}) {
  const { t } = useTranslation('properties');
  const confirm = useConfirm();
  const setActiveLogic = useEditorStore((s) => s.setActiveLogic);
  const graph = useBehaviorGraph(behavior.id);
  const template = useBehaviorTemplate(behavior);
  const status = behaviorGraphStatus(behavior, graph, template);
  const canReset =
    !!template &&
    (status.modified || status.templateUpdateAvailable || status.missingGraph);

  const onReset = async () => {
    if (!template) return;
    const ok = await confirm({
      message: t('behaviorGraph.confirmReset', { name: label }),
      confirmLabel: t('behaviorGraph.reset'),
      danger: true,
    });
    if (ok) commitBehaviorGraphReset(behavior, template);
  };

  return (
    <div
      className="vs-behavior-graph"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        marginBottom: 12,
        padding: '6px 8px',
        borderRadius: 5,
        background: '#141420',
        border: '1px solid #262636',
      }}
    >
      <span style={{ fontSize: 11, color: '#888' }}>
        {t('behaviorGraph.title')}
      </span>
      <HelpButton
        topic="behaviors"
        anchor="graph"
        tip={t('help.behaviorGraph')}
      />
      {status.modified && (
        <Badge
          className="vs-behavior-badge-modified"
          label={t('behaviorGraph.modified')}
          tip={t('behaviorGraph.modifiedTip')}
          color="#d9a441"
        />
      )}
      {status.templateUpdateAvailable && !status.missingGraph && (
        <Badge
          className="vs-behavior-badge-template"
          label={t('behaviorGraph.templateUpdate')}
          tip={t('behaviorGraph.templateUpdateTip')}
          color="#5aa0d9"
        />
      )}
      {status.missingGraph && (
        <Badge
          className="vs-behavior-badge-missing"
          label={t('behaviorGraph.missing')}
          tip={t('behaviorGraph.missingTip')}
          color="#c66"
        />
      )}
      <div style={{ flex: 1 }} />
      <button
        className="vs-behavior-open-graph"
        onClick={() => graph && setActiveLogic(graph.id)}
        disabled={!graph}
        style={buttonStyle}
      >
        {t('behaviorGraph.open')}
      </button>
      <button
        className="vs-behavior-reset-graph"
        onClick={() => void onReset()}
        disabled={!canReset}
        title={t('behaviorGraph.resetTip')}
        style={{ ...buttonStyle, opacity: canReset ? 1 : 0.5 }}
      >
        {t('behaviorGraph.reset')}
      </button>
    </div>
  );
}
