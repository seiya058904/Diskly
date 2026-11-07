//! Real scans of real folders, stored and compared the way the app does it.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

use diskghost_core::{diff, Progress};
use diskly_core::compare::{build_table, pair_status, NodeTable, PairStatus};
use diskly_core::scan::{scan_root, ScanStatus};
use diskly_core::session::{
    commit_run, list_run_views, prepare_report, report_availability, report_data, write_report,
    ReportAvailability, RunRecord, VolumeResult,
};
use diskly_core::store::{long_term_base, thin_records, ScanRecord, SnapshotMeta, Store};
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
    // The core needs the older scan's files, which are dropped once a newer one is in.
    let whole = history(&store, "v-g1").remove(0).1;
    scan_and_commit(&store, "000000000002-b", 2, &v);

    let list = history(&store, "v-g1");
    let table = build_table(&list, 100).unwrap();
    let report = diff(&whole, &list[1].1, &tree.0).unwrap();

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
    scan_and_commit(&store, "000000000001-a", 1, &v);
    tree.write("b.bin", 100);
    scan_and_commit(&store, "000000000002-b", 2, &v);
    let bad = store.list("v-g1").entries[0].clone();

    let file = data
        .path(r"history\v-g1")
        // The older scan has only its folders by now.
        .join(format!("{}.dirs.dgs", bad.scan_id));
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
    assert!(!dir.join("000000000001-a.dirs.dgs").exists());
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
fn older_scans_keep_only_their_folders_and_still_compare_exactly() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    for i in 0..300 {
        tree.write(
            &format!(r"folder\sub{}\file-with-a-longer-name-{i}.bin", i % 7),
            100,
        );
    }
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    let first = scan_and_commit(&store, "000000000001-a", 1, &v);
    let whole_table = build_table(&history(&store, "v-g1"), 100).unwrap();
    assert!(!first.folders_only);
    tree.write(r"folder\sub1\new.bin", 5000);
    scan_and_commit(&store, "000000000002-b", 2, &v);

    let list = store.list("v-g1").entries;
    assert!(list[0].folders_only, "the older one");
    assert!(!list[1].folders_only, "the newest keeps its files");
    assert!(
        list[0].stored_bytes * 2 < first.stored_bytes,
        "{} of {}",
        list[0].stored_bytes,
        first.stored_bytes
    );
    let dir = data.path(r"history\v-g1");
    assert!(!dir.join("000000000001-a.dgs").exists());
    assert!(dir.join("000000000001-a.dirs.dgs").exists());

    // It loads, its hash checks out, and folder sizes are what they were.
    let loaded = history(&store, "v-g1");
    let table = build_table(&loaded, 100).unwrap();
    for name in ["folder", "sub1", "sub6"] {
        assert_eq!(
            table.sizes[0][node(&table, name)],
            whole_table.sizes[0][node(&whole_table, name)],
            "{name}"
        );
    }
    assert_eq!(
        table.sizes[1][node(&table, "sub1")].unwrap()
            - table.sizes[0][node(&table, "sub1")].unwrap(),
        5000
    );

    // The next scan is still compared file by file with the newest, which has its files.
    tree.write(r"folder\sub2\another.bin", 700);
    scan_and_commit(&store, "000000000003-c", 3, &v);
    let list = store.list("v-g1").entries;
    let files: diskly_core::compare::FileChanges = store.load_file_changes(&list[2]).unwrap();
    assert_eq!(files.unavailable, None);
    assert_eq!(files.base, "000000000002-b");
    assert_eq!(files.added[0].path, r"folder\sub2\another.bin");
}

#[test]
fn the_newest_scan_of_each_engine_keeps_its_files() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"a\a.bin", 100);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    scan_and_commit(&store, "000000000001-a", 1, &v);
    let (mut summary, snapshot) = scan_root(&v.root, false, &Progress::default());
    summary.engine = "mft".into();
    commit_run(
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
        3,
    );
    let list = store.list("v-g1").entries;
    assert!(
        !list[0].folders_only && !list[1].folders_only,
        "one of each"
    );
}

/// Files of a store that are not part of a kept scan or report are never expected.
fn store_with_scans(data: &TestDir, tree: &TestDir, scans: u64) -> (Store, Volume) {
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    for i in 1..=scans {
        tree.write(&format!(r"grows\file{i}.bin"), 1000);
        let (summary, snapshot) = scan_root(&v.root, false, &Progress::default());
        let mut run = commit_run(
            &store,
            &format!("{i:012}-a"),
            i,
            0.1,
            false,
            vec![VolumeResult {
                volume: v.clone(),
                summary,
                snapshot,
            }],
            3,
        );
        write_report(&store, &mut run, std::slice::from_ref(&v)).unwrap();
    }
    (store, v)
}

