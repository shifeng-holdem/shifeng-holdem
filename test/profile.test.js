import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../db.js";
import { boot, api, register, login, player, ack, until, adminToken } from "../testlib/helpers.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const png = Buffer.concat([PNG, Buffer.alloc(200)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300)]);
const upload = (ctx, token, buf, type) => fetch(ctx.url + "/api/me/avatar", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": type }, body: buf });

test("玩家 ID：从 10001 起按注册顺序分配，庄家账户没有 ID，管理员可以按 ID 搜索", async () => {
  const ctx = await boot();
  try {
    const boss = await ctx.store.getUserByName("boss");
    const a = await register(ctx, "甲玩家"), b = await register(ctx, "乙玩家");
    assert.equal(boss.publicId, 10001);
    assert.equal(a.user.publicId, 10002); assert.equal(b.user.publicId, 10003);
    assert.equal((await ctx.store.getUser(ctx.houseId)).publicId, null);
    assert.equal((await api(ctx, "GET", "/api/me", null, b.token)).data.publicId, 10003);
    const adm = await adminToken(ctx);
    const r = await api(ctx, "GET", "/api/admin/users?q=10002", null, adm);
    assert.deepEqual(r.data.map((u) => [u.publicId, u.username]), [[10002, "甲玩家"]]);
  } finally { await ctx.close(); }
});

test("玩家 ID 补发：老账号按注册顺序补 ID，重启后不变，新账号接着往后排", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-")); const file = path.join(dir, "db.json");
  const old = { seq: 4, users: [
    { id: 1, username: "__house__", passHash: "!", balance: 0, isHouse: true },
    { id: 2, username: "boss", passHash: "x", balance: 0, isAdmin: true },
    { id: 3, username: "pengc11", passHash: "x", balance: 5000 },
    { id: 4, username: "老玩家", passHash: "x", balance: 0 },
  ], ledger: [], sessions: {}, settings: {} };
  fs.writeFileSync(file, JSON.stringify(old));
  let s = await openStore({ dataFile: file });
  assert.equal((await s.getUserByName("boss")).publicId, 10001);
  assert.equal((await s.getUserByName("pengc11")).publicId, 10002);
  assert.equal((await s.getUserByName("老玩家")).publicId, 10003);
  assert.equal((await s.getUserByName("__house__")).publicId, null);
  await s.close();
  s = await openStore({ dataFile: file });
  assert.equal((await s.getUserByName("pengc11")).publicId, 10002, "重启后不变");
  const n = await s.createUser("新玩家", "x", 0); assert.equal(n.publicId, 10004);
  await s.close();
  if (process.env.TEST_DATABASE_URL) { // Postgres：模拟老库里没有 ID 的账号
    const pg = await openStore({ databaseUrl: process.env.TEST_DATABASE_URL, schema: "t_bf" + Date.now().toString(36) });
    const u1 = await pg.createUser("先来", "x", 0), u2 = await pg.createUser("后到", "x", 0);
    await pg.q(`UPDATE users SET public_id = NULL WHERE id = $1`, [u2.id]);
    await pg.backfillPublicIds();
    assert.equal((await pg.getUser(u1.id)).publicId, 10001);
    const p2 = (await pg.getUser(u2.id)).publicId; assert.ok(p2 > 10001, "补发的 ID 不会和已有的重复");
    assert.equal((await pg.createUser("再来", "x", 0)).publicId, p2 + 1);
    await pg.backfillPublicIds(); assert.equal((await pg.getUser(u2.id)).publicId, p2, "再跑一次不变");
    await pg.close();
  }
});

