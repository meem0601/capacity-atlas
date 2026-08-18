import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, connectReturnUrl, safePublicPath } from "../server.js";

// 社内固有の URL は持たない。ブリッジは呼び出し側が明示的に許可する設計。
const APP_ORIGIN = "https://tools.example.com";
const APP_RETURN_URL = `${APP_ORIGIN}/ai`;

const inertAccountManager = () => ({ shutdown: async () => {} });

test("static paths fail closed instead of rewriting traversal outside the public root", () => {
  for (const pathname of ["/../package.json", "/%2e%2e/package.json", "/..\\package.json", "/%00index.html"]) {
    assert.throws(() => safePublicPath(pathname), /Not found/);
  }
  assert.match(safePublicPath("/index.html"), /public[/\\]index\.html$/);
});

test("GET /api/status returns normalized account data", async (t) => {
  const collect = async () => ({
    collectedAt: "2026-08-08T07:00:00Z",
    accounts: [{ id: "1", provider: "codex", status: "healthy", windows: [] }]
  });
  const server = createServer({ collect, refreshMs: 60_000, accountManager: inertAccountManager() });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/status`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const body = await response.json();
  assert.equal(body.accounts[0].provider, "codex");
});

test("the app bridge redirects only to an exactly allowlisted return URL", async (t) => {
  const token = "read-only-capability-token-1234567890";
  const server = createServer({
    collect: async () => ({ accounts: [] }),
    accountManager: inertAccountManager(),
    apiToken: "full-capability-token-1234567890",
    readOnlyToken: token,
    allowedOrigins: new Set([APP_ORIGIN]),
    allowedReturnUrls: new Set([APP_RETURN_URL])
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const accepted = await fetch(`${base}/app-connect?return=${encodeURIComponent("https://tools.example.com/ai")}`, {
    redirect: "manual"
  });
  assert.equal(accepted.status, 302);
  assert.equal(
    accepted.headers.get("location"),
    `https://tools.example.com/ai#capacity-atlas-token=${token}`
  );
  assert.equal(accepted.headers.get("referrer-policy"), "no-referrer");

  const rejected = await fetch(`${base}/app-connect?return=${encodeURIComponent("https://evil.example/data/ai-tools")}`, {
    redirect: "manual"
  });
  assert.equal(rejected.status, 400);
});

test("the app bridge rejects invalid capability token formats", () => {
  const target = APP_RETURN_URL;
  assert.equal(connectReturnUrl(target, "short"), null);
  assert.equal(connectReturnUrl(target, "invalid+token+characters+123456"), null);
});

test("an allowlisted origin can read status with the capability token", async (t) => {
  const token = "read-only-origin-capability-token";
  const server = createServer({
    collect: async () => ({ accounts: [] }),
    accountManager: inertAccountManager(),
    apiToken: "full-capability-token-1234567890",
    readOnlyToken: token,
    allowedOrigins: new Set([APP_ORIGIN]),
    allowedReturnUrls: new Set([APP_RETURN_URL])
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
    headers: {
      origin: "https://tools.example.com",
      "x-capacity-atlas-token": token
    }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://tools.example.com");

  const refreshed = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
    method: "POST",
    headers: {
      origin: "https://tools.example.com",
      "x-capacity-atlas-token": token
    }
  });
  assert.equal(refreshed.status, 200);

  for (const [method, pathname] of [
    ["POST", "/api/accounts"],
    ["POST", "/api/shutdown"],
    ["DELETE", "/api/login/arbitrary-session"]
  ]) {
    const rejected = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        origin: "https://tools.example.com",
        "content-type": "application/json",
        "x-capacity-atlas-token": token
      },
      body: method === "POST" && pathname === "/api/accounts"
        ? JSON.stringify({ provider: "codex" })
        : undefined
    });
    assert.equal(rejected.status, 401, `${method} ${pathname} must reject the read-only token`);
  }
});

test("unknown API routes return JSON 404", async (t) => {
  const server = createServer({ collect: async () => ({ accounts: [] }), accountManager: inertAccountManager() });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/missing`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Not found");
});

test("Connector accepts only allowlisted web origins and private-network preflight", async (t) => {
  const server = createServer({ collect: async () => ({ accounts: [] }), accountManager: inertAccountManager() });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    method: "OPTIONS",
    headers: {
      origin: "https://capacity-atlas.vercel.app",
      "access-control-request-private-network": "true"
    }
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://capacity-atlas.vercel.app");
  assert.equal(response.headers.get("access-control-allow-private-network"), "true");
});

test("Connector rejects a browser origin from an unrelated localhost port", async (t) => {
  const server = createServer({ collect: async () => ({ accounts: [] }), accountManager: inertAccountManager() });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
    headers: { origin: "http://127.0.0.1:9999" }
  });

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Origin not allowed");
});

test("Connector capability token protects account and quota APIs while health stays public", async (t) => {
  const server = createServer({
    collect: async () => ({ accounts: [] }),
    accountManager: inertAccountManager(),
    apiToken: "test-capability-token"
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`, {
    headers: { "x-capacity-atlas-token": "wrong" }
  })).status, 401);
  assert.equal((await fetch(`${base}/api/status`, {
    headers: { "x-capacity-atlas-token": "test-capability-token" }
  })).status, 200);
});

