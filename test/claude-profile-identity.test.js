import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeKeychainService, collectClaudeAccount, readClaudeKeychain } from "../lib/direct-collector.js";

const PROFILE = "/Users/tester/.capacity-atlas/profiles/claude/abc";
const suffix = home => createHash("sha256").update(home).digest("hex").slice(0, 8);

// CLAUDE_CONFIG_DIR で分離すると、claude CLI は Keychain のサービス名も
// 設定フォルダごとに分ける。既定名しか見ないと分離アカウントを
// 「認証情報が見つからない」と誤判定し、一覧から丸ごと消える（実機で再現）。
test("keychain service is scoped to the profile home", () => {
  assert.equal(claudeKeychainService(join(homedir(), ".claude")), "Claude Code-credentials");
  assert.equal(claudeKeychainService(), "Claude Code-credentials");
  assert.equal(claudeKeychainService(PROFILE), `Claude Code-credentials-${suffix(PROFILE)}`);
});

test("the keychain lookup asks for the profile-scoped service", async () => {
  const asked = [];
  await readClaudeKeychain({
    home: PROFILE,
    platform: "darwin",
    username: "tester",
    execFile: async (command, args) => {
      asked.push({ command, args });
      return { stdout: '{"claudeAiOauth":{"accessToken":"t"}}' };
    }
  });

  assert.equal(asked.length, 1);
  assert.equal(asked[0].command, "/usr/bin/security");
  assert.ok(asked[0].args.includes(`Claude Code-credentials-${suffix(PROFILE)}`));
});

// アクセストークンは不透明形式で、メールアドレスも subscriptionType も持たない。
// メールが取れないと契約側と突き合わせられないので、CLI の設定ファイルから拾う。
test("identity comes from the profile config and credentials, not the token", async () => {
  const account = await collectClaudeAccount({
    home: PROFILE,
    readJson: async path => {
      if (path.endsWith(".claude.json")) {
        return { oauthAccount: { emailAddress: "sales@example.com", accountUuid: "uuid-1" } };
      }
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    },
    readKeychain: async () => ({
      claudeAiOauth: {
        accessToken: "opaque-not-a-jwt",
        expiresAt: Date.now() + 3_600_000,
        subscriptionType: "max"
      }
    }),
    // responseBytes は本物のストリームを要求するので Response を使う
    fetch: async () => new Response(JSON.stringify({ five_hour: { utilization: 28 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });

  assert.equal(account.email, "sales@example.com");
  assert.equal(account.plan, "max");
  assert.equal(account.configured, true);
});

test("a profile without a readable credential is reported as unconfigured", async () => {
  const account = await collectClaudeAccount({
    home: PROFILE,
    readJson: async () => { throw Object.assign(new Error("no such file"), { code: "ENOENT" }); },
    readKeychain: async () => { throw new Error("not found"); }
  });

  assert.equal(account.configured, false);
});
