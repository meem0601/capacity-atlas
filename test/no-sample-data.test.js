import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const clientPath = new URL("../public/client.js", import.meta.url);
const htmlPath = new URL("../public/index.html", import.meta.url);
const i18nPath = new URL("../public/i18n.js", import.meta.url);
const demoPath = new URL("../public/demo-data.json", import.meta.url);

test("disconnected mode never loads or labels sample accounts", async () => {
  const [client, html, i18n] = await Promise.all([readFile(clientPath, "utf8"), readFile(htmlPath, "utf8"), readFile(i18nPath, "utf8")]);
  assert.doesNotMatch(client, /demo-data\.json|サンプルデータ|プレビュー表示/);
  assert.match(client, /accounts:\s*\[\]/);
  assert.match(i18n, /"account\.empty\.title": "アカウントは0件です"/);
  assert.match(i18n, /"refresh\.afterConnector": "Connector接続後に更新"/);
  assert.match(client, /t\("account\.empty\.title"\)/);
  assert.match(html, /接続を確認中/);
  assert.doesNotMatch(html, /primary@example\.com|backup@example\.com|creative@example\.com/);
  await assert.rejects(access(demoPath));
});
