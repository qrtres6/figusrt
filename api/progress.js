import { authKey, getProgress, setProgress, readBody, dbErrorResponse } from '../lib/store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const key = authKey(req);
  if (!key) return res.status(401).json({ error: 'No autenticado' });
  try {
    if (req.method === 'GET') {
      const p = await getProgress(key);
      // Always normalise the shape so the client doesn't have to.
      return res.status(200).json({
        counts: (p && typeof p.counts === 'object' && p.counts) || {},
        names:  (p && typeof p.names  === 'object' && p.names)  || {},
        showCodes: !!(p && p.showCodes),
        ts: (p && typeof p.ts === 'number') ? p.ts : 0,
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Datos inválidos' });
      const counts = (typeof body.counts === 'object' && body.counts) || {};
      const names  = (typeof body.names  === 'object' && body.names)  || {};
      if (Object.keys(counts).length > 5000) return res.status(413).json({ error: 'Demasiadas figuritas' });
      if (Object.keys(names).length > 500)   return res.status(413).json({ error: 'Demasiados nombres editados' });
      // Validate value shapes (small counters, short strings).
      for (const k of Object.keys(counts)) {
        if (k.length > 32) return res.status(400).json({ error: 'Datos inválidos' });
        const v = counts[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 9999 || Math.floor(v) !== v) {
          return res.status(400).json({ error: 'Datos inválidos' });
        }
      }
      for (const k of Object.keys(names)) {
        if (k.length > 32) return res.status(400).json({ error: 'Datos inválidos' });
        if (typeof names[k] !== 'string' || names[k].length > 60) return res.status(400).json({ error: 'Datos inválidos' });
      }
      const ts = (typeof body.ts === 'number' && Number.isFinite(body.ts) && body.ts > 0) ? body.ts : Date.now();
      const storedTs = await setProgress(key, { counts, names, showCodes: !!body.showCodes, ts });
      return res.status(200).json({ ok: true, ts: storedTs });
    }
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return dbErrorResponse(res, e);
  }
}
