# i18n + Help System

**Status: Implemented.**

Two linked frontend systems: an internationalisation (i18n) layer that makes all user-facing strings translatable, and a contextual help system that surfaces in-app documentation through `?` buttons, a floating window, and a full-page docs route.

## i18n infrastructure — `packages/frontend/src/i18n/`

### Bootstrap — `i18n/index.ts`

Initialises `react-i18next` with `i18next-browser-languagedetector`. Locale resources live under `i18n/locales/<lng>/<namespace>.json` and are loaded at bundle time via Vite `import.meta.glob` (eager). No explicit namespace registration is needed — dropping a new JSON file into the right directory is sufficient.

Key settings:

| Setting | Value |
|---------|-------|
| Supported languages (`SUPPORTED_LANGUAGES`) | `en`, `de` |
| Fallback language | `en` |
| Language persistence | `localStorage` key `vspark.lang` |
| Namespace discovery | `import.meta.glob('./locales/*/*.json', { eager: true })` |

Dependencies added: `i18next`, `react-i18next`, `i18next-browser-languagedetector`, `react-markdown`, `remark-gfm`, `rehype-slug`.

### Namespaces

One namespace per component area. Namespace names match the component area they cover:

`common`, `help`, `topbar`, `update`, `editor`, `home`, `sceneGraph`, `assets`, `properties`, `compose`, `signalGraph`, `clips`, `accounts`, `presets`, `media`, `misc`.

### Language switcher — `components/LanguageSwitcher.tsx`

An EN/DE toggle button rendered in both `TopBar` and the `Home` page header.

### Component usage convention

```ts
import { useTranslation } from 'react-i18next';
const { t } = useTranslation('<namespace>');
// …
<button>{t('some.key')}</button>
```

In non-React modules (helpers, utils) use the shared instance directly:

```ts
import i18n from '../../i18n';
i18n.t('<namespace>:some.key');
```

Prefer doing translation at the component layer; only translate helper strings that are genuinely shown to the user.

### What is (and isn't) translated

Translated: button labels, headings/section titles, `title=` tooltips, `placeholder=`, `aria-label`, option labels, empty-state text, `window.alert`/`window.confirm`/`window.prompt` messages.

Not translated: `console.*`, internal ids/keys, values sent to the backend, CSS, data attributes, verbatim code/JSON. Emoji glyphs stay in JSX; only the words around them are translated.

Interpolation uses double-brace syntax: `t('count', { n })` paired with `"count": "{{n}} items"` in the JSON.

### Adding a new translation namespace

1. Create `src/i18n/locales/en/<namespace>.json` and `src/i18n/locales/de/<namespace>.json` with matching key structure. Nest keys semantically (e.g. `toolbar.add`, `empty.noScenes`).
2. No registration step — the glob picks it up automatically.
3. In the component add `const { t } = useTranslation('<namespace>')`.
4. Validate both JSON files after editing: `node -e "JSON.parse(require('fs').readFileSync('<path>'))"`.

**JSON safety:** German quotation marks must use the curly pair **„ … "** (U+201E / U+201C), not straight `"` which breaks JSON parsing.

### Vocabulary

Standard EN → DE mappings to use consistently across all namespaces. Product
names (`vspark`, `VRM`, `VMC`, `Twitch`, `StreamElements`, `MediaPipe`) are kept
as-is in all locales. (The migration plan `dev-notes/plans/i18n-help-migration.md`
carried the original copy; this table is the durable source of truth.)

| English | Deutsch |
|---------|---------|
| Scene | Szene |
| Stage (the 3D tab) | Bühne |
| Compose (the 2D tab) | Komposition |
| Node | Knoten |
| Avatar | Avatar |
| Camera | Kamera |
| Light | Licht |
| Group | Gruppe |
| Behavior | Verhalten |
| Logic | Logik |
| Automation | Automatisierung |
| Compose | Compose |
| Layer | Ebene |
| Asset | Asset |
| Animation | Animation |
| Expression | Mimik |
| Material | Material |
| Track clip | Track-Clip |
| Keyframe | Keyframe |
| Preset | Vorlage |
| Account | Konto |
| Project | Projekt |
| Properties | Eigenschaften |
| Add / Remove / Delete | Hinzufügen / Entfernen / Löschen |

When you introduce a new recurring domain term, add it here so future
translations stay consistent.

---

## Help / documentation system — `packages/frontend/src/help/`

### Overview

The help system has three surfaces that share the same content:

| Surface | Entry point | Use case |
|---------|-------------|----------|
| Tooltip | `HelpButton` hover | One-line gloss on a control |
| Floating window | `HelpWindow` | In-context reference without leaving the editor |
| Full-page docs | `DocsPage` at `/docs` / `/docs/:topic` | Popped-out or linked directly |

### HelpButton — `help/HelpButton.tsx`

Inline `?` affordance. Props:

| Prop | Type | Purpose |
|------|------|---------|
| `topic` | `string` | Doc topic to open (`overview`, `avatar`, `scene`, `behaviors`, `logic`) |
| `anchor` | `string` | Heading id to scroll to within that topic |
| `tip` | `string` | Text shown in the hover tooltip |

On hover, renders a portaled tooltip. On click, calls `helpStore.openHelp(topic, anchor)` to open the floating window at the right section. `HelpButton` is placed next to section headers and non-obvious controls across: TopBar, SceneGraph, AssetManager, PropertiesPanel, Compose, Logic/signal palette, clips, accounts, presets, and media panels.

### HelpWindow — `help/HelpWindow.tsx`

Floating, draggable window mounted once in `pages/Editor.tsx`. Driven by `helpStore`. Has a pop-out button that navigates to `/docs/:topic#anchor` in a new tab/window, and a close button.

