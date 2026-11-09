import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';

const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A date/time text → epoch seconds, in the backend's local time zone.
 *  - a time of day `HH:MM` or `HH:MM:SS` → its next occurrence (today, or
 *    tomorrow once it has passed);
 *  - anything `Date` parses (e.g. `2026-11-09T20:00`, an ISO string with an
 *    offset) → that moment.
 * null when the text is empty or not a date.
 */
export function parseDateTime(text: unknown, nowMs = Date.now()): number | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '') return null;
  const m = CLOCK.exec(t);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    const s = m[3] === undefined ? 0 : Number(m[3]);
    if (h > 23 || min > 59 || s > 59) return null;
    const d = new Date(nowMs);
    d.setHours(h, min, s, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return d.getTime() / 1000;
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

@SignalNode({
  label: 'Date / Time',
  description:
    'Turns a date/time text into a time in seconds. A time of day like 20:00 means its next occurrence; a full date like 2026-11-09T20:00 means that moment. "fromNow" is how many seconds away it is.',
  tags: ['math'],
  color: '#4a7a5a',
})
export class DateTime extends Node {
  static readonly kind = 'date_time';

  @valueIn('text', 'String') text!: () => unknown;

  /** Epoch seconds; 0 when the text isn't a date. */
  @valueOut('seconds', 'Float') seconds = (): number =>
    parseDateTime(this.text()) ?? 0;
  /** Seconds from now until then (negative once past); 0 when invalid. */
  @valueOut('fromNow', 'Float') fromNow = (): number => {
    const at = parseDateTime(this.text());
    return at === null ? 0 : at - Date.now() / 1000;
  };
  @valueOut('valid', 'Bool') valid = (): boolean =>
    parseDateTime(this.text()) !== null;
}
