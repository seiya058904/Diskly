// Takes screenshots of demo report pages, to look at.
// Usage: node shots.mjs <folder with <scenario>.html> <out folder> [scenario[:theme[:width]] ...]

import { join } from "node:path";
import { fileUrl, launchBrowser } from "./cdp.mjs";

const [pages, out, ...wanted] = process.argv.slice(2);
const { page, stop } = await launchBrowser(join(out, "tmp"));
try {
  for (const item of wanted) {
    const [scenario, theme = "light", width = "1280"] = item.split(":");
    await page.viewport(Number(width), 900);
    await page.media({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto(fileUrl(join(pages, `${scenario}.html`)));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await page.screenshot(join(out, `${scenario}-${theme}-${width}.png`), { fullPage: true });
    const errors = page.consoleErrors.length ? ` ERRORS: ${JSON.stringify(page.consoleErrors)}` : "";
    const overflow = await page.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    console.log(`${item} overflow=${overflow}${errors}`);
  }
} finally {
  stop();
}
