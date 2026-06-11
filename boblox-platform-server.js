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

function migrateV03() {
  db.promoCodes = db.promoCodes || {};
  db.auditLogs = db.auditLogs || [];
  db.purchaseLogs = db.purchaseLogs || [];

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

migrateV03();

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

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    return send(res, 200, { ok: true });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  cleanupRooms();

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <h1>Boblox Platform Server</h1>
      <p>Status: online</p>
      <p>Rooms: ${rooms.size}</p>
      <p>Published worlds: ${db.worldOrder.length}</p>
    `);
    return;
  }

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

    if (username.length < 3 || password.length < 4) {
      return send(res, 400, { ok: false, error: "Username or password too short." });
    }
    if (db.users[username.toLowerCase()]) {
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
    const password = String(body.password || "");
    if (rateLimited("login:" + req.socket.remoteAddress, 1000)) {
      return send(res, 429, { ok: false, error: "Too many attempts. Wait a second." });
    }
    const user = db.users[username];

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

    // v0.3 anti-farm: tight cap per grant + per-reason cooldown.
    // (Full server-authoritative match validation is future work.)
    const amount = Math.min(20, Math.max(0, Math.floor(Number(body.amount || 0))));
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
    const amount = Math.max(0, Math.floor(Number(body.amount || 0)));
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

  // --- v0.3: PLAYER REPORTS (moderators read them via the audit log) ---------
  if (url.pathname === "/api/report" && req.method === "POST") {
    const body = await parseBody(req);
    const user = userByToken(body.token);
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });
    if (rateLimited("report:" + user.username, 10000)) {
      return send(res, 429, { ok: false, error: "Please wait before reporting again." });
    }
    audit(user.username, "player_report",
      String(body.target || "").slice(0, 24),
      String(body.reason || "").slice(0, 120));
    return send(res, 200, { ok: true, message: "Report sent. Thank you!" });
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
    const amount = Math.max(0, Math.floor(Number(body.amount || 0)));
    const needTarget = () => !target ? send(res, 404, { ok: false, error: "Player not found." }) : null;

    // Role requirements per action (server-side RBAC).
    const required = {
      listPlayers: "moderator", findPlayer: "moderator",
      mute: "moderator", unmute: "moderator", tempban: "moderator",
      giveCoins: "admin", takeCoins: "admin",
      giveItem: "admin", removeItem: "admin",
      ban: "admin", unban: "admin",
      logs: "admin", purchases: "admin",
      giveGems: "owner", takeGems: "owner",
      promoCreate: "owner", promoDisable: "owner", promoRedeemers: "owner",
      setRole: "owner",
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
    }

    audit(actor.username, "admin_" + action, targetName, JSON.stringify({ amount, itemId: body.itemId, code: body.code }).slice(0, 160));
    saveDb();
    return send(res, 200, result);
  }

  if (url.pathname === "/buy" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <h1>Boblox BobCoins</h1>
      <p>This is a test payment page. No real card details are requested.</p>
      <p>Real payments should be integrated through Stripe, YooKassa, or another provider.</p>
    `);
    return;
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
    };
    room.players.set(playerId, {
      id: playerId,
      name: String(body.name || "Host"),
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

    const playerId = token();
    const name = String(body.name || "Player");
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

    player.x = Number(body.x || 0);
    player.y = Number(body.y || 0);
    player.z = Number(body.z || 0);
    player.rx = Number(body.rx || 0);
    player.ry = Number(body.ry || 0);
    player.rz = Number(body.rz || 0);
    player.rw = Number(body.rw || 1);
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

  if (url.pathname === "/api/worlds/publish" && req.method === "POST") {
    const body = await parseBody(req);
    const user = userByToken(body.token);
    if (!user) return send(res, 401, { ok: false, error: "Invalid session." });

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
    };
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

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    send(res, 500, { ok: false, error: "Server error." });
  });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[Boblox] Platform server running on http://0.0.0.0:${PORT}`);
});
