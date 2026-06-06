const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');

router.post('/', async (req, res) => {
  const campaignData = req.body;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const dataStr = JSON.stringify(campaignData, null, 2);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const msg = await client.messages.create(
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: `Sei un consulente di email marketing. Analizza questi dati sulle campagne email degli ultimi 30 giorni e scrivi esattamente 3 frasi in italiano. Tono: consulente di fiducia che parla direttamente al cliente.

REGOLE TASSATIVE:
- Esattamente 3 frasi, niente di più
- Zero termini tecnici (no: nurturing, funnel, KPI, strategia, automazione, deliverability, engagement)
- Zero trattini di qualsiasi tipo (né - né —)
- Zero nomi di città
- Usa solo dati presenti nell'input
- Parla in modo diretto e concreto

Dati campagne:
${dataStr}`,
          },
        ],
      },
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const summary = msg.content[0]?.text || '';
    res.json({ summary });
  } catch (e) {
    clearTimeout(timer);
    res.json({ summary: '' });
  }
});

module.exports = router;
