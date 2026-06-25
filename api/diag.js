import { backendName, dbStats } from '../lib/store.js';

// Diagnóstico: muestra qué base detecta, qué variables existen y si puede leer/contar.
// No expone secretos (solo true/false y conteos).
export default async function handler(req, res) {
  const e = process.env;
  const env = {
    POSTGRES_URL: !!e.POSTGRES_URL,
    POSTGRES_URL_NON_POOLING: !!e.POSTGRES_URL_NON_POOLING,
    POSTGRES_PRISMA_URL: !!e.POSTGRES_PRISMA_URL,
    KV_REST_API_URL: !!e.KV_REST_API_URL,
    UPSTASH_REDIS_REST_URL: !!e.UPSTASH_REDIS_REST_URL,
    AUTH_SECRET_set: !!e.AUTH_SECRET,
  };
  let backend = null, stats = null, error = null;
  try { backend = backendName(); } catch (err) { error = 'backend: ' + (err.message || err); }
  try { stats = await dbStats(); } catch (err) { error = (err.message || String(err)); }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, backend, env, stats, error });
}
