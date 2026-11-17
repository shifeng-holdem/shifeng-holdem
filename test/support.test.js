// 客服消息：玩家 ↔ 管理员实时聊天，存数据库；限速、长度上限、原文存储（显示时转义）
import test from "node:test";
import assert from "node:assert/strict";
import { boot, api, player, until, wait, adminToken, client } from "../testlib/helpers.js";

test("客服消息：玩家发、后台实时收到并回复，玩家实时收到；历史记录；未读数；限速和长度", async () => {
  const ctx = await boot({ chatGapMs: 300 });
  try {
    const at = await adminToken(ctx);
    const adm = client(ctx, at); const got = []; adm.on("support:new", (m) => got.push(m));
    await until(() => adm.connected); adm.emit("adminWatch"); await wait(50);
    const p = await player(ctx, "求助的人"); const live = []; p.on("support:msg", (m) => live.push(m));
    await until(() => p.connected);
    // 普通玩家不能进管理员频道
    const spy = await player(ctx, "偷看的人"); const leak = []; spy.on("support:new", (m) => leak.push(m)); await until(() => spy.connected); spy.emit("adminWatch"); await wait(50);
    let r = await api(ctx, "POST", "/api/support/messages", { body: "  你好，<b>我要</b>游戏币 \u0007 " }, p.token);
    assert.equal(r.status, 200); assert.equal(r.data.message.body, "你好，<b>我要</b>游戏币", "原文保存（去掉控制字符和首尾空白），显示时由前端转义");
    await until(() => got.length === 1 && live.length === 1);
    assert.equal(got[0].username, "求助的人"); assert.equal(got[0].publicId, p.user.publicId); assert.equal(leak.length, 0, "普通玩家收不到别人的客服消息");
    // 限速 / 长度 / 空消息
    assert.equal((await api(ctx, "POST", "/api/support/messages", { body: "太快" }, p.token)).status, 429);
    await wait(320);
    assert.equal((await api(ctx, "POST", "/api/support/messages", { body: "字".repeat(501) }, p.token)).status, 400);
    assert.equal((await api(ctx, "POST", "/api/support/messages", { body: "   " }, p.token)).status, 400);
    assert.equal((await api(ctx, "POST", "/api/support/messages", { body: "字".repeat(500) }, p.token)).status, 200);
    assert.equal((await api(ctx, "POST", "/api/support/messages", { body: "x" })).status, 401);
    // 后台会话列表：未读数
    let conv = (await api(ctx, "GET", "/api/admin/support", null, at)).data;
    assert.equal(conv.length, 1); assert.equal(conv[0].unread, 2); assert.equal(conv[0].publicId, p.user.publicId); assert.equal(conv[0].username, "求助的人");
    assert.equal((await api(ctx, "GET", "/api/admin/support", null, p.token)).status, 403);
    const open = (await api(ctx, "GET", `/api/admin/support/${p.user.id}`, null, at)).data;
    assert.equal(open.list.length, 2);
    conv = (await api(ctx, "GET", "/api/admin/support", null, at)).data; assert.equal(conv[0].unread, 0, "打开后清零");
    // 管理员回复：玩家实时收到，未读 +1；玩家打开历史后清零
    r = await api(ctx, "POST", `/api/admin/support/${p.user.id}`, { body: "您好，已为您处理" }, at);
    assert.equal(r.status, 200);
    await until(() => live.length === 3 && live[2].fromAdmin === true);
    assert.equal((await api(ctx, "GET", "/api/support/unread", null, p.token)).data.unread, 1);
    const hist = (await api(ctx, "GET", "/api/support/messages", null, p.token)).data.list;
    assert.deepEqual(hist.map((m) => m.fromAdmin), [false, false, true]);
    assert.equal((await api(ctx, "GET", "/api/support/unread", null, p.token)).data.unread, 0);
    // 别人看不到这段对话
    assert.equal((await api(ctx, "GET", "/api/support/messages", null, spy.token)).data.list.length, 0);
    assert.equal((await api(ctx, "POST", `/api/admin/support/999999`, { body: "x" }, at)).status, 404);
  } finally { await ctx.close(); }
});
