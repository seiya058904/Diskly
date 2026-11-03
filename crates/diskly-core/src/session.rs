//! From finished scans to stored history and a report.

use std::collections::BTreeMap;
use std::path::PathBuf;

use diskghost_core::Snapshot;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::compare::{self, FileChanges, NodeTable, PairStatus};
use crate::insights::{self, Insights};
use crate::report;
use crate::scan::{ScanStatus, ScanSummary};
use crate::store::{now_unix, Footprint, ScanRecord, SnapshotMeta, Store, KEEP_REPORTS};
use crate::volumes::Volume;

/// Folders shown in one report, shared among its volumes, so that it stays small
/// however many disks there are.
const REPORT_NODES: usize = 30_000;
/// But never fewer than this for a volume.
const VOLUME_NODES: usize = 4_000;

/// What a scan of one volume produced.
pub struct VolumeResult {
    pub volume: Volume,
    pub summary: ScanSummary,
    pub snapshot: Option<Snapshot>,
}

/// What happened to one volume in a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunVolume {
    pub letter: char,
    pub label: String,
    pub volume_key: Option<String>,
    pub status: ScanStatus,
    pub engine: String,
    pub mft_fallback: Option<String>,
    pub seconds: f64,
    pub files: u64,
    pub bytes: u64,
    pub error: Option<String>,
    /// Stored as a scan that later ones can be compared with.
    pub stored: bool,
}

/// One click on Scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub scan_id: String,
    pub started_at: u64,
    pub finished_at: u64,
    pub seconds: f64,
    /// Administrator rights were asked for and not given.
    pub consent_declined: bool,
    pub volumes: Vec<RunVolume>,
    pub report_file: Option<String>,
    pub issues: Vec<String>,
}

/// Store what finished, leaving history alone for what did not.
pub fn commit_run(
    store: &Store,
    scan_id: &str,
    started_at: u64,
    seconds: f64,
    consent_declined: bool,
    results: Vec<VolumeResult>,
    keep: usize,
) -> RunRecord {
    let mut issues = Vec::new();
    let mut volumes = Vec::with_capacity(results.len());
    for result in results {
        let VolumeResult {
            volume,
            mut summary,
            snapshot,
        } = result;
        let insights = summary.insights.take();
        let mut error = summary.error.clone();
        let mut stored = false;
        if let (ScanStatus::Complete, Some(snapshot)) = (summary.status, &snapshot) {
            match store.commit(scan_id, started_at, &volume, &summary, snapshot) {
                Ok(Some(meta)) => {
                    stored = true;
                    if let Some(changes) = changes_against_previous(store, &meta, snapshot) {
                        if let Err(e) = store.save_file_changes(&meta, &changes) {
                            issues.push(format!("{}: 无法保存文件变化：{e}", volume.letter));
                        }
                    }
                    if let Some(insights) = &insights {
                        if let Err(e) = store.save_insights(&meta, insights) {
                            issues.push(format!("{}: 无法保存占用分析：{e}", volume.letter));
                        }
                    }
                    if let Err(e) = store.record_scan(&meta, insights.as_ref()) {
                        issues.push(format!("{}: 无法保存扫描记录：{e}", volume.letter));
                    }
                    if let Err(e) = store.prune(&meta.volume_key, keep) {
                        issues.push(format!("{}: 无法清理旧快照：{e}", volume.letter));
                    }
                    if let Err(e) = store.slim_older_scans(&meta.volume_key) {
                        issues.push(format!("{}: 无法压缩旧快照：{e}", volume.letter));
                    }
                }
                Ok(None) => {
                    error = Some("无法识别这个卷的身份，本次结果不会保存为历史".to_string());
                }
                Err(e) => {
                    error = Some(format!("无法保存快照：{e}"));
                }
            }
        }
        volumes.push(RunVolume {
            letter: volume.letter,
            label: volume.label.clone(),
            volume_key: volume.identity.key(),
            status: summary.status,
            engine: summary.engine.clone(),
            mft_fallback: summary.mft_fallback.clone(),
            seconds: summary.seconds,
            files: summary.files,
            bytes: summary.bytes,
            error,
            stored,
        });
    }
    let run = RunRecord {
        scan_id: scan_id.to_string(),
        started_at,
        finished_at: now_unix(),
        seconds,
        consent_declined,
        volumes,
        report_file: None,
        issues,
    };
    if let Err(e) = store.save_run(scan_id, &run) {
        let mut run = run;
        run.issues.push(format!("无法保存本次记录：{e}"));
        return run;
    }
    run
}

