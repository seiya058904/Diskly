//! Diskly's data folder: history per volume, reports, runs and settings.
//!
//! ```text
//! history/<volume key>/<scan id>.dgs        the snapshot (written first)
//! history/<volume key>/<scan id>.json       its metadata: the commit marker
//! history/<volume key>/<scan id>.files.json file changes against the scan before
//! history/<volume key>/<scan id>.insights.json where the space went
//! records/<volume key>.json                 one small line per scan, kept for years
//! reports/Diskly-<date>.html
//! runs/<scan id>.json                       what happened to every volume
//! settings.json
//! ```
//!
//! A snapshot counts only once its metadata exists, and the metadata is written
//! last and atomically. A crash at any point leaves older history as it was, at
//! worst with an unused file next to it. The metadata holds a hash of the
//! snapshot, so a damaged one is noticed and skipped.
//!
//! Diskly must never become a burden on the disks it looks at, however often it is
//! used. Full snapshots and reports are kept for the last few scans only, the small
//! records get sparser with age, and everything together stays under
//! [`TOTAL_LIMIT`], counting the program itself (see [`Store::enforce`]).
//!
//! This is the only module that removes files, and only its own (see
//! [`Store::remove_own_file`]).

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use diskghost_core::Snapshot;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use windows_sys::Win32::System::SystemInformation::GetLocalTime;

use crate::insights::Insights;
use crate::scan::ScanSummary;
use crate::volumes::{Volume, VolumeIdentity};

/// All of Diskly on disk: the program, its window's cache and its data.
pub const TOTAL_LIMIT: u64 = 50 * 1024 * 1024;
/// Full snapshots kept per volume. Fewer if they do not fit.
pub const KEEP_SNAPSHOTS: usize = 3;
/// Reports kept. A report whose file is gone is made again when it is opened.
pub const KEEP_REPORTS: usize = 3;
/// Entries in the window's history list.
pub const KEEP_RUNS: usize = 50;
/// All volumes' records together. One volume's stay under this by themselves, so
/// this only matters after dozens of disks or formats, whose oldest records go first.
const RECORDS_LIMIT: u64 = 4 * 1024 * 1024;
/// Records kept per volume, at most: see [`thin_records`].
pub const KEEP_RECORDS: usize = 400;
/// The window's WebView2 cache is cleared at startup above this.
pub const WEBVIEW_LIMIT: u64 = 6 * 1024 * 1024;
/// Room left for file system overhead below [`TOTAL_LIMIT`].
const MARGIN: u64 = 1024 * 1024;
/// Never less than this for data, or there would be no point in scanning.
const MIN_BUDGET: u64 = 8 * 1024 * 1024;
/// What a crash left behind is removed after this. Younger files may be in use.
const LEFTOVER_AGE: std::time::Duration = std::time::Duration::from_secs(3600);
const META_FORMAT: u32 = 1;
const DAY: u64 = 86_400;

/// What is known about one stored snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotMeta {
    pub format: u32,
    pub scan_id: String,
    pub taken_at: u64,
    pub volume_key: String,
    pub identity: VolumeIdentity,
    pub letter: char,
    pub label: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub summary: ScanSummary,
    /// BLAKE3 of the snapshot file, in hex.
    pub hash: String,
    pub stored_bytes: u64,
    /// Its files were dropped to save space: it still compares at folder level.
    #[serde(default)]
    pub folders_only: bool,
}

impl SnapshotMeta {
    pub fn used_bytes(&self) -> u64 {
        self.total_bytes.saturating_sub(self.free_bytes)
    }
}

/// The history of one volume, oldest first.
#[derive(Debug, Default)]
pub struct Listing {
    pub entries: Vec<SnapshotMeta>,
    /// What had to be skipped, in plain words.
    pub issues: Vec<String>,
}

/// The few things a user can choose.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// `"fast"` (MFT, needs consent each scan) or `"normal"`.
    pub scan_mode: String,
    /// `"dark"`, `"light"` or `"system"`.
    pub theme: String,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            scan_mode: "fast".into(),
            theme: "dark".into(),
        }
    }
}

