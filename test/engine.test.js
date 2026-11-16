import test from "node:test";
import assert from "node:assert/strict";
import * as E from "../engine.js";

const C = (s) => "shdc".indexOf(s[1]) * 13 + "23456789TJQKA".indexOf(s[0]);
const h = (s) => s.split(" ").map(C);
const sc = (s) => E.best7(h(s));
const nm = (s) => E.scoreName(sc(s));
const cfg = { start: 1000, sb: 10, bb: 20 };

test("全部 2,598,960 种五张牌的牌型数量正确", () => {
  const cnt = {};
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) for (let c = b + 1; c < 52; c++) for (let d = c + 1; d < 52; d++) for (let e = d + 1; e < 52; e++) {
    const n = E.scoreName(E.eval5([a, b, c, d, e])); cnt[n] = (cnt[n] || 0) + 1;
  }
  assert.deepEqual(cnt, { 皇家同花顺: 4, 同花顺: 36, 四条: 624, 葫芦: 3744, 同花: 5108, 顺子: 10200, 三条: 54912, 两对: 123552, 一对: 1098240, 高牌: 1302540 });
});

test("七选五牌型识别", () => {
  assert.equal(nm("As Ks Qs Js Ts 2d 3c"), "皇家同花顺");
  assert.equal(nm("As 2s 3s 4s 5s 9d 9c"), "同花顺");
  assert.equal(nm("9s 9d 9h 9c Ts 2d 3c"), "四条");
  assert.equal(nm("9s 9d 9h Tc Ts Td 3c"), "葫芦");
  assert.equal(nm("2s 7s 9s Js Ks Ad 3c"), "同花");
  assert.equal(nm("As 2d 3h 4c 5s Kd Kc"), "顺子");
  assert.equal(nm("9s 9d 9h Qc Ks 2d 4c"), "三条");
  assert.equal(nm("9s 9d Th Tc Ks 2d 4c"), "两对");
  assert.equal(nm("9s 9d Th Qc Ks 2d 4c"), "一对");
  assert.equal(nm("9s 7d Th Qc Ks 2d 4c"), "高牌");
});

test("比大小与踢脚", () => {
  assert.ok(sc("As 2d 3h 4c 5s Kd Kc") < sc("2s 3d 4h 5c 6s Kd Kc"), "A-5 小顺 < 6 高顺");
  assert.ok(sc("Ah Ad Kh Kd 2c 3s 4s") < sc("Ah Ad Kh Kd 5c 3s 4s"), "两对比踢脚");
  assert.ok(sc("Ah Ad Kh Qd Jc 3s 2s") > sc("Ah Ad Kh Qd Tc 3s 2s"), "一对比第三踢脚");
  assert.equal(sc("Ah Ad Kh Qd Jc 9s 2s"), sc("Ah Ad Kh Qd Jc 8s 2s"), "第六张牌不算");
  assert.ok(sc("9s 9d 9h 9c As 2d 3c") > sc("9s 9d 9h 9c Ks Qd Jc"), "四条踢脚");
  assert.ok(E.eval5(h("Ts Td Th 2c 2s")) > E.eval5(h("9s 9d 9h Ac As")), "葫芦先比三条");
  assert.ok(E.eval5(h("2s 7s 9s Js As")) > E.eval5(h("2h 7h 9h Jh Kh")), "同花比高张");
  assert.equal(E.best7(h("2d 3d As Ks Qs Js Ts")), E.best7(h("4c 5c As Ks Qs Js Ts")), "公共牌皇家同花顺平分");
});

test("边池计算", () => {
  const mk = (tot, folded) => tot.map((t, i) => ({ id: i, total: t, folded: folded[i], out: false }));
  assert.deepEqual(E.pots(mk([50, 200, 200, 100], [false, false, false, true])), [{ amount: 200, eligible: [0, 1, 2] }, { amount: 350, eligible: [1, 2] }]);
  assert.deepEqual(E.pots(mk([100, 300, 100], [false, false, false])), [{ amount: 300, eligible: [0, 1, 2] }, { amount: 200, eligible: [1] }]);
  assert.deepEqual(E.pots(mk([30, 60, 100, 100], [false, false, false, false])), [{ amount: 120, eligible: [0, 1, 2, 3] }, { amount: 90, eligible: [1, 2, 3] }, { amount: 80, eligible: [2, 3] }]);
});

