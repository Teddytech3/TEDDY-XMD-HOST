const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
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

  const payload = {
    name: appName,
    region: 'us'
  };

  if (HEROKU_TEAM) {
    payload.team = HEROKU_TEAM;
  }

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

app.get('/', (req, res) => {
  res.json({ message: 'TEDDY-XMD Bot Deployer Backend', status: 'running' });
});

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
  if (parseInt(botCount.rows[0].count) >= userData.max_bots