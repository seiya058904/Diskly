// Measures how a report page feels: how soon it is on screen, how evenly it scrolls,
// and how long a click on the map holds up the page. In the headless browser this
// uses, drawing is done in software, so a real screen with a graphics card does better.
// Usage: node smooth.mjs <page.html> <work folder>

import { join } from "node:path";
import { fileUrl, launchBrowser } from "./cdp.mjs";

const [file, work] = process.argv.slice(2);
const { page, stop } = await launchBrowser(join(work, "tmp"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (list, p) => list.slice().sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))];

try {
  await page.viewport(1440, 900);
  await page.media({ colorScheme: "dark", reducedMotion: "no-preference" });
  await page.goto(fileUrl(file));
  const load = await page.eval(`(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = performance.getEntriesByName("first-contentful-paint")[0];
    return { ready: Math.round(nav.domContentLoadedEventEnd), firstPaint: paint ? Math.round(paint.startTime) : null, nodes: document.querySelectorAll("*").length };
  })()`);
  await sleep(1600);

  /* Frames while scrolling all the way down and up again. */
  await page.eval(`(() => {
    window.__frames = [];
    window.__long = 0;
    new PerformanceObserver((list) => { window.__long += list.getEntries().length; }).observe({ entryTypes: ["longtask"] });
    let last = performance.now();
    const tick = (now) => { window.__frames.push(now - last); last = now; window.__raf = requestAnimationFrame(tick); };
    window.__raf = requestAnimationFrame(tick);
  })()`);
  const height = await page.eval("document.documentElement.scrollHeight");
  for (const distance of [-(height - 900), height - 900]) {
    await page.send("Input.synthesizeScrollGesture", { x: 720, y: 450, yDistance: distance, speed: 2400, gestureSourceType: "mouse" });
  }
  const scroll = await page.eval(`(() => { cancelAnimationFrame(window.__raf); return { frames: window.__frames.slice(5), long: window.__long }; })()`);

  /* Flying into a folder on the map, and back. */
  const flight = await page.eval(`(async () => {
    const frames = [];
    let last = performance.now();
    let on = true;
    const tick = (now) => { frames.push(now - last); last = now; if (on) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const start = performance.now();
    document.querySelector(".map-canvas .tile.big").click();
    const sync = performance.now() - start;
    await new Promise((r) => setTimeout(r, 650));
    on = false;
    return { sync, frames };
  })()`);

  console.log(JSON.stringify({
    page_ready_ms: load.ready,
    first_paint_ms: load.firstPaint,
    elements: load.nodes,
    scroll_px: (height - 900) * 2,
    scroll_frames: scroll.frames.length,
    scroll_p50_ms: Number(percentile(scroll.frames, 0.5).toFixed(1)),
    scroll_p95_ms: Number(percentile(scroll.frames, 0.95).toFixed(1)),
    scroll_worst_ms: Number(Math.max(...scroll.frames).toFixed(1)),
    long_tasks_while_scrolling: scroll.long,
    map_click_ms: Number(flight.sync.toFixed(1)),
    flight_p95_ms: Number(percentile(flight.frames, 0.95).toFixed(1)),
    errors: page.consoleErrors.length,
  }));
} finally {
  stop();
}
