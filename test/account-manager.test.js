import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginSpec, resolveProviderCommand, sanitizeLoginOutput, AccountManager } from "../lib/account-manager.js";

test("loginSpec isolates Codex and Grok while Claude uses its official ambient store", () => {
  const codex = loginSpec("codex", "/profiles/one");
  assert.equal(codex.command, "codex");
  assert.deepEqual(codex.args, ["login"]);
  assert.equal(codex.env.CODEX_HOME, "/profiles/one");
  assert.equal(codex.profileHome, "/profiles/one");
  assert.equal(codex.isolated, true);

  const claude = loginSpec("claude", "/profiles/two");
  assert.deepEqual(claude.args, ["auth", "login", "--claudeai"]);
  assert.deepEqual(claude.env, {});
  assert.match(claude.credentialPath, /\.claude[\\/]\.credentials\.json$/);
  assert.equal(claude.isolated, false);

  const grok = loginSpec("grok", "/profiles/three");
  assert.deepEqual(grok.args, ["login", "--oauth"]);
  assert.deepEqual(grok.env, { GROK_HOME: "/profiles/three" });
  assert.equal(grok.credentialPath, join("/profiles/three", "auth.json"));
  assert.equal(grok.isolated, true);
});

test("AccountManager prepares a managed provider helper before starting browser OAuth", async () => {
  let finishHelper;
  const helperReady = new Promise(resolve => { finishHelper = resolve; });
  const spawned = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-managed-helper-test",
    helperManager: {
      ensure: async (provider, { onProgress }) => {
        assert.equal(provider, "grok");
        onProgress({ message: "Grok公式認証機能を準備しています…" });
        await helperReady;
        return "/managed/helpers/grok";
      }
    },
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      return child;
    },
    mkdir: async () => {},
    access: async () => {},
    readFile: async () => '{"version":1,"accounts":[]}',
    writeFile: async () => {}
  });

  const session = await manager.start("grok");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.get(session.id).status, "preparing");
  assert.match(manager.get(session.id).output, /公式認証機能を準備/);
  assert.equal(spawned.length, 0);

  finishHelper();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawned[0].command, "/managed/helpers/grok");
  assert.deepEqual(spawned[0].args, ["login", "--oauth"]);
  assert.match(spawned[0].options.env.GROK_HOME, /profiles[\\/]grok[\\/]/);
});

test("Claude OAuth completion is verified with the official auth status instead of a credential file", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes = [];
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-claude-oauth-test",
    helperManager: { ensure: async () => "/managed/helpers/claude" },
    spawn: () => child,
    execFile: async (command, args) => {
      assert.equal(command, "/managed/helpers/claude");
      assert.deepEqual(args, ["auth", "status", "--json"]);
      return { stdout: '{"loggedIn":true,"authMethod":"oauth","email":"sales@example.com","subscriptionType":"max"}', stderr: "" };
    },
    mkdir: async () => {},
    access: async () => { throw new Error("credentials are stored in Keychain"); },
    readFile: async path => path.endsWith("provider-metadata.json")
      ? '{"version":1,"providers":{}}'
      : '{"version":1,"accounts":[]}',
    writeFile: async (path, value) => { writes.push({ path, value: JSON.parse(value) }); }
  });

  const session = await manager.start("claude");
  for (let attempt = 0; attempt < 20 && child.listenerCount("close") === 0; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(child.listenerCount("close") > 0, "Claude OAuth child did not become ready");
  child.emit("close", 0);
  for (let attempt = 0; attempt < 20 && manager.get(session.id).status !== "completed"; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(manager.get(session.id).status, "completed");
  const metadataWrite = writes.find(write => write.path.endsWith("provider-metadata.json"));
  assert.equal(metadataWrite.value.providers.claude.email, "sales@example.com");
  assert.equal(metadataWrite.value.providers.claude.plan, "max");
});

test("AccountManager labels managed profile homes without treating ambient CLI auth as removable", async () => {
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-home-metadata-test",
    readFile: async path => path.endsWith("provider-metadata.json")
      ? JSON.stringify({ version: 1, providers: {} })
      : JSON.stringify({
        version: 1,
        accounts: [{ id: "managed-one", provider: "codex", home: "/profiles/managed-one" }]
      })
  });

  const homes = await manager.homes();
  assert.equal(homes.codex[0].managed, false);
  assert.equal(homes.codex[0].connectionId, null);
  assert.deepEqual(homes.codex[1], {
    home: "/profiles/managed-one",
    managed: true,
    connectionId: "managed-one"
  });
});

