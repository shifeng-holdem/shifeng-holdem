import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { boot, api, register, login } from "../testlib/helpers.js";

test("注册、登录、会话、校验", async () => {
  const ctx = await boot();
  try {
    const r = await register(ctx, "Laura", "pass1234");
    assert.equal(r.user.username, "Laura"); assert.equal(r.user.balance, 10000); assert.equal(r.user.isAdmin, false);
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

test("每日免费领取：一天一次，金额由后台设置", async () => {
  const ctx = await boot();
  try {
    const { token } = await register(ctx, "每天来");
    const c1 = await api(ctx, "POST", "/api/claim", null, token);
    assert.equal(c1.status, 200); assert.equal(c1.data.amount, 2000); assert.equal(c1.data.balance, 12000);
    assert.equal((await api(ctx, "POST", "/api/claim", null, token)).status, 409);
    const me = await api(ctx, "GET", "/api/me", null, token);
    assert.equal(me.data.canClaim, false);
    const ledger = await api(ctx, "GET", "/api/me/ledger", null, token);
    assert.deepEqual(ledger.data.map((x) => x.reason), ["每日免费领取", "注册赠送"]);
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
