//! Real scans of real folders, stored and compared the way the app does it.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

use diskghost_core::{diff, Progress};
use diskly_core::compare::{build_table, pair_status, NodeTable, PairStatus};
use diskly_core::scan::{scan_root, ScanStatus};
use diskly_core::session::{commit_run, report_data, write_report, VolumeResult};
use diskly_core::store::{SnapshotMeta, Store};
use diskly_core::volumes::{Volume, VolumeIdentity};

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A folder for one test, removed again when the test ends.
struct TestDir(PathBuf);

impl TestDir {
    fn new(name: &str) -> TestDir {
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("diskly-{name}-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        TestDir(dir)
    }
    fn path(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }
    fn write(&self, rel: &str, bytes: usize) {
        let path = self.path(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![7u8; bytes]).unwrap();
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Denies this user access to a folder until dropped.
struct Denied(PathBuf);

fn account() -> String {
    let user = std::env::var("USERNAME").unwrap();
    match std::env::var("USERDOMAIN") {
        Ok(domain) => format!(r"{domain}\{user}"),
        Err(_) => user,
    }
}

impl Denied {
    fn new(path: PathBuf) -> Denied {
        let done = Command::new("icacls")
            .arg(&path)
            .args(["/deny", &format!("{}:(OI)(CI)(RX)", account())])
            .output()
            .unwrap();
        assert!(done.status.success(), "icacls could not deny access");
        Denied(path)
    }
}

impl Drop for Denied {
    fn drop(&mut self) {
        let _ = Command::new("icacls")
            .arg(&self.0)
            .args(["/remove:d", &account()])
            .output();
    }
}

fn volume(root: &Path, letter: char, guid: &str, serial: u32) -> Volume {
    Volume {
        letter,
        root: root.to_path_buf(),
        label: "test".into(),
        identity: VolumeIdentity {
            guid: Some(guid.into()),
            serial: Some(serial),
            file_system: Some("NTFS".into()),
        },
        total_bytes: 1_000_000_000,
        free_bytes: 400_000_000,
        physical_disk: Some(0),
        problem: None,
    }
}

/// Scan `root` as `volume` and store it the way the app does. Returns the meta.
fn scan_and_commit(store: &Store, id: &str, at: u64, volume: &Volume) -> SnapshotMeta {
    let (summary, snapshot) = scan_root(&volume.root, false, &Progress::default());
    let run = commit_run(
        store,
        id,
        at,
        0.1,
        false,
        vec![VolumeResult {
            volume: volume.clone(),
            summary,
            snapshot,
        }],
        20,
    );
    assert!(run.volumes[0].stored, "{:?}", run.volumes[0].error);
    store
        .list(&volume.identity.key().unwrap())
        .entries
        .into_iter()
        .find(|m| m.scan_id == id)
        .unwrap()
}

fn history(store: &Store, key: &str) -> Vec<(SnapshotMeta, diskghost_core::Snapshot)> {
    store
        .list(key)
        .entries
        .into_iter()
        .map(|meta| {
            let snapshot = store.load(&meta).unwrap();
            (meta, snapshot)
        })
        .collect()
}

fn node(table: &NodeTable, name: &str) -> usize {
    table
        .names
        .iter()
        .position(|n| n == name)
        .unwrap_or_else(|| panic!("{name} is not in the table"))
}

#[test]
fn the_table_says_exactly_what_the_core_diff_says() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"grows\a.bin", 1000);
    tree.write(r"shrinks\a.bin", 1000);
    tree.write(r"shrinks\b.bin", 500);
    tree.write(r"stays\a.bin", 300);
    tree.write(r"goes\a.bin", 700);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    scan_and_commit(&store, "000000000001-a", 1, &v);

    tree.write(r"grows\b.bin", 2000);
    fs::remove_file(tree.path(r"shrinks\b.bin")).unwrap();
    fs::remove_file(tree.path(r"goes\a.bin")).unwrap();
    fs::remove_dir(tree.path("goes")).unwrap();
    tree.write(r"comes\a.bin", 900);
    scan_and_commit(&store, "000000000002-b", 2, &v);

    let list = history(&store, "v-g1");
    let table = build_table(&list, 100).unwrap();
    let report = diff(&list[0].1, &list[1].1, &tree.0).unwrap();

    let delta_of = |name: &str| {
        let i = node(&table, name);
        let (old, new) = (table.sizes[0][i], table.sizes[1][i]);
        (old, new)
    };
    assert_eq!(table.sizes[0][0], Some(report.old_size));
    assert_eq!(table.sizes[1][0], Some(report.new_size));
    for d in report.grown.iter().chain(&report.shrunk) {
        let name = d.path.file_name().unwrap().to_str().unwrap();
        assert_eq!(
            delta_of(name),
            (Some(d.old_size), Some(d.new_size)),
            "{name}"
        );
    }
    for d in &report.added {
        let name = d.path.file_name().unwrap().to_str().unwrap();
        assert_eq!(delta_of(name), (None, Some(d.size)), "{name}");
    }
    for d in &report.removed {
        let name = d.path.file_name().unwrap().to_str().unwrap();
        assert_eq!(delta_of(name), (Some(d.size), None), "{name}");
    }
    assert_eq!(delta_of("stays"), (Some(300), Some(300)));

    // The file level agrees too, and the comparison was against the right scan.
    let files: diskly_core::compare::FileChanges = store.load_file_changes(&list[1].0).unwrap();
    assert_eq!(files.unavailable, None);
    assert_eq!(files.base, "000000000001-a");
    assert_eq!(files.added_count, report.new_files_count);
    assert_eq!(files.removed_bytes, report.removed_files_bytes);
    assert_eq!(files.added[0].path, r"grows\b.bin");
}

#[test]
fn a_folder_that_cannot_be_read_is_recorded_not_emptied() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"secret\inner\a.bin", 300_000);
    tree.write(r"open\a.bin", 1000);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    let first = scan_and_commit(&store, "000000000001-a", 1, &v);
    assert!(first.summary.unread_dirs.is_empty());

    let second = {
        let _deny = Denied::new(tree.path("secret"));
        scan_and_commit(&store, "000000000002-b", 2, &v)
    };
    assert_eq!(second.summary.unread_dirs, vec!["secret".to_string()]);
    assert_eq!(second.summary.skipped_elsewhere(), 0);

    let list = history(&store, "v-g1");
    let table = build_table(&list, 100).unwrap();
    let secret = node(&table, "secret") as u32;
    assert!(table.unread[0].is_empty());
    assert_eq!(table.unread[1], vec![secret]);
    // What is under it is only known in the scan that could read it. The comparison
    // needs that: `inner` is absent, not removed, because its parent was unread.
    assert_eq!(table.sizes[1][node(&table, "inner")], None);

    // The core alone would call this a removed file; the file list says it cannot tell.
    let files: diskly_core::compare::FileChanges = store.load_file_changes(&list[1].0).unwrap();
    assert_eq!(files.removed_count, 0);
    assert_eq!(
        files.unavailable.as_deref(),
        Some("这两次扫描能读取的目录不同")
    );
}

