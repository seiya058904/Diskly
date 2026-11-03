# Diskly

A minimal Windows tool: a small window starts a scan of every fixed disk, and an offline HTML report in the browser shows what changed. Fewer features is the goal.

## Rules that do not bend

- **Read only.** Diskly never deletes or changes a user's files. Diskghost's core can delete, so `crates/diskly-core/tests/read_only_guard.rs` keeps that out of Diskly's code, and all file removal inside `Store::remove_own_file`.
- **No network.** No accounts, telemetry, built-in AI, or background service. The AI feature is copying text.
- **Unknown is never zero.** A folder that could not be read, a missing disk or a cancelled scan must never read as space freed. Scans with different engines, or across a format, are not compared at folder level.
- **Nothing from a scan is markup.** The report assigns text with `textContent`, data stays in inert JSON, and the CSP allows only the page's own code by hash. Never use `innerHTML` or inline handlers.
- **All of Diskly stays under 50 MB, however long it is used.** That counts the program, the WebView2 folder and the data. `Store::enforce` holds the line. Nothing may grow without a bound: anything new that is kept needs a limit and a test.
- **Keep the engine close to upstream.** Change `crates/diskghost-core` only with evidence and the smallest diff, and record it in `NOTICE`. The `upstream` remote is Diskghost.

## What the owner asked for

- **The report answers "what is big?" first.** Biggest files, biggest folders, what kinds of file. Never rank what is small: freed space is a detail, closed by default.
- **The look is iOS on true black, and it must feel smooth.** Spring on press, one element for a sliding thumb, sheets that rise. Only transform and opacity move. Real `backdrop-filter` only on what content moves under (bar, sheet, tooltip), never on panels. A choice redraws only what it changes. Measure with `scripts/e2e/smooth.mjs`.
- **The fastest scan is the default.** The window does not ask how to scan.

## Where things are

| Path | What |
|---|---|
| `crates/diskly-core` | Volumes, scanning, history store, comparison table, report assembly |
| `crates/diskly-core/src/insights.rs` | Biggest files, kinds, well-known places, worked out once from the finished scan |
| `report/lib.js` | All comparison arithmetic, map layout, forecast, headline and AI text. The only place for it |
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

`scripts/e2e/app.e2e.mjs` runs the real app on real disks. Phases `basic` and `browser` need no prompt, and `uac-*` need someone to answer Windows prompts. `DISKLY_DATA_DIR` must end in `Diskly\Data`, or the helper refuses it. The WebView2 folder goes next to it. `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, which the tests need for debugging, replaces the app's own flags, so they pass those flags too. Always use it for tests, so the real history stays clean.

Scan times come from `crates/diskly-core/examples/measure.rs`. Check UI by looking at it: `scripts/e2e/look.mjs` and `shots.mjs` for the report, `capture-window.ps1` for the window. Playwright's MCP tool blocks `file:` URLs, and the report must be tested from one, so the scripts drive the browser over the DevTools protocol.

## What real use taught

- **Open reports with the `http` handler, not the `.html` association.** The association can be unset. Windows then shows a dialog and still reports success.
- **A UAC prompt takes any amount of time, and times out as a refusal after about 2 minutes.** Nothing may expire while it is open. If the window is not in front, the prompt only flashes in the taskbar.
- **The prompt covers everything, so people cannot read instructions during it.** To test each answer, read the outcome from the run records (`finished_at - started_at - seconds` is the wait) rather than relying on someone following steps.
- **More walk threads make it slower.** 4 per volume is the measured best.
- **Left alone, WebView2 grows to 75 MB in a small window.** It downloads components, which also goes against "no network". The flags in `main.rs` keep it near 2 MB.

## Publishing

Commit in single-purpose steps; never force-push. Pushing a `v*` tag builds a draft release, and it needs the owner's explicit approval each time, with the version and test results reported first. Before publishing a draft, download its files and run `app.e2e.mjs basic` on them: CI checks out CRLF line ends, so a CI build can differ from a local one.

Never use `git push --tags`. This clone holds Diskghost's own tags (`v0.1.0` to `v0.12.0`), under names Diskly's versions also use. Push a release tag explicitly: `git push origin <commit>:refs/tags/vX.Y.Z`. Never commit real scan output or screenshots of real reports: the README's report pictures come from `scripts/demo/demo-data.js`, and `scripts/e2e/readme-shots.mjs` remakes them. `gh` may default to the upstream repository here, so always pass `--repo seiya058904/Diskly`.
