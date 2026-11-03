//! The Diskly window: a small launcher for scans. The report it opens in the
//! browser is the real interface.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod helper;
mod runner;
mod shell;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use diskly_core::session::{write_report, RunRecord};
use diskly_core::store::{Settings, Store};
use diskly_core::volumes::{fixed_volumes, Volume};
use runner::{Control, ScanEvent};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::utils::config::WindowEffectsConfig;
use tauri::utils::WindowEffect;
use tauri::{AppHandle, Manager, State, Theme};

struct AppState {
    store: Store,
    control: Arc<Control>,
    mica: bool,
}

#[derive(Serialize)]
struct Home {
    volumes: Vec<Volume>,
    settings: Settings,
    last_run: Option<RunRecord>,
    data_folder: PathBuf,
    version: &'static str,
    mica: bool,
}

#[tauri::command]
fn home(state: State<AppState>) -> Home {
    Home {
        volumes: fixed_volumes(),
        settings: state.store.load_settings(),
        last_run: state.store.list_runs::<RunRecord>().into_iter().next(),
        data_folder: state.store.root().to_path_buf(),
        version: env!("CARGO_PKG_VERSION"),
        mica: state.mica,
    }
}

#[tauri::command]
fn window_ready(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn start_scan(
    mode: String,
    on_event: Channel<ScanEvent>,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if mode != "fast" && mode != "normal" {
        return Err("未知的扫描方式".to_string());
    }
    let control = state.control.clone();
    if control.running.swap(true, Ordering::Relaxed) {
        return Err("已有扫描在进行".to_string());
    }
    control.cancel.store(false, Ordering::Relaxed);
    let store = state.store.clone();
    // The prompt should belong to this window, so it comes to the front.
    let owner = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map_or(0isize, |h| h.0 as isize);
    std::thread::spawn(move || {
        runner::run(store, mode, control, on_event, owner as _);
    });
    Ok(())
}

#[tauri::command]
fn cancel_scan(state: State<AppState>) {
    state.control.request_cancel();
}

#[tauri::command]
fn list_runs(state: State<AppState>) -> Vec<RunRecord> {
    state.store.list_runs()
}

/// Open the report of a run, making it again if its file is gone.
#[tauri::command(async)]
fn open_report(scan_id: String, state: State<AppState>) -> Result<(), String> {
    let store = &state.store;
    let mut run = store
        .list_runs::<RunRecord>()
        .into_iter()
        .find(|r| r.scan_id == scan_id)
        .ok_or("找不到这次扫描的记录")?;
    let existing = run
        .report_file
        .as_deref()
        .and_then(|f| store.report_path(f));
    let path = match existing {
        Some(path) => path,
        None => write_report(store, &mut run, &fixed_volumes())?,
    };
    shell::open_in_browser(&path)
}

#[tauri::command]
fn open_data_folder(state: State<AppState>) -> Result<(), String> {
    shell::open_file(state.store.root())
}

#[tauri::command]
fn save_settings(settings: Settings, state: State<AppState>) -> Result<(), String> {
    let valid = ["ask", "fast", "normal"].contains(&settings.scan_mode.as_str())
        && ["system", "light", "dark"].contains(&settings.theme.as_str())
        && (2..=1000).contains(&settings.keep_per_volume);
    if !valid {
        return Err("设置无效".to_string());
    }
    state
        .store
        .save_settings(&settings)
        .map_err(|e| e.to_string())
}

fn theme_of(name: &str) -> Option<Theme> {
    match name {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

/// Mica follows the window's theme, so the page's choice has to reach it too.
#[tauri::command]
fn apply_theme(theme: String, app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_theme(theme_of(&theme));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--mft-helper") {
        std::process::exit(helper::serve(&args[1..]));
    }

    // Tests set this so their scans stay out of the real history.
    let root = std::env::var_os("DISKLY_DATA_DIR")
        .map(PathBuf::from)
        .or_else(Store::default_root)
        .unwrap_or_else(|| PathBuf::from("Diskly-data"));
    let store = match Store::open(root) {
        Ok(store) => store,
        Err(e) => {
            eprintln!("cannot open the data folder: {e}");
            std::process::exit(1);
        }
    };
    let mica = shell::supports_mica();
    let theme = theme_of(&store.load_settings().theme);

    let result = tauri::Builder::default()
        .manage(AppState {
            store,
            control: Arc::new(Control::default()),
            mica,
        })
        .invoke_handler(tauri::generate_handler![
            home,
            window_ready,
            start_scan,
            cancel_scan,
            list_runs,
            open_report,
            open_data_folder,
            save_settings,
            apply_theme,
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_theme(theme);
                if mica {
                    let _ = window.set_effects(WindowEffectsConfig {
                        effects: vec![WindowEffect::Mica],
                        ..WindowEffectsConfig::default()
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("cannot start the window: {e}");
        std::process::exit(1);
    }
}
