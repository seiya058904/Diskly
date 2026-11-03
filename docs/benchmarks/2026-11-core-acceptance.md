# Core acceptance: Diskghost as the scanning engine

Date: 2026-11-03. Decision: **keep Diskghost**, with one small core patch. eDirStat was not needed.

Everything below was measured on one machine. Raw numbers are in [`raw/`](raw/) and contain no paths. Scripts are in [`scripts/bench/`](../../scripts/bench/); they drive `diskghost-cli`, which Diskly later removed, so to rerun them check out the commit that added this report.

| | |
|---|---|
| Machine | Intel i7-12700H (20 threads), 15.8 GB RAM, Windows 11 |
| C: | NTFS, SK Hynix NVMe, about 600 k files, 119 k folders, 118.6 GB used |
| D: | NTFS, Kingston NVMe, about 118 k files, 16 k folders, 30.6 GB used |
| Engine | Diskghost `0034d79` (v0.12.0), release build |

**Limits of this test.** There is no third disk here, so E: was not tested. These volumes are small compared with a full multi-terabyte disk, so nothing here predicts speed or memory at tens of millions of files. All runs were on a machine already in use: the "first" run is the first of a session, not a true cold start after a reboot, and later runs are served largely from the Windows cache.

## Speed

Median of 3 runs unless noted, first run in brackets.

| Scanner | C: | D: | Both |
|---|---:|---:|---:|
| DiskPulse scanner (baseline, one thread) | 11.2 s (14.0) | 1.46 s (1.40) | 12.6 s in sequence |
| Diskghost walk, upstream default of 40 threads | 6.4 s (11.7) | 0.54 s (0.66) | 6.5 s in parallel |
| Diskghost walk, 4 threads (median of 5) | **5.3 s** | | |
| Diskghost MFT, administrator | **1.3 s** (2.5) | **0.32 s** (0.64) | **1.4 s** in parallel (3.0) |

- The walk at 4 threads is 2.1 times as fast as DiskPulse on C:, 2.7 times on D: at the default thread count.
- The MFT engine is 8.4 times as fast on C:. With both disks in parallel it is 9.2 times as fast.

### Thread count

More threads make the walk slower and much more expensive (C:, 5 runs each):

| Threads | 2 | 4 | 6 | 8 | 12 | 20 | 40 (3 runs) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Wall time, median | 5.96 s | **5.29 s** | 5.20 s | 5.29 s | 5.66 s | 5.83 s | 6.21 s |
| CPU time, median | 12.0 s | **17.3 s** | 21.9 s | 25.7 s | 33.2 s | 39.1 s | 41.7 s |

**Decision:** Diskly walks with 4 threads per volume. That costs less than half the CPU of the upstream default and is slightly faster.

### Several SSDs at once

C: and D: are separate NVMe drives. Scanning both in parallel takes about as long as C: alone: D: slows from 0.54 s to 1.0 s, and the total does not suffer.

**Decision:** volumes on different physical disks run in parallel, volumes on the same physical disk run in sequence.

### Memory and snapshots

| | C: | D: |
|---|---:|---:|
| Peak working set, walk at 4 threads | 86 MB | about 30 MB |
| Peak working set, MFT, upstream | 320 MB | 175 MB |
| Peak working set, MFT, with the final patch | 326 MB | 175 MB |
| Snapshot on disk | 6.3 MB | 1.2 MB |
| Capture / save / load | 0.14 s / 5 ms / 15 ms | 26 ms / 2 ms / 19 ms |
| Read all folders / compare two snapshots | 0.11 s / 0.12 s | 17 ms / 25 ms |

A first version of the patch peaked at 408 MB, because it kept every 8.3 alias. The final one drops an alias as soon as the long name is in the same record.

## Correctness

### Known-size fixture

`scripts/bench/fixture.ps1` builds a tree with known contents and checks the result. All of these are exact: plain files, Chinese names, a path beyond `MAX_PATH`, a hard link (counted once per name), a junction (not followed), a sparse file and an NTFS-compressed file (both counted at on-disk size), and real growth and shrinkage between two snapshots.

### Against independent counts (normal user)

