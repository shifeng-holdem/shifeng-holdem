// 五个牌桌游戏的接口：校验、结算、余额不变负、庄家对冲守恒、历史与后台统计、限额设置
import test from "node:test";
import assert from "node:assert/strict";
import { boot, api, player, register, adminToken } from "../testlib/helpers.js";

const bal = async (ctx, id) => (await ctx.store.getUser(id)).balance;
async function conserve(ctx, ids, fn) { // 玩家 + 庄家 的总额在游戏前后不变（筹码只在两者之间转移）
  const sum = async () => { let t = await bal(ctx, ctx.houseId); for (const id of ids) t += await bal(ctx, id); return t; };
  const before = await sum(); await fn(); await ctx.idle(); assert.equal(await sum(), before, "玩家 + 庄家 总额守恒");
}

test("百家乐 / 骰宝 / 牛牛：校验、结算、守恒、历史", async () => {
  const ctx = await boot();
  try {
    const p = await player(ctx, "牌桌玩家", 100000);
    assert.equal((await api(ctx, "POST", "/api/games/baccarat/play", { bets: { banker: 100 } })).status, 401);
    assert.match((await api(ctx, "POST", "/api/games/baccarat/play", { bets: { banker: 5 } }, p.token)).data.error, /最低/);
    assert.match((await api(ctx, "POST", "/api/games/baccarat/play", { bets: { banker: 50001 } }, p.token)).data.error, /最高/);
    assert.equal((await api(ctx, "POST", "/api/games/baccarat/play", { bets: { nope: 100 } }, p.token)).status, 400);
    await conserve(ctx, [p.user.id], async () => {
      for (let i = 0; i < 30; i++) {
        const r = await api(ctx, "POST", "/api/games/baccarat/play", { bets: { banker: 100, player: 50, tie: 10, ppair: 10 } }, p.token);
        assert.equal(r.status, 200); assert.equal(r.data.stake, 170); assert.ok(["player", "banker", "tie"].includes(r.data.winner));
        const s = await api(ctx, "POST", "/api/games/sicbo/play", { bets: { big: 100, sum10: 10, triple3: 10, single6: 20 } }, p.token);
        assert.equal(s.status, 200); assert.equal(s.data.dice.length, 3);
        const n = await api(ctx, "POST", "/api/games/niuniu/play", { bet: 100 }, p.token);
        assert.equal(n.status, 200); assert.ok(n.data.ph.split === null || n.data.ph.split[0].length === 3);
        assert.ok(n.data.net >= -500 && n.data.net <= 500 * 0.95);
      }
    });
    const h = await api(ctx, "GET", "/api/games/baccarat/history", null, p.token);
    assert.equal(h.data.totals.spins, 30); assert.equal(h.data.totals.bets, 30 * 170); assert.ok(h.data.history[0].detail.pc);
    // 牛牛最多按 5 倍结算：余额不足 5 倍不让下
    const q = await player(ctx, "小额玩家", 400);
    const r = await api(ctx, "POST", "/api/games/niuniu/play", { bet: 100 }, q.token); assert.equal(r.data.code, "NO_CHIPS");
    // 后台统计 + 改限额
    const at = await adminToken(ctx);
    const g = (await api(ctx, "GET", "/api/admin/games", null, at)).data;
    assert.equal(g.baccarat.spins, 30); assert.equal(g.baccarat.profit, g.baccarat.bets - g.baccarat.wins); assert.ok(g.baccarat.rtp > 0);
    assert.deepEqual(g.sicbo.limits, { min: 10, max: 50000 });
    assert.equal((await api(ctx, "POST", "/api/admin/games/limits", { game: "sicbo", min: 500, max: 100 }, at)).status, 400);
    assert.equal((await api(ctx, "POST", "/api/admin/games/limits", { game: "sicbo", min: 100, max: 1000 }, at)).status, 200);
    assert.match((await api(ctx, "POST", "/api/games/sicbo/play", { bets: { big: 50 } }, p.token)).data.error, /最低 1\.00/);
    assert.equal((await api(ctx, "GET", "/api/games/config")).data.limits.sicbo.min, 100);
    assert.equal((await api(ctx, "POST", "/api/admin/games/limits", { game: "sicbo", min: 1, max: 1 }, p.token)).status, 403);
  } finally { await ctx.close(); }
});

