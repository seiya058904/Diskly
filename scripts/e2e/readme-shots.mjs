// Makes the pictures in the README. The launcher is the real window. The report
// is the real page with made-up data, so no real paths end up in a public repository.
// Usage: node readme-shots.mjs <diskly.exe> <folder with demo pages> <work folder>

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectToPage, fileUrl, launchBrowser } from "./cdp.mjs";

const [exe, pages, work] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const images = resolve(here, "..", "..", "docs", "images");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(images, { recursive: true });

/* ---- The report ---- */

const { page: browser, stop } = await launchBrowser(join(work, "browser"));
try {
  await browser.viewport(1280, 1000, 1.5);
  for (const theme of ["light", "dark"]) {
    await browser.media({ colorScheme: theme, reducedMotion: "reduce" });
    await browser.goto(fileUrl(join(pages, "normal.html")));
    await sleep(200);
    await browser.screenshot(join(images, `report-${theme}.png`));
  }
  await browser.media({ colorScheme: "light", reducedMotion: "reduce" });
  await browser.goto(fileUrl(join(pages, "normal.html")));
  await browser.click("#open-ai");
  await sleep(250);
  await browser.screenshot(join(images, "report-ai.png"));
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
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ scan_mode: "normal", theme, keep_per_volume: 20 }));
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

await withApp("light", async () => capture("launcher-light"));
await withApp("dark", async (page) => {
  await page.click("#scan-button");
  await page.waitFor(`document.querySelector(".disk-note")`);
  await sleep(900);
  capture("launcher-scanning");
  await page.waitFor(`!document.getElementById("scan-button").classList.contains("quiet")`, 120000);
});
