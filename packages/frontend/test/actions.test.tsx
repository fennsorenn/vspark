/**
 * Actions panel + its mesh writes (mesh/actions.ts). The test peer decides its
 * own writes, so what is pinned here is what the TAB authors: the documents it
 * writes, the undo steps they form, and what the panel shows for them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  actionGraphId,
  actionKind,
  buildActionGraph,
  templateFingerprint,
} from '@vspark/shared/actions';
import { toDescriptorDoc, toGraphDescriptor } from '@vspark/shared/signal';
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
  within,
} from './helpers/render';
import { seedEditor, testPeer } from './helpers/mesh';
import { DialogProvider } from '../src/components/DialogProvider';
import { ActionsPanel } from '../src/components/editor/actions/ActionsPanel';
import {
  commitActionCreate,
  commitActionDelete,
  commitActionReset,
  commitActionSetting,
  type ActionRecord,
} from '../src/mesh/actions';

const P = 'proj-actions';
const actions = () => testPeer().collection<ActionRecord>('action');
const logic = () => testPeer().collection<Record<string, unknown>>('logic');
const graphOf = (id: string) =>
  toGraphDescriptor(logic().get(actionGraphId(id))?.descriptor as never);

/** Put an action (and, unless `graph: false`, its generated graph) into the
 *  replica, as hydration would. */
function seedAction(
  id: string,
  over: Partial<ActionRecord> = {},
  opts: { graph?: boolean } = {}
): ActionRecord {
  const def = actionKind('hotkey')!;
  const settings = def.normalize({ ...def.defaults(), ...(over.settings ?? {}) });
  const a: ActionRecord = {
    id,
    projectId: P,
    kind: 'hotkey',
    name: id,
    enabled: true,
    templateFingerprint: templateFingerprint('hotkey', settings),
    createdAt: `2026-01-01T00:00:0${id.length}`,
    ...over,
    settings,
  };
  actions().put(a, { v: { t: 1, c: 0, n: 'seed' } });
  if (opts.graph !== false)
    logic().put(
      {
        id: actionGraphId(id),
        ownerKind: 'action',
        ownerId: id,
        name: id,
        enabled: true,
        descriptor: toDescriptorDoc(
          buildActionGraph('hotkey', settings, actionGraphId(id), id)
        ),
      },
      { v: { t: 1, c: 0, n: 'seed' } }
    );
  return a;
}

const renderPanel = () =>
  renderWithProviders(
    <DialogProvider>
      <ActionsPanel projectId={P} />
    </DialogProvider>
  );

beforeEach(() => {
  seedEditor({
    projectId: P,
    nodes: [{ id: 'n1', name: 'Avatar', kind: 'vrm', parentId: null, rootSceneNodeId: 's1' }],
  });
});

