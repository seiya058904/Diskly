"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("./lib.js");

const { STATE } = lib;
const GB = 1024 ** 3;

function snap(id, over) {
  return {
    id,
    taken_at: Number(id.split("-")[0]),
    letter: "C",
    label: "",
    engine: "mft",
    elevated: true,
    seconds: 1,
    files: 10,
    dirs: 5,
    bytes: 100,
    total_bytes: 500 * GB,
    free_bytes: 300 * GB,
    serial: 1,
    guid: "g1",
    file_system: "NTFS",
    unread_count: 0,
    skipped_elsewhere: 0,
    mft_fallback: null,
    ...over,
  };
}

/* Folders as [path, size in scan 0, size in scan 1, ...], with null for absent. */
function volumeOf(rows, options) {
  const { snapshots, unread, letter = "C" } = options;
  const names = [""];
  const parents = [-1];
  const index = new Map([["", 0]]);
  for (const [path] of rows) {
    const cut = path.lastIndexOf("\\");
    names.push(path.slice(cut + 1));
    parents.push(index.get(cut < 0 ? "" : path.slice(0, cut)));
    index.set(path, names.length - 1);
  }
  const count = snapshots.length;
  const sizes = [];
  for (let s = 0; s < count; s += 1) {
    const column = [0];
    rows.forEach((row) => column.push(row[s + 1]));
    /* The root is the sum of the top level, as in a real scan. */
    column[0] = rows.filter(([p]) => !p.includes("\\")).reduce((sum, row) => sum + (row[s + 1] ?? 0), 0);
    sizes.push(column);
  }
  return {
    key: "v-g1",
    letter,
    label: "",
    connected: true,
    total_bytes: 500 * GB,
    free_bytes: 300 * GB,
    this_run: null,
    snapshots,
    table: {
      names,
      parents,
      sizes,
      unread: (unread || snapshots.map(() => [])).map((list) => list.map((p) => index.get(p))),
    },
    file_changes: {},
    issues: [],
  };
}

const node = (volume, path) => {
  const name = path.slice(path.lastIndexOf("\\") + 1);
  return volume.table.names.findIndex((n, i) => n === name && lib.pathOf(volume.table, i) === path);
};

const two = () => [snap("000000000100-a"), snap("000000000200-b", { free_bytes: 290 * GB })];

/* ---- The map ---- */

test("a map fills its space, in proportion, with nothing overlapping", () => {
  const values = [500, 433, 78, 25, 25, 25, 12, 8, 3, 1];
  const rects = lib.squarify(values, 10, 20, 800, 400);
  assert.equal(rects.length, values.length);
  const total = values.reduce((a, b) => a + b, 0);
  rects.forEach((r, i) => {
    assert.ok(Math.abs(r.w * r.h - (values[i] / total) * 800 * 400) < 0.01, `area of ${i}`);
    assert.ok(r.x >= 10 - 1e-6 && r.y >= 20 - 1e-6 && r.x + r.w <= 810 + 1e-6 && r.y + r.h <= 420 + 1e-6, `bounds of ${i}`);
  });
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const [p, q] = [rects[i], rects[j]];
      const overlapX = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const overlapY = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      assert.ok(overlapX <= 1e-6 || overlapY <= 1e-6, `${i} and ${j} overlap`);
    }
  }
  // Mostly near square, which is the point of it.
  const worst = Math.max(...rects.slice(0, 4).map((r) => Math.max(r.w / r.h, r.h / r.w)));
  assert.ok(worst < 4, `aspect ${worst}`);
});

test("a map of nothing, or into no room, is empty rather than broken", () => {
  assert.deepEqual(lib.squarify([], 0, 0, 100, 100), []);
  assert.deepEqual(lib.squarify([5], 0, 0, 0, 100), []);
  assert.deepEqual(lib.squarify([0], 0, 0, 100, 100), []);
  assert.equal(lib.squarify([5], 0, 0, 100, 50)[0].w, 100);
});

test("the folders that take the most space are the ones that explain it", () => {
  const volume = volumeOf(
    [
      ["Users", 900, 900],
      ["Users\\Alex", 880, 880],
      ["Users\\Alex\\Docker", 700, 700],
      ["Users\\Alex\\Music", 150, 150],
      ["Windows", 400, 400],
      ["Windows\\tiny", 10, 10],
      ["secret", 0, 0],
    ],
    { snapshots: two(), unread: [[], ["secret"]] },
  );
  const paths = lib.sizeHotspots(volume, 1, 10).map((i) => lib.pathOf(volume.table, i));
  // Users goes down to what fills it. Windows stays: the one folder in it says nothing.
  assert.deepEqual(paths, ["Users\\Alex\\Docker", "Windows", "Users\\Alex\\Music"]);
  assert.ok(!paths.includes("secret"), "an unread folder has no size to rank");
});

/* ---- Where the space went ---- */

