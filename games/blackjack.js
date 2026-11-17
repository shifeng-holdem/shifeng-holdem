// 21点：6 副牌，每一手都用新洗好的牌靴；庄家软 17 停牌；黑杰克 3:2；可加倍（任意两张，分牌后也可以）、
// 分牌（同点数，最多分到 4 手；A 分牌后每手只补一张）、保险（庄家明牌是 A 时可选，2:1）。庄家明牌 A/10 时先偷看黑杰克。
import { newShoe, draw, rankOf } from "./cards.js";
export const DECKS = 6, MAX_HANDS = 4;
export const val = (c) => { const r = rankOf(c); return r === 12 ? 11 : r >= 8 ? 10 : r + 2; };
export function score(cards) {
  let t = 0, aces = 0; for (const c of cards) { t += val(c); if (rankOf(c) === 12) aces++; }
  while (t > 21 && aces) { t -= 10; aces--; }
  return { total: t, soft: aces > 0 && t <= 21 };
}
export const isBJ = (cards) => cards.length === 2 && score(cards).total === 21;
export function start(rng, bet, preset) {
  const s = { shoe: preset ? null : newShoe(DECKS), preset: preset || null, k: 0, bet, dealer: [], hands: [{ cards: [], bet, doubled: false, done: false, splitAces: false }], active: 0, insurance: 0, insuranceDone: false, phase: "play", result: null };
  const p = s.hands[0].cards; p.push(take(s, rng)); s.dealer.push(take(s, rng)); p.push(take(s, rng)); s.dealer.push(take(s, rng));
  if (rankOf(s.dealer[0]) === 12) s.phase = "insurance"; else afterInsurance(s);
  return s;
}
function take(s, rng) { return s.preset ? s.preset[s.k++] : draw(s.shoe, rng); }
function afterInsurance(s) {
  s.insuranceDone = true;
  const up = val(s.dealer[0]);
  if ((up === 10 || up === 11) && isBJ(s.dealer)) return finish(s);            // 庄家黑杰克，直接结算
  if (isBJ(s.hands[0].cards)) return finish(s);                                  // 玩家黑杰克
  s.phase = "play";
}
const hand = (s) => s.hands[s.active];
export function legal(s) {
  if (s.phase === "insurance") return ["insurance", "noInsurance"];
  if (s.phase !== "play") return [];
  const h = hand(s), a = ["hit", "stand"];
  if (h.cards.length === 2 && !h.splitAces) a.push("double");
  if (h.cards.length === 2 && val(h.cards[0]) === val(h.cards[1]) && s.hands.length < MAX_HANDS && !h.splitAces) a.push("split");
  return a;
}
// 这个操作要再押多少（服务器先扣钱再执行）
export function cost(s, action) {
  if (action === "double" || action === "split") return hand(s).bet;
  if (action === "insurance") return Math.floor(s.bet / 2);
  return 0;
}
export function act(s, action, rng) {
  if (!legal(s).includes(action)) throw new Error("ILLEGAL");
  if (action === "insurance" || action === "noInsurance") { if (action === "insurance") s.insurance = Math.floor(s.bet / 2); return afterInsurance(s); }
  const h = hand(s);
  if (action === "hit") { h.cards.push(take(s, rng)); if (score(h.cards).total >= 21) h.done = true; }
  else if (action === "stand") h.done = true;
  else if (action === "double") { h.bet *= 2; h.doubled = true; h.cards.push(take(s, rng)); h.done = true; }
  else if (action === "split") {
    const aces = rankOf(h.cards[0]) === 12;
    const nh = { cards: [h.cards.pop()], bet: h.bet, doubled: false, done: false, splitAces: aces };
    h.splitAces = aces; h.cards.push(take(s, rng)); nh.cards.push(take(s, rng));
    s.hands.splice(s.active + 1, 0, nh);
    if (aces) { h.done = true; nh.done = true; } else if (score(h.cards).total === 21) h.done = true;
  }
  while (s.active < s.hands.length && s.hands[s.active].done) {
    s.active++;
    if (s.active < s.hands.length) { const n = s.hands[s.active]; if (score(n.cards).total === 21) n.done = true; }
  }
  if (s.active >= s.hands.length) { s.active = s.hands.length - 1; finish(s, rng); }
}
function finish(s, rng) {
  const split = s.hands.length > 1;
  const live = s.hands.some((h) => score(h.cards).total <= 21) && !(s.hands.length === 1 && isBJ(s.hands[0].cards));
  const dealerBJ = isBJ(s.dealer);
  if (live && !dealerBJ) while (score(s.dealer).total < 17) s.dealer.push(take(s, rng)); // 软 17 停牌
  const d = score(s.dealer).total; let payout = 0; const lines = [];
  if (s.insurance) payout += dealerBJ ? s.insurance * 3 : 0;
  for (const h of s.hands) {
    const t = score(h.cards).total, bj = !split && isBJ(h.cards); let back, res;
    if (dealerBJ) { back = bj ? h.bet : 0; res = bj ? "push" : "lose"; }
    else if (bj) { back = h.bet + Math.floor((h.bet * 3) / 2); res = "blackjack"; }
    else if (t > 21) { back = 0; res = "bust"; }
    else if (d > 21 || t > d) { back = h.bet * 2; res = "win"; }
    else if (t === d) { back = h.bet; res = "push"; }
    else { back = 0; res = "lose"; }
    payout += back; lines.push({ res, back, bet: h.bet, total: t });
  }
  s.phase = "done"; s.result = { payout, lines, dealerTotal: d, dealerBJ, insuranceWon: !!(s.insurance && dealerBJ) };
}
export const stakeOf = (s) => s.hands.reduce((a, h) => a + h.bet, 0) + s.insurance;
// 发给客户端的视图：没结束前不给暗牌和牌靴
export function view(s) {
  const done = s.phase === "done";
  return { phase: s.phase, bet: s.bet, insurance: s.insurance, active: s.active, legal: legal(s),
    dealer: done ? s.dealer : [s.dealer[0], null], dealerTotal: done ? score(s.dealer).total : score([s.dealer[0]]).total,
    hands: s.hands.map((h) => ({ cards: h.cards, bet: h.bet, doubled: h.doubled, done: h.done, ...score(h.cards) })), result: s.result };
}
// 基本策略（6 副牌、软 17 停、可分后加倍），用于模拟验证庄家优势
export function basic(s) {
  const L = legal(s); if (s.phase === "insurance") return "noInsurance";
  const h = hand(s), { total, soft } = score(h.cards), up = val(s.dealer[0]) === 11 ? 11 : val(s.dealer[0]);
  const can = (a) => L.includes(a), dbl = (fallback) => (can("double") ? "double" : fallback);
  if (can("split")) {
    const v = val(h.cards[0]);
    const sp = { 11: true, 8: true, 10: false, 9: up <= 9 && up !== 7, 7: up <= 7, 6: up <= 6, 5: false, 4: up === 5 || up === 6, 3: up <= 7, 2: up <= 7 }[v];
    if (sp) return "split";
  }
  if (soft) {
    if (total >= 19) return "stand";
    if (total === 18) return up >= 3 && up <= 6 ? dbl("stand") : up <= 8 ? "stand" : "hit";
    if (total === 17) return up >= 3 && up <= 6 ? dbl("hit") : "hit";
    if (total >= 15) return up >= 4 && up <= 6 ? dbl("hit") : "hit";
    return up >= 5 && up <= 6 ? dbl("hit") : "hit";
  }
  if (total >= 17) return "stand";
  if (total >= 13) return up <= 6 ? "stand" : "hit";
  if (total === 12) return up >= 4 && up <= 6 ? "stand" : "hit";
  if (total === 11) return up <= 10 ? dbl("hit") : "hit";
  if (total === 10) return up <= 9 ? dbl("hit") : "hit";
  if (total === 9) return up >= 3 && up <= 6 ? dbl("hit") : "hit";
  return "hit";
}