/// One small line about a scan, kept long after its snapshot is gone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanRecord {
    pub id: String,
    pub at: u64,
    pub letter: char,
    pub engine: String,
    pub total: u64,
    pub free: u64,
    pub files: u64,
    pub dirs: u64,
    /// The top-level folders, for long-term comparison between scans of one engine.
    #[serde(default)]
    pub top: Vec<(String, u64)>,
    /// A format changes it, and the folders of another format are other folders.
    /// Missing from records made before this was kept.
    #[serde(default)]
    pub serial: Option<u32>,
    /// Those of `top` with something inside that could not be read, so that their
    /// size is unknown. `None` in records made before this was kept.
    #[serde(default)]
    pub unread_top: Option<Vec<String>>,
}

impl ScanRecord {
    /// Its top-level folders can be compared over the long term at all.
    pub fn knows_its_folders(&self) -> bool {
        !self.top.is_empty() && self.serial.is_some() && self.unread_top.is_some()
    }
}

/// The record the newest one is compared with over the long term: the oldest of
/// the same file system and engine. `report/lib.js` picks the same one.
pub fn long_term_base(records: &[ScanRecord]) -> Option<usize> {
    let newest = records.last().filter(|r| r.knows_its_folders())?;
    records.iter().position(|r| {
        r.knows_its_folders() && r.engine == newest.engine && r.serial == newest.serial
    })
}

/// Which of `top` hold a folder that could not be read.
fn unread_among(top: &[(String, u64)], unread_dirs: &[String]) -> Vec<String> {
    top.iter()
        .map(|(name, _)| name)
        .filter(|name| {
            unread_dirs.iter().any(|dir| {
                dir.split('\\')
                    .next()
                    .is_some_and(|first| first.eq_ignore_ascii_case(name))
            })
        })
        .cloned()
        .collect()
}

/// Fewer records the older they are: all of the last 20, then one per hour for a
/// day, per six hours for a month, per day for half a year, per week for two years
/// and per month after that. That is under 400 lines for the first 2 years, or a
/// few hundred kilobytes, however often a disk is scanned.
pub fn thin_records(records: &mut Vec<ScanRecord>, now: u64) {
    records.sort_by(|a, b| (a.at, &a.id).cmp(&(b.at, &b.id)));
    records.dedup_by(|later, earlier| later.id == earlier.id);
    let mut kept: Vec<ScanRecord> = Vec::with_capacity(records.len().min(KEEP_RECORDS));
    let mut newer_at = u64::MAX;
    for (place, record) in records.drain(..).rev().enumerate() {
        let age = now.saturating_sub(record.at);
        let gap = if place < 20 {
            0
        } else if age < DAY {
            DAY / 24
        } else if age < 30 * DAY {
            DAY / 4
        } else if age < 180 * DAY {
            DAY
        } else if age < 730 * DAY {
            7 * DAY
        } else {
            30 * DAY
        };
        if newer_at == u64::MAX || newer_at.saturating_sub(record.at) >= gap {
            newer_at = record.at;
            kept.push(record);
        }
    }
    kept.truncate(KEEP_RECORDS);
    kept.reverse();
    *records = kept;
}

/// All of Diskly on disk right now.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Footprint {
    pub limit: u64,
    pub program: u64,
    pub webview: u64,
    pub snapshots: u64,
    pub reports: u64,
    pub records: u64,
    pub other: u64,
    pub total: u64,
    pub scans_kept: usize,
    pub reports_kept: usize,
    pub records_kept: usize,
    pub keep_snapshots: usize,
    pub keep_reports: usize,
}

/// Bytes of the files below `path`, not following links.
pub fn folder_size(path: &Path) -> u64 {
    let mut total = 0;
    for entry in fs::read_dir(path).into_iter().flatten().flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            total += folder_size(&entry.path());
        } else if let Ok(meta) = entry.metadata() {
            total += meta.len();
        }
    }
    total
}

