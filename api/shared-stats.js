/**
 * Shared Klaviyo stats cache con request deduplication.
 * Evita chiamate doppie a campaign-values-reports (Klaviyo rate-limita dopo 2 richieste).
 * Tutti gli endpoint (campaigns, panoramica-data, weekly-report) usano questo modulo.
 */
const KLAVIYO_BASE  = 'https://a.klaviyo.com/api';
const REVISION      = '2024-10-15';
const CONVERSION_ID = 'SRuFLu';
const CACHE_TTL     = 60 * 60 * 1000; // 60 minuti

let cachedStats  = null;   // { data: Map, ts: number } | null
let inFlight     = null;   // Promise in corso (evita doppie chiamate simultanee)
let lastRetryAt  = 0;      // evita retry troppo frequenti

function klaviyoHeaders() {
  return {
    Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
    revision: REVISION,
    'Content-Type': 'application/json',
  };
}

async function doFetch() {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(`${KLAVIYO_BASE}/campaign-values-reports/`, {
      method:  'POST',
      headers: klaviyoHeaders(),
      signal:  ctrl.signal,
      body: JSON.stringify({
        data: {
          type: 'campaign-values-report',
          attributes: {
            statistics: [
              'opens','open_rate','clicks','click_rate',
              'unsubscribes','unsubscribe_rate','spam_complaints',
              'recipients','delivered','delivery_rate',
            ],
            timeframe:             { key: 'last_365_days' },
            conversion_metric_id:  CONVERSION_ID,
            filter:                "equals(send_channel,'email')",
          },
        },
      }),
    });
    clearTimeout(t);

    if (res.status === 429) {
      console.log('[shared-stats] Klaviyo 429 — rate limited');
      return null; // segnale di retry
    }
    if (!res.ok) {
      console.log('[shared-stats] Klaviyo error:', res.status);
      return null;
    }

    const json  = await res.json();
    const map   = {};
    for (const r of json?.data?.attributes?.results || []) {
      const id = r.groupings?.campaign_id || r.id;
      if (id) map[id] = r.statistics || {};
    }
    console.log('[shared-stats] Fetched stats — campaigns:', Object.keys(map).length);
    return map;
  } catch (e) {
    clearTimeout(t);
    console.log('[shared-stats] fetch error:', e.message);
    return null;
  }
}

/**
 * Restituisce la stats Map.
 * - Se la cache è valida, restituisce quella.
 * - Se c'è una richiesta in volo, aspetta quella (deduplication).
 * - Altrimenti fa una nuova richiesta.
 * - NON cacha risultati vuoti (errori/429).
 */
async function getCampaignStats() {
  // Cache hit
  if (cachedStats && Date.now() - cachedStats.ts < CACHE_TTL) {
    return cachedStats.data;
  }

  // Deduplication: se c'è già una richiesta in corso, aspetta quella
  if (inFlight) {
    console.log('[shared-stats] waiting for in-flight request');
    return inFlight;
  }

  // Throttle retry: non riprovare più di 1 volta ogni 5s
  if (Date.now() - lastRetryAt < 5000) {
    console.log('[shared-stats] throttle retry, returning stale/empty');
    return cachedStats?.data || {};
  }

  lastRetryAt = Date.now();
  inFlight = doFetch().then(map => {
    inFlight = null;
    if (map && Object.keys(map).length > 0) {
      cachedStats = { data: map, ts: Date.now() };
      console.log('[shared-stats] cached', Object.keys(map).length, 'campaign stats');
    } else {
      console.log('[shared-stats] empty result, NOT caching');
    }
    return map || cachedStats?.data || {};
  }).catch(() => {
    inFlight = null;
    return cachedStats?.data || {};
  });

  return inFlight;
}

module.exports = { getCampaignStats };
