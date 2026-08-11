import { execFile as nodeExecFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MAX_JSON_RESPONSE_BYTES = 1_048_576;
const MAX_PROTOBUF_RESPONSE_BYTES = 4_194_304;
const responseTimeouts = new WeakMap();

function connectorChildEnv(base = process.env) {
  const environment = { ...base };
  delete environment.CAPACITY_ATLAS_TOKEN;
  delete environment.CAPACITY_ATLAS_RUNTIME_PATH;
  return environment;
}

async function fetchWithTimeout(fetchFn, url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const milliseconds = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Number(timeoutMs)) : DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("利用枠APIの通信がタイムアウトしました。")), milliseconds);
  try {
    const response = await fetchFn(url, { ...options, signal: controller.signal });
    responseTimeouts.set(response, timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function clearResponseTimeout(response) {
  const timer = responseTimeouts.get(response);
  if (timer) clearTimeout(timer);
  responseTimeouts.delete(response);
}

async function discardResponse(response) {
  try { await response?.body?.cancel?.(); } catch {}
  clearResponseTimeout(response);
}

const PROVIDERS = {
  codex: { name: "GPT / Codex", label: "OpenAI account" },
  claude: { name: "Claude", label: "Claude account" },
  grok: { name: "Grok", label: "Grok account" }
};

async function defaultReadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readClaudeKeychain({
  platform = process.platform,
  username = userInfo().username,
  execFile: execFileFn = execFile
} = {}) {
  if (platform !== "darwin") throw new Error("Claude Keychain is available only on macOS");
  const { stdout } = await execFileFn("/usr/bin/security", [
    "find-generic-password",
    "-a",
    username,
    "-s",
    "Claude Code-credentials",
    "-w"
  ], { maxBuffer: 1_048_576, env: connectorChildEnv() });
  return JSON.parse(stdout);
}

function decodeJwtClaims(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function isoFromEpoch(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const milliseconds = Number(value) > 10_000_000_000 ? Number(value) : Number(value) * 1000;
  return new Date(milliseconds).toISOString();
}

function windowFromUsed(kind, title, raw) {
  if (!raw || !Number.isFinite(Number(raw.used_percent ?? raw.utilization ?? raw.percent))) return null;
  const usedPercent = Number(raw.used_percent ?? raw.utilization ?? raw.percent);
  const resetsAt = raw.resets_at || raw.resetsAt || isoFromEpoch(raw.reset_at);
  return {
    kind,
    title,
    usedPercent,
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    resetsAt: resetsAt || null
  };
}

function accountBase(provider, overrides = {}) {
  const metadata = PROVIDERS[provider];
  const email = overrides.email || null;
  return {
    id: overrides.id || `${provider}:${email || overrides.label || "default"}`,
    provider,
    providerName: metadata.name,
    label: overrides.label || metadata.label,
    email,
    plan: overrides.plan || null,
    status: overrides.status || "healthy",
    source: "Capacity Atlas Connector",
    updatedAt: new Date().toISOString(),
    configured: overrides.configured ?? true,
    authConnected: overrides.authConnected ?? overrides.status === "healthy",
    windows: overrides.windows || [],
    ...(overrides.credentialSource ? { credentialSource: overrides.credentialSource } : {}),
    ...(overrides.message ? { message: overrides.message } : {})
  };
}

function errorAccount(provider, error, email = null) {
  const message = error?.message || String(error);
  const configured = !(error?.code === "ENOENT" || /credentials not found|no such file or directory/i.test(message));
  const status = error?.status === 401 || /expired|unauthorized|not logged in|credential/i.test(message)
    ? "auth_required"
    : "unavailable";
  return accountBase(provider, {
    email,
    configured,
    status,
    message: status === "auth_required" ? "認証の有効期限が切れています。再接続してください。" : message,
    windows: []
  });
}

async function responseBytes(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel?.(); } catch {}
    clearResponseTimeout(response);
    throw new Error("利用枠APIの応答が大きすぎます。");
  }
  if (!response.body?.getReader) {
    try { await response.body?.cancel?.(); } catch {}
    clearResponseTimeout(response);
    throw new Error("利用枠APIの応答を安全なストリームとして読み込めませんでした。");
  }
  let reader;
  try {
    reader = response.body.getReader();
  } catch (error) {
    try { await response.body?.cancel?.(); } catch {}
    clearResponseTimeout(response);
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
      if (total > maxBytes) throw new Error("利用枠APIの応答が大きすぎます。");
      chunks.push(Buffer.from(value));
    }
    completed = true;
    return Buffer.concat(chunks, total);
  } finally {
    if (!completed) try { await reader.cancel(); } catch {}
    try { reader.releaseLock?.(); } catch {}
    clearResponseTimeout(response);
  }
}