/// The program and what the installer put next to it.
pub fn program_size() -> u64 {
    let Ok(exe) = std::env::current_exe() else {
        return 0;
    };
    let size = |p: &Path| fs::metadata(p).map_or(0, |m| m.len());
    size(&exe)
        + exe
            .parent()
            .map_or(0, |dir| size(&dir.join("uninstall.exe")))
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A new scan id. Ids of later scans sort after earlier ones.
pub fn new_scan_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:012}-{:08x}", now_unix(), nanos ^ std::process::id())
}

/// The scan a file in a history folder belongs to, from its name.
fn scan_id_of(file_name: &str) -> &str {
    file_name.split('.').next().unwrap_or(file_name)
}

/// Scan ids become file names: only allow what `new_scan_id` makes.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Write `bytes` so a reader sees the old file or the whole new one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{:08x}.tmp", std::process::id()));
    let temp = path.with_file_name(name);
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&temp, path)
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    write_atomic(path, &bytes)
}

/// The one place Diskly removes a file. Refuses anything that is not a plain file.
fn remove_plain_file(path: &Path) -> io::Result<()> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a plain file",
        ));
    }
    fs::remove_file(path)
}

/// Used by the elevated helper: remove what it wrote into its private folder, by
/// kind of file, directly inside that folder. Call while the folder is locked.
pub fn remove_session_files(session: &Path) {
    for entry in fs::read_dir(session).into_iter().flatten().flatten() {
        let path = entry.path();
        let ours = path
            .extension()
            .is_some_and(|e| e == "dgs" || e == "json" || e == "tmp");
        if ours {
            let _ = remove_plain_file(&path);
        }
    }
}

/// Used by the elevated helper: remove its emptied private folder. This removes
/// one empty folder, and removes a link rather than following it.
pub fn remove_session_folder(session: &Path) {
    let _ = fs::remove_dir(session);
}

/// Clear a WebView2 data folder, which holds caches of the window and nothing else.
/// Refuses any folder by another name, and leaves links alone. What is in use stays.
pub fn clear_webview_folder(dir: &Path) {
    let ours = dir
        .file_name()
        .is_some_and(|name| name == "WebView" || name == "EBWebView");
    if !ours {
        return;
    }
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            clear_webview_tree(&path);
            remove_session_folder(&path);
        } else {
            let _ = remove_plain_file(&path);
        }
    }
}

fn clear_webview_tree(dir: &Path) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            clear_webview_tree(&path);
            remove_session_folder(&path);
        } else {
            let _ = remove_plain_file(&path);
        }
    }
}

