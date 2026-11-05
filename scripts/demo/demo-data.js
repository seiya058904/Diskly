"use strict";

/* Made-up report data for looking at and testing the report page: a believable
   machine with no real paths on it. Usage:
   node scripts/demo/demo-data.js <scenario> > data.json
   Scenarios: normal, first, walk-unknown, engines, hostile, pruned, empty, big */

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY = 86400;
const NOW = 1793750400; /* a fixed moment, so screenshots are repeatable */

function snapshotView(id, at, letter, label, total, free, files, dirs, over) {
  return {
    id, taken_at: at, letter, label, engine: "mft", elevated: true, seconds: 1.3,
    files, dirs, bytes: total - free, total_bytes: total, free_bytes: free, serial: 79830975,
    guid: `guid-${letter}`, file_system: "NTFS", unread_count: 0, skipped_elsewhere: 0,
    mft_fallback: null, ...over,
  };
}

/* rows: [path, size in each scan...], null where a folder does not exist yet. */
function tableOf(rows, count, unread) {
  const names = [""];
  const parents = [-1];
  const index = new Map([["", 0]]);
  const sorted = rows.slice().sort((a, b) => a[0].split("\\").length - b[0].split("\\").length);
  for (const [path] of sorted) {
    const cut = path.lastIndexOf("\\");
    names.push(path.slice(cut + 1));
    parents.push(index.get(cut < 0 ? "" : path.slice(0, cut)));
    index.set(path, names.length - 1);
  }
  const sizes = [];
  for (let s = 0; s < count; s += 1) {
    const top = sorted.filter(([p]) => !p.includes("\\")).reduce((sum, row) => sum + (row[s + 1] ?? 0), 0);
    sizes.push([top, ...sorted.map((row) => row[s + 1])]);
  }
  return {
    names, parents, sizes,
    unread: (unread || Array(count).fill([])).map((list) => list.map((p) => index.get(p))),
  };
}

const C_ROWS = [
  ["Users", 41 * GB, 42.1 * GB, 44.6 * GB, 56.2 * GB],
  ["Users\\Alex", 40 * GB, 41.1 * GB, 43.6 * GB, 55.2 * GB],
  ["Users\\Alex\\AppData", 22 * GB, 22.8 * GB, 24.4 * GB, 33.1 * GB],
  ["Users\\Alex\\AppData\\Local", 18 * GB, 18.7 * GB, 20.2 * GB, 28.6 * GB],
  ["Users\\Alex\\AppData\\Local\\Packages", 6 * GB, 6.1 * GB, 6.2 * GB, 6.3 * GB],
  ["Users\\Alex\\AppData\\Local\\Google", 4 * GB, 4.2 * GB, 4.4 * GB, 4.7 * GB],
  ["Users\\Alex\\AppData\\Local\\Google\\Chrome", 4 * GB, 4.2 * GB, 4.4 * GB, 4.7 * GB],
  ["Users\\Alex\\AppData\\Local\\Docker", 3 * GB, 3.1 * GB, 4.3 * GB, 11.8 * GB],
  ["Users\\Alex\\AppData\\Local\\Docker\\wsl", 2.9 * GB, 3 * GB, 4.2 * GB, 11.7 * GB],
  ["Users\\Alex\\AppData\\Local\\Temp", 2.1 * GB, 2.2 * GB, 2.9 * GB, 2.4 * GB],
  ["Users\\Alex\\AppData\\Roaming", 3.9 * GB, 4 * GB, 4.1 * GB, 4.4 * GB],
  ["Users\\Alex\\Downloads", 9 * GB, 9.3 * GB, 10.2 * GB, 12.8 * GB],
  ["Users\\Alex\\Downloads\\Installers", 3 * GB, 3.2 * GB, 3.2 * GB, 5.6 * GB],
  ["Users\\Alex\\Documents", 5 * GB, 5 * GB, 5 * GB, 5.3 * GB],
  ["Users\\Alex\\OneDrive - Contoso", 2.6 * GB, 2.6 * GB, 2.6 * GB, 2.6 * GB],
  ["Users\\Public", 0.2 * GB, 0.2 * GB, 0.2 * GB, 0.2 * GB],
  ["Windows", 34 * GB, 34.2 * GB, 34.2 * GB, 33.4 * GB],
  ["Windows\\WinSxS", 11 * GB, 11.1 * GB, 11.1 * GB, 10.4 * GB],
  ["Windows\\System32", 9 * GB, 9 * GB, 9.1 * GB, 9.1 * GB],
  ["Windows\\SoftwareDistribution", 2.3 * GB, 2.4 * GB, 2.4 * GB, 2.2 * GB],
  ["Program Files", 18 * GB, 18.2 * GB, 19.8 * GB, 19.9 * GB],
  ["Program Files\\Docker", 2 * GB, 2 * GB, 3.4 * GB, 3.4 * GB],
  ["Program Files (x86)", 6 * GB, 6 * GB, 6 * GB, 6 * GB],
  ["ProgramData", 3.7 * GB, 3.7 * GB, 3.8 * GB, 3.8 * GB],
  ["System Volume Information", 6.9 * GB, 6.9 * GB, 6.9 * GB, 4.1 * GB],
  ["$Recycle.Bin", 0.4 * GB, 0.4 * GB, 2.8 * GB, 0.1 * GB],
];

