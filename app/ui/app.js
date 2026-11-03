"use strict";

/* The launcher window. All text from outside reaches the page as text nodes. */

const tauri = window.__TAURI__;
const invoke = tauri.core.invoke;

const view = document.getElementById("view");
const sheetLayer = document.getElementById("sheet-layer");

const state = {
  volumes: [],
  settings: { scan_mode: "ask", theme: "system", keep_per_volume: 20 },
  dataFolder: "",
  version: "",
  lastRun: null,
  screen: "home",
  /* null | { phase, seconds, volumes: [...] } */
  scan: null,
  outcome: null,
  /* A click on Cancel must show at once, before the scan has stopped. */
  cancelling: false,
};

/* ---- Small helpers ---- */

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

const svg = (viewBox, path, className) => {
  const ns = "http://www.w3.org/2000/svg";
  const root = document.createElementNS(ns, "svg");
  root.setAttribute("viewBox", viewBox);
  root.setAttribute("aria-hidden", "true");
  if (className) root.setAttribute("class", className);
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute("d", path);
  shape.setAttribute("fill", "none");
  shape.setAttribute("stroke", "currentColor");
  shape.setAttribute("stroke-width", "1.7");
  shape.setAttribute("stroke-linecap", "round");
  shape.setAttribute("stroke-linejoin", "round");
  root.append(shape);
  return root;
};

