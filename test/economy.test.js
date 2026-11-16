import test from "node:test";
import assert from "node:assert/strict";
import { boot, player, ack, until, wait, economy, balanceOf } from "../testlib/helpers.js";

test("带入扣余额、离桌返还，总筹码守恒", async () => {
  const ctx = await boot();
  try {
    const a = await player(ctx, "甲方"), b = await player(ctx, "乙方"), c = await player(ctx, "丙方");
    const eco = await economy(ctx);
    const r = await ack(a, "create", { cfg: { start: 3000, sb: 25, bb: 50 } });
    assert.ok(r.ok);
    assert.equal(await balanceOf(ctx, a), 7000);
    assert.ok((await ack(b, "join", { code: r.code })).ok);
    assert.ok((await ack(c, "join", { code: r.code })).ok);
    a.emit("addBot");
    await until(() => a.last && a.last.members.length === 4);
    assert.equal(await economy(ctx), eco);
    a.emit("start");
    await until(() => a.last.game && b.last.game && c.last.game);
    // 大家都跟注/过牌，打几手
    for (const s of [a, b, c]) s.on("state", (v) => { const L = v.game && v.game.legal; if (L) setTimeout(() => s.emit("action", L.check ? { type: "check" } : { type: "call" }), 1); });
    for (const s of [a, b, c]) { const L = s.last.game && s.last.game.legal; if (L) s.emit("action", L.check ? { type: "check" } : { type: "call" }); }
    for (let h = 0; h < 3; h++) {
      await until(() => ["handover", "gameover"].includes(a.last.game.stage), 20000);
      assert.equal(await economy(ctx), eco, `第 ${h + 1} 手后守恒`);
      const no = a.last.game.handNo; a.emit("nextHand"); await until(() => a.last.game.handNo === no + 1 || a.last.game.stage === "gameover");
    }
    // 一手牌进行中离桌：先自动弃牌，这手结束后才返还
    b.emit("leave");
    await until(() => ["handover", "gameover"].includes(a.last.game.stage), 20000);
    await ctx.idle();
    assert.equal(await economy(ctx), eco, "离桌后守恒");
    const bChips = await balanceOf(ctx, b);
    assert.ok(bChips >= 7000 && bChips <= 7000 + 12000, "乙拿回了桌上剩余筹码 " + bChips);
    // 关闭房间：所有人筹码都回到余额
    c.emit("leave"); a.emit("leave");
    await until(() => ctx.rooms.size === 0);
    await ctx.idle();
    assert.equal(await economy(ctx), eco);
    const total = (await balanceOf(ctx, a)) + (await balanceOf(ctx, b)) + (await balanceOf(ctx, c)) + (await ctx.store.getUser(ctx.houseId)).balance;
    assert.equal(total, 30000, "三个账户 + 庄家（为电脑玩家出资）合计不变");
  } finally { await ctx.close(); }
});

test("余额不足不能带入；输光后可以从余额补充筹码", async () => {
  const ctx = await boot();
  try {
    const a = await player(ctx, "穷玩家");
    const big = await ack(a, "create", { cfg: { start: 20000 } });
    assert.equal(big.ok, false); assert.match(big.error, /余额不足/);
    assert.equal(await balanceOf(ctx, a), 10000);
    const b = await player(ctx, "对手");
    const eco = await economy(ctx);
    const r = await ack(a, "create", { cfg: { start: 1000, sb: 10, bb: 20 } });
    await ack(b, "join", { code: r.code });
    a.emit("start");
    await until(() => a.last && a.last.game);
    // 乙全下、甲跟注，直到有人输光
    const play = (s) => s.on("state", (v) => { const L = v.game && v.game.legal; if (L) setTimeout(() => s.emit("action", L.allIn ? { type: "allin" } : L.check ? { type: "check" } : { type: "call" }), 1); });
    play(a); play(b);
    for (const s of [a, b]) { const L = s.last.game.legal; if (L) s.emit("action", L.allIn ? { type: "allin" } : { type: "call" }); }
    await until(() => ["handover", "gameover"].includes(a.last.game.stage), 20000);
    if (a.last.game.stage !== "gameover") { const no = a.last.game.handNo; a.emit("nextHand"); await until(() => a.last.game.handNo > no || a.last.game.stage === "gameover"); await until(() => ["handover", "gameover"].includes(a.last.game.stage), 20000); }
    await until(() => a.last.game.stage === "gameover", 20000, "应该有人输光");
    const loser = a.last.game.players[a.last.you].chips === 0 ? a : b;
    const before = await balanceOf(ctx, loser);
    assert.equal(loser.last.game.canRebuy, true);
    const rb = await ack(loser, "rebuy");
    assert.ok(rb.ok, JSON.stringify(rb));
    assert.equal(await balanceOf(ctx, loser), before - 1000);
    await until(() => loser.last.game.players[loser.last.you].chips === 1000);
    assert.notEqual(loser.last.game.stage, "gameover", "补充后可以继续");
    assert.equal(await economy(ctx), eco);
  } finally { await ctx.close(); }
});

test("一手牌进行中关闭房间：这手作废，所有下注退回", async () => {
  const ctx = await boot();
  try {
    const a = await player(ctx, "甲方"), b = await player(ctx, "乙方");
    const eco = await economy(ctx);
    const r = await ack(a, "create", {}); await ack(b, "join", { code: r.code });
    a.emit("start"); await until(() => a.last && a.last.game);
    const turn = a.last.game.legal ? a : b;
    turn.emit("action", { type: "raise", to: 200 });
    await until(() => a.last.game.pot === 220);
    await ctx.shutdown({ closeStore: false }); // 部署/重启时也走这条路
    assert.equal(await balanceOf(ctx, a), 10000); assert.equal(await balanceOf(ctx, b), 10000);
    assert.equal(await economy(ctx), eco);
  } finally { ctx.server.close(); }
});
