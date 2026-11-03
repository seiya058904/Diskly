# Diskly

A minimal Windows tool: a small window starts a scan of every fixed disk, and an offline HTML report in the browser shows what changed. Fewer features is the goal.

## Rules that do not bend

- **Read only.** Diskly never deletes or changes a user's files. Diskghost's core can delete, so `crates/diskly-core/tests/read_only_guard.rs` keeps that out of Diskly's code, and all file removal inside `Store::remove_own_file`.
- **No network.** No accounts, telemetry, built-in AI, or background service. The AI feature is copying text.
- **Unknown is never zero.** A folder that could not be read, a missing disk or a cancelled scan must never read as space freed. Scans with different engines, or across a format, are not compared at folder level.
- **Nothing from a scan is markup.** The report assigns text with `textContent`, data stays in inert JSON, and the CSP allows only the page's own code by hash. Never use `innerHTML` or inline handlers.
- **Keep the engine close to upstream.** Change `crates/diskghost-core` only with evidence and the smallest diff, and record it in `NOTICE`. The `upstream` remote is Diskghost.

## Where things are

| Path | What |
|---|---|
| `crates/diskly-core` | Volumes, scanning, history store, comparison table, report assembly |
| `report/lib.js` | All comparison arithmetic, headline and AI text. The only place for it |
| `report/report.js` | The report page |
| `app/ui` | The window; `tokens.css` is shared with the report |
| `app/src-tauri` | Commands, scan runner, elevated helper |
| `docs/benchmarks` | Measurements behind the decisions. Read before changing thread counts or comparison rules |

## Checks

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
node --test report/lib.test.js
./scripts/e2e/build-demo.ps1 -Out <folder>
node scripts/e2e/report.e2e.mjs <folder> <shots folder>
```

`scripts/e2e/app.e2e.mjs` runs the real app on real disks. Phases `basic` and `browser` need no prompt, and `uac-*` need someone to answer Windows prompts. `DISKLY_DATA_DIR` must end in `Diskly\Data`, or the helper refuses it. Always use it for tests, so the real history stays clean.

Check UI by looking at it: `scripts/e2e/shots.mjs` for the report, `capture-window.ps1` for the window. Playwright's MCP tool blocks `file:` URLs, and the report must be tested from one, so the scripts drive the browser over the DevTools protocol.

## What real use taught

- **Open reports with the `http` handler, not the `.html` association.** The association can be unset. Windows then shows a dialog and still reports success.
- **A UAC prompt takes any amount of time, and times out as a refusal after about 2 minutes.** Nothing may expire while it is open. If the window is not in front, the prompt only flashes in the taskbar.
- **The prompt covers everything, so people cannot read instructions during it.** To test each answer, read the outcome from the run records (`finished_at - started_at - seconds` is the wait) rather than relying on someone following steps.
- **More walk threads make it slower.** 4 per volume is the measured best.

## Publishing

Commit in single-purpose steps; never force-push. Pushing a `v*` tag builds a draft release, and it needs the owner's explicit approval each time, with the version and test results reported first. Never commit real scan output or screenshots of real reports: the README's report pictures come from `scripts/demo/demo-data.js`, and `scripts/e2e/readme-shots.mjs` remakes them.
