const router = require('express').Router();

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 60 minuti
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-10-15';
const CONVERSION_METRIC_ID = 'SRuFLu';

function klaviyoHeaders() {
  return {
    Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
    revision: REVISION,
    'Content-Type': 'application/json',
  };
}

function fetchWithTimeout(url, options = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal })
    .finally(() => clearTimeout(t));
}

router.get('/', async (req, res) => {
  const cacheKey = 'panoramica';
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return res.json(hit.data);

  try {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 30);

    const reportRes = await fetchWithTimeout(
      `${KLAVIYO_BASE}/campaign-values-reports/`,
      {
        method: 'POST',
        headers: klaviyoHeaders(),
        body: JSON.stringify({
          data: {
            type: 'campaign-values-report',
            attributes: {
              statistics: ['opens','open_rate','clicks','click_rate',
                           'unsubscribes','unsubscribe_rate','spam_complaints',
                           'recipients','delivered'],
              timeframe: { start: start.toISOString().slice(0,19), end: end.toISOString().slice(0,19) },
              conversion_metric_id: CONVERSION_METRIC_ID,
              filter: "equals(send_channel,'email')",
            },
          },
        }),
      },
      8000
    );

    if (!reportRes.ok) throw new Error('stats_failed');

    const j = await reportRes.json();
    const results = j?.data?.attributes?.results || [];

    let totalOpen = 0, totalClick = 0, totalUnsub = 0, n = 0;
    const campaigns = results.map(r => {
      const s = r.statistics || {};
      totalOpen  += s.open_rate  || 0;
      totalClick += s.click_rate || 0;
      totalUnsub += s.unsubscribe_rate || 0;
      n++;
      return {
        id: r.groupings?.campaign_id || r.id,
        opens:       Math.round(s.opens || 0),
        openRate:    s.open_rate  || 0,
        clicks:      Math.round(s.clicks || 0),
        clickRate:   s.click_rate || 0,
        unsubscribes: Math.round(s.unsubscribes || 0),
        spamComplaints: Math.round(s.spam_complaints || 0),
        recipients:  Math.round(s.recipients || 0),
        delivered:   Math.round(s.delivered  || 0),
      };
    });

    const count = n || 1;
    const data = {
      openRate:      parseFloat((totalOpen  / count * 100).toFixed(1)),
      clickRate:     parseFloat((totalClick / count * 100).toFixed(1)),
      unsubscribeRate: parseFloat((totalUnsub / count * 100).toFixed(2)),
      campaigns,
    };

    cache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    // Servi stale cache se disponibile, altrimenti fallback
    const stale = cache.get(cacheKey);
    if (stale) return res.json(stale.data);
    res.json({ openRate: 0, clickRate: 0, unsubscribeRate: 0, campaigns: [] });
  }
});

module.exports = router;
