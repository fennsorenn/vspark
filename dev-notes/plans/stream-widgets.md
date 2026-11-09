# Plan: Stream widgets (2D composites, batch 2)

> **Status:** shipped on `feature/stream-widgets` (not yet merged to `dev`) — see [`../modules/composites.md`](../modules/composites.md)

> Branch: `feature/stream-widgets` (vspark, off `dev` after the composites merge 405d4ff);
> `feature/goals` in `~/projects/overlive`.

## Goal

Add the next set of built-in composites ("Widgets" in German) for the 2D compose
view, so the common stream overlay elements are one object with settings:
Twitch / manual goals, the remaining alert triggers, a countdown, a subathon
timer, recent / top event lists and an ad break overlay. 3D variants are a
second pass.

## Constraints

- **[decided]** (user, 2026-11-09) Scope of this batch: goals (manual and
  fetched from Twitch), the remaining alert triggers, countdown, subathon timer,
  recent + top event tracking (per stream or persistent), ad break overlay.
  2D only; 3D ones are a second pass.
- **[decided]** Redemptions get no widget of their own — alerts (Donation
  trigger) and Actions already cover them.
- **[decided]** Subathon: amounts per event are configurable; a **hard limit**
  (the timer never goes past the cap) and a **soft limit as diminishing adds in
  stages** (past each stage, every add is multiplied by that stage's factor).
- **[decided]** Recent / top tracking is a **new tally node** whose state lives
  in a project variable (so the variable store's persistent flag and resets
  apply), not a graph of existing nodes.
- **[decided]** Twitch goals come from overlive: Claude makes the overlive
  change, merges it to overlive `main`, bumps versions and pushes the release
  tag itself.
- **[decided]** (composites, earlier) Composites are live-linked, built-in only,
  marked by `config.composite` on the root; parts can't leave their container
  or be deleted alone; Dissolve turns the root into a plain group.
- **[decided]** (user, 2026-11-09) **No per-second updates from the backend.**
  The graph publishes only when the end time changes (start, pause, an add);
  the page counts down locally through a `<Countdown>` helper in feed templates
  (next to `<Emote>`).
- **[decided]** Prefer **general-purpose nodes**: `math`, `clamp`,
  `step_lookup`, `alarm`, `date_time`, plus **one small timer-state node**
  (`deadline`) that only owns the state — caps and stages are computed upstream
  with the general nodes, not inside it. (`alarm` was not built — see
  Deviations.)
- **[decided]** (user, 2026-11-09) **Tabs may write project variables.** The
  editor's timer buttons and a goal count set by hand put the variable document
  directly; the nodes holding the variable react. Recorded in
  [`../modules/variables.md`](../modules/variables.md).
- **[decided]** Subathon stage thresholds are measured against the timer's
  **total length** (initial time + everything added). The settings UI gets
  planning help: for each stage, the end time it corresponds to given the
  planned start.
- **[decided]** Goals: **manual** goals are counted from chosen events or set by
  hand; "by hand" means the goal reads a named project variable that other
  graphs (and Actions) can change. **Auto** goals are the channel's Twitch goals.
- **[observed]** The `feed` compose layer (htm template + scoped CSS, fed by
  `set_data`) can render bars, timers and lists, so no new layer kind is needed.
  Its templates only re-render when published data changes — which is why the
  ticking display is a page-side `<Countdown>` helper (see the decision above)
  rather than per-second publishes.
- **[observed]** Overlive's EventSub client checks the token's scopes before
  subscribing and skips subscriptions it can't make, so accounts without the
  new `channel:read:goals` scope keep working (and get no goal events until
  they reconnect).
- **[observed]** `overlive_follow` and `overlive_gift_bomb` have no `data`
  output yet; the alert's Message template reads the whole record from `data`.

## Interpretations (Claude's reading, not decided)

- The subathon hard cap is a cap on total length, like the stages.
- **Per stream** = reset when the account's `stream.online` event fires.

## Files in scope

overlive (`~/projects/overlive`):
- `packages/core/src/events/types.ts` — `GoalEvent` (`type: 'goal'`, data:
  goal id, kind, description, current, target, phase `begin|progress|end`,
  achieved).
- `packages/core/src/rest/UnifiedRestClient.ts` (+ `Goal` type) — `getGoals()`.
- `packages/twitch/src/EventSubClient.ts`, `normalizers.ts` — subscribe to
  `channel.goal.begin|progress|end` (scope `channel:read:goals`), normalize.
- `packages/twitch/src/TwitchRestClient.ts` — `getGoals()` (`GET /helix/goals`).
- `packages/twitch-oauth/src/index.ts` — add the scope to `DEFAULT_SCOPES`.
- tests + version bumps (minor), release tag.

vspark:
- `packages/backend/src/signal/nodes/overlive/goal.ts` (new) — `overlive_goal`:
  fires on goal events and on a `refresh` input (and once when the account
  connects), outputs kind / description / current / target / achieved / data.
- `packages/backend/src/overlive/manager.ts` — `goal` in the event→kind table;
  fetch current goals on connect and on refresh.
- `overlive/follow.ts`, `overlive/gift_bomb.ts` — `data` output.
- `packages/backend/src/signal/nodes/tally.ts` (new) — `tally`: `add` (user,
  amount, label) / `reset` events; keeps per-user totals + the last N entries
  in a project variable (`persistent` flag); outputs `recent`, `top`, `last`.
- `packages/backend/src/signal/nodes/deadline.ts` (new) — `deadline`: timer
  state only. Events `start(seconds)` / `pause` / `resume` / `reset` /
  `add(seconds)`; state (`endsAt`, `total`, paused remaining) in a project
  variable (`persistent` flag); outputs `endsAt`, `remaining`, `total`,
  `running`, `changed` event. No caps or stages inside.
- general nodes (new): `math` (add / subtract / min / max / divide),
  `clamp`, `step_lookup` (sorted thresholds → value), `alarm` (fires once at a
  time, re-armed by an event), `date_time` (date/time string → epoch seconds).
- `packages/frontend/src/lib/feedTemplate.tsx` — `<Countdown>` helper (ticks
  locally from `endsAt`, or shows a fixed remaining time while paused).
- `packages/shared/src/composites.ts` — alert triggers `follow`, `gift`,
  `bits`; new type defs `goal`, `countdown`, `subathon`, `recent_events`,
  `top_supporters`, `ad_break`.
- `packages/backend/src/presets/builtin_presets/composites.ts` — their payloads.
- `packages/frontend/src/components/editor/composites/compositeModel.ts` — palette
  tiles; any new setting controls (e.g. a stage list for the subathon).
- i18n `composites` (en/de), help `composites.md` (en/de), tests, e2e, docs.

## Out of scope

- 3D variants of these widgets (second pass).
- A redemption widget.
- StreamElements goals (no public goals endpoint found in overlive).
- Retiring the old alert/chat presets (waits for the user's confirmation that
  composites replace them).

## Approach

1. **overlive** — goal events + `getGoals()` + scope; tests; merge, bump
   core / twitch / twitch-oauth (minor), tag, confirm the npm publish.
2. **vspark nodes** — `overlive_goal`, `data` outputs, `tally`, `deadline`,
   the general nodes, each with backend tests (`buildGraph`); `<Countdown>`.
3. **Alert triggers** — follow, gift bomb, bits.
4. **Widgets** — goal (source: Twitch goal / counted events / by hand), countdown
   (duration or target time; at zero optionally fires a named trigger), subathon
   (amounts per event type, start time, hard cap, soft-cap stages, start / pause
   via named triggers or Actions), recent events, top supporters (per stream or
   persistent), ad break (shown between ad start and end, with remaining time).
   Each is a feed layer (+ group root) with a small logic graph.
5. i18n + help + vs- handles + bless, frontend tests, one e2e spec, docs.

## Deviations (as shipped)

- **No `alarm` node.** `deadline` fires `finished` itself when its time runs
  out (one timeout, re-armed whenever the end time moves), so nothing needed a
  separate alarm. Claude's call during implementation, not a user decision.
- `math` also has `multiply` (the plan listed add / subtract / min / max /
  divide); the subathon uses it for the stage factor.
- `overlive_goal` fetches current goals on graph start as well as on account
  connect and `refresh`.
- Two shared inference fixes were needed (see
  [`../modules/signal-graph.md`](../modules/signal-graph.md)): propagation
  reaches a fixpoint on looped graphs (the subathon's `total` feeds its own
  add), and `pack_event` types an unwired field from its config literal.
- **[observed]** The subathon's sub rate does not weight sub tiers.

## Acceptance / verification

- `pnpm lint`, `pnpm test` green; shared/backend coverage not lowered.
- Each widget places from the Create palette, its settings write into its parts,
  and its logic graph is valid and running (backend composites test).
- Timer state survives a backend restart (persistent variable); nothing is
  published per second.
- e2e `cov-composites` extended, run on isolated ports.
