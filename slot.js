// 时烽麻将消消乐：单人麻将牌消除转轴（游戏筹码，非真钱）
// 5 轴 × 4 行、1024 路（从左到右连续 3 轴以上同牌即中奖），中奖牌消除、上方牌下落补位，
// 每次连消倍数递增（普通 x1→x2→x3→x5，免费游戏 x2→x4→x6→x10）。
// 所有结果都在服务器用 crypto 随机数计算。
import { randomBytes } from "node:crypto";

export const REELS = 5, ROWS = 4;
export const WILD = "wild", SCATTER = "hu";
// 牌面：id / 中文名
export const SYMBOLS = [
  { id: "fa", name: "發" }, { id: "zhong", name: "中" }, { id: "bai", name: "白" }, { id: "wan", name: "八萬" },
  { id: "tong5", name: "五筒" }, { id: "tiao5", name: "五條" }, { id: "tong2", name: "二筒" }, { id: "tiao2", name: "二條" },
  { id: WILD, name: "百搭" }, { id: SCATTER, name: "胡" },
];
// 赔付表：单位是“总下注的 1%”× 路数；索引为连续轴数 3/4/5
export const PAYTABLE = {
  fa: { 3: 20, 4: 50, 5: 100 },
  zhong: { 3: 15, 4: 40, 5: 80 },
  bai: { 3: 12, 4: 30, 5: 60 },
  wan: { 3: 10, 4: 20, 5: 40 },
  tong5: { 3: 5, 4: 12, 5: 25 },
  tiao5: { 3: 5, 4: 12, 5: 25 },
  tong2: { 3: 2, 4: 6, 5: 15 },
  tiao2: { 3: 2, 4: 6, 5: 15 },
};
export const PAYING = Object.keys(PAYTABLE);
// 每个轴上每种牌出现的权重（百搭只在第 2–4 轴出现）
const W = { fa: 4, zhong: 5, bai: 6, wan: 8, tong5: 10, tiao5: 10, tong2: 13, tiao2: 13 };
export const WEIGHTS = [0, 1, 2, 3, 4].map((r) => ({ ...W, [WILD]: r >= 1 && r <= 3 ? 1.8 : 0, [SCATTER]: 1.15 }));
export const BASE_MULTS = [1, 2, 3, 5];
export const FREE_MULTS = [2, 4, 6, 10];
export const FREE_SPINS = (n) => 10 + 2 * (n - 3); // 3 个胡 = 10 次，每多一个 +2
export const MAX_FREE = 100;
export const MAX_WIN_X = 5000; // 单次最高赢下注的 5000 倍
export const BETS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000]; // 单位：分（0.50 – 2,000.00）

// 加权抽样表（整数化，避免浮点误差）
const TABLES = WEIGHTS.map((w) => {
  const ids = Object.keys(w).filter((k) => w[k] > 0); const cum = []; let t = 0;
  for (const k of ids) { t += Math.round(w[k] * 100); cum.push(t); }
  return { ids, cum, total: t };
});

// 缓冲的加密随机数：每次取一批随机字节，拒绝采样得到无偏整数
export function cryptoRng() {
  let buf = randomBytes(65536), pos = 0;
  const u32 = () => { if (pos + 4 > buf.length) { buf = randomBytes(65536); pos = 0; } const v = buf.readUInt32LE(pos); pos += 4; return v; };
  return (n) => { const lim = 0x100000000 - (0x100000000 % n); let v; do v = u32(); while (v >= lim); return v % n; };
}

function draw(rng, reel) {
  const t = TABLES[reel]; const x = rng(t.total);
  let lo = 0; while (t.cum[lo] <= x) lo++;
  return t.ids[lo];
}
export function randomGrid(rng) { return Array.from({ length: REELS }, (_, r) => Array.from({ length: ROWS }, () => draw(rng, r))); }