async function responseJson(response) {
  const text = (await responseBytes(response, MAX_JSON_RESPONSE_BYTES)).toString("utf8");
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!body) throw new Error("利用枠APIからJSONを取得できませんでした。");
  return body;
}

export async function collectCodexAccount({
  home,
  readJson = defaultReadJson,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
}) {
  let email = null;
  try {
    const credentials = await readJson(join(home, "auth.json"));
    const tokens = credentials.tokens || {};
    if (!tokens.access_token) throw new Error("Codex credentials not found");
    const claims = decodeJwtClaims(tokens.id_token || tokens.access_token);
    email = claims.email || claims["https://api.openai.com/profile"]?.email || null;
    const response = await fetchWithTimeout(fetch, "https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        accept: "application/json",
        ...(tokens.account_id ? { "chatgpt-account-id": tokens.account_id } : {})
      }
    }, timeoutMs);
    const payload = await responseJson(response);
    email ||= payload.email || null;
    const rate = payload.rate_limit || {};
    const windows = [
      windowFromUsed("session", "5時間", rate.primary_window),
      windowFromUsed("weekly", "週間", rate.secondary_window)
    ].filter(Boolean);
    return accountBase("codex", { email, plan: payload.plan_type || null, windows });
  } catch (error) {
    return errorAccount("codex", error, email);
  }
}

export async function collectClaudeAccount({
  home,
  readJson = defaultReadJson,
  readKeychain = readClaudeKeychain,
  now = Date.now,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
}) {
  let email = null;
  let authenticated = false;
  let credentialSource = "protected_file";
  try {
    let credentials;
    let fileError = null;
    try {
      credentials = await readJson(join(home, ".credentials.json"));
    } catch (error) {
      fileError = error;
    }
    let oauth = credentials?.claudeAiOauth || credentials;
    const expired = oauth?.expiresAt && Number(oauth.expiresAt) <= Number(now());
    if (!oauth?.accessToken || expired) {
      try {
        credentials = await readKeychain();
        oauth = credentials?.claudeAiOauth || credentials;
        credentialSource = "macos_keychain";
      } catch {
        if (fileError) throw fileError;
      }
    }
    if (!oauth?.accessToken) throw new Error("Claude credentials not found");
    authenticated = true;
    const claims = decodeJwtClaims(oauth.accessToken);
    email = claims.email || null;
    const requestUsage = () => fetchWithTimeout(fetch, "https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-code/2.1.0"
      }
    }, timeoutMs);
    let usageResponse = await requestUsage();
    if (usageResponse.status === 429) {
      const retryAfter = Number(usageResponse.headers?.get?.("retry-after"));
      await discardResponse(usageResponse);
      await sleep(Number.isFinite(retryAfter) ? Math.min(5000, Math.max(250, retryAfter * 1000)) : 1500);
      usageResponse = await requestUsage();
    }
    const payload = await responseJson(usageResponse);
    const windows = [
      windowFromUsed("session", "5時間", payload.five_hour),
      windowFromUsed("weekly", "週間", payload.seven_day),
      windowFromUsed("opus", "Opus週間", payload.seven_day_opus),
      windowFromUsed("sonnet", "Sonnet週間", payload.seven_day_sonnet)
    ].filter(Boolean);
    return accountBase("claude", { email, plan: claims.subscriptionType || null, authConnected: true, credentialSource, windows });
  } catch (error) {
    if (authenticated && error?.status !== 401) {
      return accountBase("claude", {
        email,
        status: "connected",
        authConnected: true,
        credentialSource,
        message: error?.message || String(error),
        windows: []
      });
    }
    return errorAccount("claude", error, email);
  }
}

