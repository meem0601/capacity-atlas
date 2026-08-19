import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireFileLock,
  CLAUDE_CLIENT_ID,
  CLAUDE_TOKEN_ENDPOINT,
  needsRefresh,
  refreshClaudeToken,
  refreshGrokToken,
  saveToFile,
  saveToKeychain,
  lockedByAnotherProcess
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

test("トークン更新通信はタイムアウトで中断する", async () => {
  const stalledFetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  await assert.rejects(
    () => refreshClaudeToken({ refreshToken: "r" }, { fetch: stalledFetch, timeoutMs: 10 }),
    /タイムアウト/
  );
});

test("トークン更新の巨大なJSON応答を拒否する", async () => {
  await assert.rejects(
    () => refreshClaudeToken(
      { refreshToken: "r" },
      { fetch: async () => new Response("{}", { status: 200, headers: { "content-length": "1048577" } }) }
    ),
    /大きすぎ/
  );
});

test("読み取り上限を適用できないトークン応答は拒否する", async () => {
  await assert.rejects(
    () => refreshClaudeToken(
      { refreshToken: "r" },
      { fetch: async () => ({ ok: true, headers: { get: () => null }, body: {}, json: async () => ({ access_token: "unsafe" }) }) }
    ),
    /安全に読み取れません/
  );
});

test("GrokはOIDCの設定文書からtoken_endpointを引く", async () => {
  const seen = [];
  const refreshed = await refreshGrokToken(
    { key: "old", refresh_token: "r1", oidc_issuer: "https://auth.x.ai/", oidc_client_id: "cid", email: "member@example.com" },
    {
      fetch: async (url, options) => {
        seen.push(url);
        assert.equal(options.redirect, "error", "認証情報を含む通信はredirect先へ追従しない");
        if (url.endsWith("/.well-known/openid-configuration")) {
          return json({ issuer: "https://auth.x.ai", token_endpoint: "https://auth.x.ai/oauth2/token" });
        }
        assert.equal(options.headers["content-type"], "application/x-www-form-urlencoded");
        const form = new URLSearchParams(options.body);
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("client_id"), "cid");
        return json({ access_token: "new", expires_in: 3600 });
      }
    }
  );

  assert.equal(seen[0], "https://auth.x.ai/.well-known/openid-configuration");
  assert.equal(seen[1], "https://auth.x.ai/oauth2/token");
  assert.equal(refreshed.key, "new");
  assert.equal(refreshed.email, "member@example.com", "他の項目は保つ");
  assert.ok(new Date(refreshed.expires_at) > new Date());
});

test("Grokの更新用トークンを未承認issuerへ送信しない", async () => {
  let called = false;
  const refreshed = await refreshGrokToken(
    { key: "old", refresh_token: "secret", oidc_issuer: "http://attacker.example", oidc_client_id: "cid" },
    { fetch: async () => { called = true; return json({}); } }
  );
  assert.equal(refreshed, null);
  assert.equal(called, false);
});

test("Grokの更新用トークンをissuerと異なるtoken_endpointへ送信しない", async () => {
  const seen = [];
  const refreshed = await refreshGrokToken(
    { key: "old", refresh_token: "secret", oidc_issuer: "https://auth.x.ai", oidc_client_id: "cid" },
    { fetch: async url => {
      seen.push(url);
      return json({ issuer: "https://auth.x.ai", token_endpoint: "https://attacker.example/token" });
    } }
  );
  assert.equal(refreshed, null);
  assert.deepEqual(seen, ["https://auth.x.ai/.well-known/openid-configuration"]);
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
      "https://auth.x.ai::cid": { key: "old", refresh_token: "r1", expires_at: "2000-01-01T00:00:00Z", email: "member@example.com" }
    }),
    refreshToken: async () => ({ key: "new", refresh_token: "r2", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
    saveFile: async (path, payload) => { saved.push({ path, payload }); return true; },
    fetch: async () => new Response(Buffer.from([0, 0, 0, 0, 0]), { status: 200 })
  });

  assert.equal(saved.length, 1);
  assert.match(saved[0].path, /auth\.json$/);
  assert.equal(saved[0].payload["https://auth.x.ai::cid"].refresh_token, "r2");
});

