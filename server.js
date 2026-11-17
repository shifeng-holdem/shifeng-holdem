// 时烽德州服务器：账号 + 余额 + 多人牌桌 + 管理后台
// 全部是游戏筹码：没有真钱、没有加密货币、不能购买或兑现筹码。
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import * as E from "./engine.js";
import { openStore } from "./db.js";
import * as Slot from "./slot.js";
import { mountTables, DEFAULT_LIMITS, GAMES } from "./games/routes.js";
import { vipOf, inviteTitle, DEFAULT_REWARDS, mask, VIP } from "./platform.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_SEATS = 9;
const HOUSE = "__house__";
const BOT_NAMES = ["电脑·阿杰", "电脑·小美", "电脑·老王", "电脑·Lisa", "电脑·大卫", "电脑·阿芳", "电脑·Tom", "电脑·小林", "电脑·阿强"];
// 玩家的筹码只能由庄家（管理员）在后台赠送：注册不送、没有每日免费领取
const DEFAULT_SETTINGS = { rakePercent: 0 };
const SIGNUP_BONUS = 0;
const NO_CHIPS_MSG = "余额不足，请联系客服获取游戏币";
const SESSION_DAYS = 30;

export async function createApp(opts = {}) {
  const botDelay = opts.botDelay ?? [700, 1400];
  const nextHandDelay = opts.nextHandDelay ?? 8000;
  const emptyRoomMs = opts.emptyRoomMs ?? 3 * 60 * 1000; // 没有真人在线超过这么久就关闭房间
  const sweepMs = opts.sweepMs ?? 30 * 1000;
  const autoActDelay = opts.autoActDelay ?? 1500;
  const bcryptRounds = opts.bcryptRounds ?? 10;
  const turnMs = (room) => opts.turnMs ?? room.cfg.timer * 1000;
  const supportUrl = opts.supportUrl ?? process.env.SUPPORT_URL ?? ""; // 客服链接（以后填 Telegram），空则只显示文字

  const store = opts.store ?? await openStore({ databaseUrl: opts.databaseUrl, dataFile: opts.dataFile, memory: opts.memory, schema: opts.schema });
  // 启动时清理旧版本留下的“注册赠送 / 每日领取”设置，确保它们不再生效
  const stored = await store.getSettings();
  for (const k of ["signupBonus", "dailyFree"]) if (k in stored && stored[k] !== 0) await store.setSetting(k, 0);
  let settings = { ...DEFAULT_SETTINGS, rakePercent: Number(stored.rakePercent) || 0 };
  // 每个游戏的最低/最高下注（分）、邀请奖励设置、公告：存在 settings 表里，后台可以改
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([g, d]) => [g, { ...d, ...((stored.gameLimits || {})[g] || {}) }]));
  const rewards = { invite: { ...DEFAULT_REWARDS.invite, ...((stored.rewards || {}).invite || {}) } };
  let announcements = Array.isArray(stored.announcements) ? stored.announcements : [];
  let house = await store.getUserByName(HOUSE);
  if (!house) house = await store.createUser(HOUSE, "!", 0, { isHouse: true });
  const houseId = house.id;
  if (opts.adminUsername && opts.adminPassword) {
    const hash = await bcrypt.hash(String(opts.adminPassword), bcryptRounds);
    const a = await store.getUserByName(opts.adminUsername);
    if (a) await store.updateUser(a.id, { passHash: hash, isAdmin: true, banned: false });
    else await store.createUser(String(opts.adminUsername), hash, 0, { isAdmin: true });
  } else if (!opts.quiet) console.warn("⚠️  没有设置 ADMIN_USERNAME / ADMIN_PASSWORD，管理后台暂时无人可以登录。");

  const app = express();
  app.set("trust proxy", opts.trustProxy ?? 1); // Render 前面有一层代理，取真实 IP（用于邀请的简单防刷）
  const json20 = express.json({ limit: "20kb" });
  app.use((req, res, next) => (req.path === "/api/me/avatar" ? next() : json20(req, res, next)));
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
  const server = createServer(app);
  const io = new Server(server, { cors: { origin: "*" } });
  const rooms = new Map();
  const userSockets = new Map(); // userId -> Set(socketId)

  // 后台操作（记账）全部挂在这里，测试可以等它们完成
  const pending = new Set();
  const track = (p) => { pending.add(p); p.catch((e) => console.error("记账失败", e)).finally(() => pending.delete(p)); return p; };
  const idle = async () => { while (pending.size) await Promise.allSettled([...pending]); };

  const newToken = () => randomBytes(24).toString("hex");
  const clampInt = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const activeMembers = (room) => room.members.filter((m) => !m.left);
  const betting = (g) => g && ["preflop", "flop", "turn", "river"].includes(g.stage);
  const newCode = () => {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let c; do { c = Array.from({ length: 5 }, () => A[Math.floor(Math.random() * A.length)]).join(""); } while (rooms.has(c));
    return c;
  };
  const publicUser = (u) => ({ id: u.id, publicId: u.publicId, username: u.username, balance: u.balance, isAdmin: u.isAdmin, avatarVer: u.avatarVer || 0, createdAt: u.createdAt, supportUrl, vip: vipOf(u.turnover || 0) });

  // ---------- 账号 ----------
  async function userFromToken(token) {
    if (!token || typeof token !== "string") return null;
    const s = await store.getSession(token); if (!s) return null;
    const u = await store.getUser(s.userId);
    return u && !u.banned && !u.isHouse ? u : null;
  }
  const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const auth = async (req, res, next) => { try { req.user = await userFromToken(bearer(req)); if (!req.user) return res.status(401).json({ error: "请先登录" }); next(); } catch (e) { next(e); } };
  const adminOnly = async (req, res, next) => { try { req.user = await userFromToken(bearer(req)); if (!req.user) return res.status(401).json({ error: "请先登录" }); if (!req.user.isAdmin) return res.status(403).json({ error: "没有管理权限" }); next(); } catch (e) { next(e); } };
  const NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,16}$/;
  const fails = new Map();

  async function newSession(u) {
    const token = newToken();
    await store.createSession(token, u.id, Date.now() + SESSION_DAYS * 864e5);
    await store.updateUser(u.id, { lastLogin: Date.now() });
    return token;
  }

  app.post("/api/register", async (req, res, next) => {
    try {
      const username = String(req.body?.username || "").trim(); const password = String(req.body?.password || "");
      if (!NAME_RE.test(username) || username.startsWith("__")) return res.status(400).json({ error: "用户名需 2–16 位，只能用中文、字母、数字或下划线" });
      if (password.length < 6 || password.length > 72) return res.status(400).json({ error: "密码至少 6 位" });
      // 邀请码 = 邀请人的玩家 ID。同一 IP 的“自己邀请自己”或同一设备反复注册不发奖励（账号照常注册）
      const ip = req.ip || ""; let invitedBy = null, inviteStatus = null;
      const code = Number(String(req.body?.invite || "").trim());
      if (code) {
        const inv = await store.getUserByPublicId(code);
        if (inv && !inv.isHouse && !inv.banned) {
          invitedBy = inv.id;
          inviteStatus = ip && (inv.regIp === ip || inv.lastIp === ip || (await store.countInviteesByIp(inv.id, ip)) > 0) ? "blocked" : "pending";
        }
      }
      let u;
      try { u = await store.createUser(username, await bcrypt.hash(password, bcryptRounds), SIGNUP_BONUS, { invitedBy, inviteStatus, regIp: ip || null }); }
      catch (e) { if (e.message === "EXISTS") return res.status(409).json({ error: "这个用户名已被注册" }); throw e; }
      res.json({ token: await newSession(u), user: publicUser(u) });
    } catch (e) { next(e); }
  });

  app.post("/api/login", async (req, res, next) => {
    try {
      const username = String(req.body?.username || "").trim(); const password = String(req.body?.password || "");
      const key = username.toLowerCase(); const f = fails.get(key);
      if (f && f.n >= 8 && Date.now() < f.until) return res.status(429).json({ error: "尝试次数过多，请 5 分钟后再试" });
      const u = await store.getUserByName(username);
      if (!u || u.isHouse || !(await bcrypt.compare(password, u.passHash))) {
        const n = (f && Date.now() < f.until ? f.n : 0) + 1; fails.set(key, { n, until: Date.now() + 5 * 60 * 1000 });
        return res.status(401).json({ error: "用户名或密码错误" });
      }
      fails.delete(key);
      if (u.banned) return res.status(403).json({ error: "账号已被封禁，请联系庄家" });
      if (req.ip) await store.updateUser(u.id, { lastIp: req.ip });
      res.json({ token: await newSession(u), user: publicUser(u) });
    } catch (e) { next(e); }
  });

  app.post("/api/logout", async (req, res, next) => { try { const t = bearer(req); if (t) await store.deleteSession(t); res.json({ ok: true }); } catch (e) { next(e); } });
  app.get("/api/me", auth, (req, res) => res.json(publicUser(req.user)));
  // ---------- 个人中心 ----------
  app.get("/api/me/profile", auth, async (req, res, next) => {
    try {
      const u = req.user; const mj = await store.slotTotals("mahjong", u.id);
      res.json({ ...publicUser(u), poker: { handsPlayed: u.handsPlayed, handsWon: u.handsWon, best: u.pokerBest }, mahjong: { spins: mj.spins, bets: mj.bets, wins: mj.wins, best: mj.best } });
    } catch (e) { next(e); }
  });
  app.post("/api/me/password", auth, async (req, res, next) => {
    try {
      const oldPw = String(req.body?.oldPassword || ""), newPw = String(req.body?.newPassword || "");
      if (!(await bcrypt.compare(oldPw, req.user.passHash))) return res.status(400).json({ error: "原密码不正确" });
      if (newPw.length < 6 || newPw.length > 72) return res.status(400).json({ error: "新密码至少 6 位" });
      if (newPw === oldPw) return res.status(400).json({ error: "新密码不能和原密码相同" });
      await store.updateUser(req.user.id, { passHash: await bcrypt.hash(newPw, bcryptRounds) });
      await store.deleteUserSessions(req.user.id); // 其他设备全部退出，本机换新令牌
      res.json({ ok: true, token: await newSession(req.user) });
    } catch (e) { next(e); }
  });
  const AVATAR_MAX = 300 * 1024;
  const magic = (b) => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg" : b.slice(0, 4).toString("hex") === "89504e47" ? "image/png"
    : b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP" ? "image/webp" : null);
  app.post("/api/me/avatar", auth, express.raw({ type: () => true, limit: AVATAR_MAX }), async (req, res, next) => {
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (buf.length < 64) return res.status(400).json({ error: "请选择一张图片" });
      const ct = String(req.headers["content-type"] || "").split(";")[0].trim(); const real = magic(buf);
      if (!real || !["image/jpeg", "image/png", "image/webp"].includes(ct) || ct !== real) return res.status(415).json({ error: "只支持 JPG、PNG 或 WebP 图片" });
      const ver = await store.setAvatar(req.user.id, real, buf);
      updateMemberAvatar(req.user.id, ver); pushMe(req.user.id);
      res.json({ ok: true, avatarVer: ver });
    } catch (e) { next(e); }
  });
  app.delete("/api/me/avatar", auth, async (req, res, next) => { try { const ver = await store.clearAvatar(req.user.id); updateMemberAvatar(req.user.id, ver); pushMe(req.user.id); res.json({ ok: true, avatarVer: ver }); } catch (e) { next(e); } });
  // 头像：/api/avatar/10001?v=3 ；没上传的生成默认头像（首字 + 紫金渐变）
  app.get("/api/avatar/:pid", async (req, res, next) => {
    try {
      const u = await store.getUserByPublicId(Number(req.params.pid));
      if (!u) return res.status(404).end();
      const a = u.avatarVer > 0 ? await store.getAvatar(u.id) : null; // 负数 = 已恢复默认（保留版本号，避免缓存串图）
      const etag = `"av${u.id}-${u.avatarVer}"`;
      res.set("ETag", etag); res.set("Cache-Control", req.query.v != null ? "public, max-age=31536000, immutable" : "public, max-age=300");
      if (req.headers["if-none-match"] === etag) return res.status(304).end();
      if (a) return res.type(a.mime).send(a.data);
      const ch = [...u.username][0] || "?"; const esc = (x) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const hue = [270, 285, 300, 260, 315][u.publicId % 5];
      res.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><radialGradient id="g" cx="35%" cy="28%" r="80%"><stop offset="0" stop-color="hsl(${hue},55%,52%)"/><stop offset=".6" stop-color="hsl(${hue},60%,28%)"/><stop offset="1" stop-color="#1a0b2e"/></radialGradient><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3c4"/><stop offset=".55" stop-color="#f5d77a"/><stop offset="1" stop-color="#b8860b"/></linearGradient></defs><rect width="128" height="128" fill="url(#g)"/><circle cx="64" cy="64" r="58" fill="none" stroke="#d4af37" stroke-width="5"/><text x="64" y="68" text-anchor="middle" dominant-baseline="middle" font-family="PingFang SC,Noto Sans CJK SC,sans-serif" font-size="62" font-weight="800" fill="#6a4a0a" dy="3">${esc(ch.toUpperCase())}</text><text x="64" y="68" text-anchor="middle" dominant-baseline="middle" font-family="PingFang SC,Noto Sans CJK SC,sans-serif" font-size="62" font-weight="800" fill="url(#t)">${esc(ch.toUpperCase())}</text></svg>`);
    } catch (e) { next(e); }
  });
  app.get("/api/me/ledger", auth, async (req, res, next) => { try { res.json(await store.ledger(req.user.id, 30)); } catch (e) { next(e); } });
  app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size, storage: store.kind }));
  app.get("/api/rooms", (_req, res) => res.json(listRooms()));

  // ---------- 时烽麻将消消乐（单人转轴，结果全部在服务器计算） ----------
  const MJ = "mahjong"; const MJ_NAME = "时烽麻将消消乐";
  const slotRng = opts.slotRng ?? Slot.cryptoRng();
  const spinning = new Set(); // 同一个玩家同时只能有一次转动在结算
  app.get("/api/mahjong/config", (_req, res) => res.json({
    name: MJ_NAME, bets: Slot.BETS.filter((b) => b >= limits.mahjong.min && b <= limits.mahjong.max), reels: Slot.REELS, rows: Slot.ROWS, paytable: Slot.PAYTABLE, symbols: Slot.SYMBOLS,
    baseMults: Slot.BASE_MULTS, freeMults: Slot.FREE_MULTS, maxWinX: Slot.MAX_WIN_X,
  }));
  app.post("/api/mahjong/spin", auth, async (req, res, next) => {
    const uid = req.user.id; const bet = Math.trunc(Number(req.body?.bet));
    if (!Slot.BETS.includes(bet) || bet < limits.mahjong.min || bet > limits.mahjong.max) return res.status(400).json({ error: "请选择有效的下注额" });
    if (spinning.has(uid)) return res.status(429).json({ error: "上一局还在结算，请稍等" });
    spinning.add(uid);
    try {
      if (req.user.balance < bet) return res.status(400).json({ error: NO_CHIPS_MSG, code: "NO_CHIPS" });
      const r = Slot.spin(bet, slotRng);
      const label = `${MJ_NAME} 下注 ${E.money(bet)}` + (r.win ? ` 赢 ${E.money(r.win)}` : "") + (r.freeAwarded ? `（免费游戏 ${r.freeAwarded} 次）` : "");
      let saved;
      try { saved = await store.slotSpin(uid, houseId, MJ, bet, r.win, r.freeAwarded, label); }
      catch (e) { if (e.message === "INSUFFICIENT") return res.status(400).json({ error: NO_CHIPS_MSG, code: "NO_CHIPS" }); throw e; }
      pushMe(uid); track(onPlayed(uid));
      res.json({ ...r, id: saved.id, balance: saved.balance });
    } catch (e) { next(e); } finally { spinning.delete(uid); }
  });
  app.get("/api/mahjong/history", auth, async (req, res, next) => {
    try { res.json({ history: await store.slotHistory(req.user.id, MJ, 20), totals: await store.slotTotals(MJ, req.user.id) }); } catch (e) { next(e); }
  });

  async function pushMe(userId) {
    const set = userSockets.get(userId); if (!set || !set.size) return;
    const u = await store.getUser(userId); if (!u) return;
    for (const sid of set) io.to(sid).emit("me", publicUser(u));
  }

  // ---------- 筹码进出 ----------
  // 真人：从余额带入 / 返还余额；电脑玩家：由庄家账户出资（允许为负）
  async function debit(member, amount, reason) {
    if (member.bot) return store.adjust(houseId, -amount, reason, "system", true);
    const bal = await store.adjust(member.userId, -amount, reason, "system");
    pushMe(member.userId); return bal;
  }
  function credit(member, amount, reason) {
    if (!(amount > 0)) return;
    if (member.bot) return track(store.adjust(houseId, amount, reason, "system", true));
    return track(store.adjust(member.userId, amount, reason, "system").then(() => pushMe(member.userId)));
  }

  // 把某个座位的筹码返还（一手牌进行中且还在牌局里的，等这手结束再结算）
  function releaseSeat(room, idx, reason) {
    const m = room.members[idx]; if (!m || m.cashedOut) return;
    if (!room.g) { m.cashedOut = true; credit(m, m.stack, reason); m.stack = 0; return; }
    const p = room.g.players[idx];
    if (betting(room.g) && !p.folded && !p.out) { m.pendingCashout = reason; p.sitOut = true; return; }
    m.cashedOut = true; m.pendingCashout = null;
    credit(m, p.chips, reason); p.chips = 0; p.sitOut = true;
  }

  function afterHand(room) {
    const g = room.g;
    // 个人战绩：每手牌只记一次（真人且拿到了手牌）
    if (room.statHand !== g.handNo && g.handNo > 0) {
      room.statHand = g.handNo;
      g.players.forEach((p, i) => { const m = room.members[i]; if (m && !m.bot && m.userId && p.hole.length === 2) { track(store.addPokerStats(m.userId, g.winners.includes(i), p.won || 0, p.total || 0)); track(onPlayed(m.userId)); } });
    }
    if (g.lastRake > 0 && room.rakedHand !== g.handNo) {
      room.rakedHand = g.handNo;
      track(store.adjust(houseId, g.lastRake, `抽水 房间${room.code} 第${g.handNo}手`, "system", true));
    }
    room.members.forEach((m, i) => { if (m.pendingCashout) releaseSeat(room, i, m.pendingCashout); });
  }

  function closeRoom(room, reason = "房间已关闭") {
    if (!rooms.has(room.code)) return;
    clearTimers(room);
    const g = room.g; const voidHand = betting(g); // 一手牌进行中被关闭：这手作废，下注全部退回
    if (g && !voidHand) afterHand(room);
    room.members.forEach((m, i) => {
      if (!g) { if (!m.cashedOut) { m.cashedOut = true; credit(m, m.stack, `离桌返还 房间${room.code}`); } return; }
      const p = g.players[i]; let amt = 0;
      if (!m.cashedOut) { amt += p.chips; m.cashedOut = true; p.chips = 0; }
      if (voidHand) { amt += p.total; p.total = 0; }
      credit(m, amt, voidHand ? `牌局中止，返还 房间${room.code}` : `离桌返还 房间${room.code}`);
    });
    for (const m of room.members) if (m.socketId) { const s = io.sockets.sockets.get(m.socketId); if (s) { s.emit("kicked", reason); s.leave(room.code); s.data.code = null; } }
    rooms.delete(room.code); roomsChanged();
  }

  // ---------- 牌桌 ----------
  function parseCfg(c = {}) {
    const start = clampInt(c.start, 100, 100000000, 1000); // 单位：分（客户端会传自己的设置）
    const bb = clampInt(c.bb, 2, Math.floor(start / 5), Math.min(20, Math.floor(start / 5)));
    const sb = clampInt(c.sb, 1, bb, Math.max(1, Math.floor(bb / 2)));
    const timer = clampInt(c.timer, 10, 120, 30);
    const isPublic = c.public === undefined ? true : !(c.public === false || c.public === "false" || c.public === 0);
    return { start, sb, bb, timer, public: isPublic };
  }

  function viewFor(room, token) {
    const you = room.members.findIndex((m) => m.token === token && !m.left);
    const g = room.g;
    const reveal = g && g.showdown && (g.stage === "handover" || g.stage === "gameover");
    const game = g && {
      stage: g.stage, board: g.board, dealer: g.dealer, sb: g.sb, bb: g.bb, current: g.current,
      currentBet: g.currentBet, minRaise: g.minRaise, pot: E.pot(g), handNo: g.handNo, showdown: g.showdown,
      winners: g.winners, log: g.log.slice(-30), sbAmt: g.sbAmt, bbAmt: g.bbAmt, rakePct: g.rakePct, lastRake: g.lastRake,
      players: g.players.map((p, i) => {
        const m = room.members[i];
        const show = i === you || (reveal && !p.folded && !p.out);
        return {
          name: p.name, bot: p.bot, chips: p.chips, bet: p.bet, total: p.total, folded: p.folded, allIn: p.allIn,
          out: p.out, sitOut: p.sitOut, last: p.last, won: p.won, handName: show ? p.handName : "",
          hole: show ? p.hole : [], cards: p.hole.length, pid: m ? m.pid : null, av: m ? m.av : 0, vip: m ? m.vip || 0 : 0, connected: !!(m && (m.bot || m.connected)), left: !!(m && m.left),
        };
      }),
      legal: you >= 0 && betting(g) && g.current === you ? E.legal(g, you) : null,
      toCall: you >= 0 && betting(g) ? E.toCall(g, you) : 0,
      myHand: you >= 0 && g.players[you].hole.length === 2 && g.board.length >= 3 ? E.scoreName(E.best7([...g.players[you].hole, ...g.board])) : "",
      canRebuy: you >= 0 && g.players[you].chips === 0 && (g.players[you].out || !betting(g)),
    };
    return {
      code: room.code, you, isHost: room.hostToken === token, cfg: room.cfg, started: !!g,
      members: room.members.map((m, i) => ({ i, name: m.name, pid: m.pid, av: m.av, vip: m.vip || 0, bot: m.bot, connected: m.bot || m.connected, left: m.left, host: m.token === room.hostToken })).filter((m) => !m.left),
      game, deadline: room.deadline, nextAt: room.nextAt, now: Date.now(),
    };
  }

  function broadcast(room) {
    for (const m of room.members) if (m.socketId && !m.left) io.to(m.socketId).emit("state", viewFor(room, m.token));
  }
  function clearTimers(room) { clearTimeout(room.turnTimer); clearTimeout(room.nextTimer); room.deadline = null; room.nextAt = null; }

  function doAction(room, action, note) {
    const g = room.g; if (!betting(g)) return;
    if (note) g.log = [...g.log, `${g.players[g.current].name} ${note}`].slice(-40);
    room.g = E.act(g, action);
    if (!betting(room.g)) afterHand(room);
    update(room);
  }

  function schedule(room) {
    clearTimers(room);
    const g = room.g; if (!g) return;
    const anyHuman = humansOnline(room);
    if (betting(g)) {
      const i = g.current; const p = g.players[i]; const m = room.members[i];
      if (p.bot) {
        room.turnTimer = setTimeout(() => { if (room.g === g) doAction(room, E.aiDecide(g, 150)); }, botDelay[0] + Math.random() * (botDelay[1] - botDelay[0]));
      } else if (!m || m.left || !m.connected || p.sitOut) {
        room.turnTimer = setTimeout(() => { if (room.g === g) doAction(room, E.legal(g, i).check ? { type: "check" } : { type: "fold" }); }, autoActDelay);
      } else {
        room.deadline = Date.now() + turnMs(room);
        room.turnTimer = setTimeout(() => { if (room.g === g) doAction(room, E.legal(g, i).check ? { type: "check" } : { type: "fold" }, "超时，自动操作"); }, turnMs(room));
      }
    } else if (g.stage === "handover" && !E.canStart(withSitOut(room))) {
      g.stage = "gameover";
    } else if (g.stage === "gameover" && E.canStart(withSitOut(room))) {
      g.stage = "handover"; return schedule(room);
    } else if (g.stage === "handover" && anyHuman) {
      room.nextAt = Date.now() + nextHandDelay;
      room.nextTimer = setTimeout(() => nextHand(room), nextHandDelay);
    }
  }
  function withSitOut(room) {
    room.g.players.forEach((p, i) => { const m = room.members[i]; p.sitOut = !!(m.left || m.cashedOut || m.pendingCashout || m.sitOutReq || (!m.bot && !m.connected && m.missedHands >= 2)); });
    return room.g;
  }

  function update(room) { if (!rooms.has(room.code)) return; room.lastActive = Date.now(); schedule(room); broadcast(room); roomsChanged(); }

  // ---------- 公开房间列表 ----------
  const humansOnline = (room) => room.members.some((m) => !m.bot && !m.left && m.connected);
  function listRooms() {
    const list = [];
    for (const room of rooms.values()) {
      if (!room.cfg.public || !humansOnline(room)) continue;
      const seats = activeMembers(room).length;
      const host = room.members.find((m) => m.token === room.hostToken);
      list.push({
        code: room.code, host: host ? host.name : "", seats, maxSeats: MAX_SEATS, full: seats >= MAX_SEATS,
        humans: activeMembers(room).filter((m) => !m.bot).length, sb: room.cfg.sb, bb: room.cfg.bb, start: room.cfg.start,
        status: room.g ? "游戏中" : "等待中", created: room.created,
      });
    }
    return list.sort((a, b) => (a.full - b.full) || ((a.status === "游戏中") - (b.status === "游戏中")) || b.created - a.created);
  }
  let listTimer = null, lastListJson = "";
  function roomsChanged() {
    if (listTimer) return;
    listTimer = setTimeout(() => {
      listTimer = null;
      const list = listRooms(); const json = JSON.stringify(list);
      if (json === lastListJson) return;
      lastListJson = json; io.to("lobby").emit("rooms", list);
    }, opts.listDebounceMs ?? 200);
  }

  function nextHand(room) {
    if (!room.g || !["handover", "gameover"].includes(room.g.stage)) return;
    withSitOut(room);
    if (!E.canStart(room.g)) { room.g.stage = "gameover"; update(room); return; }
    room.g.rakePct = settings.rakePercent;
    room.g = E.startHand(room.g);
    room.members.forEach((m) => { if (!m.bot && !m.connected) m.missedHands = (m.missedHands || 0) + 1; });
    update(room);
  }

  function updateMemberAvatar(userId, ver) {
    for (const r of rooms.values()) for (const m of r.members) if (m.userId === userId) { m.av = ver; update(r); }
  }
  function addMember(room, { name, bot, userId, socketId, pid = null, av = 0, vip = 0 }) {
    const m = { token: bot ? "bot-" + newToken() : "u" + userId, userId: bot ? null : userId, pid, av, vip, name, bot, socketId, connected: !bot, left: false, missedHands: 0, stack: room.cfg.start };
    const g = room.g;
    if (!g) { room.members.push(m); return m; }
    // 游戏中加入：两手牌之间才复用已离开的空位，避免影响本手底池
    const idx = betting(g) ? -1 : room.members.findIndex((x) => x.left && x.cashedOut);
    if (idx === -1) { if (g.players.length >= MAX_SEATS) return null; E.addPlayer(g, name, bot); room.members.push(m); return m; }
    room.members[idx] = m; g.players[idx] = E.mkPlayer(idx, name, bot, g.startChips);
    return m;
  }

  function leave(room, token, reason = "离桌返还") {
    const idx = room.members.findIndex((m) => m.token === token && !m.left);
    if (idx < 0) return;
    const m = room.members[idx];
    if (!room.g) { room.members.splice(idx, 1); m.cashedOut = true; credit(m, m.stack, `${reason} 房间${room.code}`); }
    else { m.left = true; m.socketId = null; releaseSeat(room, idx, `${reason} 房间${room.code}`); room.g.players[idx].sitOut = true; }
    if (room.hostToken === token) { const h = room.members.find((x) => !x.bot && !x.left); room.hostToken = h ? h.token : null; }
    if (!room.members.some((x) => !x.bot && !x.left)) return closeRoom(room);
    update(room);
  }

  function kickUser(userId, reason) {
    for (const room of [...rooms.values()]) {
      const m = room.members.find((x) => x.userId === userId && !x.left);
      if (!m) continue;
      const sid = m.socketId;
      leave(room, m.token, "被移出房间，返还");
      if (sid) { const s = io.sockets.sockets.get(sid); if (s) { s.emit("kicked", reason); s.leave(room.code); s.data.code = null; } }
    }
  }

  // ---------- Socket ----------
  io.use(async (socket, next) => {
    try {
      const u = await userFromToken(socket.handshake.auth && socket.handshake.auth.token);
      if (!u) return next(new Error("NEED_LOGIN"));
      socket.data = { user: { id: u.id, username: u.username }, code: null, token: "u" + u.id };
      next();
    } catch (e) { next(new Error("SERVER")); }
  });

  io.on("connection", (socket) => {
    const uid = socket.data.user.id;
    if (!userSockets.has(uid)) userSockets.set(uid, new Set());
    userSockets.get(uid).add(socket.id);
    const roomOf = () => rooms.get(socket.data.code);
    const meIdx = (room) => room.members.findIndex((m) => m.token === socket.data.token && !m.left);
    const isHost = (room) => room.hostToken === socket.data.token;
    const fresh = async () => { const u = await store.getUser(uid); return u && !u.banned ? u : null; };
    const attach = (room, m) => { m.socketId = socket.id; m.connected = true; m.missedHands = 0; socket.data.code = room.code; socket.join(room.code); socket.leave("lobby"); };

    socket.on("create", async (data = {}, ack = () => {}) => {
      try {
        const u = await fresh(); if (!u) return ack({ ok: false, error: "账号不可用" });
        const cfg = parseCfg(data.cfg);
        if (u.balance < cfg.start) return ack({ ok: false, error: `${NO_CHIPS_MSG}（带入需要 ${E.money(cfg.start)}，你有 ${E.money(u.balance)}）`, noChips: true });
        const code = newCode();
        try { await store.adjust(uid, -cfg.start, `带入 房间${code}`); } catch { return ack({ ok: false, error: NO_CHIPS_MSG, noChips: true }); }
        pushMe(uid);
        const room = { code, cfg, members: [], g: null, hostToken: null, lastActive: Date.now(), created: Date.now(), emptySince: null };
        rooms.set(code, room);
        const m = addMember(room, { name: u.username, bot: false, userId: uid, socketId: socket.id, pid: u.publicId, av: u.avatarVer, vip: vipOf(u.turnover).level });
        room.hostToken = m.token; attach(room, m);
        ack({ ok: true, code });
        update(room);
      } catch (e) { console.error(e); ack({ ok: false, error: "服务器出错" }); }
    });

    socket.on("join", async (data = {}, ack = () => {}) => {
      try {
        const code = String(data.code || "").toUpperCase().trim();
        let room = rooms.get(code);
        if (!room) return ack({ ok: false, error: "房间不存在或已关闭" });
        let m = room.members.find((x) => x.userId === uid && !x.left);
        if (m) { // 断线重连 / 刷新：回到原座位
          attach(room, m); m.sitOutReq = false;
          ack({ ok: true, code }); return update(room);
        }
        if (activeMembers(room).length >= MAX_SEATS) return ack({ ok: false, error: "房间已满（最多 9 人）" });
        if (room.g && room.g.players.length >= MAX_SEATS && betting(room.g)) return ack({ ok: false, error: "暂时没有空位，请等这手牌结束再试" });
        const u = await fresh(); if (!u) return ack({ ok: false, error: "账号不可用" });
        if (u.balance < room.cfg.start) return ack({ ok: false, error: `${NO_CHIPS_MSG}（带入需要 ${E.money(room.cfg.start)}，你有 ${E.money(u.balance)}）`, noChips: true });
        try { await store.adjust(uid, -room.cfg.start, `带入 房间${code}`); } catch { return ack({ ok: false, error: NO_CHIPS_MSG, noChips: true }); }
        pushMe(uid);
        room = rooms.get(code);
        const refund = (msg) => { track(store.adjust(uid, room ? room.cfg.start : 0, `带入失败退回 房间${code}`).then(() => pushMe(uid))); ack({ ok: false, error: msg }); };
        if (!room) return refund("房间已关闭");
        if (room.members.find((x) => x.userId === uid && !x.left)) return refund("你已经在这个房间里");
        if (activeMembers(room).length >= MAX_SEATS) return refund("房间已满（最多 9 人）");
        m = addMember(room, { name: u.username, bot: false, userId: uid, socketId: socket.id, pid: u.publicId, av: u.avatarVer, vip: vipOf(u.turnover).level });
        if (!m) return refund("暂时没有空位，请等这手牌结束再试");
        if (!room.hostToken) room.hostToken = m.token;
        attach(room, m);
        ack({ ok: true, code });
        update(room);
      } catch (e) { console.error(e); ack({ ok: false, error: "服务器出错" }); }
    });

    socket.on("addBot", async () => {
      const room = roomOf(); if (!room || !isHost(room)) return;
      if (activeMembers(room).length >= MAX_SEATS) return socket.emit("toast", "座位已满");
      if (room.g && betting(room.g) && room.g.players.length >= MAX_SEATS) return socket.emit("toast", "请等这手牌结束");
      const used = new Set(room.members.filter((m) => !m.left).map((m) => m.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) || "电脑" + room.members.length;
      const m = addMember(room, { name, bot: true });
      if (!m) return socket.emit("toast", "暂时没有空位");
      try { await debit(m, room.cfg.start, `电脑玩家带入 房间${room.code}`); } catch (e) { console.error(e); }
      update(room);
    });

    socket.on("removeBot", (i) => {
      const room = roomOf(); if (!room || !isHost(room)) return;
      const m = room.members[i]; if (!m || !m.bot || m.left) return;
      leave(room, m.token, "电脑玩家离桌");
    });

    socket.on("start", () => {
      const room = roomOf(); if (!room || !isHost(room) || room.g) return;
      const ms = activeMembers(room);
      if (ms.length < 2) return socket.emit("toast", "至少需要 2 名玩家");
      room.members = ms;
      room.g = E.newGame(ms.map((m) => ({ name: m.name, bot: m.bot })), { ...room.cfg, rake: settings.rakePercent });
      update(room);
    });

    socket.on("action", (a = {}) => {
      const room = roomOf(); if (!room || !betting(room.g)) return;
      const i = meIdx(room); if (i < 0 || room.g.current !== i) return;
      if (!["fold", "check", "call", "raise", "allin"].includes(a.type)) return;
      const L = E.legal(room.g, i);
      if (a.type === "check" && !L.check) return;
      if (a.type === "call" && L.check) return;
      if (a.type === "raise" && !L.canRaise) return;
      if (a.type === "allin" && !L.allIn) return;
      doAction(room, a.type === "raise" ? { type: "raise", to: clampInt(a.to, L.raiseMin, L.raiseMax, L.raiseMin) } : { type: a.type });
    });

    socket.on("rebuy", async (ack = () => {}) => {
      if (typeof ack !== "function") ack = () => {};
      const room = roomOf(); if (!room || !room.g) return ack({ ok: false });
      const i = meIdx(room); if (i < 0) return ack({ ok: false });
      const p = room.g.players[i]; const m = room.members[i];
      if (p.chips > 0 || (betting(room.g) && !p.out) || m.cashedOut || m.pendingCashout) return ack({ ok: false, error: "现在不能补充筹码" });
      if (m.rebuying) return ack({ ok: false }); m.rebuying = true;
      try { await store.adjust(uid, -room.cfg.start, `补充带入 房间${room.code}`); }
      catch { m.rebuying = false; return ack({ ok: false, error: NO_CHIPS_MSG, noChips: true }); }
      m.rebuying = false;
      if (!rooms.has(room.code) || m.left) { credit(m, room.cfg.start, `补充失败退回 房间${room.code}`); return ack({ ok: false }); }
      p.chips += room.cfg.start; pushMe(uid);
      room.g.log = [...room.g.log, `${p.name} 补充筹码 ${E.money(room.cfg.start)}`].slice(-40);
      ack({ ok: true }); update(room);
    });

    socket.on("nextHand", () => { const room = roomOf(); if (room && isHost(room)) nextHand(room); });
    socket.on("sitOut", (v) => {
      const room = roomOf(); if (!room || !room.g) return; const i = meIdx(room); if (i < 0) return;
      room.members[i].sitOutReq = !!v; if (!betting(room.g)) withSitOut(room); else if (v) room.g.players[i].sitOut = true;
      update(room);
    });
    socket.on("leave", () => { const room = roomOf(); if (room) leave(room, socket.data.token); socket.data.code = null; });

    socket.on("disconnect", () => {
      userSockets.get(uid)?.delete(socket.id); if (userSockets.get(uid)?.size === 0) userSockets.delete(uid);
      const room = roomOf(); if (!room) return;
      const m = room.members.find((x) => x.socketId === socket.id);
      if (m) { m.connected = false; m.socketId = null; if (!humansOnline(room)) room.emptySince = Date.now(); update(room); }
    });

    socket.on("watchRooms", (ack) => { socket.join("lobby"); if (typeof ack === "function") ack(listRooms()); });
    socket.on("unwatchRooms", () => socket.leave("lobby"));
    socket.on("listRooms", (ack) => { if (typeof ack === "function") ack(listRooms()); });
  });

  // ---------- 管理后台 API（只有庄家） ----------
  const A = express.Router();
  A.use(adminOnly);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const aget = (p, fn) => A.get(p, wrap(fn)); const apost = (p, fn) => A.post(p, wrap(fn));
  const tableChips = () => {
    let t = 0;
    for (const r of rooms.values()) { const live = betting(r.g); r.members.forEach((m, i) => { if (!r.g) { if (!m.cashedOut) t += m.stack; return; } if (!m.cashedOut) t += r.g.players[i].chips; if (live) t += r.g.players[i].total; }); }
    return t;
  };
  aget("/stats", async (_req, res) => {
    const h = await store.getUser(houseId);
    let seated = 0, bots = 0; for (const r of rooms.values()) for (const m of activeMembers(r)) m.bot ? bots++ : seated++;
    res.json({ online: userSockets.size, sockets: io.engine.clientsCount, rooms: rooms.size, seated, bots, users: await store.countUsers(), house: h.balance, tableChips: tableChips(), settings, storage: store.kind });
  });
  aget("/users", async (req, res) => {
    const list = await store.searchUsers(String(req.query.q || ""), 100);
    const where = new Map(); for (const r of rooms.values()) for (const m of activeMembers(r)) if (m.userId) where.set(m.userId, r.code);
    res.json(list.map((u) => ({ id: u.id, publicId: u.publicId, avatarVer: u.avatarVer, username: u.username, balance: u.balance, banned: u.banned, isAdmin: u.isAdmin, createdAt: u.createdAt, lastLogin: u.lastLogin, online: userSockets.has(u.id), room: where.get(u.id) || null })));
  });
  aget("/users/:id/ledger", async (req, res) => res.json(await store.ledger(Number(req.params.id), 100)));
  apost("/users/:id/adjust", async (req, res) => {
    const id = Number(req.params.id); const delta = Math.trunc(Number(req.body?.delta));
    if (!delta || Math.abs(delta) > 1e11) return res.status(400).json({ error: "请输入有效的数量" });
    const reason = String(req.body?.reason || "").trim().slice(0, 100) || (delta > 0 ? "管理员赠送" : "管理员扣除");
    const u = await store.getUser(id); if (!u || u.isHouse) return res.status(404).json({ error: "找不到玩家" });
    try { const bal = await store.adjust(id, delta, reason, req.user.username); pushMe(id); res.json({ ok: true, balance: bal }); }
    catch (e) { if (e.message === "INSUFFICIENT") return res.status(400).json({ error: "余额不够扣" }); throw e; }
  });
  apost("/users/:id/ban", async (req, res) => {
    const id = Number(req.params.id); const banned = !!req.body?.banned;
    const u = await store.getUser(id); if (!u || u.isHouse) return res.status(404).json({ error: "找不到玩家" });
    if (u.id === req.user.id) return res.status(400).json({ error: "不能封禁自己" });
    await store.updateUser(id, { banned });
    if (banned) {
      await store.deleteUserSessions(id); kickUser(id, "你的账号已被封禁");
      for (const sid of userSockets.get(id) || []) { const s = io.sockets.sockets.get(sid); if (s) { s.emit("kicked", "你的账号已被封禁"); s.disconnect(true); } }
    }
    res.json({ ok: true, banned });
  });
  aget("/rooms", (_req, res) => {
    res.json([...rooms.values()].map((r) => ({
      code: r.code, public: r.cfg.public, status: r.g ? (betting(r.g) ? "游戏中" : "两手之间") : "等待中", handNo: r.g ? r.g.handNo : 0,
      cfg: r.cfg, created: r.created, host: (r.members.find((m) => m.token === r.hostToken) || {}).name || "",
      online: r.members.filter((m) => !m.bot && !m.left && m.connected).length,
      members: activeMembers(r).map((m) => { const i = r.members.indexOf(m); return { name: m.name, userId: m.userId, bot: m.bot, connected: m.bot || m.connected, chips: r.g ? r.g.players[i].chips : m.stack }; }),
    })));
  });
  apost("/rooms/:code/close", (req, res) => { const r = rooms.get(String(req.params.code).toUpperCase()); if (!r) return res.status(404).json({ error: "房间不存在" }); closeRoom(r, "庄家关闭了房间，筹码已返还到余额"); res.json({ ok: true }); });
  apost("/rooms/:code/kick", (req, res) => {
    const r = rooms.get(String(req.params.code).toUpperCase()); if (!r) return res.status(404).json({ error: "房间不存在" });
    const m = r.members.find((x) => x.userId === Number(req.body?.userId) && !x.left); if (!m) return res.status(404).json({ error: "该玩家不在房间里" });
    const sid = m.socketId; leave(r, m.token, "被庄家移出，返还");
    if (sid) { const s = io.sockets.sockets.get(sid); if (s) { s.emit("kicked", "你被庄家移出了房间，筹码已返还到余额"); s.leave(r.code); s.data.code = null; } }
    res.json({ ok: true });
  });
  aget("/mahjong", async (_req, res) => {
    const t = await store.slotTotals(MJ);
    res.json({ name: MJ_NAME, totals: { ...t, profit: t.bets - t.wins, rtp: t.bets ? t.wins / t.bets : null }, recent: await store.slotHistory(null, MJ, 30), top: await store.slotTopPlayers(MJ, 10) });
  });
  apost("/settings", async (req, res) => {
    const b = req.body || {};
    if (b.rakePercent !== undefined) { const v = Number(b.rakePercent); if (!(v >= 0 && v <= 10)) return res.status(400).json({ error: "抽水比例需在 0–10% 之间" }); settings.rakePercent = Math.round(v * 10) / 10; }
    await store.setSetting("rakePercent", settings.rakePercent);
    res.json({ ok: true, settings });
  });
  // ---------- 平台：邀请好友 / 跑马灯 / 公告 ----------
  // 被邀请人第一次完成任意一局游戏时，双方各得固定奖励；每位邀请人最多奖励 20 位。没有提成、没有多级。
  async function onPlayed(uid) {
    const r = await store.firstPlay(uid);
    if (!r || !r.invitedBy || r.inviteStatus !== "pending" || !rewards.invite.enabled || !(rewards.invite.amount > 0)) return;
    const st = await store.inviteReward(uid, rewards.invite.amount, rewards.invite.cap);
    if (st === "rewarded") { pushMe(uid); pushMe(r.invitedBy); }
  }
  app.get("/api/me/invite", auth, async (req, res, next) => {
    try {
      const list = await store.inviteList(req.user.id); const ok = list.filter((x) => x.status === "rewarded").length;
      res.json({ code: req.user.publicId, rewarded: ok, total: list.length, ...rewards.invite, ...inviteTitle(ok),
        list: list.map((x) => ({ name: mask(x.username), status: x.status, at: x.at })) });
    } catch (e) { next(e); }
  });
  let marqueeCache = { at: 0, data: [] };
  const GAME_NAME = { ...GAMES, mahjong: MJ_NAME, poker: "时烽德州" };
  app.get("/api/marquee", async (_req, res, next) => {
    try {
      if (Date.now() - marqueeCache.at > 10000) marqueeCache = { at: Date.now(), data: (await store.recentBigWins(20)).map((x) => ({ name: mask(x.username), game: GAME_NAME[x.game] || x.game, win: x.win, x: x.bet > 0 ? Math.floor(x.win / x.bet) : 0, at: x.at })) };
      res.json(marqueeCache.data);
    } catch (e) { next(e); }
  });
  app.get("/api/announcements", (_req, res) => res.json(announcements));
  app.get("/api/vip", (_req, res) => res.json(VIP));
  aget("/announcements", (_req, res) => res.json(announcements));
  apost("/announcements", async (req, res) => {
    const list = Array.isArray(req.body?.list) ? req.body.list : null; if (!list || list.length > 20) return res.status(400).json({ error: "公告格式不正确（最多 20 条）" });
    announcements = list.map((a, i) => ({ id: String(a.id || Date.now() + "-" + i).slice(0, 40), title: String(a.title || "").trim().slice(0, 40), body: String(a.body || "").trim().slice(0, 500), pinned: !!a.pinned, at: Number(a.at) || Date.now() })).filter((a) => a.title || a.body);
    await store.setSetting("announcements", announcements); marqueeCache.at = 0; res.json({ ok: true, list: announcements });
  });
  aget("/rewards", async (_req, res) => res.json({ settings: rewards, totals: await store.rewardTotals(), invites: await store.inviteStats() }));
  apost("/rewards", async (req, res) => {
    const iv = req.body?.invite || {};
    if (iv.amount !== undefined) { const a = Math.trunc(Number(iv.amount)); if (!(a >= 0 && a <= 100000)) return res.status(400).json({ error: "奖励金额需在 0–1,000.00 之间" }); rewards.invite.amount = a; }
    if (iv.cap !== undefined) { const c = Math.trunc(Number(iv.cap)); if (!(c >= 0 && c <= 100)) return res.status(400).json({ error: "上限需在 0–100 之间" }); rewards.invite.cap = c; }
    if (iv.enabled !== undefined) rewards.invite.enabled = !!iv.enabled;
    await store.setSetting("rewards", rewards); res.json({ ok: true, settings: rewards });
  });
  mountTables({ app, aget, apost, store, auth, houseId, pushMe, money: E.money, NO_CHIPS_MSG, onPlayed: (uid) => track(onPlayed(uid)), rng: opts.tableRng ?? Slot.cryptoRng(),
    getLimits: () => limits, setLimits: async (g, v) => { limits[g] = v; await store.setSetting("gameLimits", limits); } });
  app.use("/api/admin", A);
  app.use((err, _req, res, _next) => {
    if (err && err.status === 413) return res.status(413).json({ error: "图片太大，请换一张小一点的" });
    if (err && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: "请求格式不正确" });
    console.error(err); res.status(500).json({ error: "服务器出错" });
  });

  // ---------- 清理与关机 ----------
  function sweep() {
    for (const room of [...rooms.values()]) {
      if (humansOnline(room)) { room.emptySince = null; continue; }
      if (!room.emptySince) room.emptySince = Date.now();
      if (Date.now() - room.emptySince >= emptyRoomMs) closeRoom(room, "房间长时间无人，已关闭");
    }
  }
  const sweeper = setInterval(sweep, sweepMs); sweeper.unref();

  // 部署/重启前把桌上的筹码全部返还到余额
  async function shutdown({ closeStore = true } = {}) {
    clearInterval(sweeper);
    for (const room of [...rooms.values()]) closeRoom(room, "服务器维护，筹码已返还到余额");
    await idle();
    io.close(); if (closeStore) await store.close();
  }

  return { app, server, io, rooms, listRooms, sweep, store, idle, shutdown, houseId, getSettings: () => settings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const PORT = process.env.PORT || 3000;
  const ctx = await createApp({
    databaseUrl: process.env.DATABASE_URL, dataFile: process.env.DATA_FILE || path.join(__dirname, "data", "db.json"),
    adminUsername: process.env.ADMIN_USERNAME, adminPassword: process.env.ADMIN_PASSWORD,
  });
  ctx.server.listen(PORT, () => console.log(`时烽德州服务器已启动：http://localhost:${PORT}（存储：${ctx.store.kind}）`));
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => {
    if (stopping) return; stopping = true;
    console.log("正在关闭，返还桌上筹码…");
    try { await ctx.shutdown(); } finally { process.exit(0); }
  });
}
