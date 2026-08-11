import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function retry(callback, attempts = 80) {
  let error;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await callback(); } catch (caught) { error = caught; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw error;
}

test("production entry writes protected runtime metadata and shuts down through its capability", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "capacity-atlas-runtime-"));
  const runtimePath = join(directory, "runtime.json");
  const port = await freePort();
  const token = "runtime-test-token_12345678901234567890";
  const child = spawn(process.execPath, [fileURLToPath(new URL("../connector-entry.js", import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "0.0.0.0",
      CAPACITY_ATLAS_TOKEN: token,
      CAPACITY_ATLAS_RUNTIME_PATH: runtimePath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  const runtime = await retry(async () => JSON.parse(await readFile(runtimePath, "utf8")));
  assert.equal(runtime.name, "Capacity Atlas Connector");
  assert.equal(runtime.version, "0.7.4");
  assert.equal(runtime.pid, child.pid);
  assert.equal(runtime.host, "127.0.0.1");
  assert.equal(runtime.token, token);
  if (process.platform !== "win32") assert.equal((await stat(runtimePath)).mode & 0o777, 0o600);

  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const stopped = once(child, "exit");
  assert.equal((await fetch(`${base}/api/shutdown`, {
    method: "POST",
    headers: { "x-capacity-atlas-token": token }
  })).status, 202);
  const [code, signal] = await stopped;
  assert.equal(code, 0);
  assert.equal(signal, null);
  await assert.rejects(readFile(runtimePath, "utf8"), error => error.code === "ENOENT");
});

test("production entry never writes the capability token to logs", async () => {
  const source = await readFile(new URL("../connector-entry.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\.(?:log|error)[^\n]*apiToken/);
  assert.doesNotMatch(source, /console\.(?:log|error)[^\n]*#token=/);
});
