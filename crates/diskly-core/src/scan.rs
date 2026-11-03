//! One scan of one volume, and several at once.
//!
//! The core marks a folder it could not list as read and empty (see
//! docs/benchmarks/2026-11-core-acceptance.md). Comparing such a scan would
//! report freed space that was never freed, so the folders the walk could not
//! list are kept as unread, and comparison treats them as unknown.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::time::Instant;

use diskghost_core::{Options, Progress, ScanTree, Snapshot};
use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::insights::{self, Insights};

/// Threads per volume for the directory walk: more only cost CPU (measured in
/// docs/benchmarks/2026-11-core-acceptance.md).
pub const WALK_THREADS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanStatus {
    Complete,
    Cancelled,
    Failed,
}

/// How a scan went. It travels between processes as JSON when an elevated
/// helper does the scanning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSummary {
    pub status: ScanStatus,
    pub error: Option<String>,
    /// `"mft"` or `"walk"`: the two measure differently (see compare).
    pub engine: String,
    /// Why the MFT was asked for and not used.
    pub mft_fallback: Option<String>,
    pub elevated: bool,
    pub seconds: f64,
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    /// Entries the core could not read.
    pub skipped: u64,
    pub disk_total: u64,
    pub disk_free: u64,
    /// Folders that could not be listed, relative to the root.
    pub unread_dirs: Vec<String>,
    /// Where the space went. It travels with the summary out of the elevated helper,
    /// and is stored in its own file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insights: Option<Insights>,
}

impl ScanSummary {
    /// Unreadable entries that cannot be pinned on a folder.
    pub fn skipped_elsewhere(&self) -> u64 {
        self.skipped.saturating_sub(self.unread_dirs.len() as u64)
    }

    pub fn failed(error: impl Into<String>, seconds: f64) -> ScanSummary {
        ScanSummary {
            status: ScanStatus::Failed,
            error: Some(error.into()),
            engine: "none".into(),
            mft_fallback: None,
            elevated: is_elevated(),
            seconds,
            files: 0,
            dirs: 0,
            bytes: 0,
            skipped: 0,
            disk_total: 0,
            disk_free: 0,
            unread_dirs: Vec::new(),
            insights: None,
        }
    }
}

/// `path` relative to `root`, with `\` between components.
pub fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let rest = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rest
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("\\"))
}

/// Scan `root`. A scan that ran to its end gives a snapshot; a cancelled or
/// failed one does not, since it cannot serve as a baseline.
pub fn scan_root(
    root: &Path,
    use_mft: bool,
    progress: &Progress,
) -> (ScanSummary, Option<Snapshot>) {
    let started = Instant::now();
    if let Err(e) = std::fs::read_dir(root) {
        return (
            ScanSummary::failed(format!("无法读取根目录：{e}"), 0.0),
            None,
        );
    }
    let options = Options {
        threads: Some(WALK_THREADS),
        mft: use_mft,
        ..Options::default()
    };
    let tree = ScanTree::build(root, &options, progress);
    let report = tree.root_report(0);
    let cancelled = tree.cancelled();
    let mut unread_dirs: Vec<String> = if cancelled {
        Vec::new()
    } else {
        tree.unlistable_dirs()
            .iter()
            .filter_map(|p| relative_path(root, p))
            .filter(|rel| !rel.is_empty())
            .collect()
    };
    unread_dirs.sort();
    let snapshot = (!cancelled).then(|| Snapshot::capture(&tree));
    let insights = (!cancelled).then(|| insights::from_tree(&tree));
    let summary = ScanSummary {
        status: if cancelled {
            ScanStatus::Cancelled
        } else {
            ScanStatus::Complete
        },
        error: None,
        engine: tree.engine().to_string(),
        mft_fallback: tree.mft_fallback().map(str::to_string),
        elevated: is_elevated(),
        seconds: started.elapsed().as_secs_f64(),
        files: report.total_files,
        dirs: report.total_dirs,
        bytes: report.total_size,
        skipped: report.skipped,
        disk_total: report.disk_total,
        disk_free: report.disk_free,
        unread_dirs,
        insights,
    };
    (summary, snapshot)
}

