import { getUser, normName, hashPin, signToken, readBody, dbErrorResponse } from '../lib/store.js';
import { check, clientIp } from '../lib/ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  try {
    const body = await readBody(req);
    const { name, pin } = body || {};
    const key = normName(name);
    if (key.length < 2 || key.length > 40 || !/^\d{3,8}$/.test(String(pin || ''))) {
      // Same message as wrong pin to avoid leaking which field is wrong.
      return res.status(400).json({ error: 'Nombre o PIN inválido.' });
    }
    // 8 attempts per name in 10 min, AND 30 attempts per IP in 10 min.
    const lName = check('login:name:' + key, { max: 8, windowMs: 10 * 60 * 1000 });
    if (!lName.ok) {
      const mins = Math.ceil(lName.retryInMs / 60000);
      return res.status(429).json({ error: `Demasiados intentos para esta cuenta. Probá en ${mins} minutos.` });
    }
    const lIp = check('login:ip:' + clientIp(req), { max: 30, windowMs: 10 * 60 * 1000 });
    if (!lIp.ok) return res.status(429).json({ error: 'Demasiados intentos. Probá en unos minutos.' });

    const u = await getUser(key);
    if (!u || hashPin(pin, u.salt) !== u.pin) {
      // Generic message so an attacker can't enumerate accounts.
      return res.status(401).json({ error: 'Nombre o PIN incorrecto.' });
    }
    return res.status(200).json({ token: signToken(key), name: u.display });
  } catch (e) {
    return dbErrorResponse(res, e);
  }
}
