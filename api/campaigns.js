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

  let sendDate = null;
  if (dateMatch) {
    sendDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
  }

  return {
    language: langMatch ? langMatch[1].toUpperCase() : 'N/A',
    sendDate,
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

async function fetchCampaignStats(campaignIds) {
  if (!campaignIds.length) return {};
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

router.get('/', async (req, res) => {
  const cacheKey = 'campaigns';
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const rawCampaigns = await fetchAllCampaigns();
    const ids = rawCampaigns.map(c => c.id);
    const statsMap = await fetchCampaignStats(ids).catch(() => ({}));

    const data = rawCampaigns.map(c => {
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
    });

    cache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    res.json([]);
  }
});

module.exports = router;
