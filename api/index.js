require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Auth check middleware for all /api/* except /api/auth
app.use('/api', (req, res, next) => {
  if (req.path === '/auth' || req.path.startsWith('/auth?')) return next();
  const token = req.headers['x-auth-token'];
  if (!token || token !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.use('/api/auth',            require('./auth'));
app.use('/api/panoramica-data', require('./panoramica-data'));
app.use('/api/ai-summary',      require('./ai-summary'));
app.use('/api/campaigns',       require('./campaigns'));
app.use('/api/link-activity',   require('./link-activity'));
app.use('/api/weekly-report',   require('./weekly-report'));
app.use('/api/health',          require('./routes/health'));

// SPA fallback (Express 5 wildcard syntax)
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
