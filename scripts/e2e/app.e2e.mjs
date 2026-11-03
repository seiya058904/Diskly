// The real app, in its real window, scanning real disks. Its history goes to a
// throwaway folder. It writes a few known files inside the repository's target
// folder, which is on a scanned disk, and removes exactly those at the end.
//
// node app.e2e.mjs <diskly.exe> <work folder> <phase>
//   basic         a normal scan, a change, a second scan, cancel, history, settings,
//                 and what it all takes on disk
//   browser       a normal scan that opens its report in the real default browser
//   uac-accept    two fast scans: answer YES to both Windows prompts
//   uac-decline   a fast scan: answer NO to the Windows prompt
//   uac-slow      a fast scan: wait 30 seconds, then answer YES

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectToPage, fileUrl, launchBrowser } from "./cdp.mjs";

const [exe, work, phase] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const lib = createRequire(import.meta.url)(join(repo, "report", "lib.js"));

const MB = 1024 * 1024;
const PORT = 9333;
const dataDir = join(work, "app-data", "Diskly", "Data");
const shots = join(work, "shots");
const scratch = join(repo, "target", "e2e-scratch");
mkdirSync(dataDir, { recursive: true });
/* The app scans the fastest way by default, which asks for rights. These phases say
   how to scan first, so that only the uac phases meet a prompt. */