test("AccountManager disconnect removes only selected managed profiles and rewrites the registry", async () => {
  const removed = [];
  const renamed = [];
  let written;
  const root = join(tmpdir(), "capacity-atlas-disconnect-test");
  const removeHome = join(root, "profiles", "codex", "remove-me");
  const keepHome = join(root, "profiles", "codex", "keep-me");
  const manager = new AccountManager({
    root,
    readFile: async () => JSON.stringify({
      version: 1,
      accounts: [
        { id: "remove-me", provider: "codex", home: removeHome },
        { id: "keep-me", provider: "codex", home: keepHome }
      ]
    }),
    writeFile: async (_path, value) => { written = JSON.parse(value); },
    mkdir: async () => {},
    rename: async (from, to) => { renamed.push([from, to]); },
    rm: async path => { removed.push(path); }
  });

  const result = await manager.disconnect(["remove-me"]);
  assert.deepEqual(result, { removed: 1 });
  assert.equal(renamed[0][0], removeHome);
  assert.match(renamed[0][1], /\.capacity-atlas-disconnect-/);
  assert.deepEqual(removed, [renamed[0][1]]);
  assert.deepEqual(written.accounts.map(account => account.id), ["keep-me"]);
});

test("disconnect never deletes credentials when the registry update fails", async () => {
  const removed = [];
  const renamed = [];
  const root = await mkdtemp(join(tmpdir(), "capacity-atlas-disconnect-failure-"));
  const removeHome = join(root, "profiles", "codex", "remove-me");
  const manager = new AccountManager({
    root,
    readFile: async () => JSON.stringify({
      version: 1,
      accounts: [{ id: "remove-me", provider: "codex", home: removeHome }]
    }),
    writeFile: async () => { throw new Error("disk full"); },
    rename: async (from, to) => { renamed.push([from, to]); },
    rm: async path => { removed.push(path); }
  });

  await assert.rejects(() => manager.disconnect(["remove-me"]), /disk full/);
  assert.deepEqual(removed, []);
  assert.equal(renamed.length, 2, "staged credentials are renamed back after registry failure");
  assert.equal(renamed[0][0], removeHome);
  assert.equal(renamed[1][1], removeHome);
});

test("disconnect records credential cleanup failures for a safe retry", async () => {
  const writes = [];
  const root = await mkdtemp(join(tmpdir(), "capacity-atlas-disconnect-cleanup-"));
  const removeHome = join(root, "profiles", "codex", "remove-me");
  const manager = new AccountManager({
    root,
    readFile: async () => JSON.stringify({
      version: 1,
      accounts: [{ id: "remove-me", provider: "codex", home: removeHome }]
    }),
    writeFile: async (_path, value) => { writes.push(JSON.parse(value)); },
    rename: async () => {},
    rm: async () => { throw new Error("file busy"); }
  });

  const result = await manager.disconnect(["remove-me"]);
  assert.deepEqual(result, { removed: 1, cleanupPending: 1 });
  assert.equal(writes.at(-1).accounts.length, 0);
  assert.equal(writes.at(-1).pendingCleanup.length, 1);
  assert.match(writes.at(-1).pendingCleanup[0].path, /\.capacity-atlas-disconnect-/);
});

test("pending credential cleanup is retried and untrusted paths fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "capacity-atlas-disconnect-retry-"));
  const pendingPath = join(root, "profiles", "codex", "old.capacity-atlas-disconnect-1234");
  const removed = [];
  const writes = [];
  const retryManager = new AccountManager({
    root,
    readFile: async () => JSON.stringify({ version: 1, accounts: [], pendingCleanup: [{ path: pendingPath }] }),
    writeFile: async (_path, value) => { writes.push(JSON.parse(value)); },
    rm: async path => { removed.push(path); }
  });
  assert.deepEqual(await retryManager.disconnect(["already-removed"]), { removed: 0 });
  assert.deepEqual(removed, [pendingPath]);
  assert.deepEqual(writes.at(-1).pendingCleanup, []);

  let unsafeRemoveCalled = false;
  const unsafeManager = new AccountManager({
    root,
    readFile: async () => JSON.stringify({
      version: 1,
      accounts: [],
      pendingCleanup: [{ path: "/tmp/outside.capacity-atlas-disconnect-1234" }]
    }),
    writeFile: async () => {},
    rm: async () => { unsafeRemoveCalled = true; }
  });
  await assert.rejects(() => unsafeManager.disconnect(["already-removed"]), /管理対象外/);
  assert.equal(unsafeRemoveCalled, false);
});

