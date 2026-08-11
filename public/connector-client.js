export function readConnectorToken({
  location = globalThis.location,
  storage = globalThis.sessionStorage,
  history = globalThis.history
} = {}) {
  const key = "capacity-atlas-token";
  const valid = value => typeof value === "string" && /^[A-Za-z0-9_-]{20,256}$/.test(value);
  let launched = null;
  try {
    const parameters = new URLSearchParams(String(location?.hash || "").replace(/^#/, ""));
    launched = parameters.get("token");
    if (launched !== null) {
      history?.replaceState?.(null, "", `${location?.pathname || "/"}${location?.search || ""}`);
    }
  } catch {}
  if (valid(launched)) {
    try { storage?.setItem?.(key, launched); } catch {}
    return launched;
  }
  try {
    const stored = storage?.getItem?.(key);
    return valid(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function connectorBase(location = globalThis.location) {
  return ["127.0.0.1", "localhost"].includes(location?.hostname) ? "" : "http://127.0.0.1:4174";
}

export function connectorIsCompatible(health, minimum = "0.7.4") {
  if (!health?.ready || !/^\d+\.\d+\.\d+$/.test(health.version || "")) return false;
  const current = health.version.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (current[index] > required[index]) return true;
    if (current[index] < required[index]) return false;
  }
  return true;
}

export function createConnectorClient({ base = connectorBase(), fetch = globalThis.fetch, token = readConnectorToken() } = {}) {
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        cache: "no-store",
        mode: base ? "cors" : "same-origin",
        ...options,
        headers: {
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(token ? { "x-capacity-atlas-token": token } : {}),
          ...(options.headers || {})
        }
      });
    } catch {
      throw new Error("Capacity Atlas Connectorへ接続できません。");
    }
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("application/json")) {
      throw new Error("Capacity Atlas Connectorから有効な応答を取得できません。");
    }
    return response.json();
  }

  return {
    url: base || globalThis.location?.origin || "http://127.0.0.1:4174",
    authorized: Boolean(token),
    health: () => request("/api/health"),
    status: () => request("/api/status"),
    refresh: () => request("/api/refresh", { method: "POST" }),
    startLogin: provider => request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ provider })
    }),
    disconnectAccount: id => request(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    loginStatus: id => request(`/api/login/${encodeURIComponent(id)}`),
    cancelLogin: id => request(`/api/login/${encodeURIComponent(id)}`, { method: "DELETE" })
  };
}
