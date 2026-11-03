// A small driver for Chrome and WebView2 over the DevTools protocol, with nothing
// to install: Node 22+ has fetch and WebSocket built in. It exists because the
// report must be tested the way people get it, from a file:// URL in a real browser.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function fileUrl(path) {
  return pathToFileURL(path).href;
}

function findChrome() {
  const candidates = [
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("no Chrome or Edge found");
  return found;
}

/** One connection to one page. */
export class Page {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.consoleErrors = [];
    this.requests = [];
    socket.addEventListener("message", (event) => this.#onMessage(JSON.parse(event.data)));
  }

  static async open(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot connect to ${webSocketUrl}`)), { once: true });
    });
    const page = new Page(socket);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    await page.send("Log.enable");
    page.on("Runtime.exceptionThrown", (p) => page.consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
    page.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error") page.consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(" "));
    });
    page.on("Log.entryAdded", (p) => {
      if (p.entry.level === "error") page.consoleErrors.push(p.entry.text);
    });
    page.on("Network.requestWillBeSent", (p) => page.requests.push(p.request.url));
    return page;
  }

  #onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
      else resolve(message.result);
      return;
    }
    for (const handler of this.handlers.get(message.method) || []) handler(message.params);
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async goto(url) {
    this.consoleErrors.length = 0;
    this.requests.length = 0;
    const loaded = new Promise((resolve) => this.on("Page.loadEventFired", resolve));
    await this.send("Page.navigate", { url });
    await loaded;
    await sleep(60);
  }

  /** Evaluate an expression in the page; its promise is awaited. */
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async waitFor(expression, timeout = 15000) {
    const start = Date.now();
    for (;;) {
      if (await this.eval(`Boolean(${expression})`)) return;
      if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${expression}`);
      await sleep(80);
    }
  }

  async click(selector) {
    const found = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.click();
      return true;
    })()`);
    if (!found) throw new Error(`nothing to click: ${selector}`);
    await sleep(40);
  }

  /** A real mouse click, which counts as a user gesture. */
  async realClick(selector) {
    const point = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!point) throw new Error(`nothing to click: ${selector}`);
    const base = { ...point, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    await sleep(40);
  }

  /** A real key press, as opposed to a synthetic event in the page. */
  async press(key, code = key, windowsVirtualKeyCode = 0) {
    const base = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(40);
  }

  async viewport(width, height, deviceScaleFactor = 1) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false });
  }

  async media({ colorScheme, reducedMotion } = {}) {
    const features = [];
    if (colorScheme) features.push({ name: "prefers-color-scheme", value: colorScheme });
    if (reducedMotion) features.push({ name: "prefers-reduced-motion", value: reducedMotion });
    await this.send("Emulation.setEmulatedMedia", { features });
  }

  async screenshot(path, { fullPage = false } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    const result = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
    });
    writeFileSync(path, Buffer.from(result.data, "base64"));
  }

  close() {
    this.socket.close();
  }
}

/** A DevTools endpoint's first page, once it has one. */
export async function connectToPage(port, timeout = 20000, match = () => true) {
  const start = Date.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((t) => t.type === "page" && match(t));
      if (target) return await Page.open(target.webSocketDebuggerUrl);
    } catch {
      /* Not up yet. */
    }
    if (Date.now() - start > timeout) throw new Error(`no page on port ${port}`);
    await sleep(120);
  }
}

/** A headless browser with a throwaway profile, separate from the user's. */
export async function launchBrowser(tempRoot) {
  mkdirSync(tempRoot, { recursive: true });
  const profile = mkdtempSync(join(tempRoot, "profile-"));
  const child = spawn(findChrome(), [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  const start = Date.now();
  while (!existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n")) {
    if (Date.now() - start > 20000) throw new Error("the browser did not start");
    await sleep(80);
  }
  const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
  const page = await connectToPage(port);
  return { page, port, stop: () => child.kill() };
}
