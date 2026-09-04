import test from "node:test";
import assert from "node:assert/strict";
import { buildSetupDiagnostic, detectPlatform } from "../public/setup-diagnostic.js";

test("setup diagnostics classify supported platforms without preserving raw user-agent data", () => {
  assert.equal(detectPlatform({ userAgentData: { platform: "macOS" } }), "macos");
  assert.equal(detectPlatform({ platform: "Win32" }), "windows");
  assert.equal(detectPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "other");
});

test("setup diagnostics contain only non-sensitive support fields", () => {
  const report = buildSetupDiagnostic({
    navigator: {
      platform: "MacIntel",
      userAgent: "email=owner@example.com token=secret remaining=42"
    },
    connectorStatus: "outdated",
    locale: "ja"
  });

  assert.match(report, /Capacity Atlas Setup Diagnostic/);
  assert.match(report, /App: 0\.9\.3/);
  assert.match(report, /OS: macOS/);
  assert.match(report, /Connector: 更新が必要/);
  assert.match(report, /認証情報・アカウント情報・利用枠・エラー本文は含まれていません/);
  assert.doesNotMatch(report, /owner@example\.com|secret|remaining=42|MacIntel/);
});

test("the UI exposes a copyable setup diagnostic", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = new URL("../public/", import.meta.url);
  const [html, client, i18n] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("client.js", root), "utf8"),
    readFile(new URL("i18n.js", root), "utf8")
  ]);

  assert.match(html, /id="copySetupDiagnostic"/);
  assert.match(client, /buildSetupDiagnostic/);
  assert.match(client, /navigator\.clipboard\.writeText\(report\)/);
  assert.match(i18n, /"diagnostic\.copy": "導入診断をコピー"/);
  assert.match(i18n, /"diagnostic\.copy": "Copy setup diagnostic"/);
});
