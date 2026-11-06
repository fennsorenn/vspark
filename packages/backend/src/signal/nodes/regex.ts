import { SignalNode } from '@vspark/shared/signal';
import { Node } from '@vspark/shared/node';
import { valueIn, valueOut } from '@vspark/shared/node_decorators';
import { regexFlags, regexGroups } from '@vspark/shared/infer_nodes';

interface MatchResult {
  matched: boolean;
  /** Capture index → matched text ('' when the group didn't take part). */
  byIndex: string[];
  /** Port name → index, for the dynamic group outputs. */
  portIndex: Map<string, number>;
  /** Named groups → matched text. */
  named: Record<string, string>;
}

const NO_MATCH: MatchResult = {
  matched: false,
  byIndex: [],
  portIndex: new Map(),
  named: {},
};

/**
 * Matches `text` against a regular expression. Pure: every output is computed
 * from the inputs when pulled (the last computation is memoised on the inputs,
 * so pulling several outputs runs the match once).
 *
 * Outputs: `matched` (Bool); one String per capture group — named groups under
 * their name, unnamed ones as `group<n>` — which appear on the card only while
 * the pattern is an inline literal (see `inferRegex`); and `groups`, a record
 * of the named groups, for consumers that don't know the pattern in advance
 * (e.g. a `text_format`'s `values`). Groups that did not match read as ''.
 *
 * Only the first match is reported; the `g` / `y` flags are ignored. An empty
 * pattern never matches. A pattern that does not compile reads as no match and
 * is logged once per node and pattern.
 */
@SignalNode({
  label: 'Regex Match',
  description:
    'Matches text against a regular expression. Outputs whether it matched, one text output per capture group, and a record of the named groups.',
  tags: ['utility'],
  color: '#3a5a6a',
})
export class Regex extends Node {
  static readonly kind = 'regex';

  @valueIn('text', 'String') text!: () => unknown;
  @valueIn('pattern', 'String') pattern!: () => unknown;
  @valueIn('flags', 'String') flags!: () => unknown;

  @valueOut('matched', 'Bool') matched = (): boolean => this._match().matched;
  @valueOut('groups', 'Any') groups = (): Record<string, string> => ({
    ...this._match().named,
  });

  private _memoKey: string | null = null;
  private _memo: MatchResult = NO_MATCH;
  private readonly _warned = new Set<string>();

  protected override onBind(): void {
    this.setDynamicOutputs((port) => {
      const r = this._match();
      const index = r.portIndex.get(port);
      return index === undefined ? undefined : (r.byIndex[index] ?? '');
    });
  }

  private _match(): MatchResult {
    const text = asString(this.text());
    const pattern = asString(this.pattern());
    const flags = regexFlags(this.flags());
    const key = `${pattern}\u0000${flags}\u0000${text}`;
    if (key === this._memoKey) return this._memo;
    this._memoKey = key;
    this._memo = this._compute(text, pattern, flags);
    return this._memo;
  }

  private _compute(text: string, pattern: string, flags: string): MatchResult {
    if (pattern.length === 0) return NO_MATCH;
    const groups = regexGroups(pattern, flags);
    if (groups === null) {
      const warnKey = `${pattern}\u0000${flags}`;
      if (!this._warned.has(warnKey)) {
        this._warned.add(warnKey);
        console.warn(
          `[regex ${this.selfId}] invalid pattern /${pattern}/${flags} — treated as no match`
        );
      }
      return NO_MATCH;
    }
    const portIndex = new Map(groups.map((g) => [g.port, g.index]));
    const m = new RegExp(pattern, flags).exec(text);
    const named: Record<string, string> = {};
    for (const g of groups) if (g.name) named[g.name] = '';
    if (!m) return { matched: false, byIndex: [], portIndex, named };
    const byIndex = Array.from(m, (v) => v ?? '');
    for (const [name, v] of Object.entries(m.groups ?? {}))
      named[name] = v ?? '';
    return { matched: true, byIndex, portIndex, named };
  }
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}
