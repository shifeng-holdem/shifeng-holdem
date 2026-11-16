import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { boot, api, register, login } from "../testlib/helpers.js";

test("注册、登录、会话、校验", async () => {
  const ctx = await boot();
  try {
    const r = await register(ctx, "Laura", "pass1234");
    assert.equal(r.user.username, "Laura"); assert.equal(r.user.balance, 0, "注册不送筹码"); assert.equal(r.user.isAdmin, false);
    // 密码用 bcrypt 存储，不是明文
    const u = await ctx.store.getUserByName("laura");
    assert.notEqual(u.passHash, "pass1234"); assert.ok(u.passHash.startsWith("$2")); assert.ok(await bcrypt.compare("pass1234", u.passHash));
    assert.equal((await api(ctx, "POST", "/api/register", { username: "LAURA", password: "whatever1" })).status, 409, "用户名不分大小写唯一");
    assert.equal((await api(ctx, "POST", "/api/register", { username: "a", password: "whatever1" })).status, 400);
    assert.equal((await api(ctx, "POST", "/api/register", { username: "abc", password: "123" })).status, 400);
    assert.equal((await api(ctx, "POST", "/api/register", { username: "__house__", password: "whatever1" })).status, 400);
    assert.equal((await login(ctx, "Laura", "wrong-pass")).status, 401);
    assert.equal((await login(ctx, "__house__", "!")).status, 401, "庄家账户不能登录");
    const ok = await login(ctx, "laura", "pass1234");
    assert.equal(ok.status, 200); assert.ok(ok.data.token);
    const me = await api(ctx, "GET", "/api/me", null, ok.data.token);
    assert.equal(me.status, 200); assert.equal(me.data.username, "Laura");
    assert.equal((await api(ctx, "GET", "/api/me")).status, 401);
    assert.equal((await api(ctx, "GET", "/api/me", null, "bad-token")).status, 401);
    await api(ctx, "POST", "/api/logout", null, ok.data.token);
    assert.equal((await api(ctx, "GET", "/api/me", null, ok.data.token)).status, 401, "退出后会话失效");
    // 连续输错会被暂时锁定
    for (let i = 0; i < 8; i++) await login(ctx, "Laura", "nope" + i);
    assert.equal((await login(ctx, "Laura", "pass1234")).status, 429);
  } finally { await ctx.close(); }
});

test("没有每日领取；旧版本存下的注册赠送/每日领取设置启动时被清零", async () => {
  const { openStore } = await import("../db.js");
  const store = await openStore({ memory: true });
  await store.setSetting("signupBonus", 10000); await store.setSetting("dailyFree", 2000); await store.setSetting("rakePercent", 1.5);
  const ctx = await boot({ store });
  try {
    const { token, user } = await register(ctx, "新玩家");
    assert.equal(user.balance, 0);
    assert.equal((await api(ctx, "GET", "/api/me", null, token)).data.balance, 0);
    assert.equal((await api(ctx, "POST", "/api/claim", null, token)).status, 404, "领取接口已移除");
    const me = (await api(ctx, "GET", "/api/me", null, token)).data;
    assert.equal(me.canClaim, undefined); assert.equal(me.dailyFree, undefined);
    const st = await store.getSettings();
    assert.equal(st.signupBonus, 0); assert.equal(st.dailyFree, 0); assert.equal(st.rakePercent, 1.5, "抽水设置保留");
    const ledger = await api(ctx, "GET", "/api/me/ledger", null, token);
    assert.deepEqual(ledger.data, [], "注册没有任何入账");
  } finally { await ctx.close(); }
});

test("余额为 0 不能建房或加入房间，提示联系客服", async () => {
  const ctx = await boot({ supportUrl: "https://t.me/example_support" });
  try {
    const { player, ack } = await import("../testlib/helpers.js");
    const rich = await player(ctx, "有钱人");
    const r = await ack(rich, "create", {});
    const poor = await player(ctx, "没钱人", 0);
    assert.equal(poor.user.balance, 0);
    const me = (await api(ctx, "GET", "/api/me", null, poor.token)).data;
    assert.equal(me.supportUrl, "https://t.me/example_support", "客服链接通过 /api/me 下发");
    const c = await ack(poor, "create", {});
    assert.equal(c.ok, false); assert.match(c.error, /余额不足，请联系客服获取游戏币/); assert.equal(c.noChips, true);
    const j = await ack(poor, "join", { code: r.code });
    assert.equal(j.ok, false); assert.match(j.error, /请联系客服获取游戏币/);
    assert.equal((await ctx.store.getUser(poor.user.id)).balance, 0);
  } finally { await ctx.close(); }
});

test("管理员账号由环境变量创建，重启时更新密码", async () => {
  const ctx = await boot({ adminUsername: "boss", adminPassword: "first-pass" });
  try {
    const l = await login(ctx, "boss", "first-pass");
    assert.equal(l.status, 200); assert.equal(l.data.user.isAdmin, true);
  } finally { await ctx.close(); }
  // 同一个存储再次启动，换新密码
  const { createApp } = await import("../server.js");
  const ctx2 = await createApp({ store: ctx.store, quiet: true, bcryptRounds: 4, adminUsername: "boss", adminPassword: "second-pass" });
  await new Promise((r) => ctx2.server.listen(0, r)); ctx2.url = "http://localhost:" + ctx2.server.address().port;
  try {
    assert.equal((await login(ctx2, "boss", "first-pass")).status, 401);
    assert.equal((await login(ctx2, "boss", "second-pass")).status, 200);
  } finally { ctx2.io.close(); ctx2.server.close(); }
});
