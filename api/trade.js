import { authKey, getTrade, updateTrade, adjustProgress, getUser, readBody, dbErrorResponse } from '../lib/store.js';

// POST /api/trade  { id, action, text? }
//   action: 'accept' (only to_key, when pending) -> status=accepted
//           'reject' (only to_key, when pending) -> status=rejected
//           'cancel' (only from_key, when pending/accepted) -> status=cancelled
//           'complete' (cualquiera, requiere accepted; necesita ambas confirmaciones -> aplica el swap)
//           'message' { text } (cualquiera de los dos)
// GET  /api/trade?id=...  -> detalle (sólo si soy parte)
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const me = authKey(req);
  if (!me) return res.status(401).json({ error: 'No autenticado' });
  try {
    const id = (req.method === 'GET' ? (req.query && req.query.id) : null);
    if (req.method === 'GET') {
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const t = await getTrade(id);
      if (!t || (t.from_key !== me && t.to_key !== me)) return res.status(404).json({ error: 'No existe' });
      return res.status(200).json({ trade: await serialize(t, me) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    const body = await readBody(req);
    const tid = String((body && body.id) || '');
    const action = String((body && body.action) || '');
    if (!tid || !action) return res.status(400).json({ error: 'Faltan id/action' });
    const t = await getTrade(tid);
    if (!t || (t.from_key !== me && t.to_key !== me)) return res.status(404).json({ error: 'No existe' });
    const isFrom = t.from_key === me;
    const isTo = t.to_key === me;

    if (action === 'message') {
      const text = String((body && body.text) || '').slice(0, 500).trim();
      if (!text) return res.status(400).json({ error: 'Mensaje vacío' });
      const msgs = (t.messages || []).concat([{ from: me, text, at: Date.now() }]);
      if (msgs.length > 200) return res.status(413).json({ error: 'Demasiados mensajes' });
      const t2 = await updateTrade(tid, { messages: msgs });
      return res.status(200).json({ trade: await serialize(t2, me) });
    }
    if (action === 'accept') {
      if (!isTo) return res.status(403).json({ error: 'Solo el destinatario puede aceptar' });
      if (t.status !== 'pending') return res.status(409).json({ error: 'La propuesta ya no está pendiente' });
      const t2 = await updateTrade(tid, { status: 'accepted' });
      return res.status(200).json({ trade: await serialize(t2, me) });
    }
    if (action === 'reject') {
      if (!isTo) return res.status(403).json({ error: 'Solo el destinatario puede rechazar' });
      if (t.status !== 'pending') return res.status(409).json({ error: 'La propuesta ya no está pendiente' });
      const t2 = await updateTrade(tid, { status: 'rejected' });
      return res.status(200).json({ trade: await serialize(t2, me) });
    }
    if (action === 'cancel') {
      if (!isFrom) return res.status(403).json({ error: 'Solo quien la creó puede cancelarla' });
      if (t.status === 'completed' || t.status === 'cancelled' || t.status === 'rejected')
        return res.status(409).json({ error: 'La propuesta ya está cerrada' });
      const t2 = await updateTrade(tid, { status: 'cancelled' });
      return res.status(200).json({ trade: await serialize(t2, me) });
    }
    if (action === 'complete') {
      if (t.status !== 'accepted' && t.status !== 'half_completed')
        return res.status(409).json({ error: 'Para completar, la propuesta debe estar aceptada.' });
      const cb = new Set(t.completed_by || []);
      cb.add(me);
      if (cb.size < 2) {
        // first one confirmed; needs the other to also confirm
        const t2 = await updateTrade(tid, { status: 'half_completed', completed_by: Array.from(cb) });
        return res.status(200).json({ trade: await serialize(t2, me), waitingPeer: true });
      }
      // Both confirmed → apply the swap to both progresses.
      const fromDelta = {}, toDelta = {};
      for (const id2 of t.gives) { fromDelta[id2] = (fromDelta[id2] || 0) - 1; toDelta[id2] = (toDelta[id2] || 0) + 1; }
      for (const id2 of t.takes) { toDelta[id2]   = (toDelta[id2]   || 0) - 1; fromDelta[id2] = (fromDelta[id2] || 0) + 1; }
      await adjustProgress(t.from_key, fromDelta);
      await adjustProgress(t.to_key,   toDelta);
      const t2 = await updateTrade(tid, { status: 'completed', completed_by: Array.from(cb) });
      return res.status(200).json({ trade: await serialize(t2, me), applied: true });
    }
    return res.status(400).json({ error: 'Acción desconocida' });
  } catch (e) {
    return dbErrorResponse(res, e);
  }
}

async function serialize(t, me) {
  const peerKey = t.from_key === me ? t.to_key : t.from_key;
  const u = await getUser(peerKey);
  return {
    id: t.id,
    peer: { key: peerKey, display: (u && u.display) || peerKey },
    isOutgoing: t.from_key === me,
    gives: t.gives, takes: t.takes,
    status: t.status,
    messages: t.messages || [],
    completedBy: t.completed_by || [],
    created: t.created, updated: t.updated,
  };
}
