// 五个新游戏：规则、赔付、以及模拟回报率（庄家优势应在标准范围内）
import test from "node:test";
import assert from "node:assert/strict";
import { seededRng } from "../games/cards.js";
import * as BC from "../games/baccarat.js";
import * as BJ from "../games/blackjack.js";
import * as SB from "../games/sicbo.js";
import * as NN from "../games/niuniu.js";
import * as ZJ from "../games/zjh.js";
// 造牌：rank 0=2 … 8=10, 9=J, 10=Q, 11=K, 12=A；suit 0♠ 1♥ 2♦ 3♣
const C = (rank, suit = 0) => suit * 13 + rank;
const near = (x, want, tol, msg) => assert.ok(Math.abs(x - want) <= tol, `${msg}: ${x.toFixed(3)} 应接近 ${want}（±${tol}）`);

test("百家乐：点数、天牌、补牌规则", () => {
  assert.equal(BC.point(C(12)), 1); assert.equal(BC.point(C(8)), 0); assert.equal(BC.point(C(11)), 0); assert.equal(BC.point(C(7)), 9);
  // 顺序：闲1 庄1 闲2 庄2 …；闲 8 点天牌，不补
  let r = BC.deal(null, [C(6), C(0), C(8), C(1)]); assert.equal(r.player.length, 2); assert.equal(r.p, 8); assert.equal(r.winner, "player");
  // 闲 5 点补牌拿到 8，庄 3 点：p3=8 时庄不补
  r = BC.deal(null, [C(1), C(1), C(0), C(8), C(6)]); assert.equal(r.player.length, 3); assert.equal(r.banker.length, 2);
  // 闲 6 点停牌，庄 5 点（闲没补）要补
  r = BC.deal(null, [C(4), C(3), C(8), C(8, 1), C(8, 2)]); assert.equal(r.player.length, 2); assert.equal(r.banker.length, 3);
  // 庄 6 点，闲补到 6/7 才补
  assert.equal(BC.bankerDraws(6, 6), true); assert.equal(BC.bankerDraws(6, 5), false); assert.equal(BC.bankerDraws(4, 1), false); assert.equal(BC.bankerDraws(7, null), false);
});
test("百家乐：赔付（庄 0.95、闲 1、和 8、对子 11，和局退回庄闲）", () => {
  const tie = { winner: "tie", ppair: true, bpair: false };
  assert.deepEqual(BC.settle({ banker: 1000, player: 1000, tie: 100, ppair: 100, bpair: 100 }, tie).payout, 1000 + 1000 + 900 + 1200);
  assert.equal(BC.settle({ banker: 1000 }, { winner: "banker" }).payout, 1950);
  assert.equal(BC.settle({ player: 1000 }, { winner: "player" }).payout, 2000);
  assert.equal(BC.settle({ player: 1000 }, { winner: "banker" }).payout, 0);
});
test("21点：计分、黑杰克 3:2、软 17 停、加倍、分牌、保险", () => {
  assert.deepEqual(BJ.score([C(12), C(5)]), { total: 18, soft: true });
  assert.deepEqual(BJ.score([C(12), C(12), C(8)]), { total: 12, soft: false });
  // 玩家黑杰克（顺序：闲 庄 闲 庄）
  let s = BJ.start(null, 1000, [C(12), C(5), C(11), C(8)]); assert.equal(s.phase, "done"); assert.equal(s.result.payout, 2500);
  // 庄家明牌 A → 保险；庄家黑杰克：保险 2:1 正好打平
  s = BJ.start(null, 1000, [C(8), C(12), C(7), C(11)]); assert.equal(s.phase, "insurance");
  BJ.act(s, "insurance"); assert.equal(s.phase, "done"); assert.equal(s.result.payout, 1500); assert.equal(BJ.stakeOf(s), 1500);
  // 庄家软 17 停牌：玩家 18 赢
  s = BJ.start(null, 1000, [C(8), C(12), C(6), C(4)]); BJ.act(s, "noInsurance"); BJ.act(s, "stand");
  assert.equal(s.dealer.length, 2); assert.equal(s.result.payout, 2000);
  // 加倍：11 加倍拿 10 → 21
  s = BJ.start(null, 1000, [C(4), C(8), C(3), C(5), C(8)]); assert.equal(BJ.cost(s, "double"), 1000); BJ.act(s, "double");
  assert.equal(s.hands[0].bet, 2000); assert.equal(s.result.lines[0].total, 21); assert.equal(s.result.payout, 4000);
  // 分牌 8,8：两手各自补牌
  s = BJ.start(null, 1000, [C(6), C(8), C(6), C(7), C(1), C(8)]); assert.ok(BJ.legal(s).includes("split")); BJ.act(s, "split");
  assert.equal(s.hands.length, 2); assert.equal(BJ.stakeOf(s), 2000);
  // 爆牌
  s = BJ.start(null, 1000, [C(8), C(8), C(4), C(7), C(8)]); BJ.act(s, "hit"); assert.equal(s.phase, "done"); assert.equal(s.result.lines[0].res, "bust");
  // 暗牌不外泄
  s = BJ.start(seededRng(3), 1000); if (s.phase !== "done") { const v = BJ.view(s); assert.equal(v.dealer[1], null); assert.equal(v.shoe, undefined); }
});
test("骰宝：大小单双遇围骰通杀，点数/围骰/单骰赔率", () => {
  assert.equal(SB.payMult("big", [4, 4, 4]), 0); assert.equal(SB.payMult("big", [6, 5, 1]), 1); assert.equal(SB.payMult("small", [1, 2, 3]), 1);
  assert.equal(SB.payMult("odd", [1, 1, 1]), 0); assert.equal(SB.payMult("even", [2, 2, 6]), 1);
  assert.equal(SB.payMult("sum4", [1, 1, 2]), 60); assert.equal(SB.payMult("sum10", [3, 3, 4]), 6);
  assert.equal(SB.payMult("anyTriple", [5, 5, 5]), 30); assert.equal(SB.payMult("triple5", [5, 5, 5]), 180); assert.equal(SB.payMult("triple4", [5, 5, 5]), 0);
  assert.equal(SB.payMult("single5", [5, 5, 2]), 2); assert.equal(SB.payMult("single5", [5, 5, 5]), 3);
  assert.equal(SB.settle({ big: 100, sum17: 100 }, [6, 6, 5]).payout, 200 + 6100);
  // 精确庄家优势（遍历 216 种）
  const E = (s) => (1 - SB.exactRtp(s)) * 100;
  near(E("big"), 2.778, 0.01, "大"); near(E("single3"), 7.87, 0.01, "单骰"); near(E("anyTriple"), 13.89, 0.01, "全围"); near(E("triple2"), 16.2, 0.01, "指定围骰"); near(E("sum10"), 12.5, 0.01, "10 点");
});
test("牛牛：牌型识别、3+2 分组、倍数与比牌", () => {
  let e = NN.evaluate([C(8), C(9, 1), C(10, 2), C(1), C(6)]); // 10 J Q → 牛 (3+8)=牛一
  assert.equal(e.type, 1); assert.equal(e.mult, 1); assert.equal(e.split[0].length, 3); assert.equal(e.split[1].length, 2);
  e = NN.evaluate([C(8), C(9, 1), C(10, 2), C(5), C(1, 3)]); assert.equal(e.name, "牛牛"); assert.equal(e.mult, 3);
  e = NN.evaluate([C(12), C(0), C(2), C(6), C(7)]); assert.equal(e.name, "无牛"); // A 2 4 8 9：没有三张凑 10 的倍数
  assert.equal(NN.evaluate([C(9), C(10), C(11), C(9, 1), C(11, 2)]).name, "五花牛");
  assert.equal(NN.evaluate([C(5), C(5, 1), C(5, 2), C(5, 3), C(2)]).name, "炸弹");
  assert.equal(NN.evaluate([C(12), C(12, 1), C(0), C(0, 1), C(1)]).name, "五小牛"); // A A 2 2 3 = 9
  assert.equal(NN.evaluate([C(12), C(12, 1), C(0), C(0, 1), C(1)]).mult, 5);
  assert.equal(NN.evaluate([C(1), C(5), C(8), C(5, 1), C(11)]).name, "牛七"); // 3 7 10 | 7 K → 牛七 ×2
  assert.equal(NN.evaluate([C(1), C(5), C(8), C(5, 1), C(11)]).mult, 2);
  // 闲赢按闲的倍数、抽 5%；输按庄的倍数
  const p = [C(8), C(9, 1), C(10, 2), C(5), C(1, 3)], b = [C(12, 1), C(0, 1), C(2, 1), C(6, 1), C(7, 1)];
  const r = NN.play(null, 1000, [p[0], b[0], p[1], b[1], p[2], b[2], p[3], b[3], p[4], b[4]]);
  assert.equal(r.win, true); assert.equal(r.net, 2850); assert.equal(r.payout, 3850);
  const r2 = NN.play(null, 1000, [b[0], p[0], b[1], p[1], b[2], p[2], b[3], p[3], b[4], p[4]]);
  assert.equal(r2.win, false); assert.equal(r2.net, -3000);
});
test("炸金花：牌型大小、庄家 Q 高合格、看牌/闷跟结算", () => {
  const ev = (h) => ZJ.evaluate(h).score;
  const baozi = [C(0), C(0, 1), C(0, 2)], sf = [C(10, 1), C(11, 1), C(12, 1)], fl = [C(0, 2), C(4, 2), C(9, 2)], st = [C(3), C(4, 1), C(5, 2)], pr = [C(12), C(12, 1), C(1)], hi = [C(12), C(10, 1), C(1, 2)];
  assert.ok(ev(baozi) > ev(sf) && ev(sf) > ev(fl) && ev(fl) > ev(st) && ev(st) > ev(pr) && ev(pr) > ev(hi));
  assert.ok(ev([C(12), C(0, 1), C(1, 2)]) < ev([C(0), C(1, 1), C(2, 2)]), "A23 是最小的顺子");
  assert.equal(ZJ.qualifies(ZJ.evaluate([C(10), C(3, 1), C(1, 2)])), true); assert.equal(ZJ.qualifies(ZJ.evaluate([C(9), C(3, 1), C(1, 2)])), false);
  const dq = [C(9), C(3, 1), C(1, 2)]; // J 高，不合格
  assert.equal(ZJ.settle(100, 200, false, hi, dq).payout, 100 * 2 + 200);            // 底注赢、跟注退
  assert.equal(ZJ.settle(100, 200, false, pr, [C(11), C(3, 1), C(1, 2)]).payout, 600);  // 看牌跟赢：全部 1:1
  assert.equal(ZJ.settle(100, 100, true, pr, [C(11), C(3, 1), C(1, 2)]).payout, 200 + 100 + 140); // 闷跟赢 7:5
  assert.equal(ZJ.settle(100, 200, false, hi, pr).payout, 0);
  assert.equal(ZJ.settle(100, 0, false, pr, hi).payout, 0, "弃牌输底注");
});
test("模拟回报率：五个游戏的庄家优势都在标准范围内", () => {
  const rng = seededRng(20261116);
  // 百家乐（8 副）：庄 1.06%、闲 1.24%、和 14.36%、对子 10.36%
  const b = { player: 0, banker: 0, tie: 0, ppair: 0, bpair: 0 }; let N = 200000;
  for (let i = 0; i < N; i++) { const r = BC.deal(rng); for (const s of BC.SPOTS) b[s] += BC.settle({ [s]: 1000 }, r).payout; }
  const he = (s) => 100 - b[s] / N / 10;
  near(he("banker"), 1.06, 0.45, "百家乐 庄"); near(he("player"), 1.24, 0.45, "百家乐 闲"); near(he("tie"), 14.36, 3, "百家乐 和"); near(he("ppair"), 10.36, 3, "百家乐 闲对");
  // 21点：基本策略下庄家优势约 0.4%–0.6%
  let base = 0, pay = 0, st = 0; N = 250000;
  for (let i = 0; i < N; i++) { const s = BJ.start(rng, 100); while (s.phase !== "done") BJ.act(s, BJ.basic(s), rng); base += 100; st += BJ.stakeOf(s); pay += s.result.payout; }
  near(((st - pay) / base) * 100, 0.5, 0.7, "21点（每手初始下注）");
  // 牛牛：对称比牌 + 闲赢抽 5%，约 4%
  let nn = 0; N = 200000; for (let i = 0; i < N; i++) nn += NN.play(rng, 100).net;
  near(-nn / N, 4.03, 0.7, "牛牛（每注）");
  // 炸金花：K 高以上看牌跟（最优策略）≈3.2%；全程闷跟 ≈3.4%（按底注）
  let zs = 0, zb = 0; N = 200000;
  for (let i = 0; i < N; i++) { const d = ZJ.deal(rng); const e = ZJ.evaluate(d.player); const call = e.cat >= 1 || e.high >= 11;
    zs += ZJ.settle(100, call ? 200 : 0, false, d.player, d.dealer).payout - 100 - (call ? 200 : 0); zb += ZJ.settle(100, 100, true, d.player, d.dealer).payout - 200; }
  near(-zs / N, 3.2, 0.8, "炸金花 看牌"); near(-zb / N, 3.37, 1.0, "炸金花 闷跟");
  // 骰宝：模拟大/小 ≈2.78%
  let big = 0; N = 200000; for (let i = 0; i < N; i++) big += SB.settle({ big: 100 }, SB.roll(rng)).payout;
  near(100 - big / N, 2.78, 0.6, "骰宝 大");
});