/// File changes against the newest earlier scan that can be compared at all.
fn changes_against_previous(
    store: &Store,
    meta: &SnapshotMeta,
    snapshot: &Snapshot,
) -> Option<FileChanges> {
    let listing = store.list(&meta.volume_key);
    let previous = listing
        .entries
        .iter()
        .rev()
        .filter(|m| m.scan_id != meta.scan_id && !m.folders_only)
        .find(|m| compare::pair_status(m, meta) == PairStatus::Comparable)?;
    let old = store.load(previous).ok()?;
    Some(compare::file_changes(previous, &old, meta, snapshot))
}

/// One stored scan, as the report sees it.
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotView {
    pub id: String,
    pub taken_at: u64,
    pub letter: char,
    pub label: String,
    pub engine: String,
    pub elevated: bool,
    pub seconds: f64,
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub serial: Option<u32>,
    pub guid: Option<String>,
    pub file_system: Option<String>,
    pub unread_count: usize,
    pub skipped_elsewhere: u64,
    pub mft_fallback: Option<String>,
}

impl From<&SnapshotMeta> for SnapshotView {
    fn from(m: &SnapshotMeta) -> SnapshotView {
        SnapshotView {
            id: m.scan_id.clone(),
            taken_at: m.taken_at,
            letter: m.letter,
            label: m.label.clone(),
            engine: m.summary.engine.clone(),
            elevated: m.summary.elevated,
            seconds: m.summary.seconds,
            files: m.summary.files,
            dirs: m.summary.dirs,
            bytes: m.summary.bytes,
            total_bytes: m.total_bytes,
            free_bytes: m.free_bytes,
            serial: m.identity.serial,
            guid: m.identity.guid.clone(),
            file_system: m.identity.file_system.clone(),
            unread_count: m.summary.unread_dirs.len(),
            skipped_elsewhere: m.summary.skipped_elsewhere(),
            mft_fallback: m.summary.mft_fallback.clone(),
        }
    }
}

/// One volume in a report.
#[derive(Debug, Clone, Serialize)]
pub struct VolumeReport {
    pub key: Option<String>,
    pub letter: char,
    pub label: String,
    /// Mounted on this machine right now.
    pub connected: bool,
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    /// What happened to it in this run; null if it was not part of it.
    pub this_run: Option<RunVolume>,
    pub snapshots: Vec<SnapshotView>,
    pub table: NodeTable,
    /// File changes by the newer scan's id.
    pub file_changes: BTreeMap<String, FileChanges>,
    /// Where the space went, by scan id.
    pub insights: BTreeMap<String, Insights>,
    /// The long history, oldest first. Most of it has no snapshot any more.
    pub records: Vec<ScanRecord>,
    pub issues: Vec<String>,
}

/// All a report shows.
#[derive(Debug, Clone, Serialize)]
pub struct ReportData {
    pub format: u32,
    pub app_version: &'static str,
    pub generated_at: u64,
    /// The look chosen in the window, until the page is told otherwise.
    pub theme: String,
    pub footprint: Footprint,
    pub run: Option<RunRecord>,
    pub volumes: Vec<VolumeReport>,
}

/// Load a volume's history, leaving out and reporting whatever is damaged.
fn load_history(
    store: &Store,
    key: &str,
    issues: &mut Vec<String>,
) -> Vec<(SnapshotMeta, Snapshot)> {
    let listing = store.list(key);
    issues.extend(listing.issues);
    let loaded: Vec<(SnapshotMeta, Result<Snapshot, String>)> = listing
        .entries
        .into_par_iter()
        .map(|meta| {
            let snapshot = store.load(&meta);
            (meta, snapshot)
        })
        .collect();
    let mut history = Vec::with_capacity(loaded.len());
    for (meta, snapshot) in loaded {
        match snapshot {
            Ok(snapshot) => history.push((meta, snapshot)),
            Err(e) => issues.push(format!("已跳过扫描 {}：{e}", meta.scan_id)),
        }
    }
    history
}

