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
  let url = `${KLAVIYO_BASE}/campaigns/?filter=equals(messages.channel,'email')&sort=-created_at&page[size]=50`;
  while (url) {
    const res = await fetchWithTimeout(url, { headers: klaviyoHeaders() }, 5000);
    if (!res.ok) break;
    const json = await res.json();
    campaigns.push(...(json.data || []));
    url = json.links?.next || null;
    if (campaigns.length >= 200) break;
  }
  return campaigns;
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
              'bounces', 'bounce_rate',
              'spam_complaints', 'recipients',
            ],
            timeframe: { key: 'all_time' },
            filter: "equals(send_channel,'email')",
          },
        },
      }),
    },
    5000
  );
  if (!res.ok) return {};
  const json = await res.json();
  const statsMap = {};
  for (const r of json?.data?.attributes?.results || []) {
    statsMap[r.id] = r.attributes;
  }
  return statsMap;
}

async function fetchLinkActivity(campaignId) {
  const cacheKey = `link_${campaignId}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const metricsRes = await fetchWithTimeout(
      `${KLAVIYO_BASE}/metrics/`,
      { headers: klaviyoHeaders() },
      5000
    );
    if (!metricsRes.ok) return [];
    const metricsJson = await metricsRes.json();
    const metric = (metricsJson.data || []).find(m => m.attributes?.name === 'Clicked Email');
    if (!metric) return [];

    const aggRes = await fetchWithTimeout(
      `${KLAVIYO_BASE}/metric-aggregates/`,
      {
        method: 'POST',
        headers: klaviyoHeaders(),
        body: JSON.stringify({
          data: {
            type: 'metric-aggregate',
            attributes: {
              metric_id: metric.id,
              measurements: ['unique', 'count'],
              filter: [`equals(campaign_id,"${campaignId}")`],
              by: ['$event_properties.URL'],
              sort: '-count',
              page_size: 100,
            },
          },
        }),
      },
      5000
    );
    if (!aggRes.ok) return [];
    const json = await aggRes.json();
    const attrs = json?.data?.attributes || {};
    let data = [];
    if (attrs.results) {
      data = attrs.results.map(r => ({
        url: r.dimensions?.['$event_properties.URL'] || '',
        uniqueClicks: r.measurements?.unique || 0,
        totalClicks: r.measurements?.count || 0,
      }));
    }
    data.sort((a, b) => b.totalClicks - a.totalClicks);
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

    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);

    const filtered = rawCampaigns
      .map(c => {
        const attrs = c.attributes || {};
        const msg = attrs.message || {};
        const { language, sendDate, number } = parseCampaignName(attrs.name || '');
        const st = statsMap[c.id] || {};
        return {
          id: c.id,
          name: attrs.name || '',
          language,
          sendDate,
          sendTime: attrs.scheduled_at ? attrs.scheduled_at.split('T')[1]?.slice(0, 5) : null,
          subject: msg.subject || attrs.subject || '',
          previewText: msg.preview_text || attrs.preview_text || '',
          recipients: st.recipients || 0,
          opens: st.opens || 0,
          openRate: st.open_rate ? parseFloat((st.open_rate * 100).toFixed(1)) : 0,
          clicks: st.clicks || 0,
          clickRate: st.click_rate ? parseFloat((st.click_rate * 100).toFixed(1)) : 0,
          unsubscribes: st.unsubscribes || 0,
          unsubscribeRate: st.unsubscribe_rate ? parseFloat((st.unsubscribe_rate * 100).toFixed(2)) : 0,
          spamComplaints: st.spam_complaints || 0,
          bounces: st.bounces || 0,
          bounceRate: st.bounce_rate ? parseFloat((st.bounce_rate * 100).toFixed(2)) : 0,
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
