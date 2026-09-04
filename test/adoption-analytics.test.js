import test from "node:test";
import assert from "node:assert/strict";
import { initializeAdoptionAnalytics, trackAdoptionEvent } from "../public/adoption-analytics.js";

test("adoption analytics allowlists events and strips account data", () => {
  const calls = [];
  const analytics = (...args) => calls.push(args);

  assert.equal(trackAdoptionEvent("oauth_completed", {
    provider: "claude",
    email: "person@example.com",
    accountId: "private-account",
    remainingPercent: 42,
    message: "secret diagnostic"
  }, analytics), true);
  assert.deepEqual(calls, [["event", {
    name: "oauth_completed",
    data: { provider: "claude" }
  }]]);

  assert.equal(trackAdoptionEvent("arbitrary_event", {}, analytics), false);
  assert.equal(calls.length, 1);
});

test("hosted analytics loads only on the production host and injects once", () => {
  const scripts = [];
  const analyticsWindow = {};
  const document = {
    head: {
      querySelector: selector => scripts.find(script => selector.includes(script.src)) || null,
      appendChild: script => scripts.push(script)
    },
    createElement: () => ({ dataset: {} })
  };

  assert.equal(initializeAdoptionAnalytics({ hostname: "localhost", window: analyticsWindow, document }), false);
  assert.equal(scripts.length, 0);
  assert.equal(initializeAdoptionAnalytics({ hostname: "capacity-atlas.vercel.app", window: analyticsWindow, document }), true);
  assert.equal(typeof analyticsWindow.va, "function");
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, "/_vercel/insights/script.js");
  assert.equal(scripts[0].defer, true);
  assert.equal(initializeAdoptionAnalytics({ hostname: "capacity-atlas.vercel.app", window: analyticsWindow, document }), true);
  assert.equal(scripts.length, 1);
});

test("the local UI relays only allowlisted events to the first-party endpoint", () => {
  const requests = [];
  const analyticsWindow = {
    navigator: { doNotTrack: "0" },
    fetch: (url, options) => {
      requests.push({ url, options });
      return Promise.resolve({ ok: true });
    }
  };

  assert.equal(initializeAdoptionAnalytics({ hostname: "127.0.0.1", window: analyticsWindow }), true);
  trackAdoptionEvent("oauth_completed", { provider: "claude", email: "owner@example.com" }, analyticsWindow.va);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://capacity-atlas.vercel.app/api/adoption-event");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    name: "oauth_completed",
    data: { provider: "claude" }
  });
  assert.equal(requests[0].options.credentials, "omit");
});

test("the local relay respects browser Do Not Track", () => {
  const analyticsWindow = { navigator: { doNotTrack: "1" }, fetch: () => assert.fail("must not send") };
  assert.equal(initializeAdoptionAnalytics({ hostname: "127.0.0.1", window: analyticsWindow }), false);
  assert.equal(analyticsWindow.va, undefined);
});

test("the UI records only the allowlisted adoption funnel milestones", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = new URL("../public/", import.meta.url);
  const [html, client] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("client.js", root), "utf8")
  ]);

  assert.match(client, /initializeAdoptionAnalytics\(\)/);
  for (const event of ["download_clicked", "connector_ready", "oauth_started", "oauth_completed", "oauth_failed", "dashboard_ready"]) {
    assert.match(client, new RegExp(`trackAdoptionEvent\\(\\"${event}\\"`));
  }
  assert.match(html, /data-download-os="macos"[^>]*data-download-location="welcome"/);
  assert.match(html, /data-download-os="windows"[^>]*data-download-location="welcome"/);
  assert.doesNotMatch(client, /trackAdoptionEvent\([^\n]*(email|accountId|remainingPercent|message)/);
});

test("the product discloses limited funnel measurement and infrastructure metadata handling in both languages", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = new URL("../public/", import.meta.url);
  const [html, i18n, readme, security] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("i18n.js", root), "utf8"),
    readFile(new URL("../README.md", root), "utf8"),
    readFile(new URL("../SECURITY.md", root), "utf8")
  ]);

  assert.match(html, /data-i18n="privacy\.analytics"/);
  assert.match(i18n, /"privacy\.analytics": "改善のため/);
  assert.match(i18n, /配信基盤側では通常のアクセス情報/);
  assert.match(i18n, /"privacy\.analytics": "To improve setup/);
  assert.match(i18n, /hosting infrastructure may process standard access metadata/);
  assert.doesNotMatch(i18n, /匿名集計|anonymously count/);
  assert.match(readme, /導入ファネル計測/);
  assert.match(readme, /通常のアクセス情報/);
  assert.match(security, /Adoption analytics/);
  assert.match(security, /standard request metadata/);
});
