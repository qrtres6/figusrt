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
