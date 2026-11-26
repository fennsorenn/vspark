# Plan: <title>

> **Status:** template — not a plan. Copy this file to start a new one, and give the
> copy a status header in the format used by every other file here (see
> [`README.md`](./README.md)):
> `> **Status:** design-only | in progress | shipped | superseded by <file> | unclear`.

> Branch: `feature/<name>`
> This plan is the seed context for a cloud worker. It is a starting point, not an
> airtight spec — the worker is interactive and may ask to refine it.

## Goal

What outcome are we after, in one or two sentences. Why this change exists.

## Constraints

Mark every entry as either **[decided]** — a choice a human actually made, which needs
their say-so to reverse — or **[observed]** — something that is merely true of the code
today, which you may change if the work calls for it. An unmarked constraint reads as
[decided] to the next reader, and an [observed] fact promoted to [decided] by accident
becomes a requirement nobody ever asked for.

- **[decided]** Architectural patterns to follow or preserve.
- **[decided]** Things that must NOT change.
- **[decided]** Dependencies / approaches already ruled out.
- **[observed]** How the code happens to work today, recorded so the worker need not
  re-derive it.

## Files in scope

- `path/to/file` — what changes here and why.

## Out of scope

- Adjacent work deliberately NOT part of this change. (Keeps the worker in its lane.)

## Approach

Step-by-step outline of the intended implementation. Enough that the worker can start
without re-deriving the design, but it may diverge with the user's input.

## Acceptance / verification

- How to know it's done and correct (e.g. `pnpm lint` passes, specific behaviour holds).
- Manual checks if any.

## Output

Open a PR into `dev` when done.
