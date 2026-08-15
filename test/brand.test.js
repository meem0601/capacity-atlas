import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("user-facing product name is Capacity Atlas everywhere", () => {
  const html = read("../public/index.html");
  const setup = read("../public/setup-model.js");
  const readme = read("../README.md");
  const server = read("../server.js");
  const pkg = JSON.parse(read("../package.json"));

  assert.match(html, /Capacity Atlas/);
  assert.match(html, /全アカウント/);
  assert.match(html, /残容量、リセット時刻、認証状態/);
  assert.equal(pkg.name, "capacity-atlas");

  for (const source of [html, setup, readme, server]) {
    assert.doesNotMatch(source, /QuotaDeck|quota-deck/);
  }
});

test("public documentation labels synthetic screenshot accounts as demo data", () => {
  const readme = read("../README.md");
  const readmeEnglish = read("../README.en.md");
  const screenshotScript = read("../scripts/readme-screenshot.mjs");

  assert.match(readme, /デモデータ/);
  assert.match(readmeEnglish, /demo data/i);
  assert.match(screenshotScript, /DEMO DATA/);
});
