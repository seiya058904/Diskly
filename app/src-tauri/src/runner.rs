//! One click on Scan: from choosing how to scan to the opened report.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use diskghost_core::{Progress, Snapshot};
use diskly_core::scan::{is_elevated, run_per_disk, scan_root, ScanStatus, ScanSummary};
use diskly_core::session::{commit_run, write_report, RunRecord, VolumeResult};
use diskly_core::store::{new_scan_id, now_unix, Store, KEEP_SNAPSHOTS};
use diskly_core::volumes::{fixed_volumes, Volume};
use serde::Serialize;
use tauri::ipc::Channel;
use windows_sys::Win32::Foundation::HWND;

use crate::helper::{Helper, StartError};
use crate::shell::open_in_browser;

const WAITING: u8 = 0;
const SCANNING: u8 = 1;
const DONE: u8 = 2;

/// What the window hears while a scan runs.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ScanEvent {
    Progress {
        phase: &'static str,
        seconds: f64,
        volumes: Vec<TrackView>,
    },
    Finished {
        scan_id: String,
        seconds: f64,
        cancelled: bool,
        stored: usize,
        declined: bool,
        error: Option<String>,
        run: Option<RunRecord>,
    },
}

#[derive(Clone, Serialize)]
pub struct TrackView {
    letter: char,
    state: &'static str,
    files: u64,
    bytes: u64,
    seconds: f64,
    /// Share of the used space seen so far. An estimate: hard links count once
    /// per name here, and the used space does not.
    estimate: f64,
}

/// One volume during a scan.
struct Track {
    volume: Volume,
    progress: Progress,
    state: AtomicU8,
    started: Mutex<Option<Instant>>,
    finished_in: Mutex<Option<f64>>,
}

impl Track {
    fn new(volume: Volume) -> Track {
        Track {
            volume,
            progress: Progress::default(),
            state: AtomicU8::new(WAITING),
            started: Mutex::new(None),
            finished_in: Mutex::new(None),
        }
    }

    fn set_state(&self, state: u8) {
        let previous = self.state.swap(state, Ordering::Relaxed);
        if state == SCANNING && previous == WAITING {
            if let Ok(mut started) = self.started.lock() {
                *started = Some(Instant::now());
            }
        }
        if state == DONE && previous != DONE {
            let took = self
                .started
                .lock()
                .ok()
                .and_then(|s| s.map(|i| i.elapsed().as_secs_f64()));
            if let Ok(mut finished) = self.finished_in.lock() {
                *finished = took;
            }
        }
    }

    fn view(&self) -> TrackView {
        let state = self.state.load(Ordering::Relaxed);
        let seconds = self
            .finished_in
            .lock()
            .ok()
            .and_then(|f| *f)
            .or_else(|| {
                self.started
                    .lock()
                    .ok()
                    .and_then(|s| s.map(|i| i.elapsed().as_secs_f64()))
            })
            .unwrap_or(0.0);
        let used = self.volume.used_bytes();
        let bytes = self.progress.bytes();
        let estimate = if used == 0 {
            0.0
        } else {
            (bytes as f64 / used as f64).min(0.99)
        };
        TrackView {
            letter: self.volume.letter,
            state: match state {
                WAITING => "waiting",
                SCANNING => "scanning",
                _ => "done",
            },
            files: self.progress.files(),
            bytes,
            seconds,
            estimate,
        }
    }
}

/// A scan in progress, as the rest of the app can reach it.
#[derive(Default)]
pub struct Control {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    tracks: Mutex<Vec<Arc<Track>>>,
}

impl Control {
    /// Make `tracks` the ones a cancel reaches. A cancel that came first was latched
    /// before this lock could be taken, so one or the other always stops them.
    fn install_tracks(&self, tracks: &[Arc<Track>]) {
        if let Ok(mut shared) = self.tracks.lock() {
            shared.clear();
            shared.extend_from_slice(tracks);
            if self.cancel.load(Ordering::Relaxed) {
                for t in tracks {
                    t.progress.cancel();
                }
            }
        }
    }

    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
        if let Ok(tracks) = self.tracks.lock() {
            for t in tracks.iter() {
                t.progress.cancel();
            }
        }
    }
}

