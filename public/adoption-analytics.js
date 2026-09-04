const EVENT_PROPERTIES = Object.freeze({
  download_clicked: Object.freeze({ os: new Set(["macos", "windows"]), location: new Set(["welcome", "dialog"]) }),
  connector_ready: Object.freeze({}),
  oauth_started: Object.freeze({ provider: new Set(["codex", "claude", "grok"]) }),
  oauth_completed: Object.freeze({ provider: new Set(["codex", "claude", "grok"]) }),
  oauth_failed: Object.freeze({ provider: new Set(["codex", "claude", "grok"]) }),
  dashboard_ready: Object.freeze({})
});

function safeProperties(eventName, properties) {
  const rules = EVENT_PROPERTIES[eventName];
  const safe = {};
  for (const [key, allowed] of Object.entries(rules)) {
    if (allowed.has(properties?.[key])) safe[key] = properties[key];
  }
  return safe;
}

const ANALYTICS_HOST = "capacity-atlas.vercel.app";
const ANALYTICS_SCRIPT = "/_vercel/insights/script.js";
const ADOPTION_ENDPOINT = `https://${ANALYTICS_HOST}/api/adoption-event`;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function initializeLocalRelay(window) {
  if (!window || window.navigator?.doNotTrack === "1" || typeof window.fetch !== "function") return false;
  window.va = (command, payload) => {
    if (command !== "event" || !payload?.name) return;
    void window.fetch(ADOPTION_ENDPOINT, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => {});
  };
  return true;
}

export function initializeAdoptionAnalytics({
  hostname = globalThis.location?.hostname,
  window = globalThis.window,
  document = globalThis.document
} = {}) {
  if (LOCAL_HOSTS.has(hostname)) return initializeLocalRelay(window);
  if (hostname !== ANALYTICS_HOST || !window || !document) return false;
  if (!window.va) {
    window.va = (...params) => {
      window.vaq = window.vaq || [];
      window.vaq.push(params);
    };
  }
  if (!document.head.querySelector(`script[src="${ANALYTICS_SCRIPT}"]`)) {
    const script = document.createElement("script");
    script.src = ANALYTICS_SCRIPT;
    script.defer = true;
    script.dataset.sdkn = "capacity-atlas";
    document.head.appendChild(script);
  }
  return true;
}

export function sanitizeAdoptionEvent(eventName, properties = {}) {
  if (!Object.hasOwn(EVENT_PROPERTIES, eventName)) return null;
  const data = safeProperties(eventName, properties);
  return Object.keys(data).length ? { name: eventName, data } : { name: eventName };
}

export function trackAdoptionEvent(eventName, properties = {}, analytics = globalThis.window?.va) {
  const event = sanitizeAdoptionEvent(eventName, properties);
  if (!event || typeof analytics !== "function") return false;
  analytics("event", event);
  return true;
}
