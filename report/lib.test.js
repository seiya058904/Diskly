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
  assert.equal(reversed.reason, "first", "nothing is earlier than the first scan");
  const [backwards] = lib.resolvePairs([volume], "000000000300-c", "000000000200-b");
  assert.equal(backwards.reason, "order");
});

/* ---- Where it happened ---- */

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
  for (const needed of ["【请回答】", "【C: 盘】", "系统已用空间变化 +10.0 GB", "变大最多的目录", "变小最多的目录", "未能读取的目录共 1 个", "a.zip", "−1.0 GB"]) {
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