#[test]
fn after_hundreds_of_scans_nothing_has_grown() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"a\a.bin", 500);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    let size = || diskly_core::store::folder_size(&data.0);
    let count = |dir: &str| fs::read_dir(data.path(dir)).unwrap().count();
    let scan = |i: u64| {
        // The same files each time, so that whatever grows can only be Diskly's own.
        tree.write(r"a\changes.bin", (i % 2 + 1) as usize * 1000);
        let (summary, snapshot) = scan_root(&v.root, false, &Progress::default());
        let mut run = commit_run(
            &store,
            &format!("{i:012}-a"),
            diskly_core::store::now_unix() - 500 + i,
            0.1,
            false,
            vec![VolumeResult {
                volume: v.clone(),
                summary,
                snapshot,
            }],
            3,
        );
        write_report(&store, &mut run, std::slice::from_ref(&v)).unwrap();
    };
    for i in 1..=60 {
        scan(i);
    }
    let settled = size();
    for i in 61..=300 {
        scan(i);
        assert!(count("reports") <= 3, "reports after scan {i}");
        assert!(count("runs") <= 50, "runs after scan {i}");
        assert!(count(r"history\v-g1") <= 12, "scan files after scan {i}");
    }
    assert_eq!(store.list("v-g1").entries.len(), 3);
    assert!(
        size() <= settled + settled / 4,
        "{settled} bytes after 60 scans, {} after 300",
        size()
    );
    assert!(store.load_records("v-g1").len() <= 400);
}

#[test]
fn many_disks_cannot_add_up_their_records_or_leave_folders_behind() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"a\a.bin", 500);
    let store = Store::open(&data.0).unwrap();
    // A hundred disks or formats, a long time ago.
    let old = SystemTime::now() - Duration::from_secs(86_400);
    for i in 0..100 {
        let path = data.path("records").join(format!("v-gone{i}.json"));
        fs::write(&path, vec![b' '; 200_000]).unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(old).unwrap();
        fs::create_dir_all(data.path("history").join(format!("v-gone{i}"))).unwrap();
    }
    scan_and_commit(&store, "000000000001-a", 1, &volume(&tree.0, 'T', "g1", 1));
    store.enforce(u64::MAX);
    assert!(diskly_core::store::folder_size(&data.path("records")) <= 4 * 1024 * 1024);
    assert_eq!(
        store.load_records("v-g1").len(),
        1,
        "the disk in use keeps its own"
    );
    assert_eq!(store.volume_keys(), vec!["v-g1"], "empty folders are gone");
}

#[test]
fn however_often_it_is_used_only_the_last_few_scans_stay_in_full() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"a\a.bin", 500);
    let (store, _) = store_with_scans(&data, &tree, 8);
    assert_eq!(store.list("v-g1").entries.len(), 3, "full snapshots");
    let reports = fs::read_dir(data.path("reports")).unwrap().count();
    assert!(reports <= 3, "{reports} reports");
    // Everything that goes with a dropped scan goes with it.
    let dir = data.path(r"history\v-g1");
    let left: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        left.iter().all(|f| !f.starts_with("000000000001-a")),
        "{left:?}"
    );
    // The records stay.
    assert_eq!(store.load_records("v-g1").len(), 8);
    // The run list is bounded too.
    assert_eq!(store.list_runs::<serde_json::Value>().len(), 8);
}

#[test]
fn the_data_never_stays_over_its_budget_and_the_newest_scan_goes_last() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"a\a.bin", 500);
    let (store, _) = store_with_scans(&data, &tree, 4);
    let size = || diskly_core::store::folder_size(&data.0);
    let before = size();

    // A little less than now: an old report and old scans go, the newest scan stays.
    store.enforce(before - 1);
    assert!(size() < before);
    assert!(!store.list("v-g1").entries.is_empty());
    assert_eq!(
        store.load_records("v-g1").len(),
        4,
        "records are not touched"
    );

    // Before a scan the newest stays however tight it is: the next one needs it.
    store.enforce(u64::MAX);
    let newest = store.list("v-g1").entries.last().unwrap().scan_id.clone();
    store.make_room();
    assert_eq!(store.list("v-g1").entries.last().unwrap().scan_id, newest);

    // Far too little: even the newest snapshot goes, and nothing else breaks.
    store.enforce(0);
    assert!(store.list("v-g1").entries.is_empty());
    assert_eq!(store.load_records("v-g1").len(), 4);
    let v = volume(&tree.0, 'T', "g1", 1);
    let report = report_data(&store, None, &[v]);
    assert!(report.volumes[0].snapshots.is_empty());
    assert_eq!(report.volumes[0].records.len(), 4);
}

