import { describe, it, expect } from 'vitest';
import {
  validateFeedTemplate,
  validateFeedCss,
  validateFeedConfig,
} from '../src/feedValidation.js';

describe('validateFeedTemplate', () => {
  it('accepts a well-formed htm template', () => {
    expect(
      validateFeedTemplate('<div>${chat.map((m) => html`<p>${m.text}</p>`)}</div>')
    ).toBeNull();
  });

  it('accepts a trivial static template', () => {
    expect(validateFeedTemplate('<div>hello</div>')).toBeNull();
  });

  it('rejects a stray/unterminated backtick (the broken-template case)', () => {
    const err = validateFeedTemplate('<div>`${chat.map((m) => <p>${m.text}</p>)}</div>');
    expect(err).toMatch(/Template syntax error/);
  });

  it('rejects an unbalanced ${ interpolation', () => {
    expect(validateFeedTemplate('<div>${chat</div>')).toMatch(
      /Template syntax error/
    );
  });
});

describe('validateFeedCss', () => {
  it('accepts a border-image rule', () => {
    expect(
      validateFeedCss('.chat { border-image: url(/u/border.png) 120 stretch; }')
    ).toBeNull();
  });

  it('does not false-reject parens/braces inside strings', () => {
    expect(validateFeedCss('.x { content: "a)b(c{d}"; }')).toBeNull();
  });

  it('ignores braces inside comments', () => {
    expect(validateFeedCss('/* } ( */ .x { color: red; }')).toBeNull();
  });

  it('rejects an unclosed rule (missing })', () => {
    expect(validateFeedCss('.chat { border-width: 20px;')).toMatch(/unclosed "{"/);
  });

  it('rejects an unexpected closing brace', () => {
    expect(validateFeedCss('.x {} }')).toMatch(/unexpected "}"/);
  });

  it('rejects unbalanced parentheses', () => {
    expect(validateFeedCss('.x { background: url(/a.png; }')).toMatch(
      /unclosed "\("/
    );
    expect(validateFeedCss('.x { width: calc(1px)); }')).toMatch(
      /unexpected "\)"/
    );
  });

  it('rejects an unterminated string', () => {
    expect(validateFeedCss('.x { content: "oops; }')).toMatch(
      /unterminated string/
    );
  });

  it('rejects an unterminated comment', () => {
    expect(validateFeedCss('.x { color: red; } /* nope')).toMatch(
      /unterminated \/\* comment/
    );
  });

  it('handles escaped quotes inside strings', () => {
    expect(validateFeedCss('.x { content: "a\\"b"; }')).toBeNull();
  });
});

describe('validateFeedConfig', () => {
  it('passes for non-object / nullish config', () => {
    expect(validateFeedConfig(undefined)).toBeNull();
    expect(validateFeedConfig(null)).toBeNull();
    expect(validateFeedConfig('nope')).toBeNull();
  });

  it('passes when template/css are absent or non-string', () => {
    expect(validateFeedConfig({})).toBeNull();
    expect(validateFeedConfig({ template: 42, css: {} })).toBeNull();
  });

  it('surfaces a template error', () => {
    expect(validateFeedConfig({ template: '<div>${x' })).toMatch(
      /Template syntax error/
    );
  });

  it('surfaces a css error', () => {
    expect(validateFeedConfig({ template: '<div></div>', css: '.x {' })).toMatch(
      /unclosed "{"/
    );
  });

  it('passes a fully valid feed config', () => {
    expect(
      validateFeedConfig({ template: '<div>${chat}</div>', css: '.x { color: red; }' })
    ).toBeNull();
  });
});
