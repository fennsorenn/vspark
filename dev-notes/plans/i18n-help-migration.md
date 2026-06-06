# i18n + Help-button migration — worker conventions

Goal: make vspark usable by non-technical users by (a) translating all
user-facing strings (EN + DE) and (b) adding contextual `?` help buttons that
deep-link into the documentation.

The infrastructure already exists (see commit "feat(i18n): add help/docs
system"). Workers extend it; they do **not** modify the infra.

## i18n usage

- In a React component, add at the top:
  ```ts
  import { useTranslation } from 'react-i18next';
  // ...
  const { t } = useTranslation('<namespace>');
  ```
  Each work item is assigned exactly one `<namespace>`.
- Replace user-visible string literals with `t('some.key')`. This includes:
  button labels, headings/section titles, `title=` tooltips, `placeholder=`,
  `aria-label`, option labels, empty-state text, and `window.alert` /
  `window.confirm` / `window.prompt` messages.
- Keep emoji/icon glyphs in the JSX, translate only the words:
  `🎤 {t('media.label')}`.
- Interpolation uses i18next double-braces: `t('count', { n })` with
  `"count": "{{n}} items"`.
- Do **NOT** translate: `console.*`, internal ids/keys, enum/string values sent
  to the backend, CSS, data attributes, code/JSON shown verbatim.
- For a non-component module (a `.ts/.tsx` helper with no React hook), import the
  shared instance instead:
  ```ts
  import i18n from '../../i18n';
  i18n.t('<namespace>:some.key');
  ```
  Prefer doing translation at the component layer; only translate helper strings
  that are genuinely shown to the user (e.g. a thrown error surfaced in the UI).

## Translation files

Create both:
- `src/i18n/locales/en/<namespace>.json`
- `src/i18n/locales/de/<namespace>.json`

Same key structure in both. Nest keys semantically (e.g. `toolbar.add`,
`empty.noScenes`). German must be a real, natural translation — not a copy of the
English. Use the project vocabulary below. These files are auto-discovered (glob),
so no registration is needed.

## JSON safety (read this — common breakage)

A JSON string value must never contain a raw `"` character. For German
quotation marks use the curly pair **„ … "** (opening `„` U+201E, closing `"`
U+201C) — NOT a straight `"`, which prematurely ends the string and corrupts the
file. Example:
- WRONG: `"confirm": "Projekt „{{name}}" löschen?"`  ← the straight `"` breaks JSON
- RIGHT: `"confirm": "Projekt „{{name}}“ löschen?"`

Before you finish, validate BOTH json files by running:
`node -e "JSON.parse(require('fs').readFileSync('<path>'))"` — it must print
nothing (exit 0). Fix any parse error.

## Vocabulary (EN → DE) — use consistently

| English | Deutsch |
|---------|---------|
| Scene | Szene |
| Stage (the 3D tab) | Stage |
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

Keep product/brand names as-is: vspark, VRM, VMC, Twitch, StreamElements, MediaPipe.

## Help buttons

Add `?` buttons next to meaningful section headers and non-obvious controls:
```tsx
import { HelpButton } from '<relative>/help/HelpButton';
// ...
<HelpButton topic="avatar" anchor="animation" tip={t('help.animation')} />
```
- `topic` is one of: `overview`, `avatar`, `scene`, `behaviors`, `logic`.
- `anchor` is an existing heading id in that page (see the markdown under
  `src/help/content/en/<topic>.md`, marked `{#id}`). Available anchors:
  - avatar: `loading`, `animation`, `expressions`, `materials`, `calibration`
  - scene: `nodes`, `hierarchy`, `cameras`, `lights`, `compose`
  - behaviors: `vmc`, `tracking`, `lipsync`, `breathing`
  - logic: `automations`, `nodes`, `events`, `triggers`
  - overview: `pieces`, `first-session`, `language`
- The `tip` is the hover tooltip; put it in your namespace under a `help.*` key.
- Be generous but not noisy: one button per section/concept, not per field.

## Scope discipline

- Touch only the files in your work item plus your two namespace JSON files.
- Do not run the full typecheck (the coordinator does that after each wave).
- Preserve all existing behavior, styling, and logic. This is a text/markup-only
  change plus help-button insertions.
