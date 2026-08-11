import test from "node:test";
import assert from "node:assert/strict";
import {
  collectCodexAccount,
  collectClaudeAccount,
  readClaudeKeychain,
  collectGrokAccount,
  collectDirectProviders,
  parseGrokBillingResponse
} from "../lib/direct-collector.js";

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

test("Codex OAuth credentials are collected without CodexBar", async () => {
  const readJson = async () => ({
    tokens: { access_token: "secret", account_id: "acct", id_token: "x.eyJlbWFpbCI6Im93bmVyQGV4YW1wbGUuY29tIn0.x" }
  });
  const fetch = async (_url, options) => {
    assert.equal(options.headers.authorization, "Bearer secret");
    assert.equal(options.headers["chatgpt-account-id"], "acct");
    return jsonResponse(200, {
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 21, reset_at: 1_800_000_000, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 45, reset_at: 1_800_604_800, limit_window_seconds: 604800 }
      }
    });
  };
  const account = await collectCodexAccount({ home: "/profile", readJson, fetch });
  assert.equal(account.provider, "codex");
  assert.equal(account.email, "owner@example.com");
  assert.equal(account.status, "healthy");
  assert.equal(account.windows[0].remainingPercent, 79);
  assert.equal(account.source, "Capacity Atlas Connector");
});

test("a stalled provider request times out instead of blocking Connector status", async () => {
  const account = await collectCodexAccount({
    home: "/profile",
    timeoutMs: 10,
    readJson: async () => ({ tokens: { access_token: "secret" } }),
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })
  });
  assert.equal(account.status, "unavailable");
  assert.match(account.message, /abort|timeout|timed out|タイムアウト/i);
});

test("an oversized provider response is rejected before reading its body", async () => {
  const account = await collectCodexAccount({
    home: "/profile",
    readJson: async () => ({ tokens: { access_token: "secret" } }),
    fetch: async () => new Response("{}", {
      status: 200,
      headers: { "content-length": "2000000", "content-type": "application/json" }
    })
  });
  assert.equal(account.status, "unavailable");
  assert.match(account.message, /大きすぎ/);
});

test("a provider response without a readable stream fails closed", async () => {
  let cancelled = false;
  const account = await collectCodexAccount({
    home: "/profile",
    readJson: async () => ({ tokens: { access_token: "secret" } }),
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { cancel: async () => { cancelled = true; } },
      arrayBuffer: async () => { throw new Error("must not buffer"); },
      text: async () => { throw new Error("must not buffer"); }
    })
  });
  assert.equal(account.status, "unavailable");
  assert.match(account.message, /安全なストリーム/);
  assert.equal(cancelled, true);
});

test("a provider body that cannot create a reader fails closed without leaking its timeout", async () => {
  let cancelled = false;
  const account = await collectCodexAccount({
    home: "/profile",
    timeoutMs: 1_000,
    readJson: async () => ({ tokens: { access_token: "secret" } }),
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => { throw new Error("reader initialization failed"); },
        cancel: async () => { cancelled = true; }
      }
    })
  });
  assert.equal(account.status, "unavailable");
  assert.match(account.message, /reader initialization failed/);
  assert.equal(cancelled, true);
});

test("a failed provider response stream is cancelled and released", async () => {
  let cancelled = false;
  let released = false;
  const account = await collectCodexAccount({
    home: "/profile",
    readJson: async () => ({ tokens: { access_token: "secret" } }),
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({
        read: async () => { throw new Error("stream failed"); },
        cancel: async () => { cancelled = true; },
        releaseLock: () => { released = true; }
      }) }
    })
  });
  assert.equal(account.status, "unavailable");
  assert.match(account.message, /stream failed/);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test("Claude uses the official Keychain credential when the legacy file token is expired", async () => {
  let authorization;
  const account = await collectClaudeAccount({
    home: "/profile",
    now: () => Date.parse("2026-08-10T12:00:00Z"),
    readJson: async () => ({ claudeAiOauth: { accessToken: "expired-file-token", expiresAt: Date.parse("2026-08-07T00:00:00Z") } }),
    readKeychain: async () => ({ claudeAiOauth: { accessToken: "fresh-keychain-token", expiresAt: Date.parse("2026-08-11T00:00:00Z") } }),
    fetch: async (_url, options) => {
      authorization = options.headers.authorization;
      return jsonResponse(200, { five_hour: { utilization: 10, resets_at: "2030-01-01T00:00:00Z" } });
    }
  });
  assert.equal(authorization, "Bearer fresh-keychain-token");
  assert.equal(account.status, "healthy");
  assert.equal(account.windows[0].remainingPercent, 90);
});

test("Claude macOS Keychain lookup is scoped to the current OS user", async () => {
  let invocation;
  const result = await readClaudeKeychain({
    platform: "darwin",
    username: "desktop-user",
    execFile: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: '{"claudeAiOauth":{"accessToken":"secret"}}' };
    }
  });
  assert.equal(invocation.command, "/usr/bin/security");
  assert.deepEqual(invocation.args, ["find-generic-password", "-a", "desktop-user", "-s", "Claude Code-credentials", "-w"]);
  assert.equal(invocation.options.env.CAPACITY_ATLAS_TOKEN, undefined);
  assert.equal(invocation.options.env.CAPACITY_ATLAS_RUNTIME_PATH, undefined);
  assert.equal(result.claudeAiOauth.accessToken, "secret");
});

