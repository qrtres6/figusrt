import { redis, authKey, readBody, dbErrorResponse } from '../lib/store.js';

export default async function handler(req, res) {
  const key = authKey(req);
  if (!key) return res.status(401).json({ error: 'No autenticado' });
  try {
    const r = redis();
    if (req.method === 'GET') {
      const p = await r.get('progress:' + key);
      return res.status(200).json(p || { counts: {}, names: {} });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const counts = (body && typeof body.counts === 'object' && body.counts) || {};
      const names = (body && typeof body.names === 'object' && body.names) || {};
      // guard against absurd payloads
      if (Object.keys(counts).length > 5000 || Object.keys(names).length > 500) {
        return res.status(413).json({ error: 'Demasiados datos' });
      }
      const showCodes = !!(body && body.showCodes);
      await r.set('progress:' + key, { counts, names, showCodes, ts: Date.now() });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return dbErrorResponse(res, e);
  }
}
