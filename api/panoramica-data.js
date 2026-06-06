const router = require('express').Router();

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2023-10-15';

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
                'bounces', 'bounce_rate',
                'spam_complaints', 'recipients',
                'revenue', 'conversions',
              ],
              timeframe: { key: 'last_30_days' },
              filter: "equals(send_channel,'email')",
            },
          },
        }),
      },
      5000
    );

    if (!reportRes.ok) {
      return res.json({ revenue: 0, openRate: 0, clickRate: 0, conversionRate: 0, unsubscribeRate: 0, campaigns: [] });
    }

    const reportJson = await reportRes.json();
    const results = reportJson?.data?.attributes?.results || [];

    let totalRevenue = 0, totalOpenRate = 0, totalClickRate = 0,
        totalConvRate = 0, totalUnsub = 0, count = 0;

    const campaigns = results.map(r => {
      const a = r.attributes;
      totalRevenue += a.revenue || 0;
      totalOpenRate += a.open_rate || 0;
      totalClickRate += a.click_rate || 0;
      totalConvRate += (a.conversions && a.recipients ? a.conversions / a.recipients : 0);
      totalUnsub += a.unsubscribe_rate || 0;
      count++;
      return {
        id: r.id,
        opens: a.opens || 0,
        openRate: a.open_rate || 0,
        clicks: a.clicks || 0,
        clickRate: a.click_rate || 0,
        unsubscribes: a.unsubscribes || 0,
        unsubscribeRate: a.unsubscribe_rate || 0,
        bounces: a.bounces || 0,
        bounceRate: a.bounce_rate || 0,
        spamComplaints: a.spam_complaints || 0,
        recipients: a.recipients || 0,
        revenue: a.revenue || 0,
        conversions: a.conversions || 0,
      };
    });

    const n = count || 1;
    const data = {
      revenue: totalRevenue,
      openRate: parseFloat((totalOpenRate / n * 100).toFixed(1)),
      clickRate: parseFloat((totalClickRate / n * 100).toFixed(1)),
      conversionRate: parseFloat((totalConvRate / n * 100).toFixed(2)),
      unsubscribeRate: parseFloat((totalUnsub / n * 100).toFixed(2)),
      campaigns,
    };

    cache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    res.json({ revenue: 0, openRate: 0, clickRate: 0, conversionRate: 0, unsubscribeRate: 0, campaigns: [] });
  }
});

module.exports = router;
