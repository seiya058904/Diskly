# Speed and footprint

Date: 2026-11-03. Same machine as [the core acceptance report](2026-11-core-acceptance.md): i7-12700H, two NVMe SSDs, Windows 11, Defender on. C: about 600,000 files, D: about 130,000. Disks already cached by Windows.

## Listing directories

Listing only, 4 threads, no tree built. `read_dir` is what the walk used. The other is `NtQueryDirectoryFile` into a 64 KB buffer, with each directory opened relative to its parent.

| | C: | D: |
|---|---:|---:|
| `read_dir` | 4.87 s, 6.00 s | 1.05 s |
| Direct | 4.03 s, 4.20 s, 4.47 s | 0.47 s, 0.48 s |

On C:, 2, 4, 8 and 16 threads take 4.6, 4.2, 4.5 and 5.0 s, so something outside the program limits it. Defender's real-time protection is the likely cause, but this was not isolated. Only the MFT avoids it.

The direct listing also says which folders failed, so the second pass that probed about 22,700 empty-looking folders (1.0 s on C:) is gone. It finds the same unreadable folders as before: 87 on C:, 2 on D:.

## The whole scan

| Both disks, in parallel | Before | Now |
|---|---:|---:|
| Fast, through the real window and prompt | 1.35 to 2.48 s | 1.50 s (3.65 s for the first after a while) |
| Normal, scan and saving together | 6.09 to 7.72 s | 5.76 to 6.55 s |

The fast engine itself did not change. Of a normal scan, C: takes about 5.3 s and D: about 1.0 s. Saving takes 0.08 to 0.56 s and writing the report 0.35 to 0.55 s.

## Disk

| | 0.1.0, after many runs | Now |
|---|---:|---:|
| Program | 10.5 MB | 8.7 MB |
| WebView2 folder | 75 MB measured | 2.3 to 3.7 MB |
| Data | Grew without a limit: 20 scans of 7.5 MB each, and every report and run record kept | 10.9 to 21 MB |

Data stayed at 14.6 MB over 5 normal scans in a row. It reaches about 21 MB when the newest scan of each engine is kept whole. A full snapshot is about 8 MB here, and one with only folders about 1.6 MB.

The program shrank through `opt-level = "s"`, with the scanning crates kept at level 3. Normal scan times stayed the same afterwards.

## The page

`scripts/e2e/smooth.mjs` on a real report (1.7 MB, 866 elements), in headless Chrome with software drawing:

| | |
|---|---:|
| Page ready | 321 ms |
| First paint | 352 ms |
| Scrolling 9,294 px: frame time at the median, 95th percentile and worst | 16.7, 16.7, 16.8 ms |
| Long tasks while scrolling | 0 |
| Click on the map, on the page's thread | 5.9 ms |
| Flight into a folder, 95th percentile frame | 16.7 ms |

These are main-thread frames. They do not prove what a given graphics card draws.

## Not tested

- Disks with millions of files. The limits are enforced by tests with small trees, not on such a disk.
- The window's memory is still about 165 MB of private memory, nearly all WebView2. This work did not reduce it.
