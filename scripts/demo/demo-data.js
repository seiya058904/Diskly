"use strict";

/* Made-up report data for looking at and testing the report page: a believable
   machine with no real paths on it. Usage:
   node scripts/demo/demo-data.js <scenario> > data.json
   Scenarios: normal, first, walk-unknown, engines, hostile, empty, big */

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
  const files = [];
  for (let s = 0; s < count; s += 1) {
    const top = sorted.filter(([p]) => !p.includes("\\")).reduce((sum, row) => sum + (row[s + 1] ?? 0), 0);
    sizes.push([top, ...sorted.map((row) => row[s + 1])]);
    files.push(sizes[s].map((v) => (v === null ? null : Math.round(v / (2 * MB)))));
  }
  return {
    names, parents, sizes, files,
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

function volume(key, letter, label, snaps, table, over) {
  const last = snaps[snaps.length - 1];
  return {
    key, letter, label, connected: true,
    total_bytes: last ? last.total_bytes : null,
    free_bytes: last ? last.free_bytes : null,
    this_run: null, snapshots: snaps, table, file_changes: {}, issues: [], ...over,
  };
}

const TIMES = [NOW - 28 * DAY, NOW - 14 * DAY, NOW - 3 * DAY, NOW];
const ids = TIMES.map((t, i) => `${String(t).padStart(12, "0")}-0000000${i}`);

function cVolume(over) {
  const used = [99, 102, 106, 118];
  const snaps = TIMES.map((t, i) => snapshotView(ids[i], t, "C", "Windows", 475 * GB, (475 - used[i]) * GB, 590000 + i * 3000, 118000, over?.snap));
  const v = volume("v-guid-c", "C", "Windows", snaps, tableOf(C_ROWS, 4));
  v.file_changes[ids[3]] = fileChanges(ids[2]);
  return v;
}

function dVolume() {
  const used = [196, 197, 200, 176];
  const snaps = TIMES.map((t, i) => snapshotView(ids[i], t, "D", "Data", 931 * GB, (931 - used[i]) * GB, 118000, 16000));
  return volume("v-guid-d", "D", "Data", snaps, tableOf(D_ROWS, 4));
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
  return { format: 1, app_version: "0.1.0", generated_at: NOW, run: run(volumes, runOver), volumes };
}

const SCENARIOS = {
  normal: () => page([cVolume(), dVolume(), eVolume()]),

  first: () => {
    const c = cVolume();
    c.snapshots = [c.snapshots[3]];
    c.table = tableOf(C_ROWS.map((r) => [r[0], r[4]]), 1);
    c.file_changes = {};
    const d = dVolume();
    d.snapshots = [d.snapshots[3]];
    d.table = tableOf(D_ROWS.filter((r) => r[4] !== null).map((r) => [r[0], r[4]]), 1);
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
    v.issues = [`<img src=x onerror="window.__pwned=5">`];
    return page([v], {
      volumes: [{ letter: "C", label, volume_key: v.key, status: "failed", engine: "none", mft_fallback: null, seconds: 0, files: 0, bytes: 0, error: `<img src=x onerror="window.__pwned=6">`, stored: false }],
    });
  },

  empty: () => ({ format: 1, app_version: "0.1.0", generated_at: NOW, run: null, volumes: [] }),

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
