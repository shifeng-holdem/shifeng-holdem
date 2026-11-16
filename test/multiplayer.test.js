import test from "node:test";
import assert from "node:assert/strict";
import { io as ioc } from "socket.io-client";
import { createApp } from "../server.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(url) {
  const s = ioc(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  s.last = null; s.on("state", (v) => { s.last = v; });
  return s;
}
const emitAck = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
async function until(fn, ms = 20000, msg = "超时") { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error(msg); await wait(20); } }

async function boot(opts) {
  const ctx = createApp({ botDelay: [5, 15], nextHandDelay: 60000, autoActDelay: 20, ...opts });
  await new Promise((r) => ctx.server.listen(0, r));
  ctx.url = "http://localhost:" + ctx.server.address().port;
  return ctx;
}

test("4 个真人客户端 + 1 个电脑玩家，完整打多手牌", async () => {
  const ctx = await boot();
  const clients = [];
  try {
    const host = client(ctx.url); clients.push(host);
    const r = await emitAck(host, "create", { name: "房主", cfg: { start: 1000, sb: 10, bb: 20, timer: 30 } });
    assert.ok(r.ok && /^[A-Z0-9]{5}$/.test(r.code));
    for (const n of ["小红", "小明", "小刚"]) { const c = client(ctx.url); clients.push(c); const j = await emitAck(c, "join", { code: r.code.toLowerCase(), name: n }); assert.ok(j.ok, j.error); c.token = j.token; }
    host.emit("addBot");
    await until(() => host.last && host.last.members.length === 5);
    host.emit("start");
    await until(() => clients.every((c) => c.last && c.last.started));

    let violations = 0, actions = 0, handsSeen = new Set();
    const total = 5000;
    for (const c of clients) {
      c.on("state", (v) => {
        const g = v.game; if (!g) return;
        // 隐私：未摊牌时看不到别人的底牌
        const reveal = g.showdown && (g.stage === "handover" || g.stage === "gameover");
        g.players.forEach((p, i) => { if (i !== v.you && !reveal && p.hole.length) violations++; });
        if (g.legal) {
          const L = g.legal; const r = Math.random(); let a;
          if (r < 0.05 && L.allIn) a = { type: "allin" };
          else if (r < 0.2 && L.canRaise) a = { type: "raise", to: L.raiseMin + Math.floor(Math.random() * (L.raiseMax - L.raiseMin) * 0.2) };
          else if (r < 0.3) a = { type: "fold" };
          else a = L.check ? { type: "check" } : { type: "call" };
          actions++;
          setTimeout(() => c.emit("action", a), 2);
        }
      });
    }
    // 触发第一次行动（state 已到达过一次）
    for (const c of clients) if (c.last.game.legal) c.emit("action", c.last.game.legal.check ? { type: "check" } : { type: "call" });

    let hands = 0;
    while (hands < 8) {
      await until(() => ["handover", "gameover"].includes(host.last.game.stage), 30000, "一手牌没有结束");
      const g = host.last.game;
      handsSeen.add(g.handNo);
      assert.equal(g.players.reduce((s, p) => s + p.chips, 0), total, "筹码守恒");
      assert.ok(g.winners.length >= 1);
      hands++;
      if (g.stage === "gameover") break;
      const no = g.handNo;
      host.emit("nextHand");
      await until(() => host.last.game.handNo === no + 1);
    }
    assert.equal(violations, 0, "未摊牌时泄露了别人的底牌");
    assert.ok(actions > 10);
    console.log(`  打完 ${hands} 手牌，客户端共行动 ${actions} 次`);

    // 断线重连：同一 token 回到原座位
    const old = clients[2]; const seat = old.last.you; old.disconnect();
    await until(() => host.last.members.some((m) => !m.connected && !m.bot));
    const back = client(ctx.url); clients.push(back);
    const j = await emitAck(back, "join", { code: host.last.code, name: "随便", token: old.token });
    assert.ok(j.ok); await until(() => back.last);
    assert.equal(back.last.you, seat, "重连回到原座位");
    assert.equal(back.last.game.players[seat].name, "小明");
  } finally {
    clients.forEach((c) => c.disconnect()); ctx.io.close(); ctx.server.close();
  }
});

test("超时自动过牌/弃牌；房间满 9 人拒绝加入", async () => {
  const ctx = await boot({ turnMs: 300 });
  const cs = [];
  try {
    const a = client(ctx.url), b = client(ctx.url); cs.push(a, b);
    const r = await emitAck(a, "create", { name: "A" });
    await emitAck(b, "join", { code: r.code, name: "B" });
    for (let i = 0; i < 7; i++) a.emit("addBot");
    await until(() => a.last && a.last.members.length === 9);
    const c = client(ctx.url); cs.push(c);
    const full = await emitAck(c, "join", { code: r.code, name: "C" });
    assert.equal(full.ok, false);
    a.emit("start");
    // 两个真人都不操作，等待超时
    await until(() => a.last.game && a.last.game.log.some((l) => l.includes("超时")), 15000, "没有触发超时");
    await until(() => ["handover", "gameover"].includes(a.last.game.stage), 15000);
    assert.equal(a.last.game.players.reduce((s, p) => s + p.chips, 0), 9000);
    assert.equal(a.last.game.players.length, 9);
  } finally { cs.forEach((c) => c.disconnect()); ctx.io.close(); ctx.server.close(); }
});
