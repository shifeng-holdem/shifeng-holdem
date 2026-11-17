// 平台功能：邀请好友（固定奖励、只发一次、上限、同 IP 不发）、VIP 外观等级、跑马灯打码、公告
import test from "node:test";
import assert from "node:assert/strict";
import { boot, api, player, adminToken } from "../testlib/helpers.js";
import { vipOf, inviteTitle, mask, tierAmount, tierInfo, DEFAULT_REWARDS } from "../platform.js";

const reg = async (ctx, username, ip, invite) => {
  const r = await fetch(ctx.url + "/api/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ username, password: "secret123", invite }) });
  return { status: r.status, data: await r.json() };
};
const bal = async (ctx, id) => (await ctx.store.getUser(id)).balance;
const playOnce = async (ctx, token) => api(ctx, "POST", "/api/games/sicbo/play", { bets: { big: 10 } }, token);

test("邀请好友：好友首次游戏后双方各得 5.00，只发一次；同 IP 不发；后台可看统计", async () => {
  const ctx = await boot();
  try {
    const a = await reg(ctx, "邀请人", "10.0.0.1"); const aid = a.data.user.id, code = a.data.user.publicId;
    await ctx.store.adjust(aid, 1000, "测试", "t");
    // 好友注册（不同 IP），还没玩：不发
    const f = await reg(ctx, "好友甲", "10.0.0.2", code); const fid = f.data.user.id;
    assert.equal(await bal(ctx, fid), 0); assert.equal((await ctx.store.getUser(fid)).inviteStatus, "pending");
    await ctx.store.adjust(fid, 100, "测试", "t");
    const before = await bal(ctx, aid);
    assert.equal((await playOnce(ctx, f.data.token)).status, 200); await ctx.idle();
    assert.equal(await bal(ctx, aid), before + 500, "邀请人 +5.00");
    const fb = await bal(ctx, fid);
    // 再玩几局：不会重复发
    for (let i = 0; i < 3; i++) await playOnce(ctx, f.data.token);
    await ctx.idle(); assert.equal(await bal(ctx, aid), before + 500);
    assert.equal((await ctx.store.getUser(fid)).inviteStatus, "rewarded");
    assert.ok(fb >= 500 - 10, "好友也拿到 5.00");
    // 同一 IP（和邀请人一样 / 和已邀请的好友一样）：注册成功但不发奖励
    const self = await reg(ctx, "小号一", "10.0.0.1", code); assert.equal(self.status, 200); assert.equal((await ctx.store.getUser(self.data.user.id)).inviteStatus, "blocked");
    const dup = await reg(ctx, "小号二", "10.0.0.2", code); assert.equal((await ctx.store.getUser(dup.data.user.id)).inviteStatus, "blocked");
    await ctx.store.adjust(dup.data.user.id, 100, "测试", "t"); await playOnce(ctx, dup.data.token); await ctx.idle();
    assert.equal(await bal(ctx, aid), before + 500, "同设备不发");
    // 无效邀请码：正常注册，不记邀请
    const bad = await reg(ctx, "路人", "10.0.0.9", "99999"); assert.equal((await ctx.store.getUser(bad.data.user.id)).invitedBy, null);
    // 我的邀请页
    const me = await api(ctx, "GET", "/api/me/invite", null, a.data.token);
    assert.equal(me.data.code, code); assert.equal(me.data.rewarded, 1); assert.equal(me.data.title, "紫晶新星"); assert.equal(me.data.amount, 500);
    assert.ok(me.data.list.every((x) => x.name.includes("*")), "好友名字打码");
    // 后台
    const at = await adminToken(ctx);
    const rw = (await api(ctx, "GET", "/api/admin/rewards", null, at)).data;
    assert.equal(rw.totals.invite.amount, 500); assert.equal(rw.totals.invited.amount, 500);
    assert.equal(rw.invites.byStatus.rewarded, 1); assert.equal(rw.invites.byStatus.blocked, 2); assert.equal(rw.invites.inviters[0].rewarded, 1);
  } finally { await ctx.close(); }
});

test("邀请好友：每位邀请人最多奖励 N 位；后台关闭或改金额立即生效", async () => {
  const ctx = await boot();
  try {
    const at = await adminToken(ctx);
    assert.equal((await api(ctx, "POST", "/api/admin/rewards", { invite: { cap: 2, amount: 300, tiers: [{ from: 1, amount: 300 }] } }, at)).status, 200);
    assert.equal((await api(ctx, "POST", "/api/admin/rewards", { invite: { amount: -1 } }, at)).status, 400);
    const a = await reg(ctx, "大使", "20.0.0.1"); const aid = a.data.user.id;
    for (let i = 0; i < 4; i++) {
      const f = await reg(ctx, "朋友" + i, "20.0.1." + i, a.data.user.publicId);
      await ctx.store.adjust(f.data.user.id, 100, "测试", "t"); await playOnce(ctx, f.data.token);
    }
    await ctx.idle();
    assert.equal(await bal(ctx, aid), 600, "只奖励 2 位 × 3.00");
    const st = (await api(ctx, "GET", "/api/admin/rewards", null, at)).data.invites.byStatus;
    assert.equal(st.rewarded, 2); assert.equal(st.capped, 2);
    await api(ctx, "POST", "/api/admin/rewards", { invite: { enabled: false, cap: 20 } }, at);
    const g = await reg(ctx, "晚来的", "20.0.2.1", a.data.user.publicId); await ctx.store.adjust(g.data.user.id, 100, "测试", "t");
    await playOnce(ctx, g.data.token); await ctx.idle();
    assert.equal(await bal(ctx, aid), 600, "关闭后不发");
    // 并发首局：只发一次
    await api(ctx, "POST", "/api/admin/rewards", { invite: { enabled: true } }, at);
    const h = await reg(ctx, "抢跑", "20.0.3.1", a.data.user.publicId); await ctx.store.adjust(h.data.user.id, 1000, "测试", "t");
    await Promise.all([1, 2, 3, 4].map(() => api(ctx, "POST", "/api/games/baccarat/play", { bets: { player: 10 } }, h.data.token)));
    await Promise.all([1, 2].map(() => api(ctx, "POST", "/api/games/sicbo/play", { bets: { big: 10 } }, h.data.token)));
    await ctx.idle();
    assert.equal(await bal(ctx, aid), 900, "并发也只发一次");
  } finally { await ctx.close(); }
});

test("VIP 外观等级、称号、打码、跑马灯与公告", async () => {
  assert.equal(vipOf(0).level, 0); assert.equal(vipOf(4999).level, 0); assert.equal(vipOf(5000).title, "青铜"); assert.equal(vipOf(1e9).level, 9);
  assert.equal(vipOf(1e9).next, null); assert.ok(vipOf(10000).progress > 0 && vipOf(10000).progress < 1);
  assert.equal(inviteTitle(0).title, null); assert.equal(inviteTitle(5).title, "紫晶新星"); assert.equal(inviteTitle(10).title, "紫晶推广大使"); assert.equal(inviteTitle(100).title, "皇家荣誉大使");
  assert.equal(mask("pengc11"), "p***1"); assert.equal(mask("小美"), "小*"); assert.equal(mask("Laura"), "L***a");
  const ctx = await boot();
  try {
    const p = await player(ctx, "流水玩家", 100000);
    for (let i = 0; i < 10; i++) await api(ctx, "POST", "/api/games/sicbo/play", { bets: { big: 1000 } }, p.token);
    const me = (await api(ctx, "GET", "/api/me", null, p.token)).data;
    assert.equal(me.vip.turnover, 10000); assert.equal(me.vip.level, 1); assert.equal(me.vip.title, "青铜");
    // 跑马灯：大奖打码显示
    await ctx.store.slotSpin(p.user.id, ctx.houseId, "sicbo", 10, 1810, 0, "测试大奖");
    const mq = (await api(ctx, "GET", "/api/marquee")).data;
    assert.equal(mq[0].name, "流***家"); assert.equal(mq[0].win, 1810); assert.equal(mq[0].game, "骰宝");
    // 公告：后台编辑，大厅读取
    const at = await adminToken(ctx);
    assert.equal((await api(ctx, "POST", "/api/admin/announcements", { list: [{ title: "新游戏上线", body: "百家乐、21点…", pinned: true }] }, at)).status, 200);
    const an = (await api(ctx, "GET", "/api/announcements")).data; assert.equal(an[0].title, "新游戏上线");
    assert.equal((await api(ctx, "POST", "/api/admin/announcements", { list: [] }, p.token)).status, 403);
  } finally { await ctx.close(); }
});

test("邀请阶梯：默认不限人数；1–10 位 5.00、11–50 位 8.00、51 位起 10.00；里程碑 10/50/100 位各只发一次", async () => {
  // 纯函数：档位边界
  for (const [n, a] of [[1, 500], [10, 500], [11, 800], [50, 800], [51, 1000], [100, 1000], [5000, 1000]]) assert.equal(tierAmount(n), a, `第 ${n} 位`);
  assert.equal(DEFAULT_REWARDS.invite.cap, 0, "默认不限人数");
  assert.deepEqual(tierInfo(0).current, { from: 1, amount: 500, to: 10 }); assert.equal(tierInfo(0).next.need, 10);
  assert.equal(tierInfo(9).next.need, 1); assert.equal(tierInfo(10).current.amount, 800); assert.equal(tierInfo(10).next.need, 40);
  assert.equal(tierInfo(50).current.amount, 1000); assert.equal(tierInfo(50).next, null);
  const ctx = await boot();
  try {
    const cfg = DEFAULT_REWARDS.invite, st = ctx.store;
    const inv = await st.createUser("阶梯大使", "!", 0, { regIp: "30.0.0.1" });
    const BON = { 10: 2000, 50: 10000, 100: 30000 };
    let expect = 0;
    for (let k = 1; k <= 101; k++) {
      const f = await st.createUser("友" + k, "!", 0, { invitedBy: inv.id, inviteStatus: "pending", regIp: "31.0." + (k >> 8) + "." + (k & 255) });
      assert.equal(await st.inviteReward(f.id, cfg), "rewarded");
      expect += tierAmount(k) + (BON[k] || 0);
      assert.equal(await bal(ctx, inv.id), expect, `第 ${k} 位后邀请人余额`);
      assert.equal(await bal(ctx, f.id), 500, "好友固定 5.00");
      assert.equal(await st.inviteReward(f.id, cfg), "rewarded"); assert.equal(await bal(ctx, inv.id), expect, "同一好友不重复发");
    }
    assert.equal(expect, 10 * 500 + 40 * 800 + 51 * 1000 + 2000 + 10000 + 30000, "共 1,300.00");
    // 里程碑只发一次：再邀请一位，配置里的 10/50/100 位里程碑都不会再发；后加的、已经越过的里程碑只补发一次
    const g = await st.createUser("友102", "!", 0, { invitedBy: inv.id, inviteStatus: "pending", regIp: "32.0.0.1" });
    await st.inviteReward(g.id, { ...cfg, milestones: [...cfg.milestones, { at: 5, bonus: 700 }] });
    assert.equal(await bal(ctx, inv.id), expect + 1000 + 700);
    const h = await st.createUser("友103", "!", 0, { invitedBy: inv.id, inviteStatus: "pending", regIp: "32.0.0.2" });
    await st.inviteReward(h.id, { ...cfg, milestones: [...cfg.milestones, { at: 5, bonus: 700 }] });
    assert.equal(await bal(ctx, inv.id), expect + 2000 + 700, "里程碑不重复");
    const claims = await st.userClaims(inv.id);
    assert.equal(claims.filter((c) => c.type === "milestone").length, 4); assert.equal(claims.filter((c) => c.type === "invite").length, 103);
    // 后台：档位 / 里程碑 / 上限的校验与保存；留空或 0 = 不限
    const at = await adminToken(ctx);
    assert.equal((await api(ctx, "POST", "/api/admin/rewards", { invite: { tiers: [{ from: 2, amount: 100 }] } }, at)).status, 400, "第一档必须从 1 开始");
    assert.equal((await api(ctx, "POST", "/api/admin/rewards", { invite: { tiers: [{ from: 1, amount: 100 }, { from: 1, amount: 200 }] } }, at)).status, 400);
    assert.equal((await api(ctx, "POST", "/api/admin/rewards", { invite: { milestones: [{ at: 10, bonus: 1 }, { at: 10, bonus: 2 }] } }, at)).status, 400);
    let r = await api(ctx, "POST", "/api/admin/rewards", { invite: { cap: "", tiers: [{ from: 1, amount: 600 }, { from: 21, amount: 900 }], milestones: [{ at: 20, bonus: 5000 }] } }, at);
    assert.equal(r.status, 200); assert.equal(r.data.settings.invite.cap, 0); assert.equal(r.data.settings.invite.tiers[1].amount, 900);
    r = await api(ctx, "GET", "/api/admin/rewards", null, at); assert.equal(r.data.totals.milestone.amount, 2000 + 10000 + 30000 + 700);
    // 通过 API 走一遍：新邀请人第一位好友按新档位 6.00，邀请页显示当前档 / 下一档 / 进度
    const a = await reg(ctx, "新大使", "40.0.0.1"); const f = await reg(ctx, "新朋友", "40.0.0.2", a.data.user.publicId);
    await ctx.store.adjust(f.data.user.id, 100, "测试", "t"); await playOnce(ctx, f.data.token); await ctx.idle();
    assert.equal(await bal(ctx, a.data.user.id), 600);
    const me = (await api(ctx, "GET", "/api/me/invite", null, a.data.token)).data;
    assert.equal(me.rewarded, 1); assert.equal(me.earned, 600); assert.equal(me.nextReward, 600); assert.equal(me.cap, 0);
    assert.equal(me.tier.current.amount, 600); assert.equal(me.tier.next.from, 21); assert.equal(me.tier.next.need, 19);
    assert.deepEqual(me.milestones, [{ at: 20, bonus: 5000, done: false }]);
  } finally { await ctx.close(); }
});

test("升级迁移：旧的“最多 20 位”设置启动后改为不限人数 + 阶梯奖励；之后后台改的值保留", async () => {
  const { openStore } = await import("../db.js");
  const st = await openStore({ memory: true });
  await st.setSetting("rewards", { invite: { enabled: true, amount: 500, cap: 20 } });
  let ctx = await boot({ store: st });
  try {
    const at = await adminToken(ctx);
    const s = (await api(ctx, "GET", "/api/admin/rewards", null, at)).data.settings.invite;
    assert.equal(s.cap, 0); assert.equal(s.tiers.length, 3); assert.equal(s.milestones.length, 3); assert.equal(s.amount, 500);
    await api(ctx, "POST", "/api/admin/rewards", { invite: { cap: 30 } }, at);
  } finally { ctx.server.close(); }
  ctx = await boot({ store: st });
  try { const at = await adminToken(ctx); assert.equal((await api(ctx, "GET", "/api/admin/rewards", null, at)).data.settings.invite.cap, 30, "迁移只做一次"); }
  finally { await ctx.close(); }
});
