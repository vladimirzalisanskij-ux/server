// Boblox Platform Server
// Self-contained Node.js server for Roblox-like platform foundations:
// rooms, join codes, live player state, chat, published worlds.
//
// Run:
//   node boblox-platform-server.js
//
// Deploy on Render:
//   Build command: npm install
//   Start command: node boblox-platform-server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = path.join(__dirname, "boblox-platform-db.json");
const ROOM_TTL_MS = 1000 * 60 * 60 * 4;
const PLAYER_TTL_MS = 1000 * 20;
const MAX_CHAT = 40;

const rooms = new Map();
let db = loadDb();

// ============================================================================
// v0.3: promo codes, gems, admin roles, audit logs, anti-farm, chat safety
// ============================================================================

// Owner allowlist comes from the environment, NEVER from the client:
//   set BOBLOX_OWNER=yourname   (comma-separated list allowed)
const OWNER_ALLOWLIST = String(process.env.BOBLOX_OWNER || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const BLOCKED_WORDS = ["idiot", "stupid", "hate you", "kill yourself", "noob trash"];
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // sessions expire after 12h

// The OWNER account is seeded from a precomputed scrypt hash so it survives
// database resets (Render free tier wipes the disk on every deploy).
// The plaintext password is NOT in this file - only its hash.
const OWNER_SEED = {
  username: "owner",
  salt: "90973c51edf3f8baad071668366001698e8e93bf0d01e1fa",
  passwordHash: "s2$63ff4511a48eb12fc34dd65694a7f2acec862be54c7c83bafe949d79324bf69d",
};

function seedOwner() {
  if (!Object.prototype.hasOwnProperty.call(db.users, OWNER_SEED.username)) {
    db.users[OWNER_SEED.username] = {
      username: OWNER_SEED.username,
      salt: OWNER_SEED.salt,
      passwordHash: OWNER_SEED.passwordHash,
      token: token(),
      balance: 0,
      inventory: [],
      createdWorlds: [],
      createdAt: Date.now(),
    };
    ensureUserV03(db.users[OWNER_SEED.username]);
  }
  db.users[OWNER_SEED.username].adminRole = "owner";
}

function migrateV03() {
  db.promoCodes = db.promoCodes || {};
  db.auditLogs = db.auditLogs || [];
  db.purchaseLogs = db.purchaseLogs || [];
  db.reports = db.reports || [];
  db.ratings = db.ratings || {};
  seedOwner();

  // Seed the two launch codes once (server is the only source of truth).
  if (!db.promoCodes["v0idadph0rn$"]) {
    db.promoCodes["v0idadph0rn$"] = {
      reward: { type: "item", itemId: "acc_void_horns", label: "Void Horns accessory" },
      enabled: true, expiresAt: 0, redeemedBy: [],
    };
  }
  if (!db.promoCodes["$nwi001bobl0x"]) {
    db.promoCodes["$nwi001bobl0x"] = {
      reward: { type: "coins", amount: 50, label: "50 BobCoins" },
      enabled: true, expiresAt: 0, redeemedBy: [],
    };
  }
  for (const user of Object.values(db.users)) ensureUserV03(user);
  saveDb();
}

function ensureUserV03(user) {
  if (user.gems === undefined) user.gems = 0;
  user.redeemedCodes = user.redeemedCodes || [];
  user.adminRole = user.adminRole || "";       // "", moderator, admin, owner
  user.bannedUntil = user.bannedUntil || 0;    // 0 = not banned, -1 = permanent
  user.banReason = user.banReason || "";
  user.mutedUntil = user.mutedUntil || 0;
  user.lastDailyClaim = user.lastDailyClaim || 0;
  user.rewardHistory = user.rewardHistory || {}; // reason -> last grant timestamp
  if (user.tokenIssuedAt === undefined) user.tokenIssuedAt = Date.now();
}

function isBanned(user) {
  return user.bannedUntil === -1 || user.bannedUntil > Date.now();
}

function isMuted(user) {
  return user && user.mutedUntil > Date.now();
}

function applyOwnerAllowlist(user) {
  if (OWNER_ALLOWLIST.includes(user.username.toLowerCase()))
    user.adminRole = "owner";
}

const ROLE_LEVEL = { "": 0, moderator: 1, admin: 2, owner: 3 };
function roleAtLeast(user, role) {
  return (ROLE_LEVEL[user.adminRole] || 0) >= (ROLE_LEVEL[role] || 99);
}

function audit(actor, action, target, details) {
  db.auditLogs.push({ time: Date.now(), actor, action, target: target || "", details: details || "" });
  db.auditLogs = db.auditLogs.slice(-500);
  saveDb();
}

// Simple in-memory rate limiter: key -> next allowed timestamp.
const rateMap = new Map();
function rateLimited(key, ms) {
  const now = Date.now();
  const next = rateMap.get(key) || 0;
  if (now < next) return true;
  rateMap.set(key, now + ms);
  if (rateMap.size > 5000) rateMap.clear(); // crude memory cap
  return false;
}

function filterChat(raw) {
  let text = String(raw || "").slice(0, 120).replace(/[\r\n]/g, " ").trim();
  if (!text) return "";
  for (const word of BLOCKED_WORDS) {
    const pattern = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    text = text.replace(pattern, "***");
  }
  return text;
}

// Active matches (in-memory): matchId -> {user, gameId, startedAt, finished}.
// Reward amounts and minimum plausible durations live ONLY here.
const matches = new Map();
const matchRewardStamps = new Map(); // "user|game" -> [timestamps of rewarded finishes]

const MATCH_REWARDS = {
  obby:        { win: 10, lose: 1, minWinSeconds: 20, minLoseSeconds: 5 },
  hideandseek: { win: 8,  lose: 1, minWinSeconds: 50, minLoseSeconds: 5 },
  pvp:         { win: 6,  lose: 1, minWinSeconds: 10, minLoseSeconds: 5 },
  generic:     { win: 5,  lose: 1, minWinSeconds: 15, minLoseSeconds: 5 },
};

function cleanupMatches() {
  const TTL = 2 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [id, match] of matches) {
    if (now - match.startedAt > TTL) matches.delete(id);
  }
}

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    }
  } catch (err) {
    console.warn("[Boblox] Failed to load db:", err.message);
  }

  return {
    users: {},
    worlds: {},
    worldOrder: [],
    nextWorldId: 1,
  };
}

function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  backupDb();
  scheduleGistSave();
}

// --- Persistent storage in a secret GitHub Gist ------------------------------
// Render's free tier wipes the local disk on every deploy/restart, so the DB
// is mirrored to a secret gist: loaded at startup, saved (debounced) on change.
// Configure on Render: BOBLOX_GIST_ID + BOBLOX_GIST_TOKEN (gist-scope token).
const GIST_ID = String(process.env.BOBLOX_GIST_ID || "");
const GIST_TOKEN = String(process.env.BOBLOX_GIST_TOKEN || "");
const GIST_ENABLED = !!(GIST_ID && GIST_TOKEN);
const GIST_FILE = "boblox-db.json";
let gistSaveTimer = null;
let gistSaving = false;

function githubRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = require("https").request({
      hostname: "api.github.com",
      path: apiPath,
      method,
      headers: Object.assign({
        Authorization: "token " + GIST_TOKEN,
        "User-Agent": "boblox-server",
        Accept: "application/vnd.github+json",
      }, payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error("GitHub " + res.statusCode));
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function fetchRaw(rawUrl) {
  return new Promise((resolve, reject) => {
    require("https").get(rawUrl, { headers: { "User-Agent": "boblox-server" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

async function loadDbFromGist() {
  if (!GIST_ENABLED) return false;
  try {
    const gist = await githubRequest("GET", "/gists/" + GIST_ID);
    const file = gist && gist.files && gist.files[GIST_FILE];
    if (!file) return false;
    const content = file.truncated ? await fetchRaw(file.raw_url) : file.content;
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || !parsed.users) {
      console.log("[Boblox] Gist DB is empty - starting fresh and seeding it.");
      return false;
    }
    db = parsed;
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    console.log(`[Boblox] Database restored from gist (${Object.keys(db.users).length} users).`);
    return true;
  } catch (err) {
    console.warn("[Boblox] Could not load DB from gist:", err.message);
    return false; // fall back to the local file - never crash the server
  }
}

function scheduleGistSave() {
  if (!GIST_ENABLED || gistSaveTimer) return;
  gistSaveTimer = setTimeout(pushDbToGist, 20 * 1000); // batch rapid changes
}

async function pushDbToGist() {
  gistSaveTimer = null;
  if (!GIST_ENABLED || gistSaving) return;
  gistSaving = true;
  try {
    await githubRequest("PATCH", "/gists/" + GIST_ID, {
      files: { [GIST_FILE]: { content: JSON.stringify(db) } },
    });
  } catch (err) {
    console.warn("[Boblox] Gist save failed (will retry on next change):", err.message);
  }
  gistSaving = false;
}

// Automatic DB backups: at most every 6 hours, keep the last 10 files.
// (Timestamp lives on the function itself: saveDb runs during startup
// migration, before top-level lets would be initialized.)
function backupDb() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (Date.now() - (backupDb._last || 0) < SIX_HOURS) return;
  backupDb._last = Date.now();

  try {
    const dir = path.join(__dirname, "backups");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);

    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    fs.copyFileSync(DB_PATH, path.join(dir, `boblox-db-${stamp}.json`));

    const files = fs.readdirSync(dir).filter((f) => f.startsWith("boblox-db-")).sort();
    while (files.length > 10) fs.unlinkSync(path.join(dir, files.shift()));
  } catch (err) {
    console.warn("[Boblox] Backup failed:", err.message);
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024 * 5) req.destroy();
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

// All client-supplied numbers go through this: NaN/Infinity become 0 instead
// of corrupting balances ("amount": "abc" used to set balance to NaN).
function safeInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function cleanName(raw, fallback) {
  const name = String(raw || "").replace(/[\r\n\t]/g, " ").trim().slice(0, 20);
  return name || fallback;
}

function makeCode(length = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function token() {
  return crypto.randomBytes(24).toString("hex");
}

// Legacy hash (pbkdf2) - kept only to verify old accounts during migration.
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 32, "sha256").toString("hex");
}

// v0.3 release hardening: scrypt (memory-hard, much harder to brute-force).
// Hashes are versioned with the "s2$" prefix; old accounts are silently
// re-hashed to scrypt on their next successful login.
function hashPasswordScrypt(password, salt) {
  return "s2$" + crypto.scryptSync(password, salt, 32).toString("hex");
}

function verifyPassword(user, password) {
  if (!user || !user.passwordHash) return false;
  if (user.passwordHash.startsWith("s2$")) {
    const expected = Buffer.from(user.passwordHash);
    const actual = Buffer.from(hashPasswordScrypt(password, user.salt));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  // Legacy pbkdf2 account: verify, then upgrade the stored hash.
  if (user.passwordHash === hashPassword(password, user.salt)) {
    user.passwordHash = hashPasswordScrypt(password, user.salt);
    return true;
  }
  return false;
}

function publicUser(user) {
  return {
    username: user.username,
    balance: user.balance,
    gems: user.gems || 0,
    role: user.adminRole || "",
    inventory: user.inventory || [],
    createdWorlds: user.createdWorlds || [],
  };
}

function userByToken(sessionToken) {
  if (!sessionToken) return null;
  const user = Object.values(db.users).find((u) => u.token === sessionToken) || null;
  if (!user) return null;
  ensureUserV03(user);
  // Session expiration: old tokens are rejected, the game asks to sign in again.
  if (Date.now() - user.tokenIssuedAt > TOKEN_TTL_MS) return null;
  if (isBanned(user)) return null;
  return user;
}

function cleanupRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const [playerId, player] of room.players) {
      if (now - player.lastSeen > PLAYER_TTL_MS) {
        room.players.delete(playerId);
        room.chat.push({
          id: token(),
          time: now,
          sender: "System",
          message: `${player.name} left.`,
        });
      }
    }

    if (now - room.createdAt > ROOM_TTL_MS || room.players.size === 0) {
      rooms.delete(code);
    }
  }
}

function roomSnapshot(room) {
  return {
    ok: true,
    code: room.code,
    gameId: room.gameId,
    worldId: room.worldId || "",
    createdAt: room.createdAt,
    online: room.players.size,
    players: Array.from(room.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      z: p.z,
      rx: p.rx,
      ry: p.ry,
      rz: p.rz,
      rw: p.rw,
      lastSeen: p.lastSeen,
    })),
    chat: room.chat.slice(-MAX_CHAT),
  };
}

// --- Website: BobGems packages + payments ------------------------------------
// Payment modes (in priority order):
//   1. STRIPE  - real money. Set on Render: STRIPE_SECRET_KEY=sk_live_...
//      and STRIPE_WEBHOOK_SECRET=whsec_... The buy page redirects to Stripe
//      Checkout; the webhook below credits the gems after payment.
//   2. TEST    - local/developer mode only. Enable explicitly with
//      BOBLOX_TEST_PAYMENTS=1. Gems are granted for free, no real money.
const https = require("https");
const STRIPE_KEY = String(process.env.STRIPE_SECRET_KEY || "");
const STRIPE_WEBHOOK_SECRET = String(process.env.STRIPE_WEBHOOK_SECRET || "");
const ALLOW_STRIPE_TEST_KEY = String(process.env.BOBLOX_ALLOW_STRIPE_TEST || "0") === "1";
const STRIPE_CONFIGURED = STRIPE_KEY.startsWith("sk_live_") ||
  (ALLOW_STRIPE_TEST_KEY && STRIPE_KEY.startsWith("sk_test_"));
const TEST_PAYMENTS = String(process.env.BOBLOX_TEST_PAYMENTS || "0") === "1";
const SITE_URL = String(process.env.BOBLOX_SITE_URL || "https://boblox-server.onrender.com").replace(/\/$/, "");

const GEM_PACKAGES = {
  starter: { gems: 100, cents: 199, price: "$1.99", label: "Starter Pack" },
  popular: { gems: 550, cents: 499, price: "$4.99", label: "Popular Pack (+10% bonus)" },
  mega: { gems: 1200, cents: 899, price: "$8.99", label: "Mega Pack (+20% bonus)" },
};

function paymentsMode() {
  if (STRIPE_CONFIGURED) return "stripe";
  return TEST_PAYMENTS ? "test" : "off";
}

function stripeRequest(apiPath, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      hostname: "api.stripe.com",
      path: apiPath,
      method: "POST",
      headers: {
        Authorization: "Bearer " + STRIPE_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error("Bad Stripe response")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => { chunks.push(c); if (chunks.length > 2048) req.destroy(); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// Stripe signs webhooks: Stripe-Signature: t=<unix>,v1=<hmac>. We recompute the
// HMAC over "<t>.<raw body>" and compare - a forged request cannot grant gems.
function verifyStripeSignature(rawBody, header) {
  if (!header || !STRIPE_WEBHOOK_SECRET) return false;
  let t = "";
  const v1s = [];
  for (const part of String(header).split(",")) {
    const [key, value] = part.split("=");
    if (key === "t") t = value;
    if (key === "v1") v1s.push(value);
  }
  if (!t || v1s.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5 min tolerance

  const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(`${t}.${rawBody}`).digest("hex");
  return v1s.some((v1) => {
    try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)); }
    catch { return false; }
  });
}

function grantGems(user, pack, mode, paymentId) {
  user.gems += pack.gems;
  db.purchaseLogs.push({
    time: Date.now(),
    user: user.username,
    item: "bobgems_" + pack.gems,
    gems: pack.gems,
    price: pack.price,
    mode,
    paymentId: paymentId || "",
  });
  db.purchaseLogs = db.purchaseLogs.slice(-500);
  audit(user.username, "buy_gems_" + mode, "", `${pack.gems} gems (${pack.price})`);
  saveDb();
}

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".zip": "application/zip",
  ".apk": "application/vnd.android.package-archive",
};

function tryServeStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (rel === "/") rel = "/index.html";
  if (rel === "/buy") rel = "/buy.html";
  if (rel === "/top" || rel === "/leaderboard") rel = "/leaderboard.html";
  if (rel === "/owner" || rel === "/admin") rel = "/owner.html";
  if (rel === "/report") rel = "/report.html";
  if (rel.startsWith("/api/")) return false;

  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false; // no path traversal
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Content-Length": fs.statSync(file).size,
  });
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    return send(res, 200, { ok: true });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  cleanupRooms();

  // The official website (served from /public): downloads + BobGems store.
  // There is intentionally NO playable version on the site - the game is
  // download-only; the browser only downloads builds and buys gems.
  if (tryServeStatic(req, res, url)) return;

  if (url.pathname === "/api/health" && req.method === "GET") {
    return send(res, 200, {
      ok: true,
      server: "Boblox Platform Server",
      rooms: rooms.size,
      worlds: db.worldOrder.length,
      time: Date.now(),
    });
  }

  if (url.pathname === "/api/register" && req.method === "POST") {
    const body = await parseBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");

    if (rateLimited("register:" + req.socket.remoteAddress, 3000)) {
      return send(res, 429, { ok: false, error: "Too many attempts. Wait a moment." });
    }
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      return send(res, 400, { ok: false, error: "Username: 3-16 letters, digits or _." });
    }
    if (password.length < 4 || password.length > 72) {
      return send(res, 400, { ok: false, error: "Password must be 4-72 characters." });
    }
    if (Object.prototype.hasOwnProperty.call(db.users, username.toLowerCase())) {
      return send(res, 409, { ok: false, error: "Username already exists." });
    }

    const salt = token();
    const user = {
      username,
      salt,
      passwordHash: hashPasswordScrypt(password, salt),
      token: token(),
      balance: 100,
      inventory: [],
      createdWorlds: [],
      createdAt: Date.now(),
    };
    ensureUserV03(user);
    applyOwnerAllowlist(user);
    db.users[username.toLowerCase()] = user;
    saveDb();
    return send(res, 200, { ok: true, token: user.token, ...publicUser(user) });
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await parseBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "").slice(0, 72);
    if (rateLimited("login:" + req.socket.remoteAddress, 1000)) {
      return send(res, 429, { ok: false, error: "Too many attempts. Wait a second." });
    }
    const user = Object.prototype.hasOwnProperty.call(db.users, username) ? db.users[username] : null;

    if (!user || !verifyPassword(user, password)) {
      return send(res, 401, { ok: false, error: "Invalid username or password." });
    }

    ensureUserV03(user);
    if (isBanned(user)) {
      const until = user.bannedUntil === -1 ? "permanently" : "until " + new Date(user.bannedUntil).toLocaleString();
      return send(res, 403, { ok: false, error: `You are banned ${until}. Reason: ${user.banReason || "rule violation"}` });
    }

    applyOwnerAllowlist(user);
    user.token = token();
    user.tokenIssuedAt = Date.now();
    saveDb();
    return send(res, 200, { ok: true, token: user.token, ...publicUser(user) });
  }

  if (url.pathname === "/api/balance" && req.method === "GET") {
    const user = userByToken(url.searchParams.get("token"));
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });
    return send(res, 200, { ok: true, balance: user.balance });
  }

  if (url.pathname === "/api/grant" && req.method === "POST") {
    const body = await parseBody(req);
    const user = userByToken(body.token);
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });

    // v0.3.1: match rewards now go through /api/match/finish (validated).
    // This endpoint remains only for tiny pickups (coins on the map), so the
    // cap is very low: a hacked client can milk at most a few coins a minute.
    const amount = safeInt(body.amount, 0, 5);
    const reason = String(body.reason || "generic").slice(0, 40);
    const lastGrant = user.rewardHistory[reason] || 0;
    if (Date.now() - lastGrant < 45 * 1000) {
      return send(res, 200, { ok: true, balance: user.balance, throttled: true });
    }

    user.rewardHistory[reason] = Date.now();
    user.balance += amount;
    saveDb();
    return send(res, 200, { ok: true, balance: user.balance });
  }

  if (url.pathname === "/api/spend" && req.method === "POST") {
    const body = await parseBody(req);
    const user = userByToken(body.token);
    const amount = safeInt(body.amount, 0, 1000000);
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });
    if (user.balance < amount) return send(res, 400, { ok: false, error: "Not enough BobCoins." });
    user.balance -= amount;
    saveDb();
    return send(res, 200, { ok: true, balance: user.balance });
  }

  if (url.pathname === "/api/inventory" && req.method === "GET") {
    const user = userByToken(url.searchParams.get("token"));
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });
    return send(res, 200, { ok: true, items: user.inventory || [] });
  }

  if (url.pathname === "/api/purchase" && req.method === "POST") {
    const body = await parseBody(req);
    const user = userByToken(body.token);
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });

    const itemId = String(body.itemId || "");
    if (!itemId) return send(res, 400, { ok: false, error: "Missing item id." });
    if ((user.inventory || []).includes(itemId)) {
      return send(res, 400, { ok: false, error: "Already owned." });
    }
    if (PROMO_ONLY_ITEMS.includes(itemId)) {
      return send(res, 403, { ok: false, error: "This item is promo-only. Redeem a code to get it." });
    }

    // Currency is decided by the SERVER catalog, never by the client.
    const coinPrice = catalogPrice(itemId);
    const gemsPrice = gemPrice(itemId);
    if (coinPrice < 0 && gemsPrice < 0) {
      return send(res, 404, { ok: false, error: "Unknown item." });
    }

    if (gemsPrice >= 0) {
      if ((user.gems || 0) < gemsPrice) return send(res, 400, { ok: false, error: "Not enough BobGems." });
      user.gems -= gemsPrice;
    } else {
      if (user.balance < coinPrice) return send(res, 400, { ok: false, error: "Not enough BobCoins." });
      user.balance -= coinPrice;
    }

    user.inventory = user.inventory || [];
    user.inventory.push(itemId);
    db.purchaseLogs.push({
      time: Date.now(), user: user.username, itemId,
      price: gemsPrice >= 0 ? gemsPrice : coinPrice,
      currency: gemsPrice >= 0 ? "gems" : "coins",
    });
    db.purchaseLogs = db.purchaseLogs.slice(-500);
    saveDb();
    return send(res, 200, { ok: true, balance: user.balance, gems: user.gems, items: user.inventory });
  }

  // --- v0.3.1: SERVER-VALIDATED MATCH REWARDS ---------------------------------
  // The client NEVER sends a coin amount. It opens a match, plays, and reports
  // win/lose. The server checks: the match exists and belongs to the player,
  // wasn't finished twice, lasted a humanly-possible time, and the hourly
  // reward cap isn't exceeded. Then the SERVER picks the reward from its table.
  if (url.pathname === "/api/match/start" && req.method === "POST") {
    const body = await parseBody(req);
    const user = userByToken(body.token);
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });
    if (rateLimited("matchstart:" + user.username, 5000)) {
      return send(res, 429, { ok: false, error: "Starting matches too fast." });
    }

    const gameId = MATCH_REWARDS[String(body.gameId || "")] ? String(body.gameId) : "generic";
    const matchId = token();
    matches.set(matchId, {
      user: user.username.toLowerCase(),
      gameId,
      startedAt: Date.now(),
      finished: false,
    });
    cleanupMatches();
    return send(res, 200, { ok: true, matchId });
  }

  if (url.pathname === "/api/match/finish" && req.method === "POST") {
    const body = await parseBody(req);
    const user = userByToken(body.token);
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });

    const match = matches.get(String(body.matchId || ""));
    if (!match || match.user !== user.username.toLowerCase()) {
      return send(res, 404, { ok: false, error: "Match not found. Rewards need a started match." });
    }
    if (match.finished) {
      return send(res, 409, { ok: false, error: "Match already finished." });
    }

    const won = String(body.result || "") === "win";
    const rules = MATCH_REWARDS[match.gameId] || MATCH_REWARDS.generic;
    const seconds = (Date.now() - match.startedAt) / 1000;
    const minSeconds = won ? rules.minWinSeconds : rules.minLoseSeconds;

    match.finished = true; // single-use even when rejected below

    if (seconds < minSeconds) {
      audit(user.username, "reward_rejected", match.gameId,
        `too fast: ${seconds.toFixed(1)}s < ${minSeconds}s`);
      return send(res, 400, { ok: false, error: "Match too short - no reward." });
    }

    // Hourly anti-farm cap per game.
    const capKey = user.username.toLowerCase() + "|" + match.gameId;
    const now = Date.now();
    const stamps = (matchRewardStamps.get(capKey) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (stamps.length >= 6) {
      matchRewardStamps.set(capKey, stamps);
      return send(res, 200, { ok: true, reward: 0, balance: user.balance,
        message: "Hourly reward limit reached - play another game!" });
    }
    stamps.push(now);
    matchRewardStamps.set(capKey, stamps);

    const reward = won ? rules.win : rules.lose;
    user.balance += reward;
    saveDb();
    return send(res, 200, {
      ok: true, reward, balance: user.balance,
      message: `+${reward} BobCoins (server verified)`,
    });
  }

  // --- v0.3: PROMO CODES (server is the only source of truth) ---------------
  if (url.pathname === "/api/promo/redeem" && req.method === "POST") {
    const body = await parseBody(req);
    const user = userByToken(body.token);
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });

    // Anti-spam: 3 second cooldown per account + per IP.
    if (rateLimited("promo:" + user.username, 3000) ||
        rateLimited("promoip:" + req.socket.remoteAddress, 1500)) {
      return send(res, 429, { ok: false, error: "Too fast. Wait a moment." });
    }

    const code = String(body.code || "").trim().toLowerCase();
    if (!code) return send(res, 400, { ok: false, error: "Invalid code" });

    const promo = db.promoCodes[code];
    if (!promo) return send(res, 404, { ok: false, error: "Invalid code" });
    if (!promo.enabled) return send(res, 403, { ok: false, error: "Code disabled" });
    if (promo.expiresAt > 0 && Date.now() > promo.expiresAt) {
      return send(res, 403, { ok: false, error: "Code expired" });
    }
    if (promo.redeemedBy.includes(user.username.toLowerCase())) {
      return send(res, 409, { ok: false, error: "Code already redeemed" });
    }

    // Apply the reward server-side.
    const reward = promo.reward || {};
    if (reward.type === "coins") {
      user.balance += Math.max(0, Math.floor(Number(reward.amount || 0)));
    } else if (reward.type === "gems") {
      user.gems += Math.max(0, Math.floor(Number(reward.amount || 0)));
    } else if (reward.type === "item") {
      user.inventory = user.inventory || [];
      if (!user.inventory.includes(reward.itemId)) user.inventory.push(reward.itemId);
    } else {
      return send(res, 500, { ok: false, error: "Broken reward config." });
    }

    promo.redeemedBy.push(user.username.toLowerCase());
    audit(user.username, "promo_redeem", code, reward.label || "");
    saveDb();
    return send(res, 200, {
      ok: true,
      message: `Reward claimed: ${reward.label || "reward"}!`,
      balance: user.balance, gems: user.gems, items: user.inventory || [],
    });
  }

  // --- v0.3: DAILY REWARD with a real 24h server cooldown --------------------
  if (url.pathname === "/api/economy/daily" && req.method === "POST") {
    const body = await parseBody(req);
    const user = userByToken(body.token);
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });

    const DAY = 24 * 60 * 60 * 1000;
    const since = Date.now() - user.lastDailyClaim;
    if (since < DAY) {
      const hoursLeft = Math.ceil((DAY - since) / (60 * 60 * 1000));
      return send(res, 429, { ok: false, error: `Daily reward in ${hoursLeft}h.` });
    }

    user.lastDailyClaim = Date.now();
    user.balance += 10;
    saveDb();
    return send(res, 200, { ok: true, message: "Daily reward: +10 BobCoins!", balance: user.balance });
  }

  // --- REPORTS on anything: a player, a world, the game itself, chat... ------
  // Works with a session token (from the game) OR username+password (from the
  // website). Reports land in db.reports and the owner panel reviews them.
  if (url.pathname === "/api/report" && req.method === "POST") {
    const body = await parseBody(req);
    let user = userByToken(body.token);
    if (!user && body.username) {
      const name = String(body.username || "").trim().toLowerCase();
      const candidate = Object.prototype.hasOwnProperty.call(db.users, name) ? db.users[name] : null;
      if (candidate && verifyPassword(candidate, String(body.password || "").slice(0, 72)) && !isBanned(candidate))
        user = candidate;
    }
    if (!user) return send(res, 401, { ok: false, error: "Sign in to send a report." });
    if (rateLimited("report:" + user.username, 10000)) {
      return send(res, 429, { ok: false, error: "Please wait before reporting again." });
    }

    const TYPES = ["player", "world", "game", "chat", "bug", "other"];
    const type = TYPES.includes(String(body.type || "")) ? String(body.type) : "other";
    const report = {
      id: token().slice(0, 12),
      time: Date.now(),
      reporter: user.username,
      type,
      target: String(body.target || "").slice(0, 48),
      reason: String(body.reason || "").slice(0, 300),
      resolved: false,
    };
    if (!report.reason) return send(res, 400, { ok: false, error: "Describe the problem." });
    db.reports.push(report);
    db.reports = db.reports.slice(-1000);
    audit(user.username, "report_" + type, report.target, report.reason.slice(0, 120));
    return send(res, 200, { ok: true, message: "Report sent. Thank you!" });
  }

  // --- GAME RATINGS (1-5 stars, one per account, changeable) -----------------
  if (url.pathname === "/api/rate" && req.method === "POST") {
    const body = await parseBody(req);
    if (rateLimited("rate:" + req.socket.remoteAddress, 2000))
      return send(res, 429, { ok: false, error: "Too fast." });
    const name = String(body.username || "").trim().toLowerCase();
    const user = Object.prototype.hasOwnProperty.call(db.users, name) ? db.users[name] : null;
    if (!user || !verifyPassword(user, String(body.password || "").slice(0, 72)))
      return send(res, 401, { ok: false, error: "Wrong username or password." });
    if (isBanned(user)) return send(res, 403, { ok: false, error: "Account is banned." });

    const stars = safeInt(body.stars, 1, 5);
    db.ratings[name] = { stars, time: Date.now() };
    saveDb();
    const all = Object.values(db.ratings).map((r) => r.stars);
    const average = all.reduce((a, b) => a + b, 0) / all.length;
    return send(res, 200, { ok: true, average: Math.round(average * 10) / 10, count: all.length, yours: stars });
  }

  if (url.pathname === "/api/rating" && req.method === "GET") {
    const all = Object.values(db.ratings || {}).map((r) => r.stars);
    const average = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
    return send(res, 200, { ok: true, average: Math.round(average * 10) / 10, count: all.length });
  }

  // --- v0.3: ADMIN PANEL (server-side role checks, full audit) ----------------
  if (url.pathname === "/api/admin/action" && req.method === "POST") {
    const body = await parseBody(req);
    const actor = userByToken(body.token);
    if (!actor) return send(res, 401, { ok: false, error: "Invalid session." });
    if (!roleAtLeast(actor, "moderator")) {
      audit(actor.username, "admin_denied", String(body.action || ""), "no role");
      return send(res, 403, { ok: false, error: "You are not an administrator." });
    }
    if (rateLimited("admin:" + actor.username, 700)) {
      return send(res, 429, { ok: false, error: "Slow down." });
    }

    const action = String(body.action || "");
    const targetName = String(body.target || "").trim().toLowerCase();
    const target = targetName ? db.users[targetName] : null;
    if (target) ensureUserV03(target);
    const amount = safeInt(body.amount, 0, 1000000);
    const needTarget = () => !target ? send(res, 404, { ok: false, error: "Player not found." }) : null;

    // Role requirements per action (server-side RBAC).
    const required = {
      listPlayers: "moderator", findPlayer: "moderator",
      mute: "moderator", unmute: "moderator", tempban: "moderator",
      listBanned: "moderator", listMuted: "moderator",
      listReports: "moderator", resolveReport: "moderator",
      listWorlds: "moderator", worldInfo: "moderator",
      listRooms: "moderator", clearRoomChat: "moderator",
      serverStats: "moderator", ratingsList: "moderator",
      giveCoins: "admin", takeCoins: "admin",
      giveItem: "admin", removeItem: "admin", clearInventory: "admin",
      ban: "admin", unban: "admin",
      logs: "admin", purchases: "admin",
      deleteWorld: "admin", renameWorld: "admin", resetWorldStats: "admin",
      closeRoom: "admin", deleteRating: "admin",
      giveGems: "owner", takeGems: "owner", setBalance: "owner", setGems: "owner",
      promoCreate: "owner", promoDisable: "owner", promoEnable: "owner",
      promoRedeemers: "owner", listPromos: "owner",
      setRole: "owner", resetPassword: "owner", deleteUser: "owner",
      announce: "owner", featureWorld: "owner",
    };
    if (!required[action]) return send(res, 400, { ok: false, error: "Unknown action." });
    if (!roleAtLeast(actor, required[action])) {
      audit(actor.username, "admin_denied", action, "insufficient role");
      return send(res, 403, { ok: false, error: `Requires ${required[action]} role.` });
    }

    let result = { ok: true };
    switch (action) {
      case "listPlayers":
        result.players = Object.values(db.users).slice(0, 100).map((u) => ({
          username: u.username, balance: u.balance, gems: u.gems || 0,
          role: u.adminRole || "", banned: isBanned(u), muted: isMuted(u),
        }));
        break;
      case "findPlayer": {
        if (needTarget()) return;
        result.player = {
          username: target.username, balance: target.balance, gems: target.gems || 0,
          role: target.adminRole || "", banned: isBanned(target), muted: isMuted(target),
          inventory: target.inventory || [], redeemedCodes: target.redeemedCodes || [],
        };
        break;
      }
      case "giveCoins": if (needTarget()) return; target.balance += amount; result.balance = target.balance; break;
      case "takeCoins": if (needTarget()) return; target.balance = Math.max(0, target.balance - amount); result.balance = target.balance; break;
      case "giveGems": if (needTarget()) return; target.gems += amount; result.gems = target.gems; break;
      case "takeGems": if (needTarget()) return; target.gems = Math.max(0, target.gems - amount); result.gems = target.gems; break;
      case "giveItem": {
        if (needTarget()) return;
        const itemId = String(body.itemId || "").slice(0, 40);
        target.inventory = target.inventory || [];
        if (itemId && !target.inventory.includes(itemId)) target.inventory.push(itemId);
        result.items = target.inventory;
        break;
      }
      case "removeItem": {
        if (needTarget()) return;
        const itemId = String(body.itemId || "");
        target.inventory = (target.inventory || []).filter((i) => i !== itemId);
        result.items = target.inventory;
        break;
      }
      case "ban":
        if (needTarget()) return;
        if (roleAtLeast(target, actor.adminRole)) return send(res, 403, { ok: false, error: "Cannot ban same/higher role." });
        target.bannedUntil = -1; target.banReason = String(body.reason || "rule violation").slice(0, 120);
        target.token = ""; // kick the session
        break;
      case "tempban": {
        if (needTarget()) return;
        if (roleAtLeast(target, actor.adminRole)) return send(res, 403, { ok: false, error: "Cannot ban same/higher role." });
        const hours = Math.min(roleAtLeast(actor, "admin") ? 720 : 24, Math.max(1, amount || 1));
        target.bannedUntil = Date.now() + hours * 60 * 60 * 1000;
        target.banReason = String(body.reason || "rule violation").slice(0, 120);
        target.token = "";
        result.until = target.bannedUntil;
        break;
      }
      case "unban": if (needTarget()) return; target.bannedUntil = 0; target.banReason = ""; break;
      case "mute": {
        if (needTarget()) return;
        const hours = Math.max(1, amount || 1);
        target.mutedUntil = Date.now() + hours * 60 * 60 * 1000;
        break;
      }
      case "unmute": if (needTarget()) return; target.mutedUntil = 0; break;
      case "promoCreate": {
        const code = String(body.code || "").trim().toLowerCase().slice(0, 32);
        if (!code || db.promoCodes[code]) return send(res, 400, { ok: false, error: "Code is empty or exists." });
        const kind = String(body.rewardType || "coins");
        db.promoCodes[code] = {
          reward: kind === "item"
            ? { type: "item", itemId: String(body.itemId || ""), label: String(body.label || body.itemId || "item") }
            : { type: kind === "gems" ? "gems" : "coins", amount, label: `${amount} ${kind === "gems" ? "BobGems" : "BobCoins"}` },
          enabled: true, expiresAt: 0, redeemedBy: [],
        };
        result.code = code;
        break;
      }
      case "promoDisable": {
        const code = String(body.code || "").trim().toLowerCase();
        if (!db.promoCodes[code]) return send(res, 404, { ok: false, error: "Code not found." });
        db.promoCodes[code].enabled = false;
        break;
      }
      case "promoRedeemers": {
        const code = String(body.code || "").trim().toLowerCase();
        if (!db.promoCodes[code]) return send(res, 404, { ok: false, error: "Code not found." });
        result.redeemers = db.promoCodes[code].redeemedBy;
        break;
      }
      case "setRole": {
        if (needTarget()) return;
        const role = String(body.role || "").toLowerCase();
        if (!["", "moderator", "admin"].includes(role)) {
          return send(res, 400, { ok: false, error: "Role must be moderator, admin or empty. Owner only via server env." });
        }
        target.adminRole = role;
        result.role = role;
        break;
      }
      case "logs": result.logs = db.auditLogs.slice(-60); break;
      case "purchases": result.logs = db.purchaseLogs.slice(-60); break;

      // --- moderation lists ---
      case "listBanned":
        result.players = Object.values(db.users).filter(isBanned).map((u) => ({
          username: u.username, until: u.bannedUntil, reason: u.banReason || "",
        }));
        break;
      case "listMuted":
        result.players = Object.values(db.users).filter(isMuted).map((u) => ({
          username: u.username, until: u.mutedUntil,
        }));
        break;

      // --- reports ---
      case "listReports":
        result.reports = db.reports.filter((r) => !r.resolved).slice(-100).reverse();
        break;
      case "resolveReport": {
        const report = db.reports.find((r) => r.id === String(body.reportId || ""));
        if (!report) return send(res, 404, { ok: false, error: "Report not found." });
        report.resolved = true;
        report.resolvedBy = actor.username;
        break;
      }

      // --- worlds ---
      case "listWorlds":
        result.worlds = db.worldOrder.map((id) => db.worlds[id]).filter(Boolean).map((w) => ({
          id: w.id, name: w.name, creator: w.creator, visits: w.visits || 0,
          likes: w.likes || 0, featured: !!w.featured,
        }));
        break;
      case "worldInfo": {
        const world = db.worlds[String(body.worldId || "")];
        if (!world) return send(res, 404, { ok: false, error: "World not found." });
        result.world = { id: world.id, name: world.name, creator: world.creator,
          description: world.description, visits: world.visits, likes: world.likes,
          featured: !!world.featured, createdAt: world.createdAt,
          sizeKb: Math.round(JSON.stringify(world.data || {}).length / 1024) };
        break;
      }
      case "deleteWorld": {
        const worldId = String(body.worldId || "");
        const world = db.worlds[worldId];
        if (!world) return send(res, 404, { ok: false, error: "World not found." });
        delete db.worlds[worldId];
        db.worldOrder = db.worldOrder.filter((id) => id !== worldId);
        const creator = db.users[String(world.creator || "").toLowerCase()];
        if (creator) creator.createdWorlds = (creator.createdWorlds || []).filter((id) => id !== worldId);
        break;
      }
      case "renameWorld": {
        const world = db.worlds[String(body.worldId || "")];
        if (!world) return send(res, 404, { ok: false, error: "World not found." });
        world.name = filterChat(String(body.name || "").slice(0, 64)) || world.name;
        result.name = world.name;
        break;
      }
      case "resetWorldStats": {
        const world = db.worlds[String(body.worldId || "")];
        if (!world) return send(res, 404, { ok: false, error: "World not found." });
        world.visits = 0; world.likes = 0; world.likedBy = [];
        break;
      }
      case "featureWorld": {
        const world = db.worlds[String(body.worldId || "")];
        if (!world) return send(res, 404, { ok: false, error: "World not found." });
        world.featured = !world.featured;
        result.featured = world.featured;
        break;
      }

      // --- live rooms ---
      case "listRooms":
        result.rooms = Array.from(rooms.values()).map((r) => ({
          code: r.code, gameId: r.gameId, online: r.players.size,
          createdAt: r.createdAt,
        }));
        break;
      case "closeRoom": {
        const code = String(body.code || "").trim().toUpperCase();
        if (!rooms.has(code)) return send(res, 404, { ok: false, error: "Room not found." });
        rooms.delete(code);
        break;
      }
      case "clearRoomChat": {
        const room = rooms.get(String(body.code || "").trim().toUpperCase());
        if (!room) return send(res, 404, { ok: false, error: "Room not found." });
        room.chat = [{ id: token(), time: Date.now(), sender: "System", message: "Chat cleared by a moderator." }];
        break;
      }

      // --- accounts (owner) ---
      case "setBalance": if (needTarget()) return; target.balance = amount; result.balance = amount; break;
      case "setGems": if (needTarget()) return; target.gems = amount; result.gems = amount; break;
      case "clearInventory": if (needTarget()) return; target.inventory = []; break;
      case "resetPassword": {
        if (needTarget()) return;
        if (roleAtLeast(target, actor.adminRole) && target.username !== actor.username)
          return send(res, 403, { ok: false, error: "Cannot reset same/higher role." });
        const newPass = makeCode(10);
        target.salt = token();
        target.passwordHash = hashPasswordScrypt(newPass, target.salt);
        target.token = "";
        result.newPassword = newPass; // shown once to the owner
        break;
      }
      case "deleteUser": {
        if (needTarget()) return;
        if (target.adminRole === "owner")
          return send(res, 403, { ok: false, error: "Cannot delete an owner." });
        delete db.users[targetName];
        break;
      }

      // --- ratings ---
      case "ratingsList":
        result.ratings = Object.entries(db.ratings || {}).map(([who, r]) => ({
          username: who, stars: r.stars, time: r.time,
        })).sort((a, b) => b.time - a.time).slice(0, 100);
        break;
      case "deleteRating": {
        if (!db.ratings[targetName]) return send(res, 404, { ok: false, error: "No rating from that player." });
        delete db.ratings[targetName];
        break;
      }

      // --- promo extras ---
      case "promoEnable": {
        const code = String(body.code || "").trim().toLowerCase();
        if (!db.promoCodes[code]) return send(res, 404, { ok: false, error: "Code not found." });
        db.promoCodes[code].enabled = true;
        break;
      }
      case "listPromos":
        result.promos = Object.entries(db.promoCodes).map(([code, p]) => ({
          code, label: (p.reward && p.reward.label) || "", enabled: p.enabled,
          redeemed: (p.redeemedBy || []).length,
        }));
        break;

      // --- broadcast announcement into every live room ---
      case "announce": {
        const text = filterChat(String(body.message || "").slice(0, 200));
        if (!text) return send(res, 400, { ok: false, error: "Empty announcement." });
        for (const room of rooms.values()) {
          room.chat.push({ id: token(), time: Date.now(), sender: "📢 ANNOUNCEMENT", message: text });
          room.chat = room.chat.slice(-MAX_CHAT);
        }
        result.sentTo = rooms.size;
        break;
      }

      // --- server stats ---
      case "serverStats": {
        const users = Object.values(db.users);
        result.stats = {
          users: users.length,
          banned: users.filter(isBanned).length,
          worlds: db.worldOrder.length,
          liveRooms: rooms.size,
          playersOnline: Array.from(rooms.values()).reduce((sum, r) => sum + r.players.size, 0),
          openReports: db.reports.filter((r) => !r.resolved).length,
          totalCoins: users.reduce((sum, u) => sum + (u.balance || 0), 0),
          totalGems: users.reduce((sum, u) => sum + (u.gems || 0), 0),
          uptimeMinutes: Math.floor(process.uptime() / 60),
        };
        break;
      }
    }

    audit(actor.username, "admin_" + action, targetName, JSON.stringify({ amount, itemId: body.itemId, code: body.code }).slice(0, 160));
    saveDb();
    return send(res, 200, result);
  }

  // BobGems checkout from the website. Login is verified server-side.
  // STRIPE mode: replies with a redirect to Stripe Checkout (card entered on
  // Stripe's page, never on ours); gems are credited by the webhook below.
  // TEST mode: gems are granted immediately, no real money.
  if (url.pathname === "/api/payments/checkout" && req.method === "POST") {
    const body = await parseBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    // Rate limit BEFORE the password check, keyed by IP too - otherwise this
    // endpoint is a free password brute-force oracle.
    if (rateLimited("buy:" + username, 3000) ||
        rateLimited("buyip:" + req.socket.remoteAddress, 1500))
      return send(res, 429, { ok: false, error: "Too many attempts, wait a moment." });
    const user = Object.prototype.hasOwnProperty.call(db.users, username) ? db.users[username] : null;
    if (!user || !verifyPassword(user, String(body.password || "").slice(0, 72)))
      return send(res, 401, { ok: false, error: "Wrong username or password." });
    if (isBanned(user))
      return send(res, 403, { ok: false, error: "Account is banned." });

    const packageId = String(body.packageId || "");
    const pack = GEM_PACKAGES[packageId];
    if (!pack) return send(res, 400, { ok: false, error: "Unknown package." });

    if (STRIPE_CONFIGURED) {
      try {
        const session = await stripeRequest("/v1/checkout/sessions", {
          mode: "payment",
          success_url: SITE_URL + "/buy?paid=1",
          cancel_url: SITE_URL + "/buy?canceled=1",
          "line_items[0][quantity]": "1",
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][unit_amount]": String(pack.cents),
          "line_items[0][price_data][product_data][name]": `${pack.gems} BobGems (${pack.label})`,
          "metadata[username]": user.username.toLowerCase(),
          "metadata[packageId]": packageId,
        });
        if (!session || !session.url)
          return send(res, 502, { ok: false, error: "Stripe rejected the request." });
        return send(res, 200, { ok: true, redirect: session.url });
      } catch {
        return send(res, 502, { ok: false, error: "Could not reach Stripe, try later." });
      }
    }

    if (!TEST_PAYMENTS)
      return send(res, 503, { ok: false, error: "Payments are not connected yet." });

    grantGems(user, pack, "test", "");
    return send(res, 200, { ok: true, granted: pack.gems, gems: user.gems, test: true });
  }

  // Stripe calls this after a successful payment. Signature-verified.
  // Configure in the Stripe dashboard: endpoint <site>/api/payments/stripe-webhook,
  // event "checkout.session.completed".
  if (url.pathname === "/api/payments/stripe-webhook" && req.method === "POST") {
    const raw = await readRawBody(req);
    if (!verifyStripeSignature(raw, req.headers["stripe-signature"]))
      return send(res, 400, { ok: false, error: "Bad signature." });

    let event;
    try { event = JSON.parse(raw.toString("utf8")); }
    catch { return send(res, 400, { ok: false, error: "Bad payload." }); }

    if (event.type === "checkout.session.completed") {
      const session = event.data && event.data.object;
      db.processedPayments = db.processedPayments || [];
      if (session && session.payment_status === "paid" &&
          !db.processedPayments.includes(session.id)) {
        const meta = session.metadata || {};
        const user = db.users[String(meta.username || "")];
        const pack = GEM_PACKAGES[String(meta.packageId || "")];
        if (user && pack) {
          db.processedPayments.push(session.id);
          db.processedPayments = db.processedPayments.slice(-2000);
          grantGems(user, pack, "stripe", session.id);
        }
      }
    }
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/payments/packages" && req.method === "GET") {
    return send(res, 200, {
      ok: true,
      mode: paymentsMode(),
      test: paymentsMode() === "test",
      packages: GEM_PACKAGES,
    });
  }

  if (url.pathname === "/api/realtime/create-room" && req.method === "POST") {
    const body = await parseBody(req);
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();

    const playerId = token();
    const room = {
      code,
      gameId: String(body.gameId || "Game"),
      worldId: String(body.worldId || ""),
      createdAt: Date.now(),
      players: new Map(),
      chat: [],
      voice: [],
      voiceSeq: 0,
    };
    room.players.set(playerId, {
      id: playerId,
      name: cleanName(body.name, "Host"),
      x: 0, y: 0, z: 0,
      rx: 0, ry: 0, rz: 0, rw: 1,
      lastSeen: Date.now(),
    });
    room.chat.push({ id: token(), time: Date.now(), sender: "System", message: "Room created." });
    rooms.set(code, room);
    return send(res, 200, { ok: true, code, playerId, room: roomSnapshot(room) });
  }

  if (url.pathname === "/api/realtime/join-room" && req.method === "POST") {
    const body = await parseBody(req);
    const code = String(body.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return send(res, 404, { ok: false, error: "Room not found." });

    if (room.players.size >= 30)
      return send(res, 403, { ok: false, error: "Room is full." });
    const playerId = token();
    const name = cleanName(body.name, "Player");
    room.players.set(playerId, {
      id: playerId,
      name,
      x: 0, y: 0, z: 0,
      rx: 0, ry: 0, rz: 0, rw: 1,
      lastSeen: Date.now(),
    });
    room.chat.push({ id: token(), time: Date.now(), sender: "System", message: `${name} joined.` });
    return send(res, 200, { ok: true, code, playerId, room: roomSnapshot(room) });
  }

  if (url.pathname === "/api/realtime/state" && req.method === "POST") {
    const body = await parseBody(req);
    const room = rooms.get(String(body.code || "").trim().toUpperCase());
    if (!room) return send(res, 404, { ok: false, error: "Room not found." });

    const player = room.players.get(String(body.playerId || ""));
    if (!player) return send(res, 404, { ok: false, error: "Player not in room." });

    player.x = safeNum(body.x);
    player.y = safeNum(body.y);
    player.z = safeNum(body.z);
    player.rx = safeNum(body.rx);
    player.ry = safeNum(body.ry);
    player.rz = safeNum(body.rz);
    player.rw = Number.isFinite(Number(body.rw)) ? Number(body.rw) : 1;
    player.lastSeen = Date.now();

    if (body.chat) {
      // v0.3 chat safety: mute check, per-player cooldown, length + word filter.
      const account = db.users[String(player.name || "").toLowerCase()];
      if (isMuted(account)) {
        // silently drop muted players' messages
      } else if (rateLimited("chat:" + player.name, 2000)) {
        // 2s message cooldown
      } else {
        const clean = filterChat(body.chat);
        if (clean) {
          room.chat.push({ id: token(), time: Date.now(), sender: player.name, message: clean });
          room.chat = room.chat.slice(-MAX_CHAT);
        }
      }
    }

    return send(res, 200, roomSnapshot(room));
  }

  if (url.pathname === "/api/realtime/room" && req.method === "GET") {
    const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return send(res, 404, { ok: false, error: "Room not found." });
    return send(res, 200, roomSnapshot(room));
  }

  // Voice chat: push-to-talk clips (16-bit PCM, base64). Polling friendly so it
  // works on Render free tier without WebSockets or open ports.
  if (url.pathname === "/api/realtime/voice" && req.method === "POST") {
    const body = await parseBody(req);
    const room = rooms.get(String(body.code || "").trim().toUpperCase());
    if (!room) return send(res, 404, { ok: false, error: "Room not found." });

    const player = room.players.get(String(body.playerId || ""));
    if (!player) return send(res, 404, { ok: false, error: "Player not in room." });

    const data = String(body.data || "");
    // ~6s of 16 kHz 16-bit mono is ~256 KB binary -> ~342 KB base64.
    if (!data || data.length > 400000) return send(res, 400, { ok: false, error: "Bad voice clip." });
    if (rateLimited("voice:" + player.id, 700)) return send(res, 200, { ok: true, skipped: true });

    const account = db.users[String(player.name || "").toLowerCase()];
    if (isMuted(account)) return send(res, 200, { ok: true, skipped: true });

    room.voice = room.voice || [];
    room.voiceSeq = (room.voiceSeq || 0) + 1;
    room.voice.push({
      seq: room.voiceSeq,
      time: Date.now(),
      playerId: player.id,
      sender: player.name,
      rate: Math.max(8000, Math.min(48000, Number(body.rate || 16000))),
      data,
    });
    room.voice = room.voice.slice(-10);
    player.lastSeen = Date.now();
    return send(res, 200, { ok: true, seq: room.voiceSeq });
  }

  if (url.pathname === "/api/realtime/voice" && req.method === "GET") {
    const room = rooms.get(String(url.searchParams.get("code") || "").trim().toUpperCase());
    if (!room) return send(res, 404, { ok: false, error: "Room not found." });

    const after = Number(url.searchParams.get("after") || 0);
    const exclude = String(url.searchParams.get("exclude") || "");
    const now = Date.now();
    const clips = (room.voice || []).filter(
      (c) => c.seq > after && c.playerId !== exclude && now - c.time < 15000
    );
    return send(res, 200, { ok: true, seq: room.voiceSeq || 0, clips });
  }

  if (url.pathname === "/api/worlds/publish" && req.method === "POST") {
    const body = await parseBody(req);
    const user = userByToken(body.token);
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });
    if (rateLimited("publish:" + user.username, 15000))
      return send(res, 429, { ok: false, error: "Publishing too fast. Wait a bit." });
    if ((user.createdWorlds || []).length >= 50)
      return send(res, 403, { ok: false, error: "World limit reached (50). Delete some first." });
    const dataSize = JSON.stringify(body.data || body.dataJson || {}).length;
    if (dataSize > 300 * 1024)
      return send(res, 413, { ok: false, error: "World is too big to publish (max 300 KB)." });

    const id = String(db.nextWorldId++);
    const world = {
      id,
      name: String(body.name || "Untitled World").slice(0, 64),
      description: String(body.description || "").slice(0, 240),
      creator: user.username,
      visits: 0,
      likes: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      data: body.data || body.dataJson || {},
      likedBy: [],
    };
    world.name = filterChat(world.name) || "Untitled World";
    world.description = filterChat(world.description);
    db.worlds[id] = world;
    db.worldOrder.unshift(id);
    user.createdWorlds = user.createdWorlds || [];
    user.createdWorlds.unshift(id);
    saveDb();
    return send(res, 200, { ok: true, world });
  }

  if (url.pathname === "/api/worlds/list" && req.method === "GET") {
    const worlds = db.worldOrder
      .map((id) => db.worlds[id])
      .filter(Boolean)
      .map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        creator: w.creator,
        visits: w.visits,
        likes: w.likes,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      }));
    return send(res, 200, { ok: true, worlds });
  }

  // Like a published world - one like per account, toggleable.
  if (url.pathname === "/api/worlds/like" && req.method === "POST") {
    const body = await parseBody(req);
    const user = userByToken(body.token);
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });
    const world = db.worlds[String(body.id || "")];
    if (!world) return send(res, 404, { ok: false, error: "World not found." });
    if (rateLimited("like:" + user.username, 1500))
      return send(res, 429, { ok: false, error: "Too fast." });

    world.likedBy = world.likedBy || [];
    const who = user.username.toLowerCase();
    const idx = world.likedBy.indexOf(who);
    if (idx >= 0) world.likedBy.splice(idx, 1);
    else world.likedBy.push(who);
    world.likes = world.likedBy.length;
    saveDb();
    return send(res, 200, { ok: true, likes: world.likes, liked: idx < 0 });
  }

  // Public leaderboard for the game and the website. No auth needed -
  // only usernames and public stats are exposed.
  if (url.pathname === "/api/leaderboard" && req.method === "GET") {
    const players = Object.values(db.users)
      .filter((u) => !isBanned(u))
      .map((u) => ({
        username: u.username,
        coins: u.balance || 0,
        gems: u.gems || 0,
        worlds: (u.createdWorlds || []).length,
      }));
    const richest = [...players].sort((a, b) => (b.coins + b.gems * 10) - (a.coins + a.gems * 10)).slice(0, 20);
    const topWorlds = db.worldOrder
      .map((id) => db.worlds[id]).filter(Boolean)
      .map((w) => ({ id: w.id, name: w.name, creator: w.creator, visits: w.visits || 0, likes: w.likes || 0 }))
      .sort((a, b) => (b.visits + b.likes * 5) - (a.visits + a.likes * 5))
      .slice(0, 20);
    return send(res, 200, { ok: true, richest, topWorlds });
  }

  if (url.pathname === "/api/worlds/get" && req.method === "GET") {
    const id = String(url.searchParams.get("id") || "");
    const world = db.worlds[id];
    if (!world) return send(res, 404, { ok: false, error: "World not found." });
    world.visits += 1;
    saveDb();
    return send(res, 200, { ok: true, world });
  }

  return send(res, 404, { ok: false, error: "Endpoint not found." });
}