test("DELETE /api/accounts disconnects only managed connections resolved by the server", async (t) => {
  const disconnected = [];
  let collectCount = 0;
  const accountManager = {
    homes: async () => ({ codex: [], claude: [], grok: [] }),
    disconnect: async ids => { disconnected.push(...ids); return { removed: ids.length }; }
  };
  const collect = async () => {
    collectCount += 1;
    return collectCount === 1
      ? { accounts: [{ id: "codex:owner@example.com", managedConnectionIds: ["managed-one", "managed-two"] }] }
      : { accounts: [] };
  };
  const server = createServer({ collect, accountManager });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/accounts/${encodeURIComponent("codex:owner@example.com")}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.deepEqual(disconnected, ["managed-one", "managed-two"]);
  assert.equal((await response.json()).removed, 2);
});

test("POST /api/accounts starts an isolated provider login", async (t) => {
  const starts = [];
  const accountManager = {
    homes: async () => ({ codex: [], claude: [], grok: [] }),
    start: async provider => { starts.push(provider); return { id: "login-1", provider, status: "starting" }; },
    get: id => ({ id, provider: "codex", status: "waiting", output: "Open login page" })
  };
  const server = createServer({ collect: async () => ({ accounts: [] }), accountManager });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "codex" })
  });
  assert.equal(response.status, 202);
  assert.deepEqual(starts, ["codex"]);
  assert.equal((await response.json()).id, "login-1");
});

test("DELETE /api/login/:id cancels an abandoned OAuth session", async (t) => {
  const cancelled = [];
  const accountManager = {
    homes: async () => ({ codex: [], claude: [], grok: [] }),
    cancel: async id => { cancelled.push(id); return { cancelled: true }; }
  };
  const server = createServer({ collect: async () => ({ accounts: [] }), accountManager });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/login/login-1`, { method: "DELETE" });

  assert.equal(response.status, 200);
  assert.deepEqual(cancelled, ["login-1"]);
  assert.deepEqual(await response.json(), { cancelled: true });
});

test("closing the Connector server shuts down active OAuth sessions", async () => {
  let shutdowns = 0;
  const accountManager = {
    homes: async () => ({ codex: [], claude: [], grok: [] }),
    shutdown: async () => { shutdowns += 1; }
  };
  const server = createServer({ collect: async () => ({ accounts: [] }), accountManager });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  server.close();
  await once(server, "close");
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(shutdowns, 1);
});

test("POST /api/shutdown waits for OAuth cleanup before closing the Connector", async (t) => {
  let shutdowns = 0;
  let finishShutdown;
  let responseSettled = false;
  const shutdownGate = new Promise(resolve => { finishShutdown = resolve; });
  const accountManager = {
    homes: async () => ({ codex: [], claude: [], grok: [] }),
    shutdown: async () => { shutdowns += 1; await shutdownGate; }
  };
  const server = createServer({
    collect: async () => ({ accounts: [] }),
    accountManager,
    apiToken: "shutdown-capability-token"
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { if (server.listening) server.close(); });
  const { port } = server.address();

  const closed = once(server, "close");
  const responsePromise = fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: "POST",
    headers: { "x-capacity-atlas-token": "shutdown-capability-token" }
  }).then(response => { responseSettled = true; return response; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(responseSettled, false);
  assert.equal(server.listening, true);

  finishShutdown();
  const response = await responsePromise;
  assert.equal(response.status, 202);
  await closed;
  assert.equal(shutdowns, 1);
});

test("management APIs reject new work while shutdown cleanup is in progress", async (t) => {
  let finishShutdown;
  let starts = 0;
  const shutdownGate = new Promise(resolve => { finishShutdown = resolve; });
  const accountManager = {
    homes: async () => ({ codex: [], claude: [], grok: [] }),
    shutdown: async () => shutdownGate,
    start: async () => { starts += 1; return { id: "unexpected" }; }
  };
  const token = "shutdown-race-capability-token";
  const server = createServer({ collect: async () => ({ accounts: [] }), accountManager, apiToken: token });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { if (server.listening) server.close(); });
  const { port } = server.address();

  const shutdownResponse = fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: "POST",
    headers: { "x-capacity-atlas-token": token }
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  const startResponse = await fetch(`http://127.0.0.1:${port}/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-capacity-atlas-token": token },
    body: JSON.stringify({ provider: "codex" })
  });
  assert.equal(startResponse.status, 503);
  assert.equal(starts, 0);

  finishShutdown();
  assert.equal((await shutdownResponse).status, 202);
});