test("Claude protected-file credential works without Keychain on Windows and Linux-style installs", async () => {
  let keychainCalls = 0;
  const account = await collectClaudeAccount({
    home: "/profile",
    readJson: async () => ({ claudeAiOauth: { accessToken: "protected-file-token", expiresAt: Date.parse("2030-01-01T00:00:00Z") } }),
    readKeychain: async () => { keychainCalls += 1; throw new Error("Keychain must not be used"); },
    fetch: async (_url, options) => {
      assert.equal(options.headers.authorization, "Bearer protected-file-token");
      return jsonResponse(200, { seven_day: { utilization: 20, resets_at: "2030-01-01T00:00:00Z" } });
    }
  });
  assert.equal(keychainCalls, 0);
  assert.equal(account.status, "healthy");
  assert.equal(account.credentialSource, "protected_file");
});

test("Claude quota retries once after a rate limit and keeps the authenticated account", async () => {
  let calls = 0;
  const account = await collectClaudeAccount({
    home: "/profile",
    readJson: async () => ({ claudeAiOauth: { accessToken: "active" } }),
    sleep: async () => {},
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(429, { error: { message: "Rate limited" } })
        : jsonResponse(200, { five_hour: { utilization: 25, resets_at: "2030-01-01T00:00:00Z" } });
    }
  });
  assert.equal(calls, 2);
  assert.equal(account.status, "healthy");
  assert.equal(account.windows[0].remainingPercent, 75);
});

test("Claude remains connected when quota retrieval is still rate limited", async () => {
  const account = await collectClaudeAccount({
    home: "/profile",
    readJson: async () => ({ claudeAiOauth: { accessToken: "active" } }),
    sleep: async () => {},
    fetch: async () => jsonResponse(429, { error: { message: "Rate limited" } })
  });
  assert.equal(account.status, "connected");
  assert.equal(account.authConnected, true);
  assert.equal(account.windows.length, 0);
});

test("Claude unauthorized credentials are surfaced as reconnect required", async () => {
  const readJson = async () => ({ claudeAiOauth: { accessToken: "expired" } });
  const fetch = async () => jsonResponse(401, { error: { message: "expired" } });
  const account = await collectClaudeAccount({ home: "/profile", readJson, fetch });
  assert.equal(account.provider, "claude");
  assert.equal(account.status, "auth_required");
  assert.equal(account.windows.length, 0);
});

function encodeVarint(number) {
  let value = BigInt(number);
  const bytes = [];
  while (value >= 0x80n) {
    bytes.push(Number(value & 0x7fn) | 0x80);
    value >>= 7n;
  }
  bytes.push(Number(value));
  return Buffer.from(bytes);
}

function grokFrame(usedPercent = 12.5, resetAt = 2_000_000_000) {
  const percent = Buffer.alloc(5);
  percent[0] = 0x0d;
  percent.writeFloatLE(usedPercent, 1);
  const resetValue = Buffer.concat([Buffer.from([0x08]), encodeVarint(resetAt)]);
  const nestedReset = Buffer.concat([Buffer.from([0x2a, resetValue.length]), resetValue]);
  const payloadBody = Buffer.concat([percent, nestedReset]);
  const payload = Buffer.concat([Buffer.from([0x0a, payloadBody.length]), payloadBody]);
  const frame = Buffer.alloc(payload.length + 5);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

test("Grok grpc-web protobuf yields used percent and reset time", () => {
  const parsed = parseGrokBillingResponse(grokFrame(), new Date("2025-01-01T00:00:00Z"));
  assert.equal(parsed.usedPercent, 12.5);
  assert.equal(parsed.resetsAt, "2033-05-18T03:33:20.000Z");
});

test("providers with no local credentials are omitted instead of becoming placeholder accounts", async () => {
  const missing = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  const result = await collectDirectProviders({
    homes: { codex: ["/missing/codex"], claude: ["/missing/claude"], grok: ["/missing/grok"] },
    readJson: async () => { throw missing; },
    readKeychain: async () => { throw missing; },
    fetch: async () => { throw new Error("fetch must not run"); }
  });
  assert.deepEqual(result.accounts, []);
});

test("duplicate managed connections for the same provider account collapse into one card", async () => {
  const token = "x.eyJlbWFpbCI6ImR1cGxpY2F0ZUBleGFtcGxlLmNvbSJ9.x";
  const result = await collectDirectProviders({
    homes: {
      codex: [
        { home: "/profiles/one", connectionId: "one", managed: true },
        { home: "/profiles/two", connectionId: "two", managed: true }
      ],
      claude: [],
      grok: []
    },
    readJson: async () => ({ tokens: { access_token: "secret", id_token: token } }),
    fetch: async () => jsonResponse(200, {
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 20, reset_at: 1_800_000_000 } }
    })
  });

  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "duplicate@example.com");
  assert.deepEqual(result.accounts[0].managedConnectionIds.sort(), ["one", "two"]);
  assert.equal(result.accounts[0].duplicateConnections, 2);
});

test("Grok credentials are fetched directly without CodexBar", async () => {
  const readJson = async () => ({ account: { key: "secret", email: "grok@example.com", expires_at: "2035-01-01T00:00:00Z" } });
  const fetch = async (_url, options) => {
    assert.equal(options.headers.authorization, "Bearer secret");
    return new Response(grokFrame(0), { status: 200 });
  };
  const account = await collectGrokAccount({ home: "/profile", readJson, fetch });
  assert.equal(account.provider, "grok");
  assert.equal(account.email, "grok@example.com");
  assert.equal(account.status, "healthy");
});