test("what the disks hold adds up across disks, and largest comes first", () => {
  const insights = (over) => ({ files: [], kinds: [], extensions: [], ranges: [], spots: [], top_folders: [], ...over });
  const c = volumeOf([["a", 1, 1]], { snapshots: two() });
  c.insights = {
    "000000000200-b": insights({
      files: [{ path: "a\\x.iso", size: 500, kind: "archive" }],
      kinds: [{ kind: "archive", size: 500, count: 1 }, { kind: "video", size: 100, count: 2 }],
      extensions: [{ ext: "iso", kind: "archive", size: 500, count: 1 }],
      ranges: [{ upper: 1024, size: 10, count: 5 }, { upper: null, size: 500, count: 1 }],
      spots: [{ id: "temp", size: 40, places: 1, largest: "t", largest_size: 40 }],
    }),
  };
  const d = volumeOf([["b", 1, 1]], { snapshots: two().map((s) => ({ ...s, letter: "D" })), letter: "D" });
  d.key = "v-g2";
  d.insights = {
    "000000000200-b": insights({
      files: [{ path: "b\\y.mkv", size: 900, kind: "video" }],
      kinds: [{ kind: "video", size: 900, count: 1 }],
      extensions: [{ ext: "mkv", kind: "video", size: 900, count: 1 }, { ext: "iso", kind: "archive", size: 1, count: 1 }],
      ranges: [{ upper: 1024, size: 1, count: 1 }, { upper: null, size: 900, count: 1 }],
      spots: [{ id: "temp", size: 70, places: 2, largest: "u", largest_size: 50 }],
    }),
  };
  const merged = lib.mergeInsights(lib.resolvePairs([c, d]));
  assert.deepEqual(merged.files.map((f) => `${f.letter}:${f.size}`), ["D:900", "C:500"]);
  assert.deepEqual(merged.kinds.map((k) => [k.kind, k.size, k.count]), [["video", 1000, 3], ["archive", 500, 1]]);
  assert.equal(merged.extensions[1].size, 501);
  assert.deepEqual(merged.ranges.map((r) => r.size), [11, 1400]);
  assert.equal(merged.spots[0].size, 110);
  assert.equal(merged.spots[0].largest, "u", "the larger one on either disk");
  assert.equal(merged.spots[0].letter, "D");
  assert.equal(lib.mergeInsights(lib.resolvePairs([volumeOf([["a", 1, 1]], { snapshots: two() })])), null);
});

test("every kind and well-known place from a scan has words for it", () => {
  for (const kind of ["video", "image", "audio", "document", "archive", "program", "code", "other"]) {
    assert.notEqual(lib.kindLabel(kind), "");
    assert.ok(lib.KINDS.some((k) => k.id === kind));
  }
  const fromRust = ["recycle", "windows-old", "restore", "winsxs", "temp", "update-cache", "installers", "downloads", "containers", "dev-cache", "dev-deps", "games", "app-cache", "system-files"];
  for (const id of fromRust) assert.ok(lib.SPOTS[id]?.label && lib.SPOTS[id]?.note, id);
});

test("the sentence about file sizes says how few files hold half the space", () => {
  const MB = 1024 ** 2;
  const line = lib.bigFilesLine([
    { upper: 4096, size: 2 * GB, count: 900000 },
    { upper: MB, size: 20 * GB, count: 90000 },
    { upper: GB, size: 30 * GB, count: 2000 },
    { upper: null, size: 60 * GB, count: 12 },
  ]);
  assert.match(line, /^1 GB 以上的 12 个文件占了 54% 的空间，它们只是所有文件的 不到 1%。$/);
  assert.equal(lib.bigFilesLine([]), null);
  assert.equal(lib.bigFilesLine([{ upper: null, size: 0, count: 0 }]), null);
  assert.equal(lib.rangeLabel(0, 4096), "4 KB 以下");
  assert.equal(lib.rangeLabel(MB, GB), "1 MB 到 1 GB");
  assert.equal(lib.rangeLabel(GB, null), "1 GB 以上");
});

/* ---- The long view ---- */

test("a disk that fills steadily gets a forecast, and one that does not gets none", () => {
  const DAY = 86400;
  const now = 1000 * DAY;
  const at = (days, usedGb) => ({ id: String(days), at: now - days * DAY, engine: "mft", total: 500 * GB, free: (500 - usedGb) * GB, top: [] });
  const filling = [at(80, 200), at(50, 215), at(20, 230), at(0, 240)];
  const f = lib.forecast(filling, now);
  assert.ok(f.perMonth > 12 * GB && f.perMonth < 18 * GB, String(f.perMonth / GB));
  assert.ok(f.months > 15 && f.months < 22, String(f.months));
  assert.match(lib.forecastLine("C", f), /^C: 最近每月多用约 .+个月后写满。$/);

  assert.equal(lib.forecast(filling.slice(0, 2), now), null, "too few");
  assert.equal(lib.forecast([at(3, 200), at(2, 210), at(1, 220)], now), null, "too short a time");
  assert.equal(lib.forecast([at(80, 240), at(40, 235), at(0, 200)], now), null, "shrinking");
  assert.equal(lib.forecast([at(80, 200), at(40, 200), at(0, 200)], now), null, "flat");
  assert.equal(lib.forecast(undefined, now), null);
  const slow = [at(80, 1), at(40, 2), at(0, 3)];
  assert.match(lib.forecastLine("C", lib.forecast(slow, now)), /短期内不会写满/);
});

test("the long-term view only compares what both ends know, with one engine", () => {
  const record = (id, engine, top) => ({ id, at: Number(id), engine, total: 1, free: 0, top, serial: 7, unread_top: [] });
  const MB = 1024 ** 2;
  const list = [
    record("1", "walk", [["Users", 1 * MB]]),
    record("2", "mft", [["Users", 10 * MB], ["Windows", 5 * MB], ["Gone", 7 * MB]]),
    record("3", "mft", []),
    record("4", "mft", [["Users", 30 * MB], ["Windows", 1 * MB], ["New", 99 * MB]]),
  ];
  const view = lib.longTerm(list);
  assert.equal(view.from, 2, "the oldest of the same engine");
  assert.deepEqual(view.rows.map((r) => [r.name, r.delta]), [["Users", 20 * MB], ["Windows", -4 * MB]]);
  assert.equal(lib.longTerm([record("9", "mft", [["a", 1]])]), null, "one scan");
  assert.equal(lib.longTerm([]), null);
  assert.equal(lib.longTerm(undefined), null);
});

