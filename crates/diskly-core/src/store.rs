//! Diskly's data folder: history per volume, reports, runs and settings.
//!
//! ```text
//! history/<volume key>/<scan id>.dgs        the snapshot (written first)
//! history/<volume key>/<scan id>.json       its metadata: the commit marker
//! history/<volume key>/<scan id>.files.json file changes against the scan before
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

use crate::scan::ScanSummary;
use crate::volumes::{Volume, VolumeIdentity};

/// Snapshots kept per volume unless the settings say otherwise.
pub const DEFAULT_KEEP: usize = 20;
const META_FORMAT: u32 = 1;

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
    /// `"ask"`, `"fast"` (MFT, needs consent each scan) or `"normal"`.
    pub scan_mode: String,
    /// `"system"`, `"light"` or `"dark"`.
    pub theme: String,
    pub keep_per_volume: usize,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            scan_mode: "ask".into(),
            theme: "system".into(),
            keep_per_volume: DEFAULT_KEEP,
        }
    }
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

/// The data folder.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// `%LOCALAPPDATA%\Diskly`.
    pub fn default_root() -> Option<PathBuf> {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Diskly"))
    }

    pub fn open(root: impl Into<PathBuf>) -> io::Result<Store> {
        let root = root.into();
        fs::create_dir_all(root.join("history"))?;
        fs::create_dir_all(root.join("reports"))?;
        fs::create_dir_all(root.join("runs"))?;
        Ok(Store { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn volume_dir(&self, key: &str) -> PathBuf {
        self.root.join("history").join(key)
    }

    fn snapshot_path(&self, meta: &SnapshotMeta) -> PathBuf {
        self.volume_dir(&meta.volume_key)
            .join(format!("{}.dgs", meta.scan_id))
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
        };
        write_json(&dir.join(format!("{scan_id}.json")), &meta)?;
        Ok(Some(meta))
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
                    && !p.to_string_lossy().ends_with(".files.json")
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

    /// Remove a file of this store. Refuses anything but a plain file of an
    /// expected kind, directly inside a folder of this store.
    fn remove_own_file(&self, path: &Path) -> io::Result<()> {
        let refuse = |why: &str| Err(io::Error::new(io::ErrorKind::InvalidInput, why.to_string()));
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if !(name.ends_with(".dgs") || name.ends_with(".json")) {
            return refuse("not a file of this store");
        }
        let Some(parent) = path.parent() else {
            return refuse("no parent folder");
        };
        let history = fs::canonicalize(self.root.join("history"))?;
        let parent = fs::canonicalize(parent)?;
        if parent.parent() != Some(history.as_path()) {
            return refuse("outside the history folder");
        }
        let info = fs::symlink_metadata(path)?;
        if !info.is_file() {
            return refuse("not a plain file");
        }
        fs::remove_file(path)
    }

    /// Keep the newest `keep` snapshots of a volume. The marker goes first, so
    /// an interruption cannot leave a marker pointing at nothing.
    pub fn prune(&self, key: &str, keep: usize) -> io::Result<usize> {
        let keep = keep.max(2);
        let entries = self.list(key).entries;
        let excess = entries.len().saturating_sub(keep);
        let dir = self.volume_dir(key);
        for meta in entries.iter().take(excess) {
            self.remove_own_file(&dir.join(format!("{}.json", meta.scan_id)))?;
            self.remove_own_file(&dir.join(format!("{}.dgs", meta.scan_id)))?;
            let files = dir.join(format!("{}.files.json", meta.scan_id));
            if files.exists() {
                self.remove_own_file(&files)?;
            }
        }
        Ok(excess)
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

    /// Past runs, newest first. Unreadable ones are left out.
    pub fn list_runs<T: DeserializeOwned>(&self) -> Vec<T> {
        let mut files: Vec<PathBuf> = fs::read_dir(self.root.join("runs"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .collect();
        files.sort();
        files.reverse();
        files.iter().filter_map(|f| read_json(f).ok()).collect()
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
        read_json(&self.root.join("settings.json")).unwrap_or_default()
    }

    pub fn save_settings(&self, settings: &Settings) -> io::Result<()> {
        write_json(&self.root.join("settings.json"), settings)
    }
}
