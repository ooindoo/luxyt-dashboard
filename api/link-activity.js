const router = require('express').Router();

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2023-10-15';

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

async function getClickedEmailMetricId() {
  const cacheKey = 'metric_clicked_email';
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const res = await fetchWithTimeout(
    `${KLAVIYO_BASE}/metrics/`,
    {
      headers: {
        Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
        revision: REVISION,
      },
    },
    5000
  );
  if (!res.ok) return null;
  const json = await res.json();
  const metric = (json.data || []).find(m => m.attributes?.name === 'Clicked Email');
  const id = metric?.id || null;
  cache.set(cacheKey, { data: id, ts: Date.now() });
  return id;
}

router.get('/', async (req, res) => {
  const { campaign_id } = req.query;
  if (!campaign_id) return res.json([]);

  const cacheKey = `link_${campaign_id}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const metricId = await getClickedEmailMetricId();
    if (!metricId) return res.json([]);

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
              metric_id: metricId,
              measurements: ['unique', 'count'],
              filter: [`equals(campaign_id,"${campaign_id}")`],
              by: ['$event_properties.URL'],
              sort: '-count',
              page_size: 100,
            },
          },
        }),
      },
      5000
    );

    if (!aggRes.ok) return res.json([]);

    const json = await aggRes.json();
    const attrs = json?.data?.attributes || {};
    const urls = attrs.data?.urls || attrs.results || [];
    const measurements = attrs.data?.measurements || {};

    let data = [];

    if (Array.isArray(urls) && urls.length > 0) {
      data = urls.map((url, i) => ({
        url,
        uniqueClicks: measurements?.unique?.[i] ?? 0,
        totalClicks: measurements?.count?.[i] ?? 0,
      }));
    } else if (attrs.results) {
      data = (attrs.results || []).map(r => ({
        url: r.dimensions?.['$event_properties.URL'] || '',
        uniqueClicks: r.measurements?.unique || 0,
        totalClicks: r.measurements?.count || 0,
      }));
    }

    data.sort((a, b) => b.totalClicks - a.totalClicks);
    cache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    res.json([]);
  }
});

module.exports = router;