function readVarint(bytes, cursor) {
  let value = 0n;
  let shift = 0n;
  while (cursor.index < bytes.length && shift < 64n) {
    const byte = bytes[cursor.index++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
  }
  return null;
}

function scanProtobuf(bytes, depth = 0, path = [], result = { fixed32: [], varints: [], order: 0 }) {
  const cursor = { index: 0 };
  while (cursor.index < bytes.length) {
    const start = cursor.index;
    const key = readVarint(bytes, cursor);
    if (!key) { cursor.index = start + 1; continue; }
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    const fieldPath = [...path, field];
    if (wire === 0) {
      const value = readVarint(bytes, cursor);
      if (value != null) result.varints.push({ path: fieldPath, value });
      else cursor.index = start + 1;
    } else if (wire === 1) {
      if (cursor.index + 8 > bytes.length) break;
      cursor.index += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, cursor);
      if (length == null || length > BigInt(bytes.length - cursor.index)) { cursor.index = start + 1; continue; }
      const end = cursor.index + Number(length);
      if (depth < 4) scanProtobuf(bytes.subarray(cursor.index, end), depth + 1, fieldPath, result);
      cursor.index = end;
    } else if (wire === 5) {
      if (cursor.index + 4 > bytes.length) break;
      const view = new DataView(bytes.buffer, bytes.byteOffset + cursor.index, 4);
      result.fixed32.push({ path: fieldPath, value: view.getFloat32(0, true), order: result.order++ });
      cursor.index += 4;
    } else {
      cursor.index = start + 1;
    }
  }
  return result;
}

function grpcDataFrames(buffer) {
  const frames = [];
  let index = 0;
  while (index + 5 <= buffer.length) {
    const flags = buffer[index];
    const length = buffer.readUInt32BE(index + 1);
    const start = index + 5;
    const end = start + length;
    if (end > buffer.length) return [];
    if ((flags & 0x80) === 0) frames.push(buffer.subarray(start, end));
    index = end;
  }
  return frames;
}

export function parseGrokBillingResponse(data, now = new Date()) {
  const buffer = Buffer.from(data);
  const frames = grpcDataFrames(buffer);
  const payloads = frames.length ? frames : [buffer];
  const scan = { fixed32: [], varints: [], order: 0 };
  for (const payload of payloads) scanProtobuf(payload, 0, [], scan);
  const percent = scan.fixed32
    .filter(field => field.path.at(-1) === 1 && Number.isFinite(field.value) && field.value >= 0 && field.value <= 100)
    .sort((a, b) => a.path.length - b.path.length || a.order - b.order)[0]?.value;
  const resets = scan.varints
    .map(field => ({ path: field.path, seconds: Number(field.value) }))
    .filter(field => field.seconds >= 1_700_000_000 && field.seconds <= 2_100_000_000)
    .map(field => ({ ...field, date: new Date(field.seconds * 1000) }))
    .filter(field => field.date > now)
    .sort((a, b) => {
      const aPreferred = JSON.stringify(a.path) === "[1,5,1]" ? 0 : 1;
      const bPreferred = JSON.stringify(b.path) === "[1,5,1]" ? 0 : 1;
      return aPreferred - bPreferred || a.date - b.date;
    });
  if (percent == null) throw new Error("Grok利用枠を解析できませんでした。");
  return { usedPercent: Number(percent), resetsAt: resets[0]?.date.toISOString() || null };
}