test("the long-term view never turns the unknown or another format into a change", () => {
  const GiB = 1024 ** 3;
  const record = (id, top, over) => ({ id, at: Number(id), engine: "walk", total: 1, free: 0, top, serial: 7, unread_top: [], ...over });
  const rows = (list) => lib.longTerm(list)?.rows.map((r) => [r.name, r.delta]) ?? null;
  const first = record("1", [["Users", 60 * GiB], ["Games", 10 * GiB]]);

  assert.deepEqual(rows([first, record("2", [["Users", 70 * GiB], ["Games", 10 * GiB]])]), [["Users", 10 * GiB]], "plain growth");

  const unreadNow = record("2", [["Users", 10 * GiB], ["Games", 12 * GiB]], { unread_top: ["Users"] });
  assert.deepEqual(rows([first, unreadNow]), [["Games", 2 * GiB]], "50 GiB that could not be read is not 50 GiB less");
  assert.equal(rows([first, record("2", [["Users", 10 * GiB]], { unread_top: ["users"] })]), null, "nothing known, in any case");

  const unreadThen = record("1", [["Users", 10 * GiB], ["Games", 10 * GiB]], { unread_top: ["Users"] });
  assert.deepEqual(rows([unreadThen, record("2", [["Users", 60 * GiB], ["Games", 12 * GiB]])]), [["Games", 2 * GiB]], "nor is reading it again 50 GiB more");

  const middle = record("2", [], { unread_top: null });
  assert.deepEqual(rows([first, middle, record("3", [["Users", 61 * GiB], ["Games", 10 * GiB]])]), [["Users", 1 * GiB]], "readable again compares with what was known");

  const formatted = record("2", [["Users", 5 * GiB]], { serial: 8 });
  assert.equal(rows([first, formatted]), null, "the same GUID with another serial holds other folders");
  assert.deepEqual(rows([first, formatted, record("3", [["Users", 6 * GiB]], { serial: 8 })]), [["Users", 1 * GiB]], "after a format it starts over");

  const old = (id, top) => ({ id, at: Number(id), engine: "walk", total: 1, free: 0, top });
  assert.equal(rows([old("1", [["Users", 60 * GiB]]), old("2", [["Users", 10 * GiB]])]), null, "old records know neither");
  assert.equal(rows([old("1", [["Users", 60 * GiB]]), record("2", [["Users", 10 * GiB]])]), null, "an old start knows nothing");
  assert.equal(rows([first, old("2", [["Users", 10 * GiB]])]), null, "an old end knows nothing");
  assert.equal(rows([first, record("2", [["Users", 70 * GiB]], { serial: null })]), null, "unknown serial is not the same disk");
  assert.deepEqual(rows([old("1", [["Users", 60 * GiB]]), first, record("3", [["Users", 61 * GiB]])]), [["Users", 1 * GiB]], "old records are skipped, not fatal");
});

test("a disk whose earlier snapshots had to go says so, instead of calling it new", () => {
  const volume = volumeOf([["a", 5]], { snapshots: [snap("000000000300-c")] });
  volume.records = [{ id: "x" }, { id: "y" }];
  const [pair] = lib.withComparisons(lib.resolvePairs([volume]));
  assert.equal(pair.reason, "pruned");
  assert.equal(pair.cmp, null);
  assert.match(lib.headline([pair]).title, /无法比较/);
  assert.match(lib.reasonText("pruned"), /占用上限/);
  volume.records = [{ id: "only" }];
  assert.equal(lib.resolvePairs([volume])[0].reason, "first");
});

/* ---- Comparing ---- */

test("growth, shrinkage, new and removed folders are told apart", () => {
  const volume = volumeOf(
    [
      ["grew", 100, 150],
      ["shrank", 100, 60],
      ["same", 100, 100],
      ["new", null, 70],
      ["gone", 80, null],
    ],
    { snapshots: two() },
  );
  const cmp = lib.compare(volume, 0, 1);
  const at = (p) => node(volume, p);
  assert.equal(cmp.state[at("grew")], STATE.GREW);
  assert.equal(cmp.delta[at("grew")], 50);
  assert.equal(cmp.state[at("shrank")], STATE.SHRANK);
  assert.equal(cmp.delta[at("shrank")], -40);
  assert.equal(cmp.state[at("same")], STATE.SAME);
  assert.equal(cmp.state[at("new")], STATE.ADDED);
  assert.equal(cmp.delta[at("new")], 70);
  assert.equal(cmp.state[at("gone")], STATE.REMOVED);
  assert.equal(cmp.delta[at("gone")], -80);
  assert.equal(cmp.delta[0], 50 - 40 + 70 - 80);
});

