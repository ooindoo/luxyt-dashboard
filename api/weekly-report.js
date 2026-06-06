const router = require('express').Router();

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-10-15';
const CONVERSION_METRIC_ID = 'SRuFLu';
const CLICKED_EMAIL_METRIC_ID = 'UDUzgX';

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

function parseCampaignName(name) {
  const dateMatch = name.match(/\[(\d{2})(\d{2})(\d{4})\]/);
  const langMatch = name.match(/\[(ITA|ENG)\]/i);
  const numMatch = name.match(/#(\d+)/);
  return {
    language: langMatch ? langMatch[1].toUpperCase() : 'N/A',
    sendDate: dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null,
    number: numMatch ? parseInt(numMatch[1]) : null,
  };
}

async function fetchAllCampaigns() {
  const campaigns = [];
  let url = `${KLAVIYO_BASE}/campaigns/?filter=equals(messages.channel,'email')&sort=-created_at`;
  while (url) {
    const res = await fetchWithTimeout(url, { headers: klaviyoHeaders() }, 25000);
    if (!res.ok) break;
    const json = await res.json();
    campaigns.push(...(json.data || []));
    url = null; // Limite 100 campagne per timeout Vercel
  }
  return campaigns;
}

async function fetchMessagesForCampaigns(campaigns) {
  const MSG_REVISION = '2026-04-15';
  const pairs = campaigns
    .map(c => ({ msgId: c.relationships?.['campaign-messages']?.data?.[0]?.id, campId: c.id }))
    .filter(p => p.msgId);
  if (!pairs.length) return {};

  const msgMap = {};
  const concurrency = 5;
  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency);
    await Promise.all(batch.map(async ({ msgId }) => {
      const res = await fetchWithTimeout(
        `${KLAVIYO_BASE}/campaign-messages/${msgId}/`,
        { headers: { Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`, revision: MSG_REVISION } },
        5000
      ).catch(() => null);
      if (!res || !res.ok) return;
      const json = await res.json().catch(() => null);
      if (!json?.data) return;
      const def = json.data.attributes?.definition?.content || json.data.attributes?.content || {};
      msgMap[msgId] = def;
    }));
  }
  return msgMap;
}

async function fetchStatsForCampaigns() {
  const res = await fetchWithTimeout(
    `${KLAVIYO_BASE}/campaign-values-reports/`,
    {
      method: 'POST',
      headers: klaviyoHeaders(),
      body: JSON.stringify({
        data: {
          type: 'campaign-values-report',
          attributes: {
            statistics: [
              'opens', 'open_rate', 'clicks', 'click_rate',
              'unsubscribes', 'unsubscribe_rate',
              'spam_complaints', 'recipients',
              'delivered', 'delivery_rate',
            ],
            timeframe: { key: 'last_365_days' },
            conversion_metric_id: CONVERSION_METRIC_ID,
            filter: "equals(send_channel,'email')",
          },
        },
      }),
    },
    25000
  );
  if (!res.ok) return {};
  const json = await res.json();
  const statsMap = {};
  for (const r of json?.data?.attributes?.results || []) {
    const cid = r.groupings?.campaign_id || r.id;
    if (cid) statsMap[cid] = r.statistics || {};
  }
  return statsMap;
}

async function fetchLinkActivity(campaignId) {
  const cacheKey = `link_${campaignId}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const end = new Date().toISOString().slice(0, 19);
    const start = new Date(Date.now() - 364 * 86400 * 1000).toISOString().slice(0, 19);

    const aggRes = await fetchWithTimeout(
      `${KLAVIYO_BASE}/metric-aggregates/`,
      {
        method: 'POST',
        headers: klaviyoHeaders(),
        body: JSON.stringify({
          data: {
            type: 'metric-aggregate',
            attributes: {
              metric_id: CLICKED_EMAIL_METRIC_ID,
              measurements: ['count', 'unique'],
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
      10000
    );
    if (!aggRes.ok) return [];
    const json = await aggRes.json();
    if (json.errors) return [];
    const items = json?.data?.attributes?.data || [];
    const data = items
      .map(item => {
        const url = item.dimensions?.[0] || '';
        if (!url) return null;
        const totalClicks = (item.measurements?.count || []).reduce((a, b) => a + (parseInt(b) || 0), 0);
        const uniqueClicks = (item.measurements?.unique || []).reduce((a, b) => a + (parseInt(b) || 0), 0);
        return { url, totalClicks, uniqueClicks };
      })
      .filter(Boolean)
      .sort((a, b) => b.totalClicks - a.totalClicks);
    cache.set(cacheKey, { data, ts: Date.now() });
    return data;
  } catch (e) {
    return [];
  }
}

router.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.json({ campaigns: [], totals: {}, linkActivity: {} });

  const cacheKey = `weekly_${start}_${end}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return res.json(cached.data);

  try {
    const [rawCampaigns, statsMap] = await Promise.all([
      fetchAllCampaigns().catch(() => []),
      fetchStatsForCampaigns().catch(() => ({})),
    ]);
    const msgMap = await fetchMessagesForCampaigns(rawCampaigns).catch(() => ({}));

    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);

    const filtered = rawCampaigns
      .map(c => {
        const attrs = c.attributes || {};
        const { language, sendDate, number } = parseCampaignName(attrs.name || '');
        const st = statsMap[c.id] || {};
        const msgId = c.relationships?.['campaign-messages']?.data?.[0]?.id;
        const msgContent = msgId ? (msgMap[msgId] || {}) : {};
        const rawTime = attrs.send_time || attrs.scheduled_at;
        return {
          id: c.id,
          name: attrs.name || '',
          language,
          sendDate,
          sendTime: rawTime ? new Date(rawTime).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }) : null,
          subject: msgContent.subject || '',
          previewText: msgContent.preview_text || '',
          recipients: Math.round(st.recipients || 0),
          opens: Math.round(st.opens || 0),
          openRate: st.open_rate ? parseFloat((st.open_rate * 100).toFixed(1)) : 0,
          clicks: Math.round(st.clicks || 0),
          clickRate: st.click_rate ? parseFloat((st.click_rate * 100).toFixed(1)) : 0,
          unsubscribes: Math.round(st.unsubscribes || 0),
          unsubscribeRate: st.unsubscribe_rate ? parseFloat((st.unsubscribe_rate * 100).toFixed(2)) : 0,
          spamComplaints: Math.round(st.spam_complaints || 0),
          delivered: Math.round(st.delivered || 0),
          bounces: Math.max(0, Math.round((st.recipients || 0) - (st.delivered || 0))),
          number,
        };
      })
      .filter(c => {
        if (!c.sendDate) return false;
        const d = new Date(c.sendDate);
        return d >= startDate && d <= endDate;
      });

    const totals = {
      recipients: filtered.reduce((s, c) => s + c.recipients, 0),
      opens: filtered.reduce((s, c) => s + c.opens, 0),
      clicks: filtered.reduce((s, c) => s + c.clicks, 0),
      unsubscribes: filtered.reduce((s, c) => s + c.unsubscribes, 0),
      spamComplaints: filtered.reduce((s, c) => s + c.spamComplaints, 0),
      delivered: filtered.reduce((s, c) => s + c.delivered, 0),
      bounces: filtered.reduce((s, c) => s + c.bounces, 0),
      openRate: filtered.length ? parseFloat((filtered.reduce((s, c) => s + c.openRate, 0) / filtered.length).toFixed(1)) : 0,
      clickRate: filtered.length ? parseFloat((filtered.reduce((s, c) => s + c.clickRate, 0) / filtered.length).toFixed(1)) : 0,
    };

    const linkActivityMap = {};
    const campaignsWithClicks = filtered.filter(c => c.clicks > 0);
    const linkResults = await Promise.all(
      campaignsWithClicks.map(c => fetchLinkActivity(c.id).then(links => ({ id: c.id, links })))
    );
    for (const { id, links } of linkResults) {
      if (links.length > 0) linkActivityMap[id] = links;
    }

    const data = { campaigns: filtered, totals, linkActivity: linkActivityMap };
    cache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    res.json({ campaigns: [], totals: {}, linkActivity: {} });
  }
});

module.exports = router;