#[test]
fn what_a_crash_left_goes_after_a_while_and_only_that() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"a\a.bin", 500);
    let (store, _) = store_with_scans(&data, &tree, 1);
    let dir = data.path(r"history\v-g1");
    let old = SystemTime::now() - Duration::from_secs(7200);
    let aged = |path: PathBuf| {
        fs::write(&path, b"x").unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(old).unwrap();
        path
    };
    let orphan = aged(dir.join("000000000099-z.dgs"));
    let orphan_part = aged(dir.join("000000000099-z.files.json"));
    let temp = aged(data.path("reports").join("x.html.123.tmp"));
    let not_ours = aged(dir.join("notes.txt"));
    let fresh = dir.join("000000000098-y.dgs");
    fs::write(&fresh, b"x").unwrap();

    store.enforce(u64::MAX);

    assert!(!orphan.exists() && !orphan_part.exists() && !temp.exists());
    assert!(fresh.exists(), "may belong to a scan running now");
    assert!(not_ours.exists(), "not a kind of file this store makes");
    assert_eq!(store.list("v-g1").entries.len(), 1, "the real scan stays");
}

#[test]
fn records_get_sparser_with_age_and_stay_few_however_many_scans_there_are() {
    const DAY: u64 = 86_400;
    let now = 3650 * DAY;
    let record = |at: u64| ScanRecord {
        id: format!("{at:012}-a"),
        at,
        letter: 'C',
        engine: "mft".into(),
        total: 1,
        free: 1,
        files: 1,
        dirs: 1,
        top: Vec::new(),
        serial: None,
        unread_top: None,
    };
    // Ten years of scanning every half hour.
    let mut records: Vec<ScanRecord> = (0..(3650 * 48)).map(|i| record(i * 1800)).collect();
    thin_records(&mut records, now);
    assert!(records.len() <= 400, "{} records", records.len());
    assert!(records.windows(2).all(|w| w[0].at < w[1].at), "in order");
    assert_eq!(
        records.last().unwrap().at,
        (3650 * 48 - 1) * 1800,
        "newest stays"
    );
    assert!(
        now - records.first().unwrap().at > 2 * 365 * DAY,
        "years are still there"
    );
    let this_month = records.iter().filter(|r| now - r.at < 30 * DAY).count();
    let this_year = records.iter().filter(|r| now - r.at < 365 * DAY).count();
    assert!(
        this_month > 60 && this_year > this_month,
        "{this_month} {this_year}"
    );
    // Thinning what is already thin does not take more away than it should.
    let count = records.len();
    thin_records(&mut records, now);
    assert_eq!(records.len(), count);
}

fn with_top(id: &str, at: u64, engine: &str, serial: Option<u32>, known: bool) -> ScanRecord {
    ScanRecord {
        id: id.into(),
        at,
        letter: 'C',
        engine: engine.into(),
        total: 1,
        free: 1,
        files: 1,
        dirs: 1,
        top: vec![("Users".into(), 1)],
        serial,
        unread_top: known.then(Vec::new),
    }
}

#[test]
fn the_long_term_base_is_the_oldest_of_the_same_file_system_and_engine() {
    let old = with_top("1", 1, "mft", Some(7), false);
    let other_format = with_top("2", 2, "mft", Some(6), true);
    let other_engine = with_top("3", 3, "walk", Some(7), true);
    let base = with_top("4", 4, "mft", Some(7), true);
    let later = with_top("5", 5, "mft", Some(7), true);
    let newest = with_top("6", 6, "mft", Some(7), true);
    let list = [old.clone(), other_format, other_engine, base, later, newest];
    assert_eq!(long_term_base(&list), Some(3));
    assert_eq!(long_term_base(&[old.clone(), old]), None, "old records");
    assert_eq!(long_term_base(&[]), None);
}

#[test]
fn records_say_what_could_not_be_read_and_reach_the_report_at_both_ends() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"Readable\a.bin", 1_000);
    tree.write(r"Secret\inner\locked\b.bin", 1_000);
    tree.write(r"Secret\c.bin", 1_000);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 7);
    scan_and_commit(&store, "000000000001-a", 1, &v);
    {
        let _denied = Denied::new(tree.path(r"Secret\inner\locked"));
        scan_and_commit(&store, "000000000002-a", 2, &v);
    }
    scan_and_commit(&store, "000000000003-a", 3, &v);

    let records = store.load_records("v-g1");
    assert_eq!(records.len(), 3);
    assert!(records.iter().all(|r| r.serial == Some(7)));
    assert_eq!(records[0].unread_top, Some(Vec::new()));
    assert_eq!(records[1].unread_top, Some(vec!["Secret".to_string()]));
    assert_eq!(records[2].unread_top, Some(Vec::new()));

    let report = report_data(&store, None, std::slice::from_ref(&v));
    let shown = &report.volumes[0].records;
    assert!(shown[0].knows_its_folders(), "the oldest end");
    assert!(shown[2].knows_its_folders(), "the newest end");
    assert!(shown[1].top.is_empty() && shown[1].unread_top.is_none());
}

