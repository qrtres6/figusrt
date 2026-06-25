import { backendName, dbStats, getUser, getProgress, normName } from '../lib/store.js';

// Diagnóstico: muestra qué base detecta, qué variables existen y si puede leer/contar.
// Con ?name=XXX muestra qué hay guardado para esa cuenta (sin exponer secretos).
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const e = process.env;
  const env = {
    POSTGRES_URL: !!e.POSTGRES_URL,
    POSTGRES_URL_NON_POOLING: !!e.POSTGRES_URL_NON_POOLING,
    POSTGRES_PRISMA_URL: !!e.POSTGRES_PRISMA_URL,
    KV_REST_API_URL: !!e.KV_REST_API_URL,
    UPSTASH_REDIS_REST_URL: !!e.UPSTASH_REDIS_REST_URL,
    AUTH_SECRET_set: !!e.AUTH_SECRET,
  };
  let backend = null, stats = null, lookup = null, error = null;
  try { backend = backendName(); } catch (err) { error = 'backend: ' + (err.message || err); }
  try { stats = await dbStats(); } catch (err) { error = (err.message || String(err)); }
  const name = req.query && req.query.name;
  if (name) {
    try {
      const key = normName(name);
      const u = await getUser(key);
      const p = await getProgress(key);
      lookup = {
        name_key: key,
        existeCuenta: !!u,
        figusGuardadas: p && p.counts ? Object.keys(p.counts).length : 0,
        ts: (p && p.ts) || 0,
      };
    } catch (err) { error = 'lookup: ' + (err.message || err); }
  }
  res.status(200).json({ ok: true, backend, env, stats, lookup, error });
}