/* Sizes as Explorer shows them: 1 GB is 1024 MB. */
function bytes(n) {
  if (n === null || n === undefined) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

function count(n) {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(n);
}

function seconds(s) {
  if (s < 10) return `${s.toFixed(1)} 秒`;
  if (s < 60) return `${Math.round(s)} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${String(Math.round(s - m * 60)).padStart(2, "0")} 秒`;
}

function ago(unix) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 90) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)} 天前`;
  return dateTime(unix);
}

function dateTime(unix) {
  return new Date(unix * 1000).toLocaleString("zh-CN", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function applyTheme() {
  const theme = state.settings.theme;
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/* ---- Home ---- */

function diskRow(volume, track) {
  const used = volume.total_bytes ? (volume.total_bytes - volume.free_bytes) / volume.total_bytes : 0;
  const free = volume.problem ? null : el("span", { class: "disk-free", text: `${bytes(volume.free_bytes)} 可用` });
  const head = el("div", { class: "disk-head" },
    el("span", { class: "disk-letter", text: `${volume.letter}:` }),
    el("span", { class: "disk-label", text: volume.label || "本地磁盘" }),
    free);

  const fill = el("span");
  const rail = el("div", { class: "rail", "aria-hidden": "true" }, fill);
  let note = null;

  if (volume.problem) {
    fill.style.width = "0";
    note = el("div", { class: "disk-note problem" }, el("span", { text: volume.problem }));
  } else if (track) {
    rail.classList.add("scanning");
    if (track.state === "waiting") {
      rail.classList.add("waiting");
      note = el("div", { class: "disk-note" }, el("span", { text: "排队中" }));
    } else if (track.state === "scanning" && track.files === 0) {
      rail.classList.add("indeterminate");
      note = el("div", { class: "disk-note" }, el("span", { text: "正在读取…" }), el("span", { text: seconds(track.seconds) }));
    } else if (track.state === "scanning") {
      fill.style.width = `${Math.round(track.estimate * 100)}%`;
      note = el("div", { class: "disk-note" },
        el("span", { text: `约 ${Math.round(track.estimate * 100)}%，${count(track.files)} 个文件，${bytes(track.bytes)}` }),
        el("span", { text: seconds(track.seconds) }));
    } else {
      fill.style.width = "100%";
      note = el("div", { class: "disk-note" },
        el("span", { text: `${count(track.files)} 个文件，${bytes(track.bytes)}` }),
        el("span", { text: seconds(track.seconds) }));
    }
  } else {
    fill.style.width = `${(used * 100).toFixed(1)}%`;
  }

  return el("div", { class: "disk" }, head, rail, note);
}

function leadText() {
  if (state.scan) {
    if (state.cancelling) return { title: "正在取消…", small: "已完成的磁盘会保留" };
    switch (state.scan.phase) {
      case "consent":
        return { title: "请在 Windows 弹窗中确认", small: "极速扫描需要管理员权限，只读取文件表，不改动任何文件。" };
      case "saving":
        return { title: "正在生成报告…", small: `已用时 ${seconds(state.scan.seconds)}` };
      default:
        return { title: "正在扫描", small: `已用时 ${seconds(state.scan.seconds)}。结果只保存在这台电脑上。` };
    }
  }
  const outcome = state.outcome;
  if (outcome) {
    if (outcome.error) return { title: "扫描没有完成", small: outcome.error };
    if (outcome.cancelled) return { title: "已取消", small: outcome.stored ? "已完成的磁盘已保存，旧的历史没有变化。" : "没有新的结果，旧的历史没有变化。" };
    const fallback = outcome.declined ? "没有获得管理员权限，这次用了普通扫描。" : "";
    return { title: "扫描完成", small: `${fallback}用时 ${seconds(outcome.seconds)}，报告已在浏览器中打开。` };
  }
  if (state.lastRun) return { title: "看看和上次比有什么变化", small: `上次扫描是${ago(state.lastRun.started_at)}。` };
  return { title: "看看磁盘空间都去了哪里", small: "第一次扫描会记下现状，下次就能看到哪些目录变大或变小。" };
}

function renderHome() {
  const { title, small } = leadText();
  const tracks = state.scan ? state.scan.volumes : [];
  const list = state.volumes.length
    ? state.volumes.map((v) => diskRow(v, tracks.find((t) => t.letter === v.letter)))
    : [el("div", { class: "empty", text: "这台电脑上没有找到固定磁盘。" })];

  let action;
  if (state.scan) {
    action = el("button", {
      type: "button",
      class: "primary quiet",
      id: "scan-button",
      text: state.cancelling ? "正在取消…" : "取消",
      disabled: state.cancelling || state.scan.phase === "saving",
      onclick: cancelScan,
    });
  } else {
    action = el("button", {
      type: "button",
      class: "primary",
      id: "scan-button",
      text: state.outcome && !state.outcome.error ? "再次扫描" : "扫描",
      disabled: !state.volumes.some((v) => !v.problem),
      onclick: requestScan,
    });
  }

  const nav = el("div", { class: "nav-row" });
  if (!state.scan) {
    if (state.outcome && state.outcome.scanId && !state.outcome.error) {
      nav.append(el("button", { type: "button", class: "text-button accent", text: "打开报告", onclick: () => openReport(state.outcome.scanId) }));
    }
    nav.append(
      el("button", { type: "button", class: "text-button", text: "历史", onclick: () => show("history") }),
      el("button", { type: "button", class: "text-button", text: "设置", onclick: () => show("settings") }));
  }

  view.replaceChildren(
    el("h1", { class: "lead" }, title, el("small", { text: small })),
    el("section", { class: "group", "aria-label": "磁盘" }, ...list),
    el("div", { class: "actions" }, action, nav));
}

/* ---- First scan: how to scan ---- */

function askHowToScan() {
  const pick = (mode) => {
    sheetLayer.replaceChildren();
    state.settings.scan_mode = mode;
    invoke("save_settings", { settings: state.settings }).catch(() => {});
    startScan(mode);
  };
  const option = (title, detail, button, mode) => el("button", {
    type: "button", class: "row", "data-mode": mode, onclick: () => pick(mode),
  },
    el("span", { class: "row-main" },
      el("span", { class: "row-title", text: title }),
      el("span", { class: "row-detail", text: detail })),
    svg("0 0 8 13", "M1.5 1.5L6.5 6.5L1.5 11.5", "row-chevron"));
  const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "sheet-title" },
    el("h2", { id: "sheet-title", text: "用哪种方式扫描？" }),
    el("div", { class: "group" },
      option("极速扫描", "直接读取 NTFS 文件表，能看到所有目录，通常快很多。每次扫描要在 Windows 弹窗里确认一次管理员权限。只读取，不改动任何文件。", "", "fast"),
      option("普通扫描", "不需要任何权限。部分系统目录读不到，这些目录会标为“未知”。", "", "normal")),
    el("p", { class: "section-note", text: "两种方式的结果不能互相比较目录变化。之后可以在设置里更改。" }),
    el("div", { class: "actions" },
      el("button", { type: "button", class: "primary quiet", text: "取消", onclick: () => sheetLayer.replaceChildren() })));
  sheetLayer.replaceChildren(sheet);
  sheet.querySelector("button.row").focus();
}

/* ---- Scanning ---- */

function requestScan() {
  if (state.settings.scan_mode === "ask") askHowToScan();
  else startScan(state.settings.scan_mode);
}

async function startScan(mode) {
  state.outcome = null;
  state.cancelling = false;
  state.scan = {
    phase: mode === "fast" ? "consent" : "scanning",
    seconds: 0,
    volumes: state.volumes.filter((v) => !v.problem).map((v) => ({
      letter: v.letter, state: "waiting", files: 0, bytes: 0, seconds: 0, estimate: 0,
    })),
  };
  renderHome();
  const channel = new tauri.core.Channel();
  channel.onmessage = onScanEvent;
  try {
    await invoke("start_scan", { mode, onEvent: channel });
  } catch (error) {
    state.scan = null;
    state.outcome = { error: String(error) };
    renderHome();
  }
}

async function cancelScan() {
  state.cancelling = true;
  renderHome();
  try {
    await invoke("cancel_scan");
  } catch {
    /* It has already finished: the final event will say so. */
  }
}

function onScanEvent(event) {
  if (event.kind === "progress") {
    if (!state.scan) return;
    state.scan = { phase: event.phase, seconds: event.seconds, volumes: event.volumes };
    if (state.screen === "home") renderHome();
    return;
  }
  if (event.kind === "finished") {
    state.scan = null;
    state.cancelling = false;
    state.outcome = {
      scanId: event.scan_id,
      seconds: event.seconds,
      cancelled: event.cancelled,
      stored: event.stored > 0,
      declined: event.declined,
      error: event.error,
    };
    state.lastRun = event.run || state.lastRun;
    refreshVolumes();
  }
}

async function refreshVolumes() {
  try {
    const home = await invoke("home");
    state.volumes = home.volumes;
    state.lastRun = home.last_run;
  } catch {
    /* Keep what is on screen. */
  }
  if (state.screen === "home") renderHome();
}

async function openReport(scanId) {
  try {
    await invoke("open_report", { scanId });
  } catch (error) {
    state.outcome = { error: String(error) };
    renderHome();
  }
}

/* ---- History ---- */

function backButton() {
  return el("button", { type: "button", class: "back", "aria-label": "返回", onclick: () => show("home") },
    svg("0 0 15 15", "M9.5 2.5L4.5 7.5L9.5 12.5"));
}

function runDetail(run) {
  const parts = run.volumes.map((v) => {
    const name = `${v.letter}:`;
    if (v.status === "cancelled") return `${name} 已取消`;
    if (v.status === "failed") return `${name} 失败`;
    return name;
  });
  return `${parts.join("、")}，用时 ${seconds(run.seconds)}`;
}

async function renderHistory() {
  const head = el("div", { class: "view-head" }, backButton(), el("h1", { text: "历史" }));
  view.replaceChildren(head);
  let runs = [];
  try {
    runs = await invoke("list_runs");
  } catch (error) {
    view.append(el("p", { class: "section-note", text: `无法读取历史：${error}` }));
    return;
  }
  if (state.screen !== "history") return;
  if (!runs.length) {
    view.append(el("div", { class: "group" }, el("div", { class: "empty", text: "还没有扫描记录。回到首页点“扫描”，开始第一次扫描。" })));
    return;
  }
  const stored = runs.filter((r) => r.volumes.some((v) => v.stored));
  view.append(el("section", { class: "group fade-in" }, ...runs.map((run) => {
    const hasData = run.volumes.some((v) => v.stored);
    const body = [
      el("span", { class: "row-main" },
        el("span", { class: "row-title", text: dateTime(run.started_at) }),
        el("span", { class: "row-detail", text: runDetail(run) })),
    ];
    if (hasData) return el("button", { type: "button", class: "row", onclick: () => openReport(run.scan_id) }, ...body, svg("0 0 8 13", "M1.5 1.5L6.5 6.5L1.5 11.5", "row-chevron"));
    return el("div", { class: "row" }, ...body);
  })));
  if (stored.length) view.append(el("p", { class: "section-note", text: "每份报告都能切换和比较历史扫描。" }));
}

/* ---- Settings ---- */

function saveSettings() {
  applyTheme();
  invoke("save_settings", { settings: state.settings }).catch(() => {});
}

function radioGroup(name, current, options, onchange) {
  return el("div", { class: "group", role: "radiogroup" }, ...options.map(([value, title, detail]) => {
    const input = el("input", { type: "radio", name, value, onchange: () => onchange(value) });
    input.checked = current === value;
    return el("label", { class: "row choice" }, input,
      el("span", { class: "row-main" },
        el("span", { class: "row-title", text: title }),
        detail ? el("span", { class: "row-detail", text: detail }) : null));
  }));
}

function renderSettings() {
  const keep = el("select", {
    "aria-label": "每个磁盘保留的扫描次数",
    onchange: (e) => { state.settings.keep_per_volume = Number(e.target.value); saveSettings(); },
  }, ...[10, 20, 50, 100].map((n) => el("option", { value: String(n), text: `${n} 次` })));
  keep.value = String(state.settings.keep_per_volume);

  view.replaceChildren(
    el("div", { class: "view-head" }, backButton(), el("h1", { text: "设置" })),
    el("h2", { class: "section-title", text: "扫描方式" }),
    radioGroup("scan-mode", state.settings.scan_mode, [
      ["ask", "下次扫描时询问"],
      ["fast", "极速扫描", "每次扫描在 Windows 弹窗里确认一次管理员权限"],
      ["normal", "普通扫描", "不需要权限，部分系统目录会标为“未知”"],
    ], (value) => { state.settings.scan_mode = value; saveSettings(); }),
    el("h2", { class: "section-title", text: "外观" }),
    radioGroup("theme", state.settings.theme, [
      ["system", "跟随系统"],
      ["light", "浅色"],
      ["dark", "深色"],
    ], (value) => {
      state.settings.theme = value;
      saveSettings();
      invoke("apply_theme", { theme: value }).catch(() => {});
    }),
    el("h2", { class: "section-title", text: "历史" }),
    el("div", { class: "group" },
      el("div", { class: "row" },
        el("span", { class: "row-main" }, el("span", { class: "row-title", text: "每个磁盘保留" })),
        keep),
      el("button", { type: "button", class: "row", onclick: () => invoke("open_data_folder").catch(() => {}) },
        el("span", { class: "row-main" },
          el("span", { class: "row-title", text: "打开数据文件夹" }),
          el("span", { class: "row-detail path", text: state.dataFolder })),
        svg("0 0 8 13", "M1.5 1.5L6.5 6.5L1.5 11.5", "row-chevron"))),
    el("p", { class: "section-note", text: "超出保留次数时，只删除 Diskly 自己保存的旧快照，不会碰你的文件。" }),
    el("p", { class: "section-note", text: `Diskly ${state.version}。扫描内核来自 Diskghost，MIT 许可。不联网，不上传任何数据。` }));
}

/* ---- Navigation ---- */

function show(screen) {
  state.screen = screen;
  if (screen === "home") refreshVolumes();
  if (screen === "history") renderHistory();
  if (screen === "settings") renderSettings();
  view.scrollTop = 0;
  view.focus({ preventScroll: true });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (sheetLayer.firstChild) sheetLayer.replaceChildren();
  else if (state.screen !== "home") show("home");
});

document.getElementById("window-minimize").addEventListener("click", () => tauri.window.getCurrentWindow().minimize());
document.getElementById("window-close").addEventListener("click", () => tauri.window.getCurrentWindow().close());

/* ---- Start ---- */

(async function start() {
  try {
    const home = await invoke("home");
    Object.assign(state, {
      volumes: home.volumes,
      settings: home.settings,
      lastRun: home.last_run,
      dataFolder: home.data_folder,
      version: home.version,
    });
    if (home.mica) document.documentElement.dataset.backdrop = "mica";
    applyTheme();
    renderHome();
  } catch (error) {
    view.replaceChildren(el("p", { class: "lead", text: "无法启动" }), el("p", { class: "section-note", text: String(error) }));
  }
  invoke("window_ready").catch(() => {});
})();
