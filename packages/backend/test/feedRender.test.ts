import { describe, it, expect } from 'vitest';
import { renderTemplateToHtml } from '../src/mcp/feedRender.js';

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

  it('throws on a broken template (caught by the tool as an error)', () => {
    expect(() => renderTemplateToHtml('<div>${chat', {})).toThrow();
  });
});
