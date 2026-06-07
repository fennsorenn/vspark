import { useEffect } from 'react';

/**
 * Calls `handler` whenever the Escape key is pressed while the component is
 * mounted. Used to make modal/overlay surfaces dismissable with Esc, matching
 * the common expectation that Escape closes the top-most dialog.
 *
 * Pass `enabled: false` to temporarily detach the listener (e.g. while a nested
 * picker owns Escape).
 */
export function useEscapeKey(handler: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handler();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handler, enabled]);
}