/// Everything the report needs, from the store and what is mounted now.
pub fn report_data(store: &Store, run: Option<&RunRecord>, connected: &[Volume]) -> ReportData {
    let mut keys = store.volume_keys();
    for volume in connected {
        if let Some(key) = volume.identity.key() {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    let node_limit = (REPORT_NODES / keys.len().max(1)).clamp(VOLUME_NODES, compare::NODE_LIMIT);
    let mut volumes: Vec<VolumeReport> = keys
        .iter()
        .map(|key| {
            let mut issues = Vec::new();
            let history = load_history(store, key, &mut issues);
            let live = connected
                .iter()
                .find(|v| v.identity.key().as_deref() == Some(key));
            let last = history.last().map(|(meta, _)| meta);
            let table = compare::build_table(&history, node_limit).unwrap_or_else(|e| {
                issues.push(format!("无法整理目录数据：{e}"));
                NodeTable::default()
            });
            let mut file_changes = BTreeMap::new();
            for (meta, _) in &history {
                if let Some(changes) = store.load_file_changes::<FileChanges>(meta) {
                    file_changes.insert(meta.scan_id.clone(), changes);
                }
            }
            let mut insights_by_scan = BTreeMap::new();
            for (meta, snapshot) in &history {
                let found = store.load_insights(meta).or_else(|| {
                    // Made before this existed, and it may be all there is to show.
                    let newest = history
                        .last()
                        .is_some_and(|(m, _)| m.scan_id == meta.scan_id);
                    if newest {
                        insights::from_snapshot(snapshot)
                    } else {
                        None
                    }
                });
                if let Some(found) = found {
                    insights_by_scan.insert(meta.scan_id.clone(), found);
                }
            }
            let mut records = store.load_records(key);
            // Long-term comparison only needs the two ends, among scans of one engine.
            let newest_engine = records.last().map(|r| r.engine.clone());
            let first_alike = records
                .iter()
                .position(|r| Some(&r.engine) == newest_engine.as_ref() && !r.top.is_empty());
            let newest_record = records.len().saturating_sub(1);
            for (i, record) in records.iter_mut().enumerate() {
                if Some(i) != first_alike && i != newest_record {
                    record.top = Vec::new();
                }
            }
            VolumeReport {
                key: Some(key.clone()),
                letter: live
                    .map(|v| v.letter)
                    .or(last.map(|m| m.letter))
                    .unwrap_or('?'),
                label: live
                    .map(|v| v.label.clone())
                    .or(last.map(|m| m.label.clone()))
                    .unwrap_or_default(),
                connected: live.is_some(),
                total_bytes: live.map(|v| v.total_bytes).or(last.map(|m| m.total_bytes)),
                free_bytes: live.map(|v| v.free_bytes).or(last.map(|m| m.free_bytes)),
                this_run: run.and_then(|r| {
                    r.volumes
                        .iter()
                        .find(|v| v.volume_key.as_deref() == Some(key))
                        .cloned()
                }),
                snapshots: history.iter().map(|(meta, _)| meta.into()).collect(),
                table,
                file_changes,
                insights: insights_by_scan,
                records,
                issues,
            }
        })
        .collect();
    // A volume with no identity has no history, but what happened to it still shows.
    if let Some(run) = run {
        for v in run.volumes.iter().filter(|v| v.volume_key.is_none()) {
            let live = connected.iter().find(|c| c.letter == v.letter);
            volumes.push(VolumeReport {
                key: None,
                letter: v.letter,
                label: v.label.clone(),
                connected: live.is_some(),
                total_bytes: live.map(|c| c.total_bytes),
                free_bytes: live.map(|c| c.free_bytes),
                this_run: Some(v.clone()),
                snapshots: Vec::new(),
                table: NodeTable::default(),
                file_changes: BTreeMap::new(),
                insights: BTreeMap::new(),
                records: Vec::new(),
                issues: Vec::new(),
            });
        }
    }
    // A disk long gone with nothing left to show but a line of numbers is not news.
    volumes.retain(|v| v.connected || !v.snapshots.is_empty() || v.this_run.is_some());
    volumes.sort_by_key(|v| (!v.connected, v.letter));
    ReportData {
        format: 2,
        app_version: env!("CARGO_PKG_VERSION"),
        generated_at: now_unix(),
        theme: store.load_settings().theme,
        footprint: store.footprint(),
        run: run.cloned(),
        volumes,
    }
}

/// Write the report for `run`, and note its file name in the run record.
pub fn write_report(
    store: &Store,
    run: &mut RunRecord,
    connected: &[Volume],
) -> Result<PathBuf, String> {
    let mut data = report_data(store, Some(run), connected);
    // Make room for the page first, and let it say truthfully what is kept once it
    // is there. Its size barely changes when those few numbers do.
    let draft = report::render(&data).map_err(|e| e.to_string())?;
    let size = draft.len() as u64;
    store.enforce(store.data_budget().saturating_sub(size));
    data.footprint = store.footprint();
    data.footprint.reports += size;
    data.footprint.total += size;
    data.footprint.reports_kept = (data.footprint.reports_kept + 1).min(KEEP_REPORTS);
    let html = report::render(&data).map_err(|e| e.to_string())?;
    let path = store.write_report(&html).map_err(|e| e.to_string())?;
    store.enforce(store.data_budget());
    run.report_file = path.file_name().map(|n| n.to_string_lossy().into_owned());
    store
        .save_run(&run.scan_id, run)
        .map_err(|e| e.to_string())?;
    Ok(path)
}
