const router = require('express').Router();

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-10-15';
const CLICKED_EMAIL_METRIC_ID = 'UDUzgX';

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
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

function safeInt(val) {
  if (val == null) return 0;
  return parseInt(String(val).replace(/[^0-9]/g, '')) || 0;
}

router.get('/', async (req, res) => {
  const { campaign_id } = req.query;
  if (!campaign_id) return res.json([]);

  const cacheKey = `link_${campaign_id}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return res.json(cached.data);

  try {
    // Date range: last 364 days (max 1 year allowed by API)
    const end = new Date().toISOString().slice(0, 19);
    const start = new Date(Date.now() - 364 * 86400 * 1000).toISOString().slice(0, 19);

    const aggRes = await fetchWithTimeout(
      `${KLAVIYO_BASE}/metric-aggregates/`,
      {
        method: 'POST',
        headers: {
          Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
          revision: REVISION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: {
            type: 'metric-aggregate',
            attributes: {
              metric_id: CLICKED_EMAIL_METRIC_ID,
              measurements: ['count', 'unique'],
              interval: 'month',
              // $message = campaign_id nella proprietà evento (confermato dai log raw)
              filter: [
                `greater-or-equal(datetime,${start})`,
                `less-than(datetime,${end})`,
                `equals($message,"${campaign_id}")`,
              ],
              by: ['URL'],
              page_size: 500,
            },
          },
        }),
      },
      10000
    );

    if (!aggRes.ok) return res.json([]);

    const json = await aggRes.json();
    if (json.errors) return res.json([]);

    const items = json?.data?.attributes?.data || [];

    const data = items
      .map(item => {
        const url = item.dimensions?.[0] || '';
        if (!url) return null;
        // measurements.count e .unique sono array (un valore per mese) — somma tutto
        const totalClicks = (item.measurements?.count || []).reduce((a, b) => a + safeInt(b), 0);
        const uniqueClicks = (item.measurements?.unique || []).reduce((a, b) => a + safeInt(b), 0);
        return { url, totalClicks, uniqueClicks };
      })
      .filter(Boolean)
      .sort((a, b) => b.totalClicks - a.totalClicks);

    cache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    res.json([]);
  }
});

module.exports = router;
