/**
 * Scroll to and briefly pulse-highlight a UI control by its `vs-` handle.
 * Driven by the assistant's ui_highlight_control tool → ui_action →
 * editorStore.dispatchUiAction. Pure DOM (runs outside React) so it can target
 * any handle without each control opting in.
 */
const HIGHLIGHT_CLASS = 'vs-ai-highlight';
const HIGHLIGHT_MS = 2600;

/** Normalise "vs-foo" / "foo" / ".vs-foo" to the class token "vs-foo". */
function normaliseHandle(handle: string): string {
  const h = handle.trim().replace(/^\./, '');
  return h.startsWith('vs-') ? h : `vs-${h}`;
}

export function highlightControl(handle: string): boolean {
  if (typeof document === 'undefined' || !handle) return false;
  const token = normaliseHandle(handle);
  const el = document.querySelector<HTMLElement>(`.${CSS.escape(token)}`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  el.classList.remove(HIGHLIGHT_CLASS);
  // Force a reflow so re-adding the class restarts the animation if it's
  // already mid-pulse from a previous call.
  void el.offsetWidth;
  el.classList.add(HIGHLIGHT_CLASS);
  window.setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
  return true;
}
