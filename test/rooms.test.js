import test from "node:test";
import assert from "node:assert/strict";
import { boot, player, client, ack, until, wait } from "../testlib/helpers.js";

test("公开房间出现在列表里并实时更新；私密房间不出现但可凭房间码加入", async () => {
  const ctx = await boot();
  try {
    const watcher = await player(ctx, "看客");
    let live = null; watcher.on("rooms", (l) => (live = l));
    assert.deepEqual(await ack(watcher, "watchRooms"), []);
    const host = await player(ctx, "Laura");
    const pub = await ack(host, "create", { cfg: { start: 2000, sb: 25, bb: 50 } });
    const priv = await player(ctx, "小周");
    const pr = await ack(priv, "create", { cfg: { public: false } });
    await until(() => live && live.length === 1, 3000, "列表没有实时推送");
    assert.equal(live[0].code, pub.code);
    assert.deepEqual({ host: live[0].host, seats: live[0].seats, maxSeats: live[0].maxSeats, sb: live[0].sb, bb: live[0].bb, start: live[0].start, status: live[0].status, full: live[0].full },
      { host: "Laura", seats: 1, maxSeats: 9, sb: 25, bb: 50, start: 2000, status: "等待中", full: false });
    const httpList = await (await fetch(ctx.url + "/api/rooms")).json();
    assert.deepEqual(httpList.map((r) => r.code), [pub.code]);
    assert.deepEqual((await ack(watcher, "listRooms")).map((r) => r.code), [pub.code]);
    const friend = await player(ctx, "朋友");
    assert.ok((await ack(friend, "join", { code: pr.code })).ok);
    assert.ok(!(await ack(watcher, "listRooms")).some((r) => r.code === pr.code));
    await ctx.addBot(pub.code); await ctx.addBot(pub.code);
    await until(() => live[0] && live[0].seats === 3);
    host.emit("start");
    await until(() => live[0] && live[0].status === "游戏中", 3000, "状态没有变成游戏中");
  } finally { await ctx.close(); }
});

test("满 9 人显示已满；真人加入时补位玩家让座", async () => {
  const ctx = await boot();
  try {
    const host = await player(ctx, "房主");
    const r = await ack(host, "create", {});
    for (let i = 0; i < 8; i++) await ctx.addBot(r.code);
    await until(async () => { const l = await ack(host, "listRooms"); return l[0] && l[0].seats === 9; });
    assert.equal((await ack(host, "listRooms"))[0].full, true);
    const c = await player(ctx, "迟到");
    const j = await ack(c, "join", { code: r.code });
    assert.equal(j.ok, true, "补位玩家让出座位"); assert.equal(ctx.rooms.get(r.code).members.filter((m) => !m.left).length, 9);
    assert.equal(ctx.rooms.get(r.code).members.filter((m) => !m.left && m.bot).length, 7);
  } finally { await ctx.close(); }
});

test("没有真人在线的房间从列表消失，过一段时间被清理并返还筹码", async () => {
  const ctx = await boot({ emptyRoomMs: 300, sweepMs: 50 });
  try {
    const watcher = await player(ctx, "看客");
    let live = null; watcher.on("rooms", (l) => (live = l)); await ack(watcher, "watchRooms");
    const host = await player(ctx, "要走的人");
    const r = await ack(host, "create", {});
    await ctx.addBot(r.code);
    await until(() => live && live.length === 1);
    assert.equal((await ctx.store.getUser(host.user.id)).balance, 10000 - 1000);
    host.disconnect();
    await until(() => live && live.length === 0, 3000, "掉线后房间仍在列表里");
    assert.ok(ctx.rooms.has(r.code), "宽限期内房间还在（可以刷新重连）");
    await until(() => !ctx.rooms.has(r.code), 3000, "空房间没有被清理");
    await ctx.idle();
    assert.equal((await ctx.store.getUser(host.user.id)).balance, 10000, "清理时筹码返还到余额");

    const h2 = await player(ctx, "会回来的人");
    const r2 = await ack(h2, "create", {});
    h2.disconnect(); await wait(150);
    const back = client(ctx, h2.token);
    assert.ok((await ack(back, "join", { code: r2.code })).ok);
    await wait(500);
    assert.ok(ctx.rooms.has(r2.code));
    assert.equal(live.length, 1);
  } finally { await ctx.close(); }
});
