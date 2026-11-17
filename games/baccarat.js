// 百家乐（Punto Banco）：8 副牌，标准补牌规则。庄 0.95:1（抽 5% 佣金），闲 1:1，和 8:1，庄对 / 闲对 11:1
import { newShoe, draw, rankOf } from "./cards.js";
export const DECKS = 8;
export const SPOTS = ["player", "banker", "tie", "ppair", "bpair"];
export const SPOT_NAME = { player: "闲", banker: "庄", tie: "和", ppair: "闲对", bpair: "庄对" };
// 赔率用“每 100 份赢多少份”表示，避免小数误差
export const PAY = { player: 100, banker: 95, tie: 800, ppair: 1100, bpair: 1100 };
export const point = (c) => { const r = rankOf(c); return r === 12 ? 1 : r <= 7 ? r + 2 : 0; };
export const total = (cards) => cards.reduce((a, c) => a + point(c), 0) % 10;
// 庄家第三张：b = 庄家两张点数，p3 = 闲家第三张点数（闲没补牌时为 null）
export function bankerDraws(b, p3) {
  if (p3 == null) return b <= 5;
  if (b <= 2) return true;
  if (b === 3) return p3 !== 8;
  if (b === 4) return p3 >= 2 && p3 <= 7;
  if (b === 5) return p3 >= 4 && p3 <= 7;
  if (b === 6) return p3 === 6 || p3 === 7;
  return false;
}
// 按发牌顺序给出一局；cards 可以直接传入（测试用）
export function deal(rng, preset) {
  const shoe = preset ? null : newShoe(DECKS); let k = 0;
  const d = () => (preset ? preset[k++] : draw(shoe, rng));
  const player = [d()], banker = [d()]; player.push(d()); banker.push(d());
  let p = total(player), b = total(banker);
  if (p < 8 && b < 8) {
    let p3 = null;
    if (p <= 5) { const c = d(); player.push(c); p3 = point(c); }
    if (bankerDraws(b, p3)) banker.push(d());
  }
  p = total(player); b = total(banker);
  return { player, banker, p, b, winner: p > b ? "player" : b > p ? "banker" : "tie",
    ppair: rankOf(player[0]) === rankOf(player[1]), bpair: rankOf(banker[0]) === rankOf(banker[1]) };
}
// 结算：bets = { banker: 分, ... }；返回 { stake, payout, lines }
export function settle(bets, r) {
  let stake = 0, payout = 0; const lines = [];
  for (const s of SPOTS) {
    const a = bets[s] || 0; if (!a) continue; stake += a; let back = 0;
    if (s === "player" || s === "banker") back = r.winner === s ? a + Math.floor((a * PAY[s]) / 100) : r.winner === "tie" ? a : 0;
    else if (s === "tie") back = r.winner === "tie" ? a + (a * PAY.tie) / 100 : 0;
    else back = r[s] ? a + (a * PAY[s]) / 100 : 0;
    payout += back; lines.push({ spot: s, bet: a, back });
  }
  return { stake, payout, lines };
}
