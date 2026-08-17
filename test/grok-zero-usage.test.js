import test from "node:test";
import assert from "node:assert/strict";
import { parseGrokBillingResponse } from "../lib/direct-collector.js";

/**
 * 実機で GetGrokCreditsConfig が返したフレームそのもの（2026-08-17）。
 * まだ一度も使っていないアカウントの応答で、creditUsagePercent が入っていない。
 * proto3 は既定値を送らないため 0% は欠落として届く。
 * 請求サイクル（1.4 開始 / 1.5 終了）は入っているので、メッセージ自体は正しい。
 */
const ZERO_USAGE_FRAME = Buffer.from(
  "000000004" + "80a4612001a00220c08cf81f5d30610d8dfdcb5032a0c08cff699d40610d8dfdcb503" +
  "421e0802120c08cf81f5d30610d8dfdcb5031a0c08cff699d40610d8dfdcb50358016200680 1".replace(/ /g, ""),
  "hex"
);

test("使用率が欠落した応答は 0% として扱う（解析失敗にしない）", () => {
  const parsed = parseGrokBillingResponse(ZERO_USAGE_FRAME, new Date("2026-08-17T11:30:00Z"));

  assert.equal(parsed.usedPercent, 0);
  // 請求サイクルの終わりがリセット時刻として取れている
  assert.equal(parsed.resetsAt, "2026-08-20T03:58:07.000Z");
});

test("本当に解釈できない応答は従来どおり失敗させる", () => {
  assert.throws(() => parseGrokBillingResponse(Buffer.alloc(0)), /解析できませんでした/);
});

test("使用率が入っていればその値を使う", () => {
  // 1.1 に fixed32(float) 42.5 を持たせた最小メッセージ
  const body = Buffer.concat([
    Buffer.from([0x0a, 0x07, 0x0d]),
    (() => { const b = Buffer.alloc(4); b.writeFloatLE(42.5); return b })(),
    Buffer.from([0x10, 0x01]),
  ]);
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 0, body.length]), body]);

  assert.equal(parseGrokBillingResponse(frame).usedPercent, 42.5);
});
