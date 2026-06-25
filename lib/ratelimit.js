// Best-effort in-memory rate limiter (per-function-instance).
// Vercel may run multiple instances → real attackers can still get through,
// but it stops casual brute-forcing of PINs (and is good enough for the album).
//
// hits[key] = { count, first }
const hits = new Map();
const MAX_BUCKETS = 5000;

export function check(key, { max, windowMs }) {
  const now = Date.now();
  const cur = hits.get(key);
  if (!cur || now - cur.first > windowMs) {
    hits.set(key, { count: 1, first: now });
    if (hits.size > MAX_BUCKETS) prune(now, windowMs);
    return { ok: true, remaining: max - 1, retryInMs: 0 };
  }
  cur.count++;
  if (cur.count > max) {
    return { ok: false, remaining: 0, retryInMs: cur.first + windowMs - now };
  }
  return { ok: true, remaining: max - cur.count, retryInMs: 0 };
}

function prune(now, windowMs) {
  for (const [k, v] of hits) if (now - v.first > windowMs) hits.delete(k);
}

export function clientIp(req) {
  const h = req.headers || {};
  const xff = h['x-forwarded-for'] || h['x-real-ip'] || '';
  const ip = String(xff).split(',')[0].trim();
  return ip || 'unknown';
}