#[test]
fn a_second_walk_reads_the_same_way_once_access_is_back() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"secret\a.bin", 100);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    {
        let _deny = Denied::new(tree.path("secret"));
        scan_and_commit(&store, "000000000001-a", 1, &v);
        scan_and_commit(&store, "000000000002-b", 2, &v);
    }
    // Both could read the same folders, so the file level can be trusted.
    let list = history(&store, "v-g1");
    let files: diskly_core::compare::FileChanges = store.load_file_changes(&list[1].0).unwrap();
    assert_eq!(files.unavailable, None);
    assert_eq!(files.removed_count, 0);
}

fn meta_with(engine: &str, guid: &str, serial: u32) -> SnapshotMeta {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write("a.bin", 1);
    let store = Store::open(&data.0).unwrap();
    let mut meta = scan_and_commit(
        &store,
        "000000000001-a",
        1,
        &volume(&tree.0, 'T', guid, serial),
    );
    meta.summary.engine = engine.to_string();
    meta
}

#[test]
fn only_scans_of_the_same_file_system_with_the_same_engine_compare() {
    let base = meta_with("mft", "g1", 1);
    assert_eq!(
        pair_status(&base, &meta_with("mft", "g1", 1)),
        PairStatus::Comparable
    );
    assert_eq!(
        pair_status(&base, &meta_with("walk", "g1", 1)),
        PairStatus::DifferentEngine
    );
    assert_eq!(
        pair_status(&base, &meta_with("mft", "g1", 2)),
        PairStatus::NotSameVolume
    );
    assert_eq!(
        pair_status(&base, &meta_with("mft", "g2", 1)),
        PairStatus::NotSameVolume
    );
}

