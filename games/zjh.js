// 炸金花（单人对庄）：豹子 > 同花顺 > 同花 > 顺子 > 对子 > 单张（A 最大；A23 是最小的顺子）。
// 下底注 → 可以先“看牌” → 跟（看牌后跟注 = 2 倍底注；不看直接“闷跟” = 1 倍底注）或弃牌（输底注）。
// 开牌：庄家至少 Q 高才“合格”。庄不合格：底注 1:1，跟注退回。庄合格：赢 → 底注 1:1、跟注 1:1（闷跟 7:5）；输 → 全输；平 → 全退。
import { newShoe, draw, rankOf, suitOf } from "./cards.js";
export const CAT_NAME = ["单张", "对子", "顺子", "同花", "同花顺", "豹子"];
export const BLIND_PAY = 140; // 闷跟赢时跟注赔 1.4 倍（每 100 份赔 140）
export function evaluate(h) {
  const r = h.map(rankOf).sort((a, b) => b - a), fl = suitOf(h[0]) === suitOf(h[1]) && suitOf(h[1]) === suitOf(h[2]);
  let st = 0; if (r[0] - r[1] === 1 && r[1] - r[2] === 1) st = r[0] + 1; else if (r[0] === 12 && r[1] === 1 && r[2] === 0) st = 0.5;
  const B = r[0] * 225 + r[1] * 15 + r[2];
  let cat, v;
  if (r[0] === r[2]) { cat = 5; v = r[0]; }
  else if (st && fl) { cat = 4; v = st; }
  else if (fl) { cat = 3; v = B; }
  else if (st) { cat = 2; v = st; }
  else if (r[0] === r[1] || r[1] === r[2]) { cat = 1; const p = r[1], k = r[0] === r[1] ? r[2] : r[0]; v = p * 15 + k; }
  else { cat = 0; v = B; }
  return { cat, name: CAT_NAME[cat], score: cat * 1e5 + v, high: r[0] };
}
export const qualifies = (e) => e.cat >= 1 || e.high >= 10; // Q = rank 10
export function deal(rng, preset) {
  const shoe = preset ? null : newShoe(1); let k = 0; const d = () => (preset ? preset[k++] : draw(shoe, rng));
  const player = [], dealer = []; for (let i = 0; i < 3; i++) { player.push(d()); dealer.push(d()); }
  return { player, dealer };
}
// 结算：返回总返还（含本金）。play = 0 表示弃牌
export function settle(ante, play, blind, player, dealer) {
  const pe = evaluate(player), de = evaluate(dealer);
  if (!play) return { payout: 0, pe, de, result: "fold", qualified: qualifies(de) };
  const q = qualifies(de);
  if (!q) return { payout: ante * 2 + play, pe, de, result: "noqualify", qualified: false };
  if (pe.score > de.score) return { payout: ante * 2 + play + (blind ? Math.floor((play * BLIND_PAY) / 100) : play), pe, de, result: "win", qualified: true };
  if (pe.score < de.score) return { payout: 0, pe, de, result: "lose", qualified: true };
  return { payout: ante + play, pe, de, result: "push", qualified: true };
}
