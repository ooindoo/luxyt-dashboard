const router = require('express').Router();

// GET /api/analytics/overview
router.get('/overview', (req, res) => {
  res.json({
    visitors:   12480,
    pageviews:  48320,
    bounceRate: 42.3,
    avgSession: '2m 14s',
  });
});

// GET /api/analytics/timeseries
router.get('/timeseries', (req, res) => {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return {
      date:      d.toISOString().split('T')[0],
      visitors:  Math.floor(Math.random() * 2000) + 500,
      pageviews: Math.floor(Math.random() * 8000) + 2000,
    };
  });
  res.json(days);
});

module.exports = router;