const settingsFile = join(dataDir, "settings.json");
if (!existsSync(settingsFile)) writeFileSync(settingsFile, JSON.stringify({ scan_mode: "normal", theme: "dark" }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function check(name, run) {
  const started = Date.now();
  try {
    await run();
    results.push(`ok    ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (error) {
    results.push(`FAIL  ${name}\n      ${error.message}`);
  }
  console.log(results[results.length - 1]);
}

function capture(name) {
  spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "capture-window.ps1"), "-Title", "Diskly", "-Out", join(shots, `${name}.png`)]);
}

/* ---- The app ---- */

function startApp(extraEnv) {
  return spawn(exe, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      DISKLY_DATA_DIR: dataDir,
      DISKLY_NO_BROWSER: "1",
      /* This replaces the flags the app sets, so the ones that keep its cache small go along. */
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --disable-component-update --disable-background-networking --no-pings --disable-gpu-shader-disk-cache --disk-cache-size=1048576 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,PersistentHistograms`,
      ...extraEnv,
    },
  });
}

let app;
let page;

async function openApp(extraEnv) {
  app = startApp(extraEnv);
  page = await connectToPage(PORT, 30000, (t) => t.url.includes("tauri.localhost"));
  await page.waitFor(`document.getElementById("scan-button")`);
}

const lead = () => page.eval(`document.querySelector(".lead")?.textContent ?? ""`);
const screen = () => page.eval(`document.getElementById("view").textContent`);

async function waitForScanToEnd(timeout = 240000) {
  await page.waitFor(`(() => { const b = document.getElementById("scan-button"); return b && !b.classList.contains("quiet"); })()`, timeout);
}

/* ---- What the app left behind ---- */

function runs() {
  const dir = join(dataDir, "runs");
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

function reportData(run) {
  const html = readFileSync(join(dataDir, "reports", run.report_file), "utf8");
  const match = html.match(/<script type="application\/json" id="diskly-data">([\s\S]*?)<\/script>/);
  return JSON.parse(match[1]);
}

function history(letter) {
  const root = join(dataDir, "history");
  const out = [];
  for (const key of readdirSync(root)) {
    for (const file of readdirSync(join(root, key))) {
      if (!/^[^.]+\.json$/.test(file)) continue;
      const meta = JSON.parse(readFileSync(join(root, key, file), "utf8"));
      if (meta.letter === letter) out.push(meta);
    }
  }
  return out.sort((a, b) => a.scan_id.localeCompare(b.scan_id));
}

/* The volume this repository is on: that is where the known files are. */
const repoLetter = repo[0].toUpperCase();
const scratchRel = scratch.slice(3);

function nodeOf(volume, rel) {
  return volume.table.names.findIndex((name, i) => i > 0 && lib.pathOf(volume.table, i).toLowerCase() === rel.toLowerCase());
}

function scratchVolume(data) {
  return data.volumes.find((v) => v.letter === repoLetter);
}

function write(rel, size) {
  const path = join(scratch, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(size, 7));
}

function removeKnownFiles() {
  for (const rel of ["grows\\keep.bin", "grows\\big.bin", "removes\\old.bin", "second\\more.bin"]) {
    rmSync(join(scratch, rel), { force: true });
  }
  for (const rel of ["grows", "removes", "second", ""]) {
    try {
      rmdirSync(join(scratch, rel));
    } catch {
      /* Not there, or not empty because something else is in it: leave it. */
    }
  }
}

async function setScanMode(mode) {
  const settings = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
  assert.ok(settings);
  await page.eval(`window.__TAURI__.core.invoke("save_settings", { settings: ${JSON.stringify({ ...settings, scan_mode: mode })} })`);
  await page.eval(`location.reload()`);
  await sleep(600);
  await page.waitFor(`document.getElementById("scan-button")`);
}

/* ---- Phases ---- */

async function basic() {
  removeKnownFiles();
  write("grows\\keep.bin", 10 * MB);
  write("removes\\old.bin", 120 * MB);

  await check("the window opens and lists every fixed disk with its capacity", async () => {
    const shown = await screen();
    assert.ok(shown.includes(`${repoLetter}:`));
    assert.match(shown, /可用/);
    assert.match(await lead(), /看看磁盘空间都去了哪里/);
    capture("01-home");
  });

  let first;
  await check("a scan starts at once, shows progress and finishes with a baseline", async () => {
    await page.click("#scan-button");
    await page.waitFor(`document.querySelector(".disk-note")`);
    await sleep(700);
    capture("03-scanning");
    const during = await screen();
    assert.match(during, /正在扫描/);
    assert.match(during, /取消/);
    await waitForScanToEnd();
    capture("04-done");
    assert.match(await lead(), /扫描完成/);
    first = runs().at(-1);
    assert.ok(first.volumes.every((v) => v.status === "complete" && v.stored && v.engine === "walk"), JSON.stringify(first.volumes));
    assert.ok(first.report_file, "a report was written");
  });

  await check("the first report says it is a baseline", async () => {
    const data = reportData(first);
    const pairs = lib.withComparisons(lib.resolvePairs(data.volumes));
    assert.equal(lib.headline(pairs).title, "第一次扫描已完成");
    assert.ok(nodeOf(scratchVolume(data), `${scratchRel}\\grows`) > 0 || scratchVolume(data).table.names.length > 1);
  });

  await check("a normal scan records the folders it could not read", async () => {
    const c = history("C").at(-1);
    assert.ok(c.summary.unread_dirs.length > 0, "a normal user cannot read some system folders");
    assert.equal(c.summary.skipped_elsewhere ?? c.summary.skipped - c.summary.unread_dirs.length, 0);
    const volume = reportData(first).volumes.find((v) => v.letter === "C");
    assert.equal(volume.table.unread.at(-1).length, c.summary.unread_dirs.length);
  });

  write("grows\\big.bin", 300 * MB);
  rmSync(join(scratch, "removes\\old.bin"));

  let second;
  await check("a second scan reports the known change exactly", async () => {
    await page.click("#scan-button");
    await sleep(500);
    await waitForScanToEnd();
    second = runs().at(-1);
    assert.notEqual(second.scan_id, first.scan_id);
    const data = reportData(second);
    const volume = scratchVolume(data);
    const cmp = lib.compare(volume, volume.snapshots.length - 2, volume.snapshots.length - 1);
    const delta = (rel) => cmp.delta[nodeOf(volume, `${scratchRel}\\${rel}`)];
    assert.equal(delta("grows"), 300 * MB, "grows");
    assert.equal(delta("removes"), -120 * MB, "removes");
    assert.ok(volume.file_changes[cmp.snapB.id], "file changes were recorded");
    const files = volume.file_changes[cmp.snapB.id];
    assert.equal(files.unavailable, null);
    assert.ok(files.added.some((f) => f.path.endsWith("grows\\big.bin") && f.new === 300 * MB), "the new file is listed");
    assert.ok(files.removed.some((f) => f.path.endsWith("removes\\old.bin") && f.old === 120 * MB), "the removed file is listed");
  });

  await check("nothing in the real report looks freed because it could not be read", async () => {
    const data = reportData(second);
    const volume = data.volumes.find((v) => v.letter === "C");
    const cmp = lib.compare(volume, volume.snapshots.length - 2, volume.snapshots.length - 1);
    for (const i of volume.table.unread.at(-1)) {
      assert.equal(cmp.state[i], lib.STATE.UNKNOWN, lib.pathOf(volume.table, i));
    }
    const shrinking = lib.hotspots(cmp, -1, 50);
    assert.ok(shrinking.every((i) => !volume.table.unread.at(-1).includes(i)));
  });

  await check("the real report opens in a real browser with no errors and no requests", async () => {
    const { page: browser, stop } = await launchBrowser(join(work, "browser"));
    try {
      await browser.viewport(1280, 900);
      await browser.goto(fileUrl(join(dataDir, "reports", second.report_file)));
      assert.deepEqual(browser.consoleErrors, []);
      assert.deepEqual(browser.requests.filter((u) => !u.startsWith("file:") && !u.startsWith("data:")), []);
      const title = await browser.eval(`document.querySelector("h1").textContent`);
      assert.ok(title.length > 3, title);
      const prompt = await browser.eval(`(async () => {
        document.getElementById("open-ai").click();
        return document.getElementById("ai-preview").textContent;
      })()`);
      const account = process.env.USERNAME;
      assert.ok(prompt.includes("【请回答】"));
      assert.ok(!new RegExp(`\\\\Users\\\\${account}\\\\`, "i").test(prompt), "the account name is hidden");
    } finally {
      stop();
    }
  });

  await check("cancelling leaves the history of the unfinished disk alone", async () => {
    const before = history("C").length;
    await page.click("#scan-button");
    await sleep(150);
    await page.click("#scan-button");
    assert.match(await lead(), /正在取消/);
    await waitForScanToEnd();
    assert.match(await lead(), /已取消/);
    const run = runs().at(-1);
    const c = run.volumes.find((v) => v.letter === "C");
    assert.equal(c.status, "cancelled");
    assert.equal(c.stored, false);
    assert.equal(history("C").length, before, "no new baseline");
    capture("05-cancelled");
  });

  await check("the history lists every run and tells a cancelled one apart", async () => {
    await page.eval(`[...document.querySelectorAll(".text-button")].find((b) => b.textContent === "历史").click()`);
    await page.waitFor(`document.querySelector(".row")`);
    const shown = await screen();
    assert.match(shown, /已取消/);
    assert.equal(await page.eval(`document.querySelectorAll(".group .row").length`), runs().length);
    capture("06-history");
    await page.press("Escape", "Escape", 27);
    await page.waitFor(`document.getElementById("scan-button")`);
  });

  await check("settings are saved, and the theme applies at once", async () => {
    await page.eval(`[...document.querySelectorAll(".text-button")].find((b) => b.textContent === "设置").click()`);
    await page.waitFor(`document.querySelector('input[name="theme"]')`);
    await page.click('input[name="theme"][value="light"]');
    await sleep(300);
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), "light");
    capture("07-settings-light");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")).theme, "light");
    await page.click('input[name="theme"][value="dark"]');
    await sleep(200);
    assert.match(await screen(), /用多久都不会超过/);
    assert.match(await screen(), /程序位置/);
    capture("07-settings-dark");
    await page.press("Escape", "Escape", 27);
  });

  await check("the window says when a scan ran without the rights it asked for", async () => {
    /* The scan side of this was seen on real prompts; see the acceptance report. */
    await page.waitFor(`document.getElementById("scan-button")`);
    await page.eval(`onScanEvent({ kind: "finished", scan_id: "x", seconds: 7.2, cancelled: false, stored: 2, declined: true, error: null, run: null })`);
    await page.waitFor(`document.querySelector(".lead")?.textContent.includes("扫描完成")`);
    assert.match(await lead(), /没有获得管理员权限，这次用了普通扫描/);
    assert.match(await lead(), /7\.2 秒/);
    capture("08-declined");
    await page.eval("location.reload()");
    await sleep(500);
    await page.waitFor(`document.getElementById("scan-button")`);
  });

  await check("bad input to a command is refused", async () => {
    const refused = await page.eval(`window.__TAURI__.core.invoke("start_scan", { mode: "delete", onEvent: new window.__TAURI__.core.Channel() }).then(() => false, () => true)`);
    assert.equal(refused, true);
    const opened = await page.eval(`window.__TAURI__.core.invoke("open_report", { scanId: "..\\\\..\\\\windows" }).then(() => true, () => false)`);
    assert.equal(opened, false);
    const bad = await page.eval(`window.__TAURI__.core.invoke("save_settings", { settings: { scan_mode: "x", theme: "system" } }).then(() => false, () => true)`);
    assert.equal(bad, true);
  });

  await check("the window has nothing it was not given", async () => {
    const denied = await page.eval(`window.__TAURI__.core.invoke("plugin:shell|execute", {}).then(() => false, () => true)`);
    assert.equal(denied, true);
    assert.equal(await page.eval(`(async () => { try { await fetch("https://example.com"); return false; } catch { return true; } })()`), true, "no network from the window");
    assert.deepEqual(page.consoleErrors.filter((e) => !e.includes("example.com") && !e.includes("plugin:shell") && !e.includes("Content Security Policy")), []);
  });

  await check("all of it stays small: the program, the window's cache and the data", async () => {
    const folderSize = (dir) => {
      let total = 0;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) total += folderSize(path);
        else if (entry.isFile()) total += statSync(path).size;
      }
      return total;
    };
    const webview = join(dataDir, "..", "WebView");
    assert.ok(existsSync(webview), "the window's cache is next to the data, not elsewhere");
    const program = statSync(exe).size;
    const cache = folderSize(webview);
    const data = folderSize(dataDir);
    console.log(`      program ${(program / MB).toFixed(1)} MB, cache ${(cache / MB).toFixed(1)} MB, data ${(data / MB).toFixed(1)} MB`);
    assert.ok(cache < 6 * MB, `the window's cache takes ${cache}`);
    assert.ok(!existsSync(join(webview, "EBWebView", "WidevineCdm")), "nothing was downloaded");
    assert.ok(folderSize(join(webview, "EBWebView", "component_crx_cache")) < 1024, "nothing was downloaded");
    assert.ok(program + cache + data < 50 * MB, `${(program + cache + data) / MB} MB in all`);
  });

  await check("the report's data says what is kept, and older scans have only their folders", async () => {
    const run = runs().filter((r) => r.report_file).at(-1);
    const data = reportData(run);
    assert.equal(data.footprint.limit, 50 * MB);
    assert.ok(data.footprint.total > 0 && data.footprint.total < 50 * MB, String(data.footprint.total));
    assert.equal(data.footprint.keep_snapshots, 3);
    const volume = scratchVolume(data);
    assert.ok(volume.records.length >= 2, "records of each scan");
    const insights = volume.insights[volume.snapshots.at(-1).id];
    assert.ok(insights.files.length > 0 && insights.kinds.length > 0);
    assert.ok(insights.files.some((f) => f.path.endsWith("grows\\big.bin")), "a real big file is found");
    const history = readdirSync(join(dataDir, "history", volume.key));
    assert.ok(history.some((f) => f.endsWith(".dirs.dgs")), "older scans are slimmed");
  });
}

