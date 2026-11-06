/**
 * Validators for feed compose-layer authoring (`config.template` + `config.css`).
 *
 * Feed layers render a user-authored htm/JSX-ish template styled by CSS. Both
 * are easy to get subtly wrong (a stray backtick, an unbalanced brace), and a
 * broken one used to be stored silently and only surface as a blank render. The
 * REST route runs these before persisting so the failure is rejected at the
 * write — which also means the MCP `create_compose_layer` / `update_compose_layer`
 * tools (they hit the route over HTTP) get a 400 the agent can read and fix,
 * instead of shipping markup that renders to nothing.
 *
 * Scope is deliberately narrow — only true *structural* faults, never style:
 *   - template: the same `new Function` compile the renderer does
 *     (frontend `lib/feedTemplate.compileTemplate`), so a SyntaxError is caught
 *     here exactly as it would be at render. Construction does NOT run the body.
 *   - css: brace/paren/string balance only. Browsers silently drop unknown or
 *     invalid *declarations*, so validating those would false-reject vendor
 *     prefixes and newer properties; we only catch gross corruption that breaks
 *     the whole stylesheet.
 */

/** Validate a feed template body the way the renderer compiles it. Returns an
 *  error message, or null when the template is syntactically sound. */
export function validateFeedTemplate(src: string): string | null {
  try {
    // Mirror compileTemplate's compile step exactly. The Function constructor
    // only parses the body — it never executes it — so this is side-effect free.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function(
      'html',
      'Emote',
      'channels',
      'with (channels) { return html`' + src + '`; }'
    );
    return null;
  } catch (e) {
    return `Template syntax error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Light structural validation of feed CSS: balanced braces/parens and closed
 *  strings/comments. Returns an error message, or null when structurally sound.
 *  Intentionally does NOT validate declarations (the browser ignores bad ones). */
export function validateFeedCss(css: string): string | null {
  let brace = 0;
  let paren = 0;
  let quote: '' | '"' | "'" = '';
  let inComment = false;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (inComment) {
      if (ch === '*' && css[i + 1] === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') i++; // skip escaped char
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      inComment = true;
      i++;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{') {
      brace++;
    } else if (ch === '}') {
      if (--brace < 0) return 'CSS has an unexpected "}" (unbalanced braces).';
    } else if (ch === '(') {
      paren++;
    } else if (ch === ')') {
      if (--paren < 0) return 'CSS has an unexpected ")" (unbalanced parentheses).';
    }
  }
  if (quote) return 'CSS has an unterminated string literal.';
  if (inComment) return 'CSS has an unterminated /* comment */.';
  if (brace > 0)
    return 'CSS has an unclosed "{" (a rule is missing its closing brace).';
  if (paren > 0) return 'CSS has an unclosed "(" (unbalanced parentheses).';
  return null;
}

/** Validate the template/css of a compose-layer `config` object, when present.
 *  Non-feed layers (no template/css) and non-string values pass through. Returns
 *  the first error message found, or null when nothing is wrong. */
export function validateFeedConfig(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const c = config as Record<string, unknown>;
  if (typeof c.template === 'string') {
    const err = validateFeedTemplate(c.template);
    if (err) return err;
  }
  if (typeof c.css === 'string') {
    const err = validateFeedCss(c.css);
    if (err) return err;
  }
  return null;
}
