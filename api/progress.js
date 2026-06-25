import { authKey, getProgress, setProgress, readBody, dbErrorResponse } from '../lib/store.js';

export default async function handler(req, res) {
  const key = authKey(req);
  if (!key) return res.status(401).json({ error: 'No autenticado' });
  try {
    if (req.method === 'GET') {
      return res.status(200).json(await getProgress(key));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const counts = (body && typeof body.counts === 'object' && body.counts) || {};
      const names = (body && typeof body.names === 'object' && body.names) || {};
      if (Object.keys(counts).length > 5000 || Object.keys(names).length > 500) {
        return res.status(413).json({ error: 'Demasiados datos' });
      }
      await setProgress(key, { counts, names, showCodes: !!(body && body.showCodes), ts: Date.now() });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return dbErrorResponse(res, e);
  }
}
