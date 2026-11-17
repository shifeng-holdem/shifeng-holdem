import { io as ioc } from "socket.io-client";
import { createApp } from "../server.js";

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 8000, msg = "超时") { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error(msg); await wait(15); } }

export async function boot(opts = {}) {
  const ctx = await createApp({
    // 设置 TEST_DATABASE_URL 时用真实 Postgres（每次一个独立 schema），否则用内存存储
    ...(process.env.TEST_DATABASE_URL ? { databaseUrl: process.env.TEST_DATABASE_URL, schema: "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) } : { memory: true }),
    quiet: true, bcryptRounds: 4, botDelay: [5, 15], nextHandDelay: 60000, autoActDelay: 20, listDebounceMs: 10,
    adminUsername: "boss", adminPassword: "boss-secret", autoBots: false, ...opts,
  });
  await new Promise((r) => ctx.server.listen(0, r));
  ctx.url = "http://localhost:" + ctx.server.address().port;
  ctx.sockets = [];
  ctx.close = async () => { ctx.sockets.forEach((s) => s.disconnect()); ctx.io.close(); ctx.server.close(); };
  return ctx;
}

export async function api(ctx, method, path, body, token) {
  const r = await fetch(ctx.url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body && method !== "GET" ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
export async function register(ctx, username, password = "secret123") {
  const r = await api(ctx, "POST", "/api/register", { username, password });
  if (r.status !== 200) throw new Error("注册失败 " + JSON.stringify(r.data));
  return r.data; // { token, user }
}
export async function login(ctx, username, password) { return api(ctx, "POST", "/api/login", { username, password }); }
export const adminToken = async (ctx) => (await login(ctx, "boss", "boss-secret")).data.token;

export function client(ctx, token) {
  const s = ioc(ctx.url, { transports: ["websocket"], forceNew: true, reconnection: false, auth: { token } });
  s.last = null; s.me = null;
  s.on("state", (v) => (s.last = v)); s.on("me", (m) => (s.me = m)); s.on("kicked", (r) => (s.kicked = r));
  ctx.sockets.push(s);
  return s;
}
export const ack = (s, ev, data) => new Promise((r) => (data === undefined ? s.emit(ev, r) : s.emit(ev, data, r)));
// 注册一个玩家；注册本身是 0 筹码，这里模拟管理员赠送 chips 个游戏币（默认 10000）
export async function player(ctx, name, chips = 10000) {
  const r = await register(ctx, name);
  if (chips) { r.user.balance = await ctx.store.adjust(r.user.id, chips, "管理员赠送", "test"); }
  const s = client(ctx, r.token); s.token = r.token; s.user = r.user; return s;
}

// 整个经济体的筹码总量 = 所有账户余额（含庄家）+ 牌桌上的筹码
export async function economy(ctx) {
  await ctx.idle();
  const users = await ctx.store.searchUsers("", 100000);
  const house = await ctx.store.getUser(ctx.houseId);
  let table = 0;
  for (const r of ctx.rooms.values()) {
    const live = r.g && ["preflop", "flop", "turn", "river"].includes(r.g.stage);
    r.members.forEach((m, i) => {
      const p = r.g && r.g.players[i];
      if (!r.g) { if (!m.cashedOut) table += m.stack; return; }
      if (!m.cashedOut) table += p.chips;
      if (live) table += p.total;
    });
  }
  return users.reduce((s, u) => s + u.balance, 0) + house.balance + table;
}
export const balanceOf = async (ctx, s) => (await ctx.store.getUser(s.user.id)).balance;