test("21点：开局扣注、加倍/分牌追加扣款、结算一次、暗牌不外泄、不能同时开两局", async () => {
  const ctx = await boot();
  try {
    const p = await player(ctx, "二十一点", 100000);
    await conserve(ctx, [p.user.id], async () => {
      for (let i = 0; i < 40; i++) {
        let r = await api(ctx, "POST", "/api/games/blackjack/start", { bet: 200 }, p.token); assert.equal(r.status, 200);
        let v = r.data.round;
        if (v.phase !== "done") {
          assert.equal(v.dealer[1], null, "庄家暗牌不发给客户端");
          assert.equal((await api(ctx, "POST", "/api/games/blackjack/start", { bet: 200 }, p.token)).data.code, "ACTIVE");
          const st = await api(ctx, "GET", "/api/games/blackjack/state", null, p.token); assert.equal(st.data.round.id, v.id);
        }
        let k = 0;
        while (v.phase !== "done" && k++ < 20) {
          const a = v.legal.includes("insurance") ? "noInsurance" : v.legal.includes("split") ? "split" : v.legal.includes("double") && i % 2 ? "double" : v.hands[v.active].total < 16 ? "hit" : "stand";
          r = await api(ctx, "POST", "/api/games/blackjack/action", { action: a }, p.token); assert.equal(r.status, 200, JSON.stringify(r.data)); v = r.data.round;
        }
        assert.equal(v.phase, "done"); assert.ok(v.result.payout >= 0); assert.ok(v.dealer[1] != null);
      }
    });
    assert.equal((await api(ctx, "POST", "/api/games/blackjack/action", { action: "hit" }, p.token)).status, 404);
    const h = await api(ctx, "GET", "/api/games/blackjack/history", null, p.token); assert.equal(h.data.totals.spins, 40);
    // 余额只够开局，不够加倍
    const q = await player(ctx, "小额21", 100);
    const s = await api(ctx, "POST", "/api/games/blackjack/start", { bet: 100 }, q.token);
    if (s.data.round.phase !== "done" && s.data.round.legal.includes("double")) {
      const d = await api(ctx, "POST", "/api/games/blackjack/action", { action: "double" }, q.token); assert.equal(d.data.code, "NO_CHIPS");
    }
    assert.ok((await bal(ctx, q.user.id)) >= 0);
  } finally { await ctx.close(); }
});

test("炸金花：看牌前看不到牌，看牌后跟注 2 倍、闷跟 1 倍，弃牌输底注", async () => {
  const ctx = await boot();
  try {
    const p = await player(ctx, "金花玩家", 100000);
    await conserve(ctx, [p.user.id], async () => {
      for (let i = 0; i < 30; i++) {
        const b0 = await bal(ctx, p.user.id);
        let r = await api(ctx, "POST", "/api/games/zjh/start", { ante: 100 }, p.token); assert.equal(r.status, 200);
        assert.equal(r.data.round.player, null); assert.equal(r.data.round.dealer, null);
        assert.equal(await bal(ctx, p.user.id), b0 - 100);
        const mode = i % 3;
        if (mode !== 2) { r = await api(ctx, "POST", "/api/games/zjh/action", { action: "look" }, p.token); assert.equal(r.data.round.player.length, 3); assert.equal(r.data.round.dealer, null); }
        r = await api(ctx, "POST", "/api/games/zjh/action", { action: mode === 0 ? "fold" : "call" }, p.token); assert.equal(r.status, 200);
        const e = r.data.round.result; assert.equal(r.data.round.dealer.length, 3);
        if (mode === 0) { assert.equal(e.payout, 0); assert.equal(await bal(ctx, p.user.id), b0 - 100); }
        else assert.equal(e.play, mode === 1 ? 200 : 100);
        assert.equal(await bal(ctx, p.user.id), b0 - 100 - e.play + e.payout);
      }
    });
    assert.equal((await api(ctx, "POST", "/api/games/zjh/action", { action: "call" }, p.token)).status, 404);
  } finally { await ctx.close(); }
});

test("并发：同一个玩家同时多次下注，余额永远不会变负", async () => {
  const ctx = await boot();
  try {
    const p = await player(ctx, "并发玩家", 1000);
    for (let i = 0; i < 40; i++) {
      const rs = await Promise.all([
        api(ctx, "POST", "/api/games/baccarat/play", { bets: { player: 300 } }, p.token),
        api(ctx, "POST", "/api/games/sicbo/play", { bets: { small: 300 } }, p.token),
        api(ctx, "POST", "/api/games/zjh/start", { ante: 300 }, p.token),
      ]);
      for (const r of rs) assert.ok([200, 400, 409, 429].includes(r.status));
      assert.ok((await bal(ctx, p.user.id)) >= 0);
      const z = await api(ctx, "GET", "/api/games/zjh/state", null, p.token);
      if (z.data.round) await api(ctx, "POST", "/api/games/zjh/action", { action: "fold" }, p.token);
      if ((await bal(ctx, p.user.id)) < 300) break;
    }
    assert.ok((await bal(ctx, p.user.id)) >= 0);
  } finally { await ctx.close(); }
});
