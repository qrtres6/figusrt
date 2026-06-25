import { getUser, normName, hashPin, signToken, readBody, dbErrorResponse } from '../lib/store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  try {
    const { name, pin } = await readBody(req);
    const key = normName(name);
    const u = await getUser(key);
    if (!u) return res.status(404).json({ error: 'No existe una cuenta con ese nombre.' });
    if (hashPin(pin, u.salt) !== u.pin) return res.status(401).json({ error: 'PIN incorrecto.' });
    return res.status(200).json({ token: signToken(key), name: u.display });
  } catch (e) {
    return dbErrorResponse(res, e);
  }
}