const D_ROWS = [
  ["Projects", 14 * GB, 14.6 * GB, 15.1 * GB, 15.4 * GB],
  ["Projects\\website", 3 * GB, 3.2 * GB, 3.4 * GB, 3.5 * GB],
  ["Projects\\website\\node_modules", 1.9 * GB, 2 * GB, 2.1 * GB, 2.2 * GB],
  ["Projects\\engine", 9 * GB, 9.3 * GB, 9.6 * GB, 9.8 * GB],
  ["Projects\\engine\\target", 7.8 * GB, 8.1 * GB, 8.3 * GB, 8.5 * GB],
  ["Photos", 62 * GB, 62 * GB, 62 * GB, 48.5 * GB],
  ["Photos\\2024", 18 * GB, 18 * GB, 18 * GB, 4.5 * GB],
  ["Photos\\2025", 44 * GB, 44 * GB, 44 * GB, 44 * GB],
  ["Backup", 21 * GB, 21 * GB, 21 * GB, 21 * GB],
  ["Games", 88 * GB, 88 * GB, 91 * GB, 91 * GB],
  ["Old laptop", 11 * GB, 11 * GB, 11 * GB, null],
];

const E_ROWS = [
  ["Videos", 340 * GB],
  ["Archive", 120 * GB],
];

function fileChanges(base) {
  return {
    base, unavailable: null,
    added: [
      { path: "Users\\Alex\\AppData\\Local\\Docker\\wsl\\main\\ext4.vhdx", old: 0, new: 7.4 * GB },
      { path: "Users\\Alex\\Downloads\\Installers\\VisualStudioSetup-offline.iso", old: 0, new: 2.3 * GB },
      { path: "Users\\Alex\\Downloads\\report-2026-q3.pdf", old: 0, new: 41 * MB },
    ],
    removed: [
      { path: "Windows\\SoftwareDistribution\\Download\\windows11.0-kb5044284.cab", old: 480 * MB, new: 0 },
      { path: "$Recycle.Bin\\S-1-5-21\\$R8QK2JD.zip", old: 2.7 * GB, new: 0 },
    ],
    changed: [
      { path: "Users\\Alex\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\History", old: 180 * MB, new: 240 * MB },
      { path: "Windows\\WinSxS\\Backup\\manifest.cat", old: 700 * MB, new: 20 * MB },
    ],
    added_count: 18420, added_bytes: 12.6 * GB, removed_count: 3102, removed_bytes: 3.8 * GB,
    changed_count: 2284, changed_delta: 0.4 * GB,
  };
}

const file = (path, size, kind) => ({ path, size, kind });

