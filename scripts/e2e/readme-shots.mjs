// Makes the pictures in the README. The launcher is the real window. The report
// is the real page with made-up data, so no real paths end up in a public repository.
// Usage: node readme-shots.mjs <diskly.exe> <folder with demo pages> <work folder> [--report-only]
// The window is found by its title, so close any other Diskly first, or use --report-only.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectToPage, fileUrl, launchBrowser } from "./cdp.mjs";

const [exe, pages, work, only] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const images = resolve(here, "..", "..", "docs", "images");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(images, { recursive: true });

/* ---- The report ---- */

const { page: browser, stop } = await launchBrowser(join(work, "browser"));
try {
  await browser.viewport(1280, 860, 1.5);
  await browser.media({ colorScheme: "dark", reducedMotion: "reduce" });
  await browser.goto(fileUrl(join(pages, "normal.html")));
  await sleep(300);
  await browser.screenshot(join(images, "report-dark.png"));
  await browser.click('.segments[aria-label="选择磁盘"] button:nth-child(2)');
  await sleep(300);
  for (const [selector, name] of [["#folders", "report-map"], ["#largest", "report-files"], ["#history", "report-trend"]]) {
    await browser.eval(`window.scrollTo(0, document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top + scrollY - 64)`);
    await sleep(400);
    await browser.screenshot(join(images, `${name}.png`));
  }
} finally {
  stop();
}

/* ---- The launcher ---- */

function capture(name) {
  spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "capture-window.ps1"), "-Title", "Diskly", "-Out", join(images, `${name}.png`)]);
}

async function withApp(theme, run) {
  const dataDir = join(work, "readme-app", theme, "Diskly", "Data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ scan_mode: "normal", theme }));
  const app = spawn(exe, [], {
    stdio: "ignore",
    env: { ...process.env, DISKLY_DATA_DIR: dataDir, DISKLY_NO_BROWSER: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9333" },
  });
  const page = await connectToPage(9333, 30000, (t) => t.url.includes("tauri.localhost"));
  await page.waitFor(`document.getElementById("scan-button")`);
  await sleep(500);
  try {
    await run(page);
  } finally {
    page.close();
    app.kill();
    await sleep(1200);
  }
}

if (only !== "--report-only") {
  await withApp("dark", async (page) => {
    capture("launcher-home");
    await page.click("#scan-button");
    await page.waitFor(`document.querySelector(".disk-note")`);
    await sleep(900);
    capture("launcher-scanning");
    await page.waitFor(`!document.getElementById("scan-button").classList.contains("quiet")`, 120000);
    await page.eval(`[...document.querySelectorAll(".text-button")].find((b) => b.textContent === "设置").click()`);
    await sleep(700);
    capture("launcher-settings");
  });
}
