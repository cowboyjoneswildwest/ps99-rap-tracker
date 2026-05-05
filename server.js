/**
 * PS99 Data Collector Server
 * 
 * This is a standalone Node.js server that:
 * 1. Fetches RAP and Exists data every hour
 * 2. Stores historical data in a JSON file
 * 3. Serves the data via a simple API
 * 
 * DEPLOYMENT OPTIONS (all free):
 * 
 * 1. RENDER.COM (Recommended)
 *    - Go to render.com, create account
 *    - New > Web Service > Connect your repo
 *    - Set Build Command: npm install
 *    - Set Start Command: node collector/server.js
 *    - Choose free tier
 * 
 * 2. RAILWAY.APP
 *    - Go to railway.app, create account
 *    - New Project > Deploy from GitHub
 *    - It auto-detects Node.js
 * 
 * 3. FLY.IO
 *    - Install flyctl CLI
 *    - Run: fly launch
 *    - Run: fly deploy
 * 
 * 4. YOUR OWN COMPUTER
 *    - Run: node collector/server.js
 *    - Keep terminal open 24/7
 *    - Use PM2 for auto-restart: pm2 start collector/server.js
 * 
 * After deploying, update COLLECTOR_URL in the frontend to point to your server.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'history.json');
const HOUR_MS = 60 * 60 * 1000;
const MAX_HISTORY_POINTS = 168; // 7 days of hourly data
// ── Fetch helper ────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}
// ── Load/Save history ───────────────────────────────────────────────────────
function loadHistory() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading history:', e);
  }
  return { items: {}, lastSnapshot: 0, snapshots: 0 };
}
function saveHistory(history) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(history), 'utf8');
  } catch (e) {
    console.error('Error saving history:', e);
  }
}
// ── Build item key ──────────────────────────────────────────────────────────
function buildKey(category, id, pt, sh, tn) {
  let k = category + ':' + id;
  if (pt === 1) k += '|g';
  else if (pt === 2) k += '|r';
  if (sh) k += '|s';
  if (tn != null) k += '|' + tn;
  return k;
}
// ── Collect data ────────────────────────────────────────────────────────────
async function collectData() {
  console.log(`[${new Date().toISOString()}] Collecting data...`);
  
  try {
    const [rapRes, existsRes] = await Promise.all([
      fetchJSON('https://ps99.biggamesapi.io/api/rap'),
      fetchJSON('https://ps99.biggamesapi.io/api/exists'),
    ]);
    if (rapRes.status !== 'ok' || existsRes.status !== 'ok') {
      throw new Error('API returned error status');
    }
    const history = loadHistory();
    const timestamp = Date.now();
    // Build maps
    const rapMap = new Map();
    const existsMap = new Map();
    for (const entry of rapRes.data) {
      const key = buildKey(
        entry.category,
        entry.configData.id,
        entry.configData.pt,
        entry.configData.sh,
        entry.configData.tn
      );
      rapMap.set(key, entry.value);
    }
    for (const entry of existsRes.data) {
      const key = buildKey(
        entry.category,
        entry.configData.id,
        entry.configData.pt,
        entry.configData.sh,
        entry.configData.tn
      );
      existsMap.set(key, entry.value);
    }
    // Record snapshot
    let itemsUpdated = 0;
    for (const [key, rap] of rapMap) {
      const exists = existsMap.get(key);
      if (!exists || rap < 100) continue;
      if (!history.items[key]) {
        history.items[key] = [];
      }
      const points = history.items[key];
      
      // Check if we should add this point
      if (points.length > 0) {
        const last = points[points.length - 1];
        const rapChange = Math.abs(rap - last.r) / Math.max(last.r, 1);
        const existsChange = Math.abs(exists - last.e) / Math.max(last.e, 1);
        
        // Skip if less than 0.5% change
        if (rapChange < 0.005 && existsChange < 0.005) {
          continue;
        }
      }
      // Add point (using short keys to save space)
      points.push({
        t: timestamp,
        r: rap,
        e: exists,
      });
      // Trim old points
      if (points.length > MAX_HISTORY_POINTS) {
        points.splice(0, points.length - MAX_HISTORY_POINTS);
      }
      itemsUpdated++;
    }
    history.lastSnapshot = timestamp;
    history.snapshots = (history.snapshots || 0) + 1;
    saveHistory(history);
    
    console.log(`[${new Date().toISOString()}] Snapshot saved. ${itemsUpdated} items updated. Total items: ${Object.keys(history.items).length}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error collecting data:`, error);
  }
}
// ── HTTP Server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Health check
  if (url.pathname === '/' || url.pathname === '/health') {
    const history = loadHistory();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      items: Object.keys(history.items).length,
      snapshots: history.snapshots || 0,
      lastSnapshot: history.lastSnapshot ? new Date(history.lastSnapshot).toISOString() : null,
      uptime: process.uptime(),
    }));
    return;
  }
  // Get all history
  if (url.pathname === '/api/history') {
    const history = loadHistory();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
    return;
  }
  // Get history for specific item
  if (url.pathname === '/api/history/item') {
    const key = url.searchParams.get('key');
    if (!key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key parameter' }));
      return;
    }
    const history = loadHistory();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key,
      points: history.items[key] || [],
    }));
    return;
  }
  // Get stats
  if (url.pathname === '/api/stats') {
    const history = loadHistory();
    let totalPoints = 0;
    let oldest = Infinity;
    let newest = 0;
    for (const points of Object.values(history.items)) {
      totalPoints += points.length;
      for (const p of points) {
        if (p.t < oldest) oldest = p.t;
        if (p.t > newest) newest = p.t;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      totalItems: Object.keys(history.items).length,
      totalPoints,
      snapshots: history.snapshots || 0,
      oldestData: oldest < Infinity ? new Date(oldest).toISOString() : null,
      newestData: newest > 0 ? new Date(newest).toISOString() : null,
      lastSnapshot: history.lastSnapshot ? new Date(history.lastSnapshot).toISOString() : null,
    }));
    return;
  }
  // Force collect (for testing)
  if (url.pathname === '/api/collect') {
    collectData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'collecting' }));
    return;
  }
  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});
// ── Start server ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                  PS99 DATA COLLECTOR SERVER                   ║
╠══════════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                                  ║
║  Collecting data every hour                                   ║
║                                                               ║
║  Endpoints:                                                   ║
║    GET /health        - Server status                         ║
║    GET /api/history   - All historical data                   ║
║    GET /api/stats     - Statistics                            ║
║    GET /api/collect   - Force data collection                 ║
║                                                               ║
║  Data stored in: ${DATA_FILE}
╚══════════════════════════════════════════════════════════════╝
  `);
  // Initial collection
  collectData();
  // Schedule hourly collection
  setInterval(collectData, HOUR_MS);
});
// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
