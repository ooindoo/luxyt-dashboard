const router = require('express').Router();

router.get('/', (req, res) => {
  const { password } = req.query;
  if (!password || password !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true });
});

module.exports = router;