// v0.3 economy: every price lives HERE, the client only displays them.
// coins table = BobCoins items, gems table = premium items,
// promo-only items cannot be bought at all.
const PROMO_ONLY_ITEMS = ["acc_void_horns"];

const COIN_CATALOG = {
  body_red: 50, body_green: 50, body_purple: 50, body_black: 50,
  body_mint: 50, body_blue: 50,
  head_pink: 50, head_blue: 50, head_white: 50, head_green: 50,
  head_red: 50, head_gold: 50,
  acc_cap: 150, acc_antenna: 150, acc_halo: 150, acc_horns: 150, hat_cube: 150,
  emote_wave: 200, emote_dance: 200, emote_flex: 200,
  studio_deco_pack: 100,
};

const GEM_CATALOG = {
  body_gold: 25,      // premium gold body
  acc_crown: 40,      // premium crown
  acc_halo_gold: 60,  // premium golden halo
};

function catalogPrice(itemId) {
  if (PROMO_ONLY_ITEMS.includes(itemId)) return -1;
  if (COIN_CATALOG[itemId] !== undefined) return COIN_CATALOG[itemId];
  return -1; // unknown items are NOT purchasable (no defaults)
}

function gemPrice(itemId) {
  if (PROMO_ONLY_ITEMS.includes(itemId)) return -1;
  return GEM_CATALOG[itemId] !== undefined ? GEM_CATALOG[itemId] : -1;
}

async function start() {
  await loadDbFromGist(); // restore players after a Render deploy/restart
  migrateV03();

  http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      send(res, 500, { ok: false, error: "Server error." });
    });
  }).listen(PORT, "0.0.0.0", () => {
    console.log(`[Boblox] Platform server running on http://0.0.0.0:${PORT}` +
      (GIST_ENABLED ? " (gist persistence ON)" : " (gist persistence OFF - data is ephemeral)"));
  });
}

// Render sends SIGTERM before shutting the service down - flush the DB first.
process.on("SIGTERM", () => {
  Promise.resolve(GIST_ENABLED ? pushDbToGist() : null)
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000); // never hang the shutdown
});

start();