test("头像：类型和大小校验、上传后可访问并带缓存头、默认头像、删除", async () => {
  const ctx = await boot();
  try {
    const a = await register(ctx, "头像玩家"); const pid = a.user.publicId;
    assert.equal((await upload(ctx, "", png, "image/png")).status, 401);
    const def = await fetch(`${ctx.url}/api/avatar/${pid}`);
    assert.equal(def.status, 200); assert.match(def.headers.get("content-type"), /svg/); assert.match(await def.text(), /头/);
    assert.equal((await upload(ctx, a.token, Buffer.from("hello world ".repeat(20)), "text/plain")).status, 415, "不是图片");
    assert.equal((await upload(ctx, a.token, jpg, "image/png")).status, 415, "声明类型和内容不符");
    assert.equal((await upload(ctx, a.token, Buffer.alloc(10), "image/png")).status, 400, "太小/空");
    const big = Buffer.concat([PNG, Buffer.alloc(400 * 1024)]);
    const r413 = await upload(ctx, a.token, big, "image/png"); assert.equal(r413.status, 413); assert.match((await r413.json()).error, /太大/);
    const ok = await upload(ctx, a.token, png, "image/png"); assert.equal(ok.status, 200); assert.equal((await ok.json()).avatarVer, 1);
    const img = await fetch(`${ctx.url}/api/avatar/${pid}?v=1`);
    assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/png"); assert.match(img.headers.get("cache-control"), /max-age=31536000/);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
    const again = await fetch(`${ctx.url}/api/avatar/${pid}?v=1`, { headers: { "if-none-match": img.headers.get("etag") } }); assert.equal(again.status, 304);
    const ok2 = await upload(ctx, a.token, jpg, "image/jpeg"); assert.equal((await ok2.json()).avatarVer, 2);
    assert.equal((await api(ctx, "GET", "/api/me", null, a.token)).data.avatarVer, 2);
    assert.equal((await fetch(`${ctx.url}/api/avatar/${pid}?v=2`)).headers.get("content-type"), "image/jpeg");
    assert.equal((await api(ctx, "DELETE", "/api/me/avatar", null, a.token)).data.avatarVer, 0);
    assert.match((await fetch(`${ctx.url}/api/avatar/${pid}`)).headers.get("content-type"), /svg/);
    assert.equal((await fetch(`${ctx.url}/api/avatar/99999999`)).status, 404);
  } finally { await ctx.close(); }
});

test("修改密码：需要原密码，成功后旧令牌失效、新密码可以登录", async () => {
  const ctx = await boot();
  try {
    const a = await register(ctx, "改密玩家", "oldpass1");
    assert.equal((await api(ctx, "POST", "/api/me/password", { oldPassword: "wrong!!", newPassword: "newpass1" }, a.token)).status, 400);
    assert.match((await api(ctx, "POST", "/api/me/password", { oldPassword: "oldpass1", newPassword: "123" }, a.token)).data.error, /至少 6 位/);
    const r = await api(ctx, "POST", "/api/me/password", { oldPassword: "oldpass1", newPassword: "newpass1" }, a.token);
    assert.equal(r.status, 200); assert.ok(r.data.token);
    assert.equal((await api(ctx, "GET", "/api/me", null, a.token)).status, 401, "旧令牌失效");
    assert.equal((await api(ctx, "GET", "/api/me", null, r.data.token)).status, 200, "本机新令牌可用");
    assert.equal((await login(ctx, "改密玩家", "oldpass1")).status, 401);
    assert.equal((await login(ctx, "改密玩家", "newpass1")).status, 200);
  } finally { await ctx.close(); }
});

test("个人中心：德州战绩（每手只记一次）和麻将战绩", async () => {
  const ctx = await boot();
  try {
    const a = await player(ctx, "战绩甲"), b = await player(ctx, "战绩乙");
    const r = await ack(a, "create", { cfg: { start: 1000, sb: 10, bb: 20 } }); await ack(b, "join", { code: r.code });
    a.emit("start"); await until(() => a.last && a.last.game && a.last.game.legal !== undefined && (a.last.game.legal || b.last.game.legal));
    const s = a.last.game.legal ? a : b; s.emit("action", { type: "fold" });
    await until(() => a.last.game.stage === "handover"); await ctx.idle();
    a.emit("sitOut", true); await new Promise((res) => setTimeout(res, 100)); await ctx.idle();
    const pa = (await api(ctx, "GET", "/api/me/profile", null, a.token)).data, pb = (await api(ctx, "GET", "/api/me/profile", null, b.token)).data;
    assert.equal(pa.poker.handsPlayed, 1); assert.equal(pb.poker.handsPlayed, 1);
    assert.equal(pa.poker.handsWon + pb.poker.handsWon, 1);
    assert.ok(Math.max(pa.poker.best, pb.poker.best) > 0);
    await api(ctx, "POST", "/api/mahjong/spin", { bet: 50 }, a.token);
    const p2 = (await api(ctx, "GET", "/api/me/profile", null, a.token)).data;
    assert.equal(p2.mahjong.spins, 1); assert.equal(p2.publicId, a.user.publicId); assert.ok(p2.createdAt);
    assert.doesNotMatch(JSON.stringify(p2), /充值|提现/);
  } finally { await ctx.close(); }
});
