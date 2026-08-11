import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager, sanitizeLoginOutput } from "../lib/account-manager.js";

function fakeChild(onKill = null) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => {
    onKill?.(signal, child);
    return true;
  };
  return child;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("Connector capability values are stripped from OAuth child environments", async () => {
  const previousToken = process.env.CAPACITY_ATLAS_TOKEN;
  const previousRuntime = process.env.CAPACITY_ATLAS_RUNTIME_PATH;
  process.env.CAPACITY_ATLAS_TOKEN = "super-secret-capability";
  process.env.CAPACITY_ATLAS_RUNTIME_PATH = "/tmp/private-runtime";
  let spawnedEnvironment;
  const child = fakeChild();
  try {
    const manager = new AccountManager({
      root: "/tmp/capacity-atlas-child-env",
      mkdir: async () => {},
      spawn: (_command, _args, options) => { spawnedEnvironment = options.env; return child; }
    });
    await manager.start("codex");
    assert.equal(spawnedEnvironment.CAPACITY_ATLAS_TOKEN, undefined);
    assert.equal(spawnedEnvironment.CAPACITY_ATLAS_RUNTIME_PATH, undefined);
    assert.equal(spawnedEnvironment.CODEX_HOME.includes("/tmp/capacity-atlas-child-env/profiles/codex/"), true);
  } finally {
    if (previousToken === undefined) delete process.env.CAPACITY_ATLAS_TOKEN;
    else process.env.CAPACITY_ATLAS_TOKEN = previousToken;
    if (previousRuntime === undefined) delete process.env.CAPACITY_ATLAS_RUNTIME_PATH;
    else process.env.CAPACITY_ATLAS_RUNTIME_PATH = previousRuntime;
  }
});

test("login output redacts JSON, Bearer, JWT, cookie, client secret, and OAuth URL secrets", () => {
  const raw = [
    '{"access_token":"SECRET_ACCESS_123456789","refresh_token": "SECRET_REFRESH_123456789"}',
    'Authorization: Bearer secret-bearer-value-12345',
    'client_secret=client-secret-value-12345',
    'Cookie: session=secret-cookie-value-12345',
    'https://example.com/callback?code=oauth-code-secret-12345&state=visible',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature1234'
  ].join("\n");
  const sanitized = sanitizeLoginOutput(raw);
  for (const secret of [
    "SECRET_ACCESS_123456789", "SECRET_REFRESH_123456789", "secret-bearer-value-12345",
    "client-secret-value-12345", "secret-cookie-value-12345", "oauth-code-secret-12345", "eyJhbGciOiJIUzI1NiJ9"
  ]) assert.equal(sanitized.includes(secret), false, secret);
  assert.match(sanitized, /\[REDACTED\]/);
  assert.match(sanitized, /state=visible/);
});

test("late helper progress and resolution cannot revive a cancelled session", async () => {
  let onProgress;
  let resolveHelper;
  let spawned = 0;
  const helperGate = new Promise(resolve => { resolveHelper = resolve; });
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-late-helper",
    mkdir: async () => {},
    rm: async () => {},
    helperManager: {
      ensure: async (_provider, options) => {
        onProgress = options.onProgress;
        return helperGate;
      }
    },
    spawn: () => { spawned += 1; return fakeChild(); }
  });

  const session = await manager.start("grok");
  await manager.cancel(session.id);
  onProgress({ message: "late progress" });
  resolveHelper("/tmp/grok");
  await tick();
  assert.equal(spawned, 0);
  assert.equal(manager.get(session.id).status, "cancelled");
});

test("late child output and successful close cannot overwrite cancellation", async () => {
  const child = fakeChild((_signal, current) => {
    current.stdout.emit("data", "late output");
    queueMicrotask(() => current.emit("close", 0));
  });
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-late-output",
    mkdir: async () => {},
    rm: async () => {},
    access: async () => {},
    spawn: () => child
  });
  const session = await manager.start("codex");
  await manager.cancel(session.id);
  assert.equal(manager.get(session.id).status, "cancelled");
  assert.equal(manager.get(session.id).output, "認証をキャンセルしました。");
});

test("shutdown waits for a queued start and prevents it from spawning afterwards", async () => {
  let releaseMkdir;
  let spawned = 0;
  const mkdirGate = new Promise(resolve => { releaseMkdir = resolve; });
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-shutdown-race",
    mkdir: async () => mkdirGate,
    rm: async () => {},
    spawn: () => { spawned += 1; return fakeChild(); }
  });

  const startPromise = manager.start("codex");
  await tick();
  const shutdownPromise = manager.shutdown();
  releaseMkdir();
  await assert.rejects(startPromise, /終了しています/);
  await shutdownPromise;
  await assert.rejects(manager.start("codex"), /終了しています/);
  assert.equal(spawned, 0);
});

