//! Making snapshots comparable, without presenting the unknown as a change.
//!
//! A report lets the reader compare any two scans of a volume. Every snapshot
//! records every folder, so a table of the folders worth showing, with their
//! exact size in each snapshot, holds all it needs. The arithmetic of a
//! comparison, including what to leave out for folders that could not be read,
//! lives in one place: `report/lib.js`.
//!
//! File-level changes come from the core's `diff`. That compares every file, so
//! it only runs where both scans could read the same folders: otherwise the
//! files of a folder readable only once would look added or removed.

use std::collections::{HashMap, HashSet};

use diskghost_core::{diff, FileDelta, Snapshot};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::scan::relative_path;
use crate::store::SnapshotMeta;
use crate::volumes::Sameness;

/// Folders shown per volume, before forced ones and their parents.
pub const NODE_LIMIT: usize = 20_000;
/// Files listed per kind of change.
pub const FILE_LIMIT: usize = 200;
/// A changed folder is worth this many times a folder of that size.
const CHANGE_WEIGHT: u64 = 16;

/// Whether the folder changes between two scans mean anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairStatus {
    Comparable,
    /// Formatted in between, or another volume, or unknown: not the same files.
    NotSameVolume,
    /// One read the MFT, one walked: they size some files differently.
    DifferentEngine,
}

pub fn pair_status(old: &SnapshotMeta, new: &SnapshotMeta) -> PairStatus {
    if old.identity.compare(&new.identity) != Sameness::Same {
        return PairStatus::NotSameVolume;
    }
    if old.summary.engine != new.summary.engine {
        return PairStatus::DifferentEngine;
    }
    PairStatus::Comparable
}

/// The folders of a volume across its snapshots, parents before children.
#[derive(Debug, Clone, Default, Serialize)]
pub struct NodeTable {
    pub names: Vec<String>,
    /// Index of the parent, -1 for the root.
    pub parents: Vec<i32>,
    /// Per snapshot, per node: its size, or null if not in that snapshot.
    pub sizes: Vec<Vec<Option<u64>>>,
    pub files: Vec<Vec<Option<u64>>>,
    /// Per snapshot, the nodes that could not be read.
    pub unread: Vec<Vec<u32>>,
}

#[derive(Default)]
struct PathStats {
    largest: u64,
    biggest_change: u64,
    last_size: u64,
    last_seen: usize,
    seen: bool,
}

impl PathStats {
    fn update(&mut self, snapshot: usize, size: u64) {
        self.largest = self.largest.max(size);
        let previous = if self.seen && self.last_seen + 1 == snapshot {
            self.last_size
        } else {
            0 // appeared here
        };
        if snapshot > 0 {
            self.biggest_change = self.biggest_change.max(size.abs_diff(previous));
        }
        self.last_size = size;
        self.last_seen = snapshot;
        self.seen = true;
    }

    fn score(&self, snapshots: usize) -> u64 {
        // Vanished before the last snapshot: that was a change of its full size.
        let vanished = if self.seen && self.last_seen + 1 < snapshots {
            self.last_size
        } else {
            0
        };
        let change = self.biggest_change.max(vanished);
        self.largest.max(change.saturating_mul(CHANGE_WEIGHT))
    }
}

fn parent_of(path: &str) -> Option<&str> {
    path.rfind('\\').map(|i| &path[..i])
}

fn depth_of(path: &str) -> usize {
    if path.is_empty() {
        0
    } else {
        path.bytes().filter(|&b| b == b'\\').count() + 1
    }
}