test("a folder that could not be read is unknown, not emptied", () => {
  const volume = volumeOf(
    [
      ["Windows", 500, 200],
      ["Windows\\open", 200, 200],
      ["Windows\\secret", 300, 0],
      ["Windows\\secret\\inner", 300, null],
      ["Users", 100, 120],
    ],
    { snapshots: two(), unread: [[], ["Windows\\secret"]] },
  );
  const cmp = lib.compare(volume, 0, 1);
  const at = (p) => node(volume, p);
  assert.equal(cmp.state[at("Windows\\secret")], STATE.UNKNOWN);
  assert.ok(Number.isNaN(cmp.delta[at("Windows\\secret")]));
  assert.equal(cmp.state[at("Windows\\secret\\inner")], STATE.UNKNOWN, "and all below it");
  // Its parent and the volume did not shrink by what could not be read.
  assert.equal(cmp.delta[at("Windows")], 0);
  assert.equal(cmp.state[at("Windows")], STATE.SAME);
  assert.equal(cmp.delta[0], 20, "only the real change");
  assert.equal(cmp.unknownTop, 1);
});

test("a folder readable only now does not look like growth either", () => {
  const volume = volumeOf(
    [
      ["Windows", 200, 500],
      ["Windows\\secret", 0, 300],
    ],
    { snapshots: two(), unread: [["Windows\\secret"], []] },
  );
  const cmp = lib.compare(volume, 0, 1);
  assert.equal(cmp.delta[node(volume, "Windows")], 0);
  assert.equal(cmp.delta[0], 0);
});

test("real change next to an unknown folder still counts", () => {
  const volume = volumeOf(
    [
      ["a", 1000, 1500],
      ["a\\secret", 400, 0],
      ["a\\seen", 600, 1500],
      ["a\\seen\\deep", 600, 1500],
    ],
    { snapshots: two(), unread: [[], ["a\\secret"]] },
  );
  const cmp = lib.compare(volume, 0, 1);
  assert.equal(cmp.delta[node(volume, "a")], 900);
  assert.equal(cmp.delta[node(volume, "a\\seen\\deep")], 900);
  assert.equal(cmp.delta[0], 900);
});

test("used space and what is attributed to folders stay separate", () => {
  const volume = volumeOf([["a", 5 * GB, 7 * GB]], { snapshots: two() });
  const cmp = lib.compare(volume, 0, 1);
  assert.equal(cmp.usedDelta, 10 * GB);
  assert.equal(cmp.attributed, 2 * GB);
  assert.equal(cmp.unattributed, 8 * GB);
});

/* ---- Which scans compare ---- */

test("scans compare only with the same engine on the same file system", () => {
  const base = snap("000000000100-a");
  assert.deepEqual(lib.pairStatus(base, snap("000000000200-b")), { comparable: true, reason: null });
  assert.equal(lib.pairStatus(base, snap("000000000200-b", { engine: "walk" })).reason, "engine");
  assert.equal(lib.pairStatus(base, snap("000000000200-b", { serial: 2 })).reason, "reformatted");
  assert.equal(lib.pairStatus(base, snap("000000000200-b", { guid: "g2" })).reason, "different");
  assert.equal(lib.pairStatus(base, snap("000000000200-b", { serial: null })).reason, "unknown");
});

test("the default comparison skips scans made another way", () => {
  const snapshots = [
    snap("000000000100-a"),
    snap("000000000200-b", { engine: "walk" }),
    snap("000000000300-c"),
  ];
  const volume = volumeOf([["x", 1, 2, 3]], { snapshots });
  const [pair] = lib.resolvePairs([volume]);
  assert.equal(pair.a, 0, "not the walk in between");
  assert.equal(pair.b, 2);
  assert.equal(pair.reason, null);
});

test("with only another engine to compare with, it says why", () => {
  const snapshots = [snap("000000000100-a", { engine: "walk" }), snap("000000000200-b")];
  const volume = volumeOf([["x", 1, 2]], { snapshots });
  const [pair] = lib.withComparisons(lib.resolvePairs([volume]));
  assert.equal(pair.reason, "engine");
  assert.equal(pair.cmp, null);
  assert.equal(lib.headline([pair]).title, "这次无法比较目录变化");
  assert.match(lib.headline([pair]).detail, /扫描方式/);
});

test("a first scan is a baseline, not a change", () => {
  const volume = volumeOf([["x", 1]], { snapshots: [snap("000000000100-a")] });
  const [pair] = lib.withComparisons(lib.resolvePairs([volume]));
  assert.equal(pair.reason, "first");
  assert.equal(lib.headline([pair]).title, "第一次扫描已完成");
});

test("a chosen scan is matched by time for each volume", () => {
  const snapshots = [snap("000000000100-a"), snap("000000000200-b"), snap("000000000300-c")];
  const volume = volumeOf([["x", 1, 2, 3]], { snapshots });
  const [pair] = lib.resolvePairs([volume], "000000000150-z", "000000000250-z");
  assert.equal(pair.a, 0);
  assert.equal(pair.b, 1);
  const [same] = lib.resolvePairs([volume], "000000000200-b", "000000000200-b");
  assert.equal(same.a, -1, "a scan is not compared with itself");
  assert.equal(same.reason, "same-scan");
  const [reversed] = lib.resolvePairs([volume], "000000000300-c", "000000000100-a");
  assert.equal(reversed.reason, "order", "the start is later even when the end is the first scan");
  const [backwards] = lib.resolvePairs([volume], "000000000300-c", "000000000200-b");
  assert.equal(backwards.reason, "order");
});

/* ---- Where it happened ---- */

