import test from "node:test";
import assert from "node:assert/strict";
import { boot, api, player, register, login, ack, until, adminToken, economy, balanceOf } from "../testlib/helpers.js";

test("管理接口：未登录 401，普通玩家 403", async () => {
  const ctx = await boot();
  try {
    const { token } = await register(ctx, "普通人");
    for (const [m, p] of [["GET", "/api/admin/stats"], ["GET", "/api/admin/users"], ["POST", "/api/admin/users/1/adjust"], ["POST", "/api/admin/users/1/ban"], ["GET", "/api/admin/rooms"], ["POST", "/api/admin/settings"], ["POST", "/api/admin/rooms/ABCDE/close"]]) {
      assert.equal((await api(ctx, m, p, {})).status, 401, p);
      assert.equal((await api(ctx, m, p, {}, token)).status, 403, p);
    }
    assert.equal((await api(ctx, "GET", "/api/admin/stats", null, await adminToken(ctx))).status, 200);
    const page = await fetch(ctx.url + "/admin"); assert.equal(page.status, 200); assert.match(await page.text(), /庄家后台/);
  } finally { await ctx.close(); }
});

test("查玩家、加减筹码（必须写原因并记账）、封禁/解封", async () => {
  const ctx = await boot();
  try {
    const adm = await adminToken(ctx);
    const p = await player(ctx, "小李");
    const found = await api(ctx, "GET", "/api/admin/users?q=小", null, adm);
    assert.deepEqual(found.data.map((u) => u.username), ["小李"]);
    assert.equal((await api(ctx, "POST", `/api/admin/users/${p.user.id}/adjust`, { delta: 500 }, adm)).status, 400, "没写原因不行");
    const add = await api(ctx, "POST", `/api/admin/users/${p.user.id}/adjust`, { delta: 500, reason: "活动奖励" }, adm);
    assert.equal(add.data.balance, 10500);
    assert.equal((await api(ctx, "POST", `/api/admin/users/${p.user.id}/adjust`, { delta: -99999, reason: "测试" }, adm)).status, 400, "不能扣成负数");
    await api(ctx, "POST", `/api/admin/users/${p.user.id}/adjust`, { delta: -300, reason: "违规扣除" }, adm);
    const led = await api(ctx, "GET", `/api/admin/users/${p.user.id}/ledger`, null, adm);
    assert.equal(led.data[0].delta, -300); assert.match(led.data[0].reason, /违规扣除/); assert.equal(led.data[0].actor, "boss"); assert.equal(led.data[0].balanceAfter, 10200);
    await until(() => p.me && p.me.balance === 10200, 2000, "余额变动没有推送给玩家");

    // 封禁：在房间里的会被请出并返还筹码，不能再登录
    const r = await ack(p, "create", {});
    await until(() => ctx.rooms.has(r.code));
    assert.equal(await balanceOf(ctx, p), 9200);
    await api(ctx, "POST", `/api/admin/users/${p.user.id}/ban`, { banned: true }, adm);
    await ctx.idle();
    assert.equal(ctx.rooms.has(r.code), false);
    assert.equal(await balanceOf(ctx, p), 10200);
    assert.equal((await login(ctx, "小李", "secret123")).status, 403);
    assert.equal((await api(ctx, "GET", "/api/me", null, p.token)).status, 401, "封禁后旧会话失效");
    await api(ctx, "POST", `/api/admin/users/${p.user.id}/ban`, { banned: false }, adm);
    assert.equal((await login(ctx, "小李", "secret123")).status, 200);
  } finally { await ctx.close(); }
});

test("查看房间、踢人、关闭房间都会返还筹码；设置每日领取金额", async () => {
  const ctx = await boot();
  try {
    const adm = await adminToken(ctx);
    const a = await player(ctx, "甲方"), b = await player(ctx, "乙方");
    const eco = await economy(ctx);
    const r = await ack(a, "create", { cfg: { public: false } });
    await ack(b, "join", { code: r.code }); a.emit("addBot");
    await until(() => a.last && a.last.members.length === 3);
    const rooms = await api(ctx, "GET", "/api/admin/rooms", null, adm);
    assert.equal(rooms.data.length, 1, "后台能看到私密房间");
    assert.equal(rooms.data[0].members.length, 3); assert.equal(rooms.data[0].online, 2);
    const stats = await api(ctx, "GET", "/api/admin/stats", null, adm);
    assert.equal(stats.data.online, 2); assert.equal(stats.data.rooms, 1); assert.equal(stats.data.tableChips, 3000);

    await api(ctx, "POST", `/api/admin/rooms/${r.code}/kick`, { userId: b.user.id }, adm);
    await ctx.idle();
    await until(() => b.kicked);
    assert.equal(await balanceOf(ctx, b), 10000);
    await api(ctx, "POST", `/api/admin/rooms/${r.code}/close`, null, adm);
    await ctx.idle();
    assert.equal(ctx.rooms.size, 0); assert.equal(await balanceOf(ctx, a), 10000);
    assert.equal(await economy(ctx), eco);

    const s = await api(ctx, "POST", "/api/admin/settings", { dailyFree: 5000 }, adm);
    assert.equal(s.data.settings.dailyFree, 5000);
    const c = await api(ctx, "POST", "/api/claim", null, a.token);
    assert.equal(c.data.amount, 5000);
    assert.equal((await api(ctx, "POST", "/api/admin/settings", { rakePercent: 50 }, adm)).status, 400);
  } finally { await ctx.close(); }
});

test("抽水：翻牌后按比例从底池抽给庄家账户，总量守恒", async () => {
  const ctx = await boot();
  try {
    const adm = await adminToken(ctx);
    await api(ctx, "POST", "/api/admin/settings", { rakePercent: 5 }, adm);
    const a = await player(ctx, "甲方"), b = await player(ctx, "乙方");
    const eco = await economy(ctx);
    const house0 = (await api(ctx, "GET", "/api/admin/stats", null, adm)).data.house;
    const r = await ack(a, "create", { cfg: { start: 1000, sb: 10, bb: 20 } }); await ack(b, "join", { code: r.code });
    a.emit("start");
    // 都过牌/跟注到摊牌
    for (const s of [a, b]) s.on("state", (v) => { const L = v.game && v.game.legal; if (L) setTimeout(() => s.emit("action", L.check ? { type: "check" } : { type: "call" }), 1); });
    await until(() => a.last && a.last.game);
    for (const s of [a, b]) { const L = s.last.game.legal; if (L) s.emit("action", L.check ? { type: "check" } : { type: "call" }); }
    await until(() => a.last.game.stage === "handover", 20000);
    await ctx.idle();
    assert.equal(a.last.game.lastRake, 2, "底池 40 抽 5% = 2");
    assert.equal(a.last.game.players.reduce((s, p) => s + p.chips, 0), 1998);
    const house1 = (await api(ctx, "GET", "/api/admin/stats", null, adm)).data.house;
    assert.equal(house1 - house0, 2);
    assert.equal(await economy(ctx), eco, "抽水只是从桌上转到庄家账户");
  } finally { await ctx.close(); }
});
