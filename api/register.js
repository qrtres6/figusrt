import { getUser, createUser, normName, cleanName, makeSalt, hashPin, signToken, readBody, dbErrorResponse } from '../lib/store.js';
import { check, clientIp } from '../lib/ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  // Per-IP cap so a single host can't mass-register names.
  const ipLimit = check('reg:' + clientIp(req), { max: 20, windowMs: 10 * 60 * 1000 });
  if (!ipLimit.ok) return res.status(429).json({ error: 'Demasiados registros desde esta red. Probá en unos minutos.' });
  try {
    const body = await readBody(req);
    const { name, pin } = body || {};
    const key = normName(name);
    if (key.length < 2) return res.status(400).json({ error: 'El nombre debe tener al menos 2 letras.' });
    if (key.length > 40) return res.status(400).json({ error: 'El nombre es demasiado largo.' });
    if (typeof pin !== 'string' && typeof pin !== 'number') return res.status(400).json({ error: 'El PIN debe ser de 3 a 8 dígitos.' });
    if (!/^\d{3,8}$/.test(String(pin))) return res.status(400).json({ error: 'El PIN debe ser de 3 a 8 dígitos.' });
    if (await getUser(key)) return res.status(409).json({ error: 'Ese nombre ya está registrado. Probá iniciar sesión.' });
    const salt = makeSalt();
    const display = cleanName(name);
    const created = await createUser(key, { display, salt, pin: hashPin(pin, salt), created: Date.now() });
    if (!created) return res.status(409).json({ error: 'Ese nombre ya está registrado. Probá iniciar sesión.' });
    return res.status(200).json({ token: signToken(key), name: display });
  } catch (e) {
    return dbErrorResponse(res, e);
  }
}
