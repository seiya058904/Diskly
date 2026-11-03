// Screenshots of one report page, scrolled to each part of it, to look at.
// Usage: node look.mjs <page.html> <out folder> <theme> <width> <height> [selector ...]
// Each selector is scrolled to the top of the window first. "top" is the page as it opens.

import { join } from "node:path";
import { fileUrl, launchBrowser } from "./cdp.mjs";

const [file, out, theme, width, height, ...wanted] = process.argv.slice(2);
const { page, stop } = await launchBrowser(join(out, "tmp"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await page.viewport(Number(width), Number(height));
  await page.media({ colorScheme: theme, reducedMotion: "reduce" });
  await page.goto(fileUrl(file));
  await page.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await sleep(250);
  for (const selector of wanted) {
    await page.eval(`(() => {
      if (${JSON.stringify(selector)} === "top") { window.scrollTo(0, 0); return; }
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 64);
    })()`);
    await sleep(350);
    const name = selector.replace(/[^a-z0-9-]/gi, "") || "top";
    await page.screenshot(join(out, `${theme}-${width}-${name}.png`));
  }
  const errors = page.consoleErrors.length ? ` ERRORS: ${JSON.stringify(page.consoleErrors)}` : "";
  const over = await page.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  console.log(`overflow=${over}${errors}`);
} finally {
  stop();
}
