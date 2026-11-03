//! The elevated MFT helper.
//!
//! Reading the NTFS Master File Table needs administrator rights, and the
//! window should not run elevated. So a fast scan starts this same program a
//! second time: elevated after the user's consent, with no window, for that one
//! scan. Idea and file protocol are adapted from Diskghost's helper
//! (`gui/src-tauri/src/helper.rs`, MIT, Copyright (c) 2026 kingchenc).
//!
//! An elevated process must not trust a folder that normal programs can write
//! to. So, unlike that helper, this one parses nothing from it. What to do comes
//! from the elevated command line, which normal programs cannot change. From the
//! folder it only notices whether two marker files exist and how old one is. It
//! writes under names holding a random token that normal programs cannot read,
//! it takes only the roots of fixed volumes, and it exits when the scan is done.
//!
//! | file                 | from   | content                                   |
//! |----------------------|--------|-------------------------------------------|
//! | `<t>-alive.json`     | app    | touched every few seconds; stale = stop   |
//! | `<t>-cancel.json`    | app    | exists = stop                             |
//! | `<t>-beat.json`      | helper | touched while it runs; stale = it died    |
//! | `<t>-progress.json`  | helper | counts per volume                         |
//! | `<t>-<L>.dgs`        | helper | the scan of volume L as a snapshot        |
//! | `<t>-<L>.json`       | helper | how that scan went                        |
//! | `<t>-done.json`      | helper | all volumes are finished                  |

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use diskghost_core::{Progress, Snapshot};
use diskly_core::scan::{run_per_disk, scan_root, ScanSummary};
use diskly_core::store::write_atomic;
use diskly_core::volumes::{fixed_volumes, Volume};
use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_CANCELLED, HANDLE, HWND, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::WaitForSingleObject;
use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

/// The helper stops when the app has not touched its file for this long.
const APP_TIMEOUT: Duration = Duration::from_secs(20);
/// The app gives up when the helper has not touched its file for this long.
const HELPER_TIMEOUT: Duration = Duration::from_secs(20);

const WAITING: u8 = 0;
const SCANNING: u8 = 1;
const DONE: u8 = 2;

/// Where a volume is, as the helper reports it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HelperCount {
    pub letter: char,
    pub state: u8,
    pub files: u64,
    pub bytes: u64,
}

fn age(file: &Path) -> Option<Duration> {
    let modified = std::fs::metadata(file).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok()
}

fn touch(file: &Path) {
    let _ = std::fs::write(file, b"");
}

