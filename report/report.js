/* The report page. Everything from a scan reaches the page through textContent,
   setAttribute on harmless attributes, or numbers: never as markup. */

(() => {
  const L = DisklyLib;
  const { STATE } = L;
  const data = JSON.parse(document.getElementById("diskly-data").textContent);
  const app = document.getElementById("app");
  const bar = document.getElementById("bar");
  const dialog = document.getElementById("ai-dialog");

  /* In the tests and on the real page alike, one object holds what is chosen. */
  const ui = {
    filter: "all", /* a volume key, or "all" */
    from: null,
    to: null,
    /* Which volume and folder the folder list shows; null: the list of disks. */
    browse: null,
    sort: "size",
    showAllGrew: false,
    showAllShrank: false,
    fileTab: "added",
    filesShown: 12,
    redactAccounts: true,
    redactPersonal: false,
  };

  /* ---- Building blocks ---- */

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
    for (const child of children) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }

  const SVG = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    return node;
  }

  function icon(viewBox, path, className) {
    const root = svgEl("svg", { viewBox, "aria-hidden": "true" });
    if (className) root.setAttribute("class", className);
    root.append(svgEl("path", {
      d: path, fill: "none", stroke: "currentColor", "stroke-width": "1.7",
      "stroke-linecap": "round", "stroke-linejoin": "round",
    }));
    return root;
  }

  const chevron = () => icon("0 0 8 13", "M1.5 1.5L6.5 6.5L1.5 11.5", "chevron");

  function brandMark() {
    const root = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    const ring = svgEl("circle", { cx: 12, cy: 12, r: 8.5, fill: "none", stroke: "currentColor", "stroke-width": 3.4, opacity: 0.28 });
    const arc = svgEl("path", { d: "M12 3.5a8.5 8.5 0 0 1 8.2 10.7", fill: "none", "stroke-width": 3.4, "stroke-linecap": "round" });
    arc.style.stroke = "var(--grew)";
    root.append(ring, arc);
    return root;
  }

  /* ---- What is on screen ---- */

  const shownVolumes = () => (ui.filter === "all" ? data.volumes : data.volumes.filter((v) => v.key === ui.filter));

  function currentPairs() {
    return L.withComparisons(L.resolvePairs(shownVolumes(), ui.from, ui.to));
  }

  function scanChoices() {
    const seen = new Map();
    for (const volume of shownVolumes()) {
      for (const snap of volume.snapshots) {
        if (!seen.has(snap.id)) seen.set(snap.id, snap.taken_at);
      }
    }
    return [...seen.entries()].map(([id, at]) => ({ id, at })).sort((a, b) => b.at - a.at);
  }

  /* ---- Top bar ---- */

  let themeChoice = null;

  function loadTheme() {
    try {
      themeChoice = localStorage.getItem("diskly-theme");
    } catch {
      themeChoice = null;
    }
    applyTheme();
  }

  function applyTheme() {
    if (themeChoice) document.documentElement.dataset.theme = themeChoice;
    else delete document.documentElement.dataset.theme;
  }

  function cycleTheme() {
    themeChoice = themeChoice === null ? "light" : themeChoice === "light" ? "dark" : null;
    try {
      if (themeChoice) localStorage.setItem("diskly-theme", themeChoice);
      else localStorage.removeItem("diskly-theme");
    } catch {
      /* Only remembered for this visit then. */
    }
    applyTheme();
    renderBar();
  }

  function setFilter(filter) {
    ui.filter = filter;
    ui.from = null;
    ui.to = null;
    ui.browse = null;
    ui.showAllGrew = false;
    ui.showAllShrank = false;
    ui.filesShown = 12;
    render();
  }

  function renderBar() {
    const options = [{ key: "all", label: "全部" }];
    for (const v of data.volumes) if (v.key) options.push({ key: v.key, label: `${v.letter}:` });
    const segments = options.length > 2
      ? el("div", { class: "segments", role: "group", "aria-label": "选择磁盘" },
        ...options.map((o) => el("button", {
          type: "button",
          "aria-pressed": String(ui.filter === o.key),
          text: o.label,
          onclick: () => setFilter(o.key),
        })))
      : null;
    const themeLabel = themeChoice === "light" ? "外观：浅色" : themeChoice === "dark" ? "外观：深色" : "外观：跟随系统";
    const themeIcon = themeChoice === "light"
      ? "M9 2.5v1.6M9 13.9v1.6M2.5 9h1.6M13.9 9h1.6M4.4 4.4l1.1 1.1M12.5 12.5l1.1 1.1M4.4 13.6l1.1-1.1M12.5 5.5l1.1-1.1M12 9a3 3 0 1 1-6 0a3 3 0 0 1 6 0z"
      : themeChoice === "dark"
        ? "M14.8 11.1A6.2 6.2 0 0 1 6.9 3.2a6.2 6.2 0 1 0 7.9 7.9z"
        : "M9 2.6a6.4 6.4 0 1 0 0 12.8a6.4 6.4 0 0 0 0-12.8zM9 2.6v12.8";
    bar.replaceChildren(el("div", { class: "bar-inner" },
      el("span", { class: "brand" }, brandMark(), el("span", { class: "brand-name", text: "Diskly" })),
      segments,
      el("span", { class: "bar-spacer" }),
      el("button", {
        type: "button", class: "icon-button", title: themeLabel, "aria-label": `${themeLabel}，点按切换`, onclick: cycleTheme,
      }, icon("0 0 18 18", themeIcon)),
      el("button", { type: "button", class: "pill", id: "open-ai", text: "复制给 AI", onclick: openAiDialog })));
  }

  /* ---- Opening sentence ---- */

  function renderHero(pairs) {
    const adjacent = !ui.from;
    const line = L.headline(pairs, { adjacent });
    const hero = el("div", { class: "hero" },
      el("h1", { text: line.title }),
      el("p", { text: line.detail }));
    const choices = scanChoices();
    if (choices.length >= 2) {
      const option = (c) => el("option", { value: c.id, text: L.formatDate(c.at) });
      const from = el("select", {
        "aria-label": "比较的起点",
        onchange: (e) => { ui.from = e.target.value === "previous" ? null : e.target.value; ui.browse = null; render(); },
      }, el("option", { value: "previous", text: "上一次" }), ...choices.map(option));
      from.value = ui.from || "previous";
      const to = el("select", {
        "aria-label": "比较的终点",
        onchange: (e) => { ui.to = e.target.value === "latest" ? null : e.target.value; ui.browse = null; render(); },
      }, el("option", { value: "latest", text: "最新一次" }), ...choices.map(option));
      to.value = ui.to || "latest";
      hero.append(el("div", { class: "compare-controls" },
        el("span", { text: "从" }), from, el("span", { text: "到" }), to));
    }
    return hero;
  }

  function runNotice() {
    const notes = [];
    const run = data.run;
    if (run && run.consent_declined) notes.push("没有获得管理员权限，这次用了普通扫描。部分系统目录读不到，它们标为“未知”，不计入变化。");
    if (run) {
      for (const v of run.volumes) {
        if (v.status === "cancelled") notes.push(`${v.letter}: 这次已取消，下面是它上一次完成的结果。`);
        if (v.status === "failed") notes.push(`${v.letter}: 这次扫描失败：${v.error || "原因未知"}。下面是它上一次完成的结果。`);
        if (v.status === "complete" && !v.stored && v.error) notes.push(`${v.letter}: ${v.error}。`);
      }
    }
    return notes.map((text) => el("p", { class: "notice", text }));
  }

  /* ---- Disks ---- */

  function diskRow(pair) {
    const { volume, cmp, reason, b } = pair;
    const snap = b >= 0 ? volume.snapshots[b] : null;
    const total = snap ? snap.total_bytes : volume.total_bytes;
    const free = snap ? snap.free_bytes : volume.free_bytes;
    const label = volume.label || "本地磁盘";

    const top = el("div", { class: "disk-top" },
      el("span", { class: "disk-letter", text: `${snap ? snap.letter : volume.letter}:` }),
      el("span", { class: "disk-label", text: label }));
    let changeText;
    if (cmp) {
      top.append(el("span", { class: cmp.usedDelta === 0 ? "disk-change none" : "disk-change", text: L.formatDelta(cmp.usedDelta) }));
      changeText = `和 ${L.formatDay(cmp.snapA.taken_at)} 相比 ${L.formatDelta(cmp.usedDelta)}`;
    } else {
      const once = volume.connected ? "第一次扫描" : "只扫描过一次";
      top.append(el("span", { class: "disk-change none", text: reason === "first" ? once : "没有可比的历史" }));
    }

    const rail = el("div", { class: "rail", "aria-hidden": "true" });
    if (total) {
      const used = total - free;
      const pct = (x) => `${Math.max(0, (x / total) * 100).toFixed(2)}%`;
      if (cmp && cmp.usedDelta > 0) {
        rail.append(el("span", { class: "used" }));
        rail.lastChild.style.width = pct(used - cmp.usedDelta);
        const grew = el("span", { class: "grew" });
        grew.style.width = `max(3px, ${pct(cmp.usedDelta)})`;
        rail.append(grew);
      } else if (cmp && cmp.usedDelta < 0) {
        rail.append(el("span", { class: "used" }));
        rail.lastChild.style.width = pct(used);
        const shrank = el("span", { class: "shrank" });
        shrank.style.width = `max(3px, ${pct(-cmp.usedDelta)})`;
        rail.append(shrank);
      } else {
        rail.append(el("span", { class: "used" }));
        rail.lastChild.style.width = pct(used);
      }
    }

    const facts = el("div", { class: "disk-facts" },
      el("span", { text: total ? `已用 ${L.formatBytes(total - free)}，共 ${L.formatBytes(total)}` : "容量未知" }),
      el("span", { text: total ? `可用 ${L.formatBytes(free)}` : "" }));

    const notes = [];
    if (!volume.connected) notes.push(el("p", { class: "disk-note", text: snap ? `本次未连接。这是 ${L.formatDate(snap.taken_at)} 的结果。` : "本次未连接。" }));
    if (!cmp && reason && reason !== "first" && reason !== "none") notes.push(el("p", { class: "disk-note", text: L.reasonText(reason) }));
    if (cmp && cmp.unknownTop > 0) notes.push(el("p", { class: "disk-note calm", text: `${cmp.unknownTop} 个目录未能读取，不计入变化。` }));
    if (snap && snap.letter !== volume.letter) notes.push(el("p", { class: "disk-note calm", text: `这个卷现在是 ${volume.letter}:。` }));
    if (cmp && cmp.snapA.letter !== cmp.snapB.letter) notes.push(el("p", { class: "disk-note calm", text: `这个卷的盘符从 ${cmp.snapA.letter}: 变成了 ${cmp.snapB.letter}:，历史按卷身份匹配，仍可比较。` }));

    const children = [top, rail, facts, ...notes];
    if (changeText) rail.setAttribute("title", changeText);
    if (ui.filter === "all" && volume.key && data.volumes.length > 1) {
      return el("button", {
        type: "button", class: "disk", "aria-label": `只看 ${volume.letter}: 盘`, onclick: () => setFilter(volume.key),
      }, ...children);
    }
    return el("div", { class: "disk" }, ...children);
  }

  /* ---- What changed ---- */

  function changeRow(item, scale, sign) {
    const { pair, node } = item;
    const { cmp, volume } = pair;
    const table = volume.table;
    const rel = L.pathOf(table, node);
    const full = L.displayPath(cmp.snapB.letter, rel);
    const cut = full.lastIndexOf("\\");
    const stateTag = cmp.state[node] === STATE.ADDED ? "新出现" : cmp.state[node] === STATE.REMOVED ? "已消失" : null;
    const width = el("span", { class: `bar-mark ${sign > 0 ? "grew" : "shrank"}` });
    width.style.width = `${Math.max(1, (Math.abs(cmp.delta[node]) / scale) * 100).toFixed(1)}%`;
    return el("button", {
      type: "button", class: "change", title: full, onclick: () => browseTo(volume.key, node, true),
    },
      el("span", { class: "change-line" },
        el("span", { class: "change-name" }, table.names[node], stateTag ? el("span", { class: "tag", text: stateTag }) : null),
        el("span", { class: "change-size", text: L.formatDelta(cmp.delta[node]) })),
      el("span", { class: "change-path", text: full.slice(0, cut + 1) }),
      width);
  }

  function changeList(pairs, sign) {
    const items = [];
    for (const pair of pairs) {
      if (!pair.cmp) continue;
      for (const node of L.hotspots(pair.cmp, sign, 20)) {
        if (Math.abs(pair.cmp.delta[node]) >= 1024 * 1024) items.push({ pair, node, size: Math.abs(pair.cmp.delta[node]) });
      }
    }
    return items.sort((a, b) => b.size - a.size);
  }

  function changeSection(title, items, scale, sign, showAll, toggle, emptyText) {
    const shown = showAll ? items : items.slice(0, 8);
    const rows = shown.map((item) => changeRow(item, scale, sign));
    if (items.length > 8) {
      rows.push(el("button", {
        type: "button", class: "more", text: showAll ? "收起" : `显示全部 ${items.length} 项`, onclick: toggle,
      }));
    }
    return el("section", {},
      el("h2", { text: title }),
      el("div", { class: "group" }, ...(rows.length ? rows : [el("div", { class: "empty", text: emptyText })])));
  }

  function renderChanges(pairs) {
    if (!pairs.some((p) => p.cmp)) return null;
    const grew = changeList(pairs, 1);
    const shrank = changeList(pairs, -1);
    const scale = Math.max(1, ...[...grew, ...shrank].map((x) => x.size));
    return el("div", { class: "changes" },
      changeSection("变大最多", grew, scale, 1, ui.showAllGrew, () => { ui.showAllGrew = !ui.showAllGrew; render(); }, "没有超过 1 MB 的增长。"),
      changeSection("变小最多", shrank, scale, -1, ui.showAllShrank, () => { ui.showAllShrank = !ui.showAllShrank; render(); }, "没有超过 1 MB 的减少。"));
  }

  /* ---- Folders ---- */

  function browseTo(key, node, scroll) {
    ui.browse = { key, node };
    render();
    if (scroll) document.getElementById("folders")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function folderRows(pair, parent) {
    const { volume, cmp, b } = pair;
    const table = volume.table;
    const sizes = table.sizes[b];
    const children = table.parents.reduce((list, p, i) => {
      if (p === parent) list.push(i);
      return list;
    }, []);
    const parentSize = sizes[parent] ?? 0;
    const unreadHere = new Set(table.unread[b] || []);
    const isUnknown = (i) => (cmp ? cmp.state[i] === STATE.UNKNOWN : unreadHere.has(i));
    const visible = children.filter((i) => (sizes[i] !== null && sizes[i] !== undefined) || (cmp && cmp.state[i] === STATE.REMOVED) || isUnknown(i));
    const rank = (i) => {
      if (ui.sort === "change" && cmp && !isUnknown(i)) return Math.abs(cmp.delta[i]);
      return sizes[i] ?? 0;
    };
    visible.sort((x, y) => rank(y) - rank(x));

    const hasKids = new Set();
    table.parents.forEach((p) => hasKids.add(p));

    const rows = visible.map((i) => {
      const unknown = isUnknown(i);
      const size = sizes[i];
      const share = el("span", { class: unknown ? "folder-share unknown" : "folder-share" });
      share.style.width = unknown ? "100%" : `${parentSize ? Math.max(0.5, ((size ?? 0) / parentSize) * 100).toFixed(1) : 0}%`;
      let changeText = "";
      let quiet = false;
      if (unknown) {
        changeText = "未知";
        quiet = true;
      } else if (cmp) {
        if (cmp.state[i] === STATE.ADDED) changeText = `${L.formatDelta(cmp.delta[i])}`;
        else if (cmp.state[i] === STATE.REMOVED) changeText = `${L.formatDelta(cmp.delta[i])}`;
        else if (cmp.delta[i] === 0) { changeText = "无变化"; quiet = true; } else changeText = L.formatDelta(cmp.delta[i]);
      }
      const tag = cmp && cmp.state[i] === STATE.ADDED ? "新出现" : cmp && cmp.state[i] === STATE.REMOVED ? "已消失" : null;
      const cells = [
        el("span", { class: "folder-main" },
          el("span", { class: "folder-name", title: table.names[i] }, table.names[i], tag ? el("span", { class: "tag", text: tag }) : null),
          share),
        el("span", { class: "folder-size", text: unknown ? "未知" : L.formatBytes(size ?? 0) }),
        el("span", { class: quiet ? "folder-change quiet" : "folder-change", text: changeText }),
      ];
      const enterable = hasKids.has(i) && !(cmp && cmp.state[i] === STATE.REMOVED && !hasKids.has(i));
      if (enterable) {
        cells.push(chevron());
        return el("button", { type: "button", class: "folder", onclick: () => browseTo(volume.key, i) }, ...cells);
      }
      cells.push(el("span"));
      return el("div", { class: "folder" }, ...cells);
    });

    /* The rest of this folder: its own files and folders too small to list. */
    const listed = visible.reduce((sum, i) => sum + (isUnknown(i) ? 0 : (sizes[i] ?? 0)), 0);
    const rest = parentSize - listed;
    if (rest > 0 && rows.length) {
      const share = el("span", { class: "folder-share" });
      share.style.width = `${parentSize ? Math.max(0.5, (rest / parentSize) * 100).toFixed(1) : 0}%`;
      rows.push(el("div", { class: "folder rest" },
        el("span", { class: "folder-main" }, el("span", { class: "folder-name", text: "文件和较小的目录" }), share),
        el("span", { class: "folder-size", text: L.formatBytes(rest) }),
        el("span", { class: "folder-change quiet" }),
        el("span")));
    }
    return rows;
  }

  function renderFolders(pairs) {
    const available = pairs.filter((p) => p.b >= 0 && p.volume.table.names.length > 0);
    if (!available.length) return null;

    let current = ui.browse && available.find((p) => p.volume.key === ui.browse.key);
    if (!current && available.length === 1) current = available[0];
    const node = current ? (ui.browse && ui.browse.key === current.volume.key ? ui.browse.node : 0) : 0;

    const sortControl = current && current.cmp
      ? el("div", { class: "segments", role: "group", "aria-label": "排序方式" },
        ...[["size", "按大小"], ["change", "按变化"]].map(([value, label]) => el("button", {
          type: "button", "aria-pressed": String(ui.sort === value), text: label,
          onclick: () => { ui.sort = value; render(); },
        })))
      : null;
    const head = el("div", { class: "folders-head" }, el("h2", { text: "目录" }), sortControl);

    if (!current) {
      const rows = available.map((pair) => {
        const snap = pair.volume.snapshots[pair.b];
        const used = pair.volume.table.sizes[pair.b][0] ?? 0;
        return el("button", { type: "button", class: "folder", onclick: () => browseTo(pair.volume.key, 0) },
          el("span", { class: "folder-main" }, el("span", { class: "folder-name", text: `${snap.letter}:\\ ${pair.volume.label || ""}` })),
          el("span", { class: "folder-size", text: L.formatBytes(used) }),
          el("span", { class: pair.cmp ? "folder-change" : "folder-change quiet", text: pair.cmp ? L.formatDelta(pair.cmp.attributed) : "" }),
          chevron());
      });
      return el("section", { id: "folders" }, head, el("div", { class: "group" }, ...rows));
    }

    const table = current.volume.table;
    const letter = current.volume.snapshots[current.b].letter;
    const chain = [];
    for (let at = node; at >= 0; at = table.parents[at]) chain.unshift(at);
    const crumbs = el("nav", { class: "crumbs", "aria-label": "当前位置" });
    if (available.length > 1) {
      crumbs.append(el("button", { type: "button", text: "所有磁盘", onclick: () => { ui.browse = null; render(); } }), el("span", { class: "sep", text: "\\" }));
    }
    chain.forEach((at, position) => {
      const name = at === 0 ? `${letter}:` : table.names[at];
      if (position === chain.length - 1) crumbs.append(el("span", { class: "here", "aria-current": "location", text: name }));
      else {
        crumbs.append(
          el("button", { type: "button", text: name, title: name, onclick: () => browseTo(current.volume.key, at) }),
          el("span", { class: "sep", text: "\\" }));
      }
    });

    const rows = folderRows(current, node);
    const summary = current.cmp && !Number.isNaN(current.cmp.delta[node]) && current.cmp.state[node] !== STATE.SAME
      ? `这个目录共 ${L.formatBytes(table.sizes[current.b][node] ?? 0)}，变化 ${L.formatDelta(current.cmp.delta[node])}。`
      : `这个目录共 ${L.formatBytes(table.sizes[current.b][node] ?? 0)}。`;
    return el("section", { id: "folders" },
      head,
      crumbs,
      el("p", { class: "section-hint", text: summary }),
      el("div", { class: "group" }, ...(rows.length ? rows : [el("div", { class: "empty", text: "这个目录下没有更多可显示的子目录。" })])));
  }

  /* ---- Files ---- */

  function renderFiles(pairs) {
    const lists = { added: [], removed: [], changed: [] };
    const counts = { added: 0, removed: 0, changed: 0 };
    const bytes = { added: 0, removed: 0, changed: 0 };
    const reasons = [];
    let usable = 0;
    for (const pair of pairs) {
      if (!pair.cmp) continue;
      const changes = pair.volume.file_changes[pair.cmp.snapB.id];
      const letter = pair.cmp.snapB.letter;
      if (!changes) continue;
      if (changes.unavailable) {
        reasons.push(`${letter}: ${changes.unavailable}，这里只比较目录。`);
        continue;
      }
      if (changes.base !== pair.cmp.snapA.id) {
        reasons.push(`${letter}: 文件明细只保留相邻两次扫描之间的，这次选择跨过了多次扫描。`);
        continue;
      }
      usable += 1;
      for (const kind of ["added", "removed", "changed"]) {
        for (const f of changes[kind]) lists[kind].push({ ...f, letter, delta: f.new - f.old });
      }
      counts.added += changes.added_count;
      counts.removed += changes.removed_count;
      counts.changed += changes.changed_count;
      bytes.added += changes.added_bytes;
      bytes.removed -= changes.removed_bytes;
      bytes.changed += changes.changed_delta;
    }
    if (!usable && !reasons.length) return null;

    const section = el("section", { id: "files" }, el("h2", { text: "文件" }));
    if (usable) {
      const tabs = [["added", "新增"], ["removed", "删除"], ["changed", "大小变化"]];
      const tabBar = el("div", { class: "segments", role: "group", "aria-label": "文件变化类型" },
        ...tabs.map(([kind, label]) => el("button", {
          type: "button", "aria-pressed": String(ui.fileTab === kind), text: `${label} ${L.formatCount(counts[kind])}`,
          onclick: () => { ui.fileTab = kind; ui.filesShown = 12; render(); },
        })));
      const list = lists[ui.fileTab].slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const rows = list.slice(0, ui.filesShown).map((f) => {
        const full = L.displayPath(f.letter, f.path);
        const cut = full.lastIndexOf("\\");
        return el("div", { class: "file" },
          el("span", { class: "file-path" }, full.slice(0, cut + 1), el("b", { text: full.slice(cut + 1) })),
          el("span", { class: "file-size", text: L.formatDelta(f.delta) }));
      });
      if (list.length > ui.filesShown) {
        rows.push(el("button", {
          type: "button", class: "more", text: `再显示 ${Math.min(list.length - ui.filesShown, 40)} 项`,
          onclick: () => { ui.filesShown += 40; render(); },
        }));
      }
      section.append(
        el("div", { class: "folders-head" }, tabBar),
        el("p", { class: "section-hint", text: `合计 ${L.formatDelta(bytes[ui.fileTab])}。这里最多列出每类最大的 200 个。` }),
        el("div", { class: "group" }, ...(rows.length ? rows : [el("div", { class: "empty", text: "这一类没有文件。" })])));
    }
    for (const reason of reasons) section.append(el("p", { class: "section-hint", text: reason }));
    return section;
  }

  /* ---- History ---- */

  function trendChart(volume) {
    const snaps = volume.snapshots;
    const used = snaps.map((s) => s.total_bytes - s.free_bytes);
    const low = Math.min(...used);
    const high = Math.max(...used);
    const span = Math.max(high - low, high * 0.01, 1);
    const floor = Math.max(0, low - span * 0.35);
    const top = high + span * 0.2;
    const W = 300;
    const H = 76;
    const first = snaps[0].taken_at;
    const last = snaps[snaps.length - 1].taken_at;
    const x = (t) => (last === first ? W / 2 : ((t - first) / (last - first)) * W);
    const y = (v) => H - ((v - floor) / (top - floor)) * (H - 4);
    const points = snaps.map((s, i) => `${x(s.taken_at).toFixed(1)},${y(used[i]).toFixed(1)}`).join(" ");

    const chart = svgEl("svg", {
      viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img",
      "aria-label": `${volume.letter}: 已用空间，从 ${L.formatBytes(used[0])} 到 ${L.formatBytes(used[used.length - 1])}`,
    });
    chart.append(svgEl("line", { class: "trend-floor", x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }));
    chart.append(svgEl("polyline", { class: "trend-line", points }));
    const cross = svgEl("line", { class: "trend-cross", y1: 0, y2: H, visibility: "hidden" });
    chart.append(cross);

    const tip = el("div", { class: "trend-tip", hidden: true });
    const box = el("div", { class: "trend" },
      el("h3", { text: `${volume.letter}: 已用空间` }),
      chart,
      el("div", { class: "trend-range" },
        el("span", { text: L.formatDay(first) }),
        el("span", { text: `${L.formatDay(last)}，${L.formatBytes(used[used.length - 1])}` })),
      tip);

    chart.addEventListener("pointermove", (event) => {
      const rect = chart.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * W;
      let best = 0;
      snaps.forEach((s, i) => {
        if (Math.abs(x(s.taken_at) - px) < Math.abs(x(snaps[best].taken_at) - px)) best = i;
      });
      const at = x(snaps[best].taken_at);
      cross.setAttribute("x1", at);
      cross.setAttribute("x2", at);
      cross.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.textContent = `${L.formatDate(snaps[best].taken_at)}，${L.formatBytes(used[best])}`;
      const left = (at / W) * rect.width + 16;
      const room = box.clientWidth - tip.offsetWidth - 6;
      tip.style.left = `${Math.max(6, Math.min(left - tip.offsetWidth / 2, room))}px`;
    });
    chart.addEventListener("pointerleave", () => {
      cross.setAttribute("visibility", "hidden");
      tip.hidden = true;
    });
    return box;
  }

  function renderHistory(pairs) {
    const volumes = shownVolumes().filter((v) => v.snapshots.length);
    if (!volumes.length) return null;
    const choices = scanChoices();
    /* Only scans really being compared are marked: a disk seen once has neither. */
    const compared = pairs.filter((p) => p.cmp);
    const fromIds = new Set(compared.map((p) => p.cmp.snapA.id));
    const toIds = new Set(compared.map((p) => p.cmp.snapB.id));
    const rows = choices.map((choice) => {
      const parts = [];
      for (const volume of volumes) {
        const snap = volume.snapshots.find((s) => s.id === choice.id);
        if (snap) parts.push(`${snap.letter}: ${L.formatBytes(snap.total_bytes - snap.free_bytes)}，${L.engineName(snap.engine)}`);
      }
      const isFrom = fromIds.has(choice.id);
      const isTo = toIds.has(choice.id);
      const role = isTo ? "终点" : isFrom ? "起点" : choices.length > 1 ? "设为起点" : "";
      const cells = [
        el("span", { text: L.formatDate(choice.at) }),
        el("span", { class: "scan-disks", text: parts.join("；") }),
        el("span", { class: isFrom || isTo ? "scan-role on" : "scan-role", text: role }),
      ];
      if (isFrom || isTo || choices.length < 2) return el("div", { class: "scan" }, ...cells);
      return el("button", {
        type: "button",
        class: "scan selectable",
        "aria-label": `和 ${L.formatDate(choice.at)} 的扫描比较`,
        onclick: () => {
          ui.from = choice.id;
          ui.browse = null;
          render();
          window.scrollTo({ top: 0, behavior: "smooth" });
        },
      }, ...cells);
    });
    const trends = volumes.filter((v) => v.snapshots.length >= 3);
    return el("section", { id: "history" },
      el("h2", { text: "历史" }),
      trends.length ? el("div", { class: "trends" }, ...trends.map((v) => el("div", { class: "group" }, trendChart(v)))) : null,
      el("div", { class: "group" }, ...rows));
  }

  /* ---- How sure is this ---- */

  function trustRow(pair) {
    const { volume, cmp, b } = pair;
    if (b < 0) {
      const run = volume.this_run;
      return el("details", {},
        el("summary", {}, el("span", { class: "title", text: `${volume.letter}:` }), el("span", { class: "sub", text: "没有可用的扫描结果" }), chevron()),
        el("div", { class: "detail-body" }, el("p", { text: run && run.error ? run.error : "这个卷还没有完成过扫描。" })));
    }
    const snap = volume.snapshots[b];
    const table = volume.table;
    const unreadIds = cmp
      ? [...new Set([...(table.unread[cmp.a] || []), ...(table.unread[cmp.b] || [])])]
      : (table.unread[b] || []);
    const unreadCount = unreadIds.length;
    const scanned = table.sizes[b][0] ?? snap.bytes;
    const used = snap.total_bytes - snap.free_bytes;
    const statusParts = [L.engineName(snap.engine), `用时 ${L.formatSeconds(snap.seconds)}`];
    statusParts.push(unreadCount ? `${unreadCount} 个目录未能读取` : "所有目录都已读取");

    const facts = el("dl", { class: "fact-list" },
      el("dt", { text: "扫描时间" }), el("dd", { text: L.formatDate(snap.taken_at) }),
      el("dt", { text: "扫描方式" }), el("dd", { text: snap.mft_fallback ? `${L.engineName(snap.engine)}（极速扫描未使用：${snap.mft_fallback}）` : L.engineName(snap.engine) }),
      el("dt", { text: "文件和目录" }), el("dd", { text: `${L.formatCountOf(snap.files, "个文件")}，${L.formatCountOf(snap.dirs, "个目录")}` }),
      el("dt", { text: "目录合计" }), el("dd", { text: L.formatBytes(scanned) }),
      el("dt", { text: "系统已用" }), el("dd", { text: L.formatBytes(used) }));

    const body = el("div", { class: "detail-body" }, facts);
    if (cmp) {
      body.append(el("p", { text: `和 ${L.formatDate(cmp.snapA.taken_at)} 相比：系统已用空间变化 ${L.formatDelta(cmp.usedDelta)}，能归到目录的变化 ${L.formatDelta(cmp.attributed)}。两者不同是正常的：卷影副本、未读取的目录和系统元数据都会影响前者。` }));
    }
    body.append(el("p", { text: "目录合计按文件名累计，硬链接的每个名称都算一次，所以可能高于系统已用空间。" }));
    if (snap.skipped_elsewhere > 0) {
      body.append(el("p", { text: `另有 ${L.formatCountOf(snap.skipped_elsewhere, "个条目")}未能读取，位置未知。` }));
    }
    if (unreadCount) {
      body.append(el("p", { text: `${unreadCount} 个目录未能读取，它们的大小未知，不计入变化。这不是空间被释放了。极速扫描可以读取其中大部分。` }));
      body.append(el("ul", { class: "path-list" },
        ...unreadIds.slice(0, 500).map((i) => el("li", { text: L.displayPath(snap.letter, L.pathOf(table, i)) }))));
    }
    for (const issue of volume.issues || []) body.append(el("p", { text: issue }));
    return el("details", {},
      el("summary", {}, el("span", { class: "title", text: `${snap.letter}:` }), el("span", { class: "sub", text: statusParts.join("，") }), chevron()),
      body);
  }

  function renderTrust(pairs) {
    if (!pairs.length) return null;
    return el("section", { id: "trust" },
      el("h2", { text: "这份结果有多可靠" }),
      el("div", { class: "group" }, ...pairs.map(trustRow)));
  }

  /* ---- The AI dialog ---- */

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* A browser may refuse this on a local file; the older way still works. */
    }
    const area = el("textarea", { readonly: true, "aria-hidden": "true" });
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    dialog.append(area);
    area.select();
    let done = false;
    try {
      done = document.execCommand("copy");
    } catch {
      done = false;
    }
    area.remove();
    return done;
  }

  function renderAiDialog() {
    const pairs = currentPairs();
    const preview = el("pre", {
      class: "prompt-preview", id: "ai-preview", tabindex: "0", "aria-label": "将要复制的内容",
      text: L.buildPrompt(pairs, { accounts: ui.redactAccounts, personal: ui.redactPersonal }),
    });
    const option = (id, label, get, set) => {
      const input = el("input", {
        type: "checkbox", id,
        onchange: (event) => {
          set(event.target.checked);
          preview.textContent = L.buildPrompt(pairs, { accounts: ui.redactAccounts, personal: ui.redactPersonal });
        },
      });
      input.checked = get();
      return el("label", {}, input, label);
    };
    const copy = el("button", {
      type: "button",
      class: "pill",
      id: "ai-copy",
      text: "复制",
      onclick: async () => {
        const ok = await copyText(preview.textContent);
        copy.textContent = ok ? "已复制" : "无法复制，请手动选择文字";
        if (ok) setTimeout(() => { copy.textContent = "复制"; }, 2000);
      },
    });
    dialog.replaceChildren(
      el("div", { class: "dialog-head" },
        el("h2", { id: "ai-title", text: "复制给 AI" }),
        el("p", { text: "复制后粘贴到你常用的 AI（如 ChatGPT、Claude）。Diskly 不会发送任何内容。" })),
      el("div", { class: "options" },
        option("redact-accounts", "隐藏用户名和组织名", () => ui.redactAccounts, (v) => { ui.redactAccounts = v; }),
        option("redact-personal", "隐藏个人文件夹里的名称", () => ui.redactPersonal, (v) => { ui.redactPersonal = v; })),
      preview,
      el("div", { class: "dialog-foot" },
        el("p", { class: "warn", text: "这段文字可能包含目录名和文件名。发送前请看一眼。" }),
        el("button", { type: "button", class: "pill quiet", text: "关闭", onclick: () => dialog.close() }),
        copy));
  }

  function openAiDialog() {
    renderAiDialog();
    dialog.showModal();
    document.getElementById("ai-copy").focus();
  }

  /* Clicking the dimmed page closes the dialog. */
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  /* ---- The whole page ---- */

  function render() {
    renderBar();
    const pairs = currentPairs();
    const disks = el("section", { id: "disks", "aria-label": "磁盘" },
      el("div", { class: "group" }, ...pairs.map(diskRow)));
    disks.style.marginTop = "0";
    const footer = el("footer", {},
      el("p", { text: "Diskly 只读取信息，不会修改或删除任何文件。这份报告保存在你的电脑上，不联网。其中包含目录名和文件名，分享前请留意。" }),
      el("p", { text: `Diskly ${data.app_version}，生成于 ${L.formatDate(data.generated_at)}。` }));
    const y = window.scrollY;
    app.replaceChildren(...[
      renderHero(pairs),
      ...runNotice(),
      disks,
      renderChanges(pairs),
      renderFolders(pairs),
      renderFiles(pairs),
      renderHistory(pairs),
      renderTrust(pairs),
      footer,
    ].filter(Boolean));
    window.scrollTo(0, y);
    /* The rails animate once, when the page opens, not on every choice. */
    if (hasOpened) document.querySelectorAll(".rail span").forEach((s) => { s.style.animation = "none"; });
    hasOpened = true;
  }

  let hasOpened = false;

  if (!data.volumes.length) {
    renderBar();
    app.replaceChildren(el("div", { class: "hero" },
      el("h1", { text: "还没有可显示的扫描" }),
      el("p", { text: "回到 Diskly 点“扫描”，开始第一次扫描。" })));
  } else {
    if (data.volumes.length === 1 && data.volumes[0].key) ui.filter = data.volumes[0].key;
    loadTheme();
    render();
  }
})();
