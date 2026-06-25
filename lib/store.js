// Shared helpers for the album API (Upstash Redis + auth)
import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

let _redis = null;
export function redis() {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const err = new Error('DB_NOT_CONFIGURED');
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }
  _redis = new Redis({ url, token });
  return _redis;
}

const SECRET = process.env.AUTH_SECRET || 'album-mundial-2026-cambiar-este-secreto';

export function normName(name) {
  return String(name || '')
    .trim().toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 40);
}
export function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}
export function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
export function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
export function signToken(key) {
  const mac = crypto.createHmac('sha256', SECRET).update(key).digest('hex');
  return Buffer.from(key).toString('base64url') + '.' + mac;
}
export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, mac] = token.split('.');
  let key;
  try { key = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return null; }
  const expect = crypto.createHmac('sha256', SECRET).update(key).digest('hex');
  try {
    if (mac.length !== expect.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
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
  if (e && e.code === 'DB_NOT_CONFIGURED') {
    return res.status(503).json({ error: 'La base de datos no está configurada todavía.' });
  }
  return res.status(500).json({ error: 'Error del servidor.' });
}