fn is_token(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The folder must be what the app says it is, not a link to somewhere else.
fn is_helper_folder(dir: &Path) -> bool {
    const REPARSE_POINT: u32 = 0x400;
    let plain = |p: &Path| {
        std::fs::symlink_metadata(p)
            .is_ok_and(|m| m.is_dir() && m.file_attributes() & REPARSE_POINT == 0)
    };
    dir.is_absolute()
        && dir.file_name() == Some(OsStr::new("helper"))
        && dir
            .parent()
            .is_some_and(|p| p.file_name() == Some(OsStr::new("Diskly")) && plain(p))
        && plain(dir)
}

// ------------------------------- helper side -------------------------------

/// Run as the helper: `--mft-helper <folder> <token> <letters>`.
pub fn serve(args: &[String]) -> i32 {
    let [dir, token, letters] = args else {
        return 2;
    };
    let dir = PathBuf::from(dir);
    if !is_token(token) || !is_helper_folder(&dir) {
        return 2;
    }
    // Only what really is a fixed volume on this machine.
    let volumes: Vec<Volume> = fixed_volumes()
        .into_iter()
        .filter(|v| v.problem.is_none() && letters.contains(v.letter))
        .collect();
    if volumes.is_empty() || !letters.chars().all(|c| c.is_ascii_uppercase()) {
        return 2;
    }
    let file = |what: &str| dir.join(format!("{token}-{what}"));

    let jobs: Vec<(Volume, Progress, Arc<AtomicU8>)> = volumes
        .into_iter()
        .map(|v| (v, Progress::default(), Arc::new(AtomicU8::new(WAITING))))
        .collect();
    let finished = AtomicBool::new(false);

    std::thread::scope(|scope| {
        scope.spawn(|| {
            let (beat, alive, cancel, progress) = (
                file("beat.json"),
                file("alive.json"),
                file("cancel.json"),
                file("progress.json"),
            );
            while !finished.load(Ordering::Relaxed) {
                touch(&beat);
                let counts: Vec<HelperCount> = jobs
                    .iter()
                    .map(|(v, p, s)| HelperCount {
                        letter: v.letter,
                        state: s.load(Ordering::Relaxed),
                        files: p.files(),
                        bytes: p.bytes(),
                    })
                    .collect();
                if let Ok(bytes) = serde_json::to_vec(&counts) {
                    let _ = write_atomic(&progress, &bytes);
                }
                let app_gone = age(&alive).is_none_or(|a| a > APP_TIMEOUT);
                if app_gone || cancel.exists() {
                    for (_, p, _) in &jobs {
                        p.cancel();
                    }
                }
                std::thread::sleep(Duration::from_millis(120));
            }
        });

        run_per_disk(
            jobs.iter().collect::<Vec<_>>(),
            |(v, _, _)| v.physical_disk,
            |(v, progress, state)| {
                state.store(SCANNING, Ordering::Relaxed);
                let (summary, snapshot) = scan_root(&v.root, true, progress);
                write_result(
                    &file(&format!("{}.dgs", v.letter)),
                    &file(&format!("{}.json", v.letter)),
                    &summary,
                    snapshot.as_ref(),
                );
                state.store(DONE, Ordering::Relaxed);
            },
            |(v, _, state)| {
                let summary = ScanSummary::failed("扫描时发生内部错误", 0.0);
                write_result(
                    &file(&format!("{}.dgs", v.letter)),
                    &file(&format!("{}.json", v.letter)),
                    &summary,
                    None,
                );
                state.store(DONE, Ordering::Relaxed);
            },
        );
        finished.store(true, Ordering::Relaxed);
    });
    touch(&file("done.json"));
    0
}

fn write_result(
    snapshot_file: &Path,
    summary_file: &Path,
    summary: &ScanSummary,
    snapshot: Option<&Snapshot>,
) {
    let mut summary = summary.clone();
    if let Some(snapshot) = snapshot {
        if let Err(e) = snapshot.save(snapshot_file) {
            summary = ScanSummary::failed(format!("无法保存结果：{e}"), summary.seconds);
        }
    }
    if let Ok(bytes) = serde_json::to_vec(&summary) {
        let _ = write_atomic(summary_file, &bytes);
    }
}

// --------------------------------- app side ---------------------------------

/// Why the helper could not be started.
#[derive(Debug)]
pub enum StartError {
    /// The user said no in the Windows prompt.
    Declined,
    Failed(String),
}

/// A running helper.
pub struct Helper {
    dir: PathBuf,
    token: String,
    process: HANDLE,
}

// SAFETY: a process handle may be used from any thread.
unsafe impl Send for Helper {}

/// A random token: hashes keyed by the OS random source, as in Diskghost.
fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let part = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos()),
        );
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
}

