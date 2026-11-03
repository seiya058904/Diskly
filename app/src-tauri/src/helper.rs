//! The elevated MFT helper.
//!
//! Reading the NTFS Master File Table needs administrator rights, and the
//! window should not run elevated. So a fast scan starts this same program a
//! second time: elevated after the user's consent, with no window, for that one
//! scan. Idea and file protocol are adapted from Diskghost's helper
//! (`gui/src-tauri/src/helper.rs`, MIT, Copyright (c) 2026 kingchenc).
//!
//! An elevated process must not be steered by programs without its rights, which
//! can write to the user's data folder and can read file names there. So, unlike
//! that helper, this one:
//!
//! - takes what to do from the elevated command line, which they cannot change,
//!   and only the roots of fixed volumes;
//! - writes only into a private folder it makes for this scan, which administrators
//!   can write to and others only read, so no link can be planted in it;
//! - holds that folder open, so it and the folders above it cannot be swapped;
//! - only looks at whether marker files exist and how old they are, never opening
//!   anything in the folder others can write to;
//! - exits when the scan is done.
//!
//! In the helper folder, from the app:
//!
//! | file                 | content                                         |
//! |----------------------|-------------------------------------------------|
//! | `<t>-alive.json`     | touched every few seconds; stale = stop         |
//! | `<t>-cancel.json`    | exists = stop                                   |
//! | `<t>-collected.json` | exists = results were read, clean up            |
//!
//! In the private folder `<t>`, from the helper:
//!
//! | file            | content                                  |
//! |-----------------|------------------------------------------|
//! | `beat.json`     | touched while it runs; stale = it died   |
//! | `progress.json` | counts per volume                        |
//! | `<L>.dgs`       | the scan of volume L as a snapshot       |
//! | `<L>.json`      | how that scan went                       |
//! | `done.json`     | all volumes are finished                 |

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use diskghost_core::{Progress, Snapshot};
use diskly_core::scan::{run_per_disk, scan_root, ScanSummary};
use diskly_core::store::{remove_session_files, remove_session_folder, write_atomic};
use diskly_core::volumes::{fixed_volumes, Volume};
use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_CANCELLED, HANDLE, HWND, INVALID_HANDLE_VALUE,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, GetFinalPathNameByHandleW, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
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
    let data = dir.parent();
    let product = data.and_then(Path::parent);
    dir.is_absolute()
        && dir.file_name() == Some(OsStr::new("helper"))
        && data.is_some_and(|p| p.file_name() == Some(OsStr::new("Data")) && plain(p))
        && product.is_some_and(|p| p.file_name() == Some(OsStr::new("Diskly")) && plain(p))
        && plain(dir)
}

// ------------------------------- helper side -------------------------------

/// A folder for one scan: administrators and the system may write to it, and
/// anyone signed in may read. Held open for as long as this value lives, which
/// stops it and the folders above it from being renamed.
struct PrivateFolder {
    handle: HANDLE,
}

impl PrivateFolder {
    /// Make `<helper folder>\<token>`. Fails if it exists already.
    fn create(path: &Path) -> Result<PrivateFolder, String> {
        const RULES: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;AU)";
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let rules = wide(OsStr::new(RULES));
        // SAFETY: `rules` is NUL-terminated; `descriptor` receives an allocation
        // that is freed below.
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                rules.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if converted == 0 {
            return Err("cannot prepare the folder's permissions".to_string());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let name = wide(path.as_os_str());
        // SAFETY: `name` is NUL-terminated; `attributes` and `descriptor` are valid here.
        let made = unsafe { CreateDirectoryW(name.as_ptr(), &attributes) };
        // SAFETY: `descriptor` came from the conversion above and is freed once.
        unsafe { LocalFree(descriptor) };
        if made == 0 {
            return Err("cannot create the folder".to_string());
        }
        // No FILE_SHARE_DELETE: while this handle is open, nothing can move it.
        // SAFETY: `name` is NUL-terminated; the handle is checked and owned below.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err("cannot open the folder".to_string());
        }
        let folder = PrivateFolder { handle };
        // The folders above may have been swapped before it was made and locked.
        let token = path.file_name().unwrap_or_default().to_string_lossy();
        let wanted = format!(r"\diskly\data\helper\{token}").to_lowercase();
        if !folder.final_path()?.to_lowercase().ends_with(&wanted) {
            return Err("the folder is not where it should be".to_string());
        }
        Ok(folder)
    }

    /// Where the folder really is, with every link resolved.
    fn final_path(&self) -> Result<String, String> {
        let mut buffer = vec![0u16; 4096];
        // SAFETY: `handle` is open, and `buffer` holds the length passed.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                self.handle,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED,
            )
        } as usize;
        if length == 0 || length >= buffer.len() {
            return Err("cannot tell where the folder is".to_string());
        }
        Ok(String::from_utf16_lossy(&buffer[..length]))
    }
}

