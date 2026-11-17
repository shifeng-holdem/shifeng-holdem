// 骰宝：三颗骰子。大/小、单/双 1:1（围骰通杀）；点数 4–17；全围 30:1；指定围骰 180:1；单骰 1/2/3 倍
export const SUM_PAY = { 4: 60, 5: 30, 6: 17, 7: 12, 8: 8, 9: 6, 10: 6, 11: 6, 12: 6, 13: 8, 14: 12, 15: 17, 16: 30, 17: 60 };
export const SPOTS = ["big", "small", "odd", "even", "anyTriple",
  ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((n) => "sum" + n),
  ...[1, 2, 3, 4, 5, 6].map((n) => "triple" + n), ...[1, 2, 3, 4, 5, 6].map((n) => "single" + n)];
export const spotName = (s) => ({ big: "大", small: "小", odd: "单", even: "双", anyTriple: "全围" }[s]
  || (s.startsWith("sum") ? `${s.slice(3)} 点` : s.startsWith("triple") ? `围 ${s.slice(6)}` : `单骰 ${s.slice(6)}`));
export const roll = (rng) => [rng(6) + 1, rng(6) + 1, rng(6) + 1];
// 返回这个注位“赢几倍”（不含本金）；0 = 输
export function payMult(spot, dice) {
  const sum = dice[0] + dice[1] + dice[2], triple = dice[0] === dice[1] && dice[1] === dice[2];
  if (spot === "big") return !triple && sum >= 11 ? 1 : 0;
  if (spot === "small") return !triple && sum <= 10 ? 1 : 0;
  if (spot === "odd") return !triple && sum % 2 === 1 ? 1 : 0;
  if (spot === "even") return !triple && sum % 2 === 0 ? 1 : 0;
  if (spot === "anyTriple") return triple ? 30 : 0;
  if (spot.startsWith("sum")) return sum === +spot.slice(3) ? SUM_PAY[sum] : 0;
  if (spot.startsWith("triple")) return triple && dice[0] === +spot.slice(6) ? 180 : 0;
  if (spot.startsWith("single")) { const n = dice.filter((d) => d === +spot.slice(6)).length; return n; }
  return 0;
}
export function settle(bets, dice) {
  let stake = 0, payout = 0; const lines = [];
  for (const s of SPOTS) { const a = bets[s] || 0; if (!a) continue; stake += a; const m = payMult(s, dice); const back = m ? a * (m + 1) : 0; payout += back; lines.push({ spot: s, bet: a, back }); }
  return { stake, payout, lines };
}
// 精确回报率：遍历 216 种结果
export function exactRtp(spot) { let r = 0; for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) { const m = payMult(spot, [a, b, c]); r += m ? m + 1 : 0; } return r / 216; }