/// Run `work` on every job: jobs on the same physical disk one after another,
/// different disks at the same time. A job that panics fails alone. Results
/// come back in the order of `jobs`.
pub fn run_per_disk<J, R>(
    jobs: Vec<J>,
    disk_of: impl Fn(&J) -> Option<u32>,
    work: impl Fn(&J) -> R + Sync,
    on_panic: impl Fn(&J) -> R + Sync,
) -> Vec<R>
where
    J: Sync,
    R: Send,
{
    // Jobs on an unknown disk get a group each.
    let mut groups: Vec<(Option<u32>, Vec<usize>)> = Vec::new();
    for (i, job) in jobs.iter().enumerate() {
        match disk_of(job) {
            Some(disk) => match groups.iter_mut().find(|(d, _)| *d == Some(disk)) {
                Some((_, members)) => members.push(i),
                None => groups.push((Some(disk), vec![i])),
            },
            None => groups.push((None, vec![i])),
        }
    }
    let mut results: Vec<(usize, R)> = std::thread::scope(|scope| {
        let handles: Vec<_> = groups
            .iter()
            .map(|(_, members)| {
                let (jobs, work, on_panic) = (&jobs, &work, &on_panic);
                scope.spawn(move || {
                    members
                        .iter()
                        .map(|&i| {
                            let job = &jobs[i];
                            let result = catch_unwind(AssertUnwindSafe(|| work(job)))
                                .unwrap_or_else(|_| on_panic(job));
                            (i, result)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });
    results.sort_by_key(|(i, _)| *i);
    results.into_iter().map(|(_, r)| r).collect()
}

/// Whether this process runs with administrator rights.
pub fn is_elevated() -> bool {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: the pseudo-handle needs no closing; `token` is a valid out-pointer.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }
    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut returned = 0u32;
    // SAFETY: the output buffer is `elevation` with its true size; `token` is valid.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            (&raw mut elevation).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    };
    // SAFETY: `token` came from OpenProcessToken and is closed once.
    unsafe { CloseHandle(token) };
    ok != 0 && elevation.TokenIsElevated != 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn relative_paths_use_backslashes_and_stay_inside_the_root() {
        let root = Path::new(r"C:\");
        assert_eq!(
            relative_path(root, Path::new(r"C:\Users\a b\c")).unwrap(),
            r"Users\a b\c"
        );
        assert_eq!(relative_path(root, Path::new(r"C:\")).unwrap(), "");
        assert_eq!(relative_path(root, Path::new(r"D:\x")), None);
    }

    #[test]
    fn jobs_keep_their_order_and_one_panic_stays_alone() {
        let results = run_per_disk(
            vec![0u32, 1, 2, 3],
            |j| Some(j % 2),
            |j| {
                assert!(*j != 2, "job 2 fails on purpose");
                *j * 10
            },
            |_| 999,
        );
        assert_eq!(results, vec![0, 10, 999, 30]);
    }

    #[test]
    fn the_same_disk_runs_in_sequence() {
        let running = AtomicUsize::new(0);
        let most = AtomicUsize::new(0);
        run_per_disk(
            vec![1, 2, 3, 4],
            |_| Some(7),
            |_| {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(15));
                running.fetch_sub(1, Ordering::SeqCst);
            },
            |_| (),
        );
        assert_eq!(most.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn different_disks_run_at_the_same_time() {
        let running = AtomicUsize::new(0);
        let most = AtomicUsize::new(0);
        run_per_disk(
            vec![1, 2],
            |j| Some(*j),
            |_| {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(60));
                running.fetch_sub(1, Ordering::SeqCst);
            },
            |_| (),
        );
        assert_eq!(most.load(Ordering::SeqCst), 2);
    }
}