async function fastScan() {
  /* In real use the window is in front when Scan is clicked. Behind other windows,
     Windows only flashes the prompt in the taskbar. */
  capture("fast-before");
  await page.click("#scan-button");
  await page.waitFor(`document.querySelector(".lead")?.textContent.includes("确认")`, 5000).catch(() => {});
  await waitForScanToEnd(300000);
}

async function uacAccept() {
  await setScanMode("fast");
  let run;
  await check("a fast scan, after consent, reads the file table", async () => {
    await fastScan();
    run = runs().at(-1);
    assert.equal(run.consent_declined, false);
    assert.ok(run.volumes.every((v) => v.engine === "mft" && v.status === "complete" && v.stored), JSON.stringify(run.volumes));
  });
  await check("it reads what a normal scan cannot, and leaves no helper files behind", async () => {
    const c = history("C").at(-1);
    assert.equal(c.summary.engine, "mft");
    assert.equal(c.summary.elevated, true);
    assert.equal(c.summary.unread_dirs.length, 0);
    assert.deepEqual(readdirSync(join(dataDir, "helper")), []);
  });
  await check("a fast scan is not compared with a normal one", async () => {
    const data = reportData(run);
    const pairs = lib.withComparisons(lib.resolvePairs(data.volumes));
    assert.ok(pairs.every((p) => !p.cmp && p.reason === "engine"));
    assert.equal(lib.headline(pairs).title, "这次无法比较目录变化");
  });
  write("second\\more.bin", 77 * MB);
  await check("a second fast scan reports a known change exactly", async () => {
    await fastScan();
    const second = runs().at(-1);
    assert.notEqual(second.scan_id, run.scan_id);
    const data = reportData(second);
    const volume = scratchVolume(data);
    const [pair] = lib.withComparisons(lib.resolvePairs([volume]));
    assert.ok(pair.cmp, pair.reason);
    assert.equal(pair.cmp.delta[nodeOf(volume, `${scratchRel}\\second`)], 77 * MB);
    assert.deepEqual(readdirSync(join(dataDir, "helper")), []);
  });
}