export async function collectGrokAccount({
  home,
  readJson = defaultReadJson,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
}) {
  let email = null;
  try {
    const entries = await readJson(join(home, "auth.json"));
    const credentials = Object.values(entries).find(value => value && typeof value === "object" && value.key);
    if (!credentials?.key) throw new Error("Grok credentials not found");
    email = credentials.email || null;
    if (credentials.expires_at && new Date(credentials.expires_at) <= new Date()) {
      const error = new Error("Grok credentials expired");
      error.status = 401;
      throw error;
    }
    const response = await fetchWithTimeout(fetch, "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.key}`,
        origin: "https://grok.com",
        referer: "https://grok.com/?_s=usage",
        accept: "*/*",
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "x-user-agent": "connect-es/2.1.1",
        "user-agent": "CapacityAtlas"
      },
      body: Buffer.from([0, 0, 0, 0, 0])
    }, timeoutMs);
    if (!response.ok) {
      await discardResponse(response);
      const error = new Error(`Grok API HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const parsed = parseGrokBillingResponse(await responseBytes(response, MAX_PROTOBUF_RESPONSE_BYTES));
    const window = {
      kind: "credits",
      title: "利用枠",
      usedPercent: parsed.usedPercent,
      remainingPercent: Math.max(0, Math.min(100, 100 - parsed.usedPercent)),
      resetsAt: parsed.resetsAt
    };
    return accountBase("grok", { email, plan: credentials.auth_mode || null, windows: [window] });
  } catch (error) {
    return errorAccount("grok", error, email);
  }
}

function accountSource(value) {
  return typeof value === "string" ? { home: value, managed: false, connectionId: null } : value;
}

function collapseDuplicateAccounts(accounts) {
  const grouped = new Map();
  for (const account of accounts) {
    const identity = account.email ? `${account.provider}:${account.email.toLowerCase()}` : `${account.id}:${account.connectionId || "ambient"}`;
    const existing = grouped.get(identity);
    const managedConnectionIds = account.managed && account.connectionId ? [account.connectionId] : [];
    if (!existing) {
      grouped.set(identity, {
        ...account,
        managedConnectionIds,
        hasAmbientConnection: !account.managed,
        duplicateConnections: 1
      });
      continue;
    }
    existing.managedConnectionIds = [...new Set([...existing.managedConnectionIds, ...managedConnectionIds])];
    existing.hasAmbientConnection ||= !account.managed;
    existing.duplicateConnections += 1;
    if (existing.status !== "healthy" && account.status === "healthy") {
      const connectionState = {
        managedConnectionIds: existing.managedConnectionIds,
        hasAmbientConnection: existing.hasAmbientConnection,
        duplicateConnections: existing.duplicateConnections
      };
      Object.assign(existing, account, connectionState);
    }
  }
  return [...grouped.values()].map(({ connectionId, managed, ...account }) => account);
}

export async function collectDirectProviders({
  homes,
  readJson = defaultReadJson,
  readKeychain,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
} = {}) {
  const root = process.env.HOME || "";
  const resolved = homes || {
    codex: [join(root, ".codex")],
    claude: [join(root, ".claude")],
    grok: [join(root, ".grok")]
  };
  const collect = (provider, source) => {
    const entry = accountSource(source);
    const collector = { codex: collectCodexAccount, claude: collectClaudeAccount, grok: collectGrokAccount }[provider];
    const options = { home: entry.home, readJson, fetch, timeoutMs };
    if (provider === "claude" && readKeychain) options.readKeychain = readKeychain;
    return collector(options).then(account => {
      const email = account.email || entry.email || null;
      return {
        ...account,
        email,
        label: email || account.label,
        plan: account.plan || entry.plan || null,
        connectionId: entry.connectionId,
        managed: entry.managed === true
      };
    });
  };
  const jobs = [
    ...(resolved.codex || []).map(source => collect("codex", source)),
    ...(resolved.claude || []).map(source => collect("claude", source)),
    ...(resolved.grok || []).map(source => collect("grok", source))
  ];
  const accounts = (await Promise.all(jobs)).filter(account => account.configured !== false);
  return {
    collectedAt: new Date().toISOString(),
    providers: ["codex", "claude", "grok"],
    accounts: collapseDuplicateAccounts(accounts)
  };
}
