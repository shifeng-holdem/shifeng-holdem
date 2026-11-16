// 多人在线德州扑克服务器（服务端权威；只用游戏筹码，不涉及真钱）
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_SEATS = 9;
const BOT_NAMES = ["电脑·阿杰", "电脑·小美", "电脑·老王", "电脑·Lisa", "电脑·大卫", "电脑·阿芳", "电脑·Tom", "电脑·小林", "电脑·阿强"];

export function createApp(opts = {}) {
  const botDelay = opts.botDelay ?? [700, 1400];
  const nextHandDelay = opts.nextHandDelay ?? 8000;
  const autoActDelay = opts.autoActDelay ?? 1500; // 掉线/离座玩家自动操作
  const turnMs = (room) => opts.turnMs ?? room.cfg.timer * 1000; // 测试时可缩短
  const app = express();
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));
  const server = createServer(app);
  const io = new Server(server, { cors: { origin: "*" } });
  const rooms = new Map();

  const newCode = () => {
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let c; do { c = Array.from({ length: 5 }, () => A[Math.floor(Math.random() * A.length)]).join(""); } while (rooms.has(c));
    return c;
  };
  const newToken = () => randomBytes(16).toString("hex");
  const clampInt = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const cleanName = (s) => String(s || "").replace(/[<>]/g, "").trim().slice(0, 12) || "玩家";
  const activeMembers = (room) => room.members.filter((m) => !m.left);
  const betting = (g) => g && ["preflop", "flop", "turn", "river"].includes(g.stage);

  function parseCfg(c = {}) {
    const start = clampInt(c.start, 100, 1000000, 1000);
    const bb = clampInt(c.bb, 2, Math.floor(start / 5), Math.min(20, Math.floor(start / 5)));
    const sb = clampInt(c.sb, 1, bb, Math.max(1, Math.floor(bb / 2)));
    const timer = clampInt(c.timer, 10, 120, 30);
    return { start, sb, bb, timer };
  }

  function viewFor(room, token) {
    const you = room.members.findIndex((m) => m.token === token && !m.left);
    const g = room.g;
    const reveal = g && g.showdown && (g.stage === "handover" || g.stage === "gameover");
    const game = g && {
      stage: g.stage, board: g.board, dealer: g.dealer, sb: g.sb, bb: g.bb, current: g.current,
      currentBet: g.currentBet, minRaise: g.minRaise, pot: E.pot(g), handNo: g.handNo, showdown: g.showdown,
      winners: g.winners, log: g.log.slice(-30), sbAmt: g.sbAmt, bbAmt: g.bbAmt,
      players: g.players.map((p, i) => {
        const m = room.members[i];
        const show = i === you || (reveal && !p.folded && !p.out);
        return {
          name: p.name, bot: p.bot, chips: p.chips, bet: p.bet, total: p.total, folded: p.folded, allIn: p.allIn,
          out: p.out, sitOut: p.sitOut, last: p.last, won: p.won, handName: show ? p.handName : "",
          hole: show ? p.hole : [], cards: p.hole.length, connected: !!(m && (m.bot || m.connected)), left: !!(m && m.left),
        };
      }),
      legal: you >= 0 && betting(g) && g.current === you ? E.legal(g, you) : null,
      toCall: you >= 0 && betting(g) ? E.toCall(g, you) : 0,
      myHand: you >= 0 && g.players[you].hole.length === 2 && g.board.length >= 3 ? E.scoreName(E.best7([...g.players[you].hole, ...g.board])) : "",
    };
    return {
      code: room.code, you, isHost: room.hostToken === token, cfg: room.cfg, started: !!g,
      members: room.members.map((m, i) => ({ i, name: m.name, bot: m.bot, connected: m.bot || m.connected, left: m.left, host: m.token === room.hostToken })).filter((m) => !m.left),
      game, deadline: room.deadline, nextAt: room.nextAt, now: Date.now(),
    };
  }

  function broadcast(room) {
    for (const m of room.members) if (m.socketId && !m.left) io.to(m.socketId).emit("state", viewFor(room, m.token));
    for (const sid of room.spectators) { const s = io.sockets.sockets.get(sid); if (s) s.emit("state", viewFor(room, s.data.token)); }
  }

  function clearTimers(room) { clearTimeout(room.turnTimer); clearTimeout(room.nextTimer); room.deadline = null; room.nextAt = null; }

  function doAction(room, action, note) {
    const g = room.g; if (!betting(g)) return;
    if (note) g.log = [...g.log, `${g.players[g.current].name} ${note}`].slice(-40);
    room.g = E.act(g, action);
    update(room);
  }

  function schedule(room) {
    clearTimers(room);
    const g = room.g; if (!g) return;
    const anyHuman = room.members.some((m) => !m.bot && !m.left && m.connected);
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
    } else if (g.stage === "handover" && !E.canStart(g)) {
      g.stage = "gameover";
    } else if (g.stage === "handover" && anyHuman) {
      room.nextAt = Date.now() + nextHandDelay;
      room.nextTimer = setTimeout(() => nextHand(room), nextHandDelay);
    }
  }

  function update(room) { room.lastActive = Date.now(); schedule(room); broadcast(room); }

  function nextHand(room) {
    if (!room.g || room.g.stage !== "handover") return;
    room.g.players.forEach((p, i) => { const m = room.members[i]; p.sitOut = !!(m.left || (!m.bot && !m.connected && m.missedHands >= 2)); });
    if (!E.canStart(room.g)) { room.g.stage = "gameover"; update(room); return; }
    room.g = E.startHand(room.g);
    room.members.forEach((m) => { if (!m.bot && !m.connected) m.missedHands = (m.missedHands || 0) + 1; });
    update(room);
  }

  function addMember(room, name, bot, socketId) {
    const m = { token: bot ? "bot-" + newToken() : newToken(), name, bot, socketId, connected: !bot, left: false, missedHands: 0 };
    const g = room.g;
    if (!g) { room.members.push(m); return m; }
    // 游戏中加入：优先复用已离开的空位（该位不在本手牌中）
    let idx = room.members.findIndex((x, i) => x.left && (g.players[i].folded || g.players[i].out || !betting(g)));
    if (idx === -1) { if (g.players.length >= MAX_SEATS) return null; E.addPlayer(g, name, bot); room.members.push(m); return m; }
    room.members[idx] = m;
    g.players[idx] = E.mkPlayer(idx, name, bot, g.startChips);
    return m;
  }

  function leave(room, token) {
    const idx = room.members.findIndex((m) => m.token === token && !m.left);
    if (idx < 0) return;
    if (!room.g) room.members.splice(idx, 1);
    else { room.members[idx].left = true; room.members[idx].socketId = null; room.g.players[idx].sitOut = true; }
    if (room.hostToken === token) { const h = room.members.find((m) => !m.bot && !m.left); room.hostToken = h ? h.token : null; }
    if (!room.members.some((m) => !m.bot && !m.left)) { clearTimers(room); rooms.delete(room.code); return; }
    update(room);
  }

  io.on("connection", (socket) => {
    const roomOf = () => rooms.get(socket.data.code);
    const meIdx = (room) => room.members.findIndex((m) => m.token === socket.data.token && !m.left);
    const isHost = (room) => room.hostToken === socket.data.token;

    socket.on("create", (data = {}, ack = () => {}) => {
      const code = newCode();
      const room = { code, cfg: parseCfg(data.cfg), members: [], g: null, hostToken: null, spectators: new Set(), lastActive: Date.now() };
      rooms.set(code, room);
      const m = addMember(room, cleanName(data.name), false, socket.id);
      room.hostToken = m.token;
      socket.data = { code, token: m.token }; socket.join(code);
      ack({ ok: true, code, token: m.token });
      update(room);
    });

    socket.on("join", (data = {}, ack = () => {}) => {
      const code = String(data.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return ack({ ok: false, error: "房间不存在或已关闭" });
      let m = data.token && room.members.find((x) => x.token === data.token && !x.left && !x.bot);
      if (m) { // 断线重连回原座位
        m.socketId = socket.id; m.connected = true; m.missedHands = 0;
        const i = room.members.indexOf(m); if (room.g && room.g.players[i].sitOut) room.g.players[i].sitOut = false;
      } else {
        if (data.spectate) { socket.data = { code, token: null }; room.spectators.add(socket.id); ack({ ok: true, code, token: null }); return broadcast(room); }
        if (activeMembers(room).length >= MAX_SEATS) return ack({ ok: false, error: "房间已满（最多 9 人）" });
        m = addMember(room, cleanName(data.name), false, socket.id);
        if (!m) return ack({ ok: false, error: "暂时没有空位，请等这手牌结束再试" });
        if (!room.hostToken) room.hostToken = m.token;
      }
      socket.data = { code, token: m.token }; socket.join(code);
      ack({ ok: true, code, token: m.token });
      update(room);
    });

    socket.on("addBot", () => {
      const room = roomOf(); if (!room || !isHost(room)) return;
      if (activeMembers(room).length >= MAX_SEATS) return socket.emit("toast", "座位已满");
      const used = new Set(room.members.map((m) => m.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) || "电脑" + room.members.length;
      if (!addMember(room, name, true, null)) return socket.emit("toast", "暂时没有空位");
      update(room);
    });

    socket.on("removeBot", (i) => {
      const room = roomOf(); if (!room || !isHost(room)) return;
      const m = room.members[i]; if (!m || !m.bot) return;
      leave(room, m.token);
    });

    socket.on("updateCfg", (cfg) => {
      const room = roomOf(); if (!room || !isHost(room) || room.g) return;
      room.cfg = parseCfg(cfg); update(room);
    });

    socket.on("start", () => {
      const room = roomOf(); if (!room || !isHost(room) || room.g) return;
      const ms = activeMembers(room);
      if (ms.length < 2) return socket.emit("toast", "至少需要 2 名玩家");
      room.members = ms;
      room.g = E.newGame(ms.map((m) => ({ name: m.name, bot: m.bot })), room.cfg);
      update(room);
    });

    socket.on("action", (a = {}) => {
      const room = roomOf(); if (!room || !betting(room.g)) return;
      const i = meIdx(room); if (i < 0 || room.g.current !== i) return;
      const types = ["fold", "check", "call", "raise", "allin"];
      if (!types.includes(a.type)) return;
      const L = E.legal(room.g, i);
      if (a.type === "check" && !L.check) return;
      if (a.type === "call" && L.check) return;
      if (a.type === "raise" && !L.canRaise) return;
      if (a.type === "allin" && !L.allIn) return;
      doAction(room, a.type === "raise" ? { type: "raise", to: clampInt(a.to, L.raiseMin, L.raiseMax, L.raiseMin) } : { type: a.type });
    });

    socket.on("nextHand", () => { const room = roomOf(); if (room && isHost(room)) nextHand(room); });

    socket.on("restart", () => {
      const room = roomOf(); if (!room || !isHost(room) || !room.g || room.g.stage !== "gameover") return;
      room.members = activeMembers(room);
      if (room.members.length < 2) return socket.emit("toast", "至少需要 2 名玩家");
      room.g = E.newGame(room.members.map((m) => ({ name: m.name, bot: m.bot })), room.cfg);
      update(room);
    });

    socket.on("sitOut", (v) => {
      const room = roomOf(); if (!room || !room.g) return; const i = meIdx(room); if (i < 0) return;
      room.g.players[i].sitOut = !!v; update(room);
    });

    socket.on("leave", () => { const room = roomOf(); if (room) leave(room, socket.data.token); socket.data = {}; });

    socket.on("disconnect", () => {
      const room = roomOf(); if (!room) return;
      room.spectators.delete(socket.id);
      const m = room.members.find((x) => x.socketId === socket.id);
      if (m) { m.connected = false; m.socketId = null; update(room); }
    });
  });

  // 清理长时间无人的房间
  const sweeper = setInterval(() => {
    for (const [code, room] of rooms) {
      const anyone = room.members.some((m) => !m.bot && m.connected);
      if (!anyone && Date.now() - room.lastActive > 60 * 60 * 1000) { clearTimers(room); rooms.delete(code); }
    }
  }, 5 * 60 * 1000);
  sweeper.unref();

  return { app, server, io, rooms };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const PORT = process.env.PORT || 3000;
  const { server } = createApp();
  server.listen(PORT, () => console.log(`时烽德州服务器已启动：http://localhost:${PORT}`));
}
