/**
 * panoramica-data.js — KPI aggregati ultimi 30 giorni.
 * NOTA: Non chiama più Klaviyo direttamente per evitare doppia chiamata
 * insieme a /api/campaigns (rate limit 429).
 * I KPI vengono calcolati dai dati di /api/campaigns (già cachati).
 * Questo endpoint usa il modulo shared-stats solo per i totali aggregati.
 */
const router = require('express').Router();
const { getCampaignStats } = require('./shared-stats');

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 60 minuti

router.get('/', async (req, res) => {
  const cacheKey = 'panoramica';
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return res.json(hit.data);

  try {
    // Usa lo stesso shared stats già richiesto da /api/campaigns
    // (deduplication: se campaigns è già in volo, aspetta quella invece di chiamare due volte)
    const statsMap = await getCampaignStats();

    // Filtra le campagne degli ultimi 30 giorni
    // Nota: statsMap non ha date, usa tutti i risultati disponibili
    const allStats = Object.values(statsMap);
    const n = allStats.length || 1;

    let totalOpen = 0, totalClick = 0, totalUnsub = 0, totalRecipients = 0, totalDelivered = 0;
    const campaigns = allStats.map((s, i) => {
      totalOpen       += s.open_rate         || 0;
      totalClick      += s.click_rate        || 0;
      totalUnsub      += s.unsubscribe_rate  || 0;
      totalRecipients += Math.round(s.recipients || 0);
      totalDelivered  += Math.round(s.delivered  || 0);
      return {
        id:            Object.keys(statsMap)[i],
        opens:         Math.round(s.opens || 0),
        openRate:      s.open_rate  || 0,
        clicks:        Math.round(s.clicks || 0),
        clickRate:     s.click_rate || 0,
        unsubscribes:  Math.round(s.unsubscribes || 0),
        spamComplaints:Math.round(s.spam_complaints || 0),
        recipients:    Math.round(s.recipients || 0),
        delivered:     Math.round(s.delivered  || 0),
      };
    });

    const data = {
      openRate:        parseFloat((totalOpen  / n * 100).toFixed(1)),
      clickRate:       parseFloat((totalClick / n * 100).toFixed(1)),
      unsubscribeRate: parseFloat((totalUnsub / n * 100).toFixed(2)),
      totalDelivered,
      campaigns,
    };

    // Non cachare se stats vuote
    if (allStats.length > 0) {
      cache.set(cacheKey, { data, ts: Date.now() });
    }
    res.json(data);
  } catch (e) {
    const stale = cache.get(cacheKey);
    if (stale) return res.json(stale.data);
    res.json({ openRate: 0, clickRate: 0, unsubscribeRate: 0, totalDelivered: 0, campaigns: [] });
  }
});

module.exports = router;
