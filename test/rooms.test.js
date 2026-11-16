import test from "node:test";
import assert from "node:assert/strict";
import { io as ioc } from "socket.io-client";
import { createApp } from "../server.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, msg = "超时") { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error(msg); await wait(20); } }
const client = (url) => { const s = ioc(url, { transports: ["websocket"], forceNew: true, reconnection: false }); s.on("state", (v) => (s.last = v)); return s; };
const ack = (s, ev, data) => new Promise((r) => (data === undefined ? s.emit(ev, r) : s.emit(ev, data, r)));
async function boot(opts = {}) {
  const ctx = createApp({ botDelay: [5, 10], nextHandDelay: 60000, listDebounceMs: 10, ...opts });
  await new Promise((r) => ctx.server.listen(0, r));
  ctx.url = "http://localhost:" + ctx.server.address().port;
  return ctx;
}
const close = (ctx, cs) => { cs.forEach((c) => c.disconnect()); ctx.io.close(); ctx.server.close(); };

test("公开房间出现在列表里并实时更新；私密房间不出现但可凭房间码加入", async () => {
  const ctx = await boot(); const cs = [];
  try {
    const watcher = client(ctx.url); cs.push(watcher);
    let live = null; watcher.on("rooms", (l) => (live = l));
    assert.deepEqual(await ack(watcher, "watchRooms"), []);

    const host = client(ctx.url); cs.push(host);
    const pub = await ack(host, "create", { name: "Laura", cfg: { start: 2000, sb: 25, bb: 50 } }); // 默认公开
    const priv = client(ctx.url); cs.push(priv);
    const pr = await ack(priv, "create", { name: "小周", cfg: { public: false } });

    await until(() => live && live.length === 1, 3000, "列表没有实时推送");
    assert.equal(live[0].code, pub.code);
    assert.deepEqual({ host: live[0].host, seats: live[0].seats, maxSeats: live[0].maxSeats, sb: live[0].sb, bb: live[0].bb, start: live[0].start, status: live[0].status, full: live[0].full },
      { host: "Laura", seats: 1, maxSeats: 9, sb: 25, bb: 50, start: 2000, status: "等待中", full: false });

    // HTTP 接口和刷新按钮用的 listRooms 结果一致，也不含私密房间
    const httpList = await (await fetch(ctx.url + "/api/rooms")).json();
    assert.deepEqual(httpList.map((r) => r.code), [pub.code]);
    assert.deepEqual((await ack(watcher, "listRooms")).map((r) => r.code), [pub.code]);

    // 私密房间凭房间码可以加入
    const friend = client(ctx.url); cs.push(friend);
    const j = await ack(friend, "join", { code: pr.code, name: "朋友" });
    assert.ok(j.ok);
    assert.ok(!(await ack(watcher, "listRooms")).some((r) => r.code === pr.code));

    // 加电脑玩家、开始游戏后，人数和状态实时变化
    host.emit("addBot"); host.emit("addBot");
    await until(() => live[0] && live[0].seats === 3);
    host.emit("start");
    await until(() => live[0] && live[0].status === "游戏中", 3000, "状态没有变成游戏中");
  } finally { close(ctx, cs); }
});

test("满 9 人显示已满且不能加入", async () => {
  const ctx = await boot(); const cs = [];
  try {
    const host = client(ctx.url); cs.push(host);
    const r = await ack(host, "create", { name: "房主" });
    for (let i = 0; i < 8; i++) host.emit("addBot");
    await until(async () => { const l = await ack(host, "listRooms"); return l[0] && l[0].seats === 9; });
    const l = await ack(host, "listRooms");
    assert.equal(l[0].full, true);
    const c = client(ctx.url); cs.push(c);
    const j = await ack(c, "join", { code: r.code, name: "迟到" });
    assert.equal(j.ok, false); assert.match(j.error, /满/);
  } finally { close(ctx, cs); }
});

test("没有真人在线的房间从列表消失，几分钟后被清理", async () => {
  const ctx = await boot({ emptyRoomMs: 300, sweepMs: 50 }); const cs = [];
  try {
    const watcher = client(ctx.url); cs.push(watcher);
    let live = null; watcher.on("rooms", (l) => (live = l)); await ack(watcher, "watchRooms");
    const host = client(ctx.url);
    const r = await ack(host, "create", { name: "要走的人" });
    host.emit("addBot");
    await until(() => live && live.length === 1);
    host.disconnect();
    await until(() => live && live.length === 0, 3000, "掉线后房间仍在列表里");
    assert.ok(ctx.rooms.has(r.code), "宽限期内房间还在（可以刷新重连）");
    await until(() => !ctx.rooms.has(r.code), 3000, "空房间没有被清理");

    // 宽限期内重连回来，房间不会被清理
    const h2 = client(ctx.url); cs.push(h2);
    const r2 = await ack(h2, "create", { name: "会回来的人" });
    h2.disconnect();
    await wait(150);
    const back = client(ctx.url); cs.push(back);
    assert.ok((await ack(back, "join", { code: r2.code, name: "x", token: r2.token })).ok);
    await wait(500);
    assert.ok(ctx.rooms.has(r2.code));
    assert.equal(live.length, 1);
  } finally { close(ctx, cs); }
});