| | Files, C: | Files, D: | Unreadable folders, C: / D: |
|---|---:|---:|---:|
| Diskghost walk | 555,567 | 113,273 | 87 / 2 |
| `robocopy /L` | 555,691 | 113,273 | 87 / 2 |
| DiskPulse | 555,624 | 112,367 | 85 denied + 2 excluded / 1 denied + 2 excluded |

Differences in bytes all have an explanation:

- **Logical against on-disk size.** robocopy adds up logical lengths. Diskghost reports on-disk size for sparse, compressed and cloud files. On D:, Diskghost's logical total matches robocopy's within 10 KB (27,640,842,798 against 27,640,832,828 bytes, on a live disk). Its on-disk total is 42.9 MB lower, because of 3 files. On C: the same gap is 159 MB, because of 21 files.
- **Exclusions.** DiskPulse skips `$RECYCLE.BIN` and `System Volume Information`, which explains its 906 fewer files on D:.
- **Live volume.** C: is the running system disk, so its numbers drift between tools. Repeated Diskghost scans differ by less than 0.01% in file count.

### MFT against a walk with the same rights

Both ran as administrator, one right after the other.

| | C:, MFT | C:, walk | D:, MFT | D:, walk |
|---|---:|---:|---:|---:|
| Files | 598,638 | 598,526 | 118,182 | 118,177 |
| Bytes | 123.76 GB | 117.44 GB | 30.327 GB | 30.327 GB |
| Unreadable folders | 0 | 8 | 0 | 1 |

What remains between them, in order of size:

1. **`System Volume Information`, 6.9 GB.** Shadow copies. Only SYSTEM can list this folder, so even an elevated walk sees it as empty. The MFT is right.
2. **Transparently compressed (WOF) files, about 570 MB net.** Checked on one file: `GetFileAttributes` shows no compression flag, its logical length is 2,823,661 bytes, and `GetCompressedFileSize` returns 479,232. The MFT engine reports the latter. The walk cannot tell from the listing and reports the former. The MFT is right.
3. **Live files.** A folder listing can show a stale size for a file that is open. A few MB.

The MFT is the more accurate engine. Its total can exceed the system's used space (123.8 GB against 118.6 GB here) because each name of a hard link counts in full. That is the core's definition, and the report has to say so.

### Failure handling

- Without administrator rights, `--mft` falls back to the walk and gives the reason (`administrator rights needed`).
- Cancelling works in both engines, with no crash, in 8 runs on real volumes. The walk stops within about 25 ms; the MFT engine finishes its current read first and took at most 1.1 s. A cancelled scan is flagged, its snapshot is marked incomplete, and comparing it is refused.
- One scan on D: finished at 278 ms, before its cancel at 300 ms, and was correctly reported as complete.

## Two defects found in the core

### 1. An unreadable folder looks emptied (handled in the adapter)

When a folder cannot be listed, `walk.rs` counts one skipped entry, but `tree.rs` still marks the folder as read. The snapshot records it as complete and 0 bytes, and does not store the skipped count. Reproduced with the fixture: denying access to a 300 KB folder makes `diff` report that folder as shrunk, the total as 300 KB smaller, and its file as removed.

Normal users hit 87 such folders on C:. Saying "space was freed" here would be wrong, so this has to be handled, but it **does not need a core change**:

- A folder that failed has no files and no size, and the public `ScanTree::dir_sizes()` lists those. Diskly tries to read each of them after a walk.
- **Accurate:** it finds exactly the skipped folders: 87 of 87 and 2 of 2 as a normal user, 8 of 8 and 1 of 1 as administrator.
- **Cost:** 1.0 s for 22,700 empty-looking folders on C:, 8 ms on D:.
- **Only after a walk.** The MFT engine does not use folder listings, so a failure to list a folder means nothing there.

### 2. MFT counts some folders twice (core patch, about 25 changed lines plus tests)

When a file has many attributes, its long name can sit in an extension record while the base record only holds the 8.3 alias. The base record then took the alias as its name, and the extension added the long name, so the folder appeared twice and everything below it counted twice. In the run on C: this produced paths such as `C:\Windows\WinSxS\AMF325~1.782\msedge.dll`, about 850 MB across 1,200 files.

