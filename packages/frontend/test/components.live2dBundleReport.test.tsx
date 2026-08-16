import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, userEvent } from './helpers/render';
import { Live2dBundleReportWindow } from '../src/components/editor/Live2dBundleReportWindow';
import type { Live2dBundleReport, Live2dFileRef } from '../src/api/client';

const ref = (over: Partial<Live2dFileRef> = {}): Live2dFileRef => ({
  ref: 'model.moc3',
  relPath: 'model.moc3',
  kind: 'moc',
  required: true,
  ...over,
});

const report = (
  over: Partial<Live2dBundleReport> = {}
): Live2dBundleReport => ({
  manifest: 'model.model3.json',
  refs: [],
  missingRequired: [],
  missingOptional: [],
  errors: [],
  ...over,
});

const show = (r: Live2dBundleReport, onClose = vi.fn()) => {
  renderWithProviders(
    <Live2dBundleReportWindow
      report={r}
      rootName="hiyori-main"
      onClose={onClose}
    />
  );
  return onClose;
};

describe('Live2dBundleReportWindow', () => {
  it('lists missing required files by their expected path', () => {
    show(
      report({
        missingRequired: [
          ref({
            ref: 'hiyori.2048/texture_00.png',
            relPath: 'hiyori.2048/texture_00.png',
            kind: 'texture',
          }),
        ],
      })
    );
    expect(screen.getByText('hiyori.2048/texture_00.png')).toBeTruthy();
    expect(screen.getByText(/Missing — required \(1\)/)).toBeTruthy();
    // The blocked headline, not the "uploaded with gaps" one.
    expect(screen.getByText('Live2D model incomplete')).toBeTruthy();
    expect(screen.getByText(/was not uploaded/)).toBeTruthy();
  });

  it('separates optional misses and says the model still renders', () => {
    show(
      report({
        missingOptional: [
          ref({
            ref: 'motion/m01.motion3.json',
            relPath: 'motion/m01.motion3.json',
            kind: 'motion',
            required: false,
            label: 'Idle[0]',
          }),
        ],
      })
    );
    expect(screen.getByText('Live2D model uploaded with gaps')).toBeTruthy();
    expect(screen.getByText(/will render/)).toBeTruthy();
    expect(screen.getByText(/Missing — optional \(1\)/)).toBeTruthy();
    // Kind and label are surfaced so a bare filename is identifiable.
    expect(screen.getByText(/motion · Idle\[0\]/)).toBeTruthy();
    expect(screen.queryByText(/Missing — required/)).toBeNull();
  });

  it('shows manifest errors and says supplying files will not help', () => {
    show(report({ errors: ['manifest is not valid JSON'] }));
    expect(screen.getByText('manifest is not valid JSON')).toBeTruthy();
    expect(screen.getByText(/Re-export the model from Cubism/)).toBeTruthy();
  });

  it('names the manifest the report is about', () => {
    show(
      report({ manifest: 'runtime/hiyori.model3.json', errors: ['broken'] })
    );
    expect(screen.getByText('runtime/hiyori.model3.json')).toBeTruthy();
  });

  it('closes from the dismiss button', async () => {
    const onClose = show(report({ errors: ['broken'] }));
    await userEvent.click(screen.getByText('Got it'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the header close button', async () => {
    const onClose = show(report({ errors: ['broken'] }));
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('carries the vs- handles the e2e control manifest tracks', () => {
    show(
      report({
        errors: ['broken'],
        missingRequired: [ref()],
        missingOptional: [
          ref({ relPath: 'p.json', kind: 'physics', required: false }),
        ],
      })
    );
    for (const cls of [
      'vs-live2d-report',
      'vs-live2d-report-close',
      'vs-live2d-report-dismiss',
      'vs-live2d-report-errors',
      'vs-live2d-report-required',
      'vs-live2d-report-optional',
    ])
      expect(document.querySelector(`.${cls}`)).toBeTruthy();
  });
});