#[test]
fn a_record_from_before_this_was_kept_still_loads_and_knows_nothing() {
    let line = r#"{"id":"1","at":1,"letter":"C","engine":"mft","total":1,"free":1,"files":1,"dirs":1,"top":[["Users",1]]}"#;
    let old: ScanRecord = serde_json::from_str(line).unwrap();
    assert_eq!(old.top.len(), 1);
    assert_eq!((old.serial, old.unread_top.as_ref()), (None, None));
    assert!(!old.knows_its_folders());
}

#[test]
fn only_a_folder_named_for_the_webview_cache_can_be_cleared() {
    let data = TestDir::new("data");
    data.write(r"Keep\a.bin", 10);
    diskly_core::store::clear_webview_folder(&data.path("Keep"));
    assert!(data.path(r"Keep\a.bin").exists(), "refused");
    data.write(r"WebView\EBWebView\Default\Cache\a.bin", 10);
    data.write(r"WebView\Local State", 10);
    diskly_core::store::clear_webview_folder(&data.path("WebView"));
    assert!(data.path("WebView").exists());
    assert_eq!(fs::read_dir(data.path("WebView")).unwrap().count(), 0);
}

#[test]
fn a_scan_knows_its_biggest_files_and_what_kinds_they_are() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"videos\holiday.mp4", 900_000);
    tree.write(r"videos\clip.mkv", 300_000);
    tree.write(r"docs\notes.pdf", 20_000);
    tree.write(r"project\node_modules\pkg\index.js", 40_000_000);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    let meta = scan_and_commit(&store, "000000000001-a", 1, &v);
    let insights = store.load_insights(&meta).unwrap();

    assert_eq!(insights.files[0].path, r"project\node_modules\pkg\index.js");
    assert_eq!(insights.files[1].path, r"videos\holiday.mp4");
    assert_eq!(insights.files[1].kind, "video");
    let kind = |k: &str| insights.kinds.iter().find(|s| s.kind == k).unwrap();
    assert_eq!(kind("video").size, 1_200_000);
    assert_eq!(kind("video").count, 2);
    assert_eq!(kind("document").size, 20_000);
    let spot = insights.spots.iter().find(|s| s.id == "dev-deps").unwrap();
    assert_eq!(spot.size, 40_000_000);
    assert_eq!(spot.places, 1);
    assert_eq!(spot.largest, r"project\node_modules");
    let total: u64 = insights.ranges.iter().map(|r| r.size).sum();
    assert_eq!(total, 41_220_000);

    // The summary stored with the scan does not carry all that again.
    assert!(meta.summary.insights.is_none());
    let report = report_data(&store, None, &[v]);
    assert_eq!(report.volumes[0].insights["000000000001-a"], insights);
    assert_eq!(report.volumes[0].records.len(), 1);
}

/// Files and bytes below `dir`, the slow and plain way, not following links.
fn count_plainly(dir: &Path) -> (u64, u64, u64) {
    let (mut files, mut dirs, mut bytes) = (0, 0, 0);
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let kind = entry.file_type().unwrap();
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            dirs += 1;
            let (f, d, b) = count_plainly(&entry.path());
            files += f;
            dirs += d;
            bytes += b;
        } else {
            files += 1;
            bytes += entry.metadata().unwrap().len();
        }
    }
    (files, dirs, bytes)
}

