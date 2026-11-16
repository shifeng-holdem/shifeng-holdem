import test from "node:test";
import assert from "node:assert/strict";
import { boot, player, client, ack, until, wait, economy } from "../testlib/helpers.js";

test("4 个真人账号 + 1 个电脑玩家，完整打多手牌", async () => {
  const ctx = await boot();
  try {
    const host = await player(ctx, "房主");
    const clients = [host];
    for (const n of ["小红", "小明", "小刚"]) clients.push(await player(ctx, n));
    const eco0 = await economy(ctx);
    const r = await ack(host, "create", { cfg: { start: 1000, sb: 10, bb: 20, timer: 30 } });
    assert.ok(r.ok && /^[A-Z0-9]{5}$/.test(r.code), JSON.stringify(r));
    for (const c of clients.slice(1)) { const j = await ack(c, "join", { code: r.code.toLowerCase() }); assert.ok(j.ok, j.error); }
    host.emit("addBot");
    await until(() => host.last && host.last.members.length === 5);
    const eco1 = await economy(ctx);
    host.emit("start");
    await until(() => clients.every((c) => c.last && c.last.started));

    let violations = 0, actions = 0;
    for (const c of clients) {
      c.on("state", (v) => {
        const g = v.game; if (!g) return;
        const reveal = g.showdown && (g.stage === "handover" || g.stage === "gameover");
        g.players.forEach((p, i) => { if (i !== v.you && !reveal && p.hole.length) violations++; });
        if (g.legal) {
          const L = g.legal; const x = Math.random(); let a;
          if (x < 0.05 && L.allIn) a = { type: "allin" };
          else if (x < 0.2 && L.canRaise) a = { type: "raise", to: L.raiseMin + Math.floor(Math.random() * (L.raiseMax - L.raiseMin) * 0.2) };
          else if (x < 0.3) a = { type: "fold" };
          else a = L.check ? { type: "check" } : { type: "call" };
          actions++; setTimeout(() => c.emit("action", a), 2);
        }
      });
    }
    for (const c of clients) if (c.last.game.legal) c.emit("action", c.last.game.legal.check ? { type: "check" } : { type: "call" });

    let hands = 0;
    while (hands < 8) {
      await until(() => ["handover", "gameover"].includes(host.last.game.stage), 30000, "一手牌没有结束");
      const g = host.last.game;
      assert.equal(g.players.reduce((s, p) => s + p.chips, 0), 5000, "桌上筹码守恒");
      hands++;
      if (g.stage === "gameover") break;
      const no = g.handNo; host.emit("nextHand");
      await until(() => host.last.game.handNo === no + 1);
    }
    assert.equal(violations, 0, "未摊牌时泄露了别人的底牌");
    assert.ok(actions > 10);
    assert.equal(await economy(ctx), eco1);
    assert.equal(eco0, eco1, "带入不会凭空产生筹码");
    console.log(`  打完 ${hands} 手牌，客户端共行动 ${actions} 次`);

    // 断线重连：同一账号重新连接，回到原座位
    const old = clients[2]; const seat = old.last.you; old.disconnect();
    await until(() => host.last.members.some((m) => !m.connected && !m.bot));
    const back = client(ctx, old.token);
    const j = await ack(back, "join", { code: host.last.code });
    assert.ok(j.ok); await until(() => back.last);
    assert.equal(back.last.you, seat, "重连回到原座位");
    assert.equal(back.last.game.players[seat].name, "小明");
  } finally { await ctx.close(); }
});

test("超时自动过牌/弃牌；房间满 9 人拒绝加入；未登录不能连接", async () => {
  const ctx = await boot({ turnMs: 300 });
  try {
    const a = await player(ctx, "玩家A"), b = await player(ctx, "玩家B");
    const r = await ack(a, "create", {});
    await ack(b, "join", { code: r.code });
    for (let i = 0; i < 7; i++) a.emit("addBot");
    await until(() => a.last && a.last.members.length === 9);
    const c = await player(ctx, "玩家C");
    const full = await ack(c, "join", { code: r.code });
    assert.equal(full.ok, false);
    a.emit("start");
    await until(() => a.last.game && a.last.game.log.some((l) => l.includes("超时")), 15000, "没有触发超时");
    await until(() => ["handover", "gameover"].includes(a.last.game.stage), 15000);
    assert.equal(a.last.game.players.reduce((s, p) => s + p.chips, 0), 9000);

    const guest = client(ctx, undefined);
    const err = await new Promise((res) => guest.on("connect_error", (e) => res(e.message)));
    assert.equal(err, "NEED_LOGIN");
  } finally { await ctx.close(); }
});
