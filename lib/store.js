// Shared helpers + storage abstraction for the album API.
// Works with EITHER Supabase/Postgres OR Upstash Redis — whichever is configured.
import crypto from 'node:crypto';

/* ----------------- backend detection ----------------- */
function pgUrl() {
  // Prefer the DIRECT (non-pooling) connection: writes persist reliably from serverless.
  return process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL ||
         process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL || null;
}
function redisCreds() {
  const e = process.env;
  let url = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL;
  let token = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  if (!url) { const k = Object.keys(e).find(k => k.endsWith('REST_API_URL') && e[k]); if (k) url = e[k]; }
  if (!token) { const k = Object.keys(e).find(k => k.endsWith('REST_API_TOKEN') && !k.includes('READ_ONLY') && e[k]); if (k) token = e[k]; }
  return url && token ? { url, token } : null;
}
function backend() {
  if (pgUrl()) return 'pg';
  if (redisCreds()) return 'redis';
  return null;
}
function noDb() { const e = new Error('DB_NOT_CONFIGURED'); e.code = 'DB_NOT_CONFIGURED'; return e; }

/* ----------------- Postgres ----------------- */
let _sql = null, _schemaReady = false;
async function pg() {
  if (!_sql) {
    const { default: postgres } = await import('postgres');
    _sql = postgres(pgUrl(), { ssl: 'require', prepare: false, max: 1, idle_timeout: 20, connect_timeout: 15 });
  }
  if (!_schemaReady) {
    await _sql`CREATE TABLE IF NOT EXISTS album_users (
      name_key text PRIMARY KEY, display text NOT NULL, salt text NOT NULL,
      pin text NOT NULL, created bigint)`;
    await _sql`CREATE TABLE IF NOT EXISTS album_progress (
      name_key text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}'::jsonb, ts bigint)`;
    await _sql`CREATE TABLE IF NOT EXISTS album_trades (
      id text PRIMARY KEY,
      from_key text NOT NULL,
      to_key text NOT NULL,
      gives jsonb NOT NULL,
      takes jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      messages jsonb NOT NULL DEFAULT '[]'::jsonb,
      completed_by jsonb NOT NULL DEFAULT '[]'::jsonb,
      created bigint NOT NULL,
      updated bigint NOT NULL)`;
    await _sql`CREATE INDEX IF NOT EXISTS album_trades_to_idx ON album_trades (to_key, updated DESC)`;
    await _sql`CREATE INDEX IF NOT EXISTS album_trades_from_idx ON album_trades (from_key, updated DESC)`;
    _schemaReady = true;
  }
  return _sql;
}

/* ----------------- Redis ----------------- */
let _redis = null;
async function rds() {
  if (_redis) return _redis;
  const { Redis } = await import('@upstash/redis');
  _redis = new Redis(redisCreds());
  return _redis;
}

/* ----------------- storage API ----------------- */
export async function getUser(key) {
  const b = backend(); if (!b) throw noDb();
  if (b === 'pg') {
    const s = await pg();
    const rows = await s`SELECT display, salt, pin FROM album_users WHERE name_key = ${key}`;
    return rows[0] || null;
  }
  const r = await rds(); return (await r.get('user:' + key)) || null;
}
// Returns true if user was created, false if name was already taken (race-safe).
export async function createUser(key, rec) {
  const b = backend(); if (!b) throw noDb();
  if (b === 'pg') {
    const s = await pg();
    const rows = await s`INSERT INTO album_users (name_key, display, salt, pin, created)
                         VALUES (${key}, ${rec.display}, ${rec.salt}, ${rec.pin}, ${rec.created})
                         ON CONFLICT (name_key) DO NOTHING
                         RETURNING name_key`;
    return rows.length > 0;
  }
  const r = await rds();
  // NX = only set if absent → atomic claim of the name
  const ok = await r.set('user:' + key, rec, { nx: true });
  if (!ok) return false;
  await r.set('progress:' + key, { counts: {}, names: {}, ts: 0 });
  return true;
}
export async function getProgress(key) {
  const b = backend(); if (!b) throw noDb();
  if (b === 'pg') {
    const s = await pg();
    const rows = await s`SELECT data FROM album_progress WHERE name_key = ${key}`;
    return rows[0] ? rows[0].data : { counts: {}, names: {} };
  }
  const r = await rds(); return (await r.get('progress:' + key)) || { counts: {}, names: {} };
}
// Last-Write-Wins on the server: an out-of-order POST with an older ts is ignored.
// Returns the final stored ts (so the client can confirm).
export async function setProgress(key, data) {
  const b = backend(); if (!b) throw noDb();
  const ts = (data && typeof data.ts === 'number') ? data.ts : Date.now();
  data = { ...data, ts };
  if (b === 'pg') {
    const s = await pg();
    const rows = await s`INSERT INTO album_progress (name_key, data, ts)
            VALUES (${key}, ${s.json(data)}, ${ts})
            ON CONFLICT (name_key) DO UPDATE
              SET data = EXCLUDED.data, ts = EXCLUDED.ts
              WHERE album_progress.ts <= EXCLUDED.ts
            RETURNING ts`;
    if (rows.length) return rows[0].ts;
    const cur = await s`SELECT ts FROM album_progress WHERE name_key = ${key}`;
    return cur[0] ? cur[0].ts : ts;
  }
  const r = await rds();
  const cur = await r.get('progress:' + key);
  if (cur && typeof cur.ts === 'number' && cur.ts > ts) return cur.ts;
  await r.set('progress:' + key, data);
  return ts;
}

