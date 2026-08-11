import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AccountManager } from "./lib/account-manager.js";
import { createServer } from "./server.js";

const VERSION = "0.7.4";
const port = Number(process.env.PORT || 4174);
const host = "127.0.0.1";
const apiToken = process.env.CAPACITY_ATLAS_TOKEN || randomBytes(32).toString("base64url");
const runtimePath = process.env.CAPACITY_ATLAS_RUNTIME_PATH || join(homedir(), ".capacity-atlas", "runtime.json");
const accountManager = new AccountManager();
const server = createServer({ accountManager, apiToken });
let stopping = false;

async function writeRuntime() {
  const runtimeDirectory = dirname(runtimePath);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(runtimeDirectory, 0o700);
  const temporary = `${runtimePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  let writeError;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      name: "Capacity Atlas Connector",
      version: VERSION,
      pid: process.pid,
      host,
      port,
      token: apiToken,
      startedAt: new Date().toISOString()
    })}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    writeError = error;
  } finally {
    await handle?.close();
  }
  if (writeError) {
    await rm(temporary, { force: true }).catch(() => {});
    throw writeError;
  }
  try {
    await rename(temporary, runtimePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  if (process.platform !== "win32") await chmod(runtimePath, 0o600);
}

async function removeRuntime() {
  try {
    const current = JSON.parse(await readFile(runtimePath, "utf8"));
    if (current.pid === process.pid && current.token === apiToken) await rm(runtimePath, { force: true });
  } catch {}
}

function openLocalDashboard() {
  const url = `http://${host}:${port}/#token=${apiToken}`;
  const command = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", "start", "", url]]
      : ["xdg-open", [url]];
  try {
    const opener = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
    opener.once("error", () => {});
    opener.unref();
  } catch {}
}

async function stop() {
  if (stopping) return;
  stopping = true;
  await server.shutdownAccounts();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await removeRuntime();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void stop().finally(() => { process.exitCode = 0; }); });
}
server.once("close", () => { void removeRuntime(); });
server.listen(port, host, () => {
  void writeRuntime().then(() => {
    console.log(`Capacity Atlas Connector listening on http://${host}:${port}`);
    if (!process.env.CAPACITY_ATLAS_TOKEN) openLocalDashboard();
  }).catch(error => {
    console.error(`Capacity Atlas runtime metadata could not be written: ${error.message}`);
    void stop().finally(() => { process.exitCode = 1; });
  });
});
