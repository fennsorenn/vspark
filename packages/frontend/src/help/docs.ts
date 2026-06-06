import type { LanguageCode } from '../i18n';

/**
 * Documentation content lives as markdown, one file per topic per locale:
 *   `./content/<lng>/<topic>.md`
 *
 * Files are imported eagerly as raw strings via Vite's `import.meta.glob`, so
 * adding a new `<topic>.md` (in every locale) makes a new help page appear
 * automatically.
 *
 * Headings may carry a stable, locale-independent anchor with a trailing
 * `{#id}` marker, e.g. `## Animation {#animation}`. Granular `?` buttons deep
 * link to those ids; because the id is explicit it survives translation even
 * when the heading text differs between locales.
 */
const rawDocs = import.meta.glob('./content/*/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface DocEntry {
  topic: string;
  /** raw markdown keyed by language code */
  byLang: Partial<Record<string, string>>;
}

const docs = new Map<string, DocEntry>();

for (const [path, raw] of Object.entries(rawDocs)) {
  const match = path.match(/\.\/content\/([^/]+)\/([^/]+)\.md$/);
  if (!match) continue;
  const [, lng, topic] = match;
  let entry = docs.get(topic);
  if (!entry) {
    entry = { topic, byLang: {} };
    docs.set(topic, entry);
  }
  entry.byLang[lng] = raw;
}

/** Order topics so the overview comes first, then alphabetical by title. */
const TOPIC_ORDER = [
  'overview',
  'avatar',
  'scene',
  'compose',
  'props',
  'assets',
  'behaviors',
  'track-clips',
  'logic',
  'streaming',
  'presets',
  'camera-effects',
];

function topicRank(topic: string): number {
  const i = TOPIC_ORDER.indexOf(topic);
  return i === -1 ? TOPIC_ORDER.length + 1 : i;
}

/** Strip the `{#id}` anchor markers so the derived title reads cleanly. */
function stripAnchorMarkers(text: string): string {
  return text.replace(/\s*\{#[\w-]+\}\s*$/, '').trim();
}

/** Pull the first `# H1` heading as the page title; fall back to the topic id. */
function deriveTitle(markdown: string | undefined, topic: string): string {
  if (markdown) {
    const m = markdown.match(/^\s*#\s+(.+?)\s*$/m);
    if (m) return stripAnchorMarkers(m[1]);
  }
  return topic;
}

export interface DocTopic {
  topic: string;
  title: string;
}

/** Raw markdown for a topic in the requested language, falling back to English. */
export function getDocMarkdown(topic: string, lng: LanguageCode | string): string | null {
  const entry = docs.get(topic);
  if (!entry) return null;
  return entry.byLang[lng] ?? entry.byLang['en'] ?? Object.values(entry.byLang)[0] ?? null;
}

/** All available topics with locale-aware titles, ordered for the nav list. */
export function listDocTopics(lng: LanguageCode | string): DocTopic[] {
  return [...docs.values()]
    .map((e) => ({
      topic: e.topic,
      title: deriveTitle(e.byLang[lng] ?? e.byLang['en'], e.topic),
    }))
    .sort((a, b) => {
      const ra = topicRank(a.topic);
      const rb = topicRank(b.topic);
      if (ra !== rb) return ra - rb;
      return a.title.localeCompare(b.title);
    });
}

export function docExists(topic: string): boolean {
  return docs.has(topic);
}
