/**
 * Gaze settings on the tracking receivers (EyeRangeSettings): the per-receiver
 * default shows when nothing is stored, and edits write `config.eyeRange`
 * without dropping the receiver's other settings.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderWithProviders, fireEvent } from './helpers/render';
import type { Behavior } from '../src/store/editorStore';
import { EyeRangeSettings } from '../src/components/editor/EyeRangeSettings';
import { docsOf, seedEditor } from './helpers/mesh';

const behavior = (config: Record<string, unknown>): Behavior =>
  ({
    id: 'beh-1',
    nodeId: 'avatar-1',
    kind: 'ifacialmocap_receiver',
    enabled: true,
    config,
  }) as Behavior;

const stored = () =>
  docsOf<{ config: Record<string, unknown> }>('behavior')[0].config;

function seed(config: Record<string, unknown>) {
  const b = behavior(config);
  seedEditor({ behaviors: [b] });
  return b;
}

describe('EyeRangeSettings', () => {
  beforeEach(() => {
    seed({ port: 49983 });
  });

  it('shows the receiver default when nothing is stored', () => {
    const on = renderWithProviders(
      <EyeRangeSettings comp={behavior({})} defaultEnabled />
    );
    const box = on.container.querySelector(
      '.vs-eye-range-enabled'
    ) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(on.container.querySelector('.vs-eye-range-max')).toBeTruthy();
    on.unmount();

    const off = renderWithProviders(
      <EyeRangeSettings comp={behavior({})} defaultEnabled={false} />
    );
    expect(
      (off.container.querySelector('.vs-eye-range-enabled') as HTMLInputElement)
        .checked
    ).toBe(false);
    // The range only matters while fitting is on.
    expect(off.container.querySelector('.vs-eye-range-max')).toBeNull();
  });

  it('toggling writes eyeRange and keeps the other settings', () => {
    const b = seed({ port: 49983 });
    const { container } = renderWithProviders(
      <EyeRangeSettings comp={b} defaultEnabled />
    );
    fireEvent.click(container.querySelector('.vs-eye-range-enabled')!);
    expect(stored()).toEqual({
      port: 49983,
      eyeRange: { enabled: false, inputMaxDeg: 30 },
    });
  });
});