/// The data folder.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// `%LOCALAPPDATA%\Diskly\Data`. The installer puts the program in the folder
    /// above, and an uninstall leaves this one alone.
    pub fn default_root() -> Option<PathBuf> {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Diskly").join("Data"))
    }

    pub fn open(root: impl Into<PathBuf>) -> io::Result<Store> {
        let root = root.into();
        fs::create_dir_all(root.join("history"))?;
        fs::create_dir_all(root.join("reports"))?;
        fs::create_dir_all(root.join("runs"))?;
        fs::create_dir_all(root.join("records"))?;
        Ok(Store { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The window's WebView2 cache, next to the data.
    pub fn webview_dir(&self) -> PathBuf {
        self.root
            .parent()
            .map_or_else(|| self.root.join("WebView"), |p| p.join("WebView"))
    }

    fn volume_dir(&self, key: &str) -> PathBuf {
        self.root.join("history").join(key)
    }

    fn snapshot_path(&self, meta: &SnapshotMeta) -> PathBuf {
        let kind = if meta.folders_only { "dirs.dgs" } else { "dgs" };
        self.volume_dir(&meta.volume_key)
            .join(format!("{}.{kind}", meta.scan_id))
    }

    /// Store a finished scan. Returns `Ok(None)` for a volume with no identity,
    /// which cannot be told apart from another one later.
    pub fn commit(
        &self,
        scan_id: &str,
        taken_at: u64,
        volume: &Volume,
        summary: &ScanSummary,
        snapshot: &Snapshot,
    ) -> io::Result<Option<SnapshotMeta>> {
        let Some(key) = volume.identity.key() else {
            return Ok(None);
        };
        if !valid_id(scan_id) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "bad scan id"));
        }
        let dir = self.volume_dir(&key);
        fs::create_dir_all(&dir)?;
        let file = dir.join(format!("{scan_id}.dgs"));
        snapshot.save(&file).map_err(io::Error::other)?;
        // The core renames its file into place; make it durable before it counts.
        fs::OpenOptions::new().write(true).open(&file)?.sync_all()?;
        let bytes = fs::read(&file)?;
        let meta = SnapshotMeta {
            format: META_FORMAT,
            scan_id: scan_id.to_string(),
            taken_at,
            volume_key: key,
            identity: volume.identity.clone(),
            letter: volume.letter,
            label: volume.label.clone(),
            total_bytes: volume.total_bytes,
            free_bytes: volume.free_bytes,
            summary: summary.clone(),
            hash: blake3::hash(&bytes).to_hex().to_string(),
            stored_bytes: bytes.len() as u64,
            folders_only: false,
        };
        write_json(&dir.join(format!("{scan_id}.json")), &meta)?;
        Ok(Some(meta))
    }

    /// Only the newest scan needs its files, to list what changed in the next one.
    /// An older scan keeps just its folders, which is about a fifth of the size and
    /// all that comparing it needs. The newest of each engine stays whole, since a
    /// scan is only compared file by file with one of its own engine.
    ///
    /// The smaller file is made before the marker changes, and the larger one goes
    /// last, so at every moment the marker points at a good file.
    pub fn slim_older_scans(&self, key: &str) -> Result<(), String> {
        let entries = self.list(key).entries;
        let mut engines = std::collections::HashSet::new();
        for meta in entries.iter().rev() {
            let newest_of_engine = engines.insert(meta.summary.engine.clone());
            if newest_of_engine || meta.folders_only {
                continue;
            }
            let whole = self.snapshot_path(meta);
            let slim = self.load(meta)?.folders_only().map_err(|e| e.to_string())?;
            let mut slimmed = meta.clone();
            slimmed.folders_only = true;
            let file = self.snapshot_path(&slimmed);
            slim.save(&file).map_err(|e| e.to_string())?;
            let bytes = fs::read(&file).map_err(|e| e.to_string())?;
            slimmed.hash = blake3::hash(&bytes).to_hex().to_string();
            slimmed.stored_bytes = bytes.len() as u64;
            let marker = self.volume_dir(key).join(format!("{}.json", meta.scan_id));
            write_json(&marker, &slimmed).map_err(|e| e.to_string())?;
            self.remove_own_file(&whole).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Every volume that has a history.
    pub fn volume_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = fs::read_dir(self.root.join("history"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        keys.sort();
        keys
    }

    /// The committed snapshots of a volume, oldest first. Anything unreadable is
    /// reported and skipped, never treated as an empty scan.
    pub fn list(&self, key: &str) -> Listing {
        let mut listing = Listing::default();
        let mut files: Vec<PathBuf> = fs::read_dir(self.volume_dir(key))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension().is_some_and(|e| e == "json")
                    && p.file_stem()
                        .is_some_and(|stem| !stem.to_string_lossy().contains('.'))
            })
            .collect();
        files.sort();
        for file in files {
            match read_json::<SnapshotMeta>(&file) {
                Ok(meta) if meta.format == META_FORMAT && self.snapshot_path(&meta).exists() => {
                    listing.entries.push(meta);
                }
                Ok(meta) if meta.format == META_FORMAT => listing
                    .issues
                    .push(format!("扫描 {} 的快照文件不见了，已跳过", meta.scan_id)),
                Ok(meta) => listing.issues.push(format!(
                    "扫描 {} 的格式 {} 无法识别，已跳过",
                    meta.scan_id, meta.format
                )),
                Err(e) => listing.issues.push(format!(
                    "无法读取 {}：{e}，已跳过",
                    file.file_name().unwrap_or_default().to_string_lossy()
                )),
            }
        }
        listing
            .entries
            .sort_by(|a, b| (a.taken_at, &a.scan_id).cmp(&(b.taken_at, &b.scan_id)));
        listing
    }

    /// Load a snapshot, checking that it is the file that was stored.
    pub fn load(&self, meta: &SnapshotMeta) -> Result<Snapshot, String> {
        let path = self.snapshot_path(meta);
        let bytes = fs::read(&path).map_err(|e| format!("无法读取快照：{e}"))?;
        if blake3::hash(&bytes).to_hex().as_str() != meta.hash {
            return Err("快照内容与记录不一致，文件可能已损坏".to_string());
        }
        Snapshot::load(&path).map_err(|e| format!("无法解析快照：{e}"))
    }

    /// Where an elevated helper leaves its results.
    pub fn helper_dir(&self) -> PathBuf {
        self.root.join("helper")
    }

    /// Remove the markers of a helper session, by their exact names. The helper
    /// cleans its own folder, which this process may only read.
    pub fn clear_helper_files(&self, token: &str) {
        if !valid_id(token) {
            return;
        }
        let dir = self.helper_dir();
        for what in ["alive", "cancel", "collected"] {
            let path = dir.join(format!("{token}-{what}.json"));
            if path.exists() {
                let _ = self.remove_own_file(&path);
            }
        }
    }

    /// Remove what a helper session left behind if the app crashed during it.
    /// Younger files may belong to a helper that is still running.
    pub fn clear_stale_helper_files(&self, older_than: std::time::Duration) {
        let entries = fs::read_dir(self.helper_dir())
            .into_iter()
            .flatten()
            .flatten();
        for entry in entries {
            let age = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok());
            if age.is_some_and(|a| a > older_than) {
                let _ = self.remove_own_file(&entry.path());
            }
        }
    }

    /// Remove a file of this store. Refuses anything but a plain file of an
    /// expected kind, directly in a volume's history folder or one of the store's
    /// own folders.
    fn remove_own_file(&self, path: &Path) -> io::Result<()> {
        let refuse = |why: &str| Err(io::Error::new(io::ErrorKind::InvalidInput, why.to_string()));
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let kind_ok = [".dgs", ".json", ".html", ".tmp"]
            .iter()
            .any(|kind| name.ends_with(kind));
        if !kind_ok {
            return refuse("not a file of this store");
        }
        let Some(parent) = path.parent() else {
            return refuse("no parent folder");
        };
        let history = fs::canonicalize(self.root.join("history"))?;
        let parent = fs::canonicalize(parent)?;
        let in_history = parent.parent() == Some(history.as_path());
        let in_folder = |dir: PathBuf| fs::canonicalize(dir).is_ok_and(|d| d == parent);
        let in_own_folder = in_folder(self.helper_dir())
            || in_folder(self.root.join("reports"))
            || in_folder(self.root.join("runs"))
            || in_folder(self.root.join("records"));
        if !in_history && !in_own_folder {
            return refuse("outside the folders of this store");
        }
        remove_plain_file(path)
    }

    /// Forget one scan's snapshot and what goes with it. The marker goes first, so
    /// an interruption cannot leave a marker pointing at nothing.
    fn drop_scan(&self, meta: &SnapshotMeta) -> io::Result<()> {
        let dir = self.volume_dir(&meta.volume_key);
        self.remove_own_file(&dir.join(format!("{}.json", meta.scan_id)))?;
        for part in ["dgs", "dirs.dgs", "files.json", "insights.json"] {
            let file = dir.join(format!("{}.{part}", meta.scan_id));
            if file.exists() {
                self.remove_own_file(&file)?;
            }
        }
        Ok(())
    }

    /// Keep the newest `keep` snapshots of a volume.
    pub fn prune(&self, key: &str, keep: usize) -> io::Result<usize> {
        let keep = keep.max(2);
        let entries = self.list(key).entries;
        let excess = entries.len().saturating_sub(keep);
        for meta in entries.iter().take(excess) {
            self.drop_scan(meta)?;
        }
        Ok(excess)
    }

    /// Every report file, oldest first.
    fn report_files(&self) -> Vec<PathBuf> {
        let mut files: Vec<(SystemTime, PathBuf)> = fs::read_dir(self.root.join("reports"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "html"))
            .map(|p| {
                let at = fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .unwrap_or(UNIX_EPOCH);
                (at, p)
            })
            .collect();
        files.sort();
        files.into_iter().map(|(_, p)| p).collect()
    }

    /// Remove what a crash left: temporary files, and parts of a scan whose marker
    /// never came. Younger files may belong to a scan that is running now.
    fn sweep_leftovers(&self) {
        let old = |path: &Path| {
            fs::metadata(path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age > LEFTOVER_AGE)
        };
        let mut folders: Vec<PathBuf> = vec![
            self.root.join("reports"),
            self.root.join("runs"),
            self.root.join("records"),
        ];
        folders.extend(self.volume_keys().iter().map(|k| self.volume_dir(k)));
        for folder in folders {
            for entry in fs::read_dir(&folder).into_iter().flatten().flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                let unused = name.ends_with(".tmp")
                    || (folder.parent() == Some(self.root.join("history").as_path())
                        && !path
                            .with_file_name(format!("{}.json", scan_id_of(&name)))
                            .exists());
                if unused && old(&path) {
                    let _ = self.remove_own_file(&path);
                }
            }
        }
    }

    /// What the program, its window's cache and the data together may not exceed
    /// leaves this for data. The cache counts at its limit, since it can grow that far.
    pub fn data_budget(&self) -> u64 {
        let others = program_size() + WEBVIEW_LIMIT.max(folder_size(&self.webview_dir())) + MARGIN;
        TOTAL_LIMIT.saturating_sub(others).max(MIN_BUDGET)
    }

    /// Before a scan: leave room for about what the last one took, so that the data
    /// stays under its budget while the new scan is written. The newest scan of each
    /// volume stays, since the next one is compared with it.
    pub fn make_room(&self) {
        let budget = self.data_budget();
        let mut expected = self
            .report_files()
            .last()
            .and_then(|p| fs::metadata(p).ok())
            .map_or(0, |m| m.len());
        for key in self.volume_keys() {
            if let Some(newest) = self.list(&key).entries.last() {
                expected += newest.stored_bytes;
            }
        }
        self.trim(budget.saturating_sub(expected), true);
    }

    /// Bring the data within `budget`: first by the fixed limits, then by removing
    /// what matters least, oldest first. A report can be made again, so reports go
    /// first. Then snapshots, down to the newest of each volume, which is what the
    /// next scan is compared with. Only a disk so large that its newest snapshot
    /// alone does not fit loses that too: it keeps its records and its reports, and
    /// the report says what cannot be compared.
    pub fn enforce(&self, budget: u64) {
        self.trim(budget, false);
    }

    fn trim(&self, budget: u64, keep_newest: bool) {
        self.sweep_leftovers();
        for key in self.volume_keys() {
            let _ = self.prune(&key, KEEP_SNAPSHOTS);
        }
        let reports = self.report_files();
        let surplus = reports.len().saturating_sub(KEEP_REPORTS);
        for report in &reports[..surplus] {
            let _ = self.remove_own_file(report);
        }
        let runs = self.run_files();
        let surplus = runs.len().saturating_sub(KEEP_RUNS);
        for run in &runs[runs.len() - surplus..] {
            let _ = self.remove_own_file(run);
        }
        self.trim_records();
        // A disk with no scans left has an empty folder, which this removes. A folder
        // with anything in it stays.
        for key in self.volume_keys() {
            if self.list(&key).entries.is_empty() {
                remove_session_folder(&self.volume_dir(&key));
            }
        }

        while folder_size(&self.root) > budget {
            let reports = self.report_files();
            if reports.len() > 1 {
                if self.remove_own_file(&reports[0]).is_err() {
                    break;
                }
                continue;
            }
            let mut scans: Vec<(SnapshotMeta, usize)> = Vec::new();
            for key in self.volume_keys() {
                let entries = self.list(&key).entries;
                let count = entries.len();
                scans.extend(entries.into_iter().map(|m| (m, count)));
            }
            scans.sort_by_key(|(m, _)| m.taken_at);
            let older = scans.iter().find(|(_, count)| *count > 1);
            let victim = match older {
                Some((meta, _)) => Some(meta),
                None if keep_newest => None,
                None => scans.first().map(|(meta, _)| meta),
            };
            let removed = match victim {
                Some(meta) => self.drop_scan(meta).is_ok(),
                None if keep_newest => false,
                None => reports
                    .first()
                    .is_some_and(|r| self.remove_own_file(r).is_ok()),
            };
            if !removed {
                break;
            }
        }
    }

    /// The records of the disks not seen for the longest time make way, if there are
    /// so many disks that they add up. The most recent stay in any case.
    fn trim_records(&self) {
        let mut files: Vec<(SystemTime, u64, PathBuf)> = fs::read_dir(self.root.join("records"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                Some((meta.modified().ok()?, meta.len(), entry.path()))
            })
            .filter(|(_, _, path)| path.extension().is_some_and(|e| e == "json"))
            .collect();
        files.sort();
        let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
        files.pop();
        for (_, size, path) in files {
            if total <= RECORDS_LIMIT {
                break;
            }
            if self.remove_own_file(&path).is_ok() {
                total -= size;
            }
        }
    }

    /// All of Diskly on disk.
    pub fn footprint(&self) -> Footprint {
        let mut scans_kept = 0;
        let mut snapshots = 0;
        for key in self.volume_keys() {
            let listing = self.list(&key).entries;
            scans_kept += listing.len();
            snapshots += folder_size(&self.volume_dir(&key));
        }
        let reports = folder_size(&self.root.join("reports"));
        let records = folder_size(&self.root.join("records"));
        let data = folder_size(&self.root);
        let program = program_size();
        let webview = folder_size(&self.webview_dir());
        Footprint {
            limit: TOTAL_LIMIT,
            program,
            webview,
            snapshots,
            reports,
            records,
            other: data.saturating_sub(snapshots + reports + records),
            total: program + webview + data,
            scans_kept,
            reports_kept: self.report_files().len(),
            records_kept: self
                .volume_keys()
                .iter()
                .map(|k| self.load_records(k).len())
                .sum(),
            keep_snapshots: KEEP_SNAPSHOTS,
            keep_reports: KEEP_REPORTS,
        }
    }

    pub fn load_records(&self, key: &str) -> Vec<ScanRecord> {
        if !valid_id(key) {
            return Vec::new();
        }
        read_json(&self.root.join("records").join(format!("{key}.json"))).unwrap_or_default()
    }

    /// Note a finished scan, and any scan still stored that has no record yet.
    pub fn record_scan(&self, meta: &SnapshotMeta, insights: Option<&Insights>) -> io::Result<()> {
        let key = &meta.volume_key;
        if !valid_id(key) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "bad volume key",
            ));
        }
        let line = |m: &SnapshotMeta, top: Vec<(String, u64)>| ScanRecord {
            id: m.scan_id.clone(),
            at: m.taken_at,
            letter: m.letter,
            engine: m.summary.engine.clone(),
            total: m.total_bytes,
            free: m.free_bytes,
            files: m.summary.files,
            dirs: m.summary.dirs,
            serial: m.identity.serial,
            unread_top: Some(unread_among(&top, &m.summary.unread_dirs)),
            top,
        };
        let mut records = self.load_records(key);
        for stored in self.list(key).entries {
            if stored.scan_id != meta.scan_id && !records.iter().any(|r| r.id == stored.scan_id) {
                records.push(line(&stored, Vec::new()));
            }
        }
        let top = insights.map_or_else(Vec::new, |i| i.top_folders.clone());
        records.push(line(meta, top));
        thin_records(&mut records, now_unix());
        write_json(
            &self.root.join("records").join(format!("{key}.json")),
            &records,
        )
    }

    pub fn save_insights(&self, meta: &SnapshotMeta, insights: &Insights) -> io::Result<()> {
        write_json(
            &self
                .volume_dir(&meta.volume_key)
                .join(format!("{}.insights.json", meta.scan_id)),
            insights,
        )
    }

    pub fn load_insights(&self, meta: &SnapshotMeta) -> Option<Insights> {
        read_json(
            &self
                .volume_dir(&meta.volume_key)
                .join(format!("{}.insights.json", meta.scan_id)),
        )
        .ok()
    }

    pub fn save_file_changes<T: Serialize>(
        &self,
        meta: &SnapshotMeta,
        changes: &T,
    ) -> io::Result<()> {
        write_json(
            &self
                .volume_dir(&meta.volume_key)
                .join(format!("{}.files.json", meta.scan_id)),
            changes,
        )
    }

    pub fn load_file_changes<T: DeserializeOwned>(&self, meta: &SnapshotMeta) -> Option<T> {
        read_json(
            &self
                .volume_dir(&meta.volume_key)
                .join(format!("{}.files.json", meta.scan_id)),
        )
        .ok()
    }

    pub fn save_run<T: Serialize>(&self, scan_id: &str, run: &T) -> io::Result<()> {
        if !valid_id(scan_id) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "bad scan id"));
        }
        write_json(&self.root.join("runs").join(format!("{scan_id}.json")), run)
    }

    /// Run records, newest first.
    fn run_files(&self) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = fs::read_dir(self.root.join("runs"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .collect();
        files.sort();
        files.reverse();
        files
    }

    /// Past runs, newest first. Unreadable ones are left out.
    pub fn list_runs<T: DeserializeOwned>(&self) -> Vec<T> {
        self.run_files()
            .iter()
            .filter_map(|f| read_json(f).ok())
            .collect()
    }

    /// Write a report, named after the local time. Returns its path.
    pub fn write_report(&self, html: &str) -> io::Result<PathBuf> {
        // SAFETY: an all-zero SYSTEMTIME is valid, and GetLocalTime fills it in.
        let now = unsafe {
            let mut t = std::mem::zeroed();
            GetLocalTime(&mut t);
            t
        };
        let stem = format!(
            "Diskly-{:04}-{:02}-{:02}-{:02}{:02}{:02}",
            now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond
        );
        let dir = self.root.join("reports");
        let mut path = dir.join(format!("{stem}.html"));
        let mut n = 2;
        while path.exists() {
            path = dir.join(format!("{stem}-{n}.html"));
            n += 1;
        }
        write_atomic(&path, html.as_bytes())?;
        Ok(path)
    }

    /// The path of a report named in a run, if it is really one of ours.
    pub fn report_path(&self, file_name: &str) -> Option<PathBuf> {
        let name = Path::new(file_name).file_name()?;
        if name != std::ffi::OsStr::new(file_name)
            || !file_name.starts_with("Diskly-")
            || !file_name.ends_with(".html")
        {
            return None;
        }
        let path = self.root.join("reports").join(name);
        path.is_file().then_some(path)
    }

    pub fn load_settings(&self) -> Settings {
        let mut settings: Settings =
            read_json(&self.root.join("settings.json")).unwrap_or_default();
        // There used to be a choice on the first scan. The fastest way is the default now.
        if settings.scan_mode == "ask" {
            settings.scan_mode = "fast".into();
        }
        settings
    }

    pub fn save_settings(&self, settings: &Settings) -> io::Result<()> {
        write_json(&self.root.join("settings.json"), settings)
    }
}
