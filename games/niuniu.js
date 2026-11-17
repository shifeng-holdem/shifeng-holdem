// 牛牛（单人对庄）：一副 52 张，各发 5 张。三张凑 10 的倍数，剩下两张点数个位 = 牛几。
// 倍数：无牛~牛6 ×1，牛7~牛9 ×2，牛牛 ×3，五花牛 ×4，炸弹 ×4，五小牛 ×5。
// 输赢按赢家的牌型倍数结算；闲家赢时抽 5% 佣金（与常见牛牛桌一致）。同牌型比最大单张（K 最大，A 最小；同点比花色 ♠>♥>♣>♦）。
import { newShoe, draw, rankOf, suitOf } from "./cards.js";
export const MAX_MULT = 5, COMMISSION = 5; // 佣金 %
export const face = (c) => (rankOf(c) === 12 ? 1 : rankOf(c) + 2); // A=1 … K=13
export const pts = (c) => Math.min(10, face(c));
const SUIT_RANK = [4, 3, 1, 2]; // ♠ ♥ ♦ ♣ → ♠>♥>♣>♦
export const cardKey = (c) => face(c) * 5 + SUIT_RANK[suitOf(c)];
export const TYPE_NAME = (t) => (t === 0 ? "无牛" : t <= 9 ? `牛${"一二三四五六七八九"[t - 1]}` : ["牛牛", "五花牛", "炸弹", "五小牛"][t - 10]);
export const multOf = (t) => (t <= 6 ? 1 : t <= 9 ? 2 : t === 10 ? 3 : t === 13 ? 5 : 4);
export function evaluate(cards) {
  const f = cards.map(face), p = cards.map(pts), sum = p.reduce((a, b) => a + b, 0);
  const counts = {}; f.forEach((x) => (counts[x] = (counts[x] || 0) + 1));
  const quad = Object.keys(counts).find((k) => counts[k] === 4);
  let type = 0, split = null;
  for (let i = 0; i < 5 && !split; i++) for (let j = i + 1; j < 5 && !split; j++) for (let k = j + 1; k < 5 && !split; k++)
    if ((p[i] + p[j] + p[k]) % 10 === 0) split = [[i, j, k], [0, 1, 2, 3, 4].filter((x) => x !== i && x !== j && x !== k)];
  if (split) { const r = (sum - p[split[0][0]] - p[split[0][1]] - p[split[0][2]]) % 10; type = r === 0 ? 10 : r; }
  if (f.every((x) => x >= 11)) type = 11;
  if (quad) type = 12;
  if (f.every((x) => x < 5) && sum <= 10) type = 13;
  const high = type === 12 ? +quad * 5 + 4 : Math.max(...cards.map(cardKey));
  return { type, name: TYPE_NAME(type), mult: multOf(type), split, score: type * 100 + high };
}
export function play(rng, bet, preset) {
  const shoe = preset ? null : newShoe(1); let k = 0; const d = () => (preset ? preset[k++] : draw(shoe, rng));
  const player = [], banker = []; for (let i = 0; i < 5; i++) { player.push(d()); banker.push(d()); }
  const ph = evaluate(player), bh = evaluate(banker), win = ph.score > bh.score;
  const mult = win ? ph.mult : bh.mult;
  const net = win ? Math.floor((bet * mult * (100 - COMMISSION)) / 100) : -bet * mult;
  return { player, banker, ph, bh, win, mult, net, payout: bet + net };
}
