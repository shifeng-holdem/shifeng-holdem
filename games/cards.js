// 牌桌小游戏的公共部分：牌、洗牌、随机数（服务器端用 crypto，测试里可以换成固定种子）
import { cryptoRng } from "../slot.js";
export { cryptoRng };
// 牌：0..51，rank = c % 13（0=2 … 8=10, 9=J, 10=Q, 11=K, 12=A），suit = c / 13（0♠ 1♥ 2♦ 3♣）
export const rankOf = (c) => c % 13;
export const suitOf = (c) => Math.floor(c / 13);
export const RANK_NAME = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
export const SUIT_NAME = ["♠", "♥", "♦", "♣"];
export const cardName = (c) => SUIT_NAME[suitOf(c)] + RANK_NAME[rankOf(c)];
// 牌靴：抽一张就是“随机选一张剩下的牌”（等价于整副洗好再按顺序发，且可以把剩余状态存起来）
export function newShoe(decks) { const cards = []; for (let d = 0; d < decks; d++) for (let c = 0; c < 52; c++) cards.push(c); return { cards, n: cards.length }; }
export function draw(shoe, rng) {
  if (shoe.n <= 0) throw new Error("SHOE_EMPTY");
  const j = rng(shoe.n), last = shoe.n - 1, c = shoe.cards[j];
  shoe.cards[j] = shoe.cards[last]; shoe.cards[last] = c; shoe.n = last; return c;
}
// 测试 / 模拟用的快速确定性随机数（xorshift128+ 的 32 位变体）
export function seededRng(seed = 1) {
  let a = seed >>> 0 || 1, b = 0x9e3779b9, c = 0x243f6a88, d = 0xb7e15162;
  const next = () => { const t = b << 9; let r = a * 5; r = ((r << 7) | (r >>> 25)) * 9; c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21); return r >>> 0; };
  for (let i = 0; i < 20; i++) next();
  return (n) => Math.floor((next() / 4294967296) * n);
}