test("exact scan IDs win over timestamps, even within the same second", () => {
  const snapshots = [snap("000000000100-a"), snap("000000000100-b"), snap("000000000200-c")];
  const v = volumeOf([["x", 1, 2, 9]], { snapshots });
  const [pair] = lib.withComparisons(lib.resolvePairs([v], null, snapshots[0].id));
  assert.equal(pair.b, 0);
  assert.equal(pair.cmp, null);
  assert.equal(pair.carried, false);
  assert.equal(lib.resolvePairs([v], null, snapshots[1].id)[0].b, 1);
  assert.equal(lib.resolvePairs([v], null, "000000000100-other")[0].b, -1, "same-second unrelated scans are not assumed earlier");
});

test("an archived run shows its own summary, never the newest details", () => {
  const v = volumeOf([["future", 9]], { snapshots: [snap("000000000300-c")] });
  v.records = [
    { id: "000000000100-a", at: 100, letter: "C", engine: "mft", total: 500 * GB, free: 490 * GB, files: 3, dirs: 1 },
    { id: "000000000300-c", at: 300, letter: "C", engine: "mft", total: 500 * GB, free: 300 * GB, files: 30, dirs: 10 },
  ];
  const [pair] = lib.withComparisons(lib.resolvePairs([v], null, v.records[0].id));
  assert.equal(pair.b, -1);
  assert.equal(pair.reason, "archived");
  assert.equal(pair.cmp, null);
  assert.equal(lib.selectedSnapshot(pair).files, 3);
  const text = lib.buildPrompt([pair]);
  assert.match(text, /摘要/);
  assert.match(text, /10.0 GB/);
  assert.ok(!text.includes("future") && !text.includes("200 GB"));
  assert.equal(lib.resolvePairs([v], v.records[0].id, v.snapshots[0].id)[0].reason, "archived-base");
  const full = volumeOf([["kept", 1]], { snapshots: [snap(v.records[0].id)] });
  const mixed = [pair, ...lib.withComparisons(lib.resolvePairs([full], null, v.records[0].id))];
  assert.equal(lib.headline(mixed).title, "部分磁盘仅保留摘要");
});

test("a run still has a summary when even its long-term record is gone", () => {
  const v = volumeOf([["future", 9]], { snapshots: [snap("000000000300-c")] });
  const run = { scan_id: "000000000100-a", started_at: 100, volumes: [{ volume_key: v.key, letter: "C", stored: true, status: "complete", engine: "mft", files: 3 }] };
  const [pair] = lib.withComparisons(lib.resolvePairs([v], null, run.scan_id, run));
  assert.equal(pair.b, -1);
  assert.equal(pair.summary.files, 3);
  assert.equal(pair.summary.free_bytes, null, "live free space must not fill a historical gap");
  assert.match(lib.buildPrompt([pair]), /容量记录已不可用/);
  assert.equal(lib.resolvePairs([v], null, null, run)[0].b, 0, "latest is an explicit different choice");
});

test("an unscanned disk carries only an earlier result and labels it", () => {
  const v = volumeOf([["x", 1, 9]], { snapshots: [snap("000000000100-a"), snap("000000000300-c")] });
  const [pair] = lib.withComparisons(lib.resolvePairs([v], null, "000000000200-b"));
  assert.equal(pair.b, 0);
  assert.equal(pair.carried, true);
  assert.match(lib.buildPrompt([pair]), /此前完成的扫描/);
});

test("historical trends stop at the selected ID, not a later scan in that second", () => {
  const v = volumeOf([], { snapshots: [snap("000000000100-a"), snap("000000000100-b")] });
  v.records = [{ id: "older", at: 50 }, { id: v.snapshots[0].id, at: 100 }, { id: v.snapshots[1].id, at: 100 }, { id: "newer", at: 200 }];
  assert.deepEqual(lib.recordsThrough(v, v.snapshots[0]).map((r) => r.id), ["older", v.snapshots[0].id]);
  assert.deepEqual(lib.recordsThrough(v, { id: "missing", taken_at: 100 }).map((r) => r.id), ["older"]);
});

test("a thinned trend still ends at the selected snapshot's known capacity", () => {
  const v = volumeOf([], { snapshots: [snap("000000000100-a")] });
  v.records = [{ id: "older", at: 50, total: 500 * GB, free: 400 * GB }, { id: "future", at: 200, total: 500 * GB, free: 1 }];
  const points = lib.recordsThrough(v, v.snapshots[0]);
  assert.deepEqual(points.map((r) => r.id), ["older", v.snapshots[0].id]);
  assert.equal(points[1].free, 300 * GB);
  assert.equal(lib.longTerm(points), null, "missing folder measurements cannot be inferred from the snapshot summary");
});

test("current readability propagates to children without borrowing comparison uncertainty", () => {
  const v = volumeOf([["restored", 0, 30], ["denied", 20, 0], ["denied\\child", 20, null]], {
    snapshots: two(), unread: [["restored"], ["denied"]],
  });
  const unread = lib.unreadNodes(v.table, 1);
  assert.equal(unread[node(v, "restored")], 0);
  assert.equal(unread[node(v, "denied\\child")], 1);
  const cmp = lib.compare(v, 0, 1);
  assert.equal(cmp.state[node(v, "restored")], STATE.UNKNOWN);
  assert.equal(cmp.delta[0], 0, "neither regained access nor denied access counts as space change");
});