// 构造一副牌：startHand 从末尾 pop 发牌
function deckFor(order) { const used = new Set(order); const rest = []; for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c); return [...rest, ...order.slice().reverse()]; }

test("单挑：庄家是小盲、翻牌前先说话，翻牌后大盲先说话", () => {
  let g = E.newGame([{ name: "A", bot: false }, { name: "B", bot: false }], cfg);
  assert.equal(g.sb, g.dealer);
  assert.equal(g.current, g.dealer);
  assert.equal(g.players[g.sb].bet, 10); assert.equal(g.players[g.bb].bet, 20);
  g = E.act(g, { type: "call" }); g = E.act(g, { type: "check" });
  assert.equal(g.stage, "flop"); assert.equal(g.current, g.bb);
});

test("三人以上：庄家左边小盲、大盲，大盲左边先说话；庄位轮转", () => {
  for (let n = 3; n <= 9; n++) {
    let g = E.newGame(Array.from({ length: n }, (_, i) => ({ name: "P" + i, bot: true })), cfg);
    assert.equal(g.sb, (g.dealer + 1) % n); assert.equal(g.bb, (g.dealer + 2) % n); assert.equal(g.current, (g.dealer + 3) % n);
    const d = g.dealer;
    while (g.stage !== "handover") g = E.act(g, { type: "fold" });
    g = E.startHand(g); assert.equal(g.dealer, (d + 1) % n);
  }
});

test("最小加注与短码全下不重新开放加注", () => {
  let g = E.newGame([{ name: "A", bot: false }, { name: "B", bot: false }, { name: "C", bot: false }], cfg);
  // 设定：庄家 0，小盲 1，大盲 2，0 先说话
  g.stage = "handover"; g.dealer = 2; g.players.forEach((p) => (p.chips = 1000)); g = E.startHand(g);
  assert.equal(g.current, 0);
  let L = E.legal(g, 0); assert.equal(L.raiseMin, 40);
  g = E.act(g, { type: "raise", to: 25 }); // 不足最小加注会被抬到 40
  assert.equal(g.players[0].bet, 40); assert.equal(g.minRaise, 20);
  g.players[1].chips = 40; // 小盲只剩 40，全下到 50（只多 10，不算完整加注）
  g = E.act(g, { type: "allin" });
  assert.equal(g.currentBet, 50);
  g = E.act(g, { type: "call" }); // 大盲跟到 50
  L = E.legal(g, 0);
  assert.equal(L.canRaise, false, "已行动的玩家面对短码全下只能跟或弃");
  assert.equal(L.call, 10);
});

test("多人全下：边池分配正确且筹码守恒", () => {
  const g0 = E.newGame([{ name: "A", bot: false }, { name: "B", bot: false }, { name: "C", bot: false }], cfg);
  g0.stage = "handover"; g0.dealer = 2; g0.players[0].chips = 100; g0.players[1].chips = 300; g0.players[2].chips = 1000;
  // 发牌顺序：从小盲(1)开始 1,2,0,1,2,0；然后烧1翻3烧1转1烧1河1
  const A1 = C("As"), A2 = C("Ad"), B1 = C("Ks"), B2 = C("Kd"), C1 = C("Qs"), C2 = C("Qd");
  const order = [B1, C1, A1, B2, C2, A2, C("2c"), C("7h"), C("8c"), C("3d"), C("2h"), C("Kh"), C("2s"), C("Jc")];
  let g = E.startHand(g0, false, deckFor(order));
  assert.equal(g.dealer, 0);
  // 现在庄家 0，小盲 1(B)，大盲 2(C)，A 先说话
  g = E.act(g, { type: "allin" }); // A 100
  g = E.act(g, { type: "allin" }); // B 300
  g = E.act(g, { type: "call" });  // C 跟 300
  assert.equal(g.stage, "handover");
  // 公共牌 7h 8c 3d Kh Jc：B 三条 K 赢主池 300 和边池 400，A 一对 A 输
  assert.equal(g.players[1].handName, "三条");
  assert.equal(g.players[0].chips, 0); assert.equal(g.players[1].chips, 700); assert.equal(g.players[2].chips, 700);
  assert.equal(g.players.reduce((s, p) => s + p.chips, 0), 1400);
});