impl Helper {
    /// Start the helper for `letters`; Windows asks the user first. Blocks until
    /// they answer.
    pub fn start(dir: PathBuf, letters: &str, owner: HWND) -> Result<Helper, StartError> {
        std::fs::create_dir_all(&dir).map_err(|e| StartError::Failed(e.to_string()))?;
        let token = random_token();
        touch(&dir.join(format!("{token}-alive.json")));

        let exe = std::env::current_exe().map_err(|e| StartError::Failed(e.to_string()))?;
        let params = format!("--mft-helper \"{}\" {token} {letters}", dir.display());
        let (verb, file, params) = (
            wide(OsStr::new("runas")),
            wide(exe.as_os_str()),
            wide(OsStr::new(&params)),
        );
        // SAFETY: an all-zero SHELLEXECUTEINFOW is valid before its fields are set.
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.hwnd = owner;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = params.as_ptr();
        info.nShow = SW_HIDE;
        // SAFETY: `info` is filled in and the strings it points to outlive the call.
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            // SAFETY: no preconditions.
            let code = unsafe { GetLastError() };
            return Err(if code == ERROR_CANCELLED {
                StartError::Declined
            } else {
                StartError::Failed(format!("无法启动提权进程（错误 {code}）"))
            });
        }
        Ok(Helper {
            dir,
            token,
            process: info.hProcess,
        })
    }

    fn file(&self, what: &str) -> PathBuf {
        self.dir.join(format!("{}-{what}", self.token))
    }

    /// Tell the helper the app is still here.
    pub fn keep_alive(&self) {
        touch(&self.file("alive.json"));
    }

    pub fn cancel(&self) {
        touch(&self.file("cancel.json"));
    }

    /// The counts so far, if there are any yet.
    pub fn counts(&self) -> Vec<HelperCount> {
        std::fs::read(self.file("progress.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn finished(&self) -> bool {
        self.file("done.json").exists()
    }

    /// The helper's process has exited, or has not been heard from for too long.
    pub fn gone(&self) -> bool {
        // SAFETY: `process` is a handle this struct owns, or null.
        let exited = !self.process.is_null()
            && unsafe { WaitForSingleObject(self.process, 0) } != WAIT_TIMEOUT;
        let silent = age(&self.file("beat.json")).is_some_and(|a| a > HELPER_TIMEOUT);
        exited || silent
    }

    /// The result for one volume. The snapshot was written by the helper and
    /// is read like any other file: a bad one is an error for that volume.
    pub fn result(&self, letter: char) -> Option<(ScanSummary, Option<Snapshot>)> {
        let summary: ScanSummary =
            serde_json::from_slice(&std::fs::read(self.file(&format!("{letter}.json"))).ok()?)
                .ok()?;
        let path = self.file(&format!("{letter}.dgs"));
        if !path.exists() {
            return Some((summary, None));
        }
        match Snapshot::load(&path) {
            Ok(snapshot) => Some((summary, Some(snapshot))),
            Err(e) => Some((
                ScanSummary::failed(format!("无法读取结果：{e}"), summary.seconds),
                None,
            )),
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        if !self.process.is_null() {
            // SAFETY: the handle came from ShellExecuteExW and is closed once.
            unsafe { CloseHandle(self.process) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_32_hex_digits() {
        let token = random_token();
        assert!(is_token(&token), "{token}");
        assert_ne!(token, random_token());
        assert!(!is_token("..\\..\\windows"));
        assert!(!is_token(&"g".repeat(32)));
    }

    #[test]
    fn only_a_plain_helper_folder_in_a_diskly_folder_is_accepted() {
        let base = std::env::temp_dir().join(format!("diskly-helper-test-{}", std::process::id()));
        let good = base.join("Diskly").join("helper");
        std::fs::create_dir_all(&good).unwrap();
        let wrong = base.join("Other").join("helper");
        std::fs::create_dir_all(&wrong).unwrap();
        assert!(is_helper_folder(&good));
        assert!(!is_helper_folder(&wrong));
        assert!(!is_helper_folder(Path::new(r"Diskly\helper")));
        assert!(!is_helper_folder(&base.join("Diskly").join("nope")));

        let target = base.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let linked = base.join("Linked").join("Diskly");
        std::fs::create_dir_all(&linked).unwrap();
        let junction = linked.join("helper");
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .output()
            .unwrap();
        assert!(made.status.success(), "could not make a junction");
        assert!(!is_helper_folder(&junction), "a junction must be refused");
        let _ = std::fs::remove_dir(&junction);
        let _ = std::fs::remove_dir_all(&base);
    }
}
