const router = require('express').Router();
const { getCampaignStats } = require('./shared-stats');

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 60 minuti
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-10-15';

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

// fetchStats usa il modulo condiviso (evita doppia chiamata Klaviyo con panoramica-data)

// ── Route ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const cacheKey = 'campaigns_v2';
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return res.json(hit.data);

  try {
    // Parallelo: campagne + statistiche (stats usa modulo condiviso — no doppia chiamata Klaviyo)
    const [rawCampaigns, statsMap] = await Promise.all([
      fetchCampaigns().catch(() => []),
      getCampaignStats().catch(() => ({})),
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

    // Non cachare se tutte le stats sono 0 (fetchStats ha fallito → riprova prossima volta)
    const hasStats = data.some(c => c.recipients > 0 || c.opens > 0);
    if (hasStats) {
      cache.set(cacheKey, { data, ts: Date.now() });
    } else {
      console.log('[campaigns] stats vuote — NON cacho, riproverò al prossimo request');
    }
    res.json(data);
  } catch (e) {
    const stale = cache.get(cacheKey);
    if (stale) return res.json(stale.data);
    res.json([]);
  }
});

module.exports = router;
