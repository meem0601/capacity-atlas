import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/client.js", import.meta.url), "utf8");

test("locale helpers normalize browser locales and fall back safely", async () => {
  const { normalizeLocale } = await import("../public/i18n.js");
  assert.equal(normalizeLocale("ja-JP"), "ja");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("fr-FR"), "en");
  assert.equal(normalizeLocale(null), "en");
});

test("English translations cover static, dynamic, and interpolated capacity labels", async () => {
  const { translate } = await import("../public/i18n.js");
  assert.equal(translate("nav.capacity", {}, "en"), "Capacity");
  assert.equal(translate("account.add", {}, "en"), "Add account");
  assert.equal(translate("status.auth_required", {}, "en"), "Reconnect required");
  assert.equal(translate("summary.services", { count: 3 }, "en"), "3 services");
  assert.equal(translate("reset.daysHours", { days: 2, hours: 4 }, "en"), "Resets in 2d 4h");
  assert.equal(translate("summary.services", { count: 1 }, "en"), "1 service");
});

test("Japanese and English dictionaries expose exactly the same keys", async () => {
  const { MESSAGES } = await import("../public/i18n.js");
  assert.deepEqual(Object.keys(MESSAGES.ja).sort(), Object.keys(MESSAGES.en).sort());
});

test("every translation key referenced by the UI exists in both dictionaries", async () => {
  const { MESSAGES } = await import("../public/i18n.js");
  const sources = [
    readFileSync(new URL("../public/client.js", import.meta.url), "utf8"),
    readFileSync(new URL("../public/index.html", import.meta.url), "utf8")
  ];
  const used = new Set();
  for (const source of sources) {
    for (const pattern of [/\bt\("([^"]+)"/g, /data-i18n(?:-aria)?="([^"]+)"/g]) {
      for (const match of source.matchAll(pattern)) used.add(match[1]);
    }
  }
  const missing = [...used].filter(key => !(key in MESSAGES.ja) || !(key in MESSAGES.en));
  assert.deepEqual(missing, []);
});

test("every user-visible initial placeholder has a locale hook", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  for (const [id, key] of [
    ["lastSyncTop", "sync.checking"],
    ["connectionStateLabel", "connection.checking"],
    ["nextRefreshLabel", "refresh.seconds"],
    ["providerCount", "summary.providerPlaceholder"],
    ["dataMode", "summary.dataChecking"],
    ["connectorTitle", "connector.checking"],
    ["connectorDetail", "connector.connecting"],
    ["setupCapability", "setup.multiple"],
    ["connectAccountButton", "setup.connectOpenAI"]
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["'][^>]*data-i18n=["']${key}["']`));
  }
});

test("persisted English is protected from a Japanese first-paint flash", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const bootstrap = readFileSync(new URL("../public/locale-bootstrap.js", import.meta.url), "utf8");
  const client = readFileSync(new URL("../public/client.js", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(html, /<script src="\/locale-bootstrap\.js\?v=0\.8\.0"><\/script>/);
  assert.ok(html.indexOf("locale-bootstrap.js") < html.indexOf("</head>"));
  assert.match(bootstrap, /capacity-atlas-locale/);
  assert.match(bootstrap, /localePending/);
  assert.match(bootstrap, /setTimeout/);
  assert.match(styles, /data-locale-pending/);
  assert.match(client, /delete document\.documentElement\.dataset\.localePending/);
});

test("Japanese remains the complete default translation", async () => {
  const { translate } = await import("../public/i18n.js");
  assert.equal(translate("nav.capacity"), "容量一覧");
  assert.equal(translate("account.add"), "アカウントを追加");
  assert.equal(translate("summary.services", { count: 2 }), "2サービス");
});

test("setup guides and login feedback are available in both languages", async () => {
  const { setupGuide, loginOpenedLabel } = await import("../public/setup-model.js");
  assert.match(setupGuide("codex", "ja").steps.join(" "), /公式ログイン画面/);
  assert.match(setupGuide("codex", "en").steps.join(" "), /official OpenAI sign-in page/i);
  assert.equal(loginOpenedLabel("claude", "en"), "Opened the Claude sign-in page");
});

test("provider filters expose only providers present in real account data", async () => {
  const { visibleProviders } = await import("../public/model.js");
  assert.deepEqual(visibleProviders([]), []);
  assert.deepEqual(visibleProviders([
    { provider: "claude" },
    { provider: "codex" },
    { provider: "claude" },
    { provider: "unknown" }
  ]), ["codex", "claude"]);
});

test("the application exposes an accessible persisted language switch", () => {
  assert.match(html, /id="languageButton"/);
  assert.match(html, /data-i18n="nav\.capacity"/);
  assert.match(client, /capacity-atlas-locale/);
  assert.match(client, /document\.documentElement\.lang/);
  assert.match(client, /applyTranslations/);
});