test("leaf folders expose kept files, including omitted intermediate folders, exactly once", () => {
  const v = volumeOf([["Backup", 30], ["Backup\\visible", 4], ["Backup-old", 2]], { snapshots: [snap("000000000100-a")] });
  v.insights = { [v.snapshots[0].id]: { files: [
    { path: "Backup\\image.vhdx", size: 19 },
    { path: "backup\\omitted\\ext4.vhdx", size: 5 },
    { path: "BACKUP\\VISIBLE\\data.bin", size: 4 },
    { path: "Backup-old\\unrelated.bin", size: 2 },
    { path: "root.bin", size: 1 },
  ] } };
  assert.deepEqual(lib.folderFiles(v, 0, 0).map((f) => f.name), ["root.bin"]);
  const files = lib.folderFiles(v, 0, node(v, "Backup"));
  assert.deepEqual(files.map((f) => f.name), ["image.vhdx", "omitted\\ext4.vhdx"]);
  assert.equal(files.reduce((s, f) => s + f.size, 0) + 4, 28, "the visible child and its file are counted only once");
  assert.deepEqual(lib.folderFiles(v, 0, node(v, "Backup\\visible")).map((f) => f.name), ["data.bin"]);
  assert.deepEqual(lib.folderFiles(v, 1, node(v, "Backup")), [], "no files from another scan");
});

test("a change is traced down to the folder that explains it", () => {
  const volume = volumeOf(
    [
      ["Users", 100, 10100],
      ["Users\\me", 100, 10100],
      ["Users\\me\\AppData", 100, 10100],
      ["Users\\me\\AppData\\Cache", 0, 9000],
      ["Users\\me\\AppData\\Logs", 100, 1100],
      ["Windows", 100, 600],
    ],
    { snapshots: two() },
  );
  const cmp = lib.compare(volume, 0, 1);
  const paths = lib.hotspots(cmp, 1, 10).map((i) => lib.pathOf(volume.table, i));
  assert.deepEqual(paths, ["Users\\me\\AppData\\Cache", "Users\\me\\AppData\\Logs", "Windows"]);
});

test("asking for one still traces it all the way down", () => {
  const volume = volumeOf(
    [
      ["Users", 100, 10100],
      ["Users\\me", 100, 10100],
      ["Users\\me\\Cache", 0, 9000],
      ["Users\\me\\Logs", 100, 1100],
      ["Windows", 100, 600],
    ],
    { snapshots: two() },
  );
  const cmp = lib.compare(volume, 0, 1);
  assert.equal(lib.pathOf(volume.table, lib.hotspots(cmp, 1, 1)[0]), "Users\\me\\Cache");
});

test("a change spread over small files stays at its folder", () => {
  const volume = volumeOf(
    [
      ["a", 100, 1100],
      ["a\\tiny", 10, 20],
    ],
    { snapshots: two() },
  );
  const cmp = lib.compare(volume, 0, 1);
  assert.deepEqual(lib.hotspots(cmp, 1, 10), [node(volume, "a")]);
});

test("unknown folders never become a hotspot", () => {
  const volume = volumeOf(
    [
      ["a", 500, 0],
      ["b", 100, 50],
    ],
    { snapshots: two(), unread: [[], ["a"]] },
  );
  const cmp = lib.compare(volume, 0, 1);
  assert.deepEqual(lib.hotspots(cmp, -1, 10), [node(volume, "b")]);
});

test("hotspots stay within the limit and never overlap", () => {
  const rows = [["big", 0, 1000]];
  for (let i = 0; i < 40; i += 1) rows.push([`big\\d${i}`, 0, 25]);
  const volume = volumeOf(rows, { snapshots: two() });
  const cmp = lib.compare(volume, 0, 1);
  const list = lib.hotspots(cmp, 1, 8);
  assert.ok(list.length <= 8);
  const paths = list.map((i) => lib.pathOf(volume.table, i));
  for (const a of paths) for (const b of paths) if (a !== b) assert.ok(!b.startsWith(`${a}\\`), `${a} contains ${b}`);
});

/* ---- The opening sentence ---- */

test("the headline says what changed and where", () => {
  const volume = volumeOf(
    [
      ["Users", 1 * GB, 9 * GB],
      ["Users\\me", 1 * GB, 9 * GB],
    ],
    { snapshots: two() },
  );
  const pairs = lib.withComparisons(lib.resolvePairs([volume]));
  const line = lib.headline(pairs, { now: 200 + 7200 });
  assert.equal(line.title, "C: 比上次多用了 10.0 GB");
  assert.match(line.detail, /C:\\Users\\me，\+8\.0 GB/);
  assert.match(line.detail, /上次扫描是 2 小时前/);
});

function diskWith(letter, usedBefore, usedAfter, rows) {
  const snapshots = [
    snap("000000000100-a", { letter, guid: `g-${letter}`, free_bytes: (500 - usedBefore) * GB }),
    snap("000000000200-b", { letter, guid: `g-${letter}`, free_bytes: (500 - usedAfter) * GB }),
  ];
  return volumeOf(rows, { snapshots, letter });
}

test("disks going opposite ways are each named, not netted", () => {
  const c = diskWith("C", 100, 112, [["Users", 1 * GB, 13 * GB]]);
  const d = diskWith("D", 200, 176, [["Photos", 30 * GB, 6 * GB]]);
  const line = lib.headline(lib.withComparisons(lib.resolvePairs([c, d])));
  assert.equal(line.title, "C: 多用了 12.0 GB，D: 少用了 24.0 GB");
  assert.match(line.detail, /增加最多的是 C:\\Users，\+12\.0 GB/);
  assert.match(line.detail, /减少最多的是 D:\\Photos，\u221224\.0 GB/);
});

