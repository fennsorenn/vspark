import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';
import { renderTemplate } from '../textTemplate.js';

interface TextFormatConfig {
  /** User-defined field NAMES (+ order). Each becomes a labeled value-in port
   *  whose current value is substituted for `${name}` (see `inferTextFormat`). */
  fields?: string[];
}

/**
 * Pure text templating: `text` is `template` with each `${name}` replaced —
 * the same syntax as `overlive_send_chat`, through the same renderer. A name
 * resolves to the like-named labeled input port when one is declared and
 * yields a value, otherwise to the field of that name in the optional
 * `values` record (e.g. a regex node's `groups`). Unresolved names render as
 * the empty string.
 */
@SignalNode({
  label: 'Format Text',
  description:
    'Builds text from a template with ${name} placeholders, filled from the node’s labeled inputs and from the fields of an optional values record.',
  tags: ['utility'],
  color: '#3a5a6a',
})
export class TextFormat extends Node {
  static readonly kind = 'text_format';

  @valueIn('template', 'String') template!: () => unknown;
  @valueIn('values', 'Any') values!: () => unknown;

  @valueOut('text', 'String') text = (): string => {
    const tpl = this.template();
    if (typeof tpl !== 'string' || tpl.length === 0) return '';
    const cfg = (this.config ?? {}) as TextFormatConfig;
    const fields = new Set((cfg.fields ?? []).filter((f) => f.length > 0));
    const raw = this.values();
    const values =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    return renderTemplate(tpl, (name) => {
      const v = fields.has(name) ? this.input(name) : undefined;
      if (v !== undefined && v !== null) return v;
      return Object.prototype.hasOwnProperty.call(values, name)
        ? values[name]
        : undefined;
    });
  };
}
