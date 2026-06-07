/**
 * Rehype plugin: honour an explicit `{#id}` marker at the end of a heading and
 * turn it into the heading element's `id`, stripping the marker from the text.
 *
 *   `## Animation {#animation}`  →  `<h2 id="animation">Animation</h2>`
 *
 * Explicit ids are locale-independent, so a granular `?` button can deep link to
 * `#animation` and land on the right section in every translation — even when
 * the visible heading text differs (e.g. "Scene" vs "Szene").
 *
 * Run before `rehype-slug` so auto-slugging only fills in headings that don't
 * already carry an explicit id.
 */
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const MARKER = /\s*\{#([\w-]+)\}\s*$/;

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function rehypeHeadingIds() {
  return (tree: HastNode) => visit(tree);
}

function visit(node: HastNode): void {
  if (node.type === 'element' && node.tagName && HEADING_TAGS.has(node.tagName)) {
    const children = node.children ?? [];
    // Walk back to the last text node; bail if a trailing inline element sits after it.
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child.type === 'text' && typeof child.value === 'string') {
        const m = child.value.match(MARKER);
        if (m) {
          child.value = child.value.replace(MARKER, '');
          node.properties ??= {};
          if (!node.properties.id) node.properties.id = m[1];
        }
        break;
      }
      if (child.type === 'element') break;
    }
  }
  if (node.children) for (const child of node.children) visit(child);
}