// Returns [{ name_key, display, counts }] for every user with progress (for matchmaking).
// Always excludes the requesting user (passed in) so we don't ship them their own row.
export async function getAllProgress(excludeKey) {
  const b = backend(); if (!b) throw noDb();
  const out = [];
  if (b === 'pg') {
    const s = await pg();
    const rows = await s`
      SELECT u.name_key AS name_key, u.display AS display, p.data AS data
      FROM album_users u JOIN album_progress p ON p.name_key = u.name_key
      WHERE u.name_key <> ${excludeKey || ''}`;
    for (const r of rows) {
      const counts = (r.data && r.data.counts) || {};
      if (Object.keys(counts).length) out.push({ name_key: r.name_key, display: r.display, counts });
    }
    return out;
  }
  // Redis: scan keys "progress:*"
  const r = await rds();
  const all = [];
  let cursor = 0;
  do {
    const [next, keys] = await r.scan(cursor, { match: 'progress:*', count: 200 });
    cursor = Number(next);
    for (const k of keys) {
      const nk = k.slice('progress:'.length);
      if (nk === excludeKey) continue;
      all.push(nk);
    }
  } while (cursor !== 0);
  for (const nk of all) {
    const p = await r.get('progress:' + nk);
    const counts = (p && p.counts) || {};
    if (!Object.keys(counts).length) continue;
    const u = await r.get('user:' + nk);
    out.push({ name_key: nk, display: (u && u.display) || nk, counts });
  }
  return out;
}

/* ----------------- trades ----------------- */
function newId() { return crypto.randomBytes(9).toString('base64url'); }

export async function createTrade({ fromKey, toKey, gives, takes }) {
  const b = backend(); if (!b) throw noDb();
  const now = Date.now();
  const id = newId();
  const trade = { id, from_key: fromKey, to_key: toKey, gives, takes,
    status: 'pending', messages: [], completed_by: [], created: now, updated: now };
  if (b === 'pg') {
    const s = await pg();
    await s`INSERT INTO album_trades (id, from_key, to_key, gives, takes, status, messages, completed_by, created, updated)
            VALUES (${id}, ${fromKey}, ${toKey}, ${s.json(gives)}, ${s.json(takes)}, 'pending', ${s.json([])}, ${s.json([])}, ${now}, ${now})`;
    return trade;
  }
  const r = await rds();
  await r.set('trade:' + id, trade);
  // index by user for fast listing
  await r.zadd('trades:user:' + fromKey, { score: now, member: id });
  await r.zadd('trades:user:' + toKey,   { score: now, member: id });
  return trade;
}

export async function getTrade(id) {
  const b = backend(); if (!b) throw noDb();
  if (b === 'pg') {
    const s = await pg();
    const rows = await s`SELECT id, from_key, to_key, gives, takes, status, messages, completed_by, created, updated
                         FROM album_trades WHERE id = ${id}`;
    return rows[0] || null;
  }
  const r = await rds();
  return (await r.get('trade:' + id)) || null;
}

