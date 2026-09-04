const APP_VERSION = "0.9.3";

export function detectPlatform(navigator = {}) {
  const platform = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  return "other";
}

export function buildSetupDiagnostic({ navigator = {}, connectorStatus = "missing", locale = "ja" } = {}) {
  const japanese = locale === "ja";
  const os = { macos: "macOS", windows: "Windows", other: japanese ? "非対応または判定不能" : "Unsupported or unknown" }[detectPlatform(navigator)];
  const connector = japanese
    ? { ready: "接続済み", outdated: "更新が必要", missing: "未検出" }[connectorStatus] || "未検出"
    : { ready: "Connected", outdated: "Update required", missing: "Not detected" }[connectorStatus] || "Not detected";
  const privacy = japanese
    ? "認証情報・アカウント情報・利用枠・エラー本文は含まれていません。"
    : "Credentials, account details, capacity values, and error text are not included.";

  return [
    "Capacity Atlas Setup Diagnostic",
    `App: ${APP_VERSION}`,
    `OS: ${os}`,
    `Connector: ${connector}`,
    `Language: ${japanese ? "ja" : "en"}`,
    privacy
  ].join("\n");
}
