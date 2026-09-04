import { sanitizeAdoptionEvent } from "../public/adoption-analytics.js";

const LOCAL_ORIGINS = new Set([
  "http://127.0.0.1:4174",
  "http://localhost:4174",
  "http://[::1]:4174"
]);
const ANONYMOUS_HEADERS = Object.freeze({
  "user-agent": "CapacityAtlasConnector/0.9.3",
  "x-forwarded-for": "0.0.0.0"
});

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Origin");
}

function parseBody(body) {
  if (body && typeof body === "object") {
    try {
      return JSON.stringify(body).length <= 2048 ? body : null;
    } catch {
      return null;
    }
  }
  if (typeof body !== "string" || body.length > 2048) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function createRateLimiter({ limit = 60, windowMs = 60_000, maxBuckets = 1024, now = Date.now } = {}) {
  const buckets = new Map();
  return function allowRequest(req) {
    const forwarded = req.headers?.["x-forwarded-for"];
    const address = Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || "unknown";
    const key = String(address).slice(0, 256);
    const timestamp = now();
    const current = buckets.get(key);
    if (!current || timestamp - current.startedAt >= windowMs) {
      if (!current && buckets.size >= maxBuckets) {
        for (const [bucketKey, bucket] of buckets) {
          if (timestamp - bucket.startedAt >= windowMs) buckets.delete(bucketKey);
        }
        if (buckets.size >= maxBuckets) buckets.delete(buckets.keys().next().value);
      }
      buckets.set(key, { startedAt: timestamp, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
}

const defaultRateLimiter = createRateLimiter();

export function createAdoptionEventHandler({ track, allowRequest = defaultRateLimiter }) {
  return async function adoptionEventHandler(req, res) {
    const origin = req.headers?.origin;
    if (!LOCAL_ORIGINS.has(origin)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    setCors(res, origin);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST, OPTIONS");
      res.end("Method Not Allowed");
      return;
    }
    if (!allowRequest(req)) {
      res.statusCode = 429;
      res.setHeader("Retry-After", "60");
      res.end("Too Many Requests");
      return;
    }

    const body = parseBody(req.body);
    const event = sanitizeAdoptionEvent(body?.name, body?.data);
    if (!event) {
      res.statusCode = 400;
      res.end("Invalid event");
      return;
    }

    try {
      await track(event.name, event.data, { headers: ANONYMOUS_HEADERS });
    } catch {
      // Adoption telemetry must never block normal product use.
    }
    res.statusCode = 204;
    res.end();
  };
}

let trackerPromise;
async function trackWithVercel(...args) {
  trackerPromise ||= import("@vercel/analytics/server").then(module => module.track);
  const track = await trackerPromise;
  return track(...args);
}

export default createAdoptionEventHandler({ track: trackWithVercel });