#[test]
fn a_volume_with_another_letter_still_compares() {
    let (first, second, data) = (TestDir::new("a"), TestDir::new("b"), TestDir::new("data"));
    first.write(r"x\a.bin", 100);
    second.write(r"x\a.bin", 250);
    let store = Store::open(&data.0).unwrap();
    // The same volume seen at two roots, as after a change of drive letter.
    scan_and_commit(&store, "000000000001-a", 1, &volume(&first.0, 'D', "g1", 1));
    scan_and_commit(
        &store,
        "000000000002-b",
        2,
        &volume(&second.0, 'E', "g1", 1),
    );
    let list = history(&store, "v-g1");
    let table = build_table(&list, 100).unwrap();
    assert_eq!(table.sizes[0][node(&table, "x")], Some(100));
    assert_eq!(table.sizes[1][node(&table, "x")], Some(250));
    let files: diskly_core::compare::FileChanges = store.load_file_changes(&list[1].0).unwrap();
    assert_eq!(files.unavailable, None);
    assert_eq!(files.changed[0].new, 250);
    assert_eq!(files.changed[0].path, r"x\a.bin");
}

#[test]
fn a_reused_letter_starts_a_new_history() {
    let (first, second, data) = (TestDir::new("a"), TestDir::new("b"), TestDir::new("data"));
    first.write("a.bin", 100);
    second.write("b.bin", 100);
    let store = Store::open(&data.0).unwrap();
    scan_and_commit(
        &store,
        "000000000001-a",
        1,
        &volume(&first.0, 'D', "old", 1),
    );
    let new = volume(&second.0, 'D', "new", 2);
    scan_and_commit(&store, "000000000002-b", 2, &new);
    assert_eq!(store.volume_keys(), vec!["v-new", "v-old"]);
    assert_eq!(store.list("v-new").entries.len(), 1);

    // The old one is still there, shown as not connected, not as emptied.
    let report = report_data(&store, None, &[new]);
    let old = report
        .volumes
        .iter()
        .find(|v| v.key.as_deref() == Some("v-old"))
        .unwrap();
    assert!(!old.connected);
    assert_eq!(old.snapshots.len(), 1);
    assert!(report.volumes[0].connected, "connected volumes first");
}

#[test]
fn a_cancelled_scan_gives_no_snapshot_and_leaves_the_baseline_alone() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"x\a.bin", 100);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    scan_and_commit(&store, "000000000001-a", 1, &v);

    let progress = Progress::default();
    progress.cancel();
    let (summary, snapshot) = scan_root(&tree.0, false, &progress);
    assert_eq!(summary.status, ScanStatus::Cancelled);
    assert!(snapshot.is_none());
    let run = commit_run(
        &store,
        "000000000002-b",
        2,
        0.1,
        false,
        vec![VolumeResult {
            volume: v,
            summary,
            snapshot,
        }],
        20,
    );
    assert!(!run.volumes[0].stored);
    let list = store.list("v-g1").entries;
    assert_eq!(list.len(), 1, "the baseline is untouched");
    assert_eq!(list[0].scan_id, "000000000001-a");
    assert_eq!(
        store.list_runs::<serde_json::Value>().len(),
        2,
        "the run is on record"
    );
}

#[test]
fn a_scan_interrupted_before_its_marker_does_not_count() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write("a.bin", 100);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    let meta = scan_and_commit(&store, "000000000001-a", 1, &v);
    // What a crash between the snapshot and its marker leaves behind.
    let dir = data.path(r"history\v-g1");
    fs::copy(
        dir.join(format!("{}.dgs", meta.scan_id)),
        dir.join("000000000002-b.dgs"),
    )
    .unwrap();
    fs::write(dir.join("000000000003-c.dgs.1234.tmp"), b"half").unwrap();
    let listing = store.list("v-g1");
    assert_eq!(listing.entries.len(), 1);
    assert!(listing.issues.is_empty());
}

#[test]
fn a_damaged_snapshot_is_noticed_and_skipped() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write("a.bin", 100);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    let bad = scan_and_commit(&store, "000000000001-a", 1, &v);
    tree.write("b.bin", 100);
    scan_and_commit(&store, "000000000002-b", 2, &v);

    let file = data
        .path(r"history\v-g1")
        .join(format!("{}.dgs", bad.scan_id));
    let mut bytes = fs::read(&file).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xFF;
    fs::write(&file, bytes).unwrap();

    assert!(store.load(&bad).unwrap_err().contains("损坏"));
    let report = report_data(&store, None, &[v]);
    assert_eq!(report.volumes[0].snapshots.len(), 1, "only the good one");
    assert_eq!(report.volumes[0].snapshots[0].id, "000000000002-b");
    assert!(report.volumes[0].issues[0].contains("000000000001-a"));
}

