export type Stage = "setup" | "preflop" | "flop" | "turn" | "river" | "handover" | "gameover";
export interface Player { id: number; name: string; bot: boolean; sitOut: boolean; chips: number; bet: number; total: number; hole: number[]; folded: boolean; allIn: boolean; out: boolean; acted: boolean; last: string; handName: string; won: number; }
export interface Game { players: Player[]; deck: number[]; board: number[]; dealer: number; sb: number; bb: number; stage: Stage; current: number; currentBet: number; minRaise: number; log: string[]; handNo: number; showdown: boolean; winners: number[]; sbAmt: number; bbAmt: number; startChips: number; }
export interface Config { start: number; sb: number; bb: number; }
const RN = ["", "", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SU = ["♠", "♥", "♦", "♣"];
export const rankOf = (c: number) => (c % 13) + 2;
export const suitOf = (c: number) => Math.floor(c / 13);
export const cardLabel = (c: number) => RN[rankOf(c)] + SU[suitOf(c)];
export const rankLabel = (c: number) => RN[rankOf(c)];
export const suitLabel = (c: number) => SU[suitOf(c)];
export const isRed = (c: number) => suitOf(c) === 1 || suitOf(c) === 2;
export const CAT = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"];
export function eval5(cs: number[]): number {
  const r = cs.map(rankOf).sort((a, b) => b - a);
  const flush = cs.every((c) => suitOf(c) === suitOf(cs[0]));
  const cnt: Record<number, number> = {};
  r.forEach((x) => (cnt[x] = (cnt[x] || 0) + 1));
  const groups = Object.keys(cnt).map(Number).sort((a, b) => cnt[b] - cnt[a] || b - a);
  let straightHigh = 0;
  if (groups.length === 5) {
    if (r[0] - r[4] === 4) straightHigh = r[0];
    else if (r[0] === 14 && r[1] === 5) straightHigh = 5;
  }
  let cat = 0; let tb: number[] = groups;
  const c0 = cnt[groups[0]], c1 = groups.length > 1 ? cnt[groups[1]] : 0;
  if (straightHigh && flush) { cat = 8; tb = [straightHigh]; }
  else if (c0 === 4) cat = 7;
  else if (c0 === 3 && c1 === 2) cat = 6;
  else if (flush) { cat = 5; tb = r; }
  else if (straightHigh) { cat = 4; tb = [straightHigh]; }
  else if (c0 === 3) cat = 3;
  else if (c0 === 2 && c1 === 2) cat = 2;
  else if (c0 === 2) cat = 1;
  else { cat = 0; tb = r; }
  let s = cat;
  for (let i = 0; i < 5; i++) s = s * 15 + (tb[i] || 0);
  return s;
}
export function best7(cs: number[]): number {
  let best = -1; const n = cs.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const five: number[] = [];
    for (let i = 0; i < n; i++) if (i !== a && i !== b) five.push(cs[i]);
    if (n === 7) { const v = eval5(five); if (v > best) best = v; }
  }
  if (n < 7) { // fallback for 5/6 cards
    const combos = (arr: number[], k: number): number[][] => k === 0 ? [[]] : arr.flatMap((x, i) => combos(arr.slice(i + 1), k - 1).map((c) => [x, ...c]));
    combos(cs, 5).forEach((f) => { const v = eval5(f); if (v > best) best = v; });
  }
  return best;
}
export function scoreName(s: number): string {
  const cat = Math.floor(s / 15 ** 5);
  if (cat === 8 && s % 15 ** 5 === 14 * 15 ** 4) return "皇家同花顺";
  return CAT[cat];
}
const clone = (g: Game): Game => JSON.parse(JSON.stringify(g));
export function mkPlayer(id: number, name: string, bot: boolean, chips: number): Player {
  return { id, name, bot, sitOut: false, chips, bet: 0, total: 0, hole: [], folded: true, allIn: false, out: true, acted: false, last: "", handName: "", won: 0 };
}
export function newGame(seats: { name: string; bot: boolean }[], cfg: Config): Game {
  const players = seats.map((s, i) => mkPlayer(i, s.name, s.bot, cfg.start));
  const g: Game = { players, deck: [], board: [], dealer: Math.floor(Math.random() * players.length), sb: -1, bb: -1, stage: "handover", current: -1, currentBet: 0, minRaise: cfg.bb, log: [], handNo: 0, showdown: false, winners: [], sbAmt: cfg.sb, bbAmt: cfg.bb, startChips: cfg.start };
  return startHand(g, true);
}
export function addPlayer(g: Game, name: string, bot: boolean): Game { g.players.push(mkPlayer(g.players.length, name, bot, g.startChips)); return g; }
export const canStart = (g: Game) => g.players.filter((p) => p.chips > 0 && !p.sitOut).length >= 2;
export function nextSeat(g: Game, from: number, pred: (p: Player) => boolean): number {
  const n = g.players.length;
  for (let k = 1; k <= n; k++) { const i = (from + k) % n; if (pred(g.players[i])) return i; }
  return -1;
}
const live = (p: Player) => !p.out;
const canAct = (p: Player) => !p.out && !p.folded && !p.allIn;
function shuffled(): number[] { const d = Array.from({ length: 52 }, (_, i) => i); for (let i = 51; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; } return d; }
function put(g: Game, i: number, amt: number) { const p = g.players[i]; const a = Math.min(amt, p.chips); p.chips -= a; p.bet += a; p.total += a; if (p.chips === 0) p.allIn = true; return a; }
export function startHand(g0: Game, first = false, deck?: number[]): Game {
  const g = clone(g0);
  if (g.stage !== "handover" && g.stage !== "gameover") g.players.forEach((p) => { p.chips += p.total; p.total = 0; }); // 未完成的一手：退回筹码
  g.players.forEach((p) => { p.out = p.chips <= 0 || p.sitOut; Object.assign(p, { bet: 0, total: 0, hole: [], folded: p.out, allIn: false, acted: false, last: "", handName: "", won: 0 }); });
  if (!first) g.dealer = nextSeat(g, g.dealer, live);
  else if (g.players[g.dealer].out) g.dealer = nextSeat(g, g.dealer, live);
  g.handNo++; g.deck = deck ? [...deck] : shuffled(); g.board = []; g.showdown = false; g.winners = [];
  const alive = g.players.filter(live).length;
  if (alive === 2) { g.sb = g.dealer; g.bb = nextSeat(g, g.dealer, live); }
  else { g.sb = nextSeat(g, g.dealer, live); g.bb = nextSeat(g, g.sb, live); }
  g.log = [...g.log, `—— 第 ${g.handNo} 手 ——`].slice(-40);
  put(g, g.sb, g.sbAmt); g.players[g.sb].last = `小盲 ${g.players[g.sb].bet}`;
  put(g, g.bb, g.bbAmt); g.players[g.bb].last = `大盲 ${g.players[g.bb].bet}`;
  for (let r = 0; r < 2; r++) { let i = g.sb; for (let k = 0; k < alive; k++) { g.players[i].hole.push(g.deck.pop() as number); i = nextSeat(g, i, live); } }
  g.stage = "preflop"; g.currentBet = g.bbAmt; g.minRaise = g.bbAmt;
  g.current = nextSeat(g, g.bb, canAct);
  return settle(g);
}
export const toCall = (g: Game, i: number) => Math.max(0, g.currentBet - g.players[i].bet);
export const pot = (g: Game) => g.players.reduce((s, p) => s + p.total, 0);
const needs = (g: Game, p: Player) => canAct(p) && (!p.acted || p.bet < g.currentBet);
export interface Legal { fold: boolean; check: boolean; call: number; raiseMin: number; raiseMax: number; canRaise: boolean; allIn: boolean; }
export function legal(g: Game, i: number): Legal {
  const p = g.players[i]; const tc = toCall(g, i);
  const maxTo = p.bet + p.chips;
  const minTo = Math.min(g.currentBet + g.minRaise, maxTo);
  const othersCanAct = g.players.some((q, j) => j !== i && canAct(q));
  const canRaise = !p.acted && p.chips > tc && othersCanAct;
  return { fold: true, check: tc === 0, call: Math.min(tc, p.chips), raiseMin: minTo, raiseMax: maxTo, canRaise, allIn: p.chips > 0 && (canRaise || p.chips <= tc) };
}
export type Action = { type: "fold" } | { type: "check" } | { type: "call" } | { type: "raise"; to: number } | { type: "allin" };
export function act(g0: Game, a: Action): Game {
  const g = clone(g0); const i = g.current; const p = g.players[i]; const L = legal(g, i);
  const log = (s: string) => { g.log = [...g.log, `${p.name}：${s}`].slice(-40); p.last = s; };
  let type = a.type; let to = a.type === "raise" ? a.to : 0;
  if (type === "allin") { to = p.bet + p.chips; type = to > g.currentBet ? "raise" : "call"; }
  if (type === "check" && !L.check) type = "call";
  if (type === "raise") {
    if (!L.canRaise) type = "call";
    else { to = Math.max(L.raiseMin, Math.min(to, L.raiseMax)); if (to <= g.currentBet) type = "call"; }
  }
  if (type === "fold") { p.folded = true; log("弃牌"); }
  else if (type === "check") { log("过牌"); }
  else if (type === "call") { const amt = put(g, i, L.call); log(p.allIn ? `全下跟注 ${amt}` : `跟注 ${amt}`); }
  else {
    const prev = g.currentBet; put(g, i, to - p.bet);
    const inc = p.bet - prev;
    if (inc >= g.minRaise) { g.minRaise = inc; g.players.forEach((q) => (q.acted = false)); }
    g.currentBet = Math.max(prev, p.bet);
    log(p.allIn ? `全下 ${p.bet}` : prev === 0 ? `下注 ${p.bet}` : `加注到 ${p.bet}`);
  }
  p.acted = true;
  return settle(g);
}
function settle(g: Game): Game {
  const inHand = g.players.filter((p) => !p.out && !p.folded);
  if (inHand.length === 1) return finish(g, false);
  if (g.current >= 0 && needs(g, g.players[g.current])) return g;
  const next = nextSeat(g, g.current >= 0 ? g.current : g.dealer, (p) => needs(g, p));
  if (next !== -1) { g.current = next; return g; }
  // round complete
  const actors = inHand.filter((p) => !p.allIn).length;
  if (g.stage === "river") return finish(g, true);
  g.players.forEach((p) => { p.bet = 0; p.acted = false; });
  g.currentBet = 0; g.minRaise = g.bbAmt;
  g.stage = g.stage === "preflop" ? "flop" : g.stage === "flop" ? "turn" : "river";
  g.deck.pop(); // burn
  const k = g.stage === "flop" ? 3 : 1;
  for (let j = 0; j < k; j++) g.board.push(g.deck.pop() as number);
  g.log = [...g.log, `${g.stage === "flop" ? "翻牌" : g.stage === "turn" ? "转牌" : "河牌"}：${g.board.map(cardLabel).join(" ")}`].slice(-40);
  if (actors <= 1) { g.current = -1; return settle2(g); }
  g.current = nextSeat(g, g.dealer, canAct);
  return g;
}
function settle2(g: Game): Game {
  // no betting possible: run out
  while (g.board.length < 5) { g.deck.pop(); g.board.push(g.deck.pop() as number); }
  g.log = [...g.log, `发完公共牌：${g.board.map(cardLabel).join(" ")}`].slice(-40);
  return finish(g, true);
}
export function pots(players: Player[]): { amount: number; eligible: number[] }[] {
  const levels = Array.from(new Set(players.filter((p) => p.total > 0).map((p) => p.total))).sort((a, b) => a - b);
  const res: { amount: number; eligible: number[] }[] = []; let prev = 0;
  for (const lv of levels) {
    let amount = 0; players.forEach((p) => (amount += Math.min(p.total, lv) - Math.min(p.total, prev)));
    const eligible = players.filter((p) => !p.folded && !p.out && p.total >= lv).map((p) => p.id);
    if (eligible.length === 0 && res.length) res[res.length - 1].amount += amount;
    else if (res.length && eligible.join() === res[res.length - 1].eligible.join()) res[res.length - 1].amount += amount;
    else res.push({ amount, eligible });
    prev = lv;
  }
  return res;
}
function finish(g: Game, showdown: boolean): Game {
  g.current = -1; g.showdown = showdown; g.stage = "handover";
  const total = pot(g);
  const winners = new Set<number>();
  if (!showdown) {
    const w = g.players.find((p) => !p.out && !p.folded) as Player;
    w.chips += total; w.won = total; winners.add(w.id);
    g.log = [...g.log, `${w.name} 赢得 ${total}（其他人弃牌）`].slice(-40);
  } else {
    const score: Record<number, number> = {};
    g.players.forEach((p) => { if (!p.out && !p.folded) { score[p.id] = best7([...p.hole, ...g.board]); p.handName = scoreName(score[p.id]); } });
    const ps = pots(g.players);
    ps.forEach((pt, idx) => {
      const best = Math.max(...pt.eligible.map((id) => score[id]));
      const ws = pt.eligible.filter((id) => score[id] === best);
      // order winners from left of dealer for odd chips
      const order: number[] = []; let s = g.dealer;
      for (let k = 0; k < g.players.length; k++) { s = (s + 1) % g.players.length; if (ws.includes(s)) order.push(s); }
      const share = Math.floor(pt.amount / ws.length); let rem = pt.amount - share * ws.length;
      order.forEach((id) => { const add = share + (rem > 0 ? 1 : 0); if (rem > 0) rem--; g.players[id].chips += add; g.players[id].won += add; winners.add(id); });
      const label = ps.length > 1 ? (idx === 0 ? "主池" : `边池${idx}`) : "底池";
      if (pt.eligible.length === 1) g.log = [...g.log, `${g.players[ws[0]].name} 收回 ${pt.amount}`].slice(-40);
      else g.log = [...g.log, `${label} ${pt.amount}：${order.map((id) => g.players[id].name).join("、")} ${ws.length > 1 ? "平分" : "赢得"}（${g.players[ws[0]].handName}）`].slice(-40);
    });
  }
  g.winners = Array.from(winners);
  g.players.forEach((p) => { p.bet = 0; });
  if (g.players.filter((p) => p.chips > 0).length <= 1) g.stage = "gameover";
  return g;
}
// ---------- AI ----------
export function equity(hole: number[], board: number[], opp: number, iters: number): number {
  const used = new Set([...hole, ...board]); const rest: number[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  let win = 0;
  for (let it = 0; it < iters; it++) {
    const d = rest.slice(); let n = d.length;
    const draw = () => { const j = Math.floor(Math.random() * n); const c = d[j]; d[j] = d[n - 1]; n--; return c; };
    const b = board.slice(); while (b.length < 5) b.push(draw());
    const me = best7([...hole, ...b]); let bestOpp = -1, ties = 0;
    for (let o = 0; o < opp; o++) { const v = best7([draw(), draw(), ...b]); if (v > bestOpp) { bestOpp = v; } }
    if (me > bestOpp) win += 1; else if (me === bestOpp) { ties++; win += 0.5; }
  }
  return win / iters;
}
export function aiDecide(g: Game, iters = 200): Action {
  const i = g.current; const p = g.players[i]; const L = legal(g, i);
  const opp = g.players.filter((q) => !q.out && !q.folded && q.id !== i).length;
  const eq = equity(p.hole, g.board, Math.max(1, opp), iters);
  const fair = 1 / (opp + 1);
  const rel = eq / fair; // >1 better than average
  const noise = (Math.random() - 0.5) * 0.3;
  const P = pot(g); const tc = L.call;
  const odds = tc / (P + tc || 1);
  const r = rel + noise;
  const raiseTo = (frac: number): Action => {
    let to = g.currentBet + Math.max(g.minRaise, Math.round((P * frac) / 10) * 10);
    if (to >= L.raiseMax) return { type: "allin" };
    return { type: "raise", to: Math.max(to, L.raiseMin) };
  };
  if (L.canRaise) {
    if (eq > 0.8 && Math.random() < 0.35 && g.stage !== "preflop") return { type: "allin" };
    if (r > 1.9) return raiseTo(0.75 + Math.random() * 0.5);
    if (r > 1.4 && Math.random() < 0.5) return raiseTo(0.5);
    if (tc === 0 && Math.random() < 0.07) return raiseTo(0.5); // bluff
  }
  if (tc === 0) return { type: "check" };
  if (eq >= odds * 1.1 + noise * 0.2 || (tc <= g.bbAmt && r > 0.8)) {
    if (tc >= p.chips && rel < 1.3) return { type: "fold" };
    return { type: "call" };
  }
  return { type: "fold" };
}
