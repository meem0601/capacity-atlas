import { execFile as nodeExecFile } from "node:child_process";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

/**
 * アクセストークンの自動更新。
 *
 * Connector は認証情報を読むだけで更新しないため、ログインから数時間で
 * 全アカウントが「再認証が必要」になり、毎日ログインし直さないと
 * 残容量を追えなかった。更新用トークンは各アカウントに残っているので、
 * 標準の refresh_token グラントで取り直す。
 *
 * 方針:
 * - 失敗しても呼び出し側は今までどおり「再認証が必要」に落ちるだけ。悪化させない
 * - 更新できたら必ず保存する。保存しないと、ローテーションする提供元では
 *   次回の更新が効かなくなり、かえって状況を悪くする
 * - 期限の少し手前で更新する。ちょうど期限で走らせると、取得中に切れる
 */

/** これだけ手前になったら更新する。収集の所要時間に対する余裕。 */
export const REFRESH_MARGIN_MS = 5 * 60_000;

export function needsRefresh(expiresAt, now = Date.now()) {
  const at = Number(expiresAt);
  if (!Number.isFinite(at) || at <= 0) return true;
  return at - REFRESH_MARGIN_MS <= now;
}

/** claude CLI が使う OAuth クライアント。CLI 同梱の定数と同じもの。 */
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
export const GROK_OIDC_ISSUER = "https://auth.x.ai";
const TOKEN_REFRESH_TIMEOUT_MS = 15_000;
const MAX_TOKEN_RESPONSE_BYTES = 1_048_576;

async function boundedJson(response, maxBytes = MAX_TOKEN_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel?.(); } catch {}
    throw new Error("トークン更新APIの応答が大きすぎます。");
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    try { await response.body?.cancel?.(); } catch {}
    throw new Error("トークン更新APIの応答を安全に読み取れません。");
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error("トークン更新APIの応答が大きすぎます。");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

async function fetchTokenJson(fetchFn, url, options = {}, timeoutMs = TOKEN_REFRESH_TIMEOUT_MS) {
  const milliseconds = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Number(timeoutMs)) : TOKEN_REFRESH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("トークン更新APIの通信がタイムアウトしました。")), milliseconds);
  try {
    const response = await fetchFn(url, { ...options, redirect: "error", signal: controller.signal });
    const body = await boundedJson(response);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function approvedIssuer(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== GROK_OIDC_ISSUER) return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) return null;
    return GROK_OIDC_ISSUER;
  } catch {
    return null;
  }
}

function approvedTokenEndpoint(value, issuer) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === issuer && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Claude のアクセストークンを取り直す。
 * 応答が refresh_token を返さない場合は既存を使い続ける（ローテーションしない提供元向け）。
 */
export async function refreshClaudeToken(oauth, { fetch = globalThis.fetch, now = Date.now, timeoutMs = TOKEN_REFRESH_TIMEOUT_MS } = {}) {
  if (!oauth?.refreshToken) return null;
  const { response, body } = await fetchTokenJson(fetch, CLAUDE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID
    })
  }, timeoutMs);
  if (!response.ok) return null;
  if (!body?.access_token) return null;

  return {
    ...oauth,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || oauth.refreshToken,
    expiresAt: now() + Number(body.expires_in || 0) * 1000
  };
}

/**
 * Grok は OIDC なので、発行元の設定文書から token_endpoint を引いてから更新する。
 * エンドポイントを直書きしないのは、発行元が変わっても追随できるようにするため。
 */
export async function refreshGrokToken(credentials, { fetch = globalThis.fetch, timeoutMs = TOKEN_REFRESH_TIMEOUT_MS } = {}) {
  if (!credentials?.refresh_token || !credentials.oidc_issuer || !credentials.oidc_client_id) return null;

  const issuer = approvedIssuer(credentials.oidc_issuer);
  if (!issuer) return null;
  const { response: discovery, body: config } = await fetchTokenJson(
    fetch,
    `${issuer}/.well-known/openid-configuration`,
    {},
    timeoutMs
  );
  if (!discovery.ok) return null;
  if (approvedIssuer(config?.issuer) !== issuer) return null;
  const tokenEndpoint = approvedTokenEndpoint(config?.token_endpoint, issuer);
  if (!tokenEndpoint) return null;

  const { response, body } = await fetchTokenJson(fetch, tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: credentials.oidc_client_id
    }).toString()
  }, timeoutMs);
  if (!response.ok) return null;
  if (!body?.access_token) return null;

  return {
    ...credentials,
    key: body.access_token,
    refresh_token: body.refresh_token || credentials.refresh_token,
    expires_at: new Date(Date.now() + Number(body.expires_in || 0) * 1000).toISOString()
  };
}

/** macOS Keychain の項目を上書き保存する（-U が無いと重複追加になる）。 */
export async function saveToKeychain(service, payload, {
  execFile: execFileFn = execFile,
  username = userInfo().username
} = {}) {
  await execFileFn("/usr/bin/security", [
    "add-generic-password", "-U", "-a", username, "-s", service, "-w", JSON.stringify(payload)
  ]);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * CLI 側が持っている書き込みロック（<file>.lock に "pid:timestamp"）を尊重する。
 * 相手が生きている間に書くと、CLI が書いた認証情報を潰しかねない。
 * 書かずに諦めても次の収集で取り直すだけなので、待たずに譲る。
 */
export async function lockedByAnotherProcess(lockPath, {
  readFile: readFileFn = readFile,
  isAlive = processIsAlive
} = {}) {
  try {
    const pid = Number(String(await readFileFn(lockPath, "utf8")).split(":")[0]);
    return pid !== process.pid && isAlive(pid);
  } catch {
    return false;
  }
}

/**
 * CLIと同じ .lock を排他的に作成し、保存処理が終わるまで保持する。
 * 既存ロックは古く見えても所有権を原子的に証明できないため削除せず、保存を譲る。
 */
export async function acquireFileLock(lockPath, {
  open: openFn = open,
  unlink: unlinkFn = unlink,
  now = Date.now
} = {}) {
  let handle;
  try {
    handle = await openFn(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}:${now()}\n`, "utf8");
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await handle.close();
      await unlinkFn(lockPath).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      });
    };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await unlinkFn(lockPath).catch(() => {});
    }
    if (error?.code === "EEXIST") return null;
    throw error;
  }
}

/**
 * 認証情報の保存。書き込み途中で落ちてもファイルを壊さないよう、
 * 別名で書いてから rename で差し替える（rename は同一ファイルシステム上で原子的）。
 * 途中まで書かれた認証情報が残ると、次回以降ログインし直すまで復帰できない。
 */
export async function saveToFile(path, payload, {
  writeFile: writeFileFn = writeFile,
  rename: renameFn = rename,
  unlink: unlinkFn = unlink,
  lockPath = `${path}.lock`,
  acquireLock: acquireLockFn = acquireFileLock
} = {}) {
  const releaseLock = await acquireLockFn(lockPath);
  if (!releaseLock) return false;

  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFileFn(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await renameFn(temporary, path);
    return true;
  } catch (error) {
    await unlinkFn(temporary).catch(() => {});
    throw error;
  } finally {
    await releaseLock();
  }
}