test("cancellation during asynchronous authentication verification cannot complete or register", async () => {
  let releaseAccess;
  const accessGate = new Promise(resolve => { releaseAccess = resolve; });
  const child = fakeChild();
  let writes = 0;
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-finish-cancel-race",
    mkdir: async () => {},
    rm: async () => {},
    access: async () => accessGate,
    writeFile: async () => { writes += 1; },
    spawn: () => child
  });

  const session = await manager.start("codex");
  child.emit("close", 0);
  await tick();
  await manager.cancel(session.id);
  releaseAccess();
  await tick();
  await tick();

  assert.equal(manager.get(session.id).status, "cancelled");
  assert.equal(writes, 0);
});

test("shutdown waits for an in-progress managed helper preparation", async () => {
  let releaseHelper;
  const helperGate = new Promise(resolve => { releaseHelper = resolve; });
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-shutdown-helper",
    mkdir: async () => {},
    rm: async () => {},
    helperManager: { ensure: async () => helperGate },
    spawn: () => fakeChild()
  });

  await manager.start("grok");
  let shutdownSettled = false;
  const shutdown = manager.shutdown().then(() => { shutdownSettled = true; });
  await tick();
  assert.equal(shutdownSettled, false);
  releaseHelper("/tmp/grok");
  await shutdown;
});

test("a committed registration wins a simultaneous cancellation without deleting its profile", async () => {
  let releaseRegister;
  let registerStarted;
  const registerGate = new Promise(resolve => { releaseRegister = resolve; });
  const started = new Promise(resolve => { registerStarted = resolve; });
  const removed = [];
  const child = fakeChild();
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-register-cancel",
    mkdir: async () => {},
    rm: async path => { removed.push(path); },
    access: async () => {},
    spawn: () => child
  });
  let registered = false;
  manager.register = async () => {
    registerStarted();
    await registerGate;
    registered = true;
  };
  manager.unregister = async () => { throw new Error("simulated rollback failure"); };

  const session = await manager.start("codex");
  child.emit("close", 0);
  await started;
  const cancellation = manager.cancel(session.id);
  releaseRegister();
  const result = await cancellation;
  await tick();

  assert.equal(registered, true);
  assert.equal(result.cancelled, false);
  assert.equal(manager.get(session.id).status, "completed");
  assert.equal(removed.includes(session.home), false);
});

test("failed isolated-profile cleanup is retained and retried instead of forgotten", async () => {
  const child = fakeChild();
  let removals = 0;
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-cleanup-retry",
    mkdir: async () => {},
    access: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    rm: async () => { removals += 1; throw new Error("busy"); },
    spawn: () => child,
    sessionRetentionMs: 10
  });

  const session = await manager.start("codex");
  child.emit("close", 1);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.ok(removals >= 2);
  assert.equal(manager.get(session.id)?.status, "failed");
});

test("authentication verification requests a hard child-process timeout", async () => {
  const child = fakeChild();
  let verifierKilled = false;
  let invocationOptions;
  const manager = new AccountManager({
    root: "/tmp/capacity-atlas-auth-timeout",
    mkdir: async () => {},
    rm: async () => {},
    execFile: async (_command, _args, options) => {
      invocationOptions = options;
      return new Promise((_resolve, reject) => setTimeout(() => {
        verifierKilled = true;
        reject(Object.assign(new Error("killed"), { killed: true }));
      }, options.timeout));
    },
    helperManager: { ensure: async () => "/tmp/claude" },
    spawn: () => child,
    authenticationTimeoutMs: 10
  });

  const session = await manager.start("claude");
  for (let attempt = 0; attempt < 10 && child.listenerCount("close") === 0; attempt += 1) await tick();
  assert.ok(child.listenerCount("close") > 0);
  child.emit("close", 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(invocationOptions.timeout, 10);
  assert.equal(invocationOptions.killSignal, "SIGKILL");
  assert.equal(verifierKilled, true);
  assert.equal(manager.get(session.id)?.status, "failed");
});

test("a timed-out Claude verifier OS process is gone before the session fails", { skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "capacity-atlas-verifier-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = join(directory, "claude");
  const pidFile = join(directory, "verifier.pid");
  await writeFile(helper, `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(pidFile)}\nwhile :; do sleep 1; done\n`);
  await chmod(helper, 0o755);

  const child = fakeChild();
  const manager = new AccountManager({
    root: join(directory, "state"),
    helperManager: { ensure: async () => helper },
    spawn: () => child,
    authenticationTimeoutMs: 500
  });
  const session = await manager.start("claude");
  for (let attempt = 0; attempt < 100 && child.listenerCount("close") === 0; attempt += 1) await tick();
  assert.ok(child.listenerCount("close") > 0);
  child.emit("close", 0);

  let verifierPid;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { verifierPid = Number(await readFile(pidFile, "utf8")); } catch {}
    if (verifierPid && manager.get(session.id)?.status === "failed") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(Number.isInteger(verifierPid));
  assert.equal(manager.get(session.id)?.status, "failed");
  assert.throws(() => process.kill(verifierPid, 0), error => error?.code === "ESRCH");
});