test("更新済みClaude認証情報を保存できなければ新トークンを使用しない", async () => {
  let usageRequested = false;
  const account = await collectClaudeAccount({
    home: "/profiles/claude/one",
    readJson: async path => {
      if (path.endsWith(".claude.json")) return { oauthAccount: { emailAddress: "owner@example.com" } };
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    },
    readKeychain: async () => ({ claudeAiOauth: { accessToken: "old", refreshToken: "r1", expiresAt: 1 } }),
    refreshToken: async () => ({ accessToken: "new", refreshToken: "r2", expiresAt: Date.now() + 3_600_000 }),
    saveKeychain: async () => { throw new Error("Keychain write failed"); },
    fetch: async () => { usageRequested = true; return json({ five_hour: { utilization: 10 } }); }
  });
  assert.equal(account.status, "unavailable");
  assert.match(account.message, /Keychain write failed/);
  assert.equal(usageRequested, false);
});

test("更新済みGrok認証情報がロックで保存できなければ新トークンを使用しない", async () => {
  let usageRequested = false;
  const account = await collectGrokAccount({
    home: "/profiles/grok/one",
    readJson: async () => ({
      "https://auth.x.ai::cid": { key: "old", refresh_token: "r1", expires_at: "2000-01-01T00:00:00Z", email: "member@example.com" }
    }),
    refreshToken: async () => ({ key: "new", refresh_token: "r2", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
    saveFile: async () => false,
    fetch: async () => { usageRequested = true; return new Response(Buffer.from([0, 0, 0, 0, 0]), { status: 200 }); }
  });
  assert.equal(account.status, "unavailable");
  assert.match(account.message, /保存/);
  assert.equal(usageRequested, false);
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

// grok CLI は auth.json.lock に "pid:timestamp" を置いて書き込む。
// ロックを無視して上書きすると、CLI が書いた認証情報を潰しうる。
test("保存中は排他的ロックを保持しrename後に解放する", async () => {
  const order = [];
  const written = await saveToFile("/profiles/grok/one/auth.json", { a: 1 }, {
    acquireLock: async () => {
      order.push("acquire");
      return async () => { order.push("release"); };
    },
    writeFile: async () => { order.push("write"); },
    rename: async () => { order.push("rename"); }
  });
  assert.equal(written, true);
  assert.deepEqual(order, ["acquire", "write", "rename", "release"]);
});

test("既存ロックは古く見えても削除せず保存を譲る", async () => {
  let opens = 0;
  let unlinks = 0;
  const exists = () => Object.assign(new Error("exists"), { code: "EEXIST" });
  const release = await acquireFileLock("/profiles/grok/one/auth.json.lock", {
    open: async () => { opens += 1; throw exists(); },
    readFile: async () => "999999:1",
    isAlive: () => false,
    unlink: async () => { unlinks += 1; }
  });
  assert.equal(release, null);
  assert.equal(opens, 1);
  assert.equal(unlinks, 0, "所有権を原子的に証明できない既存ロックは削除しない");
});

test("他プロセスがロックを持っている間は書き込まない", async () => {
  const writes = [];
  const written = await saveToFile("/profiles/grok/one/auth.json", { a: 1 }, {
    acquireLock: async () => null,
    writeFile: async (...args) => { writes.push(args); }
  });

  assert.equal(written, false);
  assert.deepEqual(writes, [], "ロック中は一切書かない");
});

test("ロック所有者が死んでいることは判定できても自動削除しない", async () => {
  const locked = await lockedByAnotherProcess("/profiles/grok/one/auth.json.lock", {
    readFile: async () => "999999:1786966160",
    isAlive: () => false
  });
  assert.equal(locked, false);
});

// 途中まで書かれた認証情報が残ると、ログインし直すまで復帰できない。
test("書いてから rename で差し替える（途中状態を本体に残さない）", async () => {
  const order = [];
  await saveToFile("/profiles/grok/one/auth.json", { a: 1 }, {
    acquireLock: async () => async () => {},
    writeFile: async path => { order.push(`write:${path}`); },
    rename: async (from, to) => { order.push(`rename:${from}→${to}`); }
  });

  assert.match(order[0], /write:\/profiles\/grok\/one\/auth\.json\.\d+\.tmp/, "本体へ直接書かない");
  assert.match(order[1], /rename:.*\.tmp→\/profiles\/grok\/one\/auth\.json$/);
});

test("書き込みに失敗したら一時ファイルを残さない", async () => {
  const removed = [];
  await assert.rejects(() => saveToFile("/profiles/grok/one/auth.json", { a: 1 }, {
    acquireLock: async () => async () => {},
    writeFile: async () => { throw new Error("disk full"); },
    unlink: async path => { removed.push(path); }
  }), /disk full/);

  assert.equal(removed.length, 1);
  assert.match(removed[0], /\.tmp$/);
});
