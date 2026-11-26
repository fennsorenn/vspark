import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';
import { parseDateTime } from '@vspark/shared/variables';

// Parsing is shared with the editor (a countdown's Start button).
export { parseDateTime };

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
