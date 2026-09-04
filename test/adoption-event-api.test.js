import test from "node:test";
import assert from "node:assert/strict";
import { createAdoptionEventHandler } from "../api/adoption-event.js";

function responseRecorder() {
  const headers = {};
  return {
    statusCode: 200,
    body: "",
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(value = "") { this.body = value; }
  };
}

test("adoption endpoint accepts an allowlisted local event and strips unknown fields", async () => {
  const tracked = [];
  const handler = createAdoptionEventHandler({
    track: async (...args) => tracked.push(args)
  });
  const req = {
    method: "POST",
    headers: { origin: "http://127.0.0.1:4174", "content-type": "application/json" },
    body: { name: "oauth_completed", data: { provider: "claude", email: "owner@example.com", message: "secret" } }
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "http://127.0.0.1:4174");
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0][0], "oauth_completed");
  assert.deepEqual(tracked[0][1], { provider: "claude" });
  assert.deepEqual(tracked[0][2], {
    headers: { "user-agent": "CapacityAtlasConnector/0.9.3", "x-forwarded-for": "0.0.0.0" }
  });
});

test("adoption endpoint rejects unknown events, oversized bodies, and unrelated origins", async () => {
  const tracked = [];
  const handler = createAdoptionEventHandler({ track: async (...args) => tracked.push(args) });

  const badEvent = responseRecorder();
  await handler({ method: "POST", headers: { origin: "http://127.0.0.1:4174" }, body: { name: "token_captured", data: {} } }, badEvent);
  assert.equal(badEvent.statusCode, 400);

  const oversized = responseRecorder();
  await handler({
    method: "POST",
    headers: { origin: "http://127.0.0.1:4174" },
    body: { name: "connector_ready", padding: "x".repeat(2100) }
  }, oversized);
  assert.equal(oversized.statusCode, 400);

  const badOrigin = responseRecorder();
  await handler({ method: "POST", headers: { origin: "https://attacker.example" }, body: { name: "connector_ready", data: {} } }, badOrigin);
  assert.equal(badOrigin.statusCode, 403);
  assert.equal(tracked.length, 0);
});

test("adoption endpoint answers local preflight without tracking", async () => {
  const tracked = [];
  const handler = createAdoptionEventHandler({ track: async (...args) => tracked.push(args) });
  const res = responseRecorder();
  await handler({ method: "OPTIONS", headers: { origin: "http://127.0.0.1:4174" } }, res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-methods"], "POST, OPTIONS");
  assert.equal(res.headers["access-control-allow-headers"], "Content-Type");
  assert.equal(tracked.length, 0);
});