/* Where the space went, in the shape the scan writes it. */
function insightsOf(files, kinds, ranges, spots, extensions) {
  return { files, kinds, extensions, ranges, spots, top_folders: [] };
}

const RANGES = (a, b, c, d, e, f, g, h) => [
  { upper: 4096, size: a * GB, count: 240000 },
  { upper: 65536, size: b * GB, count: 210000 },
  { upper: MB, size: c * GB, count: 120000 },
  { upper: 16 * MB, size: d * GB, count: 22000 },
  { upper: 128 * MB, size: e * GB, count: 1500 },
  { upper: GB, size: f * GB, count: 120 },
  { upper: 4 * GB, size: g * GB, count: 9 },
  { upper: null, size: h * GB, count: 2 },
];

const C_INSIGHTS = insightsOf(
  [
    file("Users\\Alex\\AppData\\Local\\Docker\\wsl\\main\\ext4.vhdx", 11.2 * GB, "archive"),
    file("hiberfil.sys", 6.3 * GB, "program"),
    file("pagefile.sys", 4 * GB, "program"),
    file("Users\\Alex\\Downloads\\Installers\\VisualStudioSetup-offline.iso", 2.3 * GB, "archive"),
    file("Users\\Alex\\Videos\\Captures\\meeting-recording-2026-10-28.mp4", 1.9 * GB, "video"),
    file("Users\\Alex\\Downloads\\ubuntu-24.04-desktop-amd64.iso", 1.6 * GB, "archive"),
    file("Users\\Alex\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\History", 240 * MB, "other"),
    file("Program Files\\Docker\\Docker\\resources\\docker-desktop.iso", 620 * MB, "archive"),
    file("Users\\Alex\\Documents\\Reports\\annual-report-2025.pdf", 410 * MB, "document"),
    file("Users\\Alex\\Pictures\\Screenshots\\wallpaper-8k.png", 180 * MB, "image"),
    file("Windows\\System32\\MRT.exe", 150 * MB, "program"),
    file("Users\\Alex\\Music\\album-live-session.flac", 96 * MB, "audio"),
    file("Users\\Alex\\Downloads\\report-2026-q3.pdf", 41 * MB, "document"),
  ],
  [
    { kind: "program", size: 41 * GB, count: 182000 },
    { kind: "archive", size: 18.6 * GB, count: 900 },
    { kind: "other", size: 21 * GB, count: 240000 },
    { kind: "code", size: 7.4 * GB, count: 150000 },
    { kind: "video", size: 3.2 * GB, count: 40 },
    { kind: "image", size: 2.1 * GB, count: 18000 },
    { kind: "document", size: 1.2 * GB, count: 900 },
    { kind: "audio", size: 0.3 * GB, count: 160 },
  ],
  RANGES(0.8, 4.2, 12, 22, 18, 21, 8.5, 11.2),
  [
    { id: "containers", size: 11.8 * GB, places: 1, largest: "Users\\Alex\\AppData\\Local\\Docker", largest_size: 11.8 * GB },
    { id: "downloads", size: 12.8 * GB, places: 1, largest: "Users\\Alex\\Downloads", largest_size: 12.8 * GB },
    { id: "winsxs", size: 10.4 * GB, places: 1, largest: "Windows\\WinSxS", largest_size: 10.4 * GB },
    { id: "system-files", size: 10.3 * GB, places: 2, largest: "hiberfil.sys", largest_size: 6.3 * GB },
    { id: "app-cache", size: 3.1 * GB, places: 26, largest: "Users\\Alex\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache", largest_size: 1.4 * GB },
    { id: "restore", size: 4.1 * GB, places: 1, largest: "System Volume Information", largest_size: 4.1 * GB },
    { id: "temp", size: 2.4 * GB, places: 1, largest: "Users\\Alex\\AppData\\Local\\Temp", largest_size: 2.4 * GB },
    { id: "update-cache", size: 1.6 * GB, places: 1, largest: "Windows\\SoftwareDistribution\\Download", largest_size: 1.6 * GB },
  ],
  [
    { ext: "dll", kind: "program", size: 22 * GB, count: 91000 },
    { ext: "vhdx", kind: "archive", size: 11.2 * GB, count: 1 },
    { ext: "sys", kind: "program", size: 10.8 * GB, count: 880 },
    { ext: "exe", kind: "program", size: 6.2 * GB, count: 8100 },
    { ext: "iso", kind: "archive", size: 4.5 * GB, count: 3 },
    { ext: "pak", kind: "other", size: 3.9 * GB, count: 1200 },
    { ext: "mp4", kind: "video", size: 3.2 * GB, count: 40 },
    { ext: "log", kind: "other", size: 2.8 * GB, count: 16000 },
    { ext: "js", kind: "code", size: 2.4 * GB, count: 62000 },
    { ext: "", kind: "other", size: 2.1 * GB, count: 41000 },
    { ext: "png", kind: "image", size: 1.6 * GB, count: 14000 },
    { ext: "pdf", kind: "document", size: 1.1 * GB, count: 400 },
  ],
);

