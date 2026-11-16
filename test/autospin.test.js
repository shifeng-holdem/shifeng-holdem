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
    assert.match(snd, /AudioContext/); assert.doesNotMatch(snd, /\.(mp3|ogg|wav|m4a)\b|https?:\/\//i);
    assert.match(snd, /pointerdown/, "第一次点击后才启动音频");
  } finally { await ctx.close(); }
});