A second bug is in the same lines: when the data stream sits in an extension record, the size was computed without the base record's attributes, so a compressed file counted at its logical length.

| C:, MFT against a walk with the same rights | Before | After |
|---|---:|---:|
| Files only the MFT sees | 1,327 | 119 |
| Of those, under an 8.3 alias | about 1,200 | **0** |
| Total bytes, MFT minus walk | 7.19 GB | 6.34 GB |

The patch is confined to `crates/diskghost-core/src/mft.rs`, and has unit tests. A public API cannot fix this, because the tree is already wrong by the time it is returned.

## Acceptance gate

| Requirement | Result | |
|---|---|---|
| Repeated scans differ by less than 1% in file count | Under 0.01% | Pass |
| Unexplained difference from baselines under 1% of bytes | All differences explained above; largest unexplained on C: about 0.04% (38 MB on a live disk) | Pass |
| Walk at least twice as fast as DiskPulse | 2.1 times on C:, 2.7 times on D: | Pass, narrowly on C: |
| No crash on cancel or error, safe fallback | Yes | Pass |
| Snapshot round trip and comparison correct | Yes, apart from defect 1, handled in the adapter | Pass |
| Unreadable-folder detection accurate at an acceptable cost | Exact; 1 s on C: | Pass |
| Stable MFT results | Yes, after the patch for defect 2 | Pass with patch |

## What this changes in Diskly

- **Thread count:** 4 per volume for the walk.
- **Comparing engines:** a walk and an MFT scan measure different things. Comparing them makes `Program Files (x86)` appear to grow by 606 MB with nothing changing, because of WOF compression. Folder changes are therefore only shown between scans made **with the same engine**. Across engines, only the system's used-space change is shown, with the reason.
- **Totals:** the report states that folder totals count each hard-link name and can exceed the system's used space.
- **Unknown folders:** a folder that could not be read in either scan is unknown, with everything below it, and never counts as a change.
- **Speed claims:** this report supports "about 1.3 s for 600 k files on an NVMe SSD, as administrator, with a warm cache". It does not support a general "seconds" claim.

## The finished app

Release build of Diskly 0.1.0, same machine, after the app was built. By then C: and D: held about 604,000 and 131,000 files. This is the whole scan through the real window: both disks in parallel, snapshots captured, and for a normal scan the unreadable-folder check.

| Whole scan, C: and D: | Runs | Seconds |
|---|---:|---:|
| Fast (MFT, through the elevated helper) | 6 | 1.35, 1.36, 1.42, 1.43, 2.36, 2.48 |
| Normal (walk, 4 threads per disk) | 5 | 6.09, 6.75, 6.76, 7.20, 7.72 |

The two slower fast runs were each the first in a while, so the table was probably no longer fully cached.

Real Windows prompts, read from the run records:

| Time before the answer | Result |
|---|---|
| 5 s, 11 s | Fast scan completed |
| 33 s, 51 s | Fast scan completed, and the scan time excludes the wait. An earlier build cancelled itself after 20 s |
| 123 s, unanswered | Windows times out as a refusal: normal scan, reason recorded, report written |

**Not tested:** clicking "No" by hand. It should give the same error as the timeout, which is what ran. The window's message for it was checked with a simulated event.

Known changes on a real disk were reported to the byte: a 300 MB file added and a 120 MB file removed gave +300 MB, -120 MB and a headline of +180 MB, with both scan types.

| Size | |
|---|---:|
| Installer | 2.5 MB |
| Portable executable | 10.5 MB |
| Report, real disks, about 8 scans | 4.5 MB before an unused column was removed |
| Report at the limit of 20,000 folders, 4 scans | 1.6 MB |

## Risks that remain

- **Single maintainer.** Diskghost has one maintainer and very few users. The core stays close to upstream, and the patch could be offered back.
- **No independent MFT tool.** WizTree is not installed here. The MFT engine was checked against a walk with the same rights instead, and each difference was explained.
- **Partly read folders.** If a folder lists but one entry fails, the failure is only known as a count, not a location. It did not occur here (skipped count equalled unreadable folders), and the report shows such a count if it does.
