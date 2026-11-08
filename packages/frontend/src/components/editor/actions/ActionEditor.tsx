/**
 * Action editor — the main view of the Actions tab. Shows the settings of the
 * action selected in the Actions list (left dock): name, enabled, the kind's
 * form, and the graph controls (Open graph, Reset) plus delete. All writes go
 * through the mesh (mesh/actions.ts).
 */
import { useTranslation } from 'react-i18next';
import { actionKind } from '@vspark/shared/actions';
import { useEditorStore } from '../../../store/editorStore';
import {
  commitActionDelete,
  commitActionPatch,
  commitActionReset,
  commitActionSetting,
  editRebuildsGraph,
  statusOf,
  useActionGraphs,
  useProjectActions,
  type ActionRecord,
} from '../../../mesh/actions';
import { HelpButton } from '../../../help/HelpButton';
import { useConfirm } from '../../DialogProvider';
import { HotkeyForm } from './HotkeyForm';
import { CHAT_FORMS } from './ChatForms';
import { NameField, RenderBoundary, StatusBadges } from './parts';
import { buttonStyle } from './styles';

const viewStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflowY: 'auto',
  background: '#0e0e14',
  // The main view doesn't inherit the docks' font (SceneGraph sets it).
  fontFamily: 'system-ui, sans-serif',
};

function Empty({ text }: { text: string }) {
  return (
    <div
      className="vs-action-editor-empty"
      style={{
        ...viewStyle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#555',
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}

function Editor({
  action,
  graph,
}: {
  action: ActionRecord;
  graph: ReturnType<typeof useActionGraphs>[string] | undefined;
}) {
  const { t } = useTranslation('actions');
  const confirm = useConfirm();
  const setActiveLogic = useEditorStore((s) => s.setActiveLogic);
  const setActiveAction = useEditorStore((s) => s.setActiveAction);
  const def = actionKind(action.kind);
  const status = statusOf(action, graph);

  /** A setting edit; a shape edit on a modified graph asks first, because the
   *  rebuild discards the graph edits (decided in the Actions plan). */
  const setSetting = async (path: string, value: unknown) => {
    if (editRebuildsGraph(action, path, value) && status.modified) {
      const ok = await confirm({
        message: t('confirm.rebuild', { name: action.name }),
        confirmLabel: t('confirm.rebuildConfirm'),
        danger: true,
      });
      if (!ok) return;
    }
    commitActionSetting(action, path, value);
  };
  const onSetting = (p: string, v: unknown) => void setSetting(p, v);

  const onReset = async () => {
    const ok = await confirm({
      message: t('confirm.reset', { name: action.name }),
      confirmLabel: t('row.reset'),
      danger: true,
    });
    if (ok) commitActionReset(action);
  };

  const onDelete = async () => {
    if (await commitActionDelete(action.id)) setActiveAction(null);
  };

  const Form = CHAT_FORMS[action.kind];

  return (
    <div style={viewStyle}>
      <div
        className="vs-action-editor"
        style={{
          maxWidth: 560,
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>{def?.icon}</span>
          <span
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: '#888',
            }}
          >
            {def ? t(`kinds.${action.kind}.label`) : action.kind}
          </span>
          <HelpButton
            topic="actions"
            anchor={action.kind}
            tip={t(`kinds.${action.kind}.description`)}
            size={11}
          />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 14,
              color: '#ddd',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {action.name}
          </span>
          <StatusBadges status={status} />
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: '#aaa',
          }}
        >
          <input
            type="checkbox"
            className="vs-action-editor-enable"
            checked={action.enabled}
            onChange={(e) =>
              commitActionPatch(action.id, { enabled: e.target.checked })
            }
          />
          {t('editor.enabled')}
        </label>

        <div
          className="vs-action-form"
          style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          <NameField action={action} />
          {action.kind === 'hotkey' && (
            <HotkeyForm action={action} onSetting={onSetting} />
          )}
          {Form && <Form action={action} onSetting={onSetting} />}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 10,
            borderTop: '1px solid #262636',
          }}
        >
          <button
            className="vs-action-open-graph"
            onClick={() => graph && setActiveLogic(graph.id)}
            disabled={!graph}
            style={buttonStyle}
          >
            {t('row.openGraph')}
          </button>
          <button
            className="vs-action-reset"
            onClick={() => void onReset()}
            disabled={
              !status.modified &&
              !status.templateUpdateAvailable &&
              !status.missingGraph
            }
            title={t('row.resetTip')}
            style={buttonStyle}
          >
            {t('row.reset')}
          </button>
          <div style={{ flex: 1 }} />
          <button
            className="vs-action-delete"
            onClick={() => void onDelete()}
            style={{ ...buttonStyle, color: '#c66' }}
          >
            {t('row.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ActionEditor({
  projectId: propProjectId,
}: {
  projectId?: string;
}) {
  const { t } = useTranslation('actions');
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = propProjectId ?? storeProjectId ?? undefined;
  const activeId = useEditorStore((s) => s.activeActionId);
  const actions = useProjectActions(projectId);
  const graphs = useActionGraphs();
  const action = actions.find((a) => a.id === activeId);
  if (!action) return <Empty text={t('editor.empty')} />;
  return (
    <RenderBoundary key={action.id} fallback={<Empty text={t('rowError')} />}>
      <Editor action={action} graph={graphs[action.id]} />
    </RenderBoundary>
  );
}
