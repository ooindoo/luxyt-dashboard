const router = require('express').Router();

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-10-15';

// Metrica ID cachata a livello modulo — evita refetch ad ogni chiamata
let cachedMetricId = null;

async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch (e) { clearTimeout(t); throw e; }
}

async function getClickedEmailMetricId() {
  if (cachedMetricId) return cachedMetricId;

  // Fetch lista metriche e trova "Clicked Email"
  const res = await fetchWithTimeout(
    `${KLAVIYO_BASE}/metrics/`,
    { headers: { Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`, revision: REVISION } },
    8000
  );
  if (!res.ok) return 'UDUzgX'; // fallback hardcoded confermato

  const json = await res.json();
  const metric = (json.data || []).find(m => m.attributes?.name === 'Clicked Email');
  cachedMetricId = metric?.id || 'UDUzgX';
  console.log('[link-activity] Clicked Email metric ID:', cachedMetricId);
  return cachedMetricId;
}

router.get('/', async (req, res) => {
  const { campaign_id } = req.query;
  if (!campaign_id) return res.json([]);

  const cacheKey = `link_${campaign_id}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log('[link-activity] cache hit for', campaign_id);
    return res.json(cached.data);
  }

  try {
    const metricId = await getClickedEmailMetricId();

    // Finestra temporale: ultimi 364 giorni (limite max API: 1 anno)
    const end = new Date().toISOString().slice(0, 19);
    const start = new Date(Date.now() - 364 * 86400 * 1000).toISOString().slice(0, 19);

    // NOTE: nella revision 2024-10-15 la filter dimension è "$message" (non "campaign_id")
    // e il by deve essere "URL" (non "$event_properties.URL")
    // Questi sono i valori verificati via debug raw sugli eventi Klaviyo
    const body = {
      data: {
        type: 'metric-aggregate',
        attributes: {
          metric_id: metricId,
          measurements: ['count', 'unique'],
          interval: 'month',
          filter: [
            `greater-or-equal(datetime,${start})`,
            `less-than(datetime,${end})`,
            `equals($message,"${campaign_id}")`,
          ],
          by: ['URL'],
          page_size: 500,
        },
      },
    };

    console.log('[link-activity] POST metric-aggregates body:', JSON.stringify(body));

    const aggRes = await fetchWithTimeout(
      `${KLAVIYO_BASE}/metric-aggregates/`,
      {
        method: 'POST',
        headers: {
          Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
          revision: REVISION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      12000
    );

    console.log('[link-activity] HTTP status:', aggRes.status);
    const json = await aggRes.json();
    console.log('[link-activity] raw response:', JSON.stringify(json).slice(0, 500));

    if (!aggRes.ok || json.errors) {
      console.log('[link-activity] error:', json.errors?.[0]?.detail);
      return res.json([]);
    }

    // Struttura risposta verificata:
    // json.data.attributes.data = array di item
    // item.dimensions[0] = URL
    // item.measurements.count = array numeri (uno per mese) → somma = total clicks
    // item.measurements.unique = array numeri → somma = unique clicks
    const rawItems = json?.data?.attributes?.data || json?.data?.attributes?.results || [];
    console.log('[link-activity] raw items count:', rawItems.length);

    const data = rawItems
      .map(item => {
        // dimensions è array: dimensions[0] = URL
        const url = Array.isArray(item.dimensions) ? item.dimensions[0] : null;
        if (!url) return null;

        // measurements.count e .unique sono array per-mese: somma tutto
        const totalClicks = (item.measurements?.count || [])
          .reduce((sum, v) => sum + (parseInt(v) || 0), 0);
        const uniqueClicks = (item.measurements?.unique || [])
          .reduce((sum, v) => sum + (parseInt(v) || 0), 0);

        return { url, totalClicks, uniqueClicks };
      })
      .filter(Boolean)
      .sort((a, b) => b.totalClicks - a.totalClicks);

    console.log('[link-activity] mapped results:', data.length, '| top URL clicks:', data[0]?.totalClicks);

    cache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    console.error('[link-activity] exception:', e.message);
    res.json([]);
  }
});

module.exports = router;
