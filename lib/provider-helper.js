import { createHash, randomUUID } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
function connectorChildEnv(base = process.env, overrides = {}) {
  const environment = { ...base, ...overrides };
  delete environment.CAPACITY_ATLAS_TOKEN;
  delete environment.CAPACITY_ATLAS_RUNTIME_PATH;
  return environment;
}

const execFile = promisify(nodeExecFile);
const CLAUDE_BASE = "https://downloads.claude.ai/claude-code-releases";
const GROK_BASE = "https://x.ai/cli";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const MAX_METADATA_BYTES = 1_048_576;
const MAX_BINARY_BYTES = 536_870_912;
const responseTimeouts = new WeakMap();

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function platformKey(provider, platform, arch) {
  if (provider === "claude") {
    if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
    if (platform === "win32" && arch === "x64") return "win32-x64";
  }
  if (provider === "grok") {
    if (platform === "darwin" && arch === "arm64") return "macos-aarch64";
    if (platform === "win32" && arch === "x64") return "windows-x86_64";
  }
  throw new Error("このOSはCapacity Atlas Connectorの認証機能に対応していません。");
}

export function providerArtifact(provider, { platform = process.platform, arch = process.arch, version }) {
  const key = platformKey(provider, platform, arch);
  if (provider === "claude") {
    const filename = platform === "win32" ? "claude.exe" : "claude";
    return { platformKey: key, filename, url: `${CLAUDE_BASE}/${version}/${key}/${filename}` };
  }
  if (provider === "grok") {
    const filename = platform === "win32" ? "grok.exe" : "grok";
    const suffix = platform === "win32" ? ".exe" : "";
    return { platformKey: key, filename, url: `${GROK_BASE}/grok-${version}-${key}${suffix}` };
  }
  throw new Error("このAIサービスには管理対象の認証ヘルパーがありません。");
}

async function fetchOk(fetchFn, url, timeoutMs) {
  const milliseconds = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Number(timeoutMs)) : DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("公式認証機能の通信がタイムアウトしました。")), milliseconds);
  let response;
  try {
    response = await fetchFn(url, { redirect: "follow", signal: controller.signal });
    responseTimeouts.set(response, timer);
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  if (!response?.ok) {
    try { await response?.body?.cancel?.(); } catch {}
    clearTimeout(timer);
    responseTimeouts.delete(response);
    throw new Error(`公式認証機能の取得に失敗しました（HTTP ${response?.status || "?"}）。`);
  }
  return response;
}

async function responseBytes(response, maxBytes) {
  const clearTimeoutForResponse = () => {
    const timer = responseTimeouts.get(response);
    if (timer) clearTimeout(timer);
    responseTimeouts.delete(response);
  };
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel?.(); } catch {}
    clearTimeoutForResponse();
    throw new Error("公式認証機能の応答が大きすぎます。");
  }
  if (!response.body?.getReader) {
    try { await response.body?.cancel?.(); } catch {}
    clearTimeoutForResponse();
    throw new Error("公式認証機能の応答を安全なストリームとして読み込めませんでした。");
  }
  let reader;
  try {
    reader = response.body.getReader();
  } catch (error) {
    try { await response.body?.cancel?.(); } catch {}
    clearTimeoutForResponse();
    throw error;
  }
  const chunks = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("公式認証機能の応答が大きすぎます。");
      chunks.push(Buffer.from(value));
    }
    completed = true;
    return Buffer.concat(chunks, total);
  } finally {
    if (!completed) try { await reader.cancel(); } catch {}
    try { reader.releaseLock?.(); } catch {}
    clearTimeoutForResponse();
  }
}

async function readFileBounded(path, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of createReadStream(path)) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("ローカル認証機能のファイルが大きすぎます。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function hashFileBounded(path, maxBytes) {
  const hash = createHash("sha256");
  let total = 0;
  for await (const chunk of createReadStream(path)) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("ローカル認証機能のファイルが大きすぎます。");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function defaultVerifyBinary({ provider, path, platform }) {
  if (platform === "darwin") {
    await execFile("/usr/bin/codesign", ["--verify", "--strict", path], { env: connectorChildEnv() });
    const { stderr } = await execFile("/usr/bin/codesign", ["-dv", "--verbose=4", path], { env: connectorChildEnv() });
    const expectedTeam = provider === "claude" ? "Q6L2SF6YDW" : "5Y6N3AJ54S";
    if (!String(stderr).includes(`TeamIdentifier=${expectedTeam}`)) {
      throw new Error("公式配布元の署名を確認できませんでした。");
    }
    return;
  }
  if (platform === "win32") {
    const escaped = path.replace(/'/g, "''");
    const script = `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; if ($s.Status -ne 'Valid') { exit 1 }; Write-Output $s.SignerCertificate.Subject`;
    const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: connectorChildEnv() });
    const expected = provider === "claude" ? /Anthropic/i : /X\.AI|xAI/i;
    if (!expected.test(String(stdout))) throw new Error("公式配布元の署名を確認できませんでした。");
  }
}