async function uacDecline() {
  await setScanMode("fast");
  await check("answering no falls back to a normal scan and says so", async () => {
    const before = runs().length;
    await fastScan();
    assert.equal(runs().length, before + 1);
    const run = runs().at(-1);
    assert.equal(run.consent_declined, true);
    assert.ok(run.volumes.every((v) => v.engine === "walk" && v.stored), JSON.stringify(run.volumes));
    assert.match(await lead(), /扫描完成/);
    assert.match(await screen(), /没有获得管理员权限/);
    capture("08-declined");
    const data = reportData(run);
    assert.equal(data.run.consent_declined, true);
    const c = data.volumes.find((v) => v.letter === "C");
    const [pair] = lib.withComparisons(lib.resolvePairs([c]));
    assert.ok(pair.cmp, "compared with the last normal scan, not the fast ones");
    assert.equal(pair.cmp.snapA.engine, "walk");
  });
}

/* Answering the prompt slowly must not make the scan cancel itself. */
async function uacSlow() {
  await setScanMode("fast");
  await check("a slow answer to the prompt still gives a full fast scan", async () => {
    const asked = Date.now();
    await fastScan();
    const waited = (Date.now() - asked) / 1000;
    const run = runs().at(-1);
    assert.equal(run.consent_declined, false, "the answer was no");
    assert.ok(run.volumes.every((v) => v.engine === "mft" && v.status === "complete" && v.stored), JSON.stringify(run.volumes));
    assert.ok(run.seconds < 20, `scan time must not include the wait: ${run.seconds} s`);
    assert.ok(waited > 21, `this only proves something after a 20 s wait; the answer came after ${waited.toFixed(0)} s`);
    console.log(`      answered after about ${waited.toFixed(0)} s; scan time ${run.seconds.toFixed(2)} s`);
  });
}

