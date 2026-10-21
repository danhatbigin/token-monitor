---
summary: "Read-only BytePlus Coding Plan quota through the existing local Ark CLI."
ids: [byteplus]
read_when:
  - Changing BytePlus quota collection or CLI discovery
---

# BytePlus Coding Plan

`byteplus` is a limits-only provider, separate from Volcengine. It invokes only
`arkcli usage plan --product coding-plan --format json` using the current local
BytePlus CLI session. It never logs in, changes profiles, writes credentials, or
edits client configuration. Enable it in AI Tool Limits; Edge Dock uses the same
normalized provider and window selection as other providers.

Only the `coding-plan` item is accepted. `subscribed: false` produces
`notConfigured`; missing, failed or malformed quota produces `unavailable`.
`percent` is USED percentage; the shared normalizer derives remaining as
`100 - percent`. Session (`5h` or `session`), weekly and monthly windows map to
the shared session, weekly and billing kinds. No token totals are required.
Invalid or absent reset timestamps remain unknown rather than being guessed.

The bounded, shell-free runner in `volcengine/arkcli.js` is shared, with BytePlus
npm native-binary discovery. Updates are suppressed, stderr is discarded, output
is capped, and timeout/cancellation terminate the query. Errors never contain
raw command output. Authentication remains owned by the local CLI; an expired
session is unavailable until the user signs in separately. Optional account
identifiers are hashed before publication; raw viewer data is not retained.

Run `node --test tests/shared/byteplusLimits.test.js tests/shared/volcengineArkcli.test.js`.
Live authentication and the installed desktop's visual appearance require manual
checks; automated integration tests cover collection and Edge Dock projection.

## Validation on 2026-10-21 (Windows, Node 24)

The existing signed-in BytePlus CLI returned all three windows successfully.
Only authentication status and quota reads were executed; no login or profile
changes were attempted. Lint passed. The full suite reported 7,566 passes,
22 skips and eight failures. All eight failures also reproduced against the
unmodified upstream commit `c3b38e77`:

- `a Sub2API card keeps Month and All time in the summary and its original usage tooltip`
- `a third-party tooltip keeps account details above spend without duplicate spoken periods`
- `a third-party tooltip keeps the original account format when all-time is the summary`
- `symlinked packaged Widget artifacts never launch or create marker state`
- `clientDataDirPresence detects Antigravity via the CLI conversations dir`
- `compressed Codex discovery respects configured roots and bounded non-symlink traversal`
- `clientDataDirPresence requires an actual VS Code Copilot chat source`
- `the built-in extension dir overlap is canonicalized, not string-matched`

Desktop visual inspection and packaging were not performed.