test("disks going the same way are added up", () => {
  const c = diskWith("C", 100, 112, [["Users", 1 * GB, 13 * GB]]);
  const d = diskWith("D", 200, 203, [["Photos", 3 * GB, 6 * GB]]);
  const line = lib.headline(lib.withComparisons(lib.resolvePairs([c, d])));
  assert.equal(line.title, "C:、D: 比上次共多用了 15.0 GB");
});

test("a quiet disk next to a busy one is left out of the sentence", () => {
  const c = diskWith("C", 100, 112, [["Users", 1 * GB, 13 * GB]]);
  const d = diskWith("D", 200, 200, [["Photos", 3 * GB, 3 * GB]]);
  const line = lib.headline(lib.withComparisons(lib.resolvePairs([c, d])));
  assert.equal(line.title, "C: 比上次多用了 12.0 GB");
});

test("a small change reads as no change", () => {
  const snapshots = [snap("000000000100-a"), snap("000000000200-b", { free_bytes: 300 * GB - 1024 * 1024 })];
  const volume = volumeOf([["x", 1, 2]], { snapshots });
  const line = lib.headline(lib.withComparisons(lib.resolvePairs([volume])));
  assert.match(line.title, /几乎没有变化/);
});

test("the headline never says space was freed because of an unknown folder", () => {
  const snapshots = [snap("000000000100-a"), snap("000000000200-b")];
  const volume = volumeOf([["secret", 50 * GB, 0]], { snapshots, unread: [[], ["secret"]] });
  const line = lib.headline(lib.withComparisons(lib.resolvePairs([volume])));
  assert.match(line.title, /几乎没有变化/);
});

/* ---- Privacy ---- */

test("account names are found under C:\\Users and hidden everywhere", () => {
  const volume = volumeOf(
    [
      ["Users", 1, 1],
      ["Users\\zhangsan", 1, 1],
      ["Users\\Public", 1, 1],
    ],
    { snapshots: two() },
  );
  const names = lib.accountNames([volume]);
  assert.deepEqual(names, ["zhangsan"]);
  const redact = lib.makeRedactor(names, { accounts: true });
  assert.equal(redact("C:\\Users\\zhangsan\\Downloads"), "C:\\Users\\<用户>\\Downloads");
  assert.equal(redact("D:\\backup-ZhangSan\\a"), "D:\\backup-<用户>\\a");
  assert.equal(redact("C:\\Users\\Public\\x"), "C:\\Users\\Public\\x");
  assert.equal(redact("C:\\Users\\zhangsan\\OneDrive - 某某公司\\a"), "C:\\Users\\<用户>\\OneDrive - <组织>\\a");
});

test("a short account name does not eat into other words", () => {
  const redact = lib.makeRedactor(["me"], { accounts: true });
  assert.equal(redact("C:\\Users\\me\\Documents"), "C:\\Users\\<用户>\\Documents");
  assert.equal(redact("D:\\me-backup\\Homework"), "D:\\<用户>-backup\\Homework");
});

test("a Chinese account name is hidden inside a phrase too", () => {
  const redact = lib.makeRedactor(["张三"], { accounts: true });
  assert.equal(redact("D:\\张三的资料\\a"), "D:\\<用户>的资料\\a");
});

test("personal folders can hide their contents and keep them apart", () => {
  const redact = lib.makeRedactor(["me"], { accounts: true, personal: true });
  assert.equal(
    redact("C:\\Users\\me\\Documents\\离婚协议\\草稿.docx"),
    "C:\\Users\\<用户>\\Documents\\<名称1>\\<名称2>",
  );
  assert.equal(redact("C:\\Users\\me\\Documents\\离婚协议"), "C:\\Users\\<用户>\\Documents\\<名称1>");
  // Program data says what is using the space, and is left readable.
  assert.equal(redact("C:\\Users\\me\\AppData\\Local\\Google"), "C:\\Users\\<用户>\\AppData\\Local\\Google");
});

test("a one-character account name is hidden as a folder, and nowhere else", () => {
  const volume = volumeOf(
    [
      ["Users", 1, 1],
      ["Users\\a", 1, 1],
      ["Users\\王", 1, 1],
      ["Users\\ab", 1, 1],
      ["Users\\B", 1, 1],
      ["Users\\Public", 1, 1],
      ["Users\\Default", 1, 1],
    ],
    { snapshots: two() },
  );
  const names = lib.accountNames([volume]);
  assert.deepEqual([...names].sort(), ["B", "a", "ab", "王"].sort());
  const redact = lib.makeRedactor(names, { accounts: true });
  assert.equal(redact("C:\\Users\\a\\Downloads"), "C:\\Users\\<用户>\\Downloads");
  assert.equal(redact("C:\\Users\\A\\Downloads"), "C:\\Users\\<用户>\\Downloads", "Windows ignores case");
  assert.equal(redact("C:\\users\\b"), "C:\\users\\<用户>");
  assert.equal(redact("C:\\Users\\王\\下载"), "C:\\Users\\<用户>\\下载");
  assert.equal(redact("C:\\Users\\ab\\x"), "C:\\Users\\<用户>\\x", "two characters still work as before");
  assert.equal(redact("C:\\Users\\Public\\a"), "C:\\Users\\Public\\a");
  assert.equal(redact("C:\\Users\\Default\\a"), "C:\\Users\\Default\\a");
  assert.equal(redact("D:\\data\\a-b.txt"), "D:\\data\\a-b.txt", "not a fragment of a name");
  assert.equal(redact("D:\\a\\b.txt"), "D:\\a\\b.txt", "not a folder elsewhere");
  assert.equal(redact("D:\\王者荣耀\\王.txt"), "D:\\王者荣耀\\王.txt", "not inside a Chinese phrase");
  assert.equal(redact("C:\\Users\\a\\AppData\\a.log"), "C:\\Users\\<用户>\\AppData\\a.log");
  const off = lib.makeRedactor(names, { accounts: false });
  assert.equal(off("C:\\Users\\a\\x"), "C:\\Users\\a\\x");
  const both = lib.makeRedactor(names, { accounts: true, personal: true });
  assert.equal(both("C:\\Users\\a\\Documents\\王\\a.txt"), "C:\\Users\\<用户>\\Documents\\<名称1>\\<名称2>");
  const personalOnly = lib.makeRedactor(names, { accounts: false, personal: true });
  assert.equal(personalOnly("C:\\Users\\a\\Documents\\x"), "C:\\Users\\a\\Documents\\<名称1>");
});

