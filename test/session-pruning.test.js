import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../lib/account-manager.js";

test("failed isolated OAuth profiles are removed and terminal sessions are pruned", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const removed = [];
  const root = "/tmp/capacity-atlas-failed-prune-test";
  const manager = new AccountManager({
    root,
    spawn: () => child,
    mkdir: async () => {},
    access: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    rm: async path => { removed.push(path); },
    sessionRetentionMs: 50
  });

  const session = await manager.start("codex");
  const expectedHome = join(root, "profiles", "codex", session.id);
  child.emit("close", 1);
  for (let attempt = 0; attempt < 20 && !removed.includes(expectedHome); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(manager.get(session.id)?.status, "failed");
  assert.ok(removed.includes(expectedHome));
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(manager.get(session.id), null);
});

test("a terminal failed state cannot be overwritten by a later successful close", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const root = await mkdtemp(join(tmpdir(), "capacity-atlas-terminal-race-"));
  const manager = new AccountManager({
    root,
    spawn: () => child,
    access: async () => {},
    sessionRetentionMs: 1_000
  });

  const session = await manager.start("codex");
  child.emit("error", new Error("spawn stream failed"));
  child.emit("close", 0);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(manager.get(session.id).status, "failed");
});

test("completed OAuth sessions are pruned without deleting their registered profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "capacity-atlas-completed-prune-"));
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const removed = [];
  const manager = new AccountManager({
    root,
    spawn: () => child,
    access: async () => {},
    rm: async path => { removed.push(path); },
    sessionRetentionMs: 15
  });

  const session = await manager.start("codex");
  child.emit("close", 0);
  for (let attempt = 0; attempt < 20 && manager.get(session.id)?.status !== "completed"; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(manager.get(session.id)?.status, "completed");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(manager.get(session.id), null);
  assert.equal(removed.some(path => String(path).endsWith(session.id)), false);
});