#[test]
fn the_direct_listing_finds_exactly_what_windows_lists() {
    let tree = TestDir::new("tree");
    // More than one 64 KB read of the kernel's directory call.
    for i in 0..3000 {
        tree.write(
            &format!(r"many\file-with-a-fairly-long-name-{i:05}.bin"),
            i % 7,
        );
    }
    tree.write(r"中文目录\照片 2026\假期 视频.mp4", 4096);
    tree.write(r"sp ace\.hidden", 10);
    tree.write(r"noext\README", 20);
    // Beyond MAX_PATH, in the middle of the tree.
    let long = "x".repeat(60);
    tree.write(
        &format!(r"{long}\{long}\{long}\{long}\{long}\deep.bin"),
        777,
    );
    fs::create_dir_all(tree.path(r"empty\inner")).unwrap();
    // A link is listed, not followed.
    let outside = TestDir::new("outside");
    outside.write("not-counted.bin", 999_999);
    let made = Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(tree.path("junction"))
        .arg(&outside.0)
        .output()
        .unwrap();
    assert!(made.status.success(), "could not make a junction");

    let (files, dirs, bytes) = count_plainly(&tree.0);
    let (summary, snapshot) = scan_root(&tree.0, false, &Progress::default());
    assert_eq!(summary.files, files);
    assert_eq!(summary.dirs, dirs);
    assert_eq!(summary.bytes, bytes);
    assert_eq!(summary.skipped, 0);
    assert!(summary.unread_dirs.is_empty());
    let found = snapshot.unwrap().dirs().unwrap();
    let names: Vec<String> = found
        .iter()
        .map(|d| d.path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    for name in ["many", "中文目录", "照片 2026", "sp ace", "empty", "inner"] {
        assert!(names.iter().any(|n| n == name), "{name} in {names:?}");
    }
    assert!(!names.iter().any(|n| n == "junction"), "not followed");
    let big = summary.insights.unwrap();
    assert!(big
        .files
        .iter()
        .any(|f| f.path.ends_with("假期 视频.mp4") && f.kind == "video"));
    assert!(big.files.iter().any(|f| f.path.ends_with("deep.bin")));

    // A path that does not exist is a failed scan, not an empty one.
    let (gone, snapshot) = scan_root(&tree.path("no-such-folder"), false, &Progress::default());
    assert_eq!(gone.status, ScanStatus::Failed);
    assert!(snapshot.is_none());
}

#[test]
fn insights_cross_from_the_helper_to_the_app_and_stay_out_of_the_marker() {
    // The helper hands its summary over as JSON, and the app stores it with the scan.
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"a\big.iso", 5000);
    let (summary, snapshot) = scan_root(&tree.0, false, &Progress::default());
    let sent = serde_json::to_vec(&summary).unwrap();
    let received: diskly_core::scan::ScanSummary = serde_json::from_slice(&sent).unwrap();
    assert_eq!(received.insights, summary.insights);
    assert_eq!(
        received.insights.as_ref().unwrap().files[0].path,
        r"a\big.iso"
    );

    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    commit_run(
        &store,
        "000000000001-a",
        1,
        0.1,
        false,
        vec![VolumeResult {
            volume: v,
            summary: received,
            snapshot,
        }],
        3,
    );
    let marker = fs::read_to_string(data.path(r"history\v-g1\000000000001-a.json")).unwrap();
    assert!(!marker.contains("big.iso"), "the marker stays small");
    let meta = &store.list("v-g1").entries[0];
    assert_eq!(store.load_insights(meta).unwrap().files[0].kind, "archive");
    // A summary from before this existed still reads.
    let old = r#"{"status":"complete","error":null,"engine":"mft","mft_fallback":null,"elevated":true,"seconds":1.0,"files":1,"dirs":1,"bytes":1,"skipped":0,"disk_total":1,"disk_free":1,"unread_dirs":[]}"#;
    let old: diskly_core::scan::ScanSummary = serde_json::from_str(old).unwrap();
    assert!(old.insights.is_none());
}

#[test]
fn a_stored_scan_from_before_this_existed_still_gets_its_insights() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    tree.write(r"a\big.iso", 5000);
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    let meta = scan_and_commit(&store, "000000000001-a", 1, &v);
    fs::remove_file(
        data.path(r"history\v-g1")
            .join(format!("{}.insights.json", meta.scan_id)),
    )
    .unwrap();
    let report = report_data(&store, None, &[v]);
    let insights = &report.volumes[0].insights["000000000001-a"];
    assert_eq!(insights.files[0].path, r"a\big.iso");
    assert_eq!(insights.files[0].kind, "archive");
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

