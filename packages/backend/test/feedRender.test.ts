import { describe, it, expect } from 'vitest';
import { renderTemplateToHtml } from '../src/mcp/feedRender.js';
import { FEED_CHAT_TEMPLATE } from '../src/presets/builtin_presets/helpers.js';

/** The browser rasterize path needs Chromium and is covered by the MCP tool
 *  test; here we lock the pure htm→HTML-string compile (escaping, nesting,
 *  bare-field access) that feeds it. */
describe('renderTemplateToHtml', () => {
  it('renders a static template', () => {
    expect(renderTemplateToHtml('<div class="x">hi</div>', {})).toBe(
      '<div class="x">hi</div>'
    );
  });

  it('exposes channel fields by bare name and maps over them', () => {
    const out = renderTemplateToHtml(
      '<div class="chat">${chat.map((m) => html`<p class="msg">${m.text}</p>`)}</div>',
      { chat: [{ text: 'a' }, { text: 'b' }] }
    );
    expect(out).toBe(
      '<div class="chat"><p class="msg">a</p><p class="msg">b</p></div>'
    );
  });

  it('escapes interpolated text (no markup injection)', () => {
    const out = renderTemplateToHtml('<div>${chat}</div>', {
      chat: 'a & <b>x</b> "q"',
    });
    expect(out).toBe('<div>a &amp; &lt;b&gt;x&lt;/b&gt; &quot;q&quot;</div>');
  });

  it('maps className to class and self-closes void tags', () => {
    const out = renderTemplateToHtml(
      '<span className="e">${"k"}</span><br/>',
      {}
    );
    expect(out).toBe('<span class="e">k</span><br>');
  });

  it('drops null/false children', () => {
    const out = renderTemplateToHtml(
      '<div>${cond ? html`<i>y</i>` : null}${null}</div>',
      { cond: false }
    );
    expect(out).toBe('<div></div>');
  });

  it('renders a style OBJECT to inline css (camelCase → kebab-case)', () => {
    const out = renderTemplateToHtml(
      '<span style=${{ color: c, fontWeight: 700 }}>x</span>',
      { c: '#f0a' }
    );
    expect(out).toBe('<span style="color:#f0a;font-weight:700">x</span>');
  });

  it('strips React-only key/ref and skips event-handler props', () => {
    const out = renderTemplateToHtml(
      '<div key=${"k1"} onClick=${fn} title="t">y</div>',
      { fn: () => {} }
    );
    expect(out).toBe('<div title="t">y</div>');
  });

  it('invokes a component (the Emote helper injects raw html)', () => {
    const out = renderTemplateToHtml('<p><${Emote} html=${raw} /></p>', {
      raw: 'a <img src="e.png"> b',
    });
    expect(out).toBe('<p>a <img src="e.png"> b</p>');
  });

  it('renders the actual default chat feed template faithfully', () => {
    const out = renderTemplateToHtml(FEED_CHAT_TEMPLATE, {
      chat: [
        { id: '1', displayName: 'alice', color: '#f5a', html: 'hi <b>there</b>' },
        { id: '2', displayName: 'bob', color: '#5af', html: 'gg' },
      ],
    });
    // colored name via style object, no leaked key=, Emote html injected raw
    expect(out).toContain('<span class="name" style="color:#f5a">alice</span>');
    expect(out).toContain('hi <b>there</b>');
    expect(out).not.toContain('key=');
    expect(out).not.toContain('[object Object]');
  });

  it('throws on a broken template (caught by the tool as an error)', () => {
    expect(() => renderTemplateToHtml('<div>${chat', {})).toThrow();
  });
});