/* The whole thing as a person meets it: the report opens in their own browser. */
function browserWindowTitles() {
  const script = join(here, "window-titles.ps1");
  return spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Contains", "报告"], { encoding: "utf8" }).stdout;
}

async function browserFlow() {
  await check("a finished scan opens its report in the default browser, by itself", async () => {
    assert.ok(!browserWindowTitles().includes("Diskly 报告"), "close Diskly reports in the browser first");
    await setScanMode("normal");
    await page.click("#scan-button");
    await sleep(500);
    await waitForScanToEnd();
    assert.match(await lead(), /报告已在浏览器中打开/);
    const start = Date.now();
    while (!browserWindowTitles().includes("Diskly 报告")) {
      assert.ok(Date.now() - start < 15000, "no browser window shows the report");
      await sleep(400);
    }
  });
  await check("the report can be opened again from the window", async () => {
    const run = runs().at(-1);
    assert.equal(await page.eval(`window.__TAURI__.core.invoke("open_report", { scanId: ${JSON.stringify(run.scan_id)} }).then(() => true)`), true);
  });
  await check("a report whose file is gone is made again", async () => {
    const run = runs().at(-1);
    rmSync(join(dataDir, "reports", run.report_file));
    assert.equal(await page.eval(`window.__TAURI__.core.invoke("open_report", { scanId: ${JSON.stringify(run.scan_id)} }).then(() => true)`), true);
    const again = runs().at(-1);
    assert.ok(existsSync(join(dataDir, "reports", again.report_file)), again.report_file);
  });
}

/* ---- Run ---- */

try {
  await openApp(phase === "browser" ? { DISKLY_NO_BROWSER: undefined } : {});
  if (phase === "basic") await basic();
  else if (phase === "browser") await browserFlow();
  else if (phase === "uac-accept") await uacAccept();
  else if (phase === "uac-decline") await uacDecline();
  else if (phase === "uac-slow") await uacSlow();
  else throw new Error(`unknown phase: ${phase}`);
} finally {
  page?.close();
  app?.kill();
  removeKnownFiles();
}

const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
