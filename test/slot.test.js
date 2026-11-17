import test from "node:test";
import assert from "node:assert/strict";
import * as Slot from "../slot.js";
import { boot, api, register, player, adminToken } from "../testlib/helpers.js";

const G = (cols) => cols.map((c) => c.split(" ")); // 每个字符串是一轴，从上到下

test("麻将消消乐：路数与赔付计算", () => {
  const grid = G(["fa fa tong2 tiao2", "fa wild bai wan", "tong5 fa tiao5 bai", "tong2 tiao2 wan tong5", "zhong zhong zhong zhong"]);
  const wins = Slot.evaluate(grid);
  const fa = wins.find((w) => w.sym === "fa");
  assert.equal(fa.len, 3); assert.equal(fa.ways, 2 * 2 * 1); assert.equal(fa.units, Slot.PAYTABLE.fa[3] * 4);
  assert.equal(fa.cells.length, 5, "第一轴两个發 + 第二轴發和百搭 + 第三轴一个發");
  // 第 1 轴有白吗？没有 → 白不中；百搭不能单独在第一轴开头
  assert.ok(!wins.find((w) => w.sym === "bai"));
  assert.ok(!wins.find((w) => w.sym === "zhong"), "只在第 5 轴出现不算");
  // 5 轴全中
  const five = Slot.evaluate(G(["wan fa fa fa", "wan wan fa fa", "wild fa fa fa", "wan fa fa fa", "wan wan wan fa"]));
  const w = five.find((x) => x.sym === "wan");
  assert.equal(w.len, 5); assert.equal(w.ways, 1 * 2 * 1 * 1 * 3); assert.equal(w.units, Slot.PAYTABLE.wan[5] * 6);
  assert.equal(Slot.countScatter(G(["hu fa fa fa", "fa hu fa fa", "fa fa fa fa", "fa fa fa hu", "fa fa fa fa"])), 3);
  // 下注 100，单位是 1%：赢 = 100 × units / 100
  assert.equal(Slot.MAX_WIN_X, 5000);
});

test("麻将消消乐：中奖牌消除后上方下落、顶部补新牌", () => {
  const grid = G(["a b c d", "e f g h", "i j k l", "m n o p", "q r s t"]);
  const rng = () => 0; // 补进来的永远是第一种牌（發）
  const out = Slot.cascade(grid, [[0, 3], [0, 1], [2, 0]], rng);
  assert.deepEqual(out[0], ["fa", "fa", "a", "c"]);
  assert.deepEqual(out[1], ["e", "f", "g", "h"]);
  assert.deepEqual(out[2], ["fa", "j", "k", "l"]);
  for (const col of out) assert.equal(col.length, Slot.ROWS);
});

test("麻将消消乐：连消倍数递增、步骤金额合计正确、免费游戏倍数更高", () => {
  const rng = Slot.cryptoRng();
  let sawCascade = 0, sawFree = 0;
  for (let i = 0; i < 6000 && (sawCascade < 20 || sawFree < 2); i++) {
    const s = Slot.spin(100, rng);
    const check = (steps, mults) => {
      steps.forEach((st, k) => {
        assert.equal(st.mult, mults[Math.min(k, mults.length - 1)]);
        assert.equal(st.units, st.wins.reduce((a, w) => a + w.pay * w.ways, 0) * st.mult);
        if (k < steps.length - 1) assert.ok(st.wins.length > 0, "只有中奖才会继续连消");
      });
      assert.equal(steps[steps.length - 1].wins.length, 0, "最后一步没有中奖");
      return steps.reduce((a, st) => a + st.units, 0);
    };
    let u = check(s.base.steps, Slot.BASE_MULTS);
    if (s.base.steps.length >= 3) sawCascade++;
    assert.equal(s.freeAwarded > 0, s.base.scatters >= 3);
    for (const f of s.free) u += check(f.steps, Slot.FREE_MULTS);
    if (s.free.length) { sawFree++; assert.equal(s.free.length, s.freeAwarded); assert.ok(s.freeAwarded <= Slot.MAX_FREE); }
    assert.equal(u, s.units);
    assert.ok(s.win <= 100 * Slot.MAX_WIN_X);
    if (!s.capped) assert.equal(s.win, Math.round(s.units));
  }
  assert.ok(sawCascade >= 20, "应该出现多次连消"); assert.ok(sawFree >= 2, "应该触发过免费游戏");
});

