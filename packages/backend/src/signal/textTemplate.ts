/**
 * `${field}` text templating shared by the nodes that render user-written
 * messages (`overlive_send_chat`, `text_format`).
 *
 * A placeholder is `${name}` where `name` is one or more word characters
 * (`[A-Za-z0-9_]`). Each one is replaced with `String(lookup(name))`; a lookup
 * that yields `null` or `undefined` renders as the empty string. Anything that
 * is not a well-formed placeholder is left as written.
 */
const PLACEHOLDER = /\$\{(\w+)\}/g;

export function renderTemplate(
  template: string,
  lookup: (name: string) => unknown
): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    const v = lookup(name);
    return v === null || v === undefined ? '' : String(v);
  });
}