export async function listTradesFor(key) {
  const b = backend(); if (!b) throw noDb();
  if (b === 'pg') {
    const s = await pg();
    const rows = await s`SELECT id, from_key, to_key, gives, takes, status, messages, completed_by, created, updated
                         FROM album_trades
                         WHERE from_key = ${key} OR to_key = ${key}
                         ORDER BY updated DESC LIMIT 200`;
    return rows;
  }
  const r = await rds();
  const ids = await r.zrange('trades:user:' + key, 0, 199, { rev: true });
  const out = [];
  for (const id of ids) {
    const t = await r.get('trade:' + id);
    if (t) out.push(t);
  }
  return out;
}

// Generic update: caller passes a patch object. Updates 'updated' automatically.
async function updateTrade(id, patch) {
  const b = backend(); if (!b) throw noDb();
  const now = Date.now();
  if (b === 'pg') {
    const s = await pg();
    // Use a single UPDATE with COALESCE only on the fields we touch.
    const fields = [];
    if (patch.status !== undefined)        fields.push(s`status = ${patch.status}`);
    if (patch.messages !== undefined)      fields.push(s`messages = ${s.json(patch.messages)}`);
    if (patch.completed_by !== undefined)  fields.push(s`completed_by = ${s.json(patch.completed_by)}`);
    if (!fields.length) return await getTrade(id);
    // Build dynamic SET using s.unsafe is risky; instead, do conditional updates:
    let updated = await getTrade(id);
    if (!updated) return null;
    const newStatus = patch.status !== undefined ? patch.status : updated.status;
    const newMessages = patch.messages !== undefined ? patch.messages : updated.messages;
    const newCompletedBy = patch.completed_by !== undefined ? patch.completed_by : updated.completed_by;
    await s`UPDATE album_trades
            SET status = ${newStatus},
                messages = ${s.json(newMessages)},
                completed_by = ${s.json(newCompletedBy)},
                updated = ${now}
            WHERE id = ${id}`;
    return await getTrade(id);
  }
  const r = await rds();
  const cur = await r.get('trade:' + id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updated: now };
  await r.set('trade:' + id, next);
  await r.zadd('trades:user:' + cur.from_key, { score: now, member: id });
  await r.zadd('trades:user:' + cur.to_key,   { score: now, member: id });
  return next;
}

// Atomically apply +/-1 to multiple sticker IDs in a user's progress (used on trade completion).
// `delta` is an object { stickerId: +1 | -1, ... }. Never goes below 0.
export async function adjustProgress(key, delta) {
  const b = backend(); if (!b) throw noDb();
  const p = (await getProgress(key)) || { counts: {}, names: {} };
  const counts = { ...(p.counts || {}) };
  for (const id of Object.keys(delta)) {
    const next = (counts[id] || 0) + delta[id];
    if (next <= 0) delete counts[id]; else counts[id] = next;
  }
  const data = { counts, names: p.names || {}, showCodes: !!p.showCodes, ts: Date.now() };
  await setProgress(key, data);
  return data;
}

export { updateTrade };

