import { execFile as nodeExecFile } from "node:child_process";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
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

/**
 * Claude のアクセストークンを取り直す。
 * 応答が refresh_token を返さない場合は既存を使い続ける（ローテーションしない提供元向け）。
 */
export async function refreshClaudeToken(oauth, { fetch = globalThis.fetch, now = Date.now } = {}) {
  if (!oauth?.refreshToken) return null;
  const response = await fetch(CLAUDE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID
    })
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
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
export async function refreshGrokToken(credentials, { fetch = globalThis.fetch } = {}) {
  if (!credentials?.refresh_token || !credentials.oidc_issuer || !credentials.oidc_client_id) return null;

  const discovery = await fetch(`${credentials.oidc_issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!discovery.ok) return null;
  const config = await discovery.json().catch(() => null);
  if (!config?.token_endpoint) return null;

  const response = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: credentials.oidc_client_id
    }).toString()
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
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
 * 認証情報の保存。書き込み途中で落ちてもファイルを壊さないよう、
 * 別名で書いてから rename で差し替える（rename は同一ファイルシステム上で原子的）。
 * 途中まで書かれた認証情報が残ると、次回以降ログインし直すまで復帰できない。
 */
export async function saveToFile(path, payload, {
  writeFile: writeFileFn = writeFile,
  rename: renameFn = rename,
  unlink: unlinkFn = unlink,
  lockPath = `${path}.lock`,
  isLocked = lockedByAnotherProcess
} = {}) {
  if (await isLocked(lockPath)) return false;

  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFileFn(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await renameFn(temporary, path);
    return true;
  } catch (error) {
    await unlinkFn(temporary).catch(() => {});
    throw error;
  }
}
