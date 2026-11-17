// 补位玩家（服务器托管的电脑对手）：只在真人不够时由系统安排，玩家不能自己添加。
// 公平原则：决策函数只拿得到 botView() 给出的信息——自己的两张手牌 + 公共信息（公共牌、底池、要跟的数额、
// 合法操作、还剩几个对手）。拿不到别人的手牌，也拿不到牌堆。
import * as E from "./engine.js";

export const BOT_NAMES = ["阿杰", "小美", "老王", "风清扬", "夜猫子", "一路向北", "糖糖", "老K", "胖虎", "小鱼儿", "大熊", "阿飞", "浪子回头", "月半弯",
  "木木", "南风", "清风徐来", "阿龙", "小雨", "老张", "天天向上", "王大锤", "李逍遥", "七七", "豆豆", "晴天", "北北", "江南烟雨", "皮皮虾", "阿宝",
  "星辰大海", "小橙子", "老陈", "铁柱", "可乐加冰", "一笑而过", "小白", "大鹏", "阿香", "秋天的风"];
// 看起来真实的 VIP 等级分布（只是外观）
const VIP_W = [[0, 14], [1, 24], [2, 25], [3, 20], [4, 11], [5, 5], [6, 1]];
export function pickVip(rnd = Math.random) { let x = rnd() * 100; for (const [v, w] of VIP_W) { if ((x -= w) < 0) return v; } return 0; }
export function pickName(used, rnd = Math.random) {
  const free = BOT_NAMES.filter((n) => !used.has(n));
  if (free.length) return free[Math.floor(rnd() * free.length)];
  let n; do n = BOT_NAMES[Math.floor(rnd() * BOT_NAMES.length)] + Math.floor(10 + rnd() * 90); while (used.has(n)); return n;
}

// 机器人能看到的全部信息（别人的手牌、牌堆都不在里面）
export function botView(g, i) {
  const p = g.players[i];
  return {
    hole: p.hole.slice(), board: g.board.slice(), stage: g.stage, pot: E.pot(g), chips: p.chips, bet: p.bet,
    currentBet: g.currentBet, minRaise: g.minRaise, bb: g.bbAmt, legal: E.legal(g, i),
    opponents: g.players.filter((q, j) => j !== i && !q.out && !q.folded && q.hole.length === 2).length,
  };
}

// 手牌强度（对随机手牌的胜率）+ 底池赔率 + 一点随机性
export function decide(v, { iters = 300, rnd = Math.random } = {}) {
  const L = v.legal, opp = Math.max(1, v.opponents);
  const eq = E.equity(v.hole, v.board, opp, iters);
  const rel = eq * (opp + 1) + (rnd() - 0.5) * 0.35; // >1 = 比平均好
  const tc = L.call, odds = tc / (v.pot + tc || 1);
  const raiseTo = (frac) => {
    let to = v.currentBet + Math.max(v.minRaise, Math.round((v.pot * frac) / 10) * 10);
    if (to >= L.raiseMax) return { type: "allin" };
    return { type: "raise", to: Math.max(to, L.raiseMin) };
  };
  if (L.canRaise) {
    if (eq > 0.82 && v.stage !== "preflop" && rnd() < 0.3) return { type: "allin" };
    if (rel > 1.9) return raiseTo(0.6 + rnd() * 0.5);
    if (rel > 1.4 && rnd() < 0.45) return raiseTo(0.5);
    if (tc === 0 && rnd() < 0.06) return raiseTo(0.5); // 偶尔诈唬
  }
  if (tc === 0) return { type: "check" };
  if (eq >= odds * 1.1 || (tc <= v.bb && rel > 0.85)) {
    if (tc >= v.chips && rel < 1.3) return { type: "fold" };
    return { type: "call" };
  }
  return { type: "fold" };
}