#[test]
fn reopening_a_pruned_run_keeps_its_identity_and_only_its_summary() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    let mut first = None;
    for i in 1..=5 {
        tree.write(r"folder\a.bin", i * 1024);
        let id = format!("{i:012}-a");
        scan_and_commit(&store, &id, i as u64, &v);
        let mut run: RunRecord = store
            .list_runs()
            .into_iter()
            .find(|r: &RunRecord| r.scan_id == id)
            .unwrap();
        write_report(&store, &mut run, std::slice::from_ref(&v)).unwrap();
        if i == 1 {
            first = Some(run);
        }
    }
    let mut first = first.unwrap();
    assert_eq!(
        report_availability(&store, &first),
        ReportAvailability::Summary
    );
    // Several reports in one second may reuse a pruned filename. The embedded
    // scan ID, not the filename alone, decides whose details it holds.
    if let Some(path) = store.report_path(first.report_file.as_deref().unwrap()) {
        let saved = diskly_core::report::saved_data(&fs::read_to_string(path).unwrap()).unwrap();
        assert_ne!(saved["run"]["scan_id"], first.scan_id);
    }
    let path = prepare_report(&store, &mut first, &[]).unwrap();
    let saved = diskly_core::report::saved_data(&fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(saved["run"]["scan_id"], first.scan_id);
    assert_eq!(saved["volumes"][0]["records"][0]["id"], first.scan_id);
    assert_eq!(saved["volumes"][0]["records"][0]["files"], 1);
    assert_eq!(saved["run"]["volumes"][0]["bytes"], 1024);
    assert!(saved["volumes"][0]["snapshots"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["id"] != first.scan_id));
    assert_eq!(
        report_availability(&store, &first),
        ReportAvailability::Summary,
        "a saved summary is not a saved detailed report"
    );
    assert_eq!(
        list_run_views(&store)
            .into_iter()
            .find(|r| r.run.scan_id == first.scan_id)
            .unwrap()
            .availability,
        ReportAvailability::Summary
    );
    let footprint = store.footprint();
    assert!(footprint.scans_kept <= 3 && footprint.reports_kept <= 3);
}

#[test]
fn a_saved_report_preserves_details_after_the_snapshot_is_pruned() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    tree.write(r"leaf\image.vhdx", 1024);
    scan_and_commit(&store, "000000000001-a", 1, &v);
    let mut first: RunRecord = store.list_runs().remove(0);
    assert_eq!(
        report_availability(&store, &first),
        ReportAvailability::Rebuildable
    );
    let original = write_report(&store, &mut first, std::slice::from_ref(&v)).unwrap();
    for i in 2..=5 {
        tree.write(r"leaf\image.vhdx", i * 1024);
        scan_and_commit(&store, &format!("{i:012}-a"), i as u64, &v);
    }
    store.prune(&v.identity.key().unwrap(), 3).unwrap();
    assert_eq!(
        report_availability(&store, &first),
        ReportAvailability::Saved
    );
    let old_html = fs::read_to_string(&original).unwrap();
    fs::write(
        &original,
        old_html.replace("<title>Diskly 报告</title>", "<title>Legacy</title>"),
    )
    .unwrap();
    let refreshed = prepare_report(&store, &mut first, &[]).unwrap();
    assert_eq!(
        refreshed, original,
        "reopening does not consume another report slot"
    );
    let html = fs::read_to_string(refreshed).unwrap();
    assert!(!html.contains("<title>Legacy</title>"));
    let saved = diskly_core::report::saved_data(&html).unwrap();
    assert_eq!(saved["volumes"][0]["snapshots"][0]["id"], first.scan_id);
    assert_eq!(saved["volumes"][0]["table"]["sizes"][0][0], 1024);
    assert_eq!(
        saved["volumes"][0]["insights"][&first.scan_id]["files"][0]["path"],
        r"leaf\image.vhdx"
    );
}

#[test]
fn a_wrong_or_damaged_cached_report_is_rebuilt_for_the_requested_run() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    tree.write("a.bin", 1024);
    scan_and_commit(&store, "000000000001-a", 1, &v);
    let mut run: RunRecord = store.list_runs().remove(0);
    let path = write_report(&store, &mut run, std::slice::from_ref(&v)).unwrap();
    let mut wrong = serde_json::to_value(report_data(&store, Some(&run), &[])).unwrap();
    wrong["run"]["scan_id"] = "000000000999-wrong".into();
    fs::write(&path, diskly_core::report::render(&wrong).unwrap()).unwrap();
    assert_eq!(
        report_availability(&store, &run),
        ReportAvailability::Rebuildable
    );
    let correct = prepare_report(&store, &mut run, &[]).unwrap();
    let saved = diskly_core::report::saved_data(&fs::read_to_string(&correct).unwrap()).unwrap();
    assert_eq!(saved["run"]["scan_id"], run.scan_id);
    fs::write(correct, "truncated").unwrap();
    assert!(prepare_report(&store, &mut run, &[]).unwrap().is_file());
}

#[test]
fn an_archived_disconnected_volume_is_still_in_its_run_report() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    tree.write("a.bin", 1024);
    scan_and_commit(&store, "000000000001-a", 1, &v);
    let mut run: RunRecord = store.list_runs().remove(0);
    run.volumes[0].volume_key = Some("v-no-longer-retained".into());
    let report = report_data(&store, Some(&run), &[]);
    let archived = report
        .volumes
        .iter()
        .find(|v| v.key.as_deref() == Some("v-no-longer-retained"))
        .unwrap();
    assert_eq!(archived.letter, 'T');
    assert!(!archived.connected && archived.snapshots.is_empty() && archived.records.is_empty());
    assert_eq!(archived.this_run.as_ref().unwrap().files, 1);
    assert_eq!(
        report_availability(&store, &run),
        ReportAvailability::Summary
    );
    run.volumes[0].stored = false;
    assert_eq!(report_availability(&store, &run), ReportAvailability::None);
}