### helpStore — `help/helpStore.ts`

Zustand store with a minimal surface:

```ts
{ open: boolean, topic: string, anchor: string }
openHelp(topic, anchor)
goTo(topic, anchor)       // changes topic/anchor while window is already open
closeHelp()
```

### DocViewer — `help/DocViewer.tsx`

Shared markdown renderer used by both `HelpWindow` and `DocsPage`. Renders with `react-markdown` + `remark-gfm` + `rehype-slug` + the custom `rehypeHeadingIds` plugin. Features:

- Topic navigation sidebar listing all available topics (ordered by `TOPIC_ORDER` from `docs.ts`).
- Scoped dark-mode CSS styling.
- Scrolls to the requested anchor on topic/anchor change.
- Intercepts `topic:<name>` links (navigate to another topic) and `#<anchor>` links (scroll within current topic) without a full page navigation.

### rehypeHeadingIds — `help/rehypeHeadingIds.ts`

Custom rehype plugin. Converts a `{#id}` marker at the end of a heading into that heading's HTML `id` attribute. This keeps anchor links stable across locales even when the heading text is translated — the anchor is always the explicit `{#id}` value, never the auto-derived slug from the heading text.

### Content — `help/content/<lng>/<topic>.md`

Markdown files for each topic in each supported language. Current topics: `overview`, `avatar`, `scene`, `behaviors`, `logic`. Each contains `{#anchor}` markers on section headings that serve as deep-link targets.

Available anchors per topic:

| Topic | Anchors |
|-------|---------|
| `overview` | `pieces`, `first-session`, `language` |
| `avatar` | `loading`, `animation`, `expressions`, `materials`, `calibration` |
| `scene` | `nodes`, `hierarchy`, `cameras`, `lights`, `compose` |
| `behaviors` | `vmc`, `tracking`, `lipsync`, `breathing` |
| `logic` | `automations`, `nodes`, `events`, `triggers` |

### docs.ts — `help/docs.ts`

Loads markdown at build time via `import.meta.glob('./content/*/*.md', { query: '?raw' })`. Exports:

- `getDocMarkdown(topic, lng)` — returns the markdown string for a topic/locale pair, falling back to `en` if the requested locale has no file.
- `listDocTopics(lng)` — returns available topics for a locale in `TOPIC_ORDER` sequence.
- `deriveTitle(markdown)` — extracts the first H1 as the display title.

### DocsPage — `pages/DocsPage.tsx`

Full-page route at `/docs` and `/docs/:topic`. Reads the anchor from `window.location.hash`. This is the pop-out target for the floating `HelpWindow`'s pop-out button.

---

## How to add a new help doc page

1. Create `src/help/content/en/<topic>.md` (and `de/<topic>.md` for German).
2. Add `{#anchor-id}` markers to section headings in both files.
3. Add the topic to `TOPIC_ORDER` in `docs.ts` so it appears in the nav.
4. `listDocTopics` and `getDocMarkdown` pick it up automatically — no other registration needed.
5. Point `HelpButton` instances at the new `topic` + `anchor` values.

## Cross-locale anchor convention

Anchors are declared with `{#id}` inline markers, not derived from heading text. This means:

- The German heading can be freely translated.
- All `HelpButton topic=… anchor=…` references work in every locale without change.
- When adding a new section, choose the anchor id in English (or a language-neutral slug) and use it consistently in all locale files.

Do not rely on `rehype-slug`'s automatic heading id (the heading text lowercased/slugified) for anything that a `HelpButton` links to — those ids change if the heading is retranslated. Only the explicit `{#id}` markers are stable.

---

## Keeping i18n + help in sync with the app

These two systems only stay useful if they're updated *alongside* the features
they describe. Treat the following as part of "done" for any frontend change:

- **New or changed UI text** → never hardcode. Add a key to the relevant
  namespace in **both** `en` and `de` locale files, validate the JSON, and use
  `t(...)`. See [the usage convention](#component-usage-convention).
- **New feature, concept, or panel** → add or extend the relevant
  `help/content/{en,de}/<topic>.md` page (with `{#anchor}` sections) and drop a
  `HelpButton` next to the new control pointing at it. A feature shipped without
  a hint or doc section is incomplete for non-technical users — the whole point
  of this system.
- **Renamed/removed concept** → update the doc prose, the affected
  `HelpButton topic/anchor` references, and the [vocabulary table](#vocabulary)
  if it's a recurring term. Removing a `{#anchor}` silently breaks every
  `HelpButton` that targeted it, so grep for the anchor before deleting it.
- **New recurring domain term** → add it to the vocabulary table above.

When a task touches the UI, spawn the `doc-updater` agent (per the root
`CLAUDE.md`) with enough context to refresh both this module doc and the help
content. The agent maintains docs; it does not write the German translations or
place `HelpButton`s — do those as part of the implementing change.