type ScanResult = (ScanSummary, Option<Snapshot>);

fn cancelled_result() -> ScanResult {
    let mut summary = ScanSummary::failed("扫描已取消", 0.0);
    summary.status = ScanStatus::Cancelled;
    summary.error = None;
    (summary, None)
}

/// Scan time. Waiting for the user to answer a prompt is not part of it.
struct Clock(Mutex<Instant>);

impl Clock {
    fn new() -> Clock {
        Clock(Mutex::new(Instant::now()))
    }

    fn restart(&self) {
        if let Ok(mut started) = self.0.lock() {
            *started = Instant::now();
        }
    }

    fn seconds(&self) -> f64 {
        self.0.lock().map_or(0.0, |s| s.elapsed().as_secs_f64())
    }
}

fn walk_track(track: &Track) -> ScanResult {
    track.set_state(SCANNING);
    let result = scan_root(&track.volume.root, false, &track.progress);
    track.set_state(DONE);
    result
}

/// Scan what the helper could not, or everything for a normal scan.
fn walk_all(tracks: &[Arc<Track>], fallback: Option<&str>) -> Vec<ScanResult> {
    let mut results = run_per_disk(
        tracks.to_vec(),
        |t| t.volume.physical_disk,
        |t| walk_track(t),
        |t| {
            t.set_state(DONE);
            (ScanSummary::failed("扫描时发生内部错误", 0.0), None)
        },
    );
    if let Some(reason) = fallback {
        for (summary, _) in &mut results {
            summary.mft_fallback = Some(reason.to_string());
        }
    }
    results
}