test("hostile characters in a name cannot break the pattern", () => {
  const redact = lib.makeRedactor(["a.b(c"], { accounts: true });
  assert.equal(redact("C:\\Users\\a.b(c\\x"), "C:\\Users\\<用户>\\x");
  assert.equal(redact("C:\\Users\\aXb(c\\x"), "C:\\Users\\aXb(c\\x");
});

/* ---- The text for an AI ---- */

function promptVolume() {
  const volume = volumeOf(
    [
      ["Users", 1 * GB, 4 * GB],
      ["Users\\zhangsan", 1 * GB, 4 * GB],
      ["Users\\zhangsan\\Documents", 1 * GB, 4 * GB],
      ["Users\\zhangsan\\Documents\\私人项目", 1 * GB, 4 * GB],
      ["Temp", 2 * GB, 1 * GB],
      ["System Volume Information", 0, 0],
    ],
    { snapshots: two(), unread: [["System Volume Information"], ["System Volume Information"]] },
  );
  const a = volume.snapshots[0].id;
  const b = volume.snapshots[1].id;
  volume.file_changes[b] = {
    base: a,
    unavailable: null,
    added: [{ path: "Users\\zhangsan\\Documents\\私人项目\\a.zip", old: 0, new: 3 * GB }],
    removed: [],
    changed: [],
  };
  return lib.withComparisons(lib.resolvePairs([volume]));
}

test("the prompt holds the question, the numbers and the unknowns", () => {
  const text = lib.buildPrompt(promptVolume());
  for (const needed of ["【请回答】", "【C: 盘】", "系统已用空间变化 +10.0 GB", "变大最多的目录", "释放最多的目录", "未能读取的目录共 1 个", "a.zip", "−1.0 GB"]) {
    assert.ok(text.includes(needed), needed);
  }
});

test("the prompt hides account names by default", () => {
  const text = lib.buildPrompt(promptVolume());
  assert.ok(!text.includes("zhangsan"));
  assert.ok(text.includes("C:\\Users\\<用户>\\Documents"));
  assert.ok(text.includes("私人项目"), "folder names stay unless asked");
});

test("the prompt can hide personal folders too, and show all if asked", () => {
  const hidden = lib.buildPrompt(promptVolume(), { accounts: true, personal: true });
  assert.ok(!hidden.includes("私人项目"));
  assert.ok(!hidden.includes("a.zip"));
  const open = lib.buildPrompt(promptVolume(), { accounts: false, personal: false });
  assert.ok(open.includes("zhangsan"));
  assert.ok(!open.includes("占位符"), "no note about redaction when nothing is redacted");
});

test("the prompt says when there is nothing to compare yet", () => {
  const volume = volumeOf([["x", 1]], { snapshots: [snap("000000000100-a")] });
  const text = lib.buildPrompt(lib.withComparisons(lib.resolvePairs([volume])));
  assert.ok(text.includes("这是第一次扫描"));
});

test("the prompt does not pass off a missing disk as a fresh one", () => {
  const volume = volumeOf([["x", 1]], { snapshots: [snap("000000000100-a")] });
  volume.connected = false;
  const text = lib.buildPrompt(lib.withComparisons(lib.resolvePairs([volume])));
  assert.ok(text.includes("本次未连接"));
  assert.ok(!text.includes("这是第一次扫描"));
});

/* ---- Formatting ---- */

test("sizes read the way Explorer shows them", () => {
  assert.equal(lib.formatBytes(0), "0 B");
  assert.equal(lib.formatBytes(1023), "1023 B");
  assert.equal(lib.formatBytes(1024), "1.0 KB");
  assert.equal(lib.formatBytes(1.5 * GB), "1.5 GB");
  assert.equal(lib.formatBytes(300 * GB), "300 GB");
  assert.equal(lib.formatBytes(null), "未知");
  assert.equal(lib.formatDelta(NaN), "未知");
  assert.equal(lib.formatDelta(0), "没有变化");
  assert.equal(lib.formatDelta(2 * GB), "+2.0 GB");
  assert.equal(lib.formatDelta(-2 * GB), "\u22122.0 GB");
});

test("counts and durations read naturally", () => {
  assert.equal(lib.formatCount(999), "999");
  assert.equal(lib.formatCount(555567), "55.6 万");
  assert.equal(lib.formatCountOf(555567, "个文件"), "55.6 万个文件");
  assert.equal(lib.formatCountOf(3100, "个文件"), "3100 个文件");
  assert.equal(lib.formatSeconds(1.234), "1.2 秒");
  assert.equal(lib.formatSeconds(42.4), "42 秒");
  assert.equal(lib.formatSeconds(125), "2 分 05 秒");
});
