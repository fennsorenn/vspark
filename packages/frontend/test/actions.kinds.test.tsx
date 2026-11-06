/**
 * Actions panel — the chat / redemption kinds' settings forms and previews.
 * What is pinned is what the TAB writes (the test peer decides its own writes,
 * so no server normalization).
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
  fireEvent,
  renderWithProviders,
  userEvent,
  waitFor,
} from './helpers/render';
import { seedEditor, testPeer } from './helpers/mesh';
import { DialogProvider } from '../src/components/DialogProvider';
import { ActionsPanel } from '../src/components/editor/actions/ActionsPanel';
import type { ActionRecord } from '../src/mesh/actions';
import { useEditorStore } from '../src/store/editorStore';

const P = 'proj-kinds';
const actions = () => testPeer().collection<ActionRecord>('action');
const logic = () => testPeer().collection<Record<string, unknown>>('logic');
const graphOf = (id: string) =>
  toGraphDescriptor(logic().get(actionGraphId(id))?.descriptor as never);
const settingsOf = (id: string) =>
  actions().get(id)!.settings as Record<string, any>;

function seed(
  id: string,
  kind: string,
  over: Record<string, unknown> = {}
): ActionRecord {
  const def = actionKind(kind)!;
  const settings = def.normalize({ ...def.defaults(), ...over });
  const a: ActionRecord = {
    id,
    projectId: P,
    kind,
    name: id,
    enabled: true,
    settings,
    templateFingerprint: templateFingerprint(kind, settings),
    createdAt: `2026-01-01T00:00:00-${id}`,
  };
  actions().put(a, { v: { t: 1, c: 0, n: 'seed' } });
  logic().put(
    {
      id: actionGraphId(id),
      ownerKind: 'action',
      ownerId: id,
      name: id,
      enabled: true,
      descriptor: toDescriptorDoc(
        buildActionGraph(kind, settings, actionGraphId(id), id)
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

/** Type into a draft field and commit it (Enter blurs). */
async function commitText(
  user: ReturnType<typeof userEvent.setup>,
  el: Element,
  text: string
) {
  await user.clear(el as HTMLInputElement);
  // `{` / `[` open key descriptors in user-event; doubled they are literal.
  if (text)
    await user.type(el as HTMLInputElement, text.replace(/[{[]/g, '$&$&'));
  await user.type(el as HTMLInputElement, '{Enter}');
}

beforeEach(() => {
  seedEditor({
    projectId: P,
    nodes: [
      {
        id: 'n1',
        name: 'Avatar',
        kind: 'vrm',
        parentId: null,
        rootSceneNodeId: 's1',
      },
    ],
  });
  useEditorStore.setState({
    overliveAccounts: [
      { id: 'acc-1', label: 'Main', platform: 'twitch', isDefault: true },
      { id: 'acc-2', label: 'Bot', platform: 'twitch' },
    ] as never,
  });
});

const preview = (container: HTMLElement, kind: string) =>
  container.querySelector(`.vs-action-group-${kind} .vs-action-preview`)!
    .textContent!;

describe('Chat command', () => {
  it('previews the commands, rank, cooldown, counter and reply', () => {
    seed('cmd', 'chat_command', {
      command: 'hug',
      aliases: 'cuddle',
      minRank: 'mod',
      cooldown: { seconds: 30, group: 'fun' },
      counter: { enabled: true, name: 'hugs' },
      reply: '${user} hugs ${args}',
    });
    const { container } = renderPanel();
    const text = preview(container, 'chat_command');
    for (const s of [
      '!hug',
      '!cuddle',
      'mods+',
      '⏱ 30 s (fun)',
      '# hugs',
      '“${user} hugs ${args}”',
    ])
      expect(text).toContain(s);
  });

  it('text, rank, cooldown, counter, reply and account are value writes', async () => {
    seed('a1', 'chat_command');
    const before = JSON.stringify(logic().get(actionGraphId('a1')));
    const user = userEvent.setup();
    const { container } = renderPanel();
    const q = (cls: string) => container.querySelector(cls)!;
    await user.click(q('.vs-action-settings'));

    await commitText(user, q('.vs-action-command'), '!hug');
    expect(settingsOf('a1').command).toBe('!hug');
    // The derived regex goes along with the edit (same undo step).
    expect(settingsOf('a1').derived.commandPattern).toBe('^(?:hug)$');
    await commitText(user, q('.vs-action-aliases'), 'cuddle');
    expect(settingsOf('a1').derived.commandPattern).toBe('^(?:hug|cuddle)$');
    testPeer().undo();
    expect(settingsOf('a1').aliases).toBe('');
    expect(settingsOf('a1').derived.commandPattern).toBe('^(?:hug)$');

    await user.selectOptions(
      q('.vs-action-min-rank') as HTMLSelectElement,
      'sub'
    );
    expect(settingsOf('a1').minRank).toBe('sub');
    await commitText(user, q('.vs-action-cooldown-seconds'), '45');
    await commitText(user, q('.vs-action-cooldown-group'), 'fun');
    expect(settingsOf('a1').cooldown).toEqual({ seconds: 45, group: 'fun' });
    await commitText(user, q('.vs-action-args-pattern'), '\\w+');
    expect(settingsOf('a1').argsPattern).toBe('\\w+');

    expect(container.querySelector('.vs-action-counter-name')).toBeNull();
    await user.click(q('.vs-action-counter-enabled'));
    expect(settingsOf('a1').counter.enabled).toBe(true);
    await commitText(user, q('.vs-action-counter-name'), 'hugs');
    expect(settingsOf('a1').counter.name).toBe('hugs');
    expect(settingsOf('a1').derived.counterScope).toBe('');
    await commitText(user, q('.vs-action-counter-step'), '2');
    expect(settingsOf('a1').counter.step).toBe(2);
    await user.click(q('.vs-action-counter-persistent'));
    expect(settingsOf('a1').counter.persistent).toBe(false);

    await commitText(user, q('.vs-action-reply'), 'hi ${user}');
    expect(settingsOf('a1').reply).toBe('hi ${user}');
    await user.selectOptions(
      q('.vs-action-account') as HTMLSelectElement,
      'acc-2'
    );
    expect(settingsOf('a1').account).toBe('acc-2');

    // None of it touched the graph.
    expect(JSON.stringify(logic().get(actionGraphId('a1')))).toBe(before);
  });

  it('a draft field commits once, on Enter; Escape reverts; a bad number reverts', async () => {
    seed('a1', 'chat_command');
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(container.querySelector('.vs-action-settings')!);
    const input = container.querySelector(
      '.vs-action-command'
    ) as HTMLInputElement;
    await user.type(input, 'abc');
    expect(settingsOf('a1').command).toBe('');
    await user.type(input, '{Escape}');
    expect(input.value).toBe('');
    await user.type(input, 'x{Enter}');
    expect(settingsOf('a1').command).toBe('x');
    await commitText(
      user,
      container.querySelector('.vs-action-cooldown-seconds')!,
      ''
    );
    expect(settingsOf('a1').cooldown.seconds).toBe(10);
  });
});

describe('Chat pattern', () => {
  it('previews and edits the pattern', async () => {
    seed('a1', 'chat_pattern', { pattern: 'a+b' });
    const user = userEvent.setup();
    const { container } = renderPanel();
    expect(preview(container, 'chat_pattern')).toContain('/a+b/');
    await user.click(container.querySelector('.vs-action-settings')!);
    await commitText(
      user,
      container.querySelector('.vs-action-pattern')!,
      'x+'
    );
    expect(settingsOf('a1').pattern).toBe('x+');
    expect(settingsOf('a1').derived.fullPattern).toBe('^(?:x+)$');
  });
});
