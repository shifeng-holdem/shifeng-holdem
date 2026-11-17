// 补位玩家：玩家不能添加；真人优先匹配，等够时间才补位；公平（只看自己的牌和公共信息）；筹码不经过玩家余额
import test from "node:test";
import assert from "node:assert/strict";
import * as E from "../engine.js";
import * as BOTS from "../bots.js";
import { boot, api, player, ack, until, wait, economy, adminToken, balanceOf } from "../testlib/helpers.js";

test("补位玩家只看得到自己的手牌和公共信息；策略合理且有随机性", () => {
  let g = E.newGame(["甲", "乙", "丙"].map((name) => ({ name, bot: true })), { start: 1000, sb: 5, bb: 10 });
  g = E.startHand(g, true);
  const i = g.current, v = BOTS.botView(g, i);
  assert.deepEqual(Object.keys(v).sort(), ["bb", "bet", "board", "chips", "currentBet", "hole", "legal", "minRaise", "opponents", "pot", "stage"]);
  const others = g.players.filter((_, j) => j !== i).flatMap((p) => p.hole);
  const flat = JSON.stringify(v);
  assert.ok(!("deck" in v) && !flat.includes("deck"));
  assert.deepEqual(v.hole, g.players[i].hole); assert.equal(v.opponents, 2);
  for (const c of others) assert.ok(!v.hole.includes(c) && !v.board.includes(c), "看不到别人的牌");
  // 换掉对手的手牌和牌堆，看到的信息完全一样（决策只取决于这些信息）
  const g2 = structuredClone(g); g2.players.forEach((p, j) => { if (j !== i) p.hole = [51 - p.hole[0], 50 - p.hole[1]]; }); g2.deck = [];
  assert.deepEqual(BOTS.botView(g2, i), v);
  // 策略：AA 翻前从不弃牌；72 不同花面对大额全下几乎总是弃牌；整体有加注也有弃牌
  const L = { fold: true, check: false, call: 900, raiseMin: 1000, raiseMax: 1000, canRaise: true, allIn: true };
  const base = { board: [], stage: "preflop", pot: 1015, chips: 1000, bet: 0, currentBet: 900, minRaise: 890, bb: 10, legal: L, opponents: 1 };
  let foldsAA = 0, folds72 = 0;
  for (let k = 0; k < 40; k++) { if (BOTS.decide({ ...base, hole: [12, 25] }, { iters: 150 }).type === "fold") foldsAA++; if (BOTS.decide({ ...base, hole: [5, 13] }, { iters: 150 }).type === "fold") folds72++; }
  assert.equal(foldsAA, 0); assert.ok(folds72 >= 30, `72o 弃牌 ${folds72}/40`);
  const kinds = new Set();
  for (let k = 0; k < 200; k++) { const h = [Math.floor(Math.random() * 26), 26 + Math.floor(Math.random() * 26)]; kinds.add(BOTS.decide({ ...base, hole: h, currentBet: 20, legal: { ...L, call: 20, raiseMin: 40 }, pot: 35 }, { iters: 60 }).type); }
  assert.ok(kinds.has("fold") && kinds.has("call") && (kinds.has("raise") || kinds.has("allin")), [...kinds].join(","));
  for (const n of BOTS.BOT_NAMES) assert.ok(!/电脑|AI|机器人|bot/i.test(n));
});