#[test]
fn a_damaged_marker_is_reported_and_skipped() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write("a.bin", 100);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    let meta = scan_and_commit(&store, "000000000001-a", 1, &v);
    fs::write(
        data.path(r"history\v-g1")
            .join(format!("{}.json", meta.scan_id)),
        b"{broken",
    )
    .unwrap();
    let listing = store.list("v-g1");
    assert!(listing.entries.is_empty());
    assert_eq!(listing.issues.len(), 1);
}

#[test]
fn old_snapshots_go_only_past_the_limit_and_only_our_own_files() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write("a.bin", 100);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    for i in 1..=4 {
        scan_and_commit(&store, &format!("00000000000{i}-a"), i, &v);
    }
    let dir = data.path(r"history\v-g1");
    fs::write(dir.join("notes.txt"), b"not ours").unwrap();
    assert_eq!(store.prune("v-g1", 2).unwrap(), 2);
    let kept: Vec<String> = store
        .list("v-g1")
        .entries
        .into_iter()
        .map(|m| m.scan_id)
        .collect();
    assert_eq!(kept, vec!["000000000003-a", "000000000004-a"]);
    assert!(dir.join("notes.txt").exists());
    assert!(!dir.join("000000000001-a.dgs").exists());
    assert!(!dir.join("000000000001-a.json").exists());
    assert!(!dir.join("000000000001-a.files.json").exists());
    assert_eq!(
        store.prune("v-g1", 1).unwrap(),
        0,
        "two is the least worth keeping"
    );
}

#[test]
fn only_old_files_of_a_helper_are_cleared_and_only_its_kinds() {
    let data = TestDir::new("data");
    let store = Store::open(&data.0).unwrap();
    let dir = store.helper_dir();
    fs::create_dir_all(&dir).unwrap();
    let old = SystemTime::now() - Duration::from_secs(7200);
    let aged = |name: &str| {
        let path = dir.join(name);
        fs::write(&path, b"x").unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(old).unwrap();
        path
    };
    let stale_marker = aged("abc-alive.json");
    let stale_result = aged("abc-C.dgs");
    let not_ours = aged("notes.txt");
    let fresh = dir.join("def-alive.json");
    fs::write(&fresh, b"x").unwrap();

    store.clear_stale_helper_files(Duration::from_secs(3600));

    assert!(!stale_marker.exists());
    assert!(!stale_result.exists());
    assert!(not_ours.exists(), "not a kind of file a helper writes");
    assert!(fresh.exists(), "may belong to a helper still running");
}

#[test]
fn a_big_tree_keeps_what_matters_within_the_limit() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    for i in 0..30 {
        tree.write(&format!(r"small\d{i}\a.bin"), 10);
    }
    tree.write(r"deep\er\still\big.bin", 500_000);
    tree.write(r"deep\er\still\er\changes.bin", 100);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    scan_and_commit(&store, "000000000001-a", 1, &v);
    tree.write(r"deep\er\still\er\changes.bin", 200_000);
    scan_and_commit(&store, "000000000002-b", 2, &v);

    let table = build_table(&history(&store, "v-g1"), 6).unwrap();
    // The top level, the biggest and the changed one with its parents are in.
    for name in ["small", "deep", "er", "still"] {
        node(&table, name);
    }
    assert!(table.names.len() < 12, "{} nodes", table.names.len());
    // Parents come first, whatever was kept.
    for (i, p) in table.parents.iter().enumerate().skip(1) {
        assert!((*p as usize) < i);
    }
}

#[test]
fn a_report_is_one_file_in_the_reports_folder() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"x\a.bin", 100);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    let (summary, snapshot) = scan_root(&tree.0, false, &Progress::default());
    let mut run = commit_run(
        &store,
        "000000000001-a",
        1,
        0.1,
        false,
        vec![VolumeResult {
            volume: v.clone(),
            summary,
            snapshot,
        }],
        20,
    );
    let path = write_report(&store, &mut run, &[v]).unwrap();
    assert_eq!(path.parent().unwrap(), data.path("reports"));
    let html = fs::read_to_string(&path).unwrap();
    assert!(html.contains("id=\"diskly-data\""));
    assert!(html.contains(r#""scan_id":"000000000001-a""#));
    assert_eq!(
        store.report_path(run.report_file.as_deref().unwrap()),
        Some(path)
    );
    assert_eq!(store.report_path(r"..\settings.json"), None);
    assert_eq!(store.report_path("Diskly-missing.html"), None);
}