const D_INSIGHTS = insightsOf(
  [
    file("Games\\SteamLibrary\\steamapps\\common\\Cyber\\archive\\pc\\content\\basegame_4_gi.archive", 28 * GB, "other"),
    file("Backup\\laptop-image-2026.vhdx", 19 * GB, "archive"),
    file("Photos\\2025\\wedding-video-final.mov", 8.8 * GB, "video"),
    file("Projects\\engine\\target\\release\\deps\\libengine.rlib", 1.2 * GB, "code"),
    file("Photos\\2025\\raw\\IMG_2231.CR3", 72 * MB, "image"),
    file("Music\\collection.zip", 3.4 * GB, "archive"),
  ],
  [
    { kind: "other", size: 88 * GB, count: 12000 },
    { kind: "image", size: 40 * GB, count: 42000 },
    { kind: "archive", size: 24 * GB, count: 800 },
    { kind: "code", size: 12 * GB, count: 51000 },
    { kind: "video", size: 8.5 * GB, count: 120 },
    { kind: "program", size: 3 * GB, count: 4000 },
  ],
  RANGES(0.1, 0.9, 6, 39, 30, 32, 21, 47),
  [
    { id: "games", size: 91 * GB, places: 1, largest: "Games\\SteamLibrary\\steamapps", largest_size: 91 * GB },
    { id: "dev-deps", size: 2.2 * GB, places: 14, largest: "Projects\\website\\node_modules", largest_size: 2.2 * GB },
    { id: "recycle", size: 0.6 * GB, places: 1, largest: "$Recycle.Bin", largest_size: 0.6 * GB },
  ],
  [
    { ext: "archive", kind: "other", size: 62 * GB, count: 40 },
    { ext: "cr3", kind: "image", size: 34 * GB, count: 1400 },
    { ext: "vhdx", kind: "archive", size: 19 * GB, count: 1 },
    { ext: "mov", kind: "video", size: 8.5 * GB, count: 12 },
    { ext: "rlib", kind: "code", size: 7.2 * GB, count: 3100 },
  ],
);

/* A year of scans: the snapshots are long gone, these small lines stay. */
function recordsOf(letter, total, usedNow, perMonthGb, topNow) {
  const out = [];
  const count = 30;
  for (let i = count - 1; i >= 0; i -= 1) {
    const age = (i * i * 0.42) * DAY;
    const wobble = Math.sin(i * 1.7) * 0.8;
    const usedGb = usedNow - (age / (30.44 * DAY)) * perMonthGb + (i ? wobble : 0);
    out.push({
      id: `${String(NOW - age).padStart(12, "0")}-r${i}`, at: NOW - age, letter, engine: "mft",
      total, free: total - usedGb * GB, files: 500000, dirs: 90000,
      top: i === count - 1 ? topNow.map(([n, g]) => [n, g * 0.72 * GB]) : i === 0 ? topNow.map(([n, g]) => [n, g * GB]) : [],
      serial: 1, unread_top: [],
    });
  }
  return out;
}

