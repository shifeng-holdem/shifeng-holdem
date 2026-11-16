import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as E from "../engine.js";
import { openStore } from "../db.js";
import { boot, api, register, adminToken } from "../testlib/helpers.js";

const C = (s) => "shdc".indexOf(s[1]) * 13 + "23456789TJQKA".indexOf(s[0]);
const deckFor = (order) => { const used = new Set(order); const rest = []; for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c); return [...rest, ...order.slice().reverse()]; };

test("金额格式：整数分 → 两位小数和千分位", () => {
  assert.equal(E.money(100000), "1,000.00"); assert.equal(E.money(1250), "12.50"); assert.equal(E.money(5), "0.05");
  assert.equal(E.money(123456789), "1,234,567.89"); assert.equal(E.money(-30), "-0.30"); assert.equal(E.money(0), "0.00");
  // 整数分相加没有浮点误差：0.10 + 0.20 = 0.30
  assert.equal(E.money(10 + 20), "0.30");
});

test("平分底池按分计算：零头一分一分给庄家左边的赢家，总数不变", () => {
  const g0 = E.newGame(["A", "B", "C", "D"].map((name) => ({ name, bot: false })), { start: 100000, sb: 5, bb: 11 });
  g0.stage = "handover"; g0.dealer = 3; g0.players.forEach((p) => (p.chips = 100000));
  const holes = ["2c", "3c", "4c", "5c", "2d", "3d", "4d", "5d"].map(C);
  const order = [...holes, C("9h"), C("As"), C("Ks"), C("Qs"), C("8h"), C("Js"), C("9c"), C("Ts")];
  let g = E.startHand(g0, false, deckFor(order));
  const sb = g.sb;
  while (g.stage === "preflop") { const L = E.legal(g, g.current); g = E.act(g, g.current === sb ? { type: "fold" } : L.check ? { type: "check" } : { type: "call" }); }
  while (g.stage !== "handover") g = E.act(g, { type: "check" });
  const won = g.players.filter((p, i) => i !== sb).map((p) => p.won).sort((a, b) => a - b);
  assert.deepEqual(won, [12, 13, 13], "底池 0.38 三人平分：0.12 / 0.13 / 0.13");
  assert.equal(g.players.reduce((s, p) => s + p.chips, 0), 400000);
});

test("金额迁移：老数据 ×100 只做一次（重复启动不会再乘）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfc-")); const file = path.join(dir, "db.json");
  fs.writeFileSync(file, JSON.stringify({ seq: 2, users: [{ id: 1, username: "__house__", passHash: "!", balance: -50, isHouse: true }, { id: 2, username: "pengc11", passHash: "x", balance: 1000 }],
    ledger: [{ userId: 2, delta: 1000, balanceAfter: 1000, reason: "管理员赠送", actor: "boss", at: 1 }], sessions: {}, settings: {},
    slotSpins: [{ id: 1, userId: 2, game: "mahjong", bet: 10, win: 25, freeSpins: 0, balanceAfter: 1015, at: 1 }], slotTotals: { mahjong: { spins: 1, bets: 10, wins: 25, features: 0, best: 25 } } }));
  let s = await openStore({ dataFile: file });
  assert.equal((await s.getUserByName("pengc11")).balance, 100000, "1000 → 1,000.00");
  assert.equal(E.money((await s.getUserByName("pengc11")).balance), "1,000.00");
  assert.equal((await s.getUserByName("__house__")).balance, -5000);
  assert.equal((await s.ledger(2))[0].delta, 100000);
  assert.equal((await s.slotTotals("mahjong")).bets, 1000);
  assert.equal(await s.migrateCents(), false, "再调用一次不会重复迁移");
  await s.close();
  s = await openStore({ dataFile: file });
  assert.equal((await s.getUserByName("pengc11")).balance, 100000, "重启后不变");
  assert.equal((await s.slotHistory(2, "mahjong"))[0].win, 2500);
  await s.close();
  if (process.env.TEST_DATABASE_URL) {
    const pg = await openStore({ databaseUrl: process.env.TEST_DATABASE_URL, schema: "t_c" + Date.now().toString(36) });
    const u = await pg.createUser("pengc11", "x", 0);
    await pg.q(`UPDATE users SET balance = 1000 WHERE id=$1`, [u.id]); await pg.q(`DELETE FROM settings WHERE key='amountsInCents'`); // 模拟老库
    assert.equal(await pg.migrateCents(), true); assert.equal(await pg.migrateCents(), false);
    assert.equal((await pg.getUser(u.id)).balance, 100000);
    await pg.close();
  }
});

test("后台赠送 12.50（按分传 1250）；新账号默认 0.00", async () => {
  const ctx = await boot();
  try {
    const z = await register(ctx, "小数玩家"); const adm = await adminToken(ctx);
    const r = await api(ctx, "POST", `/api/admin/users/${z.user.id}/adjust`, { delta: 1250 }, adm);
    assert.equal(r.data.balance, 1250); assert.equal(E.money(r.data.balance), "12.50");
    const s = await api(ctx, "POST", "/api/mahjong/spin", { bet: 50 }, z.token);
    assert.equal(s.data.balance, 1250 - 50 + s.data.win); assert.ok(Number.isInteger(s.data.win));
    const led = await api(ctx, "GET", "/api/me/ledger", null, z.token); assert.match(led.data[0].reason, /下注 0\.50/);
  } finally { await ctx.close(); }
});
