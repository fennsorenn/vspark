/** DOMPurify allow-list shared by the `text` compose layer and `text_canvas`
 *  scene node's allowHtml mode. Curated to overlive's tokensToHtml output
 *  (inline formatting + inline emote images). */
export const TEXT_SANITIZE_OPTS = {
  ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'span', 'br', 'img'],
  ALLOWED_ATTR: ['src', 'alt', 'title', 'width', 'height', 'class', 'style'],
  ALLOWED_URI_REGEXP: /^(?:https?:|data:image\/)/i,
};