function footprint(over) {
  return {
    limit: 50 * MB, program: 10.9 * MB, webview: 2.2 * MB, snapshots: 9.7 * MB, reports: 5 * MB, records: 0.2 * MB, other: 0.03 * MB,
    total: 28 * MB, scans_kept: 6, reports_kept: 3, records_kept: 60, keep_snapshots: 3, keep_reports: 3, ...over,
  };
}

function volume(key, letter, label, snaps, table, over) {
  const last = snaps[snaps.length - 1];
  return {
    key, letter, label, connected: true,
    total_bytes: last ? last.total_bytes : null,
    free_bytes: last ? last.free_bytes : null,
    this_run: null, snapshots: snaps, table, file_changes: {}, insights: {}, records: [], issues: [], ...over,
  };
}

const TIMES = [NOW - 28 * DAY, NOW - 14 * DAY, NOW - 3 * DAY, NOW];
const ids = TIMES.map((t, i) => `${String(t).padStart(12, "0")}-0000000${i}`);

function cVolume(over) {
  const used = [99, 102, 106, 118];
  const snaps = TIMES.map((t, i) => snapshotView(ids[i], t, "C", "Windows", 475 * GB, (475 - used[i]) * GB, 590000 + i * 3000, 118000, over?.snap));
  const v = volume("v-guid-c", "C", "Windows", snaps, tableOf(C_ROWS, 4));
  v.file_changes[ids[3]] = fileChanges(ids[2]);
  v.insights[ids[3]] = C_INSIGHTS;
  v.insights[ids[2]] = C_INSIGHTS;
  v.records = recordsOf("C", 475 * GB, 118, 5.5, [["Users", 56.2], ["Windows", 33.4], ["Program Files", 19.9], ["ProgramData", 3.8]]);
  return v;
}

function dVolume() {
  const used = [196, 197, 200, 176];
  const snaps = TIMES.map((t, i) => snapshotView(ids[i], t, "D", "Data", 931 * GB, (931 - used[i]) * GB, 118000, 16000));
  const v = volume("v-guid-d", "D", "Data", snaps, tableOf(D_ROWS, 4));
  v.insights[ids[3]] = D_INSIGHTS;
  v.records = recordsOf("D", 931 * GB, 176, 1.2, [["Games", 91], ["Photos", 48.5], ["Backup", 21], ["Projects", 15.4]]);
  return v;
}

function eVolume() {
  const snaps = [snapshotView(ids[0], TIMES[0], "E", "Backup disk", 1863 * GB, 1403 * GB, 40200, 3100)];
  const v = volume("v-guid-e", "E", "Backup disk", snaps, tableOf(E_ROWS, 1));
  v.connected = false;
  return v;
}

function run(volumes, over) {
  return {
    scan_id: ids[3], started_at: NOW, finished_at: NOW + 2, seconds: 1.4, consent_declined: false,
    volumes: volumes.filter((v) => v.connected).map((v) => ({
      letter: v.letter, label: v.label, volume_key: v.key, status: "complete", engine: "mft",
      mft_fallback: null, seconds: 1.3, files: 1, bytes: 1, error: null, stored: true,
    })),
    report_file: null, issues: [], ...over,
  };
}

function page(volumes, runOver) {
  return { format: 2, app_version: "0.2.0", generated_at: NOW, theme: "dark", footprint: footprint(), run: run(volumes, runOver), volumes };
}