#[test]
fn reopening_recovers_partial_details_without_losing_the_cached_disk() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    let store = Store::open(&data.0).unwrap();
    tree.write("a.bin", 1024);
    let volumes = [volume(&tree.0, 'T', "g1", 1), volume(&tree.0, 'U', "g2", 2)];
    let results = volumes
        .iter()
        .map(|v| {
            let (summary, snapshot) = scan_root(&v.root, false, &Progress::default());
            VolumeResult {
                volume: v.clone(),
                summary,
                snapshot,
            }
        })
        .collect();
    let mut run = commit_run(&store, "000000000001-a", 1, 0.1, false, results, 3);
    let path = write_report(&store, &mut run, &volumes).unwrap();
    let mut saved = diskly_core::report::saved_data(&fs::read_to_string(&path).unwrap()).unwrap();
    saved["volumes"].as_array_mut().unwrap().truncate(1);
    fs::write(&path, diskly_core::report::render(&saved).unwrap()).unwrap();
    for i in 2..=4 {
        tree.write("a.bin", i * 1024);
        scan_and_commit(&store, &format!("{i:012}-a"), i as u64, &volumes[0]);
    }
    store.prune(&volumes[0].identity.key().unwrap(), 2).unwrap();
    assert_eq!(
        report_availability(&store, &run),
        ReportAvailability::Rebuildable
    );
    let path = prepare_report(&store, &mut run, &volumes).unwrap();
    let saved = diskly_core::report::saved_data(&fs::read_to_string(&path).unwrap()).unwrap();
    for volume in saved["volumes"].as_array().unwrap() {
        let i = volume["snapshots"]
            .as_array()
            .unwrap()
            .iter()
            .position(|s| s["id"] == run.scan_id)
            .unwrap();
        assert_eq!(volume["table"]["sizes"][i][0], 1024);
    }
    assert_eq!(report_availability(&store, &run), ReportAvailability::Saved);
    // A third, no-longer-retained disk makes this a partial report, not complete.
    let mut missing = run.volumes[0].clone();
    missing.volume_key = Some("v-missing".into());
    run.volumes.push(missing);
    assert_eq!(
        report_availability(&store, &run),
        ReportAvailability::Partial
    );
}

#[test]
fn a_format_one_report_keeps_its_last_copy_of_the_scan() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    tree.write("old.bin", 1024);
    scan_and_commit(&store, "000000000001-a", 1, &v);
    let mut run: RunRecord = store.list_runs().remove(0);
    let path = write_report(&store, &mut run, std::slice::from_ref(&v)).unwrap();
    let mut legacy = serde_json::to_value(report_data(&store, Some(&run), &[])).unwrap();
    // The actual format-1 schema in c260f56: before footprint, theme and insights.
    legacy["format"] = 1.into();
    for field in ["theme", "footprint"] {
        legacy.as_object_mut().unwrap().remove(field);
    }
    for volume in legacy["volumes"].as_array_mut().unwrap() {
        for field in ["insights", "records"] {
            volume.as_object_mut().unwrap().remove(field);
        }
    }
    fs::write(&path, diskly_core::report::render(&legacy).unwrap()).unwrap();
    for i in 2..=4 {
        scan_and_commit(&store, &format!("{i:012}-a"), i, &v);
    }
    store.prune(&v.identity.key().unwrap(), 2).unwrap();
    assert_eq!(report_availability(&store, &run), ReportAvailability::Saved);
    let reopened = prepare_report(&store, &mut run, &[]).unwrap();
    assert_eq!(reopened, path);
    let saved = diskly_core::report::saved_data(&fs::read_to_string(reopened).unwrap()).unwrap();
    assert_eq!(saved["volumes"][0]["snapshots"][0]["id"], run.scan_id);
    assert_eq!(saved["volumes"][0]["table"]["sizes"][0][0], 1024);
}

