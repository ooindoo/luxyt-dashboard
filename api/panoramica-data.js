/**
 * panoramica-data.js
 * I KPI della Panoramica sono ora calcolati direttamente nel frontend
 * dai dati di /api/campaigns (già filtrati: solo Sent, solo email, no flussi).
 * Questo endpoint rimane per compatibilità ma non è più usato per i KPI.
 */
const router = require('express').Router();

router.get('/', (req, res) => {
  res.json({ ok: true, message: 'KPI calcolati nel frontend da /api/campaigns' });
});

module.exports = router;
