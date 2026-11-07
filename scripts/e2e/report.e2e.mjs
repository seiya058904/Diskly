// The report in a real browser, opened from a file:// URL as it is in real use.
// Usage: node report.e2e.mjs <folder with demo pages> <folder for screenshots>
// Make the pages first with scripts/demo/demo-data.js and the render_report example.

import assert from "node:assert/strict";
import { join } from "node:path";
import { fileUrl, launchBrowser } from "./cdp.mjs";

const [pages, out] = process.argv.slice(2);
const { page, stop } = await launchBrowser(join(out, "tmp"));
const url = (scenario) => fileUrl(join(pages, `${scenario}.html`));
const text = (selector) => page.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
const texts = (selector) => page.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent)`);
const count = (selector) => page.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

const results = [];
async function check(name, run) {
  try {
    await run();
    results.push(`ok    ${name}`);
  } catch (error) {
    results.push(`FAIL  ${name}\n      ${error.message}`);
  }
}

async function openClean(scenario) {
  await page.viewport(1280, 900);
  await page.media({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(url(scenario));
}

try {
  await check("no script from a file name runs, and nothing is blocked or broken", async () => {
    await openClean("hostile");
    assert.equal(await page.eval("window.__pwned === undefined"), true, "a hostile name ran");
    assert.deepEqual(page.consoleErrors, []);
    // Hostile text is there to read, as text.
    assert.ok((await text("#app")).includes("</script>"));
    assert.equal(await count("#app img, #app svg[onload], #app script"), 0);
    await page.click("#open-ai");
    assert.equal(await page.eval("window.__pwned === undefined"), true, "the dialog ran a name");
    assert.equal(await count("#ai-dialog img, #ai-dialog script"), 0);
    await page.click("#ai-dialog .pill.quiet");
  });

  await check("names in the new sections are text too: files, kinds and places", async () => {
    await openClean("hostile");
    const page_ = await text("#app");
    assert.ok(page_.includes("onerror"), "the hostile names are shown as text");
    await page.eval(`document.querySelectorAll("#largest .item, #spots .item, .tile:not(.rest)").forEach((e) => e.dispatchEvent(new PointerEvent("pointermove", { bubbles: true })))`);
    assert.equal(await page.eval("window.__pwned === undefined"), true);
    assert.equal(await count("#app img, #app script, .tip img, .toast img"), 0);
    assert.deepEqual(page.consoleErrors, []);
  });

  await check("the page requests nothing from any network", async () => {
    await openClean("normal");
    await page.click("#open-ai");
    await page.click("#ai-dialog .pill.quiet");
    const remote = page.requests.filter((u) => !u.startsWith("file:") && !u.startsWith("data:"));
    assert.deepEqual(remote, []);
    const policy = await page.eval(`document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`);
    assert.match(policy, /default-src 'none'/);
    assert.ok(!policy.includes("unsafe"));
  });

  await check("the content security policy really stops injected code", async () => {
    await openClean("normal");
    const ran = await page.eval(`(() => {
      const s = document.createElement("script");
      s.textContent = "window.__injected = 1";
      document.body.append(s);
      return window.__injected === 1;
    })()`);
    assert.equal(ran, false);
  });

  await check("the opening sentence names both disks going opposite ways", async () => {
    await openClean("normal");
    assert.equal(await text("h1"), "C: 多用了 12.0 GB，D: 少用了 24.0 GB");
    const line = await text(".hero p");
    assert.match(line, /增加最多的是 C:\\Users\\Alex\\AppData\\Local\\Docker\\wsl/);
    assert.match(line, /减少最多的是 D:\\Photos\\2024/);
  });

  await check("filter by disk, and a missing disk says so instead of showing zero", async () => {
    await openClean("normal");
    assert.ok((await text("#disks")).includes("本次未连接"));
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(2)');
    assert.equal(await text("h1"), "C: 比上次多用了 12.0 GB");
    assert.equal(await count("#disks .disk"), 1);
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(4)');
    assert.ok((await text("#disks")).includes("本次未连接"));
    assert.equal(await text("h1"), "第一次扫描已完成");
    assert.ok(!(await text("#disks")).includes("0 B"));
  });

  await check("the folder list goes down and back up", async () => {
    await openClean("normal");
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(2)');
    assert.ok((await texts("#folders .folder-name")).includes("Users"));
    await page.eval(`[...document.querySelectorAll("#folders button.folder")].find((b) => b.textContent.includes("Users")).click()`);
    assert.ok((await texts("#folders .folder-name")).includes("Alex"));
    assert.ok((await texts("#folders .folder-name")).some((n) => n.includes("Public")));
    await page.eval(`[...document.querySelectorAll("#folders button.folder")].find((b) => b.textContent.includes("Alex")).click()`);
    assert.ok((await text("#folders .crumbs")).includes("Alex"));
    await page.eval(`[...document.querySelectorAll(".crumbs button")].find((b) => b.textContent === "C:").click()`);
    assert.ok((await texts("#folders .folder-name")).includes("Windows"));
  });

  await check("sorting by change puts the biggest change first", async () => {
    await openClean("normal");
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(2)');
    await page.eval(`[...document.querySelectorAll('.segments[aria-label="排序方式"] button')].find((b) => b.textContent === "按变化").click()`);
    const first = (await texts("#folders .folder-name"))[0];
    assert.equal(first, "Users");
  });

  await check("history opens the requested scan and keeps it across disk filters", async () => {
    await openClean("historical");
    const chosen = await page.eval('JSON.parse(document.getElementById("diskly-data").textContent).run.scan_id');
    assert.equal(await page.eval('document.querySelector(\'select[aria-label="比较的终点"]\').value'), chosen);
    assert.match(await text("h1"), /4.0 GB/);
    assert.match(await text(".hero"), /正在查看/);
    assert.equal(await count("#largest .item"), 0, "newer file details are not shown");
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(2)');
    assert.equal(await page.eval('document.querySelector(\'select[aria-label="比较的终点"]\').value'), chosen);
    assert.equal(await text("h1"), "C: 比上次多用了 3.0 GB");
    assert.match(await text("#disks"), /已用 102 GB/);
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(4)');
    assert.match(await text("#disks"), /沿用/);
    assert.equal(await page.eval('document.querySelector(\'select[aria-label="比较的终点"]\').value'), chosen);
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(2)');
    await page.click("#open-ai");
    assert.match(await text("#ai-preview"), /已用 102 GB/);
    assert.ok(!(await text("#ai-preview")).includes("已用 118 GB"));
    await page.click("#ai-dialog .pill.quiet");
    await page.click("#show-latest");
    assert.equal(await text("h1"), "C: 比上次多用了 12.0 GB");
  });

  await check("a carried disk cannot disable another disk's earliest comparison", async () => {
    await openClean("normal");
    const earliest = await page.eval('[...document.querySelectorAll("#history button.scan")].at(-1)?.textContent');
    assert.ok(earliest?.includes("99.0 GB") && earliest.endsWith("设为起点"));
    await page.eval('[...document.querySelectorAll("#history button.scan")].at(-1).click()');
    assert.match(await text("h1"), /19.0 GB/);
  });

  await check("same-second endpoints and their option labels remain distinct", async () => {
    await openClean("same-second");
    assert.match(await text("#disks"), /已用 102 GB/);
    const options = await texts('select[aria-label="比较的终点"] option');
    assert.equal(new Set(options).size, options.length);
    await page.click("#show-latest");
    assert.match(await text("#disks"), /已用 118 GB/);
    assert.deepEqual(page.consoleErrors, []);
  });

  await check("format-one data still renders folders, comparisons and copy controls", async () => {
    await openClean("legacy");
    assert.match(await text("h1"), /4.0 GB/);
    assert.equal(await count("#largest"), 0, "old reports did not keep file insights");
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(2)');
    await page.eval('[...document.querySelectorAll("#folders button.folder")].find((r) => r.querySelector(".folder-name").textContent === "Windows").click()');
    assert.equal(await text(".crumbs .here"), "Windows");
    assert.equal(await count("#copy-folder-path"), 1);
    assert.deepEqual(page.consoleErrors, []);
  });

  await check("restored leaf folders show current files while changes stay unknown", async () => {
    await openClean("leaf-edges");
    const restored = await page.eval('[...document.querySelectorAll("#folders button.folder")].find((r) => r.querySelector(".folder-name").textContent === "Restored")?.textContent');
    assert.match(restored, /19.0 GB.*变化未知/);
    assert.ok(await page.eval('[...document.querySelectorAll(".tile")].some((t) => t.getAttribute("aria-label").startsWith("Restored，"))'));
    await page.eval('[...document.querySelectorAll("#folders button.folder")].find((r) => r.querySelector(".folder-name").textContent === "Restored").click()');
    assert.match(await text(".folder-file"), /image.vhdx.*19.0 GB/);
    assert.ok(!(await text("#folders .section-hint")).includes("+19.0 GB"));
    await page.screenshot(join(out, "restored-leaf.png"));
    await page.eval('[...document.querySelectorAll(".crumbs button")].find((b) => b.textContent === "C:").click()');
    await page.eval('[...document.querySelectorAll("#folders button.folder")].find((r) => r.querySelector(".folder-name").textContent === "Denied").click()');
    assert.match(await text("#folders .section-hint"), /大小未知/);
    assert.ok(!(await text("#folders .section-hint")).includes("0 B"));
    assert.equal(await count(".tile"), 0);
    await page.eval('[...document.querySelectorAll(".crumbs button")].find((b) => b.textContent === "C:").click()');
    await page.eval('[...document.querySelectorAll("#folders button.folder")].find((r) => r.querySelector(".folder-name").textContent === "Empty").click()');
    assert.match(await text(".folder-file"), /zero.bin.*0 B/);
    assert.equal(await count(".tile"), 0, "zero-byte files have no area");
    assert.deepEqual(page.consoleErrors, []);
  });

  await check("archived history shows a summary, with no newer map or file details", async () => {
    await openClean("archived");
    assert.equal(await text("h1"), "这次扫描仅保留摘要");
    assert.match(await text("#disks"), /已用 99.0 GB/);
    assert.equal(await count("#folders, #largest, #changes"), 0);
    assert.ok((await texts("#history .scan")).some((s) => s.includes("仅保留摘要") && s.endsWith("终点")));
    assert.ok(!(await text("#history .trends")).includes("118 GB"));
    await page.click("#open-ai");
    assert.match(await text("#ai-preview"), /已用 99.0 GB/);
    assert.ok(!(await text("#ai-preview")).includes("ext4.vhdx"));
    await page.click("#ai-dialog .pill.quiet");
    await page.screenshot(join(out, "archived.png"));
    await page.click("#show-latest");
    assert.match(await text("#disks"), /已用 118 GB/);
    assert.ok(await count("#folders"));
    assert.deepEqual(page.consoleErrors, []);
  });

  await check("a run without capacity records never borrows live capacity", async () => {
    await openClean("run-only");
    assert.equal(await text("h1"), "这次扫描仅保留摘要");
    assert.match(await text("#disks"), /容量未知/);
    assert.equal(await text(".ring-center b"), "未知");
    assert.equal(await count("#folders, #largest, .trend"), 0);
    assert.deepEqual(page.consoleErrors, []);
  });

  await check("leaf folders open from list and map, with files, remainder and copyable paths", async () => {
    await openClean("normal");
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(3)');
    await page.eval('[...document.querySelectorAll("#folders button.folder")].find((b) => b.querySelector(".folder-name").textContent === "Backup").click()');
    assert.equal(await text(".crumbs .here"), "Backup");
    assert.match(await text(".folder-file"), /laptop-image-2026.vhdx.*19.0 GB/);
    assert.match(await text(".folder.rest"), /其他文件和未收录的目录详情.*2.0 GB/);
    assert.ok(await page.eval('[...document.querySelectorAll(".map-canvas .tile")].some((e) => e.getAttribute("aria-label").startsWith("laptop-image-2026.vhdx，文件"))'));
    await page.realClick("#copy-folder-path");
    await page.waitFor('document.querySelector(".toast.on")');
    assert.equal(await page.eval("navigator.clipboard.readText()"), "D:\\Backup");
    await page.realClick(".folder-file");
    await page.waitFor('document.querySelector(".toast.on")');
    assert.equal(await page.eval("navigator.clipboard.readText()"), "D:\\Backup\\laptop-image-2026.vhdx");
    await page.screenshot(join(out, "leaf-folder.png"));
    await page.eval('[...document.querySelectorAll(".crumbs button")].find((b) => b.textContent === "D:").click()');
    await page.eval('[...document.querySelectorAll(".map-canvas .tile")].find((b) => b.getAttribute("aria-label").startsWith("Backup，")).click()');
    assert.equal(await text(".crumbs .here"), "Backup");
    for (const width of [480, 320]) {
      await page.viewport(width, 800);
      assert.equal(await page.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0);
    }
    await page.eval('document.querySelector("#folders").scrollIntoView({ block: "start" })');
    await page.screenshot(join(out, "leaf-folder-mobile.png"));
    assert.deepEqual(page.consoleErrors, []);
  });

  await check("files remain reachable when intermediate folders were omitted", async () => {
    await openClean("normal");
    await page.eval('[...document.querySelectorAll("#largest .with-action")].find((r) => r.textContent.includes("ext4.vhdx")).querySelector(".locate").click()');
    assert.equal(await text(".crumbs .here"), "wsl");
    assert.ok((await texts(".folder-file .folder-name")).includes("main\\ext4.vhdx"));
    assert.equal(await count(".folder-file"), 1);
  });

  await check("the biggest files come first, and nothing ranks what is small", async () => {
    await openClean("normal");
    const sizes = await page.eval(`[...document.querySelectorAll("#largest .item-size")].map((e) => e.textContent)`);
    assert.equal(sizes[0], "28.0 GB", "the biggest file on any disk");
    assert.equal(await text("#largest .item-name"), "basegame_4_gi.archive");
    const all = await text("#app");
    assert.ok(!all.includes("最小"), "nobody asked about the smallest");
    assert.ok(!all.includes("变小最多"), "freed space is a detail, under its own name");
    assert.equal(await page.eval(`document.querySelector("details.freed").open`), false, "and closed by default");
    assert.ok((await text("#facts")).includes("最大的文件"));
    assert.ok((await text("#facts")).includes("最占地方的目录"));
  });

  await check("a kind filters the file list, and picking it again clears it", async () => {
    await openClean("normal");
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(2)');
    const pick = (label) => page.eval(`[...document.querySelectorAll("#kinds .kind-row")].find((r) => r.textContent.includes(${JSON.stringify(label)})).click()`);
    await pick("视频");
    assert.deepEqual(await texts("#largest .item-name"), ["meeting-recording-2026-10-28.mp4"]);
    assert.ok((await text("#kinds")).includes(".mp4"));
    assert.ok(!(await text("#kinds")).includes(".dll"), "the extensions follow");
    await pick("视频");
    assert.ok((await count("#largest .item")) > 5);
  });

  await check("the folders that take the most space, and places worth a look, say what they are", async () => {
    await openClean("normal");
    const folders = await texts("#top-folders .item-name");
    assert.equal(folders[0], "Videos");
    assert.ok(folders.includes("wsl"), "down to the folder that explains it");
    const spots = await text("#spots");
    assert.ok(spots.includes("Steam 游戏") && spots.includes("Docker 和 WSL"));
    assert.ok(spots.includes("不要手动删除"), "and says what not to do");
    assert.ok(spots.includes("Diskly 只告诉你"));
    await page.click("#spots button.item");
    assert.ok((await text("#folders .crumbs")).includes("steamapps") || (await text("#folders .crumbs")).includes("D:"));
    assert.match(await text("#ranges .section-hint"), /个文件占了 \d+% 的空间/);
    assert.equal(await count("#ranges .range-column"), 8);
  });

  await check("the map draws the disk in proportion, and goes in and back out", async () => {
    await openClean("normal");
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(2)');
    await page.waitFor(`document.querySelector(".map-canvas .tile")`);
    const box = await page.eval(`(() => {
      const frame = document.querySelector(".map-frame").getBoundingClientRect();
      const tile = (name) => { const t = [...document.querySelectorAll(".map-canvas .tile")].find((e) => e.getAttribute("aria-label").startsWith(name + "，")); const r = t.getBoundingClientRect(); return { area: r.width * r.height, inside: r.left >= frame.left - 1 && r.right <= frame.right + 1 && r.top >= frame.top - 1 && r.bottom <= frame.bottom + 1 }; };
      return { users: tile("Users"), windows: tile("Windows") };
    })()`);
    assert.ok(box.users.inside && box.windows.inside);
    const ratio = box.users.area / box.windows.area;
    assert.ok(Math.abs(ratio - 56.2 / 33.4) < 0.08, `Users to Windows drawn at ${ratio}`);
    const click = (name) => page.eval(`[...document.querySelectorAll(".map-canvas .tile")].find((e) => e.getAttribute("aria-label").startsWith(${JSON.stringify(name + "，")})).click()`);
    await click("Users");
    assert.ok((await text("#folders .crumbs")).includes("Users"));
    assert.ok((await texts("#folders .folder-name")).includes("Alex"), "the list follows the map");
    assert.ok(await page.eval(`[...document.querySelectorAll(".map-canvas .tile")].some((e) => e.getAttribute("aria-label").startsWith("Alex，"))`));
    await page.eval(`[...document.querySelectorAll(".crumbs button")].find((b) => b.textContent === "C:").click()`);
    assert.ok((await texts("#folders .folder-name")).includes("Windows"));
    assert.equal(await count(".map-canvas"), 1);
  });

  await check("the map shows big files where they are, and a folder it cannot read is said, not drawn", async () => {
    await openClean("normal");
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(2)');
    await page.waitFor(`document.querySelector(".map-canvas .tile")`);
    assert.ok(await page.eval(`[...document.querySelectorAll(".map-canvas .tile")].some((e) => e.getAttribute("aria-label").startsWith("hiberfil.sys，文件"))`));
    await openClean("walk-unknown");
    await page.waitFor(`document.querySelector(".map-canvas .tile")`);
    const labels = await page.eval(`[...document.querySelectorAll(".map-canvas .tile")].map((e) => e.getAttribute("aria-label"))`);
    assert.ok(!labels.some((l) => l.startsWith("System Volume Information")), "an unknown size has no area");
    assert.match(await text(".map-legend"), /未能读取，大小未知/);
  });

  await check("a file can be copied by its path, and says so", async () => {
    await openClean("normal");
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
    await page.realClick("#largest .item");
    await page.waitFor(`document.querySelector(".toast.on")`);
    assert.equal(await text(".toast"), "已复制路径");
    const pasted = await page.eval("navigator.clipboard.readText()");
    assert.ok(pasted.endsWith("basegame_4_gi.archive"), pasted);
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  });

  await check("the long view uses the records, with a forecast and what grew", async () => {
    await openClean("normal");
    const history = await text("#history");
    assert.ok(history.includes("30 条记录"), "far more than the snapshots kept");
    assert.ok(history.includes("最近每月多用约"));
    assert.ok(history.includes("顶层目录变化最多"));
    assert.ok(/\d{4} 年 \d+ 月/.test(history), "a span over a new year says the year");
    assert.equal(await count("#history .trend"), 2, "one chart per disk, never two scales on one");
  });

  await check("the long view shows only what it knows, from three records up", async () => {
    await openClean("long-view");
    assert.equal(await count("#history .trend"), 2, "two records are too few for a chart");
    assert.equal(await count("#history .trend-rows"), 1, "records from before serials compare nothing");
    const rows = await texts("#history .trend-row");
    assert.equal(rows.length, 1, rows.join());
    assert.ok(rows[0].startsWith("Windows"), rows[0]);
    assert.ok(!(await text("#history")).includes("Users"), "a folder read only in part has no change");
  });

  await check("it says what Diskly itself takes, against the limit", async () => {
    await openClean("normal");
    const shown = await text("#footprint");
    assert.ok(shown.includes("28.0 MB") && shown.includes("上限 50.0 MB"));
    assert.ok(shown.includes("程序") && shown.includes("快照") && shown.includes("报告"));
    assert.ok(shown.includes("长期记录一直保留"));
  });

  await check("a disk whose earlier snapshot had to go is not called new", async () => {
    await openClean("pruned");
    assert.equal(await text("h1"), "这次无法比较目录变化");
    assert.match(await text(".hero p"), /占用上限/);
    assert.ok((await text("#history")).includes("30 条记录"), "the long view is still there");
    assert.equal(await count(".changes"), 0);
  });

  await check("with motion on, flying into a folder ends on one map and leaves no error", async () => {
    await page.viewport(1280, 900);
    await page.media({ colorScheme: "dark", reducedMotion: "no-preference" });
    await page.goto(url("normal"));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await count("main.opening"), 0, "the opening is over");
    await page.eval(`document.querySelector(".map-canvas .tile.big").click()`);
    assert.equal(await count(".map-canvas"), 2, "both during the flight");
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(await count(".map-canvas"), 1, "one after it");
    await page.click("#open-ai");
    await page.click("#ai-dialog .pill.quiet");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.eval(`document.getElementById("ai-dialog").open`), false, "the sheet sinks away and is gone");
    assert.deepEqual(page.consoleErrors, []);
  });

  await check("a change links to its folder", async () => {
    await openClean("normal");
    await page.click(".changes .change");
    assert.ok((await text("#folders .crumbs")).includes("Docker"));
  });

  await check("choosing another start changes the comparison, and the history shows it", async () => {
    await openClean("normal");
    await page.click('.segments[aria-label="选择磁盘"] button:nth-child(2)');
    assert.equal(await count("#history .scan-role.on"), 2);
    const oldest = await page.eval(`(() => { const s = document.querySelector('select[aria-label="比较的起点"]'); return s.options[s.options.length - 1].value; })()`);
    await page.eval(`(() => { const s = document.querySelector('select[aria-label="比较的起点"]'); s.value = ${JSON.stringify(oldest)}; s.dispatchEvent(new Event("change")); })()`);
    assert.match(await text("h1"), /C: 比 \d+ 月 \d+ 日多用了 19\.0 GB/);
    assert.equal(await count("#history .scan-role.on"), 2);
    assert.ok((await text("#files")).includes("只保留相邻两次"), "no file list across several scans");
    await page.click("#history button.scan");
    assert.match(await text("h1"), /多用了/);
  });

  await check("a folder that could not be read never shows as freed", async () => {
    await openClean("walk-unknown");
    assert.match(await text("h1"), /几乎没有变化/);
    const changes = await text(".changes");
    assert.ok(!changes.includes("System Volume Information"), "an unknown folder in the ranking");
    assert.ok(!changes.includes("CSC"));
    assert.ok(changes.includes("没有超过 1 MB 的减少"));
    const row = await page.eval(`[...document.querySelectorAll("#folders .folder")].find((r) => r.textContent.includes("System Volume Information")).textContent`);
    assert.ok(row.includes("未知"));
    assert.ok((await text("#files")).includes("能读取的目录不同"));
    assert.ok((await text("#app")).includes("没有获得管理员权限"));
    // Windows lost 1 GB, all of it in the folder that could not be read.
    await page.eval(`[...document.querySelectorAll("#folders button.folder")].find((b) => b.textContent.includes("Windows")).click()`);
    assert.ok((await text("#folders .section-hint")).includes("这个目录共"));
    await page.click("#trust summary");
    assert.ok((await text("#trust")).includes("这不是空间被释放了"));
  });

  await check("scans made in different ways are not compared", async () => {
    await openClean("engines");
    assert.equal(await text("h1"), "这次无法比较目录变化");
    assert.match(await text(".hero p"), /不同的扫描方式/);
    assert.equal(await count(".changes"), 0);
    assert.ok((await text("#disks")).includes("没有可比的历史"));
    assert.ok((await text("#folders")).includes("Users"), "the sizes are still there");
  });

  await check("a first scan is a baseline, with sizes and no changes", async () => {
    await openClean("first");
    assert.equal(await text("h1"), "第一次扫描已完成");
    assert.equal(await count(".changes"), 0);
    assert.equal(await count("#files"), 0);
    assert.equal(await count('select[aria-label="比较的起点"]'), 0);
  });

  await check("an empty report says what to do", async () => {
    await openClean("empty");
    assert.equal(await text("h1"), "还没有可显示的扫描");
    assert.deepEqual(page.consoleErrors, []);
  });

  await check("the AI text is previewed, hides names by default, and really copies", async () => {
    await openClean("normal");
    /* A headless window never has focus, and a page without focus may not copy. */
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
    await page.click("#open-ai");
    assert.equal(await page.eval(`document.getElementById("ai-dialog").open`), true);
    const shown = await text("#ai-preview");
    assert.ok(!shown.includes("Alex"), "account name shown");
    assert.ok(!shown.includes("Contoso"), "organization shown");
    assert.ok(shown.includes("C:\\Users\\<用户>\\AppData\\Local\\Docker\\wsl"));
    assert.ok(shown.includes("【请回答】"));
    await page.click("#redact-accounts");
    assert.ok((await text("#ai-preview")).includes("Alex"), "unticking shows names");
    await page.click("#redact-accounts");
    await page.click("#redact-personal");
    assert.ok(!(await text("#ai-preview")).includes("VisualStudioSetup"), "personal folders hidden");
    await page.click("#redact-personal");

    await page.realClick("#ai-copy");
    await page.waitFor(`document.getElementById("ai-copy").textContent !== "复制"`);
    assert.equal(await text("#ai-copy"), "已复制");
    const pasted = await page.eval("navigator.clipboard.readText()");
    /* Windows keeps text on the clipboard with CRLF line ends. */
    assert.equal(pasted.replaceAll("\r\n", "\n"), await text("#ai-preview"), "the clipboard holds what was previewed");
    assert.ok(!pasted.includes("Alex"), "the names stay hidden on the clipboard too");
  });

  await check("the keyboard works: Tab reaches controls, focus shows, Escape closes", async () => {
    await openClean("normal");
    await page.press("Tab", "Tab", 9);
    const first = await page.eval("document.activeElement.textContent");
    assert.equal(first, "全部");
    const outline = await page.eval("getComputedStyle(document.activeElement).outlineStyle");
    assert.equal(outline, "solid", "focus must be visible");
    await page.click("#open-ai");
    assert.equal(await page.eval(`document.activeElement.id`), "ai-copy");
    await page.press("Escape", "Escape", 27);
    assert.equal(await page.eval(`document.getElementById("ai-dialog").open`), false);
  });

  await check("no horizontal scrolling at any width, in any state", async () => {
    await page.media({ reducedMotion: "reduce" });
    for (const scenario of ["normal", "historical", "legacy", "same-second", "leaf-edges", "archived", "run-only", "walk-unknown", "hostile", "engines", "first", "pruned"]) {
      for (const width of [1920, 1280, 900, 760, 480, 360, 320]) {
        await page.viewport(width, 800);
        await page.goto(url(scenario));
        const over = await page.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth");
        assert.equal(over, 0, `${scenario} at ${width}px overflows by ${over}px`);
      }
    }
  });

  await check("high resolution screens render at full scale", async () => {
    for (const scale of [1, 1.5, 2]) {
      await page.viewport(1280, 900, scale);
      await page.goto(url("normal"));
      assert.equal(await page.eval("window.devicePixelRatio"), scale);
      assert.equal(await page.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth"), 0);
    }
  });

  await check("reduced motion turns the animation off", async () => {
    await page.viewport(1280, 900);
    await page.media({ reducedMotion: "reduce" });
    await page.goto(url("normal"));
    const duration = await page.eval(`getComputedStyle(document.querySelector(".rail .grew")).animationDuration`);
    assert.ok(parseFloat(duration) < 0.01, `animation runs for ${duration}`);
  });

  await check("it opens pure black even on a light system, and the look can be chosen", async () => {
    await page.viewport(1280, 900);
    await page.media({ colorScheme: "light" });
    await page.goto(url("normal"));
    await page.eval(`localStorage.removeItem("diskly-theme")`);
    await page.goto(url("normal"));
    /* light-dark() follows a change of color-scheme on the next frame, not at once. */
    const backgroundBecomes = (color) => page.waitFor(`getComputedStyle(document.documentElement).backgroundColor === "${color}"`, 1000);
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), "dark");
    await backgroundBecomes("rgb(0, 0, 0)");
    await page.click('.icon-button');
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), "light");
    await backgroundBecomes("rgb(242, 242, 247)");
    await page.click('.icon-button');
    assert.equal(await page.eval(`document.documentElement.dataset.theme ?? "system"`), "system");
    await backgroundBecomes("rgb(242, 242, 247)");
    await page.goto(url("normal"));
    assert.equal(await page.eval(`document.documentElement.dataset.theme ?? "system"`), "system", "the choice is remembered");
    await page.click('.icon-button');
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), "dark");
    await page.eval(`localStorage.removeItem("diskly-theme")`);
  });

  await check("a report at the size limit stays quick", async () => {
    await openClean("big");
    await page.waitFor(`document.querySelector(".map-canvas .tile")`);
    const ms = await page.eval(`(async () => {
      const start = performance.now();
      document.querySelector('.segments[aria-label="排序方式"] button:nth-child(2)').click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - start;
    })()`);
    assert.ok(ms < 500, `redrawing took ${Math.round(ms)} ms`);
    const nodes = await page.eval("JSON.parse(document.getElementById('diskly-data').textContent).volumes[0].table.names.length");
    assert.ok(nodes >= 20000, `only ${nodes} folders`);
  });
} finally {
  stop();
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
