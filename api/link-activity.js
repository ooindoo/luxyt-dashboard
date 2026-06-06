const router = require('express').Router();

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-10-15';
const CLICKED_EMAIL_METRIC_ID = 'UDUzgX'; // hardcoded — stabile per account Klaviyo

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
  const { campaign_id } = req.query;
  if (!campaign_id) return res.json([]);

  const cacheKey = `link_${campaign_id}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
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

    // API 2024-10-15 restituisce data.dimensions[] + data.measurements{}
    const dims = attrs.data?.dimensions || [];
    const measurements = attrs.data?.measurements || {};
    let data = [];

    if (dims.length > 0) {
      data = dims.map((dim, i) => ({
        url: Array.isArray(dim) ? dim[0] : (dim['$event_properties.URL'] || dim),
        uniqueClicks: measurements?.unique?.[i] ?? 0,
        totalClicks: measurements?.count?.[i] ?? 0,
      }));
    } else if (attrs.results) {
      // fallback formato precedente
      data = attrs.results.map(r => ({
        url: r.dimensions?.['$event_properties.URL'] || '',
        uniqueClicks: r.measurements?.unique || 0,
        totalClicks: r.measurements?.count || 0,
      }));
    }

    data = data.filter(d => d.url).sort((a, b) => b.totalClicks - a.totalClicks);
    cache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    res.json([]);
  }
});

module.exports = router;