test("concurrent account registrations preserve every connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "capacity-atlas-concurrent-registry-"));
  const manager = new AccountManager({ root });
  await Promise.all([
    manager.register({ id: "one", provider: "codex", home: join(root, "profiles", "codex", "one") }),
    manager.register({ id: "two", provider: "grok", home: join(root, "profiles", "grok", "two") })
  ]);
  const registry = JSON.parse(await readFile(join(root, "accounts.json"), "utf8"));
  assert.deepEqual(registry.accounts.map(account => account.id).sort(), ["one", "two"]);
});

test("a lock left by a terminated Connector is recovered before registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "capacity-atlas-stale-lock-"));
  const lock = join(root, ".accounts.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() }));

  const manager = new AccountManager({ root });
  await manager.register({ id: "recovered", provider: "codex", home: join(root, "profiles", "recovered") });

  const registry = JSON.parse(await readFile(join(root, "accounts.json"), "utf8"));
  assert.deepEqual(registry.accounts.map(account => account.id), ["recovered"]);
});

test("a malformed registry fails closed and is never overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "capacity-atlas-corrupt-registry-"));
  const registryPath = join(root, "accounts.json");
  await writeFile(registryPath, "{not-json", { mode: 0o600 });
  const manager = new AccountManager({ root });
  await assert.rejects(
    () => manager.register({ id: "new", provider: "codex", home: join(root, "profiles", "codex", "new") }),
    /接続情報を安全に読み込めません/
  );
  assert.equal(await readFile(registryPath, "utf8"), "{not-json");
});

test("bundled Codex is preferred so account login works without a system CLI", () => {
  assert.equal(resolveProviderCommand("codex", {
    execPath: "/Applications/Capacity Atlas Connector.app/Contents/Resources/connector",
    platform: "darwin",
    env: {},
    existsSync: path => path.endsWith("/codex")
  }), "/Applications/Capacity Atlas Connector.app/Contents/Resources/codex");
  assert.equal(resolveProviderCommand("codex", {
    execPath: "C:\\Capacity Atlas\\capacity-atlas-connector.exe",
    platform: "win32",
    env: {},
    existsSync: path => path.endsWith("codex.exe")
  }), "C:\\Capacity Atlas\\codex.exe");
});

test("Finder-launched Connector discovers provider CLIs in their official user locations", () => {
  const available = new Set([
    "/Users/test/.local/bin/claude",
    "/Users/test/.grok/bin/grok"
  ]);
  const options = {
    execPath: "/Applications/Capacity Atlas Connector.app/Contents/Resources/connector",
    platform: "darwin",
    home: "/Users/test",
    env: {},
    existsSync: path => available.has(path)
  };
  assert.equal(resolveProviderCommand("claude", options), "/Users/test/.local/bin/claude");
  assert.equal(resolveProviderCommand("grok", options), "/Users/test/.grok/bin/grok");
});

test("login output redacts credential-shaped values", () => {
  const output = sanitizeLoginOutput("\u001b[94mAuthorization: Bearer abcdefghijklmnop\u001b[0m refresh_token=super-secret-token\nOpen https://example.com");
  assert.doesNotMatch(output, /abcdefghijklmnop|super-secret-token|\[94m|\u001b/);
  assert.match(output, /Open https:\/\/example.com/);
});

test("OAuth completion reports a failed session when registry persistence fails", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const manager = new AccountManager({
    root: join(tmpdir(), `capacity-atlas-write-failure-${Date.now()}`),
    spawn: () => child,
    providerHelper: { ensure: async () => "/tmp/codex" },
    mkdir: async () => {},
    access: async () => {},
    readFile: async () => '{"version":1,"accounts":[]}',
    writeFile: async () => { throw new Error("disk full"); }
  });

  const session = await manager.start("codex");
  child.emit("close", 0);
  for (let attempt = 0; attempt < 30 && manager.get(session.id).status !== "failed"; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.equal(manager.get(session.id).status, "failed");
  assert.match(manager.get(session.id).output, /disk full/);
});

test("AccountManager exposes login progress without exposing the child process", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-test",
    spawn: () => child,
    mkdir: async () => {},
    access: async () => {},
    readFile: async () => '{"version":1,"accounts":[]}',
    writeFile: async () => {}
  });
  const session = await manager.start("codex");
  child.stdout.emit("data", Buffer.from("Open https://auth.openai.com and enter ABCD-EFGH\n"));
  const progress = manager.get(session.id);
  assert.equal(progress.provider, "codex");
  assert.equal(progress.status, "waiting");
  assert.match(progress.output, /ABCD-EFGH/);
  assert.equal("child" in progress, false);

  const missing = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
  child.emit("error", missing);
  const failed = manager.get(session.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.output, /認証機能を起動できませんでした/);
  assert.doesNotMatch(failed.output, /ENOENT/);
});

