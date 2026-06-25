import { authKey, getProgress, getUser, createTrade, listTradesFor, readBody, dbErrorResponse } from '../lib/store.js';

// GET  /api/trades            -> mis propuestas (recibidas y enviadas)
// POST /api/trades            -> crear { toKey, gives:[ids], takes:[ids], message? }
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const me = authKey(req);
  if (!me) return res.status(401).json({ error: 'No autenticado' });
  try {
    if (req.method === 'GET') {
      const rows = await listTradesFor(me);
      // Enrich with the OTHER user's display name (we already know our own).
      const peers = new Set(rows.map(t => t.from_key === me ? t.to_key : t.from_key));
      const names = {};
      for (const k of peers) { const u = await getUser(k); names[k] = u ? u.display : k; }
      const trades = rows.map(t => {
        const peerKey = t.from_key === me ? t.to_key : t.from_key;
        const isOutgoing = t.from_key === me;
        return {
          id: t.id,
          peer: { key: peerKey, display: names[peerKey] || peerKey },
          isOutgoing,
          gives: t.gives, takes: t.takes,           // siempre en perspectiva del "from"
          status: t.status,
          messages: t.messages || [],
          completedBy: t.completed_by || [],
          created: t.created, updated: t.updated,
        };
      });
      return res.status(200).json({ trades });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const toKey = String((body && body.toKey) || '').slice(0, 40);
      const gives = Array.isArray(body && body.gives) ? body.gives : [];
      const takes = Array.isArray(body && body.takes) ? body.takes : [];
      const initialMsg = String((body && body.message) || '').slice(0, 500).trim();
      if (!toKey || toKey === me) return res.status(400).json({ error: 'Destinatario inválido' });
      if (!gives.length || !takes.length) return res.status(400).json({ error: 'Tenés que elegir al menos una figurita de cada lado' });
      if (gives.length > 200 || takes.length > 200) return res.status(400).json({ error: 'Demasiadas figuritas' });
      // Validate IDs look reasonable (alphanumeric + dashes).
      const idOk = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(id);
      if (!gives.every(idOk) || !takes.every(idOk)) return res.status(400).json({ error: 'IDs inválidos' });

      const peer = await getUser(toKey);
      if (!peer) return res.status(404).json({ error: 'No existe ese usuario' });

      // Best-effort consistency: server-side check that the proposer actually has the repes.
      const myP = await getProgress(me);
      const myCounts = (myP && myP.counts) || {};
      for (const id of gives) {
        if ((myCounts[id] || 0) < 2) {
          return res.status(400).json({ error: 'Ya no tenés repe de ' + id });
        }
      }
      const trade = await createTrade({ fromKey: me, toKey, gives, takes });
      if (initialMsg) {
        const { updateTrade } = await import('../lib/store.js');
        const t2 = await updateTrade(trade.id, { messages: [{ from: me, text: initialMsg, at: Date.now() }] });
        return res.status(200).json({ trade: serializeTrade(t2, me, peer.display) });
      }
      return res.status(200).json({ trade: serializeTrade(trade, me, peer.display) });
    }
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return dbErrorResponse(res, e);
  }
}

function serializeTrade(t, me, peerDisplay) {
  const peerKey = t.from_key === me ? t.to_key : t.from_key;
  return {
    id: t.id,
    peer: { key: peerKey, display: peerDisplay || peerKey },
    isOutgoing: t.from_key === me,
    gives: t.gives, takes: t.takes,
    status: t.status,
    messages: t.messages || [],
    completedBy: t.completed_by || [],
    created: t.created, updated: t.updated,
  };
}
