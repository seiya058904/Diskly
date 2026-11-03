//! The Diskly window: a small launcher for scans. The report it opens in the
//! browser is the real interface.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod helper;
mod runner;
mod shell;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use diskly_core::session::{write_report, RunRecord};
use diskly_core::store::{
    clear_webview_folder, folder_size, Footprint, Settings, Store, WEBVIEW_LIMIT,
};
use diskly_core::volumes::{fixed_volumes, Volume};
use runner::{Control, ScanEvent};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::utils::config::WindowEffectsConfig;
use tauri::utils::WindowEffect;
use tauri::{AppHandle, Manager, State, Theme, WebviewWindowBuilder};

/// WebView2 is a whole browser, and left alone it downloads components and fills
/// caches: 75 MB was measured for this small window, and the downloads go against
/// "no network". With these it stays at about 2 MB. It only ever shows the window's
/// own few files, so there is nothing a cache would speed up. Tauri's own default
/// flags are in the first one.
const WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,PersistentHistograms,SpareRendererForSitePerProcess \
     --disable-component-update --disable-background-networking --no-pings \
     --disable-gpu-shader-disk-cache --disk-cache-size=1048576 --media-cache-size=1048576";

/// Where version 0.1.0 left WebView2's files, by default, under the app's identifier.
const OLD_WEBVIEW_FOLDER: &str = r"io.github.seiya058904.diskly\EBWebView";

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
    program: Option<PathBuf>,
    footprint: Footprint,
    version: &'static str,
    mica: bool,
}

#[tauri::command(async)]
fn home(state: State<AppState>) -> Home {
    Home {
        volumes: fixed_volumes(),
        settings: state.store.load_settings(),
        last_run: state.store.list_runs::<RunRecord>().into_iter().next(),
        data_folder: state.store.root().to_path_buf(),
        program: std::env::current_exe().ok(),
        footprint: state.store.footprint(),
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
        let events = on_event.clone();
        let keeper = control.clone();
        let ran = catch_unwind(AssertUnwindSafe(|| {
            runner::run(store, mode, control, on_event, owner as _);
        }));
        // The window must not stay on "scanning" forever if something went wrong.
        if ran.is_err() {
            keeper.running.store(false, Ordering::Relaxed);
            let _ = events.send(ScanEvent::Finished {
                scan_id: String::new(),
                seconds: 0.0,
                cancelled: false,
                stored: 0,
                declined: false,
                error: Some("扫描时发生内部错误，旧的历史没有变化。".to_string()),
                run: None,
            });
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_scan(state: State<AppState>) {
    state.control.request_cancel();
}

#[tauri::command(async)]
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
    let valid = ["fast", "normal"].contains(&settings.scan_mode.as_str())
        && ["system", "light", "dark"].contains(&settings.theme.as_str());
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
    let webview_dir = store.webview_dir();

    // Before the window is there to use them, caches that have grown too large go.
    if folder_size(&webview_dir) > WEBVIEW_LIMIT {
        clear_webview_folder(&webview_dir);
    }
    if std::env::var_os("DISKLY_DATA_DIR").is_none() {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let old = PathBuf::from(local).join(OLD_WEBVIEW_FOLDER);
            clear_webview_folder(&old);
            if let Some(parent) = old.parent() {
                diskly_core::store::remove_session_folder(&old);
                diskly_core::store::remove_session_folder(parent);
            }
        }
    }
    // What an older version kept, or a limit passed: brought back in without a scan.
    {
        let store = store.clone();
        std::thread::spawn(move || store.enforce(store.data_budget()));
    }

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
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("the window is not configured")?;
            let window = WebviewWindowBuilder::from_config(app.handle(), &config)?
                .data_directory(webview_dir)
                .additional_browser_args(WEBVIEW_ARGS)
                .build()?;
            let _ = window.set_theme(theme);
            if mica {
                let _ = window.set_effects(WindowEffectsConfig {
                    effects: vec![WindowEffect::Mica],
                    ..WindowEffectsConfig::default()
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("cannot start the window: {e}");
        std::process::exit(1);
    }
}
