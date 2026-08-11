import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/client.js", import.meta.url), "utf8");

test("primary navigation and controls are Japanese", () => {
  for (const phrase of ["容量一覧", "サマリー", "接続状況", "更新", "アカウントを追加"]) {
    assert.match(html, new RegExp(phrase));
  }
  for (const phrase of [">Overview<", ">Accounts<", ">Activity<", ">Refresh now<", ">Credentials stay local<"]) {
    assert.doesNotMatch(html, new RegExp(phrase));
  }
});

test("dynamic capacity and status labels are Japanese", () => {
  for (const phrase of ["取得済み", "再接続が必要", "取得できません", "残り", "更新済み", "Connector接続済み", "Connector未接続", "接続を再確認", "コードをコピーしてOpenAIを開く", "この画面に戻る", "利用枠の取得が混み合っています"]) {
    assert.match(client, new RegExp(phrase));
  }
  for (const phrase of ["Authentication required", "Capacity unavailable", "Not available", "Local collector live"]) {
    assert.doesNotMatch(client, new RegExp(phrase));
  }
});

test("authenticated Claude is distinguished from quota availability", () => {
  assert.match(client, /connected:\s*"接続済み"/);
  assert.match(client, /接続済み・残容量を取得中/);
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
  assert.match(client, /Connectorの更新が必要です/);
  assert.match(client, /v0\.7\.4へ置き換えてください/);
  assert.match(client, /state\.connectorOutdated \? "Connectorを更新してください" : guide\.actionLabel/);
});
