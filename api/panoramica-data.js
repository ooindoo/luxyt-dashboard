const router = require('express').Router();

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-10-15';
// Metric IDs (Klaviyo account-specific, resolved at startup)
const CONVERSION_METRIC_ID = 'SRuFLu'; // Opened Email — fallback per account senza Placed Order

function klaviyoHeaders() {
  return {
    Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
    revision: REVISION,
    'Content-Type': 'application/json',
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

router.get('/', async (req, res) => {
  const cacheKey = 'panoramica';
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const reportRes = await fetchWithTimeout(
      `${KLAVIYO_BASE}/campaign-values-reports/`,
      {
        method: 'POST',
        headers: klaviyoHeaders(),
        body: JSON.stringify({
          data: {
            type: 'campaign-values-report',
            attributes: {
              statistics: [
                'opens', 'open_rate',
                'clicks', 'click_rate',
                'unsubscribes', 'unsubscribe_rate',
                'spam_complaints', 'recipients',
                'delivered', 'delivery_rate',
              ],
              timeframe: (() => {
                const end = new Date();
                const start = new Date(end);
                start.setDate(start.getDate() - 30);
                return { start: start.toISOString().slice(0,19), end: end.toISOString().slice(0,19) };
              })(),
              conversion_metric_id: CONVERSION_METRIC_ID,
              filter: "equals(send_channel,'email')",
            },
          },
        }),
      },
      5000
    );

    if (!reportRes.ok) {
      return res.json({ openRate: 0, clickRate: 0, unsubscribeRate: 0, campaigns: [] });
    }

    const reportJson = await reportRes.json();
    // API 2024-10-15: results[i].statistics (non più .attributes), id in .groupings.campaign_id
    const results = reportJson?.data?.attributes?.results || [];

    let totalOpenRate = 0, totalClickRate = 0, totalUnsub = 0, count = 0;

    const campaigns = results.map(r => {
      const s = r.statistics || {};
      const cid = r.groupings?.campaign_id || r.id;
      totalOpenRate += s.open_rate || 0;
      totalClickRate += s.click_rate || 0;
      totalUnsub += s.unsubscribe_rate || 0;
      count++;
      return {
        id: cid,
        opens: Math.round(s.opens || 0),
        openRate: s.open_rate || 0,
        clicks: Math.round(s.clicks || 0),
        clickRate: s.click_rate || 0,
        unsubscribes: Math.round(s.unsubscribes || 0),
        unsubscribeRate: s.unsubscribe_rate || 0,
        spamComplaints: Math.round(s.spam_complaints || 0),
        recipients: Math.round(s.recipients || 0),
        delivered: Math.round(s.delivered || 0),
      };
    });

    const n = count || 1;
    const data = {
      openRate: parseFloat((totalOpenRate / n * 100).toFixed(1)),
      clickRate: parseFloat((totalClickRate / n * 100).toFixed(1)),
      unsubscribeRate: parseFloat((totalUnsub / n * 100).toFixed(2)),
      campaigns,
    };

    cache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    res.json({ openRate: 0, clickRate: 0, unsubscribeRate: 0, campaigns: [] });
  }
});

module.exports = router;
