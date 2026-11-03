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
    order: "起点要早于终点，请重新选择。",
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

  function pathOf(table, i) {
    const parts = [];
    for (let at = i; at > 0; at = table.parents[at]) parts.push(table.names[at]);
    return parts.reverse().join("\\");
  }

  function displayPath(letter, rel) {
    return rel ? `${letter}:\\${rel}` : `${letter}:\\`;
  }

  /* ---- What to compare ---- */

  /* For each volume: which two scans to compare. Without choices it is the newest
     scan against the newest comparable one before it. A chosen scan is matched by
     time, because each volume has its own scans. */
  function resolvePairs(volumes, fromId, toId) {
    return volumes.map((volume) => {
      const snapshots = volume.snapshots;
      if (!snapshots.length) return { volume, a: -1, b: -1, reason: "none" };
      const position = (id) => {
        const time = Number(String(id).split("-")[0]);
        let found = -1;
        snapshots.forEach((s, i) => {
          if (s.taken_at <= time) found = i;
        });
        return found;
      };
      const b = toId ? position(toId) : snapshots.length - 1;
      if (b < 0) return { volume, a: -1, b: -1, reason: "none" };
      if (fromId) {
        const a = position(fromId);
        if (a < 0 || b === 0) return { volume, a: -1, b, reason: "first" };
        if (a === b) return { volume, a: -1, b, reason: "same-scan" };
        if (a > b) return { volume, a: -1, b, reason: "order" };
        const status = pairStatus(snapshots[a], snapshots[b]);
        return { volume, a, b, reason: status.reason };
      }
      const a = previousComparable(snapshots, b);
      if (a >= 0) return { volume, a, b, reason: null };
      if (b === 0) return { volume, a: -1, b, reason: "first" };
      return { volume, a: b - 1, b, reason: pairStatus(snapshots[b - 1], snapshots[b]).reason };
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

  /* The account names a report shows, from the folders under C:\Users. */
  function accountNames(volumes) {
    const names = new Set();
    for (const volume of volumes) {
      const table = volume.table;
      const users = table.names.findIndex((name, i) => i > 0 && table.parents[i] === 0 && name.toLowerCase() === "users");
      if (users < 0) continue;
      table.names.forEach((name, i) => {
        if (table.parents[i] === users && !NOT_A_USER.has(name.toLowerCase()) && name.length >= 2) names.add(name);
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
    /* A short Latin name must not eat into other words ("me" in "Documents").
       Chinese has no word boundaries, and a name inside a phrase still counts. */
    const nameRule = (name) =>
      /^[\x00-\x7f]*$/.test(name)
        ? `(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`
        : escapeRegExp(name);
    const pattern = names.length ? new RegExp(names.map(nameRule).join("|"), "gi") : null;
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
        parts = parts.map((part) => {
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
      if (b < 0) continue;
      const snap = volume.snapshots[b];
      out.push(`【${snap.letter}: 盘】`);
      out.push(`已用 ${formatBytes(snap.total_bytes - snap.free_bytes)}，共 ${formatBytes(snap.total_bytes)}，可用 ${formatBytes(snap.free_bytes)}。${snap.file_system || ""}。`);
      out.push(`最新扫描：${formatDate(snap.taken_at)}，${engineName(snap.engine)}，${formatCountOf(snap.files, "个文件")}，${formatCountOf(snap.dirs, "个目录")}。`);
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
      out.push("变小最多的目录：");
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
    STATE,
    accountNames,
    buildPrompt,
    compare,
    displayPath,
    engineName,
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
    makeRedactor,
    pairStatus,
    pathOf,
    previousComparable,
    reasonText,
    resolvePairs,
    withComparisons,
  };
})();

if (typeof module !== "undefined") module.exports = DisklyLib;
