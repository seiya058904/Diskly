"use strict";

/* The report's logic, without a page: comparing two scans, finding where a change
   really happened, and writing it down. The page is in report.js. To test this
   file directly: node --test report/lib.test.js */

const DisklyLib = (() => {
  /* ---- Formatting ---- */

  const MINUS = "\u2212";

  /* Sizes as Explorer shows them: 1 GB is 1024 MB. */
  function formatBytes(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return "未知";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let value = Math.abs(n);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const digits = unit === 0 || value >= 100 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unit]}`;
  }

  function formatDelta(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return "未知";
    if (n === 0) return "没有变化";
    return `${n > 0 ? "+" : MINUS}${formatBytes(n)}`;
  }

  function formatCount(n) {
    if (n >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`;
    if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
    return String(n);
  }

  /* "3100 个文件", but "59.9 万个文件". */
  function formatCountOf(n, unit) {
    return `${formatCount(n)}${n >= 10000 ? "" : " "}${unit}`;
  }

  function formatSeconds(s) {
    if (s < 10) return `${s.toFixed(1)} 秒`;
    if (s < 60) return `${Math.round(s)} 秒`;
    const minutes = Math.floor(s / 60);
    return `${minutes} 分 ${String(Math.round(s - minutes * 60)).padStart(2, "0")} 秒`;
  }

  function formatDate(unix) {
    const d = new Date(unix * 1000);
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatDay(unix) {
    const d = new Date(unix * 1000);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  function formatAgo(unix, now) {
    const s = Math.max(0, now - unix);
    if (s < 90) return "刚刚";
    if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
    return `${Math.round(s / 86400)} 天前`;
  }

  const engineName = (engine) => (engine === "mft" ? "极速扫描" : "普通扫描");

  /* ---- Which scans can be compared ---- */

  /* The same rules as compare.rs: unknown is never proof of identity. */
  function sameVolume(a, b) {
    if (a.guid && b.guid && a.guid !== b.guid) return "different";
    if (a.serial === null || a.serial === undefined || b.serial === null || b.serial === undefined) return "unknown";
    if (a.serial !== b.serial) return a.guid && b.guid ? "reformatted" : "different";
    if (!a.guid || !b.guid) return a.file_system === b.file_system ? "same" : "unknown";
    return "same";
  }

  /* Whether folder changes between two scans mean anything, and if not, why. */
  function pairStatus(a, b) {
    const same = sameVolume(a, b);
    if (same !== "same") return { comparable: false, reason: same };
    if (a.engine !== b.engine) return { comparable: false, reason: "engine" };
    return { comparable: true, reason: null };
  }

  const REASONS = {
    first: "这是它的第一次扫描，下次就能看到变化。",
    engine: "这两次用了不同的扫描方式。两种方式对部分文件的计量不同，目录变化没有可比性。用同一种方式再扫一次就能比较。",
    reformatted: "这块磁盘在两次扫描之间被格式化过，旧的结果已不再对应现在的文件。",
    different: "这两次扫描的不是同一个卷。",
    unknown: "无法确认这两次扫描的是同一个卷，所以不做比较。",
    "same-scan": "这两个时间之间，它没有新的扫描。",
    pruned: "这块磁盘文件太多，上一次的完整快照放不进 Diskly 的占用上限，所以这次只能看总量变化。",
    order: "起点要早于终点，请重新选择。",
    archived: "这次扫描的目录和文件详情已清理或不可用，只能查看保留的摘要。",
    "archived-base": "所选起点的目录详情已不可用，不能计算这段时间的目录变化。",
  };

  function reasonText(reason) {
    return REASONS[reason] || "这两次扫描不能比较。";
  }

  /* The newest scan before `to` that it can be compared with, or -1. */
  function previousComparable(snapshots, to) {
    for (let i = to - 1; i >= 0; i -= 1) {
      if (pairStatus(snapshots[i], snapshots[to]).comparable) return i;
    }
    return -1;
  }

  /* ---- Comparing two scans ---- */

  const STATE = { SAME: 0, GREW: 1, SHRANK: 2, ADDED: 3, REMOVED: 4, UNKNOWN: 5, ABSENT: 6 };

  function childrenOf(table) {
    const children = table.names.map(() => []);
    for (let i = 1; i < table.parents.length; i += 1) {
      const parent = table.parents[i];
      if (parent >= 0) children[parent].push(i);
    }
    return children;
  }

  /* Compare scans `a` and `b` (indexes) of a volume. A folder that either scan
     could not read is unknown, with everything below it. What such a folder seems
     to have changed by is taken out of its ancestors, so a folder that could not
     be read never shows up as space freed, anywhere up the tree. */
  function compare(volume, a, b) {
    const table = volume.table;
    const n = table.names.length;
    const sizesA = table.sizes[a];
    const sizesB = table.sizes[b];
    const unknown = new Uint8Array(n);
    for (const i of table.unread[a] || []) unknown[i] = 1;
    for (const i of table.unread[b] || []) unknown[i] = 1;
    for (let i = 1; i < n; i += 1) {
      if (unknown[table.parents[i]]) unknown[i] = 1;
    }

    const raw = new Float64Array(n);
    for (let i = 0; i < n; i += 1) raw[i] = (sizesB[i] ?? 0) - (sizesA[i] ?? 0);

    /* Children come after their parents, so going backwards sees them first. */
    const excluded = new Float64Array(n);
    for (let i = n - 1; i >= 1; i -= 1) {
      const parent = table.parents[i];
      if (unknown[i]) {
        if (!unknown[parent]) excluded[parent] += raw[i];
      } else {
        excluded[parent] += excluded[i];
      }
    }

    const delta = new Float64Array(n);
    const state = new Uint8Array(n);
    let unknownTop = 0;
    for (let i = 0; i < n; i += 1) {
      if (unknown[i]) {
        delta[i] = NaN;
        state[i] = STATE.UNKNOWN;
        if (i > 0 && !unknown[table.parents[i]]) unknownTop += 1;
        continue;
      }
      delta[i] = raw[i] - excluded[i];
      const inA = sizesA[i] !== null && sizesA[i] !== undefined;
      const inB = sizesB[i] !== null && sizesB[i] !== undefined;
      if (!inA && !inB) state[i] = STATE.ABSENT;
      else if (!inA) state[i] = STATE.ADDED;
      else if (!inB) state[i] = STATE.REMOVED;
      else if (delta[i] > 0) state[i] = STATE.GREW;
      else if (delta[i] < 0) state[i] = STATE.SHRANK;
      else state[i] = STATE.SAME;
    }

    const snapA = volume.snapshots[a];
    const snapB = volume.snapshots[b];
    const used = (s) => s.total_bytes - s.free_bytes;
    const usedDelta = used(snapB) - used(snapA);
    return {
      volume,
      a,
      b,
      snapA,
      snapB,
      delta,
      state,
      children: childrenOf(table),
      unknownTop,
      usedDelta,
      attributed: delta[0],
      unattributed: usedDelta - delta[0],
    };
  }

  /* ---- Where a change really happened ---- */

  /* The folders behind a change, none inside another. "C:\Users grew by 10 GB"
     says little if it is all in one folder eight levels down, so a folder gives
     way to its children when they explain most of its change. */
  function hotspots(cmp, sign, limit) {
    const value = (i) => {
      const v = sign * cmp.delta[i];
      return v > 0 ? v : 0;
    };
    const growing = (i) => cmp.children[i].filter((c) => value(c) > 0);
    const splittable = (i) => {
      const kids = growing(i);
      if (!kids.length) return false;
      const total = kids.reduce((sum, c) => sum + value(c), 0);
      return total >= 0.6 * value(i);
    };
    let list = growing(0);
    for (;;) {
      list.sort((x, y) => value(y) - value(x));
      const pick = list.find(splittable);
      if (pick === undefined) break;
      const kept = growing(pick).filter((c) => value(c) >= 0.05 * value(pick));
      if (!kept.length) break;
      /* Enough to rank well however few are asked for, and bounded however many
         folders a change is spread over. */
      if (list.length - 1 + kept.length > Math.max(limit, 16) * 2) break;
      list = list.filter((i) => i !== pick).concat(kept);
    }
    return list.slice(0, limit);
  }

  /* The folders that take the most space, none inside another: the same idea as
     hotspots, on sizes. "C:\\Users 80 GB" says less than the folders inside it that
     make it so. A folder that could not be read has no size to rank. */
  function sizeHotspots(volume, b, limit) {
    const table = volume.table;
    const sizes = table.sizes[b];
    if (!sizes) return [];
    const unread = new Set(table.unread[b] || []);
    const kids = childrenOf(table);
    const value = (i) => (unread.has(i) ? 0 : sizes[i] ?? 0);
    const present = (i) => kids[i].filter((c) => value(c) > 0);
    const splittable = (i) => {
      const inside = present(i);
      if (!inside.length) return false;
      return inside.reduce((sum, c) => sum + value(c), 0) >= 0.6 * value(i);
    };
    let list = present(0);
    for (;;) {
      list.sort((x, y) => value(y) - value(x));
      const pick = list.slice(0, limit).find(splittable);
      if (pick === undefined) break;
      const kept = present(pick).filter((c) => value(c) >= 0.05 * value(pick));
      if (!kept.length) break;
      if (list.length - 1 + kept.length > Math.max(limit, 16) * 3) break;
      list = list.filter((i) => i !== pick).concat(kept);
    }
    return list.slice(0, limit);
  }

  /* ---- Laying out a map of folders ---- */

  /* Squarified treemap (Bruls, Huizing and van Wijk): rectangles in `w` by `h` with
     areas in proportion to `values`, as close to square as can be. `values` must be
     positive and biggest first. The rectangles come back in the same order. */
  function squarify(values, x, y, w, h) {
    const total = values.reduce((sum, v) => sum + v, 0);
    const out = [];
    if (!(total > 0) || w <= 0 || h <= 0) return out;
    const scale = (w * h) / total;
    let i = 0;
    while (i < values.length) {
      const short = Math.min(w, h);
      let sum = 0;
      let first = 0;
      let best = Infinity;
      let j = i;
      while (j < values.length) {
        const area = values[j] * scale;
        const next = sum + area;
        const top = first || area;
        const worst = Math.max((short * short * top) / (next * next), (next * next) / (short * short * area));
        if (worst > best && j > i) break;
        best = worst;
        sum = next;
        first = top;
        j += 1;
      }
      if (w >= h) {
        const width = sum / h;
        let at = y;
        for (let k = i; k < j; k += 1) {
          const height = (values[k] * scale) / width;
          out.push({ x, y: at, w: width, h: height });
          at += height;
        }
        x += width;
        w -= width;
      } else {
        const height = sum / w;
        let at = x;
        for (let k = i; k < j; k += 1) {
          const width = (values[k] * scale) / height;
          out.push({ x: at, y, w: width, h: height });
          at += width;
        }
        y += height;
        h -= height;
      }
      i = j;
    }
    return out;
  }

  /* ---- What the space is made of ---- */

  /* In the order they get their colors, which never change with the data. */
  const KINDS = [
    { id: "video", label: "视频" },
    { id: "image", label: "图片" },
    { id: "audio", label: "音频" },
    { id: "document", label: "文档" },
    { id: "archive", label: "压缩包和镜像" },
    { id: "program", label: "程序和系统" },
    { id: "code", label: "开发文件" },
    { id: "other", label: "其他" },
  ];

  const kindLabel = (id) => KINDS.find((k) => k.id === id)?.label ?? "其他";
  const kindIndex = (id) => Math.max(0, KINDS.findIndex((k) => k.id === id));

  /* The well-known places a scan points at. Diskly never touches them: this says
     what they are and what the system offers for them. */
  const SPOTS = {
    recycle: { label: "回收站", note: "清空回收站就能腾出这些空间。" },
    downloads: { label: "下载文件夹", note: "用过的安装包和压缩包常常留在这里。" },
    temp: { label: "临时文件", note: "可以在 Windows 设置的“存储 > 临时文件”里清理。" },
    "app-cache": { label: "应用缓存", note: "浏览器和应用会按需重建，最好在应用自己的设置里清理。" },
    "dev-deps": { label: "开发依赖", note: "node_modules 这类目录重新安装就能恢复，不用的项目可以清掉。" },
    "dev-cache": { label: "开发工具缓存", note: "包管理器的下载缓存，它们通常有自带的清理命令。" },
    containers: { label: "Docker 和 WSL", note: "虚拟磁盘只涨不缩，用 Docker 或 WSL 自带的办法压缩。" },
    games: { label: "Steam 游戏", note: "不玩的游戏可以在 Steam 里卸载，随时能重新下载。" },
    "update-cache": { label: "Windows 更新缓存", note: "用系统的“磁盘清理”可以移除。" },
    "windows-old": { label: "旧版 Windows", note: "用“磁盘清理”可以移除，移除后不能再退回旧系统。" },
    installers: { label: "安装程序缓存", note: "系统卸载和修复软件时要用，不要手动删除。" },
    winsxs: { label: "系统组件", note: "系统运行需要它，不要手动删除。" },
    restore: { label: "系统还原和卷影副本", note: "可以在“系统保护”里调低它的上限。" },
    "system-files": { label: "休眠和页面文件", note: "系统文件，不要直接删除。关闭休眠可以移除 hiberfil.sys。" },
  };

  /* Where the space went on the shown disks, added together. A scan that says
     nothing about this simply adds nothing. */
  function mergeInsights(pairs) {
    const files = [];
    const kinds = new Map();
    const extensions = new Map();
    const ranges = new Map();
    const spots = new Map();
    let any = false;
    for (const pair of pairs) {
      if (pair.b < 0) continue;
      const snap = pair.volume.snapshots[pair.b];
      const insights = pair.volume.insights?.[snap.id];
      if (!insights) continue;
      any = true;
      for (const f of insights.files) files.push({ ...f, letter: snap.letter, key: pair.volume.key });
      for (const k of insights.kinds) {
        const seen = kinds.get(k.kind) || { kind: k.kind, size: 0, count: 0 };
        seen.size += k.size;
        seen.count += k.count;
        kinds.set(k.kind, seen);
      }
      for (const e of insights.extensions) {
        const seen = extensions.get(e.ext) || { ext: e.ext, kind: e.kind, size: 0, count: 0 };
        seen.size += e.size;
        seen.count += e.count;
        extensions.set(e.ext, seen);
      }
      for (const r of insights.ranges) {
        const key = r.upper ?? "last";
        const seen = ranges.get(key) || { upper: r.upper ?? null, size: 0, count: 0 };
        seen.size += r.size;
        seen.count += r.count;
        ranges.set(key, seen);
      }
      for (const s of insights.spots) {
        const seen = spots.get(s.id) || { id: s.id, size: 0, places: 0, largest: "", largestSize: 0, letter: "", key: null };
        seen.size += s.size;
        seen.places += s.places;
        if (s.largest_size > seen.largestSize) {
          Object.assign(seen, { largest: s.largest, largestSize: s.largest_size, letter: snap.letter, key: pair.volume.key });
        }
        spots.set(s.id, seen);
      }
    }
    if (!any) return null;
    const bySize = (x, y) => y.size - x.size;
    return {
      files: files.sort(bySize),
      kinds: [...kinds.values()].sort(bySize),
      extensions: [...extensions.values()].sort(bySize),
      ranges: [...ranges.values()].sort((x, y) => (x.upper ?? Infinity) - (y.upper ?? Infinity)),
      spots: [...spots.values()].sort(bySize),
    };
  }

  function rangeLabel(lower, upper) {
    const short = (n) => formatBytes(n).replace(/\.0 /, " ");
    if (upper === null || upper === undefined) return `${short(lower)} 以上`;
    if (!lower) return `${short(upper)} 以下`;
    return `${short(lower)} 到 ${short(upper)}`;
  }

  /* The sentence that says it all about file sizes: how few files hold how much. */
  function bigFilesLine(ranges) {
    const total = ranges.reduce((sum, r) => sum + r.size, 0);
    if (!total) return null;
    const totalFiles = ranges.reduce((sum, r) => sum + r.count, 0);
    let size = 0;
    let count = 0;
    let lower = null;
    for (let i = ranges.length - 1; i > 0 && size < total * 0.5; i -= 1) {
      size += ranges[i].size;
      count += ranges[i].count;
      lower = ranges[i - 1].upper;
    }
    if (!count || lower === null) return null;
    const share = Math.round((size / total) * 100);
    const fewShare = (count / totalFiles) * 100;
    const few = fewShare < 1 ? "不到 1%" : `${Math.round(fewShare)}%`;
    return `${formatBytes(lower).replace(/\.0 /, " ")} 以上的 ${formatCountOf(count, "个文件")}占了 ${share}% 的空间，它们只是所有文件的 ${few}。`;
  }

  /* ---- The long view ---- */

  const SECONDS_PER_MONTH = 30.44 * 86400;

  /* How fast a disk is filling, from recent records: a straight line through them.
     null unless there is enough to go on and the disk really is filling. */
  function forecast(records, now) {
    const recent = (records || []).filter((r) => now - r.at <= 90 * 86400);
    if (recent.length < 3) return null;
    const span = recent[recent.length - 1].at - recent[0].at;
    if (span < 14 * 86400) return null;
    const used = (r) => r.total - r.free;
    const meanT = recent.reduce((sum, r) => sum + r.at, 0) / recent.length;
    const meanU = recent.reduce((sum, r) => sum + used(r), 0) / recent.length;
    let top = 0;
    let bottom = 0;
    for (const r of recent) {
      top += (r.at - meanT) * (used(r) - meanU);
      bottom += (r.at - meanT) ** 2;
    }
    const perSecond = bottom ? top / bottom : 0;
    const perMonth = perSecond * SECONDS_PER_MONTH;
    if (perMonth < 64 * 1024 * 1024) return null;
    const newest = recent[recent.length - 1];
    const months = newest.free / perMonth;
    return { perMonth, months, tooFar: months > 60 };
  }

  function forecastLine(letter, f) {
    if (!f) return null;
    const speed = `${letter}: 最近每月多用约 ${formatBytes(f.perMonth)}`;
    if (f.tooFar) return `${speed}，短期内不会写满。`;
    if (f.months < 1) return `${speed}，按这个速度不到一个月就会写满。`;
    return `${speed}，按这个速度约 ${Math.round(f.months)} 个月后写满。`;
  }

  /* How the top-level folders changed since the oldest record of the same file
     system and engine. A folder missing from either end, or holding something that
     could not be read there, has no known size, so it is left out rather than taken
     for new, gone or shrunk. Records from before these were kept compare nothing.
     `long_term_base` in store.rs picks the same oldest record. */
  function longTerm(records) {
    const list = records || [];
    const last = list[list.length - 1];
    const knows = (r) => r.top?.length && r.serial != null && Array.isArray(r.unread_top);
    if (!last || !knows(last)) return null;
    const first = list.find((r) => knows(r) && r.engine === last.engine && r.serial === last.serial);
    if (!first || first.id === last.id) return null;
    const before = new Map(first.top);
    const unknown = new Set([...first.unread_top, ...last.unread_top].map((name) => name.toLowerCase()));
    const rows = last.top
      .filter(([name]) => before.has(name) && !unknown.has(name.toLowerCase()))
      .map(([name, size]) => ({ name, size, delta: size - before.get(name) }))
      .filter((row) => Math.abs(row.delta) >= 1024 * 1024)
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
      .slice(0, 5);
    return rows.length ? { from: first.at, rows } : null;
  }

  function pathOf(table, i) {
    const parts = [];
    for (let at = i; at > 0; at = table.parents[at]) parts.push(table.names[at]);
    return parts.reverse().join("\\");
  }

  function displayPath(letter, rel) {
    return rel ? `${letter}:\\${rel}` : `${letter}:\\`;
  }

  /* ---- What to compare ---- */

  function recordSnapshot(record) {
    return {
      id: record.id, taken_at: record.at, letter: record.letter, engine: record.engine,
      total_bytes: record.total ?? null, free_bytes: record.free ?? null,
      files: record.files ?? null, dirs: record.dirs ?? null, summary_only: true,
    };
  }

  /* Exact IDs win, including two scans in the same second. If details were
     pruned, the matching record wins over an older snapshot. Only a volume not
     scanned at the requested time may carry an earlier result forward. */
  function selectScan(volume, id, run) {
    const snapshots = volume.snapshots;
    const records = (volume.records || []).filter((r) => Number.isFinite(r.at));
    const exact = snapshots.findIndex((s) => s.id === id);
    if (exact >= 0) return { b: exact, summary: null, carried: false };
    const record = records.find((r) => r.id === id);
    if (record) return { b: -1, summary: recordSnapshot(record), carried: false };
    const ownRun = run && run.scan_id === id
      ? run.volumes.find((v) => volume.key ? v.volume_key === volume.key : !v.volume_key && v.letter === volume.letter)
      : null;
    if (ownRun && (ownRun.stored || ownRun.status === "complete")) {
      return { b: -1, carried: false, summary: {
        id, taken_at: run.started_at, letter: ownRun.letter, engine: ownRun.engine,
        files: ownRun.files, dirs: null, total_bytes: null, free_bytes: null, summary_only: true,
      } };
    }
    const time = run && run.scan_id === id ? run.started_at : Number(String(id).split("-")[0]);
    const candidates = [
      ...snapshots.map((s, b) => ({ id: s.id, at: s.taken_at, b, summary: null })),
      ...records.filter((r) => !snapshots.some((s) => s.id === r.id)).map((r) => ({ id: r.id, at: r.at, b: -1, summary: recordSnapshot(r) })),
    ].filter((s) => !id || s.at < time).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    const selected = candidates[0];
    return selected ? { b: selected.b, summary: selected.summary, carried: Boolean(id) } : { b: -1, summary: null, carried: false };
  }

  function selectedSnapshot(pair) {
    return pair.b >= 0 ? pair.volume.snapshots[pair.b] : pair.summary || null;
  }

  /* Trend/forecast data must stop at the selected result too. */
  function recordsThrough(volume, snapshot) {
    if (!snapshot) return [];
    const records = volume.records?.length ? volume.records
      : volume.snapshots.map((s) => ({ id: s.id, at: s.taken_at, total: s.total_bytes, free: s.free_bytes }));
    const exact = records.findIndex((r) => r.id === snapshot.id);
    if (exact >= 0) return records.slice(0, exact + 1);
    const earlier = records.filter((r) => r.at < snapshot.taken_at);
    if (snapshot.total_bytes != null && snapshot.free_bytes != null) earlier.push({
      id: snapshot.id, at: snapshot.taken_at, total: snapshot.total_bytes, free: snapshot.free_bytes,
      engine: snapshot.engine, serial: snapshot.serial, top: [], unread_top: null,
    });
    return earlier;
  }

  function resolvePairs(volumes, fromId, toId, run = null) {
    return volumes.map((volume) => {
      const snapshots = volume.snapshots;
      const selection = selectScan(volume, toId, run);
      const { b } = selection;
      const result = (a, reason) => ({ volume, ...selection, a, reason });
      if (b < 0) return result(-1, selection.summary ? "archived" : "none");
      /* Nothing to compare with: because this is the start, or because it had to go. */
      const alone = (volume.records?.length || 0) > snapshots.length && snapshots.length === 1 ? "pruned" : "first";
      if (fromId) {
        const start = selectScan(volume, fromId, run);
        const a = start.b;
        if (start.summary) return result(-1, "archived-base");
        if (a < 0) return result(-1, alone);
        if (a === b) return result(-1, "same-scan");
        if (a > b) return result(-1, "order");
        const status = pairStatus(snapshots[a], snapshots[b]);
        return result(a, status.reason);
      }
      const a = previousComparable(snapshots, b);
      if (a >= 0) return result(a, null);
      if (b === 0) return result(-1, alone);
      return result(b - 1, pairStatus(snapshots[b - 1], snapshots[b]).reason);
    });
  }

  /* What a pair says: a comparison if it means something, else its reason. */
  function withComparisons(pairs) {
    return pairs.map((pair) => ({
      ...pair,
      cmp: pair.a >= 0 && pair.b >= 0 && !pair.reason ? compare(pair.volume, pair.a, pair.b) : null,
    }));
  }

  /* Below this, a change in used space is everyday noise (logs, caches). */
  const QUIET_BYTES = 32 * 1024 * 1024;

  /* The one sentence the report opens with. */
  function headline(pairs, options) {
    const { adjacent = true, now = Date.now() / 1000 } = options || {};
    const compared = pairs.filter((p) => p.cmp);
    const letters = (list) => list.map((p) => `${p.volume.letter}:`).join("、");
    if (!compared.length) {
      if (pairs.some((p) => p.summary)) return { title: pairs.some((p) => p.b >= 0) ? "部分磁盘仅保留摘要" : "这次扫描仅保留摘要", detail: reasonText("archived") };
      const scanned = pairs.filter((p) => p.b >= 0);
      if (!scanned.length) {
        return { title: "还没有可显示的扫描", detail: "回到 Diskly 点“扫描”，开始第一次扫描。" };
      }
      if (scanned.every((p) => p.reason === "first")) {
        return {
          title: "第一次扫描已完成",
          detail: `已记下 ${letters(scanned)} 的现状。下次扫描就能看到哪些目录变大或变小。`,
        };
      }
      return { title: "这次无法比较目录变化", detail: reasonText(scanned.find((p) => p.reason !== "first")?.reason) };
    }

    const base = compared[0].cmp.snapA.taken_at;
    const since = adjacent ? "比上次" : `比 ${formatDay(base)}`;
    const ago = formatAgo(base, now);
    const detailTail = adjacent ? `上次扫描是${/^\d/.test(ago) ? " " : ""}${ago}。` : "";
    const changed = compared.filter((p) => Math.abs(p.cmp.usedDelta) >= QUIET_BYTES);
    const name = (p) => `${p.cmp.snapB.letter}:`;

    if (!changed.length) {
      const total = compared.reduce((sum, p) => sum + p.cmp.usedDelta, 0);
      const subject = compared.length === 1 ? `${name(compared[0])} ` : "";
      const how = total === 0 ? "已用空间没有变化。" : `已用空间相差 ${formatBytes(total)}。`;
      return { title: `${subject}${since}几乎没有变化`, detail: `${how}${detailTail}` };
    }

    const verb = (delta) => (delta > 0 ? "多用了" : "少用了");
    const up = changed.some((p) => p.cmp.usedDelta > 0);
    const down = changed.some((p) => p.cmp.usedDelta < 0);
    let title;
    if (changed.length === 1) {
      const { usedDelta } = changed[0].cmp;
      title = `${name(changed[0])} ${since}${verb(usedDelta)} ${formatBytes(usedDelta)}`;
    } else if (up && down) {
      /* A net figure would hide the disk that filled up: say each one. */
      title = changed.map((p) => `${name(p)} ${verb(p.cmp.usedDelta)} ${formatBytes(p.cmp.usedDelta)}`).join("，");
    } else {
      const total = changed.reduce((sum, p) => sum + p.cmp.usedDelta, 0);
      title = `${changed.map(name).join("、")} ${since}共${verb(total)} ${formatBytes(total)}`;
    }

    const biggest = (sign) => {
      let top = null;
      for (const pair of compared) {
        const [first] = hotspots(pair.cmp, sign, 1);
        if (first !== undefined && (!top || Math.abs(pair.cmp.delta[first]) > Math.abs(top.delta))) {
          top = {
            delta: pair.cmp.delta[first],
            path: displayPath(pair.cmp.snapB.letter, pathOf(pair.volume.table, first)),
          };
        }
      }
      return top;
    };
    const parts = [];
    for (const [wanted, sign, words] of [[up, 1, "增加最多的是"], [down, -1, "减少最多的是"]]) {
      const top = wanted ? biggest(sign) : null;
      if (top) parts.push(`${words} ${top.path}，${formatDelta(top.delta)}。`);
    }
    if (!parts.length) parts.push("变化没有落在能读取的目录里。");
    return { title, detail: `${parts.join("")}${detailTail}` };
  }

  /* ---- Privacy ---- */

  const NOT_A_USER = new Set(["public", "default", "default user", "all users", "defaultapppool"]);
  const PERSONAL = new Set(["desktop", "documents", "downloads", "pictures", "videos", "music", "onedrive", "favorites", "contacts"]);

  /* The account names a report shows, from the folders under C:\Users. Windows allows
     a name of one character. */
  function accountNames(volumes) {
    const names = new Set();
    for (const volume of volumes) {
      const table = volume.table;
      const users = table.names.findIndex((name, i) => i > 0 && table.parents[i] === 0 && name.toLowerCase() === "users");
      if (users < 0) continue;
      table.names.forEach((name, i) => {
        if (table.parents[i] === users && !NOT_A_USER.has(name.toLowerCase())) names.add(name);
      });
    }
    return [...names].sort((x, y) => y.length - x.length);
  }

  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /* Returns a function that hides what `options` asks for in a path. The same
     folder always gets the same stand-in, so an AI can still tell them apart. */
  function makeRedactor(names, options) {
    const { accounts = true, personal = false } = options || {};
    const stand = new Map();
    const standIn = (name) => {
      const key = name.toLowerCase();
      if (!stand.has(key)) stand.set(key, `<名称${stand.size + 1}>`);
      return stand.get(key);
    };
    /* One character would match all over the place ("a" in "a-b.txt", "王" in "王者"),
       so such a name is only hidden as the folder directly under Users. */
    const isOneCharacter = (name) => [...name].length === 1;
    const oneCharacter = new Set(names.filter(isOneCharacter).map((name) => name.toLowerCase()));
    const longer = names.filter((name) => !isOneCharacter(name));
    /* A short Latin name must not eat into other words ("me" in "Documents").
       Chinese has no word boundaries, and a name inside a phrase still counts. */
    const nameRule = (name) =>
      /^[\x00-\x7f]*$/.test(name)
        ? `(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`
        : escapeRegExp(name);
    const pattern = longer.length ? new RegExp(longer.map(nameRule).join("|"), "gi") : null;
    return (path) => {
      let parts = path.split("\\");
      if (personal) {
        const users = parts.findIndex((part) => part.toLowerCase() === "users");
        if (users >= 0 && parts.length > users + 2) {
          const folder = parts.findIndex((part, i) => i > users + 1 && PERSONAL.has(part.toLowerCase().replace(/ - .*$/, "")));
          if (folder >= 0) {
            parts = parts.map((part, i) => (i > folder ? standIn(part) : part));
          }
        }
      }
      if (accounts) {
        parts = parts.map((part, i) => {
          if (i > 0 && parts[i - 1].toLowerCase() === "users" && oneCharacter.has(part.toLowerCase())) return "<用户>";
          let out = part.replace(/^(OneDrive - ).+$/i, "$1<组织>");
          if (pattern) out = out.replace(pattern, "<用户>");
          return out;
        });
      }
      return parts.join("\\");
    };
  }

  /* ---- The text for an AI ---- */

  const LIST_LIMIT = 15;

  function changeLines(pair, sign, redact) {
    const { cmp, volume } = pair;
    return hotspots(cmp, sign, LIST_LIMIT)
      .filter((i) => Math.abs(cmp.delta[i]) >= 1024 * 1024)
      .map((i) => {
        const tag = cmp.state[i] === STATE.ADDED ? "（新出现）" : cmp.state[i] === STATE.REMOVED ? "（已消失）" : "";
        const path = displayPath(cmp.snapB.letter, pathOf(volume.table, i));
        return { delta: cmp.delta[i], text: `${formatDelta(cmp.delta[i])}  ${redact(path)}${tag}` };
      });
  }

  function buildPrompt(pairs, options) {
    const { accounts = true, personal = false } = options || {};
    const volumes = pairs.map((p) => p.volume);
    const redact = makeRedactor(accountNames(volumes), { accounts, personal });
    const out = [];
    out.push("你是一位熟悉 Windows 的磁盘空间分析助手。下面是 Diskly（只读的磁盘变化观察工具）生成的扫描摘要，请帮我分析。");
    out.push("");
    out.push("【请回答】");
    out.push("1. 这段时间空间变化的主要原因可能是什么？");
    out.push("2. 哪些增长看起来正常（如系统更新、应用缓存），哪些值得留意？");
    out.push("3. 如果想腾出空间，建议先看哪里？涉及删除时，请说明风险和操作前要确认什么，不要建议直接删除系统目录。");
    out.push("");
    out.push("【读数据时请注意】");
    out.push("- 目录大小按文件名累计，硬链接的每个名称都算一次，所以目录合计可能高于系统已用空间。");
    out.push("- “未能读取”的目录大小未知，不代表变大或变小，不要据此下结论。");
    if (accounts || personal) out.push("- 路径已脱敏，<用户>、<组织>、<名称N> 是替换后的占位符。");
    out.push("");

    for (const pair of pairs) {
      const { volume, b } = pair;
      const snap = selectedSnapshot(pair);
      if (!snap) continue;
      out.push(`【${snap.letter}: 盘】`);
      if (b < 0) {
        out.push(`所选扫描：${formatDate(snap.taken_at)}，仅保留摘要。`);
        if (snap.total_bytes != null && snap.free_bytes != null) out.push(`已用 ${formatBytes(snap.total_bytes - snap.free_bytes)}，共 ${formatBytes(snap.total_bytes)}，可用 ${formatBytes(snap.free_bytes)}。`);
        else out.push("这次扫描的容量记录已不可用，不能用当前容量代替。");
        if (snap.files != null) out.push(`${formatCountOf(snap.files, "个文件")}。`);
        out.push(reasonText("archived"));
        if (pair.carried) out.push("所选时间没有这块盘的新结果，以上是此前保留的摘要。");
        out.push("");
        continue;
      }
      out.push(`已用 ${formatBytes(snap.total_bytes - snap.free_bytes)}，共 ${formatBytes(snap.total_bytes)}，可用 ${formatBytes(snap.free_bytes)}。${snap.file_system || ""}。`);
      out.push(`所选扫描：${formatDate(snap.taken_at)}，${engineName(snap.engine)}，${formatCountOf(snap.files, "个文件")}，${formatCountOf(snap.dirs, "个目录")}。`);
      if (pair.carried) out.push("所选时间没有这块盘的新结果，以上是此前完成的扫描。");
      const insights = volume.insights?.[snap.id];
      if (insights) {
        if (insights.kinds.length) {
          out.push(`占用最多的文件类型：${insights.kinds.slice(0, 5).map((k) => `${kindLabel(k.kind)} ${formatBytes(k.size)}`).join("，")}。`);
        }
        if (insights.files.length) {
          out.push("最大的文件：");
          for (const f of insights.files.slice(0, LIST_LIMIT)) out.push(`  ${formatBytes(f.size)}  ${redact(displayPath(snap.letter, f.path))}`);
        }
      }
      const big = sizeHotspots(volume, b, LIST_LIMIT).filter((i) => (volume.table.sizes[b][i] ?? 0) >= 1024 * 1024);
      if (big.length) {
        out.push("最占地方的目录：");
        for (const i of big) out.push(`  ${formatBytes(volume.table.sizes[b][i])}  ${redact(displayPath(snap.letter, pathOf(volume.table, i)))}`);
      }
      if (!volume.connected) out.push("这块盘本次未连接，以上是它最后一次扫描的情况。");
      if (!pair.cmp) {
        const once = volume.connected ? "这是第一次扫描，还没有可比较的历史。" : "它只扫描过一次，没有可比较的历史。";
        out.push(pair.reason === "first" ? once : `没有目录变化可比较：${reasonText(pair.reason)}`);
        out.push("");
        continue;
      }
      const { cmp } = pair;
      out.push(`对比基准：${formatDate(cmp.snapA.taken_at)}。`);
      out.push(`系统已用空间变化 ${formatDelta(cmp.usedDelta)}；能归到目录的变化 ${formatDelta(cmp.attributed)}。`);
      const grew = changeLines(pair, 1, redact);
      const shrank = changeLines(pair, -1, redact);
      out.push("变大最多的目录：");
      out.push(...(grew.length ? grew.map((l) => `  ${l.text}`) : ["  （没有超过 1 MB 的增长）"]));
      out.push("释放最多的目录：");
      out.push(...(shrank.length ? shrank.map((l) => `  ${l.text}`) : ["  （没有超过 1 MB 的减少）"]));

      const files = volume.file_changes[cmp.snapB.id];
      if (files && !files.unavailable && files.base === cmp.snapA.id) {
        const list = [...files.added, ...files.removed, ...files.changed]
          .map((f) => ({ path: f.path, delta: f.new - f.old }))
          .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
          .slice(0, LIST_LIMIT);
        if (list.length) {
          out.push("变化最大的文件：");
          for (const f of list) out.push(`  ${formatDelta(f.delta)}  ${redact(displayPath(snap.letter, f.path))}`);
        }
      }
      const unread = [...new Set([...(volume.table.unread[cmp.a] || []), ...(volume.table.unread[cmp.b] || [])])];
      if (unread.length) {
        const sample = unread.slice(0, 8).map((i) => redact(displayPath(snap.letter, pathOf(volume.table, i))));
        out.push(`未能读取的目录共 ${unread.length} 个，例如：`);
        for (const path of sample) out.push(`  ${path}`);
      }
      out.push("");
    }
    return out.join("\n").trimEnd();
  }

  return {
    KINDS,
    SPOTS,
    STATE,
    accountNames,
    bigFilesLine,
    buildPrompt,
    childrenOf,
    compare,
    displayPath,
    engineName,
    forecast,
    forecastLine,
    formatAgo,
    formatBytes,
    formatCount,
    formatCountOf,
    formatDate,
    formatDay,
    formatDelta,
    formatSeconds,
    headline,
    hotspots,
    kindIndex,
    kindLabel,
    longTerm,
    makeRedactor,
    mergeInsights,
    pairStatus,
    pathOf,
    previousComparable,
    rangeLabel,
    recordsThrough,
    reasonText,
    resolvePairs,
    selectedSnapshot,
    sizeHotspots,
    squarify,
    withComparisons,
  };
})();

if (typeof module !== "undefined") module.exports = DisklyLib;