test("cancelling an OAuth session terminates its child process and marks it cancelled", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    child.emit("close", null, signal);
    return true;
  };
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-cancel-login-test",
    spawn: () => child,
    mkdir: async () => {},
    rm: async () => {}
  });

  const session = await manager.start("codex");
  const result = await manager.cancel(session.id);

  assert.equal(result.cancelled, true);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(manager.get(session.id).status, "cancelled");
});

test("an abandoned OAuth session expires and releases its child after the login TTL", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    child.emit("close", null, signal);
    return true;
  };
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-expired-login-test",
    spawn: () => child,
    mkdir: async () => {},
    rm: async () => {},
    loginTimeoutMs: 10
  });

  const session = await manager.start("codex");
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(manager.get(session.id).status, "expired");
  assert.match(manager.get(session.id).output, /時間切れ/);
});

test("starting a second login replaces the active session for the same provider", async () => {
  const children = [0, 1].map(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = signal => {
      child.signals.push(signal);
      child.emit("close", null, signal);
      return true;
    };
    return child;
  });
  let index = 0;
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-single-login-test",
    spawn: () => children[index++],
    mkdir: async () => {},
    rm: async () => {}
  });

  const first = await manager.start("codex");
  const second = await manager.start("codex");

  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  assert.equal(manager.get(first.id).status, "cancelled");
  assert.notEqual(second.id, first.id);
  assert.equal(index, 2);
});

test("concurrent starts still leave only one active login for a provider", async () => {
  const children = [0, 1].map(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = signal => {
      child.signals.push(signal);
      child.emit("close", null, signal);
      return true;
    };
    return child;
  });
  let index = 0;
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-concurrent-login-test",
    spawn: () => children[index++],
    mkdir: async () => { await new Promise(resolve => setImmediate(resolve)); },
    rm: async () => {}
  });

  const sessions = await Promise.all([manager.start("codex"), manager.start("codex")]);
  const active = sessions.filter(session => manager.get(session.id).status !== "cancelled");

  assert.equal(active.length, 1);
  assert.equal(children.filter(child => child.signals.includes("SIGTERM")).length, 1);
});

test("Connector shutdown terminates every active OAuth child", async () => {
  const children = [0, 1].map(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = signal => {
      child.signals.push(signal);
      child.emit("close", null, signal);
      return true;
    };
    return child;
  });
  let index = 0;
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-shutdown-login-test",
    spawn: () => children[index++],
    helperManager: { ensure: async () => "/managed/helpers/grok" },
    mkdir: async () => {},
    rm: async () => {}
  });

  await manager.start("codex");
  const grok = await manager.start("grok");
  for (let attempt = 0; attempt < 20 && manager.get(grok.id).status === "preparing"; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  await manager.shutdown();

  assert.deepEqual(children.map(child => child.signals), [["SIGTERM"], ["SIGTERM"]]);
  assert.equal([...manager.sessions.values()].every(session => session.status === "cancelled"), true);
});

test("cancellation force-kills an OAuth child that ignores SIGTERM", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === "SIGKILL") child.emit("close", null, signal);
    return true;
  };
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-force-kill-test",
    spawn: () => child,
    mkdir: async () => {},
    rm: async () => {},
    killGraceMs: 10
  });

  const session = await manager.start("codex");
  await manager.cancel(session.id);

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(manager.get(session.id).status, "cancelled");
});