#[test]
fn reopening_a_summary_keeps_its_numbers_and_an_unscanned_cached_disk() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    tree.write("a.bin", 1024);
    scan_and_commit(&store, "000000000001-a", 1, &v);
    let mut run: RunRecord = store.list_runs().remove(0);
    let path = write_report(&store, &mut run, std::slice::from_ref(&v)).unwrap();
    let mut cached = diskly_core::report::saved_data(&fs::read_to_string(&path).unwrap()).unwrap();
    let mut carried = cached["volumes"][0].clone();
    carried["key"] = "v-offline".into();
    carried["letter"] = "U".into();
    carried["this_run"] = serde_json::Value::Null;
    cached["volumes"][0]["snapshots"] = serde_json::json!([]);
    cached["volumes"][0]["table"] = serde_json::to_value(NodeTable::default()).unwrap();
    cached["volumes"].as_array_mut().unwrap().push(carried);
    fs::write(&path, diskly_core::report::render(&cached).unwrap()).unwrap();
    for i in 2..=4 {
        scan_and_commit(&store, &format!("{i:012}-a"), i, &v);
    }
    store.prune(&v.identity.key().unwrap(), 2).unwrap();
    fs::write(
        data.path(&format!("records/{}.json", v.identity.key().unwrap())),
        "[]",
    )
    .unwrap();
    for _ in 0..2 {
        let reopened = prepare_report(&store, &mut run, &[]).unwrap();
        let saved =
            diskly_core::report::saved_data(&fs::read_to_string(reopened).unwrap()).unwrap();
        assert_eq!(saved["volumes"][0]["records"][0]["free"], v.free_bytes);
        assert!(saved["volumes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["key"] == "v-offline"));
    }
}

#[test]
fn invalid_cached_tables_and_damaged_snapshots_are_not_available_details() {
    let (tree, data) = (TestDir::new("tree"), TestDir::new("data"));
    let store = Store::open(&data.0).unwrap();
    let v = volume(&tree.0, 'T', "g1", 1);
    tree.write("a.bin", 1024);
    let meta = scan_and_commit(&store, "000000000001-a", 1, &v);
    let mut run: RunRecord = store.list_runs().remove(0);
    let path = write_report(&store, &mut run, std::slice::from_ref(&v)).unwrap();
    let mut cached = diskly_core::report::saved_data(&fs::read_to_string(&path).unwrap()).unwrap();
    let mut healthy = cached["volumes"][0].clone();
    healthy["key"] = "v-healthy".into();
    healthy["letter"] = "U".into();
    healthy["this_run"] = serde_json::Value::Null;
    cached["volumes"].as_array_mut().unwrap().push(healthy);
    // A completely malformed disk is isolated too, without rejecting the page.
    cached["volumes"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"key": "v-broken", "snapshots": "damaged"}));
    let valid = cached["volumes"][0]["table"].clone();
    for (field, damaged) in [
        ("sizes", serde_json::json!([])),
        ("parents", serde_json::json!([0])),
        ("unread", serde_json::json!([[99]])),
    ] {
        cached["volumes"][0]["table"] = valid.clone();
        cached["volumes"][0]["table"][field] = damaged;
        fs::write(&path, diskly_core::report::render(&cached).unwrap()).unwrap();
        assert_eq!(
            report_availability(&store, &run),
            ReportAvailability::Rebuildable,
            "{field} must not be treated as usable detail"
        );
    }
    fs::write(
        data.path(&format!("history/{}/{}.dgs", meta.volume_key, meta.scan_id)),
        "damaged",
    )
    .unwrap();
    assert_eq!(
        report_availability(&store, &run),
        ReportAvailability::Summary
    );
    let reopened = prepare_report(&store, &mut run, &[]).unwrap();
    let saved = diskly_core::report::saved_data(&fs::read_to_string(reopened).unwrap()).unwrap();
    assert!(saved["volumes"][0]["snapshots"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(saved["volumes"][0]["records"][0]["id"], run.scan_id);
    let volumes = saved["volumes"].as_array().unwrap();
    assert_eq!(volumes.len(), 2);
    let healthy = volumes.iter().find(|v| v["key"] == "v-healthy").unwrap();
    assert_eq!(healthy["table"]["sizes"][0][0], 1024);
}

#[test]
fn refreshing_an_old_report_under_budget_pressure_keeps_the_opened_page() {
    let data = TestDir::new("data");
    let store = Store::open(&data.0).unwrap();
    let budget = store.data_budget() as usize;
    let size = budget / 3 - 100;
    let first = data.path("reports/Diskly-0001.html");
    fs::write(&first, "a".repeat(size)).unwrap();
    for name in ["Diskly-0002.html", "Diskly-0003.html"] {
        fs::write(data.path(&format!("reports/{name}")), "b".repeat(size)).unwrap();
    }
    let html = "c".repeat(size + 1000);
    let refreshed = store.refresh_report("Diskly-0001.html", &html).unwrap();
    assert!(
        refreshed.is_file(),
        "budget enforcement removed the page being opened"
    );
    assert_eq!(fs::read_to_string(refreshed).unwrap(), html);
    assert!(diskly_core::store::folder_size(&data.0) <= budget as u64);
}