/// Let the elevated helper scan `tracks`. A volume it gives no result for comes
/// back as `None`, so it can be walked instead.
fn scan_with_helper(
    helper: &Helper,
    tracks: &[Arc<Track>],
    control: &Control,
) -> Vec<Option<ScanResult>> {
    helper.keep_alive();
    let mut last_alive = Instant::now();
    let mut cancel_sent = false;
    loop {
        if last_alive.elapsed() > Duration::from_secs(3) {
            helper.keep_alive();
            last_alive = Instant::now();
        }
        if !cancel_sent && control.cancel.load(Ordering::Relaxed) {
            helper.cancel();
            cancel_sent = true;
        }
        for count in helper.counts() {
            if let Some(track) = tracks.iter().find(|t| t.volume.letter == count.letter) {
                track.progress.set_counts(count.files, count.bytes);
                track.set_state(count.state);
            }
        }
        if helper.finished() || helper.gone() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    tracks
        .iter()
        .map(|t| {
            let result = helper.result(t.volume.letter);
            t.set_state(DONE);
            result
        })
        .collect()
}

fn scan_fast(
    store: &Store,
    tracks: &[Arc<Track>],
    control: &Arc<Control>,
    owner: HWND,
    phase: &Mutex<&'static str>,
    clock: &Clock,
) -> (Vec<ScanResult>, bool) {
    // Nobody wants this scan any more, so nobody should be asked for rights for it.
    if control.cancel.load(Ordering::Relaxed) {
        let results = tracks
            .iter()
            .map(|t| {
                t.set_state(DONE);
                cancelled_result()
            })
            .collect();
        return (results, false);
    }
    if is_elevated() {
        // Already administrator: no prompt, no helper.
        let results = run_per_disk(
            tracks.to_vec(),
            |t| t.volume.physical_disk,
            |t| {
                t.set_state(SCANNING);
                let result = scan_root(&t.volume.root, true, &t.progress);
                t.set_state(DONE);
                result
            },
            |t| {
                t.set_state(DONE);
                (ScanSummary::failed("扫描时发生内部错误", 0.0), None)
            },
        );
        return (results, false);
    }
    let letters: String = tracks.iter().map(|t| t.volume.letter).collect();
    store.clear_stale_helper_files(Duration::from_secs(3600));
    let dir = store.helper_dir();
    let started = Helper::start(dir, &letters, owner);
    clock.restart();
    match started {
        Err(StartError::Declined) => {
            set_phase(phase, "scanning");
            let reason = "没有获得管理员权限";
            (walk_all(tracks, Some(reason)), true)
        }
        Err(StartError::Failed(why)) => {
            set_phase(phase, "scanning");
            (walk_all(tracks, Some(&why)), false)
        }
        Ok(helper) => {
            set_phase(phase, "scanning");
            let results = scan_with_helper(&helper, tracks, control);
            helper.finish();
            store.clear_helper_files(helper.token());
            // Whatever the helper left undone is walked, unless the user stopped it.
            let cancelled = control.cancel.load(Ordering::Relaxed);
            let results: Vec<Option<ScanResult>> = results
                .into_iter()
                .map(|r| r.filter(|(s, _)| cancelled || s.status != ScanStatus::Cancelled))
                .collect();
            let missing: Vec<Arc<Track>> = tracks
                .iter()
                .zip(&results)
                .filter(|(_, r)| r.is_none())
                .map(|(t, _)| t.clone())
                .collect();
            let mut walked = if missing.is_empty() || cancelled {
                Vec::new()
            } else {
                for t in &missing {
                    t.state.store(WAITING, Ordering::Relaxed);
                }
                walk_all(&missing, Some("极速扫描未能完成"))
            }
            .into_iter();
            let merged = results
                .into_iter()
                .map(|r| r.or_else(|| walked.next()).unwrap_or_else(cancelled_result))
                .collect();
            (merged, false)
        }
    }
}

fn set_phase(phase: &Mutex<&'static str>, value: &'static str) {
    if let Ok(mut p) = phase.lock() {
        *p = value;
    }
}

/// Run a whole scan on this thread, reporting on `events`.
pub fn run(
    store: Store,
    mode: String,
    control: Arc<Control>,
    events: Channel<ScanEvent>,
    owner: HWND,
) {
    let clock = Clock::new();
    let started_at = now_unix();
    let scan_id = new_scan_id();
    store.make_room();
    let volumes = fixed_volumes();
    let (scannable, blocked): (Vec<Volume>, Vec<Volume>) =
        volumes.into_iter().partition(|v| v.problem.is_none());
    let tracks: Vec<Arc<Track>> = scannable
        .into_iter()
        .map(|v| Arc::new(Track::new(v)))
        .collect();
    control.install_tracks(&tracks);

    let phase = Mutex::new(if mode == "fast" {
        "consent"
    } else {
        "scanning"
    });
    let done = AtomicBool::new(false);
    let (results, declined) = std::thread::scope(|scope| {
        scope.spawn(|| {
            while !done.load(Ordering::Relaxed) {
                let current = phase.lock().map_or("scanning", |p| *p);
                let _ = events.send(ScanEvent::Progress {
                    phase: current,
                    seconds: clock.seconds(),
                    volumes: tracks.iter().map(|t| t.view()).collect(),
                });
                std::thread::sleep(Duration::from_millis(120));
            }
        });
        let outcome = if mode == "fast" {
            scan_fast(&store, &tracks, &control, owner, &phase, &clock)
        } else {
            (walk_all(&tracks, None), false)
        };
        set_phase(&phase, "saving");
        done.store(true, Ordering::Relaxed);
        outcome
    });
    let _ = events.send(ScanEvent::Progress {
        phase: "saving",
        seconds: clock.seconds(),
        volumes: tracks.iter().map(|t| t.view()).collect(),
    });

    let mut scanned: Vec<VolumeResult> = tracks
        .iter()
        .zip(results)
        .map(|(track, (summary, snapshot))| VolumeResult {
            volume: track.volume.clone(),
            summary,
            snapshot,
        })
        .collect();
    for volume in blocked {
        let problem = volume.problem.clone().unwrap_or_default();
        scanned.push(VolumeResult {
            volume,
            summary: ScanSummary::failed(problem, 0.0),
            snapshot: None,
        });
    }

    let seconds = clock.seconds();
    let cancelled = control.cancel.load(Ordering::Relaxed);
    let mut run = commit_run(
        &store,
        &scan_id,
        started_at,
        seconds,
        declined,
        scanned,
        KEEP_SNAPSHOTS,
    );
    let stored = run.volumes.iter().filter(|v| v.stored).count();

    let mut error = None;
    if stored > 0 {
        let connected = fixed_volumes();
        match write_report(&store, &mut run, &connected) {
            // Tests set this so a run of them does not fill the browser with tabs.
            Ok(_) if std::env::var_os("DISKLY_NO_BROWSER").is_some() => {}
            Ok(path) if !cancelled => {
                if let Err(e) = open_in_browser(&path) {
                    error = Some(format!("报告已保存，但无法打开浏览器：{e}"));
                }
            }
            Ok(_) => {}
            Err(e) => error = Some(format!("无法生成报告：{e}")),
        }
    } else if !cancelled {
        let why = run
            .volumes
            .iter()
            .find_map(|v| v.error.clone())
            .unwrap_or_else(|| "没有可以扫描的磁盘".to_string());
        error = Some(why);
    }

    control.running.store(false, Ordering::Relaxed);
    let _ = events.send(ScanEvent::Finished {
        scan_id,
        seconds: clock.seconds(),
        cancelled,
        stored,
        declined,
        error,
        run: Some(run),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU32;
    use std::sync::Barrier;

    use diskly_core::volumes::VolumeIdentity;
    use tauri::ipc::InvokeResponseBody;

    const FILES: u64 = 40;
    static NEXT: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> TempDir {
            let n = NEXT.fetch_add(1, Ordering::SeqCst);
            let dir =
                std::env::temp_dir().join(format!("diskly-runner-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn with_files() -> TempDir {
            let dir = TempDir::new();
            for i in 0..FILES {
                std::fs::write(dir.0.join(format!("{i}.bin")), [7u8; 16]).unwrap();
            }
            dir
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn track_of(dir: &TempDir) -> Arc<Track> {
        Arc::new(Track::new(Volume {
            letter: 'T',
            root: dir.0.clone(),
            label: "test".into(),
            identity: VolumeIdentity {
                guid: Some("g".into()),
                serial: Some(1),
                file_system: Some("NTFS".into()),
            },
            total_bytes: 1,
            free_bytes: 0,
            physical_disk: None,
            problem: None,
        }))
    }

    fn assert_walked_nothing(results: &[ScanResult], tracks: &[Arc<Track>]) {
        for ((summary, snapshot), track) in results.iter().zip(tracks) {
            assert_eq!(summary.status, ScanStatus::Cancelled);
            assert_eq!(summary.files, 0, "the walk must not read the disk");
            assert_eq!(track.progress.files(), 0);
            assert!(snapshot.is_none());
        }
    }

    #[test]
    fn a_cancel_before_the_tracks_exist_stops_the_walk() {
        let dir = TempDir::with_files();
        let tracks = vec![track_of(&dir)];
        let control = Arc::new(Control::default());
        let cancelled = Arc::new(Barrier::new(2));
        let clicker = {
            let (control, cancelled) = (control.clone(), cancelled.clone());
            std::thread::spawn(move || {
                control.request_cancel();
                cancelled.wait();
            })
        };
        cancelled.wait();
        control.install_tracks(&tracks);
        clicker.join().unwrap();
        assert_walked_nothing(&walk_all(&tracks, None), &tracks);
    }

    #[test]
    fn a_cancel_racing_the_tracks_always_reaches_them() {
        let dir = TempDir::new();
        for _ in 0..500 {
            let tracks = vec![track_of(&dir)];
            let control = Arc::new(Control::default());
            let start = Arc::new(Barrier::new(2));
            let clicker = {
                let (control, start) = (control.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    control.request_cancel();
                })
            };
            start.wait();
            control.install_tracks(&tracks);
            clicker.join().unwrap();
            assert!(tracks[0].progress.cancelled());
        }
    }

    #[test]
    fn a_cancel_after_the_tracks_exist_stops_the_walk() {
        let dir = TempDir::with_files();
        let tracks = vec![track_of(&dir)];
        let control = Control::default();
        control.install_tracks(&tracks);
        assert!(!tracks[0].progress.cancelled());
        control.request_cancel();
        assert_walked_nothing(&walk_all(&tracks, None), &tracks);
    }

    #[test]
    fn the_cancel_of_one_scan_does_not_reach_the_next() {
        let dir = TempDir::with_files();
        let control = Control::default();
        let first = vec![track_of(&dir)];
        control.request_cancel();
        control.install_tracks(&first);
        assert!(first[0].progress.cancelled());

        // What start_scan does before the next run.
        control.cancel.store(false, Ordering::Relaxed);
        let second = vec![track_of(&dir)];
        control.install_tracks(&second);
        let results = walk_all(&second, None);
        assert_eq!(results[0].0.status, ScanStatus::Complete);
        assert_eq!(results[0].0.files, FILES);
    }

    #[test]
    fn a_cancel_after_the_end_changes_nothing_that_was_found() {
        let dir = TempDir::with_files();
        let tracks = vec![track_of(&dir)];
        let control = Control::default();
        control.install_tracks(&tracks);
        let results = walk_all(&tracks, None);
        control.request_cancel();
        assert_eq!(results[0].0.status, ScanStatus::Complete);
        assert_eq!(results[0].0.files, FILES);
    }

    #[test]
    fn a_fast_scan_cancelled_early_asks_for_nothing_and_reads_nothing() {
        let (dir, data) = (TempDir::with_files(), TempDir::new());
        let tracks = vec![track_of(&dir)];
        let control = Arc::new(Control::default());
        control.request_cancel();
        control.install_tracks(&tracks);
        let store = Store::open(&data.0).unwrap();
        let phase = Mutex::new("consent");
        let (results, declined) = scan_fast(
            &store,
            &tracks,
            &control,
            std::ptr::null_mut(),
            &phase,
            &Clock::new(),
        );
        assert!(!declined);
        assert_walked_nothing(&results, &tracks);
        assert_eq!(tracks[0].view().state, "done");
    }

    /// The whole of `run` on this machine's disks: it may only end this quickly and
    /// with nothing stored because the walk stops at once.
    fn run_cancelled_from_the_start(mode: &str) {
        std::env::set_var("DISKLY_NO_BROWSER", "1");
        let data = TempDir::new();
        let store = Store::open(&data.0).unwrap();
        let control = Arc::new(Control::default());
        control.running.store(true, Ordering::Relaxed);
        control.request_cancel();
        let finished = Arc::new(Mutex::new(None::<serde_json::Value>));
        let events = {
            let finished = finished.clone();
            Channel::new(move |body| {
                if let InvokeResponseBody::Json(text) = body {
                    let event: serde_json::Value = serde_json::from_str(&text).unwrap();
                    if event["kind"] == "finished" {
                        *finished.lock().unwrap() = Some(event);
                    }
                }
                Ok(())
            })
        };
        run(
            store,
            mode.to_string(),
            control.clone(),
            events,
            std::ptr::null_mut(),
        );
        assert!(!control.running.load(Ordering::Relaxed));
        let event = finished.lock().unwrap().take().expect("a final event");
        assert_eq!(event["cancelled"], true);
        assert_eq!(event["stored"], 0);
        assert!(event["error"].is_null(), "{event}");
        for volume in event["run"]["volumes"].as_array().unwrap() {
            assert_eq!(volume["files"], 0, "{volume}");
        }
    }

    #[test]
    fn a_normal_run_cancelled_from_the_start_reads_no_disk() {
        run_cancelled_from_the_start("normal");
    }

    #[test]
    fn a_fast_run_cancelled_from_the_start_reads_no_disk() {
        run_cancelled_from_the_start("fast");
    }
}
