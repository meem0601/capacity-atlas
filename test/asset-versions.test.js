import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const VERSIONED = ["../public/index.html", "../public/client.js"];

/**
 * 静的アセットは ?v=<version> でキャッシュを区切っている。
 * リリースで上げ忘れると、ブラウザは同じURLの古いファイルを使い続け、
 * デプロイしたのに修正が届かない（しかも本人の画面では直って見えることがある）。
 * 実際 0.8.0 → 0.8.1 → 0.9.0 の間ずっと ?v=0.8.0 のまま据え置かれていた。
 */
test("asset cache-busting pins match the released version", () => {
  const version = JSON.parse(read("../package.json")).version;
  const stale = [];

  for (const path of VERSIONED) {
    const source = read(path);
    for (const [, pinned] of source.matchAll(/\?v=([0-9]+\.[0-9]+\.[0-9]+)/g)) {
      if (pinned !== version) stale.push(`${path}: ?v=${pinned} (package.json is ${version})`);
    }
  }

  assert.deepEqual(stale, [], `bump these pins when releasing:\n${stale.join("\n")}`);
});

test("every module and stylesheet request carries a version pin", () => {
  const html = read("../public/index.html");
  const unpinned = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)]
    .map(match => match[1])
    .filter(url => !url.includes("?v="));

  assert.deepEqual(unpinned, [], `these assets would be served from a stale cache:\n${unpinned.join("\n")}`);
});
