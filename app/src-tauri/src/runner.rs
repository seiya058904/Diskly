//! One click on Scan: from choosing how to scan to the opened report.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use diskghost_core::{Progress, Snapshot};
use diskly_core::scan::{is_elevated, run_per_disk, scan_root, ScanStatus, ScanSummary};
use diskly_core::session::{commit_run, write_report, RunRecord, VolumeResult};
use diskly_core::store::{new_scan_id, now_unix, Store};
use diskly_core::volumes::{fixed_volumes, Volume};
use serde::Serialize;
use tauri::ipc::Channel;
use windows_sys::Win32::Foundation::HWND;

use crate::helper::{Helper, StartError};
use crate::shell::open_file;

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
) -> (Vec<ScanResult>, bool) {
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
    let dir = store.helper_dir();
    match Helper::start(dir, &letters, owner) {
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
            store.clear_helper_files(helper.token());
            // Whatever the helper left undone is walked, unless the user stopped it.
            let missing: Vec<Arc<Track>> = tracks
                .iter()
                .zip(&results)
                .filter(|(_, r)| r.is_none())
                .map(|(t, _)| t.clone())
                .collect();
            let cancelled = control.cancel.load(Ordering::Relaxed);
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
                .map(|r| {
                    r.or_else(|| walked.next()).unwrap_or_else(|| {
                        let mut s = ScanSummary::failed("扫描已取消", 0.0);
                        s.status = ScanStatus::Cancelled;
                        s.error = None;
                        (s, None)
                    })
                })
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
    let started = Instant::now();
    let started_at = now_unix();
    let scan_id = new_scan_id();
    let volumes = fixed_volumes();
    let (scannable, blocked): (Vec<Volume>, Vec<Volume>) =
        volumes.into_iter().partition(|v| v.problem.is_none());
    let tracks: Vec<Arc<Track>> = scannable
        .into_iter()
        .map(|v| Arc::new(Track::new(v)))
        .collect();
    if let Ok(mut shared) = control.tracks.lock() {
        shared.clone_from(&tracks);
    }

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
                    seconds: started.elapsed().as_secs_f64(),
                    volumes: tracks.iter().map(|t| t.view()).collect(),
                });
                std::thread::sleep(Duration::from_millis(120));
            }
        });
        let outcome = if mode == "fast" {
            scan_fast(&store, &tracks, &control, owner, &phase)
        } else {
            (walk_all(&tracks, None), false)
        };
        set_phase(&phase, "saving");
        done.store(true, Ordering::Relaxed);
        outcome
    });
    let _ = events.send(ScanEvent::Progress {
        phase: "saving",
        seconds: started.elapsed().as_secs_f64(),
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

    let keep = store.load_settings().keep_per_volume;
    let seconds = started.elapsed().as_secs_f64();
    let cancelled = control.cancel.load(Ordering::Relaxed);
    let mut run = commit_run(
        &store, &scan_id, started_at, seconds, declined, scanned, keep,
    );
    let stored = run.volumes.iter().filter(|v| v.stored).count();

    let mut error = None;
    if stored > 0 {
        let connected = fixed_volumes();
        match write_report(&store, &mut run, &connected) {
            Ok(path) if !cancelled => {
                if let Err(e) = open_file(&path) {
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
        seconds: started.elapsed().as_secs_f64(),
        cancelled,
        stored,
        declined,
        error,
        run: Some(run),
    });
}
