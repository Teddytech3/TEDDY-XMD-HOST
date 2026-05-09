const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'teddy';
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const HEROKU_TEAM = process.env.HEROKU_TEAM;
const HEROKU_API = 'https://api.heroku.com';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrateDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        github_username TEXT PRIMARY KEY,
        is_approved BOOLEAN DEFAULT true,
        is_banned BOOLEAN DEFAULT false,
        max_bots INTEGER DEFAULT 2,
        deployment_count INTEGER DEFAULT 0,
        subscription_plan TEXT DEFAULT 'free',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS bots (
        app_name TEXT PRIMARY KEY,
        heroku_app_name TEXT,
        github_username TEXT REFERENCES users(github_username) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        status TEXT DEFAULT 'running'
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE,
        price TEXT,
        duration_days INTEGER,
        max_bots INTEGER,
        features TEXT[],
        is_active BOOLEAN DEFAULT true
      );
    `);
    const { rows } = await client.query('SELECT COUNT(*) FROM plans');
    if (parseInt(rows[0].count) === 0) {
      await client.query(
        `INSERT INTO plans (name, price, duration_days, max_bots, features) VALUES
         ('free', 'Free', 36500, 2, ARRAY['2 bots', 'Basic features'])`
      );
    }
  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    client.release();
  }
}
migrateDb().catch(console.error);

async function checkFork(username) {
  try {
    const url = `https://api.github.com/repos/Teddytech1/TEDDY-XMD/forks?per_page=100`;
    const resp = await axios.get(url, { timeout: 10000 });
    const forks = resp.data;
    const userFork = forks.find(fork => fork.owner.login.toLowerCase() === username.toLowerCase());
    return { hasFork:!!userFork, forkUrl: userFork?.html_url };
  } catch (e) {
    return { hasFork: false, error: e.message };
  }
}

async function herokuRequest(method, path, data = null) {
  try {
    const response = await axios({
      method,
      url: `${HEROKU_API}${path}`,
      headers: {
        'Authorization': `Bearer ${HEROKU_API_KEY}`,
        'Accept': 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
      },
      data
    });
    return response.data;
  } catch (err) {
    if (err.response) {
      throw new Error(`Heroku API error: ${err.response.data.message || err.response.statusText}`);
    }
    throw err;
  }
}

async function createHerokuApp(baseName) {
  const safeBase = baseName.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const appName = `${safeBase}-${crypto.randomBytes(4).toString('hex')}`;

  const payload = { name: appName, region: 'us' };
  if (HEROKU_TEAM) payload.team = HEROKU_TEAM;

  const data = await herokuRequest('POST', '/apps', payload);
  return { id: data.id, name: data.name };
}

async function setHerokuConfigVars(appName, envVars) {
  return await herokuRequest('PATCH', `/apps/${appName}/config-vars`, envVars);
}

async function deployFromGitHub(appName, repoUrl) {
  const tarballUrl = repoUrl.replace('github.com', 'api.github.com/repos') + '/tarball/main';
  return await herokuRequest('POST', `/apps/${appName}/builds`, {
    source_blob: { url: tarballUrl, version: 'main' }
  });
}

async function deleteHerokuApp(appName) {
  await herokuRequest('DELETE', `/apps/${appName}`);
}

// API Routes
app.get('/api/plans', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM plans WHERE is_active = true');
  res.json({ plans: rows });
});

app.post('/check-fork', async (req, res) => {
  const { githubUsername } = req.body;
  if (!githubUsername) return res.status(400).json({ error: 'Username required' });

  const forkInfo = await checkFork(githubUsername);
  const user = await pool.query('SELECT * FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  let userData = user.rows[0];

  if (!userData) {
    await pool.query(
      'INSERT INTO users (github_username, max_bots, subscription_plan) VALUES ($1, $2, $3)',
      [githubUsername.toLowerCase(), 2, 'free']
    );
    userData = {
      github_username: githubUsername.toLowerCase(),
      is_approved: true,
      is_banned: false,
      max_bots: 2,
      deployment_count: 0,
      subscription_plan: 'free'
    };
  }

  const bots = await pool.query(
    'SELECT app_name, heroku_app_name, created_at, status FROM bots WHERE github_username = $1',
    [githubUsername.toLowerCase()]
  );

  res.json({
    hasFork: forkInfo.hasFork,
    forkUrl: forkInfo.forkUrl,
    isApproved: userData.is_approved,
    isBanned: userData.is_banned,
    maxBots: userData.max_bots,
    deploymentCount: userData.deployment_count,
    subscriptionPlan: userData.subscription_plan,
    deployedBots: bots.rows,
    currentBots: bots.rows.length
  });
});

app.post('/deploy', async (req, res) => {
  const { githubUsername, sessionId } = req.body;
  if (!githubUsername ||!sessionId) return res.status(400).json({ error: 'Missing fields' });

  const user = await pool.query('SELECT * FROM users WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (user.rows.length === 0) return res.status(403).json({ error: 'User not found' });
  const userData = user.rows[0];

  if (userData.is_banned) return res.status(403).json({ error: 'User is banned' });
  if (!userData.is_approved) return res.status(403).json({ error: 'User not approved' });

  const botCount = await pool.query('SELECT COUNT(*) FROM bots WHERE github_username = $1', [githubUsername.toLowerCase()]);
  if (parseInt(botCount.rows[0].count) >= userData.max_bots) {
    return res.status(403).json({ error: `Bot limit reached (max ${userData.max_bots} bots)` });
  }

  const baseName = `teddy-${githubUsername}`;

  try {
    const app = await createHerokuApp(baseName);
    await setHerokuConfigVars(app.name, { SESSION_ID: sessionId });

    const forkInfo = await checkFork(githubUsername);
    if (!forkInfo.hasFork) throw new Error('User does not have a fork');

    await deployFromGitHub(app.name, forkInfo.forkUrl);

    await pool.query(
      'INSERT INTO bots (app_name, heroku_app_name, github_username, status) VALUES ($1, $2, $3, $4)',
      [baseName, app.name, githubUsername.toLowerCase(), 'deploying']
    );
    await pool.query(
      'UPDATE users SET deployment_count = deployment_count + 1 WHERE github_username = $1',
      [githubUsername.toLowerCase()]
    );

    res.json({
      success: true,
      appName: baseName,
      herokuAppName: app.name,
      message: `Bot deployed to Heroku successfully! Access at https://${app.name}.herokuapp.com`
    });

  } catch (error) {
    console.error('Deployment error:', error);
    res.status(500).json({ error: 'Failed to deploy to Heroku', details: error.message });
  }
});

app.post('/delete-app', async (req, res) => {
  const { appName, githubUsername } = req.body;
  const bot = await pool.query('SELECT heroku_app_name FROM bots WHERE app_name = $1', [appName]);
  if (bot.rows.length === 0) return res.status(404).json({ error: 'Bot not found' });

  try {
    await deleteHerokuApp(bot.rows[0].heroku_app_name);
    await pool.query('DELETE FROM bots WHERE app_name = $1', [appName]);
    res.json({ success: true, message: 'Bot deleted from Heroku' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Invalid password' });
});

app.post('/admin/users', async (req, res) => {
  if (req.body.password!== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query(`
    SELECT u.*, COUNT(b.app_name) as active_bots
    FROM users u
    LEFT JOIN bots b ON u.github_username = b.github_username
    GROUP BY u.github_username
  `);
  res.json({ users: rows });
});

app.post('/get-all-apps', async (req, res) => {
  if (req.body.password!== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT * FROM bots ORDER BY created_at DESC');
  res.json({ apps: rows });
});

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));