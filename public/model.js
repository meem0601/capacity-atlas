export function primaryQuota(account) {
  const windows = Array.isArray(account?.windows) ? account.windows : [];
  return windows.reduce((lowest, current) => {
    if (!lowest) return current;
    return current.remainingPercent < lowest.remainingPercent ? current : lowest;
  }, null);
}

export function visibleProviders(accounts = []) {
  const supported = new Set(["codex", "claude", "grok"]);
  return [...new Set(accounts.map(account => account?.provider).filter(provider => supported.has(provider)))].sort((a, b) => ["codex", "claude", "grok"].indexOf(a) - ["codex", "claude", "grok"].indexOf(b));
}

export function deriveSummary(accounts = []) {
  const quotas = accounts.map(primaryQuota).filter(Boolean);
  const averageRemaining = quotas.length
    ? Math.round(quotas.reduce((sum, quota) => sum + quota.remainingPercent, 0) / quotas.length)
    : null;
  return {
    total: accounts.length,
    providers: new Set(accounts.map(account => account.provider)).size,
    attention: accounts.filter(account => account.status !== "healthy" || (primaryQuota(account)?.remainingPercent ?? 100) < 20).length,
    averageRemaining
  };
}

export function accountTone(account) {
  if (account.status === "connected") return "neutral";
  if (account.status !== "healthy") return "danger";
  const remaining = primaryQuota(account)?.remainingPercent;
  if (remaining == null) return "neutral";
  if (remaining < 20) return "danger";
  if (remaining < 45) return "warning";
  return "healthy";
}