export class ProviderHelperManager {
  constructor({
    root = join(homedir(), ".capacity-atlas", "helpers"),
    platform = process.platform,
    arch = process.arch,
    fetch = globalThis.fetch,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    maxMetadataBytes = MAX_METADATA_BYTES,
    maxBinaryBytes = MAX_BINARY_BYTES,
    verifyBinary = defaultVerifyBinary
  } = {}) {
    this.root = root;
    this.platform = platform;
    this.arch = arch;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.maxMetadataBytes = maxMetadataBytes;
    this.maxBinaryBytes = maxBinaryBytes;
    this.verifyBinary = verifyBinary;
    this.inFlight = new Map();
  }

  async ensure(provider, { onProgress = () => {} } = {}) {
    if (!["claude", "grok"].includes(provider)) throw new Error("管理対象外の認証ヘルパーです。");
    if (!this.inFlight.has(provider)) {
      const task = this.#ensure(provider, onProgress).finally(() => this.inFlight.delete(provider));
      this.inFlight.set(provider, task);
    }
    return this.inFlight.get(provider);
  }

  async #ensure(provider, onProgress) {
    const providerRoot = join(this.root, provider);
    const currentPath = join(providerRoot, "current.json");
    let cached = null;
    try {
      const current = JSON.parse((await readFileBounded(currentPath, this.maxMetadataBytes)).toString("utf8"));
      if (!VERSION_PATTERN.test(current.version || "") || !/^[a-f0-9]{64}$/i.test(current.checksum || "")) {
        throw new Error("cached helper metadata is invalid");
      }
      const artifact = providerArtifact(provider, {
        platform: this.platform,
        arch: this.arch,
        version: current.version
      });
      cached = join(providerRoot, current.version, artifact.filename);
      if (current.platformKey !== artifact.platformKey || !await pathExists(cached)) {
        throw new Error("cached helper does not match this platform");
      }
      const actualChecksum = await hashFileBounded(cached, this.maxBinaryBytes);
      if (actualChecksum !== current.checksum.toLowerCase()) throw new Error("cached helper checksum mismatch");
      await this.verifyBinary({ provider, path: cached, platform: this.platform });
      return cached;
    } catch {
      if (cached) await rm(cached, { force: true });
    }

    onProgress({ stage: "version", message: "公式認証機能の最新版を確認しています…" });
    const versionUrl = provider === "claude" ? `${CLAUDE_BASE}/latest` : `${GROK_BASE}/stable`;
    const versionResponse = await fetchOk(this.fetch, versionUrl, this.timeoutMs);
    const version = (await responseBytes(versionResponse, this.maxMetadataBytes)).toString("utf8").trim();
    if (!VERSION_PATTERN.test(version)) throw new Error("公式配布元から有効なバージョン情報を取得できませんでした。");

    const artifact = providerArtifact(provider, { platform: this.platform, arch: this.arch, version });
    let expectedChecksum = null;
    if (provider === "claude") {
      const manifestResponse = await fetchOk(this.fetch, `${CLAUDE_BASE}/${version}/manifest.json`, this.timeoutMs);
      const manifest = JSON.parse((await responseBytes(manifestResponse, this.maxMetadataBytes)).toString("utf8"));
      expectedChecksum = manifest?.platforms?.[artifact.platformKey]?.checksum || null;
      if (!/^[a-f0-9]{64}$/i.test(expectedChecksum || "")) {
        throw new Error("Claude公式manifestの整合性情報を確認できませんでした。");
      }
    }

    const versionRoot = join(providerRoot, version);
    const destination = join(versionRoot, artifact.filename);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.download`;
    const currentTemporary = `${currentPath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(versionRoot, { recursive: true, mode: 0o700 });
    onProgress({ stage: "download", message: `${provider === "claude" ? "Claude" : "Grok"}公式認証機能を準備しています…` });
    try {
      const binaryResponse = await fetchOk(this.fetch, artifact.url, this.timeoutMs);
      const bytes = await responseBytes(binaryResponse, this.maxBinaryBytes);
      const actualChecksum = createHash("sha256").update(bytes).digest("hex");
      if (expectedChecksum) {
        if (actualChecksum !== expectedChecksum.toLowerCase()) throw new Error("公式認証機能の整合性を確認できませんでした。");
      }
      await writeFile(temporary, bytes, { mode: 0o700 });
      await chmod(temporary, 0o700);
      await this.verifyBinary({ provider, path: temporary, platform: this.platform });
      await rename(temporary, destination);
      await writeFile(currentTemporary, JSON.stringify({
        version,
        platformKey: artifact.platformKey,
        checksum: actualChecksum,
        verifiedAt: new Date().toISOString()
      }, null, 2), { mode: 0o600 });
      await rename(currentTemporary, currentPath);
      return destination;
    } catch (error) {
      await rm(temporary, { force: true });
      await rm(currentTemporary, { force: true });
      throw error;
    }
  }
}