// Atomic "complete" for a trade.
//   byKey = user calling complete.
// Returns one of:
//   { half: true, trade }                      → first confirm, waiting peer
//   { applied: true, trade }                   → both confirmed and swap applied
//   { error: 'missing_gives'|'missing_takes', missing:[ids], trade }
//   { error: 'wrong_status'|'not_party', trade? }
// Idempotent: calling twice from the same user does not double-add and does not double-apply.
export async function completeTradeAtomic(id, byKey) {
  const b = backend(); if (!b) throw noDb();
  if (b === 'pg') {
    const s = await pg();
    return await s.begin(async sql => {
      const rows = await sql`SELECT id, from_key, to_key, gives, takes, status, messages, completed_by, created
                             FROM album_trades WHERE id = ${id} FOR UPDATE`;
      const t = rows[0];
      if (!t) return { error: 'not_found' };
      if (t.from_key !== byKey && t.to_key !== byKey) return { error: 'not_party' };
      if (t.status === 'completed') {
        // Idempotent — already done.
        return { applied: false, alreadyDone: true, trade: t };
      }
      if (t.status !== 'accepted' && t.status !== 'half_completed') return { error: 'wrong_status', trade: t };

      const cb = new Set(t.completed_by || []);
      const wasMember = cb.has(byKey);
      cb.add(byKey);

      if (cb.size < 2) {
        const now = Date.now();
        const newStatus = 'half_completed';
        const newCB = Array.from(cb);
        await sql`UPDATE album_trades
                  SET status = ${newStatus}, completed_by = ${sql.json(newCB)}, updated = ${now}
                  WHERE id = ${id}`;
        return { half: !wasMember, idempotent: wasMember, trade: { ...t, status: newStatus, completed_by: newCB, updated: now } };
      }

      // Both confirmed — re-validate that each side has the stickers they promised.
      const fromP = await sql`SELECT data FROM album_progress WHERE name_key = ${t.from_key}`;
      const toP   = await sql`SELECT data FROM album_progress WHERE name_key = ${t.to_key}`;
      const fromCounts = (fromP[0] && fromP[0].data && fromP[0].data.counts) || {};
      const toCounts   = (toP[0]   && toP[0].data   && toP[0].data.counts)   || {};
      const missingGives = [], missingTakes = [];
      // Tally how many of each id are needed
      const needFrom = {}, needTo = {};
      for (const x of t.gives) needFrom[x] = (needFrom[x] || 0) + 1;
      for (const x of t.takes) needTo[x]   = (needTo[x]   || 0) + 1;
      for (const k of Object.keys(needFrom)) if ((fromCounts[k] || 0) < needFrom[k]) missingGives.push(k);
      for (const k of Object.keys(needTo))   if ((toCounts[k]   || 0) < needTo[k])   missingTakes.push(k);
      if (missingGives.length || missingTakes.length) {
        return { error: missingGives.length ? 'missing_gives' : 'missing_takes',
                 missing: missingGives.length ? missingGives : missingTakes,
                 trade: t };
      }
      // Apply deltas in-memory and write both progress rows + the trade.
      const fromNew = { counts: { ...fromCounts } };
      const toNew   = { counts: { ...toCounts } };
      for (const x of t.gives) {
        fromNew.counts[x] = fromNew.counts[x] - 1;
        if (fromNew.counts[x] <= 0) delete fromNew.counts[x];
        toNew.counts[x]   = (toNew.counts[x]   || 0) + 1;
      }
      for (const x of t.takes) {
        toNew.counts[x] = toNew.counts[x] - 1;
        if (toNew.counts[x] <= 0) delete toNew.counts[x];
        fromNew.counts[x] = (fromNew.counts[x] || 0) + 1;
      }
      // preserve names/showCodes
      const fromMerged = { counts: fromNew.counts,
                          names: ((fromP[0] && fromP[0].data) || {}).names || {},
                          showCodes: !!((fromP[0] && fromP[0].data) || {}).showCodes,
                          ts: Date.now() };
      const toMerged = { counts: toNew.counts,
                         names: ((toP[0] && toP[0].data) || {}).names || {},
                         showCodes: !!((toP[0] && toP[0].data) || {}).showCodes,
                         ts: Date.now() };
      await sql`INSERT INTO album_progress (name_key, data, ts) VALUES (${t.from_key}, ${sql.json(fromMerged)}, ${fromMerged.ts})
                ON CONFLICT (name_key) DO UPDATE SET data = EXCLUDED.data, ts = EXCLUDED.ts`;
      await sql`INSERT INTO album_progress (name_key, data, ts) VALUES (${t.to_key}, ${sql.json(toMerged)}, ${toMerged.ts})
                ON CONFLICT (name_key) DO UPDATE SET data = EXCLUDED.data, ts = EXCLUDED.ts`;
      const newCB = Array.from(cb);
      const now = Date.now();
      await sql`UPDATE album_trades
                SET status = 'completed', completed_by = ${sql.json(newCB)}, updated = ${now}
                WHERE id = ${id}`;
      return { applied: true, trade: { ...t, status: 'completed', completed_by: newCB, updated: now } };
    });
  }

  // Redis path — best effort (no real locking; revalida tras leer).
  const r = await rds();
  const t = await r.get('trade:' + id);
  if (!t) return { error: 'not_found' };
  if (t.from_key !== byKey && t.to_key !== byKey) return { error: 'not_party' };
  if (t.status === 'completed') return { applied: false, alreadyDone: true, trade: t };
  if (t.status !== 'accepted' && t.status !== 'half_completed') return { error: 'wrong_status', trade: t };

  const cb = new Set(t.completed_by || []);
  const wasMember = cb.has(byKey);
  cb.add(byKey);
  if (cb.size < 2) {
    const now = Date.now();
    const next = { ...t, status: 'half_completed', completed_by: Array.from(cb), updated: now };
    await r.set('trade:' + id, next);
    return { half: !wasMember, idempotent: wasMember, trade: next };
  }
  const fromP = (await r.get('progress:' + t.from_key)) || { counts: {}, names: {} };
  const toP   = (await r.get('progress:' + t.to_key))   || { counts: {}, names: {} };
  const needFrom = {}, needTo = {};
  for (const x of t.gives) needFrom[x] = (needFrom[x] || 0) + 1;
  for (const x of t.takes) needTo[x]   = (needTo[x]   || 0) + 1;
  const missingGives = [], missingTakes = [];
  for (const k of Object.keys(needFrom)) if ((fromP.counts[k] || 0) < needFrom[k]) missingGives.push(k);
  for (const k of Object.keys(needTo))   if ((toP.counts[k]   || 0) < needTo[k])   missingTakes.push(k);
  if (missingGives.length || missingTakes.length) {
    return { error: missingGives.length ? 'missing_gives' : 'missing_takes',
             missing: missingGives.length ? missingGives : missingTakes, trade: t };
  }
  const fromCounts = { ...fromP.counts }, toCounts = { ...toP.counts };
  for (const x of t.gives) { fromCounts[x] -= 1; if (fromCounts[x] <= 0) delete fromCounts[x]; toCounts[x] = (toCounts[x]||0)+1; }
  for (const x of t.takes) { toCounts[x]   -= 1; if (toCounts[x]   <= 0) delete toCounts[x];   fromCounts[x] = (fromCounts[x]||0)+1; }
  const now = Date.now();
  await r.set('progress:' + t.from_key, { counts: fromCounts, names: fromP.names || {}, showCodes: !!fromP.showCodes, ts: now });
  await r.set('progress:' + t.to_key,   { counts: toCounts,   names: toP.names   || {}, showCodes: !!toP.showCodes,   ts: now });
  const newCB = Array.from(cb);
  const next = { ...t, status: 'completed', completed_by: newCB, updated: now };
  await r.set('trade:' + id, next);
  return { applied: true, trade: next };
}

