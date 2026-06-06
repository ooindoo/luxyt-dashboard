const router = require('express').Router();

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 60 minuti
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-10-15';
const CONVERSION_METRIC_ID = 'SRuFLu';

const CAMPAIGNS_FILTER = "and(equals(messages.channel,'email'),equals(status,'Sent'),greater-or-equal(scheduled_at,2026-01-01T00:00:00Z))";

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

function parseCampaignName(name) {
  const dateMatch = name.match(/\[(\d{2})(\d{2})(\d{4})\]/);
  const langMatch = name.match(/\[(ITA|ENG)\]/i);
  const numMatch  = name.match(/#(\d+)/);
  return {
    language: langMatch ? langMatch[1].toUpperCase() : 'N/A',
    sendDate: dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null,
    number:   numMatch ? parseInt(numMatch[1]) : null,
  };
}

// ── Fetch campagne (parallelo con stats) ──────────────────────────────────────
async function fetchCampaigns() {
  // Sparse fieldset: solo i campi necessari → payload più leggero
  const url = `${KLAVIYO_BASE}/campaigns/?filter=${CAMPAIGNS_FILTER}&sort=-scheduled_at`
            + `&fields%5Bcampaign%5D=name,status,send_time,scheduled_at`;
  const res = await fetchWithTimeout(url, { headers: klaviyoHeaders() }, 8000);
  if (!res.ok) return [];
  const j = await res.json();
  return j.data || [];
}

// ── Fetch statistiche (parallelo con campagne) ────────────────────────────────
async function fetchStats() {
  const res = await fetchWithTimeout(
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
                         'recipients','delivered','delivery_rate'],
            timeframe: { key: 'last_365_days' },
            conversion_metric_id: CONVERSION_METRIC_ID,
            filter: "equals(send_channel,'email')",
          },
        },
      }),
    },
    8000
  );
  if (!res.ok) return {};
  const j = await res.json();
  const map = {};
  for (const r of j?.data?.attributes?.results || []) {
    const id = r.groupings?.campaign_id || r.id;
    if (id) map[id] = r.statistics || {};
  }
  return map;
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const cacheKey = 'campaigns_v2';
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return res.json(hit.data);

  try {
    // Parallelo: campagne + statistiche insieme
    const [rawCampaigns, statsMap] = await Promise.all([
      fetchCampaigns().catch(() => []),
      fetchStats().catch(() => ({})),
    ]);

    const data = rawCampaigns.map(c => {
      const attrs = c.attributes || {};
      const { language, sendDate, number } = parseCampaignName(attrs.name || '');
      const st = statsMap[c.id] || {};
      const rawTime = attrs.send_time || attrs.scheduled_at;

      return {
        id:         c.id,
        name:       attrs.name || '',
        language,
        sendDate,
        sendTime:   rawTime
          ? new Date(rawTime).toLocaleTimeString('it-IT', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Rome' })
          : null,
        recipients: Math.round(st.recipients  || 0),
        opens:      Math.round(st.opens       || 0),
        openRate:   st.open_rate  ? parseFloat((st.open_rate  * 100).toFixed(1)) : 0,
        clicks:     Math.round(st.clicks      || 0),
        clickRate:  st.click_rate ? parseFloat((st.click_rate * 100).toFixed(1)) : 0,
        unsubscribes: Math.round(st.unsubscribes || 0),
        unsubscribeRate: st.unsubscribe_rate ? parseFloat((st.unsubscribe_rate * 100).toFixed(2)) : 0,
        spamComplaints: Math.round(st.spam_complaints || 0),
        delivered:  Math.round(st.delivered   || 0),
        deliveryRate: st.delivery_rate ? parseFloat((st.delivery_rate * 100).toFixed(1)) : 0,
        bounces:    Math.max(0, Math.round((st.recipients || 0) - (st.delivered || 0))),
        number,
      };
    });

    cache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    const stale = cache.get(cacheKey);
    if (stale) return res.json(stale.data);
    res.json([]);
  }
});

module.exports = router;
