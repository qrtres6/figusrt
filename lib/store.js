// Shared helpers + storage abstraction for the album API.
// Works with EITHER Supabase/Postgres OR Upstash Redis — whichever is configured.
import crypto from 'node:crypto';

/* ----------------- backend detection ----------------- */
function pgUrl() {
  return process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL ||
         process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || null;
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
      pin text NOT NULL, progress jsonb NOT NULL DEFAULT '{"counts":{},"names":{}}'::jsonb, created bigint)`;
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
export async function createUser(key, rec) {
  const b = backend(); if (!b) throw noDb();
  if (b === 'pg') {
    const s = await pg();
    await s`INSERT INTO album_users (name_key, display, salt, pin, created)
            VALUES (${key}, ${rec.display}, ${rec.salt}, ${rec.pin}, ${rec.created})`;
    return;
  }
  const r = await rds();
  await r.set('user:' + key, rec);
  await r.set('progress:' + key, { counts: {}, names: {} });
}
export async function getProgress(key) {
  const b = backend(); if (!b) throw noDb();
  if (b === 'pg') {
    const s = await pg();
    const rows = await s`SELECT progress FROM album_users WHERE name_key = ${key}`;
    return rows[0] ? rows[0].progress : { counts: {}, names: {} };
  }
  const r = await rds(); return (await r.get('progress:' + key)) || { counts: {}, names: {} };
}
export async function setProgress(key, data) {
  const b = backend(); if (!b) throw noDb();
  if (b === 'pg') {
    const s = await pg();
    await s`UPDATE album_users SET progress = ${JSON.stringify(data)}::jsonb WHERE name_key = ${key}`;
    return;
  }
  const r = await rds(); await r.set('progress:' + key, data);
}

/* ----------------- auth + helpers ----------------- */
const SECRET = process.env.AUTH_SECRET || 'album-mundial-2026-cambiar-este-secreto';
export function normName(name) {
  return String(name || '').trim().toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').slice(0, 40);
}
export function cleanName(name) { return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40); }
export function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
export function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
export function signToken(key) {
  const mac = crypto.createHmac('sha256', SECRET).update(key).digest('hex');
  return Buffer.from(key).toString('base64url') + '.' + mac;
}
export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, mac] = token.split('.');
  let key; try { key = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return null; }
  const expect = crypto.createHmac('sha256', SECRET).update(key).digest('hex');
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
  console.error('DB error:', e && e.message);
  return res.status(500).json({ error: 'Error del servidor.' });
}
