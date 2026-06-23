/**
 * Phase 7 frontend component UI tests.
 *
 * Covers:
 *   - DialogProvider + useConfirm hook (confirm/cancel paths)
 *   - HelpButton (opens help store with correct topic/anchor)
 *   - HelpWindow (renders title, close button, calls closeHelp)
 *
 * Mocks:
 *   - DocViewer is mocked with a trivial stub to avoid the
 *     `import.meta.glob` / ReactMarkdown / remark/rehype pipeline which
 *     doesn't resolve correctly under jsdom/vitest (no Vite plugin running).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { useState } from 'react';
import { renderWithProviders, screen, within, waitFor, userEvent } from './helpers/render';
import { DialogProvider, useConfirm } from '../src/components/DialogProvider';
import { HelpButton } from '../src/help/HelpButton';
import { HelpWindow } from '../src/help/HelpWindow';
import { useHelpStore } from '../src/help/helpStore';

// ---------------------------------------------------------------------------
// Mock DocViewer so HelpWindow doesn't pull in import.meta.glob / ReactMarkdown
// ---------------------------------------------------------------------------
vi.mock('../src/help/DocViewer', () => ({
  DocViewer: ({ topic }: { topic: string | null }) => (
    <div data-testid="doc-viewer">{topic}</div>
  ),
}));

// Ensure RTL DOM is fully cleaned up between every test
afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Small consumer that triggers confirm() and shows the resolved value. */
function ConfirmConsumer({ message }: { message: string }) {
  const confirm = useConfirm();
  const [result, setResult] = useState<boolean | null>(null);

  return (
    <>
      <button
        onClick={async () => {
          const v = await confirm({ message });
          setResult(v);
        }}
      >
        open dialog
      </button>
      {result !== null && <span data-testid="result">{String(result)}</span>}
    </>
  );
}

// ---------------------------------------------------------------------------
// DialogProvider + useConfirm
// ---------------------------------------------------------------------------

describe('DialogProvider + useConfirm', () => {
  it('renders dialog with the supplied message when confirm() is called', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <DialogProvider>
        <ConfirmConsumer message="Are you sure?" />
      </DialogProvider>
    );

    await user.click(within(container).getByRole('button', { name: 'open dialog' }));

    // Message text appears
    expect(screen.getByText('Are you sure?')).toBeTruthy();
    // Confirm and cancel controls rendered
    expect(screen.getByRole('button', { name: /ok/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy();
  });

  it('resolves true when the confirm button is clicked', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <DialogProvider>
        <ConfirmConsumer message="Delete it?" />
      </DialogProvider>
    );

    await user.click(within(container).getByRole('button', { name: 'open dialog' }));
    await user.click(screen.getByRole('button', { name: /ok/i }));

    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('true');
    });
  });

  it('resolves false when the cancel button is clicked', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <DialogProvider>
        <ConfirmConsumer message="Delete it?" />
      </DialogProvider>
    );

    await user.click(within(container).getByRole('button', { name: 'open dialog' }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => {
      expect(screen.getByTestId('result').textContent).toBe('false');
    });
  });

  it('dismisses the dialog after confirming', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <DialogProvider>
        <ConfirmConsumer message="Gone?" />
      </DialogProvider>
    );

    await user.click(within(container).getByRole('button', { name: 'open dialog' }));
    expect(screen.getByText('Gone?')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /ok/i }));

    await waitFor(() => {
      expect(screen.queryByText('Gone?')).toBeFalsy();
    });
  });

  it('dismisses the dialog after cancelling', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <DialogProvider>
        <ConfirmConsumer message="Nope?" />
      </DialogProvider>
    );

    await user.click(within(container).getByRole('button', { name: 'open dialog' }));
    expect(screen.getByText('Nope?')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => {
      expect(screen.queryByText('Nope?')).toBeFalsy();
    });
  });
});

// ---------------------------------------------------------------------------
// HelpButton
// ---------------------------------------------------------------------------

describe('HelpButton', () => {
  beforeEach(() => {
    // Reset help store before each test
    useHelpStore.setState({ open: false, topic: null, anchor: null });
  });

  it('renders a "?" button', () => {
    const { container } = renderWithProviders(<HelpButton topic="avatar" />);
    const btn = within(container).getByRole('button');
    expect(btn.textContent).toBe('?');
  });

  it('opens the help store with the correct topic when clicked', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<HelpButton topic="avatar" />);

    await user.click(within(container).getByRole('button'));

    const state = useHelpStore.getState();
    expect(state.open).toBe(true);
    expect(state.topic).toBe('avatar');
    expect(state.anchor).toBeNull();
  });

  it('opens with the correct topic and anchor when both are provided', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<HelpButton topic="scene" anchor="animation" />);

    await user.click(within(container).getByRole('button'));

    const state = useHelpStore.getState();
    expect(state.open).toBe(true);
    expect(state.topic).toBe('scene');
    expect(state.anchor).toBe('animation');
  });

  it('uses aria-label from tip prop when provided', () => {
    const { container } = renderWithProviders(<HelpButton topic="avatar" tip="Avatar help" />);
    const btn = within(container).getByRole('button', { name: 'Avatar help' });
    expect(btn).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// HelpWindow (DocViewer is mocked)
// ---------------------------------------------------------------------------

describe('HelpWindow', () => {
  beforeEach(() => {
    useHelpStore.setState({ open: false, topic: null, anchor: null });
  });

  it('renders nothing when the help store is closed', () => {
    const { container } = renderWithProviders(<HelpWindow />);
    expect(container.querySelector('[data-testid="doc-viewer"]')).toBeFalsy();
  });

  it('renders when help store is opened with a topic', () => {
    useHelpStore.setState({ open: true, topic: 'avatar', anchor: null });
    const { container } = renderWithProviders(<HelpWindow />);
    expect(container.querySelector('[data-testid="doc-viewer"]')).toBeTruthy();
  });

  it('passes the topic to DocViewer', () => {
    useHelpStore.setState({ open: true, topic: 'scene', anchor: null });
    const { container } = renderWithProviders(<HelpWindow />);
    const viewer = container.querySelector('[data-testid="doc-viewer"]');
    expect(viewer?.textContent).toBe('scene');
  });

  it('closes via the close (×) button', async () => {
    const user = userEvent.setup();
    useHelpStore.setState({ open: true, topic: 'avatar', anchor: null });
    const { container } = renderWithProviders(<HelpWindow />);

    // The close button is the last button in the header (× comes after ↗)
    const allBtns = within(container).getAllByRole('button');
    const closeBtn = allBtns[allBtns.length - 1];
    await user.click(closeBtn);

    await waitFor(() => {
      expect(useHelpStore.getState().open).toBe(false);
    });
  });
});
