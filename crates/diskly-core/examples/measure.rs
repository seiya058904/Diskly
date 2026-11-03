//! Times the steps from a scan to a finished report, on real disks, into a throwaway
//! data folder. Prints numbers only, no paths, so its output can be kept in
//! docs/benchmarks. Run it as administrator for `--mft`.
//!
//! `cargo run --release -p diskly-core --example measure -- <data folder> [--mft] [--runs N]`

use std::path::PathBuf;
use std::time::Instant;

use diskghost_core::Progress;
use diskly_core::scan::{run_per_disk, scan_root};
use diskly_core::session::{commit_run, write_report, VolumeResult};
use diskly_core::store::{folder_size, new_scan_id, now_unix, Store, KEEP_SNAPSHOTS};
use diskly_core::volumes::fixed_volumes;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let data = PathBuf::from(args.first().expect("a data folder"));
    let mft = args.iter().any(|a| a == "--mft");
    let runs = args
        .iter()
        .position(|a| a == "--runs")
        .and_then(|i| args.get(i + 1))
        .and_then(|n| n.parse().ok())
        .unwrap_or(1);
    let store = Store::open(&data).expect("cannot open the data folder");
    let volumes: Vec<_> = fixed_volumes()
        .into_iter()
        .filter(|v| v.problem.is_none())
        .collect();

    for _ in 0..runs {
        store.make_room();
        let started = Instant::now();
        let results = run_per_disk(
            volumes.clone(),
            |v| v.physical_disk,
            |v| {
                let at = Instant::now();
                let (summary, snapshot) = scan_root(&v.root, mft, &Progress::default());
                eprintln!(
                    "{}: {} {:.2} s, {} files, {} folders, {} unread",
                    v.letter,
                    summary.engine,
                    at.elapsed().as_secs_f64(),
                    summary.files,
                    summary.dirs,
                    summary.unread_dirs.len()
                );
                (v.clone(), summary, snapshot)
            },
            |_| panic!("a scan failed"),
        );
        let scanned = started.elapsed().as_secs_f64();

        let at = Instant::now();
        let id = new_scan_id();
        let mut run = commit_run(
            &store,
            &id,
            now_unix(),
            scanned,
            false,
            results
                .into_iter()
                .map(|(volume, summary, snapshot)| VolumeResult {
                    volume,
                    summary,
                    snapshot,
                })
                .collect(),
            KEEP_SNAPSHOTS,
        );
        let committed = at.elapsed().as_secs_f64();

        let at = Instant::now();
        let path = write_report(&store, &mut run, &volumes).expect("cannot write the report");
        let reported = at.elapsed().as_secs_f64();
        let page = std::fs::metadata(&path).map_or(0, |m| m.len());

        println!(
            "{{\"scan_s\":{scanned:.2},\"commit_s\":{committed:.2},\"report_s\":{reported:.2},\"total_s\":{:.2},\"report_mb\":{:.2},\"data_mb\":{:.1}}}",
            started.elapsed().as_secs_f64(),
            page as f64 / 1048576.0,
            folder_size(&data) as f64 / 1048576.0
        );
    }
}