/* ----------------- auth + helpers ----------------- */
const SECRET = process.env.AUTH_SECRET || '';
function secret() {
  if (!SECRET || SECRET.length < 16) {
    const e = new Error('AUTH_SECRET_MISSING'); e.code = 'AUTH_SECRET_MISSING'; throw e;
  }
  return SECRET;
}
export function normName(name) {
  return String(name || '').trim().toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').slice(0, 40);
}
export function cleanName(name) { return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40); }
export function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
export function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
export function signToken(key) {
  const mac = crypto.createHmac('sha256', secret()).update(key).digest('hex');
  return Buffer.from(key).toString('base64url') + '.' + mac;
}
export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, mac] = token.split('.');
  let key; try { key = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return null; }
  let expect;
  try { expect = crypto.createHmac('sha256', secret()).update(key).digest('hex'); } catch { return null; }
  try { if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null; }
  catch { return null; }
  return key;
}
export function authKey(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : h;
  return verifyToken(t);
}
export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
export function dbErrorResponse(res, e) {
  if (e && e.code === 'DB_NOT_CONFIGURED') return res.status(503).json({ error: 'La base de datos no está configurada todavía.' });
  if (e && e.code === 'AUTH_SECRET_MISSING') {
    console.error('AUTH_SECRET missing or too short');
    return res.status(503).json({ error: 'El servidor no está configurado (falta AUTH_SECRET).' });
  }
  console.error('Server error:', e && (e.stack || e.message || e));
  return res.status(500).json({ error: 'Error del servidor.' });
}