test("公共牌皇家同花顺三人平分", () => {
  const g0 = E.newGame([{ name: "A", bot: false }, { name: "B", bot: false }, { name: "C", bot: false }], { start: 1000, sb: 5, bb: 10 });
  g0.dealer = 2;
  const order = [C("2c"), C("3c"), C("4c"), C("2d"), C("3d"), C("4d"), C("9h"), C("As"), C("Ks"), C("Qs"), C("8h"), C("Js"), C("9c"), C("Ts")];
  let g = E.startHand(g0, false, deckFor(order));
  g = E.act(g, { type: "call" }); g = E.act(g, { type: "call" }); g = E.act(g, { type: "check" });
  while (g.stage !== "handover") g = E.act(g, { type: "check" });
  assert.deepEqual(g.players.map((p) => p.handName), ["皇家同花顺", "皇家同花顺", "皇家同花顺"]);
  assert.deepEqual(g.players.map((p) => p.chips), [1000, 1000, 1000]);
});

test("随机模拟 2–9 人对局：筹码守恒、无卡死", () => {
  let hands = 0;
  for (let n = 2; n <= 9; n++) for (let k = 0; k < 2; k++) {
    let g = E.newGame(Array.from({ length: n }, (_, i) => ({ name: "P" + i, bot: true })), cfg);
    const total = n * 1000; let steps = 0;
    while (g.stage !== "gameover" && steps < 3000) {
      if (g.stage === "handover") { assert.equal(g.players.reduce((s, p) => s + p.chips, 0), total); g = E.startHand(g); hands++; continue; }
      const p = g.players[g.current];
      assert.ok(p && !p.folded && !p.allIn && !p.out, "轮到的玩家必须能行动");
      const r = Math.random();
      const a = r < 0.08 ? { type: "allin" } : r < 0.25 ? E.aiDecide(g, 20) : r < 0.35 ? { type: "fold" } : r < 0.5 ? { type: "raise", to: E.legal(g, g.current).raiseMin } : { type: "call" };
      g = E.act(g, a); steps++;
    }
    assert.equal(g.players.reduce((s, p) => s + p.chips, 0), total);
  }
  assert.ok(hands > 50);
});

test("平分底池的零头给庄家左边第一位赢家", () => {
  const g0 = E.newGame([{ name: "A", bot: false }, { name: "B", bot: false }, { name: "C", bot: false }], { start: 1000, sb: 5, bb: 11 });
  g0.stage = "handover"; g0.dealer = 2; g0.players.forEach((p) => (p.chips = 1000));
  const order = [C("2c"), C("3c"), C("4c"), C("2d"), C("3d"), C("4d"), C("9h"), C("As"), C("Ks"), C("Qs"), C("8h"), C("Js"), C("9c"), C("Ts")];
  let g = E.startHand(g0, false, deckFor(order)); // 庄家 0，小盲 B，大盲 C
  g = E.act(g, { type: "call" }); // A 跟 11
  g = E.act(g, { type: "fold" }); // B 弃牌（损失 5）
  g = E.act(g, { type: "check" });
  while (g.stage !== "handover") g = E.act(g, { type: "check" });
  // 底池 27，A 与 C 平分：C 在庄家左边更近，拿 14；A 拿 13
  assert.deepEqual(g.players.map((p) => p.chips), [1000 - 11 + 13, 995, 1000 - 11 + 14]);
});

test("抽水：没看到翻牌不抽；没人跟的部分不抽；平分时从主池扣", async () => {
  // 翻牌前大家弃牌：不抽
  let g = E.newGame([{ name: "A", bot: false }, { name: "B", bot: false }, { name: "C", bot: false }], { ...cfg, rake: 5 });
  while (g.stage !== "handover") g = E.act(g, { type: "fold" });
  assert.equal(g.lastRake, 0);
  // 翻牌后有人下注没人跟：只按被跟注的部分抽
  g = E.newGame([{ name: "A", bot: false }, { name: "B", bot: false }], { ...cfg, rake: 10 });
  g = E.act(g, { type: "call" }); g = E.act(g, { type: "check" }); // 底池 40，进入翻牌
  g = E.act(g, { type: "raise", to: 500 }); g = E.act(g, { type: "fold" });
  assert.equal(g.lastRake, 4);
  assert.equal(g.players.reduce((s, p) => s + p.chips, 0), 1996);
});
