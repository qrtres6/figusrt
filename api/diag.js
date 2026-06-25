import { backendName, dbStats, getUser, getProgress, setProgress, normName } from '../lib/store.js';

// Diagnóstico:
//   /api/diag                 -> backend, variables, conteos
//   /api/diag?name=XXX        -> qué hay guardado para esa cuenta
//   /api/diag?write=XXX       -> ESCRIBE una prueba (3 figus) para esa cuenta y la lee de vuelta
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const e = process.env;
  const env = {
    POSTGRES_URL: !!e.POSTGRES_URL,
    POSTGRES_URL_NON_POOLING: !!e.POSTGRES_URL_NON_POOLING,
    KV_REST_API_URL: !!e.KV_REST_API_URL,
    UPSTASH_REDIS_REST_URL: !!e.UPSTASH_REDIS_REST_URL,
    AUTH_SECRET_set: !!e.AUTH_SECRET,
  };
  let backend = null, stats = null, lookup = null, wrote = null, error = null;
  try { backend = backendName(); } catch (err) { error = 'backend: ' + (err.message || err); }
  try { stats = await dbStats(); } catch (err) { error = (err.message || String(err)); }

  const writeName = req.query && req.query.write;
  if (writeName) {
    try {
      const key = normName(writeName);
      await setProgress(key, { counts: { TEST1: 1, TEST2: 1, TEST3: 1 }, names: {}, showCodes: true, ts: Date.now() });
      const back = await getProgress(key);
      wrote = { name_key: key, escribio: true, leidoEnMismaLlamada: back && back.counts ? Object.keys(back.counts).length : 0 };
    } catch (err) { error = 'write: ' + (err.message || err); }
  }

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
        dataType: typeof p,
        dataPreview: typeof p === 'string' ? p.slice(0, 120) : JSON.stringify(p).slice(0, 120),
      };
    } catch (err) { error = 'lookup: ' + (err.message || err); }
  }

  res.status(200).json({ ok: true, backend, env, stats, wrote, lookup, error });
}
