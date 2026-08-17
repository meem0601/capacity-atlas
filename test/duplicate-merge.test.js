import test from "node:test";
import assert from "node:assert/strict";
import { collectDirectProviders } from "../lib/direct-collector.js";

const usageResponse = () => new Response(JSON.stringify({ five_hour: { utilization: 30 } }), {
  status: 200,
  headers: { "content-type": "application/json" }
});

/**
 * 同じアカウントが複数プロファイルに登録されていると、期限切れの行と
 * 取得できている行が同時に届く。畳むときに健全な行で「置き換える」のではなく
 * 上書きマージすると、正常なアカウントに期限切れメッセージが残り、
 * 画面が「正常」と「再認証が必要」を同時に言う（実機で発生）。
 */
test("重複を畳むとき、捨てた側のメッセージを持ち越さない", async () => {
  const expiredHome = "/profiles/claude/expired";
  const healthyHome = "/profiles/claude/healthy";

  const snapshot = await collectDirectProviders({
    homes: {
      codex: [],
      grok: [],
      claude: [
        { home: expiredHome, managed: true, connectionId: "expired" },
        { home: healthyHome, managed: true, connectionId: "healthy" }
      ]
    },
    readJson: async path => {
      if (path.endsWith(".claude.json")) return { oauthAccount: { emailAddress: "owner@example.com" } };
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    },
    // 認証情報が「無い」のではなく「あるが失効している」状態にする。
    // 無い場合は configured=false で畳む前に除外され、重複マージを通らない。
    readKeychain: async ({ home }) => ({
      claudeAiOauth: {
        accessToken: home === expiredHome ? "expired-token" : "live-token",
        expiresAt: Date.now() + 3_600_000,
        subscriptionType: "max"
      }
    }),
    fetch: async (_url, options) => (
      options.headers.authorization.includes("expired-token")
        ? new Response('{"error":{"message":"unauthorized"}}', { status: 401 })
        : usageResponse()
    )
  });

  assert.equal(snapshot.accounts.length, 1);
  const [account] = snapshot.accounts;
  assert.equal(account.status, "healthy");
  assert.equal("message" in account, false, `健全なアカウントに古い注意書きが残っている: ${account.message}`);
  assert.equal(account.duplicateConnections, 2);
});
