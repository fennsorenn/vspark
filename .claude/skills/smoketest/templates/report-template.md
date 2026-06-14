# Smoketest report — <branch>

- **Date (UTC):** <timestamp>
- **Commit:** <short-sha>
- **Base:** origin/<base-branch>   <!-- base branch is defined in project.md -->
- **Overall:** ✅ PASS / ❌ FAIL / ⚠️ PARTIAL

## Scope

What the diff touched and how it was classified (API / Frontend / both /
docs-only). One or two sentences plus a short file list.

```
<git diff --stat origin/<base-branch>...HEAD>
```

## Test plan

The proportional set of checks decided up front.

1. …
2. …

## Results

| # | Check | Type | Result | Notes |
|---|-------|------|--------|-------|
| 1 | … | API / UI | ✅ / ❌ | … |
| 2 | … | API / UI | ✅ / ❌ | … |

### Failures & errors

- Server/boot errors, failed assertions, console errors — verbatim output.
- (Empty if everything passed.)

## Screenshots

Embed the captured states. In a PR comment use the committed blob URL with
`?raw=true` so GitHub renders them; in the committed report.md a relative path
works.

![Editor loaded](shots/02-editor-loaded.png)

## Notes

- Migrations applied cleanly on boot: yes / no / n.a.
- Anything out of scope worth flagging for a human.
