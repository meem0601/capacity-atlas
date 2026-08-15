import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const productVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 4180;
const debugPort = 9224;
const origin = `http://127.0.0.1:${port}`;
const output = join(root, "docs", "assets", "dashboard.png");
const now = "2026-08-10T13:30:00.000Z";
const status = {
  accounts: [
    {
      id: "codex-demo-1",
      provider: "codex",
      providerName: "GPT / Codex",
      email: "alex@example.com",
      label: "OpenAI account",
      plan: "plus",
      status: "healthy",
      configured: true,
      source: "Capacity Atlas Connector",
      updatedAt: now,
      windows: [
        { id: "five-hour", title: "5時間", remainingPercent: 82, resetsAt: "2026-08-10T17:00:00.000Z" },
        { id: "weekly", title: "週間", remainingPercent: 68, resetsAt: "2026-08-15T00:00:00.000Z" }
      ]
    },
    {
      id: "claude-demo-1",
      provider: "claude",
      providerName: "Claude",
      email: "maker@example.com",
      label: "Claude account",
      plan: "max",
      status: "healthy",
      configured: true,
      authConnected: true,
      source: "Capacity Atlas Connector",
      updatedAt: now,
      windows: [
        { id: "five-hour", title: "5時間", remainingPercent: 64, resetsAt: "2026-08-10T16:20:00.000Z" },
        { id: "weekly", title: "週間", remainingPercent: 91, resetsAt: "2026-08-16T00:00:00.000Z" }
      ]
    },
    {
      id: "grok-demo-1",
      provider: "grok",
      providerName: "Grok",
      email: "team@example.com",
      label: "Grok account",
      plan: "supergrok",
      status: "healthy",
      configured: true,
      source: "Capacity Atlas Connector",
      updatedAt: now,
      windows: [
        { id: "usage", title: "利用枠", remainingPercent: 76, resetsAt: "2026-08-11T09:00:00.000Z" }
      ]
    }
  ],
  collectedAt: now
};

const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", join(root, "dist")], { stdio: "ignore" });
const profile = `/tmp/capacity-atlas-readme-${process.pid}`;
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  "about:blank"
], { stdio: "ignore" });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
try {
  let targets;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      if (targets.length) break;
    } catch {}
    await sleep(100);
  }
  const target = targets?.find(item => item.type === "page");
  if (!target) throw new Error("Chrome DevTools target not found");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => {
    const requestId = ++id;
    socket.send(JSON.stringify({ id: requestId, method, params }));
    return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
  };
  const consoleErrors = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") consoleErrors.push(message.params.exceptionDetails?.text || "exception");
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") consoleErrors.push(message.params.args?.map(arg => arg.value || arg.description).join(" ") || "console.error");
    if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      const isHealth = request.url.endsWith("/api/health");
      const body = isHealth
        ? { name: "Capacity Atlas Connector", version: productVersion, ready: true, codexBar: false }
        : status;
      send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "application/json; charset=utf-8" },
          { name: "Access-Control-Allow-Origin", value: origin },
          { name: "Access-Control-Allow-Methods", value: "GET, POST, DELETE, OPTIONS" },
          { name: "Access-Control-Allow-Headers", value: "Content-Type" },
          { name: "Access-Control-Allow-Private-Network", value: "true" }
        ],
        body: Buffer.from(JSON.stringify(body)).toString("base64")
      }).catch(() => {});
    }
    if (!message.id || !pending.has(message.id)) return;
    const handler = pending.get(message.id);
    pending.delete(message.id);
    message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result);
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*://127.0.0.1:*/api/*", requestStage: "Request" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${origin}/?demo=readme` });
  await sleep(1800);
  const metrics = await send("Runtime.evaluate", {
    expression: `({cards: document.querySelectorAll('.account-card').length, connector: document.querySelector('#connectionState b')?.textContent, scrollHeight: document.documentElement.scrollHeight})`,
    returnByValue: true
  });
  if (metrics.result.value.cards !== 3) {
    const diagnostic = await send("Runtime.evaluate", { expression: `({body: document.body.innerText.slice(0, 1000), href: location.href})`, returnByValue: true });
    throw new Error(`Expected 3 demo cards, received ${metrics.result.value.cards}; ${JSON.stringify({ ...diagnostic.result.value, consoleErrors })}`);
  }
  await send("Runtime.evaluate", {
    expression: `(() => {
      const badge = document.createElement("div");
      badge.id = "readmeDemoDataBadge";
      badge.textContent = "DEMO DATA";
      badge.setAttribute("aria-label", "Demo data");
      Object.assign(badge.style, {
        position: "fixed",
        top: "78px",
        right: "32px",
        zIndex: "9999",
        padding: "8px 12px",
        border: "1px solid rgba(255,255,255,.24)",
        borderRadius: "999px",
        background: "rgba(9,11,15,.92)",
        color: "#ffffff",
        font: "700 12px/1 system-ui, sans-serif",
        letterSpacing: ".12em",
        boxShadow: "0 8px 24px rgba(0,0,0,.35)"
      });
      document.body.appendChild(badge);
      return badge.textContent;
    })()`,
    returnByValue: true
  });
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    fromSurface: true,
    clip: { x: 0, y: 0, width: 1440, height: Math.min(metrics.result.value.scrollHeight, 1050), scale: 1 }
  });
  await mkdir(join(root, "docs", "assets"), { recursive: true });
  await writeFile(output, Buffer.from(shot.data, "base64"));
  console.log(JSON.stringify({ output, ...metrics.result.value }));
} finally {
  socket?.close();
  chrome.kill("SIGTERM");
  server.kill("SIGTERM");
}
