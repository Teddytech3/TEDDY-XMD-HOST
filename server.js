const express = require('express');
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
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '254700000';
const HEROKU_API = 'https://api.heroku.com';

// In-memory storage - resets on restart
let users = {};
let bots = [];
let plans = [
  { id: 1, name: 'Free', price: 'Free', duration_days: 36500, max_bots: 2, features: ['2 bots', 'Basic features'], is_active: true },
  { id: 2, name: 'Pro', price: '$5/month', duration_days: 30, max_bots: 5, features: ['5 bots', 'Priority deploy', '24/7 support'], is_active: true },
  { id: 3, name: 'Ultra', price: '$15/month', duration_days: 30, max_bots: 15, features: ['15 bots', 'Dedicated resources', 'Custom domain'], is_active: true }
];

async function checkFork(username) {
  try {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'teddy-xmd-deployer'
    };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;

    const url = `https://api.github.com/repos/Teddytech1/TEDDY-XMD/forks?per_page=100`;
    const resp = await axios.get(url, { headers, timeout: 15000 });

    const forks = resp.data;
    const userFork = forks.find(fork => fork.owner.login.toLowerCase() === username.toLowerCase());
    return { hasFork:!!userFork, forkUrl: userFork?.html_url, error: null };
  } catch (e) {
    console.error('GitHub API error:', e.response?.data || e.message);
    return { hasFork: false, error: e.response?.data?.message || e.message };
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
    if (err.response) throw new Error(`Heroku API error: ${err.response.data.message || err.response.statusText}`);
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
  res.json({ plans: plans.filter(p => p.is_active), whatsapp: WHATSAPP_NUMBER });
});

app.post('/check-fork', async (req, res) => {
  const { githubUsername } = req.body;
  if (!githubUsername) return res.status(400).json({ error: 'Username required' });

  const forkInfo = await checkFork(githubUsername);
  const username = githubUsername.toLowerCase();

  if (!users[username]) {
    users[username] = {
      github_username: username,
      is_approved: true,
      is_banned: false,
      max_bots: 2,
      deployment_count: 0,
      subscription_plan: 'free'
    };
  }

  const userBots = bots.filter(b => b.github_username === username);

  res.json({
    hasFork: forkInfo.hasFork,
    forkUrl: forkInfo.forkUrl,
    forkError: forkInfo.error,
    isApproved: users[username].is_approved,
    isBanned: users[username].is_banned,
    maxBots: users[username].max_bots,
    deploymentCount: users[username].deployment_count,
    subscriptionPlan: users[username].subscription_plan,
    deployedBots: userBots,
    currentBots: userBots.length
  });
});

app.post('/deploy', async (req, res) => {
  const { githubUsername, sessionId } = req.body;
  if (!githubUsername ||!sessionId) return res.status(400).json({ error: 'Missing fields' });

  const username = githubUsername.toLowerCase();
  if (!users[username]) return res.status(403).json({ error: 'User not found' });

  const userData = users[username];
  if (userData.is_banned) return res.status(403).json({ error: 'User is banned' });
  if (!userData.is_approved) return res.status(403).json({ error: 'User not approved' });

  const userBots = bots.filter(b => b.github_username === username);
  if (userBots.length >= userData.max_bots) {
    return res.status(403).json({ error: `Bot limit reached (max ${userData.max_bots} bots)` });
  }

  const baseName = `teddy-${username}`;

  try {
    const app = await createHerokuApp(baseName);
    await setHerokuConfigVars(app.name, { SESSION_ID: sessionId });

    const forkInfo = await checkFork(username);
    if (!forkInfo.hasFork) throw new Error('User does not have a fork');

    await deployFromGitHub(app.name, forkInfo.forkUrl);

    bots.push({
      app_name: baseName,
      heroku_app_name: app.name,
      github_username: username,
      created_at: new Date().toISOString(),
      status: 'deploying'
    });

    users[username].deployment_count += 1;

    res.json({
      success: true,
      appName: baseName,
      herokuAppName: app.name,
      message: `Bot deployed! Access at https://${app.name}.herokuapp.com`
    });
  } catch (error) {
    console.error('Deployment error:', error);
    res.status(500).json({ error: 'Failed to deploy to Heroku', details: error.message });
  }
});

app.post('/delete-app', async (req, res) => {
  const { appName, githubUsername } = req.body;
  const botIndex = bots.findIndex(b => b.app_name === appName);
  if (botIndex === -1) return res.status(404).json({ error: 'Bot not found' });

  try {
    await deleteHerokuApp(bots[botIndex].heroku_app_name);
    bots.splice(botIndex, 1);
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

  const userList = Object.values(users).map(u => ({
   ...u,
    active_bots: bots.filter(b => b.github_username === u.github_username).length
  }));
  res.json({ users: userList });
});

app.post('/get-all-apps', async (req, res) => {
  if (req.body.password!== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ apps: bots });
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));