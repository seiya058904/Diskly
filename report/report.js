/* The report page. Everything from a scan reaches the page through textContent,
   setAttribute on harmless attributes, or numbers: never as markup.

   Smoothness comes from doing little: a choice redraws only the part it changes, what
   moves is transform and opacity, and nothing listens to scrolling. */

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
    /* Which volume and folder the map shows; null: the list of disks. */
    browse: null,
    sort: "size",
    kind: null,
    showAllGrew: false,
    showAllShrank: false,
    filesOpen: 12,
    showAllExtensions: false,
    fileTab: "added",
    filesShown: 12,
    redactAccounts: true,
    redactPersonal: false,
  };

  const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  const locateIcon = () => icon("0 0 16 16", "M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M11.5 8a3.5 3.5 0 1 1-7 0a3.5 3.5 0 0 1 7 0z");

  function brandMark() {
    const root = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    const ring = svgEl("circle", { cx: 12, cy: 12, r: 8.5, fill: "none", stroke: "currentColor", "stroke-width": 3.4, opacity: 0.26 });
    const arc = svgEl("path", { d: "M12 3.5a8.5 8.5 0 0 1 8.2 10.7", fill: "none", "stroke-width": 3.4, "stroke-linecap": "round" });
    arc.style.stroke = "var(--accent)";
    root.append(ring, arc);
    return root;
  }

  const percent = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);
  const seriesColor = (i) => (i >= 0 && i < 8 ? `var(--s${i})` : "var(--neutral)");

  function colored(node, color) {
    node.style.setProperty("--dot", color);
    return node;
  }

  function widened(node, part, whole, least = 0.6) {
    node.style.width = `${Math.max(least, percent(part, whole)).toFixed(2)}%`;
    return node;
  }

  /* A little in, one after another: `at` is its place in the sequence. */
  function placed(node, at) {
    node.style.setProperty("--at", String(at));
    return node;
  }

  /* ---- Floating things ---- */

  const tip = el("div", { class: "tip", role: "tooltip" });
  const toastBox = el("div", { class: "toast", role: "status", "aria-live": "polite" });
  document.body.append(tip, toastBox);

  /* A tooltip enhances: all it says can also be read elsewhere on the page. Following
     the pointer only moves it. Its text, and so layout, changes when the target does. */
  let tipText = "";
  let tipWidth = 0;
  let tipHeight = 0;
  let tipFrame = 0;
  let tipAt = null;

  function showTip(x, y, value, ...lines) {
    const shown = lines.filter(Boolean);
    const text = [value, ...shown].join("|");
    if (text !== tipText) {
      tipText = text;
      tip.replaceChildren(el("b", { text: value }), ...shown.map((line) => el("span", { text: line })));
      tipWidth = tip.offsetWidth;
      tipHeight = tip.offsetHeight;
    }
    tip.classList.add("on");
    tipAt = { x, y };
    if (tipFrame) return;
    tipFrame = requestAnimationFrame(() => {
      tipFrame = 0;
      const room = window.innerWidth - tipWidth - 10;
      const left = Math.max(10, Math.min(tipAt.x + 14, room));
      const top = tipAt.y + 18 + tipHeight > window.innerHeight - 8 ? tipAt.y - tipHeight - 12 : tipAt.y + 18;
      tip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(Math.max(8, top))}px, 0)`;
    });
  }

  function hideTip() {
    tip.classList.remove("on");
    tipText = "";
  }

  /* Numbers run up to their value once, as the page opens. */
  function countUp(node, value, format) {
    if (calm() || !(value > 0)) return;
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / 950);
      const eased = 1 - (1 - t) ** 4;
      node.textContent = format(t === 1 ? value : value * eased);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* A year is only worth saying when it is not this one. */
  function dayOf(at) {
    const year = new Date(at * 1000).getFullYear();
    const thisYear = new Date(data.generated_at * 1000).getFullYear();
    return year === thisYear ? L.formatDay(at) : `${year} 年 ${L.formatDay(at)}`;
  }

  let toastTimer = 0;

  function toast(text) {
    toastBox.textContent = text;
    toastBox.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastBox.classList.remove("on"), 1700);
  }

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
    (dialog.open ? dialog : document.body).append(area);
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

  async function copyPath(path) {
    toast((await copyText(path)) ? "已复制路径" : "无法复制，请手动选择文字");
  }

  /* ---- What is on screen ---- */

  const shownVolumes = () => (ui.filter === "all" ? data.volumes : data.volumes.filter((v) => v.key === ui.filter));

  /* Working out a comparison is cheap, but not free, and most choices do not change it. */
  const pairCache = new Map();

  function currentPairs() {
    const key = `${ui.filter}|${ui.from}|${ui.to}`;
    if (!pairCache.has(key)) pairCache.set(key, L.withComparisons(L.resolvePairs(shownVolumes(), ui.from, ui.to)));
    return pairCache.get(key);
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

  /* A disk keeps its color whatever is filtered. */
  const diskColor = (volume) => seriesColor(data.volumes.indexOf(volume));

  const kidsCache = new WeakMap();

  function kidsOf(table) {
    if (!kidsCache.has(table)) kidsCache.set(table, L.childrenOf(table));
    return kidsCache.get(table);
  }

  /* A top-level folder keeps its color at every depth of the map. */
  const hueCache = new Map();

  function hueOf(pair, node) {
    const table = pair.volume.table;
    const key = `${pair.volume.key}|${pair.b}`;
    if (!hueCache.has(key)) {
      const sizes = table.sizes[pair.b];
      const top = kidsOf(table)[0].slice().sort((x, y) => (sizes[y] ?? 0) - (sizes[x] ?? 0));
      hueCache.set(key, new Map(top.map((n, i) => [n, i])));
    }
    let at = node;
    while (at > 0 && table.parents[at] > 0) at = table.parents[at];
    return seriesColor(hueCache.get(key).get(at) ?? -1);
  }

  /* ---- The segmented control ---- */

  /* Kept between redraws, so that its thumb slides from where it was. */
  const controls = new Map();

  function placeThumb(control) {
    const pressed = control.buttons.find((b) => b.getAttribute("aria-pressed") === "true");
    if (!pressed || !pressed.offsetWidth) return;
    control.thumb.style.width = `${pressed.offsetWidth}px`;
    control.thumb.style.transform = `translateX(${pressed.offsetLeft}px)`;
  }

  function segmented(id, label, options, value, pick) {
    const signature = options.map((o) => `${o.key}=${o.label}`).join("|");
    let control = controls.get(id);
    if (!control || control.signature !== signature) {
      const thumb = el("span", { class: "thumb", "aria-hidden": "true" });
      control = { signature, thumb, pick, buttons: [] };
      control.buttons = options.map((o) => el("button", {
        type: "button",
        text: o.label,
        onclick: () => control.pick(o.key),
        "data-key": o.key,
      }));
      control.root = el("div", { class: "segments", role: "group", "aria-label": label }, ...control.buttons, thumb);
      controls.set(id, control);
    }
    control.pick = pick;
    for (const button of control.buttons) button.setAttribute("aria-pressed", String(button.dataset.key === value));
    requestAnimationFrame(() => {
      placeThumb(control);
      requestAnimationFrame(() => control.root.classList.add("ready"));
    });
    return control.root;
  }

  window.addEventListener("resize", () => {
    controls.forEach(placeThumb);
    layoutMap();
  }, { passive: true });

  /* ---- Top bar ---- */

  let themeChoice = "dark";

  function loadTheme() {
    themeChoice = ["dark", "light", "system"].includes(data.theme) ? data.theme : "dark";
    try {
      const saved = localStorage.getItem("diskly-theme");
      if (saved) themeChoice = saved;
    } catch {
      /* Nothing to remember it with: what the window chose stands. */
    }
    applyTheme();
  }

  function applyTheme() {
    if (themeChoice === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = themeChoice;
  }

  function cycleTheme() {
    themeChoice = themeChoice === "dark" ? "light" : themeChoice === "light" ? "system" : "dark";
    try {
      localStorage.setItem("diskly-theme", themeChoice);
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
    ui.kind = null;
    ui.showAllGrew = false;
    ui.showAllShrank = false;
    ui.filesOpen = 12;
    ui.filesShown = 12;
    render();
  }

  function renderBar() {
    const options = [{ key: "all", label: "全部" }];
    for (const v of data.volumes) if (v.key) options.push({ key: v.key, label: `${v.letter}:` });
    const segments = options.length > 2 ? segmented("disk", "选择磁盘", options, ui.filter, setFilter) : null;
    const themeLabel = themeChoice === "light" ? "外观：浅色" : themeChoice === "dark" ? "外观：纯黑" : "外观：跟随系统";
    const themeIcon = themeChoice === "light"
      ? "M9 2.5v1.6M9 13.9v1.6M2.5 9h1.6M13.9 9h1.6M4.4 4.4l1.1 1.1M12.5 12.5l1.1 1.1M4.4 13.6l1.1-1.1M12.5 5.5l1.1-1.1M12 9a3 3 0 1 1-6 0a3 3 0 0 1 6 0z"
      : themeChoice === "dark"
        ? "M14.8 11.1A6.2 6.2 0 0 1 6.9 3.2a6.2 6.2 0 1 0 7.9 7.9z"
        : "M9 2.6a6.4 6.4 0 1 0 0 12.8a6.4 6.4 0 0 0 0-12.8zM9 2.6v12.8";
    bar.replaceChildren(el("div", { class: "bar-inner" },
      el("span", { class: "brand" }, brandMark(), el("span", { class: "brand-name", text: "Diskly" })),
      segments,
      el("span", { class: "bar-title", id: "bar-title" }),
      el("span", { class: "bar-spacer" }),
      el("button", {
        type: "button", class: "icon-button press", title: themeLabel, "aria-label": `${themeLabel}，点按切换`, onclick: cycleTheme,
      }, icon("0 0 18 18", themeIcon)),
      el("button", { type: "button", class: "pill press", id: "open-ai", text: "复制给 AI", onclick: openAiDialog })));
    const heading = document.querySelector(".hero h1");
    if (heading) document.getElementById("bar-title").textContent = heading.textContent;
  }

  /* The glass and the small title appear as a navigation bar's do, without a listener
     on scrolling. */
  const pageTop = el("div", { "aria-hidden": "true" });
  pageTop.style.cssText = "";
  document.body.prepend(pageTop);
  new IntersectionObserver(([entry]) => bar.classList.toggle("scrolled", !entry.isIntersecting), { rootMargin: "8px 0px 0px 0px" }).observe(pageTop);
  const titleWatch = new IntersectionObserver(([entry]) => bar.classList.toggle("titled", !entry.isIntersecting), { rootMargin: "-56px 0px 0px 0px" });

  /* ---- Opening sentence ---- */

  function renderHero(pairs) {
    const adjacent = !ui.from;
    const line = L.headline(pairs, { adjacent });
    const hero = el("div", { class: "hero" },
      placed(el("h1", { text: line.title }), 0),
      placed(el("p", { text: line.detail }), 1));
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
      hero.append(placed(el("div", { class: "compare-controls" },
        el("span", { text: "从" }), from, el("span", { text: "到" }), to), 2));
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

  const RING_BOX = 200;

  /* One ring per disk, outermost first, as a phone shows its activity: the brand's own
     ring, and how full a disk is reads at a glance. More disks than fit stay in the list. */
  function renderRings(pairs, opening) {
    const shown = pairs.slice(0, 4);
    const width = shown.length === 1 ? 22 : shown.length === 2 ? 17 : 13;
    const gap = 5;
    const root = svgEl("svg", { viewBox: `0 0 ${RING_BOX} ${RING_BOX}`, role: "img", "aria-label": "各磁盘的已用空间比例，数字见右边的列表" });
    const settle = [];
    shown.forEach((pair, i) => {
      const { volume, cmp, b } = pair;
      const snap = b >= 0 ? volume.snapshots[b] : null;
      const total = snap ? snap.total_bytes : volume.total_bytes;
      const free = snap ? snap.free_bytes : volume.free_bytes;
      const r = RING_BOX / 2 - width / 2 - 1 - i * (width + gap);
      const circle = (cls) => svgEl("circle", { class: cls, cx: RING_BOX / 2, cy: RING_BOX / 2, r, "stroke-width": width, pathLength: 100 });
      root.append(circle("ring-track"));
      if (!total) return;
      const usedAll = percent(total - free, total);
      const grew = cmp && cmp.usedDelta > 0 ? percent(cmp.usedDelta, total) : 0;
      const base = usedAll - grew;
      const used = circle("ring-used");
      used.style.stroke = volume.connected ? diskColor(volume) : "var(--neutral)";
      used.setAttribute("stroke-dasharray", "0 100");
      root.append(used);
      settle.push(() => used.setAttribute("stroke-dasharray", `${base.toFixed(2)} ${(100 - base).toFixed(2)}`));
      if (grew > 0) {
        const mark = circle("ring-grew");
        mark.style.stroke = "var(--grew)";
        mark.setAttribute("stroke-dasharray", "0 100");
        mark.setAttribute("stroke-dashoffset", (-base).toFixed(2));
        root.append(mark);
        settle.push(() => mark.setAttribute("stroke-dasharray", `${Math.max(grew, 0.8).toFixed(2)} ${(100 - grew).toFixed(2)}`));
      }
    });
    /* After the first frame, so that it sweeps rather than just being there. */
    if (calm()) settle.forEach((go) => go());
    else requestAnimationFrame(() => requestAnimationFrame(() => settle.forEach((go) => go())));

    const known = pairs.filter((p) => (p.b >= 0 ? p.volume.snapshots[p.b].total_bytes : p.volume.total_bytes));
    const usedOf = (p) => {
      const snap = p.b >= 0 ? p.volume.snapshots[p.b] : null;
      return (snap ? snap.total_bytes - snap.free_bytes : p.volume.total_bytes - p.volume.free_bytes);
    };
    const totalOf = (p) => (p.b >= 0 ? p.volume.snapshots[p.b].total_bytes : p.volume.total_bytes);
    const used = known.reduce((sum, p) => sum + usedOf(p), 0);
    const whole = known.reduce((sum, p) => sum + totalOf(p), 0);
    const one = known.length === 1;
    const format = one ? (v) => `${Math.round(v)}%` : L.formatBytes;
    const value = one ? percent(used, whole) : used;
    const number = el("b", { text: format(value) });
    if (opening) countUp(number, value, format);
    return el("div", { class: "rings" }, root,
      el("div", { class: "ring-center" }, number, el("span", { text: one ? "已用" : "共已用" })));
  }

  function diskRow(pair) {
    const { volume, cmp, reason, b } = pair;
    const snap = b >= 0 ? volume.snapshots[b] : null;
    const total = snap ? snap.total_bytes : volume.total_bytes;
    const free = snap ? snap.free_bytes : volume.free_bytes;
    const label = volume.label || "本地磁盘";

    const top = el("div", { class: "disk-top" },
      colored(el("span", { class: "disk-dot", "aria-hidden": "true" }), volume.connected ? diskColor(volume) : "var(--neutral)"),
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

    const rail = colored(el("div", { class: "rail", "aria-hidden": "true" }), volume.connected ? diskColor(volume) : "var(--neutral)");
    if (total) {
      const used = total - free;
      const pct = (x) => `${Math.max(0, percent(x, total)).toFixed(2)}%`;
      const usedBar = el("span", { class: "used" });
      rail.append(usedBar);
      if (cmp && cmp.usedDelta > 0) {
        usedBar.style.width = pct(used - cmp.usedDelta);
        const grew = el("span", { class: "grew" });
        grew.style.width = `max(3px, ${pct(cmp.usedDelta)})`;
        rail.append(grew);
      } else if (cmp && cmp.usedDelta < 0) {
        usedBar.style.width = pct(used);
        const shrank = el("span", { class: "shrank" });
        shrank.style.width = `max(3px, ${pct(-cmp.usedDelta)})`;
        rail.append(shrank);
      } else {
        usedBar.style.width = pct(used);
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
        type: "button", class: "disk row", "aria-label": `只看 ${volume.letter}: 盘`, onclick: () => setFilter(volume.key),
      }, ...children);
    }
    return el("div", { class: "disk" }, ...children);
  }

  /* ---- At a glance ---- */

  function renderFacts(pairs, merged, opening) {
    const scanned = pairs.filter((p) => p.b >= 0);
    if (!scanned.length) return null;
    const files = scanned.reduce((sum, p) => sum + p.volume.snapshots[p.b].files, 0);
    const dirs = scanned.reduce((sum, p) => sum + p.volume.snapshots[p.b].dirs, 0);
    const fact = (label, amount, format, detail) => {
      const number = el("span", { class: "fact-value", text: format(amount) });
      if (opening) countUp(number, amount, format);
      return [
        el("span", { class: "fact-label", text: label }),
        number,
        detail ? el("span", { class: "fact-detail", text: detail, title: detail }) : null,
      ];
    };
    const tiles = [
      el("div", { class: "fact" }, ...fact("文件", files, (v) => L.formatCount(Math.round(v)), `${L.formatCount(dirs)} 个目录`)),
    ];
    const biggest = merged && merged.files[0];
    if (biggest) {
      const full = L.displayPath(biggest.letter, biggest.path);
      tiles.push(el("button", {
        type: "button", class: "fact", title: `复制路径：${full}`, onclick: () => copyPath(full),
      }, ...fact("最大的文件", biggest.size, L.formatBytes, full.slice(full.lastIndexOf("\\") + 1))));
    }
    const top = scanned
      .flatMap((p) => L.sizeHotspots(p.volume, p.b, 1).map((node) => ({ pair: p, node, size: p.volume.table.sizes[p.b][node] })))
      .sort((x, y) => y.size - x.size)[0];
    if (top) {
      const full = L.displayPath(top.pair.volume.snapshots[top.pair.b].letter, L.pathOf(top.pair.volume.table, top.node));
      tiles.push(el("button", {
        type: "button", class: "fact", title: `在地图中打开：${full}`, onclick: () => browseTo(top.pair.volume.key, top.node, true),
      }, ...fact("最占地方的目录", top.size, L.formatBytes, full.slice(full.lastIndexOf("\\") + 1))));
    }
    const kind = merged && merged.kinds.find((k) => k.kind !== "other");
    if (kind) {
      tiles.push(el("button", {
        type: "button", class: "fact", title: `筛选${L.kindLabel(kind.kind)}`, onclick: () => pickKind(kind.kind, true),
      }, ...fact("占用最多的类型", kind.size, L.formatBytes, L.kindLabel(kind.kind))));
    }
    return placed(el("div", { id: "facts" }, ...tiles), 4);
  }

  /* ---- The map ---- */

  const MAP_ITEMS = 36;
  const NESTED_ITEMS = 12;
  const GAP = 1.5;

  /* The children of a place, and what else is in it: its biggest files, and the rest. */
  function mapChildren(pair, node, limit, files) {
    const { volume, b, cmp } = pair;
    const table = volume.table;
    const sizes = table.sizes[b];
    const unread = new Set(table.unread[b] || []);
    const items = [];
    for (const child of kidsOf(table)[node]) {
      const size = sizes[child];
      if (!size || unread.has(child) || (cmp && cmp.state[child] === STATE.UNKNOWN)) continue;
      items.push({ kind: "dir", pair, node: child, name: table.names[child], size, enterable: kidsOf(table)[child].length > 0 });
    }
    const parentPath = L.pathOf(table, node);
    for (const file of files) {
      const cut = file.path.lastIndexOf("\\");
      const at = cut < 0 ? "" : file.path.slice(0, cut);
      if (at.toLowerCase() === parentPath.toLowerCase()) {
        items.push({ kind: "file", pair, node, file, name: file.path.slice(cut + 1), size: file.size });
      }
    }
    items.sort((x, y) => y.size - x.size);
    const whole = sizes[node] ?? 0;
    const kept = items.slice(0, limit);
    const listed = kept.reduce((sum, item) => sum + item.size, 0);
    const rest = whole - listed;
    if (rest > whole * 0.002 && rest > 0) {
      const hidden = items.length - kept.length;
      kept.push({ kind: "rest", pair, node, name: hidden > 0 ? `其他 ${hidden} 项和文件` : "其他文件", size: rest });
      kept.sort((x, y) => y.size - x.size);
    }
    return kept;
  }

  function filesOf(pair) {
    return pair.volume.insights?.[pair.volume.snapshots[pair.b].id]?.files || [];
  }

  /* How a tile is colored: by which top-level folder it is in, or by what changed. */
  function paintTile(tile, item, depth, rank, maxChange, nested) {
    const { pair } = item;
    const style = tile.style;
    if (ui.sort === "change" && pair.cmp && item.kind === "dir") {
      const delta = pair.cmp.delta[item.node];
      if (Number.isNaN(delta) || delta === 0 || !maxChange) {
        style.setProperty("--hue", "var(--neutral)");
        style.setProperty("--mix", "22%");
      } else {
        style.setProperty("--hue", delta > 0 ? "var(--grew)" : "var(--shrank)");
        style.setProperty("--mix", `${Math.round(16 + 48 * Math.sqrt(Math.abs(delta) / maxChange))}%`);
      }
      return;
    }
    if (ui.sort === "change" && pair.cmp) {
      style.setProperty("--hue", "var(--neutral)");
      style.setProperty("--mix", "18%");
      return;
    }
    if (item.kind === "rest") {
      style.setProperty("--hue", "var(--neutral)");
      style.setProperty("--mix", depth ? "20%" : "28%");
      return;
    }
    /* A disk is only the frame around its folders, if there is room to show them. */
    if (item.kind === "disk") {
      style.setProperty("--hue", nested ? "var(--neutral)" : diskColor(pair.volume));
      style.setProperty("--mix", nested ? "14%" : "54%");
      if (nested) tile.classList.add("frame");
      return;
    }
    style.setProperty("--hue", item.node > 0 ? hueOf(pair, item.node) : "var(--neutral)");
    const base = depth ? 74 : 62;
    style.setProperty("--mix", `${Math.max(depth ? 42 : 40, base - rank * (depth ? 5 : 3))}%`);
  }

  function tileLabel(item) {
    if (item.kind === "file") return `${item.name}，文件，${L.formatBytes(item.size)}`;
    if (item.kind === "rest") return `${item.name}，${L.formatBytes(item.size)}`;
    return `${item.name}，${L.formatBytes(item.size)}`;
  }

  function placeTile(tile, x, y, w, h) {
    tile.style.left = `${(x + GAP).toFixed(1)}px`;
    tile.style.top = `${(y + GAP).toFixed(1)}px`;
    tile.style.width = `${Math.max(0, w - GAP * 2).toFixed(1)}px`;
    tile.style.height = `${Math.max(0, h - GAP * 2).toFixed(1)}px`;
    tile.style.setProperty("--r", `${Math.min(10, Math.max(3, Math.min(w, h) / 5)).toFixed(0)}px`);
  }

  /* The current place drawn into a new canvas of the given size. */
  function drawCanvas(place, width, height, opening) {
    const canvas = el("div", { class: "map-canvas" });
    const items = place.items;
    let maxChange = 0;
    if (ui.sort === "change") {
      for (const item of items) {
        if (item.kind !== "dir" || !item.pair.cmp) continue;
        const d = Math.abs(item.pair.cmp.delta[item.node]);
        if (d > maxChange) maxChange = d;
        for (const child of kidsOf(item.pair.volume.table)[item.node]) {
          const c = Math.abs(item.pair.cmp.delta[child]);
          if (c > maxChange) maxChange = c;
        }
      }
    }
    const shown = [];
    const add = (item, rect, depth, rank, big) => {
      const tile = el("button", {
        type: "button",
        class: `tile${item.kind === "rest" ? " rest" : ""}${big ? " big" : ""}${opening ? " opening" : ""}`,
        "aria-label": tileLabel(item),
        /* The list beside it is the way through by keyboard. Only the top level stops here. */
        tabindex: item.kind === "rest" || depth > 0 ? "-1" : null,
      });
      tile.dataset.i = String(shown.length);
      shown.push({ item, rect, tile });
      placeTile(tile, rect.x, rect.y, rect.w, rect.h);
      paintTile(tile, item, depth, rank, maxChange, big);
      if (opening) tile.style.setProperty("--at", String(Math.min(380, shown.length * 7)));
      const w = rect.w - GAP * 2;
      const h = rect.h - GAP * 2;
      if (w >= 46 && h >= 22) {
        const text = el("span", { class: "tile-text" }, el("span", { class: "tile-name", text: item.name }));
        if (h >= 42) text.append(el("span", { class: "tile-size", text: L.formatBytes(item.size) }));
        tile.append(text);
      }
      canvas.append(tile);
    };
    const rects = L.squarify(items.map((item) => item.size), 0, 0, width, height);
    items.forEach((item, i) => {
      const rect = rects[i];
      if (!rect) return;
      const nest = item.kind !== "file" && item.kind !== "rest" && rect.w >= 150 && rect.h >= 104;
      add(item, rect, 0, i, nest);
      if (!nest) return;
      const kids = mapChildren(item.pair, item.node, NESTED_ITEMS, filesOf(item.pair));
      if (!kids.length) return;
      const pad = 5;
      const head = 40;
      const inner = L.squarify(kids.map((k) => k.size), rect.x + pad, rect.y + head, rect.w - pad * 2, rect.h - head - pad);
      kids.forEach((kid, k) => {
        /* A sliver says nothing and is hard to hit. It stays part of its parent. */
        if (inner[k] && inner[k].w >= 12 && inner[k].h >= 12) add(kid, inner[k], 1, k, false);
      });
    });
    canvas.__shown = shown;
    return canvas;
  }

  /* What the map shows: all disks, or one folder. */
  function mapPlace() {
    const pairs = currentPairs();
    const available = pairs.filter((p) => p.b >= 0 && p.volume.table.names.length > 0);
    if (!available.length) return null;
    let current = ui.browse && available.find((p) => p.volume.key === ui.browse.key);
    if (!current && available.length === 1) [current] = available;
    if (!current) {
      const items = available
        .map((pair) => ({
          kind: "disk", pair, node: 0, enterable: true,
          name: `${pair.volume.snapshots[pair.b].letter}:${pair.volume.connected ? "" : "（未连接）"}`,
          size: pair.volume.table.sizes[pair.b][0] ?? 0,
        }))
        .filter((item) => item.size > 0)
        .sort((x, y) => y.size - x.size);
      return { available, current: null, node: 0, items };
    }
    const node = ui.browse && ui.browse.key === current.volume.key ? ui.browse.node : 0;
    return { available, current, node, items: mapChildren(current, node, MAP_ITEMS, filesOf(current)) };
  }

  let mapFrame = null;
  let mapWidth = 0;

  /* Redrawn only if the frame really changed size. */
  function layoutMap() {
    if (!mapFrame || !mapFrame.isConnected) return;
    const width = mapFrame.clientWidth;
    if (!width || width === mapWidth) return;
    mapWidth = width;
    const place = mapPlace();
    if (!place) return;
    mapFrame.replaceChildren(drawCanvas(place, width, mapFrame.clientHeight, false));
  }

  function tileAt(event) {
    const target = event.target.closest?.(".tile");
    if (!target) return null;
    const canvas = target.parentElement;
    const shown = canvas.__shown?.[Number(target.dataset.i)];
    return shown ? { ...shown, canvas } : null;
  }

  function tileLines(item) {
    const { pair } = item;
    const letter = pair.volume.snapshots[pair.b].letter;
    if (item.kind === "file") return [L.displayPath(letter, item.file.path), `文件，${L.kindLabel(item.file.kind)}。点按复制路径`];
    if (item.kind === "rest") return [`这里没有单独列出的文件和小目录`];
    if (item.kind === "disk") {
      const delta = pair.cmp ? `和上次相比 ${L.formatDelta(pair.cmp.attributed)}` : null;
      return [pair.volume.label || "本地磁盘", delta];
    }
    const parent = pair.volume.table.parents[item.node];
    const parentSize = pair.volume.table.sizes[pair.b][parent] ?? 0;
    const share = parentSize ? `占上一级的 ${Math.round(percent(item.size, parentSize))}%` : null;
    const delta = pair.cmp ? pair.cmp.delta[item.node] : null;
    const change = delta === null ? null : Number.isNaN(delta) ? "变化未知" : `和上次相比 ${L.formatDelta(delta)}`;
    return [L.displayPath(letter, L.pathOf(pair.volume.table, item.node)), [share, change].filter(Boolean).join("，")];
  }

  function onMapClick(event) {
    const hit = tileAt(event);
    if (!hit) return;
    const { item, rect, tile } = hit;
    if (item.kind === "file") {
      copyPath(L.displayPath(item.pair.volume.snapshots[item.pair.b].letter, item.file.path));
      return;
    }
    if (item.kind === "rest" || !item.enterable) {
      tile.classList.remove("nudge");
      requestAnimationFrame(() => tile.classList.add("nudge"));
      if (item.kind === "dir") toast("这个目录下没有更多可显示的子目录");
      return;
    }
    hideTip();
    browseTo(item.pair.volume.key, item.node, false, rect);
  }

  /* Going into a folder is a flight into its tile: the old map grows until the tile
     fills the frame, while the new one grows out of where the tile was. */
  function flyInto(frame, oldCanvas, newCanvas, rect, width, height) {
    if (calm() || !oldCanvas || !rect) return false;
    const sx = width / rect.w;
    const sy = height / rect.h;
    const options = { duration: 520, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "both" };
    frame.append(oldCanvas, newCanvas);
    oldCanvas.style.pointerEvents = "none";
    const leave = oldCanvas.animate([
      { transform: "none", opacity: 1 },
      { transform: `translate(${-rect.x * sx}px, ${-rect.y * sy}px) scale(${sx}, ${sy})`, opacity: 0 },
    ], options);
    newCanvas.animate([
      { transform: `translate(${rect.x}px, ${rect.y}px) scale(${1 / sx}, ${1 / sy})`, opacity: 0.2 },
      { transform: "none", opacity: 1 },
    ], options);
    leave.onfinish = () => oldCanvas.remove();
    return true;
  }

  /* Coming back out: the map settles from slightly too large. */
  function settleBack(frame, oldCanvas, newCanvas) {
    if (calm() || !oldCanvas) return false;
    const options = { duration: 420, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "both" };
    frame.append(newCanvas, oldCanvas);
    oldCanvas.style.pointerEvents = "none";
    const leave = oldCanvas.animate([
      { transform: "none", opacity: 1 },
      { transform: "scale(0.86)", opacity: 0 },
    ], options);
    newCanvas.animate([
      { transform: "scale(1.06)", opacity: 0.3 },
      { transform: "none", opacity: 1 },
    ], options);
    leave.onfinish = () => oldCanvas.remove();
    return true;
  }

  /* The same place in other colors: one fades into the other. */
  function crossfade(frame, oldCanvas, newCanvas) {
    if (calm() || !oldCanvas) return false;
    frame.append(newCanvas, oldCanvas);
    oldCanvas.style.pointerEvents = "none";
    oldCanvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: "linear", fill: "both" }).onfinish = () => oldCanvas.remove();
    return true;
  }

  /* Redraw the map and its list. `motion` says how to get there. */
  function refreshFolders(motion) {
    const oldCanvas = mapFrame?.isConnected ? mapFrame.querySelector(".map-canvas:last-child") : null;
    const height = mapFrame?.clientHeight ?? 0;
    const width = mapFrame?.clientWidth ?? 0;
    const y = window.scrollY;
    const section = renderFolders(currentPairs());
    replaceSection("folders", section);
    /* The list and its rows change height. The place on the page does not change. */
    window.scrollTo({ top: y, behavior: "instant" });
    const place = mapPlace();
    if (place && mapFrame) {
      mapWidth = mapFrame.clientWidth;
      const canvas = drawCanvas(place, mapWidth, mapFrame.clientHeight, false);
      const moved = motion?.fade ? crossfade(mapFrame, oldCanvas, canvas)
        : motion?.back ? settleBack(mapFrame, oldCanvas, canvas)
          : flyInto(mapFrame, oldCanvas, canvas, motion?.from, width, height);
      if (!moved) mapFrame.replaceChildren(canvas);
    }
    return section;
  }

  function browseTo(key, node, scroll, from) {
    ui.browse = { key, node };
    const section = refreshFolders({ from });
    if (scroll) section.scrollIntoView({ behavior: calm() ? "auto" : "smooth", block: "start" });
  }

  function browseBack(key, node) {
    ui.browse = key === null ? null : { key, node };
    refreshFolders({ back: true });
  }

  function replaceSection(id, node) {
    const old = document.getElementById(id);
    if (old && node) old.replaceWith(node);
    else if (old) old.remove();
  }

  /* ---- The folder list: the map, as a table ---- */

  function folderRows(pair, parent) {
    const { volume, cmp, b } = pair;
    const table = volume.table;
    const sizes = table.sizes[b];
    const kids = kidsOf(table);
    const children = kids[parent];
    const parentSize = sizes[parent] ?? 0;
    const unreadHere = new Set(table.unread[b] || []);
    const isUnknown = (i) => (cmp ? cmp.state[i] === STATE.UNKNOWN : unreadHere.has(i));
    const visible = children.filter((i) => (sizes[i] !== null && sizes[i] !== undefined) || (cmp && cmp.state[i] === STATE.REMOVED) || isUnknown(i));
    const rank = (i) => {
      if (ui.sort === "change" && cmp && !isUnknown(i)) return Math.abs(cmp.delta[i]);
      return sizes[i] ?? 0;
    };
    visible.sort((x, y) => rank(y) - rank(x));
    const listed = visible.slice(0, 200);

    const rows = listed.map((i, place) => {
      const unknown = isUnknown(i);
      const size = sizes[i];
      const share = el("span", { class: unknown ? "folder-share unknown" : "folder-share" });
      share.style.width = unknown ? "100%" : `${parentSize ? Math.max(0.5, percent(size ?? 0, parentSize)).toFixed(1) : 0}%`;
      if (!unknown) share.style.setProperty("--dot", hueOf(pair, i));
      let changeText = "";
      let quiet = false;
      if (unknown) {
        changeText = "未知";
        quiet = true;
      } else if (cmp) {
        if (cmp.state[i] === STATE.ADDED || cmp.state[i] === STATE.REMOVED) changeText = L.formatDelta(cmp.delta[i]);
        else if (cmp.delta[i] === 0) { changeText = "无变化"; quiet = true; } else changeText = L.formatDelta(cmp.delta[i]);
      }
      const tag = cmp && cmp.state[i] === STATE.ADDED ? "新出现" : cmp && cmp.state[i] === STATE.REMOVED ? "已消失" : null;
      const cells = [
        el("span", { class: "folder-main" },
          el("span", { class: "folder-name", title: table.names[i] }, table.names[i], tag ? el("span", { class: "tag", text: tag }) : null),
          share),
        el("span", { class: "folder-numbers" },
          el("span", { class: "folder-size", text: unknown ? "未知" : L.formatBytes(size ?? 0) }),
          changeText ? el("span", { class: quiet ? "folder-change quiet" : "folder-change", text: changeText }) : null),
      ];
      const enterable = kids[i].length > 0;
      if (enterable) {
        cells.push(chevron());
        return placed(el("button", { type: "button", class: "folder row", onclick: () => browseTo(volume.key, i) }, ...cells), place);
      }
      cells.push(el("span"));
      return placed(el("div", { class: "folder" }, ...cells), place);
    });

    /* The rest of this folder: its own files and folders too small to list. */
    const sum = listed.reduce((total, i) => total + (isUnknown(i) ? 0 : (sizes[i] ?? 0)), 0);
    const rest = parentSize - sum;
    if (rest > 0 && rows.length) {
      const share = el("span", { class: "folder-share" });
      share.style.width = `${parentSize ? Math.max(0.5, percent(rest, parentSize)).toFixed(1) : 0}%`;
      rows.push(placed(el("div", { class: "folder rest" },
        el("span", { class: "folder-main" }, el("span", { class: "folder-name", text: "文件和较小的目录" }), share),
        el("span", { class: "folder-numbers" }, el("span", { class: "folder-size", text: L.formatBytes(rest) })),
        el("span")), rows.length));
    }
    return rows;
  }

  function mapLegend(place) {
    const parts = [];
    if (ui.sort === "change" && place.available.some((p) => p.cmp)) {
      parts.push(
        el("span", { class: "key" }, colored(el("i"), "var(--grew)"), "变大"),
        el("span", { class: "key" }, colored(el("i"), "var(--shrank)"), "变小"),
        el("span", { class: "key" }, colored(el("i"), "var(--neutral)"), "没有变化"));
    }
    if (place.current) {
      const { cmp, volume, b } = place.current;
      const unread = new Set(volume.table.unread[b] || []);
      const unknown = kidsOf(volume.table)[place.node].filter((i) => (cmp ? cmp.state[i] === STATE.UNKNOWN : unread.has(i))).length;
      if (unknown) parts.push(el("span", { text: `这里有 ${unknown} 个目录未能读取，大小未知，没有画在图里。` }));
    }
    return parts.length ? el("div", { class: "map-legend" }, ...parts) : null;
  }

  function renderFolders(pairs) {
    const place = mapPlace();
    if (!place) return null;
    const { available, current, node } = place;

    const hasChange = available.some((p) => p.cmp);
    const sortControl = hasChange
      ? segmented("sort", "排序方式", [{ key: "size", label: "按大小" }, { key: "change", label: "按变化" }], ui.sort, (value) => {
        ui.sort = value;
        refreshFolders({ fade: true });
      })
      : null;
    const head = el("div", { class: "section-head" }, el("h2", { text: "空间地图" }), sortControl);

    mapFrame = el("div", { class: "map-frame", role: "group", "aria-label": "空间地图，方块越大占用越多。点按进入目录。同样的内容见旁边的列表。", onclick: onMapClick });
    mapFrame.addEventListener("pointermove", (event) => {
      const hit = tileAt(event);
      if (!hit) { hideTip(); return; }
      showTip(event.clientX, event.clientY, L.formatBytes(hit.item.size), hit.item.name, ...tileLines(hit.item));
    }, { passive: true });
    mapFrame.addEventListener("pointerleave", hideTip, { passive: true });
    mapFrame.addEventListener("focusin", (event) => {
      const hit = tileAt(event);
      if (!hit || !event.target.matches(":focus-visible")) return;
      const box = event.target.getBoundingClientRect();
      showTip(box.left, box.bottom - 12, L.formatBytes(hit.item.size), hit.item.name, ...tileLines(hit.item));
    });
    mapFrame.addEventListener("focusout", hideTip);

    let crumbs = null;
    let rows;
    let summary = null;
    if (!current) {
      rows = place.items.map((item, at) => {
        const { pair } = item;
        const snap = pair.volume.snapshots[pair.b];
        return placed(el("button", { type: "button", class: "folder row", onclick: () => browseTo(pair.volume.key, 0) },
          el("span", { class: "folder-main" },
            el("span", { class: "folder-name", text: `${snap.letter}:\\ ${pair.volume.label || ""}` }),
            colored(widened(el("span", { class: "folder-share" }), snap.total_bytes - snap.free_bytes, snap.total_bytes), diskColor(pair.volume))),
          el("span", { class: "folder-numbers" },
            el("span", { class: "folder-size", text: L.formatBytes(item.size) }),
            pair.cmp ? el("span", { class: "folder-change", text: L.formatDelta(pair.cmp.attributed) }) : null),
          chevron()), at);
      });
    } else {
      const table = current.volume.table;
      const letter = current.volume.snapshots[current.b].letter;
      const chain = [];
      for (let at = node; at >= 0; at = table.parents[at]) chain.unshift(at);
      crumbs = el("nav", { class: "crumbs", "aria-label": "当前位置" });
      if (available.length > 1) {
        crumbs.append(el("button", {
          type: "button", class: "press", text: "所有磁盘", onclick: () => browseBack(null, 0),
        }), el("span", { class: "sep", text: "\\" }));
      }
      chain.forEach((at, position) => {
        const name = at === 0 ? `${letter}:` : table.names[at];
        if (position === chain.length - 1) crumbs.append(el("span", { class: "here", "aria-current": "location", text: name }));
        else {
          crumbs.append(
            el("button", { type: "button", class: "press", text: name, title: name, onclick: () => browseBack(current.volume.key, at) }),
            el("span", { class: "sep", text: "\\" }));
        }
      });
      rows = folderRows(current, node);
      const size = L.formatBytes(table.sizes[current.b][node] ?? 0);
      const changed = current.cmp && !Number.isNaN(current.cmp.delta[node]) && current.cmp.state[node] !== STATE.SAME;
      summary = el("p", { class: "section-hint", text: changed ? `这个目录共 ${size}，变化 ${L.formatDelta(current.cmp.delta[node])}。` : `这个目录共 ${size}。` });
    }

    const list = el("div", { class: "group folder-list list-in" },
      ...(rows.length ? rows : [el("div", { class: "empty", text: "这个目录下没有更多可显示的子目录。" })]));
    return placed(el("section", { id: "folders" },
      head,
      crumbs,
      summary,
      el("div", { class: "explorer" }, mapFrame, list),
      mapLegend(place)), 6);
  }

  /* ---- The biggest files ---- */

  function pickKind(kind, scroll) {
    ui.kind = ui.kind === kind ? null : kind;
    ui.filesOpen = 12;
    const merged = L.mergeInsights(currentPairs());
    replaceSection("largest", renderLargest(merged));
    replaceSection("kinds", renderKinds(merged));
    if (scroll) document.getElementById("largest")?.scrollIntoView({ behavior: calm() ? "auto" : "smooth", block: "start" });
  }

  /* The folder a file is in, or the nearest one above it that the report knows. */
  function nearestNode(table, path) {
    let at = 0;
    const parts = path.split("\\").slice(0, -1);
    const kids = kidsOf(table);
    for (const part of parts) {
      const next = kids[at].find((c) => table.names[c].toLowerCase() === part.toLowerCase());
      if (next === undefined) break;
      at = next;
    }
    return at;
  }

  function renderLargest(merged) {
    if (!merged || !merged.files.length) return null;
    const chips = el("div", { class: "chips", role: "group", "aria-label": "按类型筛选" },
      el("button", {
        type: "button", class: "chip press", text: "全部", "aria-pressed": String(ui.kind === null),
        onclick: () => { ui.kind = null; ui.filesOpen = 12; replaceSection("largest", renderLargest(merged)); replaceSection("kinds", renderKinds(merged)); },
      }),
      ...merged.kinds.filter((k) => merged.files.some((f) => f.kind === k.kind)).map((k) => el("button", {
        type: "button", class: "chip press", "aria-pressed": String(ui.kind === k.kind), onclick: () => pickKind(k.kind),
      }, colored(el("i"), kindColor(k.kind)), L.kindLabel(k.kind))));
    const list = ui.kind ? merged.files.filter((f) => f.kind === ui.kind) : merged.files;
    const scale = Math.max(1, list[0]?.size ?? 1);
    const rows = list.slice(0, ui.filesOpen).map((file, at) => {
      const full = L.displayPath(file.letter, file.path);
      const cut = full.lastIndexOf("\\");
      const pair = currentPairs().find((p) => p.volume.key === file.key);
      const fill = colored(el("span"), kindColor(file.kind));
      fill.style.width = `${Math.max(1, percent(file.size, scale)).toFixed(1)}%`;
      return placed(el("div", { class: "with-action" },
        el("button", {
          type: "button", class: "item row", title: `点按复制：${full}`, onclick: () => copyPath(full),
        },
          el("span", { class: "item-name", text: full.slice(cut + 1) }),
          el("span", { class: "item-size", text: L.formatBytes(file.size) }),
          el("span", { class: "item-path", text: full.slice(0, cut + 1) }),
          el("span", { class: "item-bar" }, fill)),
        pair && pair.volume.table.names.length ? el("button", {
          type: "button", class: "locate press", title: "在地图中打开它所在的目录", "aria-label": `在地图中打开 ${full.slice(cut + 1)} 所在的目录`,
          onclick: () => browseTo(file.key, nearestNode(pair.volume.table, file.path), true),
        }, locateIcon()) : null), at);
    });
    if (list.length > ui.filesOpen) {
      rows.push(el("button", {
        type: "button", class: "more row", text: `再显示 ${Math.min(list.length - ui.filesOpen, 30)} 个`,
        onclick: () => { ui.filesOpen += 30; replaceSection("largest", renderLargest(merged)); },
      }));
    }
    return el("section", { id: "largest" },
      el("h2", { text: "最大的文件" }),
      chips,
      el("div", { class: "group" }, ...(rows.length ? rows : [el("div", { class: "empty", text: "这一类没有大文件。" })])));
  }

  const kindColor = (kind) => (kind === "other" ? "var(--neutral)" : seriesColor(L.kindIndex(kind)));

  function renderKinds(merged) {
    if (!merged || !merged.kinds.length) return null;
    const total = merged.kinds.reduce((sum, k) => sum + k.size, 0);
    const parts = merged.kinds.filter((k) => k.size > 0);
    const segmentsBar = el("div", { class: `kinds-bar${ui.kind ? " filtered" : ""}`, role: "img", "aria-label": `文件类型占比：${parts.map((k) => `${L.kindLabel(k.kind)} ${Math.round(percent(k.size, total))}%`).join("，")}` },
      ...parts.map((k) => {
        const part = colored(el("span", { class: ui.kind === k.kind ? "on" : null }), kindColor(k.kind));
        part.style.flex = `${Math.max(percent(k.size, total), 0.4).toFixed(2)} 1 0`;
        part.addEventListener("pointermove", (event) => {
          showTip(event.clientX, event.clientY, L.formatBytes(k.size), L.kindLabel(k.kind), `占 ${Math.round(percent(k.size, total))}%，${L.formatCountOf(k.count, "个文件")}`);
        }, { passive: true });
        part.addEventListener("pointerleave", hideTip, { passive: true });
        return part;
      }));
    const rows = parts.map((k) => el("button", {
      type: "button", class: "kind-row row", "aria-pressed": String(ui.kind === k.kind), onclick: () => pickKind(k.kind),
    },
      el("span", { class: "ext-name" }, colored(el("i", { class: "dot" }), kindColor(k.kind)), L.kindLabel(k.kind)),
      el("span", { class: "kind-count", text: L.formatCountOf(k.count, "个") }),
      el("span", { class: "kind-size", text: L.formatBytes(k.size) })));

    const extensions = (ui.kind ? merged.extensions.filter((e) => e.kind === ui.kind) : merged.extensions).filter((e) => e.size > 0);
    const shownExt = extensions.slice(0, ui.showAllExtensions ? 40 : 8);
    const extRows = shownExt.map((e) => el("div", { class: "kind-row" },
      el("span", { class: "ext-name" }, colored(el("i", { class: "dot" }), kindColor(e.kind)), e.ext ? `.${e.ext}` : "没有扩展名"),
      el("span", { class: "kind-count", text: L.formatCountOf(e.count, "个") }),
      el("span", { class: "kind-size", text: L.formatBytes(e.size) })));
    if (extensions.length > 8) {
      extRows.push(el("button", {
        type: "button", class: "more row", text: ui.showAllExtensions ? "收起" : `显示前 ${Math.min(extensions.length, 40)} 种`,
        onclick: () => { ui.showAllExtensions = !ui.showAllExtensions; replaceSection("kinds", renderKinds(merged)); },
      }));
    }
    return el("section", { id: "kinds" },
      el("h2", { text: "文件类型" }),
      el("div", { class: "group" }, segmentsBar, ...rows),
      extRows.length ? el("div", { class: "group" }, ...extRows) : null);
  }

  /* ---- Folders, by size ---- */

  function renderTopFolders(pairs) {
    const items = [];
    for (const pair of pairs) {
      if (pair.b < 0 || !pair.volume.table.names.length) continue;
      for (const node of L.sizeHotspots(pair.volume, pair.b, 14)) {
        items.push({ pair, node, size: pair.volume.table.sizes[pair.b][node] ?? 0 });
      }
    }
    items.sort((x, y) => y.size - x.size);
    const shown = items.slice(0, 10).filter((item) => item.size > 0);
    if (!shown.length) return null;
    const scale = shown[0].size;
    return el("section", { id: "top-folders" },
      el("h2", { text: "最占地方的目录" }),
      el("div", { class: "group" }, ...shown.map(({ pair, node, size }) => {
        const table = pair.volume.table;
        const full = L.displayPath(pair.volume.snapshots[pair.b].letter, L.pathOf(table, node));
        const cut = full.lastIndexOf("\\");
        const fill = colored(el("span"), hueOf(pair, node));
        fill.style.width = `${Math.max(1, percent(size, scale)).toFixed(1)}%`;
        const delta = pair.cmp ? pair.cmp.delta[node] : null;
        return el("button", { type: "button", class: "item row", title: full, onclick: () => browseTo(pair.volume.key, node, true) },
          el("span", { class: "item-name", text: table.names[node] }),
          el("span", { class: "item-size", text: L.formatBytes(size) }),
          el("span", { class: "item-path", text: `${full.slice(0, cut + 1)}${delta && !Number.isNaN(delta) ? `，${L.formatDelta(delta)}` : ""}` }),
          el("span", { class: "item-bar" }, fill));
      })));
  }

  /* ---- Well-known places ---- */

  function renderSpots(merged) {
    if (!merged || !merged.spots.length) return null;
    const scale = merged.spots[0].size;
    return el("section", { id: "spots" },
      el("h2", { text: "值得看看的地方" }),
      el("p", { class: "section-hint", text: "这些地方常常悄悄变大。Diskly 只告诉你，不会动它们。" }),
      el("div", { class: "group" }, ...merged.spots.slice(0, 9).map((spot) => {
        const words = L.SPOTS[spot.id] || { label: spot.id, note: "" };
        const fill = colored(el("span"), "var(--accent)");
        fill.style.width = `${Math.max(1, percent(spot.size, scale)).toFixed(1)}%`;
        const pair = currentPairs().find((p) => p.volume.key === spot.key);
        const node = pair && pair.volume.table.names.length ? nearestNode(pair.volume.table, `${spot.largest}\\x`) : 0;
        const where = spot.places > 1 ? `${spot.places} 处，最大的是 ${L.displayPath(spot.letter, spot.largest)}` : L.displayPath(spot.letter, spot.largest);
        const cells = [
          el("span", { class: "item-name", text: words.label }),
          el("span", { class: "item-size", text: L.formatBytes(spot.size) }),
          el("span", { class: "item-note", text: words.note }),
          el("span", { class: "item-path", text: where, title: where }),
          el("span", { class: "item-bar" }, fill),
        ];
        if (node > 0) return el("button", { type: "button", class: "item row", onclick: () => browseTo(spot.key, node, true) }, ...cells);
        return el("div", { class: "item" }, ...cells);
      })));
  }

  /* ---- File sizes ---- */

  function renderRanges(merged) {
    const ranges = merged?.ranges || [];
    const total = ranges.reduce((sum, r) => sum + r.size, 0);
    if (!total) return null;
    const scale = Math.max(...ranges.map((r) => r.size));
    const box = el("div", { class: "ranges" });
    box.style.setProperty("--count", String(ranges.length));
    const columns = el("div", { class: "range-columns", role: "img", "aria-label": "按文件大小统计的占用，数字见下方" });
    const labels = el("div", { class: "range-labels" });
    ranges.forEach((range, i) => {
      const lower = i ? ranges[i - 1].upper : 0;
      const name = L.rangeLabel(lower, range.upper);
      const fill = el("span");
      fill.style.height = `${Math.max(1.5, percent(range.size, scale)).toFixed(1)}%`;
      fill.style.animationDelay = `${i * 50}ms`;
      const column = el("div", { class: "range-column" }, fill);
      column.addEventListener("pointermove", (event) => {
        showTip(event.clientX, event.clientY, L.formatBytes(range.size), name, `${L.formatCountOf(range.count, "个文件")}，占 ${Math.round(percent(range.size, total))}%`);
      }, { passive: true });
      column.addEventListener("pointerleave", hideTip, { passive: true });
      columns.append(column);
      labels.append(el("span", {}, el("b", { text: L.formatBytes(range.size).replace(/\.\d /, " ") }), name));
    });
    box.append(columns, labels);
    const line = L.bigFilesLine(ranges);
    return el("section", { id: "ranges" },
      el("h2", { text: "空间花在多大的文件上" }),
      line ? el("p", { class: "section-hint", text: line }) : null,
      el("div", { class: "group" }, box));
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
    width.style.width = `${Math.max(1, percent(Math.abs(cmp.delta[node]), scale)).toFixed(1)}%`;
    return el("button", {
      type: "button", class: "change row", title: full, onclick: () => browseTo(volume.key, node, true),
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

  function changeRows(items, scale, sign, showAll, toggle, emptyText) {
    const shown = showAll ? items : items.slice(0, 8);
    const rows = shown.map((item) => changeRow(item, scale, sign));
    if (items.length > 8) {
      rows.push(el("button", {
        type: "button", class: "more row", text: showAll ? "收起" : `显示全部 ${items.length} 项`, onclick: toggle,
      }));
    }
    return el("div", { class: "group" }, ...(rows.length ? rows : [el("div", { class: "empty", text: emptyText })]));
  }

  function renderChanges(pairs) {
    if (!pairs.some((p) => p.cmp)) return null;
    const redraw = () => replaceSection("changes", renderChanges(pairs));
    const grew = changeList(pairs, 1);
    const shrank = changeList(pairs, -1);
    const scale = Math.max(1, ...[...grew, ...shrank].map((x) => x.size));
    const freedTotal = shrank.reduce((sum, item) => sum + item.size, 0);
    const freed = el("details", { class: "group freed" },
      el("summary", {},
        el("span", { class: "title", text: "释放最多" }),
        el("span", { class: "sub", text: shrank.length ? `这段时间腾出来的空间，共约 ${L.formatBytes(freedTotal)}` : "这段时间没有明显腾出空间" }),
        chevron()),
      changeRows(shrank, scale, -1, ui.showAllShrank, () => { ui.showAllShrank = !ui.showAllShrank; redraw(); }, "没有超过 1 MB 的减少。"));
    return el("section", { id: "changes", class: "changes-block" },
      el("h2", { text: "这段时间的变化" }),
      el("div", { class: "changes" },
        el("div", {},
          changeRows(grew, scale, 1, ui.showAllGrew, () => { ui.showAllGrew = !ui.showAllGrew; redraw(); }, "没有超过 1 MB 的增长。"),
          freed),
        renderFiles(pairs)));
  }

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
    const section = el("div", { id: "files" });
    if (!usable && !reasons.length) return section;
    if (usable) {
      const tabs = [["added", "新增"], ["changed", "变大变小"], ["removed", "删除"]];
      const tabBar = segmented(`files-${counts.added}-${counts.removed}-${counts.changed}`, "文件变化类型",
        tabs.map(([key, label]) => ({ key, label: `${label} ${L.formatCount(counts[key])}` })), ui.fileTab, (kind) => {
          ui.fileTab = kind;
          ui.filesShown = 12;
          replaceSection("changes", renderChanges(pairs));
        });
      const list = lists[ui.fileTab].slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const rows = list.slice(0, ui.filesShown).map((f) => {
        const full = L.displayPath(f.letter, f.path);
        const cut = full.lastIndexOf("\\");
        return el("button", { type: "button", class: "file row", title: `点按复制：${full}`, onclick: () => copyPath(full) },
          el("span", { class: "file-path" }, full.slice(0, cut + 1), el("b", { text: full.slice(cut + 1) })),
          el("span", { class: "file-size", text: L.formatDelta(f.delta) }));
      });
      if (list.length > ui.filesShown) {
        rows.push(el("button", {
          type: "button", class: "more row", text: `再显示 ${Math.min(list.length - ui.filesShown, 40)} 项`,
          onclick: () => { ui.filesShown += 40; replaceSection("changes", renderChanges(pairs)); },
        }));
      }
      section.append(
        el("div", { class: "section-head" }, tabBar),
        el("p", { class: "section-hint", text: `合计 ${L.formatDelta(bytes[ui.fileTab])}。这里最多列出每类最大的 200 个。` }),
        el("div", { class: "group" }, ...(rows.length ? rows : [el("div", { class: "empty", text: "这一类没有文件。" })])));
    }
    for (const reason of reasons) section.append(el("p", { class: "section-hint", text: reason }));
    return section;
  }

  /* ---- The long view ---- */

  function trendChart(volume) {
    const points = (volume.records?.length ? volume.records : volume.snapshots.map((s) => ({ at: s.taken_at, total: s.total_bytes, free: s.free_bytes })));
    const used = points.map((p) => p.total - p.free);
    const low = Math.min(...used);
    const high = Math.max(...used);
    const span = Math.max(high - low, high * 0.01, 1);
    const floor = Math.max(0, low - span * 0.35);
    const top = high + span * 0.2;
    const W = 300;
    const H = 120;
    const first = points[0].at;
    const last = points[points.length - 1].at;
    const x = (t) => (last === first ? W / 2 : ((t - first) / (last - first)) * W);
    const y = (v) => H - ((v - floor) / (top - floor)) * (H - 4);
    const line = points.map((p, i) => `${x(p.at).toFixed(1)},${y(used[i]).toFixed(1)}`).join(" ");

    const chart = svgEl("svg", {
      viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img",
      "aria-label": `${volume.letter}: 已用空间，从 ${L.formatBytes(used[0])} 到 ${L.formatBytes(used[used.length - 1])}`,
    });
    chart.append(svgEl("line", { class: "trend-floor", x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }));
    chart.append(svgEl("line", { class: "trend-floor", x1: 0, x2: W, y1: H / 2, y2: H / 2 }));
    chart.append(svgEl("polygon", { class: "trend-area", points: `${x(first).toFixed(1)},${H} ${line} ${x(last).toFixed(1)},${H}` }));
    chart.append(svgEl("polyline", { class: "trend-line", points: line }));
    const cross = svgEl("line", { class: "trend-cross", y1: 0, y2: H, visibility: "hidden" });
    chart.append(cross);

    const forecast = L.forecast(points, data.generated_at);
    const speed = L.forecastLine(volume.letter, forecast);
    const box = colored(el("div", { class: "trend" },
      el("h3", { text: `${volume.letter}: 已用空间 ${L.formatBytes(used[used.length - 1])}` }),
      speed ? el("p", { class: "trend-speed", text: speed }) : null,
      chart,
      el("div", { class: "trend-range" },
        el("span", { text: dayOf(first) }),
        el("span", { text: `${dayOf(last)}，${points.length} 条记录` }))), diskColor(volume));

    const longView = L.longTerm(volume.records);
    if (longView) {
      box.append(el("div", { class: "trend-rows" },
        el("p", { text: `从 ${dayOf(longView.from)} 到现在，顶层目录变化最多的是：` }),
        ...longView.rows.map((row) => el("div", { class: "trend-row" },
          el("span", { text: row.name, title: row.name }),
          el("span", { text: L.formatDelta(row.delta) })))));
    }

    chart.addEventListener("pointermove", (event) => {
      const rect = chart.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * W;
      let best = 0;
      points.forEach((p, i) => {
        if (Math.abs(x(p.at) - px) < Math.abs(x(points[best].at) - px)) best = i;
      });
      const at = x(points[best].at);
      cross.setAttribute("x1", at);
      cross.setAttribute("x2", at);
      cross.setAttribute("visibility", "visible");
      showTip(event.clientX, rect.top + 6, L.formatBytes(used[best]), L.formatDate(points[best].at));
    }, { passive: true });
    chart.addEventListener("pointerleave", () => {
      cross.setAttribute("visibility", "hidden");
      hideTip();
    }, { passive: true });
    return box;
  }

  function renderHistory(pairs) {
    const volumes = shownVolumes().filter((v) => v.snapshots.length || v.records?.length);
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
        class: "scan row",
        "aria-label": `和 ${L.formatDate(choice.at)} 的扫描比较`,
        onclick: () => {
          ui.from = choice.id;
          ui.browse = null;
          render();
          window.scrollTo({ top: 0, behavior: calm() ? "auto" : "smooth" });
        },
      }, ...cells);
    });
    const trends = volumes.filter((v) => (v.records?.length ? v.records.length : v.snapshots.length) >= 3);
    return el("section", { id: "history" },
      el("h2", { text: "长期趋势和历史" }),
      trends.length ? el("div", { class: "trends" }, ...trends.map(trendChart)) : null,
      rows.length ? el("div", { class: "group" }, ...rows) : null);
  }

  /* ---- How sure is this ---- */

  function trustRow(pair) {
    const { volume, cmp, b } = pair;
    if (b < 0) {
      const run = volume.this_run;
      return el("details", {},
        el("summary", { class: "row" }, el("span", { class: "title", text: `${volume.letter}:` }), el("span", { class: "sub", text: "没有可用的扫描结果" }), chevron()),
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
      el("summary", { class: "row" }, el("span", { class: "title", text: `${snap.letter}:` }), el("span", { class: "sub", text: statusParts.join("，") }), chevron()),
      body);
  }

  function renderTrust(pairs) {
    if (!pairs.length) return null;
    return el("section", { id: "trust" },
      el("h2", { text: "这份结果有多可靠" }),
      el("div", { class: "group" }, ...pairs.map(trustRow)));
  }

  /* ---- What Diskly itself takes ---- */

  function renderFootprint() {
    const f = data.footprint;
    if (!f || !f.limit) return null;
    const parts = [
      ["程序", f.program, "var(--s0)"],
      ["快照", f.snapshots, "var(--s2)"],
      ["报告", f.reports, "var(--s6)"],
      ["窗口缓存", f.webview, "var(--s3)"],
      ["长期记录", f.records, "var(--s4)"],
      ["其他", f.other, "var(--neutral)"],
    ].filter(([, size]) => size > 0);
    const barBox = el("div", { class: "footprint-bar", role: "img", "aria-label": parts.map(([name, size]) => `${name} ${L.formatBytes(size)}`).join("，") },
      ...parts.map(([name, size, color]) => {
        const part = colored(el("span"), color);
        part.style.width = `${Math.max(0.4, percent(size, f.limit)).toFixed(2)}%`;
        part.addEventListener("pointermove", (event) => showTip(event.clientX, event.clientY, L.formatBytes(size), name), { passive: true });
        part.addEventListener("pointerleave", hideTip, { passive: true });
        return part;
      }));
    return el("section", { id: "footprint" },
      el("h2", { text: "Diskly 自己占多少" }),
      el("div", { class: "group" }, el("div", { class: "footprint" },
        el("div", { class: "footprint-total" },
          el("b", { text: L.formatBytes(f.total) }),
          el("span", { text: `上限 ${L.formatBytes(f.limit)}，用多久都不会超过` })),
        barBox,
        el("div", { class: "footprint-keys" }, ...parts.map(([name, size, color]) => el("span", { class: "key" }, colored(el("i"), color), `${name} ${L.formatBytes(size)}`))),
        el("p", { class: "footprint-rule", text: `每次扫描后自动清理：完整快照只留最新一份，更早的最多再留 ${Math.max(0, f.keep_snapshots - 1)} 次、只存目录；报告最多留 ${f.keep_reports} 份；${f.records_kept ? `${L.formatCount(f.records_kept)} 条` : ""}长期记录一直保留，越久越稀疏，只占几百 KB。放不下时先删最旧的。` }))));
  }

  /* ---- The AI sheet ---- */

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
      class: "pill press",
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
        el("button", { type: "button", class: "pill quiet press", text: "关闭", onclick: closeDialog }),
        copy));
  }

  function openAiDialog() {
    renderAiDialog();
    dialog.classList.remove("closing");
    dialog.showModal();
    document.getElementById("ai-copy").focus();
  }

  /* It sinks away instead of just vanishing. */
  function closeDialog() {
    if (!dialog.open) return;
    if (calm()) {
      dialog.close();
      return;
    }
    dialog.classList.add("closing");
    setTimeout(() => {
      dialog.classList.remove("closing");
      dialog.close();
    }, 190);
  }

  /* Clicking the dimmed page closes the sheet, and so does Escape, the same way. */
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });

  /* ---- The whole page ---- */

  function far(...children) {
    const present = children.filter(Boolean);
    if (!present.length) return null;
    return el("div", { class: `far${present.length > 1 ? " columns" : ""}` }, ...present);
  }

  function drawPage(opening) {
    const pairs = currentPairs();
    const merged = L.mergeInsights(pairs);
    const disks = placed(el("div", { id: "disks", role: "group", "aria-label": "磁盘" },
      renderRings(pairs, opening),
      el("div", { class: "disk-list" }, ...pairs.map(diskRow))), 3);
    const footer = el("footer", {},
      el("p", { text: "Diskly 只读取信息，不会修改或删除你的任何文件。这份报告保存在你的电脑上，不联网。其中包含目录名和文件名，分享前请留意。" }),
      el("p", { text: `Diskly ${data.app_version}，生成于 ${L.formatDate(data.generated_at)}。` }));
    const y = window.scrollY;
    app.classList.toggle("opening", opening && !calm());
    app.replaceChildren(...[
      renderHero(pairs),
      ...runNotice(),
      disks,
      renderFacts(pairs, merged, opening),
      renderFolders(pairs),
      far(renderLargest(merged), renderKinds(merged)),
      far(renderTopFolders(pairs), renderSpots(merged)),
      far(renderRanges(merged)),
      far(renderChanges(pairs)),
      far(renderHistory(pairs)),
      far(renderTrust(pairs)),
      far(renderFootprint()),
      footer,
    ].filter(Boolean));
    window.scrollTo({ top: y, behavior: "instant" });
    /* The map needs its frame's size, so it is drawn once the frame is in the page. */
    if (mapFrame) {
      mapWidth = mapFrame.clientWidth;
      const place = mapPlace();
      if (place) mapFrame.replaceChildren(drawCanvas(place, mapWidth, mapFrame.clientHeight, opening && !calm()));
    }
    renderBar();
    titleWatch.disconnect();
    const heading = app.querySelector(".hero h1");
    if (heading) titleWatch.observe(heading);
  }

  /* A choice crossfades where the browser can, rather than jumping. */
  function render() {
    if (document.startViewTransition && !calm() && app.firstChild) {
      document.startViewTransition(() => drawPage(false));
    } else {
      drawPage(false);
    }
  }

  loadTheme();
  if (!data.volumes.length) {
    renderBar();
    app.replaceChildren(el("div", { class: "hero" },
      el("h1", { text: "还没有可显示的扫描" }),
      el("p", { text: "回到 Diskly 点“扫描”，开始第一次扫描。" })));
  } else {
    if (data.volumes.length === 1 && data.volumes[0].key) ui.filter = data.volumes[0].key;
    drawPage(true);
    /* The opening is one moment: after it, nothing replays by accident. */
    setTimeout(() => app.classList.remove("opening"), 1400);
  }
})();