const SCENARIOS = {
  normal: () => page([cVolume(), dVolume(), eVolume()]),

  first: () => {
    const c = cVolume();
    c.snapshots = [c.snapshots[3]];
    c.table = tableOf(C_ROWS.map((r) => [r[0], r[4]]), 1);
    c.file_changes = {};
    c.records = c.records.slice(-1);
    const d = dVolume();
    d.snapshots = [d.snapshots[3]];
    d.table = tableOf(D_ROWS.filter((r) => r[4] !== null).map((r) => [r[0], r[4]]), 1);
    d.records = d.records.slice(-1);
    return page([c, d]);
  },

  /* A normal scan that could not read two folders: not one byte of them may show
     up as freed, though they are 6.9 GB and 34 GB in the scan before. */
  "walk-unknown": () => {
    const rows = [
      ["Users", 41 * GB, 41.4 * GB],
      ["Users\\Alex", 40 * GB, 40.4 * GB],
      ["Windows", 34 * GB, 33 * GB],
      ["Windows\\System32", 9 * GB, 9 * GB],
      ["Windows\\CSC", 1 * GB, 0],
      ["ProgramData", 3.7 * GB, 3.7 * GB],
      ["System Volume Information", 6.9 * GB, 0],
    ];
    const opts = { engine: "walk", elevated: false, unread_count: 2, seconds: 5.3 };
    const snaps = [
      snapshotView(ids[2], TIMES[2], "C", "Windows", 475 * GB, 369 * GB, 590000, 118000, { ...opts, unread_count: 0 }),
      snapshotView(ids[3], TIMES[3], "C", "Windows", 475 * GB, 369 * GB, 590400, 118000, opts),
    ];
    const v = volume("v-guid-c", "C", "Windows", snaps, tableOf(rows, 2, [[], ["System Volume Information", "Windows\\CSC"]]));
    v.file_changes[ids[3]] = { base: ids[2], unavailable: "这两次扫描能读取的目录不同", added: [], removed: [], changed: [] };
    return page([v], { consent_declined: true });
  },

  /* Only a scan with the other engine to compare with. */
  engines: () => {
    const c = cVolume();
    c.snapshots = c.snapshots.slice(2);
    c.snapshots[0].engine = "walk";
    c.table = tableOf(C_ROWS.map((r) => [r[0], r[3], r[4]]), 2);
    c.file_changes = {};
    c.records = [];
    return page([c]);
  },

  /* Names no file system should hold, to prove none of it runs. */
  hostile: () => {
    const bad = "<img src=x onerror=\"window.__pwned=1\">";
    const rows = [
      [`</script><script>window.__pwned=2</script>`, 5 * GB, 9 * GB],
      [`</script><script>window.__pwned=2</script>\\${bad}`, 1 * GB, 4 * GB],
      ["&lt;b&gt;     __DATA__", 2 * GB, 1 * GB],
      ["System Volume Information", 0, 0],
    ];
    const label = `<svg onload="window.__pwned=3">`;
    const snaps = [
      snapshotView(ids[2], TIMES[2], "C", label, 475 * GB, 400 * GB, 10, 10),
      snapshotView(ids[3], TIMES[3], "C", label, 475 * GB, 395 * GB, 10, 10),
    ];
    const v = volume("v-guid-c", "C", label, snaps, tableOf(rows, 2));
    v.file_changes[ids[3]] = {
      base: ids[2], unavailable: null,
      added: [{ path: `${bad}\\</script><script>window.__pwned=4</script>.txt`, old: 0, new: 3 * GB }],
      removed: [], changed: [], added_count: 1, added_bytes: 3 * GB, removed_count: 0, removed_bytes: 0, changed_count: 0, changed_delta: 0,
    };
    v.insights[ids[3]] = insightsOf(
      [file(`${bad}\\</script><script>window.__pwned=7</script>.bin`, 3 * GB, "other")],
      [{ kind: "<img src=x onerror=\"window.__pwned=8\">", size: 3 * GB, count: 1 }, { kind: "other", size: 1 * GB, count: 4 }],
      RANGES(0, 0, 0, 0, 0, 0, 0, 3),
      [{ id: `<img src=x onerror="window.__pwned=9">`, size: 3 * GB, places: 1, largest: bad, largest_size: 3 * GB }, { id: "temp", size: 1 * GB, places: 1, largest: `${bad}\\x`, largest_size: 1 * GB }],
      [{ ext: `<img src=x onerror="window.__pwned=10">`, kind: "other", size: 3 * GB, count: 1 }],
    );
    v.records = [
      { id: "1", at: TIMES[0], letter: "C", engine: "mft", total: 475 * GB, free: 410 * GB, files: 1, dirs: 1, top: [[bad, 1 * GB]], serial: 1, unread_top: [] },
      { id: "2", at: TIMES[1], letter: "C", engine: "mft", total: 475 * GB, free: 405 * GB, files: 1, dirs: 1, top: [], serial: 1, unread_top: [] },
      { id: "3", at: TIMES[3], letter: "C", engine: "mft", total: 475 * GB, free: 395 * GB, files: 1, dirs: 1, top: [[bad, 5 * GB]], serial: 1, unread_top: [] },
    ];
    v.issues = [`<img src=x onerror="window.__pwned=5">`];
    return page([v], {
      volumes: [{ letter: "C", label, volume_key: v.key, status: "failed", engine: "none", mft_fallback: null, seconds: 0, files: 0, bytes: 0, error: `<img src=x onerror="window.__pwned=6">`, stored: false }],
    });
  },

  /* A disk with too many files: its last full snapshot did not fit under the limit. */
  pruned: () => {
    const c = cVolume();
    c.snapshots = [c.snapshots[3]];
    c.table = tableOf(C_ROWS.map((r) => [r[0], r[4]]), 1);
    c.file_changes = {};
    return page([c]);
  },

  /* The long view: one disk with a folder it could not read at the end, one with only
     records from before that was kept, and one with too few records for a chart. */
  "long-view": () => {
    const known = (id, at, top, unread) => ({ id, at, letter: "C", engine: "mft", total: 475 * GB, free: 300 * GB, files: 1, dirs: 1, top, serial: 1, unread_top: unread });
    const c = cVolume();
    c.records = [
      known("1", TIMES[0], [["Users", 60 * GB], ["Windows", 30 * GB]], []),
      known("2", TIMES[1], [], null),
      known("3", TIMES[3], [["Users", 10 * GB], ["Windows", 33 * GB]], ["Users"]),
    ];
    const d = dVolume();
    d.records = [
      { id: "1", at: TIMES[0], letter: "D", engine: "mft", total: 931 * GB, free: 700 * GB, files: 1, dirs: 1, top: [["Games", 90 * GB]] },
      { id: "2", at: TIMES[1], letter: "D", engine: "mft", total: 931 * GB, free: 700 * GB, files: 1, dirs: 1, top: [] },
      { id: "3", at: TIMES[3], letter: "D", engine: "mft", total: 931 * GB, free: 700 * GB, files: 1, dirs: 1, top: [["Games", 10 * GB]] },
    ];
    const e = eVolume();
    e.records = [known("1", TIMES[0], [["Data", 1 * GB]], []), known("2", TIMES[3], [["Data", 9 * GB]], [])];
    return page([c, d, e]);
  },

  empty: () => ({ format: 2, app_version: "0.2.0", generated_at: NOW, theme: "dark", footprint: footprint({ snapshots: 0, reports: 0, records: 0, total: 13 * MB }), run: null, volumes: [] }),

  /* As many folders as a report can hold, for checking speed and size. */
  big: () => {
    const rows = [["Data", 900 * GB, 950 * GB]];
    for (let i = 0; i < 400; i += 1) {
      rows.push([`Data\\project-${i}`, 2 * GB, (2 + (i % 7) / 10) * GB]);
      for (let j = 0; j < 49; j += 1) rows.push([`Data\\project-${i}\\module-with-a-rather-long-name-${j}`, 40 * MB, (40 + j) * MB]);
    }
    const snaps = TIMES.map((t, i) => snapshotView(ids[i], t, "D", "Data", 1863 * GB, (900 - i * 10) * GB, 5000000, 800000));
    const table = tableOf(rows.map((r) => [r[0], r[1], r[1], r[2], r[2]]), 4);
    return page([volume("v-guid-d", "D", "Data", snaps, table)]);
  },
};

const scenario = process.argv[2] || "normal";
if (!SCENARIOS[scenario]) {
  console.error(`unknown scenario: ${scenario}. Known: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(SCENARIOS[scenario]()));
