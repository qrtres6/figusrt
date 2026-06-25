import { redis, normName, cleanName, makeSalt, hashPin, signToken, readBody, dbErrorResponse } from '../lib/store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  try {
    const { name, pin } = await readBody(req);
    const key = normName(name);
    if (key.length < 2) return res.status(400).json({ error: 'El nombre debe tener al menos 2 letras.' });
    if (!/^\d{3,8}$/.test(String(pin || ''))) return res.status(400).json({ error: 'El PIN debe ser de 3 a 8 dígitos.' });
    const r = redis();
    const exists = await r.get('user:' + key);
    if (exists) return res.status(409).json({ error: 'Ese nombre ya está registrado. Probá iniciar sesión.' });
    const salt = makeSalt();
    const display = cleanName(name);
    await r.set('user:' + key, { name: display, salt, pin: hashPin(pin, salt), created: Date.now() });
    await r.set('progress:' + key, { counts: {}, names: {}, ts: Date.now() });
    return res.status(200).json({ token: signToken(key), name: display });
  } catch (e) {
    return dbErrorResponse(res, e);
  }
}
