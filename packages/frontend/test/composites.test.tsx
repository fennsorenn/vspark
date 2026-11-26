/**
 * Composites in the editor, on the tab's peer: a part can't be moved out of
 * its container or deleted on its own through any write helper; deleting a
 * composite while keeping its children dissolves it in the same undo step;
 * the Settings section writes every link of a setting as one undo step; and
 * Dissolve drops the marker. See @vspark/shared/composites.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MeshProvider } from '@vspark/mesh-react';
import { compositeMarkerOf } from '@vspark/shared/composites';
import { testPeer, seedEditor, seedClip } from './helpers/mesh';
import {
  commitLayerDelete,
  commitLayerDeleteKeepChildren,
  commitLayerPatch,
  commitLayerPath,
} from '../src/mesh/layerWrites';
import { commitNodeDelete, commitNodePatch } from '../src/mesh/writes';
import { useToastStore } from '../src/store/toastStore';
import {
  CompositePartNote,
  CompositeSettings,
} from '../src/components/editor/composites/CompositeSettings';
import {
  formatDuration,
  parseDuration,
} from '../src/components/editor/composites/CompositeControls';
import { Countdown, formatCountdown } from '../src/lib/feedTemplate';
import {
  persistentVariableId,
  type DeadlineState,
} from '@vspark/shared/variables';
import '../src/i18n';

type Doc = Record<string, unknown>;
const layers = () =>
  testPeer().collection<Doc & { id: string }>('compose_layer');
const nodes = () => testPeer().collection<Doc & { id: string }>('scene_node');
const graphs = () => testPeer().collection<Doc & { id: string }>('logic');

const layer = (id: string, parentId: string | null, extra: Doc = {}) => ({
  id,
  projectId: 'p1',
  rootComposeSceneId: 'cs',
  parentId,
  name: id,
  kind: 'text',
  assetId: null,
  config: {},
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  rotation: 0,
  anchorH: 'left',
  anchorV: 'top',
  orderKey: 'a0',
  visible: true,
  ...extra,
});

function seedAlert() {
  seedEditor({
    projectId: 'p1',
    composeLayers: [
      layer('cs', null, { kind: 'compose_scene', rootComposeSceneId: 'cs' }),
      layer('root', 'cs', {
        name: 'My Alert',
        kind: 'group',
        config: {
          opacity: 0,
          composite: {
            type: 'alert',
            parts: {
              caption: 'cap',
              sound: 'snd',
              badgeImage: 'img',
              badgeVideo: 'vid',
              fade: 'clip',
              queue: 'g',
            },
          },
        },
      }),
      layer('cap', 'root', { config: { content: 'Hi', fontSize: 40 } }),
      layer('snd', 'root', { kind: 'audio', config: { volume: 1 } }),
      layer('img', 'root', { kind: 'image' }),
      layer('vid', 'root', { kind: 'video', visible: false }),
      layer('other', 'root'),
    ],
  });
  seedClip({
    id: 'clip',
    lanes: [
      {
        id: 'ln',
        keyframes: [
          { id: 'k1', t: 0 },
          { id: 'k2', t: 0.5 },
          { id: 'k3', t: 4 },
          { id: 'k4', t: 4.5 },
        ],
      },
    ],
    events: [],
  });
  testPeer()
    .collection<{ id: string }>('logic')
    .put(
      {
        id: 'g',
        ownerKind: 'compose_layer',
        ownerId: 'root',
        name: 'Alert Queue',
        enabled: true,
        descriptor: {
          id: 'g',
          label: 'q',
          readonly: false,
          nodes: {
            ev: {
              id: 'ev',
              kind: 'overlive_raid',
              position: { x: 0, y: 0 },
              defaultConfig: { account: '' },
            },
            fmt: {
              id: 'fmt',
              kind: 'text_format',
              position: { x: 0, y: 0 },
              defaultConfig: { template: 'Hi', fields: ['payload'] },
            },
            clock: {
              id: 'clock',
              kind: 'clock',
              position: { x: 0, y: 0 },
              defaultConfig: { hz: 0.2 },
            },
          },
          edges: {},
        },
      } as { id: string },
      { v: { t: 1e6, c: 0, n: 'seed' } }
    );
}

const lastToast = () => useToastStore.getState().toasts.at(-1)?.message;

describe('composite part protection in the write helpers', () => {
  beforeEach(() => {
    useToastStore.getState().clear();
    seedAlert();
  });

  it('refuses deleting a part, with a notice, and leaves it in place', async () => {
    expect(await commitLayerDelete('cap')).toBe(false);
    expect(layers().get('cap')).toBeDefined();
    expect(lastToast()).toMatch(/composite/i);
    // A child that isn't a listed part is ordinary.
    expect(await commitLayerDelete('other')).toBe(true);
    expect(layers().get('other')).toBeUndefined();
  });

  it('refuses moving a part to another container but allows reordering', () => {
    commitLayerPatch('cap', { parentId: null });
    commitLayerPath('cap', 'parentId', 'cs');
    expect(layers().get('cap')?.parentId).toBe('root');
    commitLayerPatch('cap', { orderKey: 'b0' });
    expect(layers().get('cap')?.orderKey).toBe('b0');
  });

  it('delete-keeping-children dissolves the composite in the same undo step', async () => {
    await commitLayerDeleteKeepChildren('root', 'cs');
    expect(layers().get('root')).toBeUndefined();
    expect(layers().get('cap')?.parentId).toBe('cs');
    act(() => {
      testPeer().undo();
    });
    expect(layers().get('cap')?.parentId).toBe('root');
    expect(compositeMarkerOf('compose_layer', layers().get('root'))?.type).toBe(
      'alert'
    );
  });

  it('protects scene-node parts the same way', async () => {
    seedEditor({
      projectId: 'p1',
      nodes: [
        {
          id: 'n1',
          rootSceneNodeId: 's1',
          parentId: null,
          name: 'Chat',
          kind: 'group',
          components: {},
          properties: {
            composite: { type: 'scrolling_chat', parts: { message: 'n2' } },
          },
        },
        {
          id: 'n2',
          rootSceneNodeId: 's1',
          parentId: 'n1',
          name: 'Msg',
          kind: 'text_canvas',
          components: {},
        },
      ],
    });
    expect(await commitNodeDelete('n2')).toBe(false);
    commitNodePatch('n2', { parentId: null });
    expect(nodes().get('n2')?.parentId).toBe('n1');
  });
});

describe('composite settings section', () => {
  beforeEach(() => {
    useToastStore.getState().clear();
    seedAlert();
  });

  const renderSettings = (rootId = 'root') =>
    render(
      <MeshProvider peer={testPeer()}>
        <CompositeSettings rtype="compose_layer" rootId={rootId} />
        <CompositePartNote rtype="compose_layer" id="cap" />
      </MeshProvider>
    );

  it('shows the type’s settings and writes every link of one as one undo step', () => {
    renderSettings();
    expect(screen.getByText(/Part of “My Alert”/)).toBeTruthy();
    const message = document.querySelector(
      '.vs-composite-setting-message'
    ) as HTMLInputElement;
    expect(message.value).toBe('Hi');
    fireEvent.change(message, { target: { value: '${displayName} raids!' } });
    fireEvent.blur(message);
    const tpl = (
      (graphs().get('g')?.descriptor as Doc).nodes as Record<string, Doc>
    ).fmt.defaultConfig as Doc;
    expect(tpl.template).toBe('${displayName} raids!');
    expect((layers().get('cap')?.config as Doc).content).toBe(
      '${displayName} raids!'
    );
    act(() => {
      testPeer().undo();
    });
    expect((layers().get('cap')?.config as Doc).content).toBe('Hi');
  });

  it('switching the trigger shows that trigger’s settings', () => {
    renderSettings();
    expect(
      document.querySelector('.vs-composite-setting-account')
    ).toBeTruthy();
    const trigger = document.querySelector(
      '.vs-composite-setting-trigger'
    ) as HTMLSelectElement;
    act(() => {
      fireEvent.change(trigger, { target: { value: 'named' } });
    });
    expect(document.querySelector('.vs-composite-setting-account')).toBeNull();
    expect(
      (
        document.querySelector(
          '.vs-composite-setting-triggerName'
        ) as HTMLInputElement
      ).value
    ).toBe('alert');
  });

  it('shows a setting whose part is gone as unavailable', () => {
    layers().remove('snd');
    renderSettings();
    expect(document.querySelector('.vs-composite-setting-volume')).toBeNull();
    expect(screen.getAllByText(/not available/).length).toBeGreaterThan(0);
  });

  it('dissolve drops the marker and the section', () => {
    renderSettings();
    act(() => {
      fireEvent.click(document.querySelector('.vs-composite-dissolve')!);
    });
    expect(compositeMarkerOf('compose_layer', layers().get('root'))).toBeNull();
    expect(document.querySelector('.vs-composite-settings')).toBeNull();
    // …and the parts are ordinary now.
    commitLayerPatch('cap', { parentId: 'cs' });
    expect(layers().get('cap')?.parentId).toBe('cs');
  });

  it('renders nothing for a plain layer', () => {
    renderSettings('other');
    expect(document.querySelector('.vs-composite-settings')).toBeNull();
  });
});

// ── Stream widgets ──────────────────────────────────────────────────────────


describe('durations and countdowns', () => {
  it('parses typed durations and shows seconds as H:MM:SS', () => {
    expect(parseDuration('1:30:00')).toBe(5400);
    expect(parseDuration('5:00')).toBe(300);
    expect(parseDuration('90')).toBe(5400); // a plain number is minutes
    expect(parseDuration('1h 30m')).toBe(5400);
    expect(parseDuration('45s')).toBe(45);
    expect(parseDuration('5:75')).toBeNull();
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(formatDuration(5400)).toBe('1:30:00');
    expect(formatDuration(30 * 3600)).toBe('30:00:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(3665)).toBe('1:01:05');
    expect(formatCountdown(65, 'mm:ss')).toBe('01:05');
    expect(formatCountdown(-3)).toBe('0:00');
  });

  afterEach(() => vi.useRealTimers());

  it('<Countdown> counts down on the page from the end time, or holds a pause', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const running: DeadlineState & { now: number } = {
      endsAt: 1000 + 90,
      remaining: 90,
      total: 90,
      running: true,
      finished: false,
      now: 1000,
    };
    const { container, rerender } = render(<Countdown state={running} />);
    expect(container.textContent).toBe('1:30');
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(container.textContent).toBe('1:00');
    rerender(
      <Countdown state={{ ...running, running: false, endsAt: null, remaining: 42 }} />
    );
    expect(container.textContent).toBe('0:42');
  });
});

describe('widget controls', () => {
  beforeEach(() => {
    seedEditor({
      projectId: 'p1',
      composeLayers: [
        layer('cs', null, { kind: 'compose_scene', rootComposeSceneId: 'cs' }),
        layer('cd', 'cs', {
          name: 'Countdown',
          kind: 'feed',
          config: {
            css: '.c { --w-font: a; --w-size: 48px; --w-color: #fff; }',
            composite: { type: 'countdown', parts: { panel: 'cd', timer: 'tg' } },
          },
        }),
      ],
    });
    testPeer()
      .collection<{ id: string }>('logic')
      .put(
        {
          id: 'tg',
          ownerKind: 'compose_layer',
          ownerId: 'cd',
          name: 'Countdown',
          enabled: true,
          descriptor: {
            id: 'tg',
            label: 'c',
            readonly: false,
            nodes: {
              lid: { id: 'lid', kind: 'logic_id', position: { x: 0, y: 0 } },
              dl: {
                id: 'dl',
                kind: 'deadline',
                position: { x: 0, y: 0 },
                defaultConfig: { name: 'countdown', persistent: true, duration: 300 },
              },
              dt: {
                id: 'dt',
                kind: 'date_time',
                position: { x: 0, y: 0 },
                defaultConfig: { text: '20:00' },
              },
            },
            edges: {
              'lid:id:dl:scope': {
                fromNodeId: 'lid',
                fromPort: 'id',
                toNodeId: 'dl',
                toPort: 'scope',
                kind: 'value',
              },
            },
          },
        } as { id: string },
        { v: { t: 1e6, c: 0, n: 'seed' } }
      );
  });

  const timerDoc = () =>
    testPeer()
      .collection<{ id: string; value: DeadlineState }>('variable')
      .get(persistentVariableId({ projectId: 'p1', scope: 'tg', name: 'countdown' }));

  it('Start / Pause / Resume / Reset write the timer state into its variable', () => {
    render(
      <MeshProvider peer={testPeer()}>
        <CompositeSettings rtype="compose_layer" rootId="cd" />
      </MeshProvider>
    );
    act(() => {
      fireEvent.click(document.querySelector('.vs-composite-timer-start')!);
    });
    expect(timerDoc()?.value).toMatchObject({ running: true, total: 300 });
    act(() => {
      fireEvent.click(document.querySelector('.vs-composite-timer-pause')!);
    });
    expect(timerDoc()?.value.running).toBe(false);
    expect(timerDoc()?.value.remaining).toBeGreaterThan(299);
    act(() => {
      fireEvent.click(document.querySelector('.vs-composite-timer-resume')!);
    });
    expect(timerDoc()?.value.running).toBe(true);
    act(() => {
      fireEvent.click(document.querySelector('.vs-composite-timer-reset')!);
    });
    expect(timerDoc()?.value).toMatchObject({ running: false, remaining: 0 });
    // Not undoable: runtime state, not an edit.
    expect(testPeer().undo()).toBe(false);
  });

  it('the mode toggles the until-edge and the length is a duration', () => {
    render(
      <MeshProvider peer={testPeer()}>
        <CompositeSettings rtype="compose_layer" rootId="cd" />
      </MeshProvider>
    );
    const length = document.querySelector(
      '.vs-composite-setting-duration'
    ) as HTMLInputElement;
    expect(length.value).toBe('0:05:00');
    fireEvent.change(length, { target: { value: '10:00' } });
    fireEvent.blur(length);
    const g = () => (graphs().get('tg')?.descriptor as Doc);
    expect(((g().nodes as Record<string, Doc>).dl.defaultConfig as Doc).duration).toBe(600);
    act(() => {
      fireEvent.change(document.querySelector('.vs-composite-setting-mode')!, {
        target: { value: 'until' },
      });
    });
    expect(Object.keys(g().edges as Doc)).toContain('dt:fromNow:dl:duration');
    expect(document.querySelector('.vs-composite-setting-until')).toBeTruthy();
  });
});
