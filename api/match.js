import { authKey, getProgress, getAllProgress, dbErrorResponse } from '../lib/store.js';

// Matchmaking de figuritas:
//   GET /api/match  ->  { mine:{display,extras,needs}, matches:[ {key,display,gives,takes,score} ] }
// "extras" = sticker IDs que tengo de más (count > 1)
// "needs"  = sticker IDs que me faltan (count == 0  -> derivable solo en el cliente; aquí pasamos counts)
// Para que sea eficiente, devolvemos:
//   - mine.extras: ids que el usuario tiene de más
//   - mine.needs:  ids que el usuario NO tiene (counts[id] no existe o es 0)  -> derivable solo si el server
//                  conoce el set total de IDs. Para evitar pasarlo, el cliente deriva needs por sí mismo;
//                  el server devuelve "mine.have" (ids con count>0) y el cliente calcula needs = ALL - have.
// Y los matches con otros usuarios, ya computados (gives/takes son sets reales).
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
  const key = authKey(req);
  if (!key) return res.status(401).json({ error: 'No autenticado' });
  try {
    const me = await getProgress(key);
    const myCounts = (me && me.counts) || {};
    const myExtras = new Set();           // tengo de más (cantidad > 1)
    const myHave = new Set();             // tengo (cantidad >= 1)
    for (const id of Object.keys(myCounts)) {
      const v = myCounts[id] | 0;
      if (v >= 1) myHave.add(id);
      if (v >= 2) myExtras.add(id);
    }
    const others = await getAllProgress(key);
    const matches = [];
    for (const o of others) {
      const oHave = new Set();
      const oExtras = new Set();
      for (const id of Object.keys(o.counts || {})) {
        const v = o.counts[id] | 0;
        if (v >= 1) oHave.add(id);
        if (v >= 2) oExtras.add(id);
      }
      // gives: lo que yo le doy = mis repes que ÉL no tiene
      const gives = [];
      for (const id of myExtras) if (!oHave.has(id)) gives.push(id);
      // takes: lo que él me da = sus repes que YO no tengo
      const takes = [];
      for (const id of oExtras) if (!myHave.has(id)) takes.push(id);
      if (!gives.length || !takes.length) continue;   // sólo matches mutuos
      matches.push({
        key: o.name_key,
        display: o.display,
        gives, takes,
        score: Math.min(gives.length, takes.length),  // tamaño del intercambio posible
      });
    }
    matches.sort((a, b) => b.score - a.score || (b.gives.length + b.takes.length) - (a.gives.length + a.takes.length));
    return res.status(200).json({
      mine: { extras: Array.from(myExtras), have: Array.from(myHave) },
      matches,
    });
  } catch (e) {
    return dbErrorResponse(res, e);
  }
}