// 计算当前牌面的所有中奖路线。grid[轴][行]，行 0 在最上面
export function evaluate(grid) {
  const wins = [];
  for (const s of PAYING) {
    const counts = []; const cells = [];
    for (let r = 0; r < REELS; r++) {
      const hit = []; grid[r].forEach((x, row) => { if (x === s || x === WILD) hit.push([r, row]); });
      if (!hit.length) break;
      counts.push(hit.length); cells.push(...hit);
    }
    const len = counts.length;
    if (len >= 3 && counts[0] > 0 && grid[0].includes(s)) {
      const ways = counts.reduce((a, b) => a * b, 1);
      wins.push({ sym: s, len, ways, pay: PAYTABLE[s][len], units: PAYTABLE[s][len] * ways, cells });
    }
  }
  return wins;
}
export const countScatter = (grid) => grid.reduce((n, col) => n + col.filter((x) => x === SCATTER).length, 0);

// 消除中奖牌，剩下的往下落，上面补新牌
export function cascade(grid, cells, rng) {
  const dead = new Set(cells.map(([r, row]) => r * 10 + row));
  return grid.map((col, r) => {
    const keep = col.filter((_, row) => !dead.has(r * 10 + row));
    const fresh = Array.from({ length: ROWS - keep.length }, () => draw(rng, r));
    return [...fresh, ...keep];
  });
}

// 一次转动（含所有连消）。返回步骤列表与总“单位”（总下注的 1%）
export function playRound(rng, mults, first) {
  let grid = first || randomGrid(rng); const steps = []; let units = 0; let k = 0;
  for (;;) {
    const wins = evaluate(grid);
    const mult = mults[Math.min(k, mults.length - 1)];
    if (!wins.length) { steps.push({ grid, wins: [], mult, units: 0 }); break; }
    const u = wins.reduce((a, w) => a + w.units, 0) * mult; units += u;
    steps.push({ grid, wins: wins.map(({ sym, len, ways, pay, cells }) => ({ sym, len, ways, pay, cells })), mult, units: u });
    grid = cascade(grid, wins.flatMap((w) => w.cells), rng); k++;
  }
  return { steps, units, scatters: countScatter(grid) };
}

// 完整一次下注：普通转动 + 触发的免费游戏
export function spin(bet, rng = cryptoRng()) {
  const base = playRound(rng, BASE_MULTS);
  let totalUnits = base.units; const free = [];
  let left = base.scatters >= 3 ? FREE_SPINS(base.scatters) : 0; let awarded = left;
  while (left > 0) {
    left--;
    const r = playRound(rng, FREE_MULTS);
    let extra = 0;
    if (r.scatters >= 3 && awarded < MAX_FREE) { extra = Math.min(FREE_SPINS(r.scatters), MAX_FREE - awarded); awarded += extra; left += extra; }
    totalUnits += r.units; free.push({ steps: r.steps, units: r.units, win: Math.round((bet * r.units) / 100), scatters: r.scatters, extra });
  }
  let win = Math.round((bet * totalUnits) / 100);
  const capped = win > bet * MAX_WIN_X; if (capped) win = bet * MAX_WIN_X;
  return { bet, win, units: totalUnits, capped, base: { steps: base.steps, units: base.units, win: Math.round((bet * base.units) / 100), scatters: base.scatters }, freeAwarded: awarded, free };
}

// 只算数（模拟 RTP 用，不保存步骤）
export function simulate(n, rng = cryptoRng()) {
  let paid = 0, hits = 0, features = 0, maxX = 0, freeUnits = 0;
  for (let i = 0; i < n; i++) {
    const s = spin(100, rng);
    const u = Math.min(s.units, 100 * MAX_WIN_X);
    paid += u; if (u > 0) hits++; if (s.freeAwarded) { features++; freeUnits += u - s.base.units; }
    if (u / 100 > maxX) maxX = u / 100;
  }
  return { spins: n, rtp: paid / (n * 100), hitRate: hits / n, featureRate: features / n, freeShare: freeUnits / Math.max(1, paid), maxX };
}