describe('Actions panel', () => {
  it('groups actions by kind and previews each row', () => {
    seedAction('a1', {
      name: 'Smile',
      settings: {
        shortcut: { key: 'F8', ctrl: true },
        responses: { '0': { type: 'set_expression', nodeId: 'n1', expression: 'happy' } },
      },
    });
    seedAction('a2', { name: 'Wave', settings: { mode: 'toggle' } });
    seedAction('other', { projectId: 'elsewhere' });
    const { container } = renderPanel();

    const group = container.querySelector('.vs-action-group-hotkey') as HTMLElement;
    expect(group).toBeTruthy();
    expect(within(group).getByText('(2)')).toBeTruthy();
    expect(container.querySelectorAll('.vs-action-row')).toHaveLength(2);

    const [smile, wave] = Array.from(
      container.querySelectorAll('.vs-action-preview')
    ) as HTMLElement[];
    expect(smile.textContent).toContain('Ctrl + F8');
    expect(smile.textContent).toContain('Set expression');
    // The entity reference resolves to its name.
    expect(smile.textContent).toContain('Avatar');
    expect(smile.textContent).toContain('happy');
    // A Hotkey row's headline is its shortcut recorder (Macros parity).
    expect(
      wave.querySelector('.vs-action-row-shortcut')?.textContent
    ).toMatch(/Set shortcut/);
    expect(wave.textContent).toContain('toggle');
    expect(wave.textContent).toContain('2.');
  });

  it('shows the empty state without actions', () => {
    renderPanel();
    expect(screen.getByText(/No actions yet/)).toBeTruthy();
  });

  it('badges: none when in step, Modified after a graph edit, Template update, No graph', () => {
    seedAction('clean');
    seedAction('edited');
    logic().set(actionGraphId('edited'), 'descriptor.nodes.extra', {
      id: 'extra',
      kind: 'log',
      position: { x: 0, y: 0 },
    });
    seedAction('moved');
    const hk = graphOf('moved').nodes.find((n) => n.id === 'hotkey')!;
    logic().set(actionGraphId('moved'), 'descriptor.nodes.hotkey', {
      ...hk,
      position: { x: 500, y: 500 },
    });
    seedAction('outdated', { templateFingerprint: 'older-template' });
    seedAction('nograph', {}, { graph: false });
    const { container } = renderPanel();

    const row = (name: string) =>
      Array.from(container.querySelectorAll('.vs-action-row')).find((r) =>
        r.textContent?.includes(name)
      ) as HTMLElement;
    const has = (name: string, cls: string) => !!row(name).querySelector(cls);

    expect(has('clean', '.vs-action-badge-modified')).toBe(false);
    expect(has('clean', '.vs-action-badge-template')).toBe(false);
    expect(has('edited', '.vs-action-badge-modified')).toBe(true);
    // Tidying the canvas is not a modification.
    expect(has('moved', '.vs-action-badge-modified')).toBe(false);
    expect(has('outdated', '.vs-action-badge-template')).toBe(true);
    expect(has('nograph', '.vs-action-badge-missing')).toBe(true);
    // Reset is only offered when there is something to reset.
    expect(
      (row('clean').querySelector('.vs-action-reset') as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (row('edited').querySelector('.vs-action-reset') as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('adds an action of a picked kind with its graph', async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(container.querySelector('.vs-action-add')!);
    await user.click(container.querySelector('.vs-action-add-kind-hotkey')!);
    await waitFor(() => expect(actions().all()).toHaveLength(1));
    const a = actions().all()[0];
    expect(a).toMatchObject({ kind: 'hotkey', projectId: P, name: 'Hotkey 1' });
    expect(logic().get(actionGraphId(a.id))).toMatchObject({
      ownerKind: 'action',
      ownerId: a.id,
    });
  });

  it('toggles enabled and edits settings from the form', async () => {
    seedAction('a1');
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(container.querySelector('.vs-action-enable')!);
    expect(actions().get('a1')?.enabled).toBe(false);

    await user.click(container.querySelector('.vs-action-settings')!);
    await user.selectOptions(
      container.querySelector('.vs-action-mode') as HTMLSelectElement,
      'cycle'
    );
    expect(actions().get('a1')?.settings.mode).toBe('cycle');
    expect(graphOf('a1').nodes.some((n) => n.kind === 'cycle')).toBe(true);
    await user.selectOptions(
      container.querySelector('.vs-action-positions') as HTMLSelectElement,
      '4'
    );
    expect(graphOf('a1').nodes.find((n) => n.id === 'cycle')?.defaultConfig).toEqual({
      count: 4,
    });
    expect(container.querySelectorAll('.vs-action-response')).toHaveLength(4);
  });

  it('asks before a shape edit rebuilds a modified graph', async () => {
    seedAction('a1');
    logic().set(actionGraphId('a1'), 'descriptor.nodes.extra', {
      id: 'extra',
      kind: 'log',
      position: { x: 0, y: 0 },
    });
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(container.querySelector('.vs-action-settings')!);
    await user.selectOptions(
      container.querySelector('.vs-action-mode') as HTMLSelectElement,
      'toggle'
    );
    // Cancelled: nothing changes.
    await user.click(await screen.findByText('Cancel'));
    expect(actions().get('a1')?.settings.mode).toBe('single');
    expect(graphOf('a1').nodes.some((n) => n.id === 'extra')).toBe(true);

    await user.selectOptions(
      container.querySelector('.vs-action-mode') as HTMLSelectElement,
      'toggle'
    );
    await user.click(container.ownerDocument.querySelector('.vs-dialog-confirm')!);
    await waitFor(() => expect(actions().get('a1')?.settings.mode).toBe('toggle'));
    expect(graphOf('a1').nodes.some((n) => n.id === 'extra')).toBe(false);
  });
});

describe('action writes', () => {
  it('create writes the action and its graph as one undo step', async () => {
    const a = (await commitActionCreate(P, 'hotkey', 'Mine'))!;
    expect(actions().get(a.id)?.templateFingerprint).toBe(
      templateFingerprint('hotkey', a.settings)
    );
    expect(logic().get(actionGraphId(a.id))).toBeDefined();
    testPeer().undo();
    expect(actions().get(a.id)).toBeUndefined();
    expect(logic().get(actionGraphId(a.id))).toBeUndefined();
    expect(await commitActionCreate(P, 'nope', 'x')).toBeUndefined();
  });

  it('a value edit writes one setting and leaves the graph alone', () => {
    const a = seedAction('a1');
    const before = JSON.stringify(logic().get(actionGraphId('a1')));
    commitActionSetting(a, 'responses.0.clipId', 'c9');
    expect(actions().get('a1')?.settings.responses).toEqual({
      '0': { type: 'play_clip', clipId: 'c9' },
    });
    expect(JSON.stringify(logic().get(actionGraphId('a1')))).toBe(before);
  });

  it('a shape edit rewrites graph + fingerprint; one undo restores an edited graph', () => {
    const a = seedAction('a1');
    logic().set(actionGraphId('a1'), 'descriptor.nodes.extra', {
      id: 'extra',
      kind: 'log',
      position: { x: 0, y: 0 },
    });
    commitActionSetting(actions().get('a1')!, 'mode', 'toggle');
    const next = actions().get('a1')!;
    expect(next.templateFingerprint).toBe(templateFingerprint('hotkey', next.settings));
    expect(graphOf('a1').nodes.some((n) => n.kind === 'cycle')).toBe(true);
    testPeer().undo();
    expect(actions().get('a1')?.settings.mode).toBe('single');
    expect(actions().get('a1')?.templateFingerprint).toBe(a.templateFingerprint);
    expect(graphOf('a1').nodes.some((n) => n.id === 'extra')).toBe(true);
  });

  it('reset rebuilds (or creates) the graph; delete takes the graph along', async () => {
    seedAction('a1', { templateFingerprint: 'old' }, { graph: false });
    commitActionReset(actions().get('a1')!);
    expect(logic().get(actionGraphId('a1'))).toBeDefined();
    expect(actions().get('a1')?.templateFingerprint).toBe(
      templateFingerprint('hotkey', actions().get('a1')!.settings)
    );
    expect(await commitActionDelete('a1')).toBe(true);
    expect(actions().get('a1')).toBeUndefined();
    expect(logic().get(actionGraphId('a1'))).toBeUndefined();
  });
});
