import { accountTone, deriveSummary, primaryQuota, visibleProviders } from "./model.js?v=0.8.0";
import { loginOpenedLabel, setupGuide } from "./setup-model.js?v=0.8.0";
import { connectorIsCompatible, createConnectorClient } from "./connector-client.js?v=0.8.0";
import { parseBrowserLogin, parseDeviceLogin, stripTerminalFormatting } from "./login-output-model.js?v=0.8.0";
import { applyTranslations, normalizeLocale, translate } from "./i18n.js?v=0.8.0";

const connector = createConnectorClient();
const LOCALE_KEY = "capacity-atlas-locale";
function initialLocale() {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_KEY) || navigator.language);
  } catch {
    return normalizeLocale(navigator.language);
  }
}
const state = { data: { accounts: [], collectedAt: null }, provider: "all", countdown: 60, setupProvider: "codex", connectorReady: false, connectorOutdated: false, loginTimer: null, activeLoginId: null, disconnectAccountId: null, setupReturnFocus: null, disconnectReturnFocus: null, locale: initialLocale() };
const $ = selector => document.querySelector(selector);
const t = (key, params = {}) => translate(key, params, state.locale);
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
  if (!value) return t("time.none");
  return new Intl.DateTimeFormat(state.locale === "ja" ? "ja-JP" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatReset(value) {
  if (!value) return t("reset.notAvailable");
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 0) return t("reset.pending");
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (days) return t("reset.daysHours", { days, hours: remainingHours });
  if (hours) return t("reset.hoursMinutes", { hours, minutes: Math.floor((ms % 3_600_000) / 60_000) });
  return t("reset.minutes", { minutes });
}

function statusLabel(status) {
  return ({ healthy: t("status.healthy"), connected: t("status.connected"), auth_required: t("status.auth_required"), unavailable: t("status.error") })[status] || t("status.unknown");
}

function localizedMessage(account) {
  const message = account.message || t("message.default");
  if (/OAuth token expired|claude login/i.test(message)) return t("message.claudeExpired");
  if (/not logged in|authentication|unauthorized/i.test(message)) return t("message.auth");
  if (/rate limited|too many requests|429/i.test(message)) return account.status === "connected"
    ? t("message.rateConnected")
    : t("message.rate");
  if (/timeout|network/i.test(message)) return t("message.network");
  return message;
}

function disconnectControl(account) {
  const managedCount = account.managedConnectionIds?.length || 0;
  if (!managedCount) return "";
  const label = account.hasAmbientConnection ? t("disconnect.mergeAction") : t("disconnect.action");
  return `<button class="disconnect-button" type="button" data-disconnect-account="${escapeHtml(account.id)}">${label}</button>`;
}

