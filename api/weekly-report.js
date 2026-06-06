const router = require('express').Router();
const { getCampaignStats } = require('./shared-stats');

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 60 minuti
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-10-15';
const CLICKED_EMAIL_METRIC_ID = 'UDUzgX';
const MSG_REVISION = '2026-04-15';

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
    number:   numMatch  ? parseInt(numMatch[1]) : null,
  };
}

// ── Fetch campagne sparse ─────────────────────────────────────────────────────
async function fetchCampaigns() {
  const url = `${KLAVIYO_BASE}/campaigns/?filter=${CAMPAIGNS_FILTER}&sort=-scheduled_at`
            + `&fields%5Bcampaign%5D=name,status,send_time,scheduled_at`;
  const res = await fetchWithTimeout(url, { headers: klaviyoHeaders() }, 8000);
  if (!res.ok) return [];
  return (await res.json()).data || [];
}

// ── Fetch statistiche ─────────────────────────────────────────────────────────
// weekly-report usa il modulo condiviso (evita altra chiamata Klaviyo)
async function fetchStats() {
  return getCampaignStats();
}

// ── Fetch messaggi SOLO per le campagne filtrate (poche, parallelo totale) ────
async function fetchMessages(campaigns) {
  const pairs = campaigns
    .map(c => ({
      msgId:  c.relationships?.['campaign-messages']?.data?.[0]?.id,
      campId: c.id,
    }))
    .filter(p => p.msgId);
  if (!pairs.length) return {};

  const results = await Promise.all(pairs.map(async ({ msgId }) => {
    const res = await fetchWithTimeout(
      `${KLAVIYO_BASE}/campaign-messages/${msgId}/`,
      { headers: { Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`, revision: MSG_REVISION } },
      4000
    ).catch(() => null);
    if (!res?.ok) return null;
    const j = await res.json().catch(() => null);
    const def = j?.data?.attributes?.definition?.content || j?.data?.attributes?.content || {};
    return { msgId, def };
  }));

  const map = {};
  for (const r of results) if (r) map[r.msgId] = r.def;
  return map;
}

// ── Fetch link activity per campagna ─────────────────────────────────────────
async function fetchLinkActivity(campaignId) {
  const cacheKey = `link_${campaignId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  try {
    const end   = new Date().toISOString().slice(0, 19);
    const start = new Date(Date.now() - 364 * 86400 * 1000).toISOString().slice(0, 19);

    const res = await fetchWithTimeout(
      `${KLAVIYO_BASE}/metric-aggregates/`,
      {
        method: 'POST',
        headers: klaviyoHeaders(),
        body: JSON.stringify({
          data: {
            type: 'metric-aggregate',
            attributes: {
              metric_id: CLICKED_EMAIL_METRIC_ID,
              measurements: ['count','unique'],
              interval: 'month',
              filter: [
                `greater-or-equal(datetime,${start})`,
                `less-than(datetime,${end})`,
                `equals($message,"${campaignId}")`,
              ],
              by: ['URL'],
              page_size: 500,
            },
          },
        }),
      },
      8000
    );
    if (!res.ok) return [];
    const j = await res.json();
    if (j.errors) return [];
    const items = j?.data?.attributes?.data || [];
    const data = items
      .map(item => {
        const url = item.dimensions?.[0] || '';
        if (!url) return null;
        const totalClicks  = (item.measurements?.count  || []).reduce((a, b) => a + (parseInt(b) || 0), 0);
        const uniqueClicks = (item.measurements?.unique || []).reduce((a, b) => a + (parseInt(b) || 0), 0);
        return { url, totalClicks, uniqueClicks };
      })
      .filter(Boolean)
      .sort((a, b) => b.totalClicks - a.totalClicks);

    cache.set(cacheKey, { data, ts: Date.now() });
    return data;
  } catch {
    return [];
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.json({ campaigns: [], totals: {}, linkActivity: {} });

  const cacheKey = `weekly_${start}_${end}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return res.json(hit.data);

  try {
    // 1. Fetch campagne + stats in parallelo
    const [allCampaigns, statsMap] = await Promise.all([
      fetchCampaigns().catch(() => []),
      fetchStats().catch(() => ({})),
    ]);

    // 2. Filtra per range date usando send_time reale (UTC esplicito)
    const startDate = new Date(start + 'T00:00:00Z');
    const endDate   = new Date(end   + 'T23:59:59Z');

    const filtered = allCampaigns.filter(c => {
      const t = c.attributes?.send_time || c.attributes?.scheduled_at;
      if (!t) return false;
      const d = new Date(t);
      return d >= startDate && d <= endDate;
    });

    // 3. Fetch messaggi SOLO per le campagne nel range (di solito 2-10)
    const msgMap = await fetchMessages(filtered).catch(() => ({}));

    // 4. Mappa
    const campaigns = filtered.map(c => {
      const attrs = c.attributes || {};
      const { language, sendDate, number } = parseCampaignName(attrs.name || '');
      const st = statsMap[c.id] || {};
      const msgId = c.relationships?.['campaign-messages']?.data?.[0]?.id;
      const msg   = msgId ? (msgMap[msgId] || {}) : {};
      const rawTime = attrs.send_time || attrs.scheduled_at;

      return {
        id:       c.id,
        name:     attrs.name || '',
        language,
        sendDate,
        sendTime: rawTime
          ? new Date(rawTime).toLocaleTimeString('it-IT', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Rome' })
          : null,
        subject:     msg.subject      || '',
        previewText: msg.preview_text || '',
        recipients:  Math.round(st.recipients  || 0),
        opens:       Math.round(st.opens       || 0),
        openRate:    st.open_rate  ? parseFloat((st.open_rate  * 100).toFixed(1)) : 0,
        clicks:      Math.round(st.clicks      || 0),
        clickRate:   st.click_rate ? parseFloat((st.click_rate * 100).toFixed(1)) : 0,
        unsubscribes: Math.round(st.unsubscribes || 0),
        spamComplaints: Math.round(st.spam_complaints || 0),
        delivered:   Math.round(st.delivered   || 0),
        bounces:     Math.max(0, Math.round((st.recipients || 0) - (st.delivered || 0))),
        number,
      };
    });

    // 5. Totali
    const totals = {
      recipients:    campaigns.reduce((s, c) => s + c.recipients, 0),
      opens:         campaigns.reduce((s, c) => s + c.opens, 0),
      clicks:        campaigns.reduce((s, c) => s + c.clicks, 0),
      unsubscribes:  campaigns.reduce((s, c) => s + c.unsubscribes, 0),
      spamComplaints:campaigns.reduce((s, c) => s + c.spamComplaints, 0),
      delivered:     campaigns.reduce((s, c) => s + c.delivered, 0),
      bounces:       campaigns.reduce((s, c) => s + c.bounces, 0),
      openRate:  campaigns.length ? parseFloat((campaigns.reduce((s,c) => s+c.openRate,0)  / campaigns.length).toFixed(1)) : 0,
      clickRate: campaigns.length ? parseFloat((campaigns.reduce((s,c) => s+c.clickRate,0) / campaigns.length).toFixed(1)) : 0,
    };

    // 6. Link activity in parallelo per campagne con click
    const withClicks = campaigns.filter(c => c.clicks > 0);
    const linkResults = await Promise.all(
      withClicks.map(c => fetchLinkActivity(c.id).then(links => ({ id: c.id, links })))
    );
    const linkActivity = {};
    for (const { id, links } of linkResults) if (links.length) linkActivity[id] = links;

    const data = { campaigns, totals, linkActivity };
    cache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    const stale = cache.get(cacheKey);
    if (stale) return res.json(stale.data);
    res.json({ campaigns: [], totals: {}, linkActivity: {} });
  }
});

module.exports = router;
