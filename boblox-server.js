// ============================================================================
// BOBLOX ACCOUNT SERVER (MVP)
// Accounts, server-side BobCoins, server-validated purchases and the website
// (download page + TEST payment page).
//
// Run:   npm install && npm start          (http://localhost:3000)
// Deploy: Render / Railway free tier works as-is (PORT env respected).
//
// IMPORTANT: the /buy page is a TEST payment that credits coins instantly.
// For real money you must integrate a payment provider (Stripe, YooKassa...)
// inside the "/api/devbuy" handler and keep everything else unchanged.
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'boblox-db.json');
const STARTING_BALANCE = 500;

// --- Item catalog: server is the source of truth for prices -----------------
const CATALOG = {
  body_red: 50, body_green: 50, body_purple: 80, body_black: 120,
  body_gold: 400, body_mint: 70,
  head_pink: 50, head_blue: 50, head_white: 80, head_green: 60, head_red: 90,
  acc_cap: 150, acc_antenna: 200, acc_crown: 500, acc_halo: 350, acc_horns: 350,
  emote_wave: 60, emote_dance: 100, emote_flex: 150,
};

const COIN_PACKS = { small: 500, medium: 1200, large: 3000 };

// --- Tiny JSON "database" ----------------------------------------------------
let db = { users: {} }; // users[name] = {passHash, salt, balance, items[], tokens[]}
try {
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (e) { console.error('DB load failed, starting fresh:', e.message); }

function saveDb() {
  fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), () => {});
}

function hash(password, salt) {
  return crypto.createHash('sha256').update(salt + '|' + password).digest('hex');
}

function userByToken(token) {
  if (!token) return null;
  for (const name of Object.keys(db.users)) {
    if (db.users[name].tokens && db.users[name].tokens.includes(token))
      return { name, user: db.users[name] };
  }
  return null;
}

function fail(res, error) { res.json({ ok: false, error }); }

// --- Auth ---------------------------------------------------------------------
app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (username.length < 3 || username.length > 16)
    return fail(res, 'Username must be 3-16 characters.');
  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return fail(res, 'Username: letters, digits and _ only.');
  if (password.length < 4)
    return fail(res, 'Password must be at least 4 characters.');
  if (db.users[username])
    return fail(res, 'This username is already taken.');

  const salt = crypto.randomBytes(8).toString('hex');
  db.users[username] = {
    salt,
    passHash: hash(password, salt),
    balance: STARTING_BALANCE,
    items: [],
    tokens: [],
  };
  issueToken(res, username);
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.users[username];
  if (!user || user.passHash !== hash(password, user.salt))
    return fail(res, 'Wrong username or password.');
  issueToken(res, username);
});

function issueToken(res, username) {
  const user = db.users[username];
  const token = crypto.randomBytes(24).toString('hex');
  user.tokens = (user.tokens || []).slice(-4); // keep a few active sessions
  user.tokens.push(token);
  saveDb();
  res.json({ ok: true, token, username, balance: user.balance });
}

// --- Balance / economy ----------------------------------------------------------
app.get('/api/balance', (req, res) => {
  const found = userByToken(req.query.token);
  if (!found) return fail(res, 'Session expired. Please sign in again.');
  res.json({ ok: true, balance: found.user.balance });
});

app.get('/api/inventory', (req, res) => {
  const found = userByToken(req.query.token);
  if (!found) return fail(res, 'Session expired. Please sign in again.');
  res.json({ ok: true, items: found.user.items || [] });
});

// Gameplay rewards. MVP NOTE: trusts the client; a real backend would verify
// game results server-side. Capped to limit abuse.
app.post('/api/grant', (req, res) => {
  const found = userByToken(req.body.token);
  if (!found) return fail(res, 'Session expired. Please sign in again.');
  const amount = Math.floor(Number(req.body.amount) || 0);
  if (amount <= 0 || amount > 500) return fail(res, 'Invalid reward amount.');
  found.user.balance += amount;
  saveDb();
  res.json({ ok: true, balance: found.user.balance });
});

app.post('/api/spend', (req, res) => {
  const found = userByToken(req.body.token);
  if (!found) return fail(res, 'Session expired. Please sign in again.');
  const amount = Math.floor(Number(req.body.amount) || 0);
  if (amount <= 0) return fail(res, 'Invalid amount.');
  if (found.user.balance < amount) return fail(res, 'Not enough BobCoins.');
  found.user.balance -= amount;
  saveDb();
  res.json({ ok: true, balance: found.user.balance });
});

app.post('/api/purchase', (req, res) => {
  const found = userByToken(req.body.token);
  if (!found) return fail(res, 'Session expired. Please sign in again.');

  const itemId = String(req.body.itemId || '');
  const price = CATALOG[itemId];
  if (price === undefined) return fail(res, 'Unknown item.');
  if ((found.user.items || []).includes(itemId)) return fail(res, 'You already own this item.');
  if (found.user.balance < price) return fail(res, 'Not enough BobCoins.');

  found.user.balance -= price;
  found.user.items.push(itemId);
  saveDb();
  res.json({ ok: true, balance: found.user.balance, items: found.user.items });
});

// --- Website: TEST payment page ----------------------------------------------------
app.get('/buy', (req, res) => {
  const token = String(req.query.token || '');
  const found = userByToken(token);
  const who = found ? `Signed in as <b>${found.name}</b> — balance ${found.user.balance} BC` :
    'Not signed in — open this page from the game (Buy BobCoins button).';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Buy BobCoins</title>
  <style>body{font-family:sans-serif;background:#EAF1F8;text-align:center;padding:40px}
  .card{background:#fff;max-width:480px;margin:0 auto;padding:24px;border-radius:14px;box-shadow:0 4px 14px rgba(0,0,0,.1)}
  button{background:#FFB545;border:0;padding:14px 22px;margin:8px;border-radius:10px;font-size:17px;cursor:pointer}
  .warn{color:#a55;font-size:14px;margin-top:16px}</style></head><body>
  <div class="card"><h1 style="color:#3F9FE5">BOBLOX — Buy BobCoins</h1><p>${who}</p>
  <button onclick="buy('small')">500 BC — $0.99</button><br>
  <button onclick="buy('medium')">1200 BC — $1.99</button><br>
  <button onclick="buy('large')">3000 BC — $3.99</button>
  <p id="status"></p>
  <p class="warn">TEST MODE: no real money is charged. Real payments require a
  payment provider integration. After buying, return to the game — the balance
  refreshes automatically.</p></div>
  <script>
  function buy(pack){
    fetch('/api/devbuy',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:'${token}',pack:pack})})
      .then(r=>r.json()).then(d=>{
        document.getElementById('status').textContent =
          d.ok ? 'Success! New balance: '+d.balance+' BC. Return to the game.' : (d.error||'Failed');
      });
  }
  </script></body></html>`);
});

// TEST payment endpoint. Replace the body of this handler with a real
// payment-provider checkout + webhook for production.
app.post('/api/devbuy', (req, res) => {
  const found = userByToken(req.body.token);
  if (!found) return fail(res, 'Sign in inside the game first.');
  const coins = COIN_PACKS[String(req.body.pack || '')];
  if (!coins) return fail(res, 'Unknown pack.');
  found.user.balance += coins;
  saveDb();
  console.log(`[buy] ${found.name} +${coins} BC (test purchase)`);
  res.json({ ok: true, balance: found.user.balance });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Boblox server running on http://localhost:${PORT}`));