function connectionBadge(account) {
  return account.duplicateConnections > 1
    ? `<span class="duplicate-badge">${t("account.duplicateBadge", { count: account.duplicateConnections })}</span>`
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
      <div class="error-state"><strong>${account.status === "auth_required" ? t("account.reconnect") : account.status === "connected" ? t("account.collecting") : t("account.unavailable")}</strong><p>${escapeHtml(localizedMessage(account))}</p></div>
      <div class="card-foot"><span>${escapeHtml(account.source || t("account.localSource"))}</span><div class="card-foot-actions"><span>${formatTime(account.updatedAt)}</span>${disconnectControl(account)}</div></div>
    </article>`;
  }
  return `<article class="account-card provider-card provider-${account.provider}" style="--accent:${accent}">
    <div class="card-head"><div class="provider-lockup"><span class="provider-icon">${providerLogo(account.provider)}</span><div class="provider-meta"><b>${escapeHtml(account.providerName)}</b><span>${escapeHtml(identity)}</span>${connectionBadge(account)}</div></div><span class="status-pill"><i></i>${status}</span></div>
    <div class="quota-row"><div class="quota-number">${Math.round(quota.remainingPercent)}<small>%</small></div><div class="quota-label">${t("account.remaining")}<b>${escapeHtml(account.plan || t("account.connectedPlan"))}</b></div></div>
    <div class="progress"><span style="--value:${quota.remainingPercent}%"></span></div>
    <div class="window-meta"><span>${escapeHtml(quota.title || quota.kind)}</span><span>${formatReset(quota.resetsAt)}</span></div>
    <div class="card-foot"><span>${escapeHtml(account.source || t("account.localSource"))}</span><div class="card-foot-actions"><span>${t("account.updated", { time: formatTime(account.updatedAt) })}</span>${disconnectControl(account)}</div></div>
  </article>`;
}

function render() {
  const accounts = state.data?.accounts || [];
  const providers = visibleProviders(accounts);
  if (state.provider !== "all" && !providers.includes(state.provider)) state.provider = "all";
  const filtered = state.provider === "all" ? accounts : accounts.filter(account => account.provider === state.provider);
  document.querySelectorAll(".provider-filter").forEach(button => { button.hidden = !providers.includes(button.dataset.provider); });
  const filters = $("#filters");
  filters.hidden = providers.length < 2;
  const legend = document.querySelector(".provider-legend");
  legend.hidden = providers.length === 0;
  document.querySelectorAll("[data-provider-mark]").forEach(mark => { mark.hidden = !providers.includes(mark.dataset.providerMark); });
  const summary = deriveSummary(accounts);
  $("#totalAccounts").textContent = summary.total;
  $("#providerCount").textContent = summary.providers ? t("summary.services", { count: summary.providers }) : t("summary.servicesUnknown");
  $("#averageRemaining").textContent = summary.averageRemaining == null ? "—" : `${summary.averageRemaining}%`;
  $("#attentionCount").textContent = summary.attention;
  $("#lastSync").textContent = state.data?.collectedAt ? formatTime(state.data.collectedAt) : "—";
  const lastSyncTop = $("#lastSyncTop");
  if (lastSyncTop) lastSyncTop.textContent = state.data?.collectedAt ? t("sync.last", { time: formatTime(state.data.collectedAt) }) : t("sync.checking");
  $("#dataMode").textContent = state.connectorReady ? t("summary.dataLocal") : t("summary.dataWaiting");
  $("#autoUpdateState").lastChild.textContent = state.connectorReady ? t("refresh.auto") : t("refresh.waiting");
  $("#nextRefresh").textContent = state.connectorReady ? state.countdown : "—";
  $("#nextRefreshLabel").textContent = state.connectorReady ? t("refresh.seconds") : t("refresh.afterConnector");
  const emptyMessage = state.connectorReady ? t("account.empty.ready") : t("account.empty.connector");
  $("#accountGrid").innerHTML = filtered.length
    ? filtered.map(accountCard).join("")
    : `<div class="empty"><strong>${t("account.empty.title")}</strong><p>${emptyMessage}</p></div>`;
  $("#statusTable").innerHTML = filtered.length ? filtered.map(account => {
    const color = account.status === "healthy" ? "#50d8a1" : account.status === "connected" ? COLORS[account.provider] : account.status === "auth_required" ? "#f0b45a" : "#ff6b75";
    return `<tr><td class="provider-cell" data-label="${t("table.service")}">${escapeHtml(account.providerName)}</td><td data-label="${t("table.account")}">${escapeHtml(account.email || account.label)}</td><td data-label="${t("table.source")}">${escapeHtml(account.source || "—")}</td><td data-label="${t("table.updated")}">${formatTime(account.updatedAt)}</td><td data-label="${t("table.status")}"><span class="table-status" style="--status-color:${color}">${statusLabel(account.status)}</span></td></tr>`;
  }).join("") : `<tr><td colspan="5" class="table-empty">${t("account.noConnected")}</td></tr>`;
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
  const guide = setupGuide(provider, state.locale);
  if (!guide) return;
  $("#accountSetupDialog").classList.remove("login-flow-active");
  state.setupProvider = provider;
  $("#setupProviderTitle").textContent = guide.title;
  $("#setupCapability").textContent = guide.capability;
  $("#setupSteps").innerHTML = guide.steps.map(step => `<li>${escapeHtml(step)}</li>`).join("");
  $("#setupNote").textContent = guide.note;
  $("#connectAccountButton").textContent = state.connectorOutdated ? t("setup.update") : guide.actionLabel;
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
      $("#connectorTitle").textContent = t("setup.reopenTitle");
      $("#connectorDetail").textContent = t("setup.reopenDetail");
    } else if (!connectorIsCompatible(health)) {
      state.connectorReady = false;
      state.connectorOutdated = true;
      banner.className = "connector-banner missing";
      $("#connectorTitle").textContent = t("setup.outdatedTitle");
      $("#connectorDetail").textContent = t("setup.outdatedDetail", { version: health.version || t("general.unknown") });
    } else {
      state.connectorReady = true;
      state.connectorOutdated = false;
      banner.className = "connector-banner ready";
      $("#connectorTitle").textContent = t("setup.readyTitle");
      $("#connectorDetail").textContent = t("setup.readyDetail");
    }
  } catch {
    state.connectorReady = false;
    state.connectorOutdated = false;
    banner.className = "connector-banner missing";
    $("#connectorTitle").textContent = t("setup.missingTitle");
    $("#connectorDetail").textContent = t("setup.missingDetail");
  }
  installActions.hidden = state.connectorReady;
  const button = $("#connectAccountButton");
  button.disabled = state.connectorOutdated;
  button.textContent = state.connectorOutdated
    ? t("setup.update")
    : state.connectorReady
    ? (setupGuide(state.setupProvider, state.locale)?.actionLabel || t("setup.connect"))
    : t("setup.recheck");
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
    const serviceName = { codex: "OpenAI", claude: "Claude", grok: "Grok" }[state.setupProvider] || t("general.aiService");
    const accountName = { codex: "OpenAI", claude: "Anthropic", grok: "xAI" }[state.setupProvider] || serviceName;
    element.className = "login-output guided-login";
    element.innerHTML = `<div class="login-ready-mark">${t("login.opened", { service: serviceName })}</div>
      <ol class="login-easy-steps">
        <li><b>${t("login.signInTitle", { service: serviceName })}</b><span>${t("login.signInDetail", { account: accountName })}</span></li>
        <li><b>${t("login.allowTitle")}</b><span>${t("login.allowDetail")}</span></li>
        <li><b>${t("login.returnTitle")}</b><span>${t("login.returnDetail")}</span></li>
      </ol>
      <button type="button" class="login-open-button" data-auth-url="${escapeHtml(browserLogin.url)}">${t("login.openFallback")}</button>
      <details class="login-technical"><summary>${t("login.technical")}</summary><pre>${escapeHtml(browserLogin.clean)}</pre></details>`;
    return true;
  }
  if (parsed.ready) {
    element.className = "login-output guided-login";
    element.innerHTML = `<div class="login-ready-mark">${t("login.deviceReady")}</div>
      <ol class="login-easy-steps">
        <li><b>${t("login.deviceStepTitle")}</b><span>${t("login.deviceStepDetail")}</span></li>
        <li><b>${t("login.pasteTitle")}</b><span>${t("login.pasteDetail")}</span></li>
        <li><b>${t("login.returnTitle")}</b><span>${t("login.returnDeviceDetail")}</span></li>
      </ol>
      <div class="device-code"><span>${t("login.oneTimeCode")}</span><strong>${escapeHtml(parsed.code)}</strong></div>
      <button type="button" class="login-open-button" data-auth-url="${escapeHtml(parsed.url)}" data-auth-code="${escapeHtml(parsed.code)}">${t("login.copyAndOpen")}</button>
      <details class="login-technical"><summary>${t("login.technical")}</summary><pre>${escapeHtml(parsed.clean)}</pre></details>`;
    return true;
  }
  element.className = "login-output guided-login login-preparing";
  element.innerHTML = `<div class="login-spinner"></div><div><b>${t("login.preparing")}</b><span>${t("login.wait")}</span></div>`;
  return false;
}

function renderLoginResult(element, success, message) {
  element.hidden = false;
  element.className = `login-output guided-login ${success ? "login-success" : "login-failed"}`;
  element.innerHTML = success
    ? `<div class="login-result-icon">✓</div><div><b>${t("login.successTitle")}</b><span>${t("login.successDetail")}</span></div>`
    : `<div class="login-result-icon">!</div><div><b>${t("login.failedTitle")}</b><span>${escapeHtml(stripTerminalFormatting(message) || t("login.tryAgain"))}</span></div>`;
}

async function startAccountLogin() {
  if (!state.connectorReady) {
    await checkConnector();
    if (!state.connectorReady) {
      showToast(t("toast.connectorFirst"));
      return;
    }
  }
  const button = $("#connectAccountButton");
  const output = $("#loginOutput");
  $("#accountSetupDialog").classList.add("login-flow-active");
  button.disabled = true;
  button.textContent = t("setup.starting");
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
        button.textContent = t("setup.completed");
        renderLoginResult(output, true);
        showToast(t("toast.accountAdded"));
        await loadData(true);
        return true;
      }
      if (["failed", "cancelled", "expired"].includes(progress.status)) {
        if (state.loginTimer) clearInterval(state.loginTimer);
        state.loginTimer = null;
        state.activeLoginId = null;
        button.disabled = false;
        button.textContent = t("setup.retry");
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
    button.textContent = setupGuide(state.setupProvider, state.locale)?.actionLabel || t("setup.connect");
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
    ? t("disconnect.ambientCopy", { count })
    : t("disconnect.addedCopy");
  $("#confirmDisconnectButton").textContent = account.hasAmbientConnection && count > 1 ? t("disconnect.mergeAction", { count }) : t("disconnect.action");
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
  button.textContent = t("disconnect.removing");
  try {
    const result = await connector.disconnectAccount(state.disconnectAccountId);
    closeDisconnectDialog();
    await loadData(false);
    showToast(result.cleanupPending
      ? t("disconnect.cleanupPending")
      : result.removed > 1 ? t("disconnect.merged", { count: result.removed }) : t("disconnect.removed"));
  } catch (error) {
    showToast(error.message || t("disconnect.failed"));
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
    setConnection("live", t("connection.ready"));
  } catch {
    state.data = { accounts: [], collectedAt: null };
    state.connectorReady = false;
    setConnection("demo", state.connectorOutdated ? t("connection.updateRequired") : t("connection.notConnected"));
  } finally {
    state.countdown = 60;
    button.classList.remove("loading");
    render();
    if (force) showToast(state.connectorReady ? t("toast.refreshed") : t("toast.connectorFailed"));
  }
}

function applyLocale(locale, persist = false) {
  state.locale = normalizeLocale(locale);
  document.documentElement.lang = state.locale;
  document.title = t("meta.title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("meta.description"));
  applyTranslations(document, state.locale);
  const languageButton = $("#languageButton");
  languageButton.querySelector("span").textContent = t("language.short");
  languageButton.setAttribute("aria-label", t("language.switch"));
  if (persist) {
    try { localStorage.setItem(LOCALE_KEY, state.locale); } catch {}
  }
  renderSetupGuide(state.setupProvider);
  render();
  setConnection(state.connectorReady ? "live" : "demo", state.connectorReady ? t("connection.ready") : state.connectorOutdated ? t("connection.updateRequired") : t("connection.notConnected"));
  delete document.documentElement.dataset.localePending;
}

$("#languageButton").addEventListener("click", () => {
  applyLocale(state.locale === "ja" ? "en" : "ja", true);
  void checkConnector();
});

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
    button.textContent = loginOpenedLabel(state.setupProvider, state.locale);
    return;
  }
  navigator.clipboard.writeText(code).then(() => {
    button.textContent = t("login.copiedContinue");
    showToast(t("toast.codeCopied"));
  }).catch(() => {
    const field = document.createElement("textarea");
    field.value = code;
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
    showToast(t("toast.codeCopied"));
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

applyLocale(state.locale);
loadData(false);