test("麻将消消乐：100 万次模拟 RTP 在 94%–98% 之间", () => {
  const r = Slot.simulate(1_000_000);
  console.log(`  RTP ${(r.rtp * 100).toFixed(2)}% · 中奖率 ${(r.hitRate * 100).toFixed(1)}% · 免费游戏触发 1/${Math.round(1 / r.featureRate)} · 最高 ${r.maxX}x`);
  assert.ok(r.rtp > 0.94 && r.rtp < 0.98, "RTP " + r.rtp);
});

test("麻将消消乐接口：需要登录、下注额校验、余额不足提示、余额不会变负、庄家对冲守恒", async () => {
  const ctx = await boot();
  try {
    assert.equal((await api(ctx, "POST", "/api/mahjong/spin", { bet: 10 })).status, 401);
    const z = await register(ctx, "零币小王");
    const r0 = await api(ctx, "POST", "/api/mahjong/spin", { bet: 50 }, z.token);
    assert.equal(r0.status, 400); assert.equal(r0.data.error, "余额不足，请联系客服获取游戏币");
    const p = await player(ctx, "转轴玩家", 100);
    assert.equal((await api(ctx, "POST", "/api/mahjong/spin", { bet: 7 }, p.token)).status, 400, "不在列表里的下注额");
    assert.equal((await api(ctx, "POST", "/api/mahjong/spin", { bet: 500 }, p.token)).data.code, "NO_CHIPS");
    const house0 = (await ctx.store.getUser(ctx.houseId)).balance;
    let bal = 100, spins = 0, bets = 0, wins = 0;
    for (let i = 0; i < 400; i++) {
      // 同时发起多次：要么被挡住（429），要么余额不足，要么依次结算；余额绝不会变负
      const rs = await Promise.all([1, 2, 3].map(() => api(ctx, "POST", "/api/mahjong/spin", { bet: 50 }, p.token)));
      for (const r of rs) assert.ok([200, 400, 429].includes(r.status), "状态 " + r.status);
      for (const r of rs.filter((x) => x.status === 200)) { spins++; bets += 50; wins += r.data.win; bal = r.data.balance; assert.ok(bal >= 0); }
      const u = await ctx.store.getUser(p.user.id); assert.ok(u.balance >= 0, "余额不会变负"); assert.equal(u.balance, 100 - bets + wins);
      if (rs.some((r) => r.data && r.data.code === "NO_CHIPS")) break;
    }
    assert.ok(spins > 0);
    const house = (await ctx.store.getUser(ctx.houseId)).balance;
    assert.equal(house - house0, bets - wins, "庄家账户 = 下注 - 派彩");
    const h = await api(ctx, "GET", "/api/mahjong/history", null, p.token);
    assert.equal(h.data.totals.spins, spins); assert.equal(h.data.totals.bets, bets); assert.equal(h.data.totals.wins, wins);
    assert.equal(h.data.history.length, Math.min(20, spins)); assert.equal(h.data.history[0].bet, 50);
    // 后台汇总
    assert.equal((await api(ctx, "GET", "/api/admin/mahjong", null, p.token)).status, 403);
    const a = await api(ctx, "GET", "/api/admin/mahjong", null, await adminToken(ctx));
    assert.equal(a.data.totals.spins, spins); assert.equal(a.data.totals.profit, bets - wins); assert.equal(a.data.top[0].username, "转轴玩家");
    // 账本里有记录
    const led = await ctx.store.ledger(p.user.id, 5); assert.match(led[0].reason, /时烽麻将消消乐 下注 0\.50/);
  } finally { await ctx.close(); }
});

test("麻将消消乐：后台赠送的游戏币和德州共用，页面没有充值/提现字样", async () => {
  const ctx = await boot();
  try {
    const z = await register(ctx, "共用余额");
    const adm = await adminToken(ctx);
    await api(ctx, "POST", `/api/admin/users/${z.user.id}/adjust`, { delta: 1000 }, adm);
    const r = await api(ctx, "POST", "/api/mahjong/spin", { bet: 100 }, z.token);
    assert.equal(r.status, 200); assert.equal(r.data.balance, 900 + r.data.win);
    assert.equal((await api(ctx, "GET", "/api/me", null, z.token)).data.balance, r.data.balance);
    for (const f of ["/", "/mahjong.js", "/admin"]) {
      const t = await (await fetch(ctx.url + f)).text();
      assert.doesNotMatch(t, /充值|提现|兑现到|出款|入款|USDT|deposit|withdraw/i, f);
    }
    assert.match(await (await fetch(ctx.url + "/")).text(), /游戏大厅/);
  } finally { await ctx.close(); }
});
