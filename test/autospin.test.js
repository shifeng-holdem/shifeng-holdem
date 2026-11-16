import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { boot, api, player } from "../testlib/helpers.js";

const load = () => { const ctx = {}; vm.runInNewContext(fs.readFileSync(new URL("../public/mj-auto.js", import.meta.url), "utf8"), { window: ctx }); return ctx.MJAuto; };

test("自动转：次数递减、无限、各种停止条件", () => {
  const A = load();
  assert.deepEqual([...A.COUNTS], [10, 30, 50, 100, Infinity]);
  assert.throws(() => A.create(7));
  const a = A.create(10);
  const ok = { balance: 5000, bet: 100, win: 0 };
  for (let i = 0; i < 9; i++) { A.consume(a); assert.equal(A.afterSpin(a, ok), null); }
  A.consume(a); assert.equal(a.left, 0); assert.equal(A.afterSpin(a, ok), "自动转完成"); assert.equal(a.done, 10);
  const inf = A.create(Infinity); for (let i = 0; i < 500; i++) A.consume(inf);
  assert.equal(A.afterSpin(inf, ok), null); assert.equal(A.label(inf), "∞");
  assert.match(A.afterSpin(A.create(30), { balance: 50, bet: 100, win: 0 }), /余额不足，请联系客服获取游戏币/);
  assert.match(A.afterSpin(A.create(30), { ...ok, error: true }), /出错/);
  assert.match(A.afterSpin(A.create(30), { ...ok, hidden: true }), /离开/);
  assert.match(A.afterSpin(A.create(30), { ...ok, left: true }), /离开/);
  assert.match(A.afterSpin(A.create(30, { winOver: 1000 }), { ...ok, win: 1500 }), /单次赢得 1,500/);
  assert.equal(A.afterSpin(A.create(30, { winOver: 1000 }), { ...ok, win: 1000 }), null, "等于不算超过");
  assert.match(A.afterSpin(A.create(30, { balUnder: 6000 }), ok), /余额低于 6,000/);
  const s = A.create(50); s.stopReq = true; assert.equal(A.afterSpin(s, ok), "自动已停止");
  assert.equal(A.canStart({ balance: 99, bet: 100 }), "余额不足，请联系客服获取游戏币");
});

test("自动转：客户端逐局调用 /spin，余额不足时自动停下且不会变负", async () => {
  const A = load();
  const ctx = await boot();
  try {
    const p = await player(ctx, "自动玩家", 300);
    const a = A.create(Infinity); let balance = 300, reason = null, calls = 0;
    while (!reason) {
      A.consume(a); calls++;
      const r = await api(ctx, "POST", "/api/mahjong/spin", { bet: 100 }, p.token);
      assert.equal(r.status, 200, "余额够的时候每一局都能结算");
      balance = r.data.balance; assert.ok(balance >= 0);
      reason = A.afterSpin(a, { balance, bet: 100, win: r.data.win });
      assert.ok(calls < 5000);
    }
    assert.match(reason, /余额不足/); assert.ok(balance < 100);
    const h = await api(ctx, "GET", "/api/mahjong/history", null, p.token);
    assert.equal(h.data.totals.spins, calls, "每次自动转都是一条单独的记录");
  } finally { await ctx.close(); }
});

test("页面带自动转与声音：原创合成音乐，没有外部音频文件", async () => {
  const ctx = await boot();
  try {
    const html = await (await fetch(ctx.url + "/")).text();
    for (const f of ["/sound.js", "/mj-auto.js", "/mahjong.js"]) { assert.match(html, new RegExp(f.replace(".", "\\."))); assert.equal((await fetch(ctx.url + f)).status, 200); }
    assert.match(html, /id="mjAutoBtn"/); assert.match(html, /class="sndgrp"/);
    const snd = await (await fetch(ctx.url + "/sound.js")).text();
    assert.match(snd, /AudioContext/); assert.doesNotMatch(snd, /https?:\/\//i, "不引用任何外部音频");
    assert.match(snd, /pointerdown/, "第一次点击后才启动音频");
  } finally { await ctx.close(); }
});

test("配音文件都在 public/voice/ 里并能正常访问", async () => {
  const ctx = await boot();
  try {
    const snd = await (await fetch(ctx.url + "/sound.js")).text();
    const want = ["hall_welcome", "pk_turn", "pk_check", "pk_call", "pk_raise", "pk_allin", "pk_fold", "pk_deal", "pk_flop", "pk_turncard", "pk_river", "pk_youwin", "pk_showdown",
      "mj_start", "mj_hu", "mj_combo", "mj_c2", "mj_c3", "mj_c4", "mj_c5", "mj_c6", "mj_c10", "mj_free", "mj_big", "mj_super", "mj_nochips"];
    let total = 0;
    for (const id of want) {
      assert.match(snd, new RegExp(`\\b${id}: "`), "sound.js 里有 " + id);
      const r = await fetch(`${ctx.url}/voice/${id}.mp3`);
      assert.equal(r.status, 200, id); assert.match(r.headers.get("content-type"), /audio\/mpeg/);
      const b = Buffer.from(await r.arrayBuffer()); total += b.length;
      assert.ok(b.length > 1000 && b.length < 20000, `${id} 大小 ${b.length}`);
      assert.ok(b[0] === 0xff || b.slice(0, 3).toString() === "ID3", id + " 是 mp3");
    }
    assert.ok(total < 200000, "全部配音加起来很小：" + total);
  } finally { await ctx.close(); }
});
