import { accountTone, deriveSummary, primaryQuota } from "./model.js?v=0.7.4";
import { loginOpenedLabel, setupGuide } from "./setup-model.js?v=0.7.4";
import { connectorIsCompatible, createConnectorClient } from "./connector-client.js?v=0.7.4";
import { parseBrowserLogin, parseDeviceLogin, stripTerminalFormatting } from "./login-output-model.js?v=0.7.4";

const connector = createConnectorClient();
const state = { data: { accounts: [], collectedAt: null }, provider: "all", countdown: 60, setupProvider: "codex", connectorReady: false, connectorOutdated: false, loginTimer: null, activeLoginId: null, disconnectAccountId: null, setupReturnFocus: null, disconnectReturnFocus: null };
const $ = selector => document.querySelector(selector);
const COLORS = { codex: "#10a37f", claude: "#d97757", grok: "#8b9dff" };
const PROVIDER_ASSETS = {
  codex: { src: "/assets/providers/openai.svg", alt: "OpenAI" },
  claude: { src: "/assets/providers/claude.svg", alt: "Claude" },
  grok: { src: "/assets/providers/grok.svg", alt: "Grok" }
};

function providerLogo(provider) {
  const asset = PROVIDER_ASSETS[provider];
  return asset
    ? `<img src="${asset.src}" alt="${asset.alt}" width="21" height="21">`
    : `<span aria-hidden="true">AI</span>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function formatTime(value) {
  if (!value) return "取得なし";
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatReset(value) {
  if (!value) return "リセット日時は未取得";
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 0) return "リセット反映待ち";
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return days ? `リセットまで${days}日${remainingHours}時間` : `リセットまで${Math.max(1, hours)}時間`;
}

function statusLabel(status) {
  return ({ healthy: "取得済み", connected: "接続済み", auth_required: "再接続が必要", unavailable: "取得できません" })[status] || status;
}

function localizedMessage(account) {
  const message = account.message || "現在の利用枠を取得できませんでした。";
  if (/OAuth token expired|claude login/i.test(message)) return "Claudeの認証期限が切れています。「アカウントを追加」から再接続手順を確認してください。";
  if (/not logged in|authentication|unauthorized/i.test(message)) return "認証を確認できませんでした。「アカウントを追加」から接続し直してください。";
  if (/rate limited|too many requests|429/i.test(message)) return account.status === "connected"
    ? "Claudeとの接続は完了しています。利用枠は自動で再取得します。"
    : "利用枠の取得が混み合っています。少し待ってから更新してください。";
  if (/timeout|network/i.test(message)) return "通信に失敗しました。しばらく待ってから更新してください。";
  return message;
}

function disconnectControl(account) {
  const managedCount = account.managedConnectionIds?.length || 0;
  if (!managedCount) return "";
  const label = account.hasAmbientConnection ? "重複を整理" : "接続解除";
  return `<button class="disconnect-button" type="button" data-disconnect-account="${escapeHtml(account.id)}">${label}</button>`;
}

function connectionBadge(account) {
  return account.duplicateConnections > 1
    ? `<span class="duplicate-badge">${account.duplicateConnections}件の接続を統合</span>`
    : "";
}

function accountCard(account) {
  const quota = primaryQuota(account);
  const tone = accountTone(account);
  const accent = tone === "danger" ? "#ff6b75" : tone === "warning" ? "#f0b45a" : COLORS[account.provider] || "#8d94a3";
  const identity = account.email || account.label;
  const status = statusLabel(account.status);
  if (!quota) {
    return `<article class="account-card provider-card provider-${account.provider}" style="--accent:${accent}">
      <div class="card-head"><div class="provider-lockup"><span class="provider-icon">${providerLogo(account.provider)}</span><div class="provider-meta"><b>${escapeHtml(account.providerName)}</b><span>${escapeHtml(identity)}</span>${connectionBadge(account)}</div></div><span class="status-pill"><i></i>${status}</span></div>
      <div class="error-state"><strong>${account.status === "auth_required" ? "再接続が必要です" : account.status === "connected" ? "接続済み・残容量を取得中" : "残容量を取得できません"}</strong><p>${escapeHtml(localizedMessage(account))}</p></div>
      <div class="card-foot"><span>${escapeHtml(account.source || "ローカル接続")}</span><div class="card-foot-actions"><span>${formatTime(account.updatedAt)}</span>${disconnectControl(account)}</div></div>
    </article>`;
  }
  return `<article class="account-card provider-card provider-${account.provider}" style="--accent:${accent}">
    <div class="card-head"><div class="provider-lockup"><span class="provider-icon">${providerLogo(account.provider)}</span><div class="provider-meta"><b>${escapeHtml(account.providerName)}</b><span>${escapeHtml(identity)}</span>${connectionBadge(account)}</div></div><span class="status-pill"><i></i>${status}</span></div>
    <div class="quota-row"><div class="quota-number">${Math.round(quota.remainingPercent)}<small>%</small></div><div class="quota-label">残り<b>${escapeHtml(account.plan || "接続済み")}</b></div></div>
    <div class="progress"><span style="--value:${quota.remainingPercent}%"></span></div>
    <div class="window-meta"><span>${escapeHtml(quota.title || quota.kind)}</span><span>${formatReset(quota.resetsAt)}</span></div>
    <div class="card-foot"><span>${escapeHtml(account.source || "ローカル接続")}</span><div class="card-foot-actions"><span>更新済み ${formatTime(account.updatedAt)}</span>${disconnectControl(account)}</div></div>
  </article>`;
}

function render() {
  const accounts = state.data?.accounts || [];
  const filtered = state.provider === "all" ? accounts : accounts.filter(account => account.provider === state.provider);
  const summary = deriveSummary(accounts);
  $("#totalAccounts").textContent = summary.total;
  $("#providerCount").textContent = `${summary.providers}サービス`;
  $("#averageRemaining").textContent = summary.averageRemaining == null ? "—" : `${summary.averageRemaining}%`;
  $("#attentionCount").textContent = summary.attention;
  $("#lastSync").textContent = state.data?.collectedAt ? formatTime(state.data.collectedAt) : "—";
  const lastSyncTop = $("#lastSyncTop");
  if (lastSyncTop) lastSyncTop.textContent = state.data?.collectedAt ? `最終同期 ${formatTime(state.data.collectedAt)}` : "同期を確認中";
  $("#dataMode").textContent = state.connectorReady ? "ローカル収集・自動更新" : "Connector接続待ち";
  $("#autoUpdateState").lastChild.textContent = state.connectorReady ? "自動更新中" : "接続待ち";
  $("#nextRefresh").textContent = state.connectorReady ? state.countdown : "—";
  $("#nextRefreshLabel").textContent = state.connectorReady ? "秒後に次回更新" : "Connector接続後に更新";
  const emptyMessage = state.connectorReady
    ? "まだアカウントが接続されていません。右上の「アカウントを追加」から接続してください。"
    : "Connectorへ接続すると、このPCの実際のアカウントだけが表示されます。";
  $("#accountGrid").innerHTML = filtered.length
    ? filtered.map(accountCard).join("")
    : `<div class="empty"><strong>アカウントは0件です</strong><p>${emptyMessage}</p></div>`;
  $("#statusTable").innerHTML = filtered.length ? filtered.map(account => {
    const color = account.status === "healthy" ? "#50d8a1" : account.status === "connected" ? COLORS[account.provider] : account.status === "auth_required" ? "#f0b45a" : "#ff6b75";
    return `<tr><td class="provider-cell" data-label="サービス">${escapeHtml(account.providerName)}</td><td data-label="アカウント">${escapeHtml(account.email || account.label)}</td><td data-label="取得元">${escapeHtml(account.source || "—")}</td><td data-label="最終更新">${formatTime(account.updatedAt)}</td><td data-label="状態"><span class="table-status" style="--status-color:${color}">${statusLabel(account.status)}</span></td></tr>`;
  }).join("") : '<tr><td colspan="5" class="table-empty">接続済みのアカウントはありません。</td></tr>';
}

function setConnection(mode, text) {
  const element = $("#connectionState");
  element.className = `connection ${mode}`;
  element.querySelector("b").textContent = text;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}

function renderSetupGuide(provider) {
  const guide = setupGuide(provider);
  if (!guide) return;
  $("#accountSetupDialog").classList.remove("login-flow-active");
  state.setupProvider = provider;
  $("#setupProviderTitle").textContent = guide.title;
  $("#setupCapability").textContent = guide.capability;
  $("#setupSteps").innerHTML = guide.steps.map(step => `<li>${escapeHtml(step)}</li>`).join("");
  $("#setupNote").textContent = guide.note;
  $("#connectAccountButton").textContent = state.connectorOutdated ? "Connectorを更新してください" : guide.actionLabel;
  $("#connectAccountButton").disabled = !state.connectorReady;
  $("#loginOutput").hidden = true;
  document.querySelectorAll(".provider-choice").forEach(button => {
    const active = button.dataset.setupProvider === provider;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active) $("#setupPanel").setAttribute("aria-labelledby", button.id);
  });
}

async function checkConnector() {
  const banner = $("#connectorBanner");
  const installActions = $("#connectorInstallActions");
  try {
    const health = await connector.health();
    if (!health.ready) throw new Error("not ready");
    if (health.requiresToken && !connector.authorized) {
      state.connectorReady = false;
      state.connectorOutdated = false;
      banner.className = "connector-banner missing";
      $("#connectorTitle").textContent = "Connectorからこの画面を開き直してください";
      $("#connectorDetail").textContent = "安全な一時接続を作るため、Connectorアプリをもう一度起動します";
    } else if (!connectorIsCompatible(health)) {
      state.connectorReady = false;
      state.connectorOutdated = true;
      banner.className = "connector-banner missing";
      $("#connectorTitle").textContent = "Connectorの更新が必要です";
      $("#connectorDetail").textContent = `現在はv${health.version || "不明"}です。v0.7.4へ置き換えてください`;
    } else {
      state.connectorReady = true;
      state.connectorOutdated = false;
      banner.className = "connector-banner ready";
      $("#connectorTitle").textContent = "Connector接続済み";
      $("#connectorDetail").textContent = "CodexBarを使わず、このPC内で安全に認証・取得します";
    }
  } catch {
    state.connectorReady = false;
    state.connectorOutdated = false;
    banner.className = "connector-banner missing";
    $("#connectorTitle").textContent = "まずConnectorをダウンロードして起動してください";
    $("#connectorDetail").textContent = "OSに合う版を選び、解凍してConnectorを起動します";
  }
  installActions.hidden = state.connectorReady;
  const button = $("#connectAccountButton");
  button.disabled = state.connectorOutdated;
  button.textContent = state.connectorOutdated
    ? "Connectorを更新してください"
    : state.connectorReady
    ? (setupGuide(state.setupProvider)?.actionLabel || "接続する")
    : "接続を再確認";
}

async function openSetupDialog(provider = "codex") {
  state.setupReturnFocus = document.activeElement;
  renderSetupGuide(provider);
  $("#accountSetupDialog").showModal();
  await checkConnector();
  if (!$("#accountSetupDialog").open) return;
  document.querySelector(`.provider-choice[data-setup-provider="${provider}"]`)?.focus();
}

function closeSetupDialog() {
  $("#accountSetupDialog").close();
}

function handleSetupDialogClosed() {
  if (state.loginTimer) clearInterval(state.loginTimer);
  state.loginTimer = null;
  const activeLoginId = state.activeLoginId;
  state.activeLoginId = null;
  if (activeLoginId) void connector.cancelLogin(activeLoginId).catch(() => {});
  state.setupReturnFocus?.focus?.();
  state.setupReturnFocus = null;
}

function renderLoginProgress(element, value) {
  const parsed = parseDeviceLogin(value);
  const browserLogin = parseBrowserLogin(value);
  element.hidden = false;
  if (browserLogin.ready && !parsed.ready) {
    const serviceName = { codex: "OpenAI", claude: "Claude", grok: "Grok" }[state.setupProvider] || "AIサービス";
    const accountName = { codex: "OpenAI", claude: "Anthropic", grok: "xAI" }[state.setupProvider] || serviceName;
    element.className = "login-output guided-login";
    element.innerHTML = `<div class="login-ready-mark">${serviceName}のログイン画面を開きました</div>
      <ol class="login-easy-steps">
        <li><b>${serviceName}の画面でログイン</b><span>Capacity Atlasで使いたい${accountName}アカウントを選んでください。</span></li>
        <li><b>アクセスを許可</b><span>確認画面が表示されたら、そのまま続行してください。</span></li>
        <li><b>この画面に戻る</b><span>接続完了は自動で反映されます。コード入力はありません。</span></li>
      </ol>
      <button type="button" class="login-open-button" data-auth-url="${escapeHtml(browserLogin.url)}">ログイン画面が見つからない場合はこちら</button>
      <details class="login-technical"><summary>技術情報を表示</summary><pre>${escapeHtml(browserLogin.clean)}</pre></details>`;
    return true;
  }
  if (parsed.ready) {
    element.className = "login-output guided-login";
    element.innerHTML = `<div class="login-ready-mark">OpenAIのログイン準備ができました</div>
      <ol class="login-easy-steps">
        <li><b>下のボタンを押す</b><span>コードをコピーして、OpenAIの公式画面を開きます。</span></li>
        <li><b>コードを貼り付けてログイン</b><span>入力欄を押し、⌘Vで貼り付けてください。</span></li>
        <li><b>この画面に戻る</b><span>接続完了は自動で反映されます。</span></li>
      </ol>
      <div class="device-code"><span>ワンタイムコード</span><strong>${escapeHtml(parsed.code)}</strong></div>
      <button type="button" class="login-open-button" data-auth-url="${escapeHtml(parsed.url)}" data-auth-code="${escapeHtml(parsed.code)}">コードをコピーしてOpenAIを開く</button>
      <details class="login-technical"><summary>技術情報を表示</summary><pre>${escapeHtml(parsed.clean)}</pre></details>`;
    return true;
  }
  element.className = "login-output guided-login login-preparing";
  element.innerHTML = `<div class="login-spinner"></div><div><b>ログイン画面を準備しています</b><span>そのまま数秒お待ちください。</span></div>`;
  return false;
}

function renderLoginResult(element, success, message) {
  element.hidden = false;
  element.className = `login-output guided-login ${success ? "login-success" : "login-failed"}`;
  element.innerHTML = success
    ? `<div class="login-result-icon">✓</div><div><b>接続できました</b><span>利用枠を更新しています。この画面は閉じて大丈夫です。</span></div>`
    : `<div class="login-result-icon">!</div><div><b>接続を完了できませんでした</b><span>${escapeHtml(stripTerminalFormatting(message) || "もう一度お試しください。")}</span></div>`;
}

async function startAccountLogin() {
  if (!state.connectorReady) {
    await checkConnector();
    if (!state.connectorReady) {
      showToast("Connectorを起動してから接続を再確認してください");
      return;
    }
  }
  const button = $("#connectAccountButton");
  const output = $("#loginOutput");
  $("#accountSetupDialog").classList.add("login-flow-active");
  button.disabled = true;
  button.textContent = "認証を開始中…";
  output.hidden = false;
  renderLoginProgress(output, "");
  try {
    const session = await connector.startLogin(state.setupProvider);
    state.activeLoginId = session.id;
    if (!$("#accountSetupDialog").open) {
      state.activeLoginId = null;
      await connector.cancelLogin(session.id).catch(() => {});
      return;
    }
    const update = async () => {
      const progress = await connector.loginStatus(session.id);
      if (!$("#accountSetupDialog").open) return true;
      renderLoginProgress(output, progress.output || "");
      if (progress.status === "completed") {
        if (state.loginTimer) clearInterval(state.loginTimer);
        state.loginTimer = null;
        state.activeLoginId = null;
        button.textContent = "接続完了";
        renderLoginResult(output, true);
        showToast("アカウントを追加しました");
        await loadData(true);
        return true;
      }
      if (["failed", "cancelled", "expired"].includes(progress.status)) {
        if (state.loginTimer) clearInterval(state.loginTimer);
        state.loginTimer = null;
        state.activeLoginId = null;
        button.disabled = false;
        button.textContent = "もう一度接続する";
        renderLoginResult(output, false, progress.output);
        return true;
      }
      return false;
    };
    const finished = await update();
    if (!finished) state.loginTimer = setInterval(() => void update().catch(() => {}), 1200);
  } catch (error) {
    if (!$("#accountSetupDialog").open) return;
    renderLoginResult(output, false, error.message);
    button.disabled = false;
    button.textContent = setupGuide(state.setupProvider)?.actionLabel || "接続する";
  }
}

async function openDisconnectDialog(accountId) {
  const account = state.data.accounts?.find(item => item.id === accountId);
  if (!account?.managedConnectionIds?.length) return;
  state.disconnectAccountId = accountId;
  state.disconnectReturnFocus = document.activeElement;
  const count = account.managedConnectionIds.length;
  $("#disconnectAccountSummary").innerHTML = `<span class="provider-icon">${providerLogo(account.provider)}</span><div><b>${escapeHtml(account.providerName)}</b><span>${escapeHtml(account.email || account.label)}</span></div>`;
  $("#disconnectDialogCopy").textContent = account.hasAmbientConnection
    ? `Capacity Atlasで追加した${count}件の重複接続を削除し、標準接続だけを残します。`
    : `Capacity Atlasで追加したこの接続を削除します。後から再接続できます。`;
  $("#confirmDisconnectButton").textContent = account.hasAmbientConnection && count > 1 ? `${count}件の重複を整理` : "接続解除";
  $("#disconnectDialog").showModal();
  $("#cancelDisconnectButton").focus();
}

function closeDisconnectDialog() {
  $("#disconnectDialog").close();
}

function handleDisconnectDialogClosed() {
  state.disconnectAccountId = null;
  state.disconnectReturnFocus?.focus?.();
  state.disconnectReturnFocus = null;
}

async function confirmDisconnect() {
  if (!state.disconnectAccountId) return;
  const button = $("#confirmDisconnectButton");
  button.disabled = true;
  button.textContent = "解除しています…";
  try {
    const result = await connector.disconnectAccount(state.disconnectAccountId);
    closeDisconnectDialog();
    await loadData(false);
    showToast(result.cleanupPending
      ? "接続は解除しました。認証フォルダの清掃は次回もう一度試します"
      : result.removed > 1 ? `${result.removed}件の重複接続を整理しました` : "接続を解除しました");
  } catch (error) {
    showToast(error.message || "接続を解除できませんでした");
  } finally {
    button.disabled = false;
  }
}

async function loadData(force = false) {
  const button = $("#refreshButton");
  button.classList.add("loading");
  try {
    const health = await connector.health();
    if (!connectorIsCompatible(health)) {
      state.connectorOutdated = true;
      throw new Error("outdated Connector");
    }
    state.data = force ? await connector.refresh() : await connector.status();
    state.connectorReady = true;
    state.connectorOutdated = false;
    setConnection("live", "Connector接続済み");
  } catch {
    state.data = { accounts: [], collectedAt: null };
    state.connectorReady = false;
    setConnection("demo", state.connectorOutdated ? "Connector更新が必要" : "Connector未接続");
  } finally {
    state.countdown = 60;
    button.classList.remove("loading");
    render();
    if (force) showToast(state.connectorReady ? "最新の残容量へ更新しました" : "Connectorへ接続できませんでした");
  }
}

$("#filters").addEventListener("click", event => {
  const button = event.target.closest("button[data-provider]");
  if (!button) return;
  state.provider = button.dataset.provider;
  document.querySelectorAll(".filter").forEach(item => item.classList.toggle("active", item === button));
  render();
});
$("#providerChoices").addEventListener("click", event => {
  const button = event.target.closest("button[data-setup-provider]");
  if (button) renderSetupGuide(button.dataset.setupProvider);
});
$("#providerChoices").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...document.querySelectorAll(".provider-choice")];
  const currentIndex = Math.max(0, tabs.indexOf(document.activeElement));
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
    ? tabs.length - 1
    : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  const next = tabs[nextIndex];
  renderSetupGuide(next.dataset.setupProvider);
  next.focus();
});
$("#addAccountButton").addEventListener("click", () => void openSetupDialog());
$("#closeSetupDialog").addEventListener("click", closeSetupDialog);
$("#cancelSetupDialog").addEventListener("click", closeSetupDialog);
$("#accountSetupDialog").addEventListener("close", handleSetupDialogClosed);
$("#connectAccountButton").addEventListener("click", startAccountLogin);
$("#loginOutput").addEventListener("click", event => {
  const button = event.target.closest("button[data-auth-url]");
  if (!button) return;
  const url = button.dataset.authUrl;
  const code = button.dataset.authCode;
  window.open(url, "_blank", "noopener,noreferrer");
  if (!code) {
    button.textContent = loginOpenedLabel(state.setupProvider);
    return;
  }
  navigator.clipboard.writeText(code).then(() => {
    button.textContent = "コピーしました。OpenAI画面へ進んでください";
    showToast("ワンタイムコードをコピーしました");
  }).catch(() => {
    const field = document.createElement("textarea");
    field.value = code;
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
    showToast("ワンタイムコードをコピーしました");
  });
});
$("#accountGrid").addEventListener("click", event => {
  const button = event.target.closest("button[data-disconnect-account]");
  if (button) void openDisconnectDialog(button.dataset.disconnectAccount);
});
$("#closeDisconnectDialog").addEventListener("click", closeDisconnectDialog);
$("#cancelDisconnectButton").addEventListener("click", closeDisconnectDialog);
$("#confirmDisconnectButton").addEventListener("click", confirmDisconnect);
$("#disconnectDialog").addEventListener("close", handleDisconnectDialogClosed);
$("#disconnectDialog").addEventListener("click", event => { if (event.target === event.currentTarget) closeDisconnectDialog(); });
$("#accountSetupDialog").addEventListener("click", event => { if (event.target === event.currentTarget) closeSetupDialog(); });
$("#refreshButton").addEventListener("click", () => loadData(true));

setInterval(() => {
  if (!state.connectorReady) {
    $("#nextRefresh").textContent = "—";
    return;
  }
  state.countdown -= 1;
  if (state.countdown <= 0) loadData(false);
  $("#nextRefresh").textContent = Math.max(0, state.countdown);
}, 1000);

renderSetupGuide("codex");
loadData(false);