/// Build the table for `history`, oldest first. The biggest and most changed
/// folders are kept up to `limit`, plus the top level, every unread folder and
/// the parents of them all. Sizes in it are exact in every snapshot: the rest of
/// a folder is what its size leaves after the children listed.
pub fn build_table(
    history: &[(SnapshotMeta, Snapshot)],
    limit: usize,
) -> Result<NodeTable, String> {
    type Row = (String, u64, u64);
    let rows: Vec<Vec<Row>> = history
        .par_iter()
        .map(|(_, snapshot)| {
            let dirs = snapshot.dirs().map_err(|e| e.to_string())?;
            Ok(dirs
                .into_iter()
                .filter_map(|d| {
                    let rel = relative_path(&snapshot.root, &d.path)?;
                    (!rel.is_empty()).then_some((rel, d.size, d.file_count))
                })
                .collect())
        })
        .collect::<Result<_, String>>()?;

    let mut stats: HashMap<&str, PathStats> = HashMap::new();
    for (s, list) in rows.iter().enumerate() {
        for (rel, size, _) in list {
            stats.entry(rel.as_str()).or_default().update(s, *size);
        }
    }

    let mut keep: HashSet<&str> = stats.keys().copied().filter(|p| depth_of(p) == 1).collect();
    for (meta, _) in history {
        for rel in &meta.summary.unread_dirs {
            keep.insert(rel.as_str());
        }
    }
    let mut ranked: Vec<(&str, u64)> = stats
        .iter()
        .filter(|(p, _)| !keep.contains(*p))
        .map(|(p, s)| (*p, s.score(history.len())))
        .collect();
    ranked.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    keep.extend(
        ranked
            .iter()
            .take(limit.saturating_sub(keep.len()))
            .map(|(p, _)| *p),
    );
    let chosen: Vec<&str> = keep.iter().copied().collect();
    for path in chosen {
        let mut at = path;
        while let Some(parent) = parent_of(at) {
            if !keep.insert(parent) {
                break;
            }
            at = parent;
        }
    }

    let mut ordered: Vec<&str> = keep.into_iter().collect();
    ordered.sort_unstable_by(|a, b| depth_of(a).cmp(&depth_of(b)).then_with(|| a.cmp(b)));
    let mut index: HashMap<&str, u32> = HashMap::with_capacity(ordered.len() + 1);
    let mut table = NodeTable {
        names: Vec::with_capacity(ordered.len() + 1),
        parents: Vec::with_capacity(ordered.len() + 1),
        ..NodeTable::default()
    };
    index.insert("", 0);
    table.names.push(String::new());
    table.parents.push(-1);
    for path in &ordered {
        let i = table.names.len() as u32;
        index.insert(path, i);
        let (parent, name) = match path.rfind('\\') {
            Some(cut) => (&path[..cut], &path[cut + 1..]),
            None => ("", *path),
        };
        table.names.push(name.to_string());
        table
            .parents
            .push(index.get(parent).map_or(0, |&p| p as i32));
    }

    for (s, (meta, snapshot)) in history.iter().enumerate() {
        let mut sizes = vec![None; table.names.len()];
        let mut files = vec![None; table.names.len()];
        sizes[0] = Some(snapshot.total_size);
        files[0] = Some(snapshot.total_files);
        for (rel, size, count) in &rows[s] {
            if let Some(&i) = index.get(rel.as_str()) {
                sizes[i as usize] = Some(*size);
                files[i as usize] = Some(*count);
            }
        }
        table.sizes.push(sizes);
        table.files.push(files);
        table.unread.push(
            meta.summary
                .unread_dirs
                .iter()
                .filter_map(|rel| index.get(rel.as_str()).copied())
                .collect(),
        );
    }
    Ok(table)
}

/// One file that appeared, disappeared or changed size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub old: u64,
    pub new: u64,
}

/// The file changes against the scan before.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChanges {
    /// The older scan they are measured against.
    pub base: String,
    /// Why there are none, in plain words.
    pub unavailable: Option<String>,
    pub added: Vec<FileChange>,
    pub removed: Vec<FileChange>,
    pub changed: Vec<FileChange>,
    pub added_count: u64,
    pub added_bytes: u64,
    pub removed_count: u64,
    pub removed_bytes: u64,
    pub changed_count: u64,
    pub changed_delta: i64,
}

fn file_list(root: &std::path::Path, list: Vec<FileDelta>) -> Vec<FileChange> {
    list.into_iter()
        .filter_map(|f| {
            Some(FileChange {
                path: relative_path(root, &f.path)?,
                old: f.old_size,
                new: f.new_size,
            })
        })
        .collect()
}

/// File changes from `old` to `new`, or a [`FileChanges::unavailable`] reason
/// when the result could not be trusted.
pub fn file_changes(
    old_meta: &SnapshotMeta,
    old: &Snapshot,
    new_meta: &SnapshotMeta,
    new: &Snapshot,
) -> FileChanges {
    let refuse = |why: &str| FileChanges {
        base: old_meta.scan_id.clone(),
        unavailable: Some(why.to_string()),
        ..FileChanges::default()
    };
    match pair_status(old_meta, new_meta) {
        PairStatus::Comparable => {}
        PairStatus::NotSameVolume => return refuse("这两次扫描不是同一个文件系统"),
        PairStatus::DifferentEngine => return refuse("这两次扫描使用了不同的扫描方式"),
    }
    if old_meta.summary.unread_dirs != new_meta.summary.unread_dirs {
        return refuse("这两次扫描能读取的目录不同");
    }
    if old_meta.summary.skipped_elsewhere() > 0 || new_meta.summary.skipped_elsewhere() > 0 {
        return refuse("有条目未能读取且位置未知");
    }
    // The same volume can have another letter now: the core compares roots.
    let mut aligned = old.clone();
    aligned.root.clone_from(&new.root);
    let mut report = match diff(&aligned, new, &new.root) {
        Ok(report) => report,
        Err(e) => return refuse(&format!("无法比较：{e}")),
    };
    report.truncate(FILE_LIMIT);
    FileChanges {
        base: old_meta.scan_id.clone(),
        unavailable: None,
        added: file_list(&new.root, report.new_files_list),
        removed: file_list(&new.root, report.removed_files_list),
        changed: file_list(&new.root, report.changed_files_list),
        added_count: report.new_files_count,
        added_bytes: report.new_files_bytes,
        removed_count: report.removed_files_count,
        removed_bytes: report.removed_files_bytes,
        changed_count: report.changed_files_count,
        changed_delta: report.changed_files_delta,
    }
}
