const router = require('express').Router();

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const REVISION = '2024-10-15';
const CONVERSION_METRIC_ID = 'SRuFLu'; // Opened Email

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
  // Filtra: solo email, solo Sent, solo dal 2026 (send_time non è filtrabile → uso scheduled_at)
  let url = `${KLAVIYO_BASE}/campaigns/?filter=and(equals(messages.channel,'email'),equals(status,'Sent'),greater-or-equal(scheduled_at,2026-01-01T00:00:00Z))&sort=-scheduled_at`;

  while (url) {
    const res = await fetchWithTimeout(url, { headers: klaviyoHeaders() }, 25000);
    if (!res.ok) break;
    const json = await res.json();
    campaigns.push(...(json.data || []));
    // Limite 100 campagne (≈ 1 anno per Luxyt) per rispettare timeout Vercel
    url = null;
  }
  return campaigns;
}

async function fetchMessagesForCampaigns(campaigns) {
  // API 2026-04-15: singolo fetch per ID, soggetto in .definition.content
  // Limite concorrenza: 20 richieste parallele alla volta
  const MSG_REVISION = '2026-04-15';
  const pairs = campaigns
    .map(c => ({
      msgId: c.relationships?.['campaign-messages']?.data?.[0]?.id,
      campId: c.id,
    }))
    .filter(p => p.msgId);

  if (!pairs.length) return {};

  const msgMap = {};
  const concurrency = 5;
  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency);
    await Promise.all(batch.map(async ({ msgId }) => {
      const res = await fetchWithTimeout(
        `${KLAVIYO_BASE}/campaign-messages/${msgId}/`,
        {
          headers: {
            Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
            revision: MSG_REVISION,
          },
        },
        5000
      ).catch(() => null);
      if (!res || !res.ok) return;
      const json = await res.json().catch(() => null);
      if (!json?.data) return;
      // In revision 2026-04-15 il content è sotto .definition.content
      const def = json.data.attributes?.definition?.content
                || json.data.attributes?.content || {};
      msgMap[msgId] = def;
    }));
  }
  return msgMap;
}

async function fetchCampaignStats() {
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
            // last_365_days funziona con API 2024-10-15 quando si include statistics[]
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
  // API 2024-10-15: risultati in .statistics (non .attributes), id in .groupings.campaign_id
  const statsMap = {};
  for (const r of json?.data?.attributes?.results || []) {
    const cid = r.groupings?.campaign_id || r.id;
    if (cid) statsMap[cid] = r.statistics || {};
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
    const [rawCampaigns, statsMap] = await Promise.all([
      fetchAllCampaigns(),
      fetchCampaignStats().catch(() => ({})),
    ]);
    // Fetch messaggi in parallelo dopo aver ottenuto i campaign IDs
    const msgMap = await fetchMessagesForCampaigns(rawCampaigns).catch(() => ({}));

    const data = rawCampaigns.map(c => {
      const attrs = c.attributes || {};
      const { language, sendDate, number } = parseCampaignName(attrs.name || '');
      const st = statsMap[c.id] || {};

      // subject/preview: dall'included campaign-message tramite relationship
      const msgId = c.relationships?.['campaign-messages']?.data?.[0]?.id;
      const msgContent = msgMap[msgId] || {};

      // send_time: usa send_time (orario effettivo) oppure scheduled_at, convertito in timezone Rome
      const rawTime = attrs.send_time || attrs.scheduled_at;
      const sendTime = rawTime
        ? new Date(rawTime).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
        : null;

      return {
        id: c.id,
        name: attrs.name || '',
        language,
        sendDate,
        sendTime,
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
        deliveryRate: st.delivery_rate ? parseFloat((st.delivery_rate * 100).toFixed(1)) : 0,
        // bounces non esiste nelle statistiche Klaviyo 2024: si calcola come recipients - delivered
        bounces: Math.max(0, Math.round((st.recipients || 0) - (st.delivered || 0))),
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
