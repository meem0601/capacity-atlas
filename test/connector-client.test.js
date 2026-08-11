import test from "node:test";
import assert from "node:assert/strict";
import { connectorBase, connectorIsCompatible, createConnectorClient, readConnectorToken } from "../public/connector-client.js";

test("hosted Capacity Atlas uses the local Connector loopback", () => {
  assert.equal(connectorBase({ hostname: "capacity-atlas.vercel.app" }), "http://127.0.0.1:4174");
  assert.equal(connectorBase({ hostname: "127.0.0.1" }), "");
  assert.equal(connectorBase({ hostname: "localhost" }), "");
});

test("protected account management requires Connector v0.7.4 or newer", () => {
  assert.equal(connectorIsCompatible({ ready: true, version: "0.7.3" }), false);
  assert.equal(connectorIsCompatible({ ready: true, version: "0.7.4" }), true);
  assert.equal(connectorIsCompatible({ ready: true, version: "0.8.0" }), true);
  assert.equal(connectorIsCompatible({ ready: true }), false);
  assert.equal(connectorIsCompatible({ ready: false, version: "0.7.4" }), false);
});

test("Connector client reads status and starts account login", async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith("/api/health")) return new Response('{"ready":true}', { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).endsWith("/api/accounts")) return new Response('{"id":"login-1","status":"starting"}', { status: 202, headers: { "content-type": "application/json" } });
    return new Response('{"accounts":[]}', { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = createConnectorClient({ base: "http://127.0.0.1:4174", fetch });
  assert.equal(client.url, "http://127.0.0.1:4174");
  assert.equal(client.authorized, false);
  assert.equal((await client.health()).ready, true);
  assert.equal((await client.startLogin("codex")).id, "login-1");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.body, JSON.stringify({ provider: "codex" }));
});

test("Connector client disconnects an account with an encoded DELETE request", async () => {
  const calls = [];
  const client = createConnectorClient({
    base: "http://127.0.0.1:4174",
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response('{"removed":2}', { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const result = await client.disconnectAccount("codex:owner@example.com");
  assert.equal(result.removed, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:4174/api/accounts/codex%3Aowner%40example.com");
  assert.equal(calls[0].options.method, "DELETE");
});

test("Connector client rejects non-JSON responses", async () => {
  const client = createConnectorClient({
    base: "http://127.0.0.1:4174",
    fetch: async () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } })
  });
  await assert.rejects(client.health(), /Connector/);
});

test("Connector token is captured from the launch URL, stored for the tab, and removed from history", () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value)
  };
  const calls = [];
  const token = readConnectorToken({
    location: { hash: "#token=launch-token_12345678901234567890", pathname: "/", search: "?lang=ja" },
    storage,
    history: { replaceState: (...args) => calls.push(args) }
  });

  assert.equal(token, "launch-token_12345678901234567890");
  assert.equal(storage.getItem("capacity-atlas-token"), token);
  assert.deepEqual(calls, [[null, "", "/?lang=ja"]]);
});

test("Connector client attaches the capability token to API requests", async () => {
  const calls = [];
  const client = createConnectorClient({
    base: "http://127.0.0.1:4174",
    token: "test-capability-token",
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response('{"accounts":[]}', { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  await client.status();
  assert.equal(client.authorized, true);
  assert.equal(calls[0].options.headers["x-capacity-atlas-token"], "test-capability-token");
});

test("Connector client cancels a login session with DELETE", async () => {
  const calls = [];
  const client = createConnectorClient({
    base: "http://127.0.0.1:4174",
    token: "test-capability-token",
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response('{"cancelled":true}', { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.deepEqual(await client.cancelLogin("login one"), { cancelled: true });
  assert.equal(calls[0].url, "http://127.0.0.1:4174/api/login/login%20one");
  assert.equal(calls[0].options.method, "DELETE");
});
