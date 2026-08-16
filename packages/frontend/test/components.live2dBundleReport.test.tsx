import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, userEvent } from './helpers/render';
import { Live2dBundleReportWindow } from '../src/components/editor/Live2dBundleReportWindow';
import type {
  BundleFileInput,
  Live2dBundleReport,
  Live2dFileRef,
} from '../src/api/client';

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

/** Read-only mode: the bundle is already stored, nothing to supply. */
const show = (r: Live2dBundleReport, onClose = vi.fn()) => {
  renderWithProviders(
    <Live2dBundleReportWindow
      report={r}
      rootName="hiyori-main"
      pending={null}
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

// ─── Completion mode ─────────────────────────────────────────────────────────

/**
 * Completion mode: the bundle was refused, nothing was stored, and the browser
 * still holds what the user picked — so the window collects the stragglers and
 * re-uploads a complete bundle rather than making them start over.
 */
const showSupply = (
  r: Live2dBundleReport,
  pending: BundleFileInput[] = [
    {
      relPath: 'model.model3.json',
      file: new File(['{}'], 'model.model3.json'),
    },
  ]
) => {
  const onRetry = vi.fn();
  renderWithProviders(
    <Live2dBundleReportWindow
      report={r}
      rootName="hiyori-main"
      pending={pending}
      onRetry={onRetry}
      onClose={vi.fn()}
    />
  );
  return onRetry;
};

const texture = (relPath: string): Live2dFileRef => ({
  ref: relPath,
  relPath,
  kind: 'texture',
  required: true,
});

const addFiles = async (files: File[]) => {
  const input = document.querySelector(
    '.vs-live2d-supply-input'
  ) as HTMLInputElement;
  await userEvent.upload(input, files);
};

describe('Live2dBundleReportWindow — supplying missing files', () => {
  it('offers no collection UI when the bundle was accepted', () => {
    show(
      report({ missingOptional: [ref({ required: false, kind: 'motion' })] })
    );
    expect(document.querySelector('.vs-live2d-supply-drop')).toBeNull();
    expect(document.querySelector('.vs-live2d-retry')).toBeNull();
  });

  it('offers no collection UI for a malformed manifest, which files cannot fix', () => {
    showSupply(report({ errors: ['manifest is not valid JSON'] }));
    expect(document.querySelector('.vs-live2d-supply-drop')).toBeNull();
  });

  it('matches a supplied file to its slot by basename', async () => {
    showSupply(
      report({ missingRequired: [texture('hiyori.2048/texture_00.png')] })
    );
    // The retry is blocked until the required slot is filled.
    const retry = document.querySelector(
      '.vs-live2d-retry'
    ) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);

    // The user drops the bare file — no folder structure rebuilt by hand.
    await addFiles([new File(['png'], 'texture_00.png')]);

    expect(screen.getByText(/supplied/)).toBeTruthy();
    expect(
      (document.querySelector('.vs-live2d-retry') as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('re-uploads the original files plus the supplied ones, at the manifest path', async () => {
    const pending = [
      {
        relPath: 'model.model3.json',
        file: new File(['{}'], 'model.model3.json'),
      },
      { relPath: 'model.moc3', file: new File(['moc'], 'model.moc3') },
    ];
    const onRetry = showSupply(
      report({ missingRequired: [texture('hiyori.2048/texture_00.png')] }),
      pending
    );
    await addFiles([new File(['png'], 'texture_00.png')]);
    await userEvent.click(document.querySelector('.vs-live2d-retry')!);

    expect(onRetry).toHaveBeenCalledTimes(1);
    const sent = onRetry.mock.calls[0][0] as BundleFileInput[];
    // Everything already picked survives, and the new file lands at the path
    // the manifest asked for — not at the bare name the user dropped.
    expect(sent.map((f) => f.relPath)).toEqual([
      'model.model3.json',
      'model.moc3',
      'hiyori.2048/texture_00.png',
    ]);
  });

  it('asks rather than guesses when one name could fill several slots', async () => {
    showSupply(
      report({
        missingRequired: [
          texture('a.2048/texture_00.png'),
          texture('b.2048/texture_00.png'),
        ],
      })
    );
    await addFiles([new File(['png'], 'texture_00.png')]);

    // Nothing auto-assigned; the retry stays blocked.
    expect(screen.queryByText(/supplied/)).toBeNull();
    const select = document.querySelector(
      '.vs-live2d-leftover-slot'
    ) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      '',
      'a.2048/texture_00.png',
      'b.2048/texture_00.png',
    ]);

    // Choosing resolves it.
    await userEvent.selectOptions(select, 'b.2048/texture_00.png');
    expect(screen.getByText(/supplied/)).toBeTruthy();
  });

  it('says so when a supplied file belongs to no slot at all', async () => {
    showSupply(report({ missingRequired: [texture('tex/texture_00.png')] }));
    await addFiles([new File(['x'], 'unrelated.png')]);
    expect(screen.getByText(/not part of this model/)).toBeTruthy();
    expect(
      (document.querySelector('.vs-live2d-retry') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('lets a supplied file be taken back off its slot', async () => {
    showSupply(report({ missingRequired: [texture('tex/texture_00.png')] }));
    await addFiles([new File(['png'], 'texture_00.png')]);
    expect(
      (document.querySelector('.vs-live2d-retry') as HTMLButtonElement).disabled
    ).toBe(false);

    await userEvent.click(document.querySelector('.vs-live2d-slot-clear')!);
    expect(screen.queryByText(/supplied/)).toBeNull();
    expect(
      (document.querySelector('.vs-live2d-retry') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('allows retry once REQUIRED slots are filled, even with optional gaps left', async () => {
    showSupply(
      report({
        missingRequired: [texture('tex/texture_00.png')],
        missingOptional: [
          {
            ref: 'motion/m01.motion3.json',
            relPath: 'motion/m01.motion3.json',
            kind: 'motion',
            required: false,
          },
        ],
      })
    );
    await addFiles([new File(['png'], 'texture_00.png')]);
    expect(
      (document.querySelector('.vs-live2d-retry') as HTMLButtonElement).disabled
    ).toBe(false);
  });
});
