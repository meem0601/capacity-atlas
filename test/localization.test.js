import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/client.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

test("primary navigation and controls are Japanese", () => {
  for (const phrase of ["容量一覧", "サマリー", "接続状況", "更新", "アカウントを追加"]) {
    assert.match(html, new RegExp(phrase));
  }
  for (const phrase of [">Overview<", ">Accounts<", ">Activity<", ">Refresh now<", ">Credentials stay local<"]) {
    assert.doesNotMatch(html, new RegExp(phrase));
  }
});

test("dynamic capacity and status labels are Japanese", () => {
  for (const phrase of ["再認証が必要", "取得エラー", "残り", "更新済み", "Connector接続済み", "Connector未接続", "接続を再確認", "コードをコピーしてOpenAIを開く", "この画面に戻る", "利用枠の取得が混み合っています"]) {
    assert.match(i18n, new RegExp(phrase));
  }
  assert.match(client, /t\("status\.auth_required"\)/);
  assert.match(client, /t\("account\.updated"/);
});

test("authenticated Claude is distinguished from quota availability", () => {
  assert.match(i18n, /"status\.connected": "接続済み"/);
  assert.match(i18n, /"account\.collecting": "接続済み・残容量を取得中"/);
  assert.match(client, /t\("account\.collecting"\)/);
});

test("account setup modal is present and accessible", () => {
  assert.match(html, /id="addAccountButton"/);
  assert.match(html, /id="accountSetupDialog"/);
  assert.match(html, /aria-labelledby="setupDialogTitle"/);
  assert.match(html, /id="connectAccountButton"/);
  assert.match(html, /id="connectorBanner"/);
  assert.match(html, /id="loginOutput"/);
});

test("outdated Connector is blocked with an explicit update message", () => {
  assert.match(client, /connectorIsCompatible/);
  assert.match(i18n, /"setup\.outdatedTitle": "Connectorの更新が必要です"/);
  assert.match(i18n, /最新のConnectorへ置き換えてください/);
  assert.match(client, /state\.connectorOutdated \? t\("setup\.update"\) : guide\.actionLabel/);
});