test("玩家不能添加补位玩家；等待时间到了才补位并自动开局；补位玩家没有 ID、看起来和真人一样；筹码不经过玩家余额", async () => {
  const ctx = await boot({ autoBots: true, botTickMs: 50, nextHandDelay: 300, turnMs: 400 });
  try {
    const at = await adminToken(ctx);
    let r = await api(ctx, "POST", "/api/admin/settings", { bots: { waitSec: 3, maxPerTable: 3 } }, at);
    assert.equal(r.status, 200); assert.deepEqual(r.data.settings.bots, { enabled: true, waitSec: 3, maxPerTable: 3 });
    assert.equal((await api(ctx, "POST", "/api/admin/settings", { bots: { waitSec: 1 } }, at)).status, 400);
    assert.equal((await api(ctx, "POST", "/api/admin/settings", { bots: { maxPerTable: 9 } }, at)).status, 400);
    const usersBefore = (await ctx.store.searchUsers("", 1000)).length;
    const eco = await economy(ctx);
    const a = await player(ctx, "真人甲"); const ecoA = eco + 10000;
    const room = await ack(a, "create", { cfg: { start: 1000, sb: 5, bb: 10 } });
    a.emit("addBot"); a.emit("removeBot", 0); // 旧的入口已经没有了
    await wait(1500);
    assert.equal(ctx.rooms.get(room.code).members.length, 1, "等待期内不补位，先等真人");
    await until(() => a.last && a.last.started && a.last.members.length === 4, 6000, "没有补位开局");
    const v = a.last;
    for (const m of v.members) assert.ok(!("bot" in m));
    for (const p of v.game.players) assert.ok(!("bot" in p));
    const bots = v.members.filter((m) => m.name !== "真人甲");
    assert.equal(bots.length, 3);
    for (const m of bots) { assert.equal(m.pid, null); assert.match(m.avu, /^\/api\/avatar\/n\//); assert.ok(m.vip >= 0 && m.vip <= 9); }
    assert.equal((await fetch(ctx.url + bots[0].avu)).status, 200);
    // 别人的手牌看不到
    const me = v.you; v.game.players.forEach((p, i) => { if (i !== me) assert.deepEqual(p.hole, []); });
    assert.equal((await ctx.store.searchUsers("", 1000)).length, usersBefore + 1, "补位玩家不会在数据库里建账号");
    assert.equal(await balanceOf(ctx, a), 9000, "真人余额只扣了自己的带入");
    assert.equal(await economy(ctx), ecoA, "筹码守恒（补位玩家由庄家账户出资）");
    // 第二个真人加入：这手结束后多出的补位玩家离桌（凑够 4 人：2 真人 + 2 补位）
    a.on("state", (s) => { const L = s.game && s.game.legal; if (L) setTimeout(() => a.emit("action", L.check ? { type: "check" } : { type: "call" }), 1); });
    const b = await player(ctx, "真人乙");
    b.on("state", (s) => { const L = s.game && s.game.legal; if (L) setTimeout(() => b.emit("action", L.check ? { type: "check" } : { type: "call" }), 1); });
    assert.ok((await ack(b, "join", { code: room.code })).ok);
    await until(() => { const rm = ctx.rooms.get(room.code); return rm && rm.members.filter((m) => !m.left && m.bot).length === 2; }, 15000, "没有让出座位");
    // 后台关闭补位：这手结束后补位玩家全部离桌
    await api(ctx, "POST", "/api/admin/settings", { bots: { enabled: false } }, at);
    await until(() => { const rm = ctx.rooms.get(room.code); return rm && rm.members.filter((m) => !m.left && m.bot).length === 0; }, 15000, "关闭后补位玩家没有离桌");
    assert.equal(await economy(ctx), ecoA + 10000);
    // 补位玩家不会出现在跑马灯里
    assert.ok(ctx.rooms.get(room.code).members.filter((m) => m.bot).every((m) => m.userId == null && m.pid == null), "没有账号、没有 ID，不进战绩和跑马灯");
  } finally { await ctx.close(); }
});

test("桌上没有在线真人时补位玩家全部离桌", async () => {
  const ctx = await boot({ autoBots: true, botTickMs: 50, nextHandDelay: 300, turnMs: 300, emptyRoomMs: 60000 });
  try {
    const at = await adminToken(ctx);
    await api(ctx, "POST", "/api/admin/settings", { bots: { waitSec: 3, maxPerTable: 2 } }, at);
    const a = await player(ctx, "独行侠");
    const room = await ack(a, "create", { cfg: { start: 1000, sb: 5, bb: 10 } });
    await until(() => a.last && a.last.members.length === 3, 6000);
    const eco = await economy(ctx);
    a.disconnect();
    await until(() => { const rm = ctx.rooms.get(room.code); return rm && rm.members.filter((m) => !m.left && m.bot).length === 0; }, 15000, "补位玩家没有离桌");
    assert.equal(await economy(ctx), eco);
  } finally { await ctx.close(); }
});