impl Drop for PrivateFolder {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateFileW and is closed once.
        unsafe { CloseHandle(self.handle) };
    }
}

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
    let session = dir.join(token);
    let Ok(folder) = PrivateFolder::create(&session) else {
        return 3;
    };
    let out = |what: &str| session.join(what);
    let marker = |what: &str| dir.join(format!("{token}-{what}.json"));

    // The app starts touching its marker once the prompt has been answered, so
    // the time the user took does not count, only how long it stays silent now.
    let started = Instant::now();
    let app_gone = || match age(&marker("alive")) {
        Some(age) => age > APP_TIMEOUT,
        None => started.elapsed() > APP_TIMEOUT,
    };

    let jobs: Vec<(Volume, Progress, Arc<AtomicU8>)> = volumes
        .into_iter()
        .map(|v| (v, Progress::default(), Arc::new(AtomicU8::new(WAITING))))
        .collect();
    let finished = AtomicBool::new(false);

    std::thread::scope(|scope| {
        scope.spawn(|| {
            while !finished.load(Ordering::Relaxed) {
                touch(&out("beat.json"));
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
                    let _ = write_atomic(&out("progress.json"), &bytes);
                }
                if app_gone() || marker("cancel").exists() {
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
                    &out(&format!("{}.dgs", v.letter)),
                    &out(&format!("{}.json", v.letter)),
                    &summary,
                    snapshot.as_ref(),
                );
                state.store(DONE, Ordering::Relaxed);
            },
            |(v, _, state)| {
                let summary = ScanSummary::failed("扫描时发生内部错误", 0.0);
                write_result(
                    &out(&format!("{}.dgs", v.letter)),
                    &out(&format!("{}.json", v.letter)),
                    &summary,
                    None,
                );
                state.store(DONE, Ordering::Relaxed);
            },
        );
        finished.store(true, Ordering::Relaxed);
    });
    touch(&out("done.json"));

    // Only this process can clean its folder, once the app has read the results.
    while !marker("collected").exists() && !app_gone() {
        std::thread::sleep(Duration::from_millis(60));
    }
    remove_session_files(&session);
    // Files go while the folder is locked. Removing the folder needs it unlocked,
    // and removing a folder cannot follow a link.
    drop(folder);
    remove_session_folder(&session);
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

    /// A file in the helper's private folder, which this process can only read.
    fn result_file(&self, what: &str) -> PathBuf {
        self.dir.join(&self.token).join(what)
    }

    /// A marker this process writes for the helper to notice.
    fn marker(&self, what: &str) -> PathBuf {
        self.dir.join(format!("{}-{what}.json", self.token))
    }

    /// Tell the helper the app is still here.
    pub fn keep_alive(&self) {
        touch(&self.marker("alive"));
    }

    pub fn cancel(&self) {
        touch(&self.marker("cancel"));
    }

    /// Say the results have been read, and give the helper a moment to clean up.
    pub fn finish(&self) {
        touch(&self.marker("collected"));
        if !self.process.is_null() {
            // SAFETY: `process` is a handle this struct owns.
            unsafe { WaitForSingleObject(self.process, 5000) };
        }
    }

    /// The counts so far, if there are any yet.
    pub fn counts(&self) -> Vec<HelperCount> {
        std::fs::read(self.result_file("progress.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn finished(&self) -> bool {
        self.result_file("done.json").exists()
    }

    /// The helper's process has exited, or has not been heard from for too long.
    pub fn gone(&self) -> bool {
        // SAFETY: `process` is a handle this struct owns, or null.
        let exited = !self.process.is_null()
            && unsafe { WaitForSingleObject(self.process, 0) } != WAIT_TIMEOUT;
        let silent = age(&self.result_file("beat.json")).is_some_and(|a| a > HELPER_TIMEOUT);
        exited || silent
    }

    /// The result for one volume. The snapshot was written by the helper and
    /// is read like any other file: a bad one is an error for that volume.
    pub fn result(&self, letter: char) -> Option<(ScanSummary, Option<Snapshot>)> {
        let summary: ScanSummary = serde_json::from_slice(
            &std::fs::read(self.result_file(&format!("{letter}.json"))).ok()?,
        )
        .ok()?;
        let path = self.result_file(&format!("{letter}.dgs"));
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
    fn a_private_folder_cannot_be_written_to_or_moved_by_normal_programs() {
        let base = std::env::temp_dir().join(format!("diskly-private-{}", std::process::id()));
        let helper = base.join("Diskly").join("Data").join("helper");
        std::fs::create_dir_all(&helper).unwrap();
        let session = helper.join(random_token());

        let folder = PrivateFolder::create(&session).unwrap();
        assert!(session.is_dir());
        assert!(
            PrivateFolder::create(&session).is_err(),
            "a folder that exists might be someone else's"
        );
        assert!(
            std::fs::rename(&helper, base.join("moved")).is_err(),
            "the folders above must stay put"
        );
        if !diskly_core::scan::is_elevated() {
            assert!(
                std::fs::write(session.join("planted.json"), b"x").is_err(),
                "a normal program must not be able to plant anything"
            );
        }
        drop(folder);
        std::fs::remove_dir(&session).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_private_folder_must_be_in_the_helper_folder() {
        let base = std::env::temp_dir().join(format!("diskly-elsewhere-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let session = base.join(random_token());
        assert!(PrivateFolder::create(&session).is_err());
        let _ = std::fs::remove_dir(&session);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_a_plain_helper_folder_in_a_diskly_folder_is_accepted() {
        let base = std::env::temp_dir().join(format!("diskly-helper-test-{}", std::process::id()));
        let good = base.join("Diskly").join("Data").join("helper");
        std::fs::create_dir_all(&good).unwrap();
        let wrong = base.join("Other").join("Data").join("helper");
        std::fs::create_dir_all(&wrong).unwrap();
        assert!(is_helper_folder(&good));
        assert!(!is_helper_folder(&wrong));
        assert!(!is_helper_folder(Path::new(r"Diskly\Data\helper")));
        assert!(!is_helper_folder(
            &base.join("Diskly").join("Data").join("nope")
        ));

        let target = base.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let linked = base.join("Linked").join("Diskly").join("Data");
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
