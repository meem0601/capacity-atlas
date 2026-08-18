import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_CLIENT_ID,
  CLAUDE_TOKEN_ENDPOINT,
  needsRefresh,
  refreshClaudeToken,
  refreshGrokToken,
  saveToKeychain
} from "../lib/token-refresh.js";
import { collectClaudeAccount, collectGrokAccount } from "../lib/direct-collector.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

test("期限の手前で更新する（ちょうど期限だと取得中に切れる）", () => {
  const now = 1_800_000_000_000;
  assert.equal(needsRefresh(now + 60 * 60_000, now), false);
  assert.equal(needsRefresh(now + 60_000, now), true, "5分を切ったら更新する");
  assert.equal(needsRefresh(now - 1, now), true);
  assert.equal(needsRefresh(0, now), true);
  assert.equal(needsRefresh(undefined, now), true);
});

test("Claudeは refresh_token グラントで取り直す", async () => {
  const calls = [];
  const refreshed = await refreshClaudeToken(
    { accessToken: "old", refreshToken: "r1", subscriptionType: "max" },
    {
      now: () => 1_000_000,
      fetch: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return json({ access_token: "new", refresh_token: "r2", expires_in: 3600 });
      }
    }
  );

  assert.equal(calls[0].url, CLAUDE_TOKEN_ENDPOINT);
  assert.deepEqual(calls[0].body, {
    grant_type: "refresh_token",
    refresh_token: "r1",
    client_id: CLAUDE_CLIENT_ID
  });
  assert.equal(refreshed.accessToken, "new");
  assert.equal(refreshed.refreshToken, "r2");
  assert.equal(refreshed.expiresAt, 1_000_000 + 3_600_000);
  assert.equal(refreshed.subscriptionType, "max", "他の項目は保つ");
});

test("Claudeの応答が更新用トークンを返さなければ既存を使い続ける", async () => {
  const refreshed = await refreshClaudeToken(
    { accessToken: "old", refreshToken: "keep-me" },
    { now: () => 0, fetch: async () => json({ access_token: "new", expires_in: 60 }) }
  );
  assert.equal(refreshed.refreshToken, "keep-me");
});

test("更新に失敗したら null を返す（呼び出し側は従来どおり落ちる）", async () => {
  assert.equal(await refreshClaudeToken({ refreshToken: "r" }, { fetch: async () => json({ error: "invalid_client" }, 400) }), null);
  assert.equal(await refreshClaudeToken({ accessToken: "x" }, { fetch: async () => json({}) }), null, "更新用トークンが無ければ何もしない");
});

test("GrokはOIDCの設定文書からtoken_endpointを引く", async () => {
  const seen = [];
  const refreshed = await refreshGrokToken(
    { key: "old", refresh_token: "r1", oidc_issuer: "https://auth.example.com/", oidc_client_id: "cid", email: "member@example.com" },
    {
      fetch: async (url, options) => {
        seen.push(url);
        if (url.endsWith("/.well-known/openid-configuration")) {
          return json({ token_endpoint: "https://auth.example.com/oauth2/token" });
        }
        assert.equal(options.headers["content-type"], "application/x-www-form-urlencoded");
        const form = new URLSearchParams(options.body);
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("client_id"), "cid");
        return json({ access_token: "new", expires_in: 3600 });
      }
    }
  );

  assert.equal(seen[0], "https://auth.example.com/.well-known/openid-configuration");
  assert.equal(seen[1], "https://auth.example.com/oauth2/token");
  assert.equal(refreshed.key, "new");
  assert.equal(refreshed.email, "member@example.com", "他の項目は保つ");
  assert.ok(new Date(refreshed.expires_at) > new Date());
});

// 更新できても保存しないと、ローテーションする提供元では次回が失敗する。
test("Claudeは更新したら同じ保管先へ書き戻す", async () => {
  const saved = [];
  await collectClaudeAccount({
    home: "/profiles/claude/one",
    readJson: async path => {
      if (path.endsWith(".claude.json")) return { oauthAccount: { emailAddress: "owner@example.com" } };
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    },
    readKeychain: async () => ({ claudeAiOauth: { accessToken: "old", refreshToken: "r1", expiresAt: 1 } }),
    refreshToken: async () => ({ accessToken: "new", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 }),
    saveKeychain: async (service, payload) => { saved.push({ service, payload }); },
    saveFile: async () => { throw new Error("Keychain 由来ならファイルへは書かない"); },
    fetch: async () => json({ five_hour: { utilization: 10 } })
  });

  assert.equal(saved.length, 1);
  assert.match(saved[0].service, /^Claude Code-credentials-/);
  assert.equal(saved[0].payload.claudeAiOauth.refreshToken, "r2");
});

test("Grokは更新したら auth.json を書き戻す", async () => {
  const saved = [];
  await collectGrokAccount({
    home: "/profiles/grok/one",
    readJson: async () => ({
      "https://auth.example.com::cid": { key: "old", refresh_token: "r1", expires_at: "2000-01-01T00:00:00Z", email: "member@example.com" }
    }),
    refreshToken: async () => ({ key: "new", refresh_token: "r2", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
    saveFile: async (path, payload) => { saved.push({ path, payload }); },
    fetch: async () => new Response(Buffer.from([0, 0, 0, 0, 0]), { status: 200 })
  });

  assert.equal(saved.length, 1);
  assert.match(saved[0].path, /auth\.json$/);
  assert.equal(saved[0].payload["https://auth.example.com::cid"].refresh_token, "r2");
});

test("Keychainへの保存は追加ではなく上書きにする", async () => {
  const calls = [];
  await saveToKeychain("Test-service", { a: 1 }, {
    username: "tester",
    execFile: async (command, args) => { calls.push({ command, args }); return { stdout: "" }; }
  });

  assert.equal(calls[0].command, "/usr/bin/security");
  assert.ok(calls[0].args.includes("-U"), "-U が無いと同名項目が増え続ける");
  assert.equal(calls[0].args.at(-1), JSON.stringify({ a: 1 }));
});
