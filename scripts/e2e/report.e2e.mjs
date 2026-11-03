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
    for (const scenario of ["normal", "walk-unknown", "hostile", "engines", "first"]) {
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

  await check("the theme follows the system, and can be chosen", async () => {
    await page.viewport(1280, 900);
    await page.media({ colorScheme: "dark" });
    await page.goto(url("normal"));
    const background = () => page.eval(`getComputedStyle(document.documentElement).backgroundColor`);
    assert.equal(await background(), "rgb(0, 0, 0)");
    await page.click('.icon-button');
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), "light");
    assert.equal(await background(), "rgb(242, 242, 247)");
    await page.click('.icon-button');
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), "dark");
    await page.click('.icon-button');
    assert.equal(await page.eval(`document.documentElement.dataset.theme ?? "system"`), "system");
  });

  await check("a report at the size limit stays quick", async () => {
    await openClean("big");
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
