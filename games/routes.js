// 五个牌桌游戏的接口：所有结果在服务器用 crypto 随机数产生；每次结算一个数据库事务；余额永远不会变成负数
import * as BC from "./baccarat.js";
import * as BJ from "./blackjack.js";
import * as SB from "./sicbo.js";
import * as NN from "./niuniu.js";
import * as ZJ from "./zjh.js";
import { cardName } from "./cards.js";

export const GAMES = { baccarat: "百家乐", blackjack: "21点", sicbo: "骰宝", niuniu: "牛牛", zjh: "炸金花" };
export const CHIPS = [10, 50, 100, 500, 1000, 5000, 10000]; // 0.10 0.50 1 5 10 50 100
export const DEFAULT_LIMITS = Object.fromEntries([...Object.keys(GAMES), "mahjong"].map((g) => [g, { min: 10, max: 50000 }])); // 0.10 – 500.00

export function mountTables({ app, aget, apost, store, auth, houseId, pushMe, money, NO_CHIPS_MSG, onPlayed, rng, getLimits, setLimits }) {
  const busy = new Set();
  const lim = (g) => getLimits()[g];
  const cents = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const ERR = { INSUFFICIENT: [400, NO_CHIPS_MSG, "NO_CHIPS"], ACTIVE: [409, "上一局还没结束", "ACTIVE"], CONFLICT: [409, "牌局状态已变化，请刷新", "CONFLICT"], ILLEGAL: [400, "现在不能这样操作", "ILLEGAL"] };
  const run = (fn) => async (req, res, next) => {
    const uid = req.user.id;
    if (busy.has(uid)) return res.status(429).json({ error: "操作太快了，请稍等" });
    busy.add(uid);
    try { await fn(req, res, uid); }
    catch (e) { const x = ERR[e.message]; if (x) return res.status(x[0]).json({ error: x[1], code: x[2] }); next(e); }
    finally { busy.delete(uid); }
  };
  const checkRange = (g, amount) => { const L = lim(g); if (amount < L.min) return `最低下注 ${money(L.min)}`; if (amount > L.max) return `最高下注 ${money(L.max)}`; return null; };
  const done = (uid) => { pushMe(uid); Promise.resolve(onPlayed(uid)).catch((e) => console.error("onPlayed", e)); };
  const cardsTxt = (a) => a.map(cardName).join(" ");

  app.get("/api/games/config", (_req, res) => res.json({
    games: GAMES, chips: CHIPS, limits: getLimits(),
    baccarat: { pay: BC.PAY, spots: BC.SPOTS, names: BC.SPOT_NAME },
    sicbo: { sumPay: SB.SUM_PAY, spots: SB.SPOTS },
    niuniu: { maxMult: NN.MAX_MULT, commission: NN.COMMISSION },
    zjh: { blindPay: ZJ.BLIND_PAY },
    blackjack: { decks: BJ.DECKS, maxHands: BJ.MAX_HANDS },
  }));
  app.get("/api/games/:game/history", auth, async (req, res, next) => {
    try { const g = req.params.game; if (!GAMES[g]) return res.status(404).json({ error: "没有这个游戏" });
      res.json({ history: await store.slotHistory(req.user.id, g, 20), totals: await store.slotTotals(g, req.user.id) }); } catch (e) { next(e); }
  });

  // 多注位游戏：百家乐 / 骰宝
  function readBets(body, spots, g) {
    const bets = {}; let total = 0; const L = lim(g);
    for (const [k, v] of Object.entries(body?.bets || {})) {
      if (!spots.includes(k)) return { err: "无效的注位" };
      const a = cents(v); if (!a) continue;
      if (a < L.min) return { err: `每个注位最低 ${money(L.min)}` };
      bets[k] = a; total += a;
    }
    if (!total) return { err: "请先下注" };
    if (total > L.max) return { err: `单局总下注最高 ${money(L.max)}` };
    return { bets, total };
  }
  app.post("/api/games/baccarat/play", auth, run(async (req, res, uid) => {
    const b = readBets(req.body, BC.SPOTS, "baccarat"); if (b.err) return res.status(400).json({ error: b.err });
    if (req.user.balance < b.total) return res.status(400).json({ error: NO_CHIPS_MSG, code: "NO_CHIPS" });
    const r = BC.deal(rng); const s = BC.settle(b.bets, r);
    const label = `百家乐 下注 ${money(s.stake)}${s.payout ? ` 返还 ${money(s.payout)}` : ""}`;
    const saved = await store.slotSpin(uid, houseId, "baccarat", s.stake, s.payout, 0, label, { detail: { w: r.winner, p: r.p, b: r.b, pc: cardsTxt(r.player), bc: cardsTxt(r.banker) } });
    done(uid); res.json({ ...r, ...s, balance: saved.balance });
  }));
  app.post("/api/games/sicbo/play", auth, run(async (req, res, uid) => {
    const b = readBets(req.body, SB.SPOTS, "sicbo"); if (b.err) return res.status(400).json({ error: b.err });
    if (req.user.balance < b.total) return res.status(400).json({ error: NO_CHIPS_MSG, code: "NO_CHIPS" });
    const dice = SB.roll(rng); const s = SB.settle(b.bets, dice);
    const label = `骰宝 下注 ${money(s.stake)}${s.payout ? ` 返还 ${money(s.payout)}` : ""}`;
    const saved = await store.slotSpin(uid, houseId, "sicbo", s.stake, s.payout, 0, label, { detail: { dice } });
    done(uid); res.json({ dice, ...s, balance: saved.balance });
  }));
  app.post("/api/games/niuniu/play", auth, run(async (req, res, uid) => {
    const bet = cents(req.body?.bet); const e = checkRange("niuniu", bet); if (e) return res.status(400).json({ error: e });
    const need = bet * NN.MAX_MULT;
    if (req.user.balance < need) return res.status(400).json({ error: `${NO_CHIPS_MSG}（牛牛最多按 ${NN.MAX_MULT} 倍结算，需要余额 ${money(need)}）`, code: "NO_CHIPS" });
    const r = NN.play(rng, bet);
    const label = `牛牛 下注 ${money(bet)} ${r.win ? "赢" : "输"} ${money(Math.abs(r.net))}（${r.ph.name} 对 ${r.bh.name}）`;
    const saved = await store.slotSpin(uid, houseId, "niuniu", bet, r.payout, 0, label, { need, detail: { ph: r.ph.name, bh: r.bh.name, win: r.win, mult: r.mult } });
    done(uid); res.json({ ...r, bet, balance: saved.balance });
  }));

  // 21点（多步骤）
  const bjView = (round) => (round ? { id: round.id, ...BJ.view(round.state) } : null);
  app.get("/api/games/blackjack/state", auth, async (req, res, next) => { try { res.json({ round: bjView(await store.roundGet(req.user.id, "blackjack")) }); } catch (e) { next(e); } });
  const bjLabel = (s) => `21点 下注 ${money(BJ.stakeOf(s))}${s.result.payout ? ` 返还 ${money(s.result.payout)}` : ""}`;
  const bjDetail = (s) => ({ d: cardsTxt(s.dealer), dt: s.result.dealerTotal, h: s.hands.map((h) => ({ c: cardsTxt(h.cards), t: BJ.score(h.cards).total })), r: s.result.lines.map((l) => l.res) });
  app.post("/api/games/blackjack/start", auth, run(async (req, res, uid) => {
    const bet = cents(req.body?.bet); const e = checkRange("blackjack", bet); if (e) return res.status(400).json({ error: e });
    const cur = await store.roundGet(uid, "blackjack"); if (cur) return res.status(409).json({ error: "上一手还没打完", code: "ACTIVE", round: bjView(cur) });
    const s = BJ.start(rng, bet);
    if (s.phase === "done") { // 开局就有黑杰克：一次结算完
      const saved = await store.slotSpin(uid, houseId, "blackjack", bet, s.result.payout, 0, bjLabel(s), { detail: bjDetail(s) });
      done(uid); return res.json({ round: { id: null, ...BJ.view(s) }, balance: saved.balance });
    }
    const r = await store.roundStart(uid, "blackjack", bet, s, `21点 下注 ${money(bet)}`);
    pushMe(uid); res.json({ round: { id: r.id, ...BJ.view(s) }, balance: r.balance });
  }));
  app.post("/api/games/blackjack/action", auth, run(async (req, res, uid) => {
    const action = String(req.body?.action || "");
    const round = await store.roundGet(uid, "blackjack"); if (!round) return res.status(404).json({ error: "没有进行中的牌局" });
    const s = round.state; if (!BJ.legal(s).includes(action)) throw new Error("ILLEGAL");
    const extra = BJ.cost(s, action);
    if (extra && req.user.balance < extra) return res.status(400).json({ error: NO_CHIPS_MSG, code: "NO_CHIPS" });
    BJ.act(s, action, rng);
    const xl = `21点 ${{ double: "加倍", split: "分牌", insurance: "保险" }[action] || ""} ${money(extra)}`;
    if (s.phase === "done") {
      const saved = await store.roundSettle(round.id, round.ver, uid, houseId, "blackjack", s.result.payout, s, bjLabel(s), bjDetail(s), extra, xl);
      done(uid); return res.json({ round: { id: round.id, ...BJ.view(s) }, balance: saved.balance });
    }
    const u = await store.roundUpdate(round.id, round.ver, uid, s, extra, xl);
    if (extra) pushMe(uid);
    res.json({ round: { id: round.id, ...BJ.view(s) }, balance: u.balance });
  }));

  // 炸金花（多步骤：底注 → 看牌（可选）→ 跟 / 弃）
  const zjView = (round, end) => { if (!round) return null; const s = round.state;
    return { id: round.id, ante: s.ante, seen: s.seen, player: s.seen || end ? s.player : null, dealer: end ? s.dealer : null, result: end || null,
      hand: s.seen || end ? ZJ.evaluate(s.player).name : null }; };
  app.get("/api/games/zjh/state", auth, async (req, res, next) => { try { res.json({ round: zjView(await store.roundGet(req.user.id, "zjh")) }); } catch (e) { next(e); } });
  app.post("/api/games/zjh/start", auth, run(async (req, res, uid) => {
    const ante = cents(req.body?.ante); const e = checkRange("zjh", ante); if (e) return res.status(400).json({ error: e });
    const cur = await store.roundGet(uid, "zjh"); if (cur) return res.status(409).json({ error: "上一局还没结束", code: "ACTIVE", round: zjView(cur) });
    const d = ZJ.deal(rng);
    const r = await store.roundStart(uid, "zjh", ante, { ante, player: d.player, dealer: d.dealer, seen: false }, `炸金花 底注 ${money(ante)}`);
    pushMe(uid); res.json({ round: zjView({ id: r.id, state: { ante, player: d.player, dealer: d.dealer, seen: false } }), balance: r.balance });
  }));
  app.post("/api/games/zjh/action", auth, run(async (req, res, uid) => {
    const action = String(req.body?.action || "");
    const round = await store.roundGet(uid, "zjh"); if (!round) return res.status(404).json({ error: "没有进行中的牌局" });
    const s = round.state;
    if (action === "look") { if (s.seen) throw new Error("ILLEGAL"); s.seen = true; await store.roundUpdate(round.id, round.ver, uid, s, 0, ""); return res.json({ round: zjView(round) }); }
    if (action !== "call" && action !== "fold") throw new Error("ILLEGAL");
    const play = action === "call" ? (s.seen ? s.ante * 2 : s.ante) : 0;
    if (play && req.user.balance < play) return res.status(400).json({ error: NO_CHIPS_MSG, code: "NO_CHIPS" });
    const r = ZJ.settle(s.ante, play, !s.seen, s.player, s.dealer);
    const stake = s.ante + play;
    const label = `炸金花 ${action === "fold" ? "弃牌" : s.seen ? "看牌跟注" : "闷跟"} 下注 ${money(stake)}${r.payout ? ` 返还 ${money(r.payout)}` : ""}`;
    const end = { action, play, blind: !s.seen, payout: r.payout, result: r.result, qualified: r.qualified, pe: r.pe.name, de: r.de.name };
    const saved = await store.roundSettle(round.id, round.ver, uid, houseId, "zjh", r.payout, s, label, { p: cardsTxt(s.player), d: cardsTxt(s.dealer), pe: r.pe.name, de: r.de.name, res: r.result }, play, `炸金花 跟注 ${money(play)}`);
    done(uid); res.json({ round: zjView(round, end), balance: saved.balance });
  }));

  // 后台：每个游戏的下注、返还、庄家盈亏、实际回报率，以及最低/最高下注
  aget("/games", async (_req, res) => {
    const out = {};
    for (const g of [...Object.keys(GAMES), "mahjong"]) { const t = await store.slotTotals(g); out[g] = { name: GAMES[g] || "时烽麻将消消乐", ...t, profit: t.bets - t.wins, rtp: t.bets ? t.wins / t.bets : null, limits: lim(g) }; }
    res.json(out);
  });
  aget("/games/:game/recent", async (req, res) => { const g = req.params.game; if (!GAMES[g] && g !== "mahjong") return res.status(404).json({ error: "没有这个游戏" }); res.json(await store.slotHistory(null, g, 30)); });
  apost("/games/limits", async (req, res) => {
    const g = String(req.body?.game || ""); if (!GAMES[g] && g !== "mahjong") return res.status(404).json({ error: "没有这个游戏" });
    const min = cents(req.body?.min), max = cents(req.body?.max);
    if (!min || !max || min > max || max > 100000000) return res.status(400).json({ error: "请输入有效的最低/最高下注（最低 ≤ 最高）" });
    await setLimits(g, { min, max }); res.json({ ok: true, limits: getLimits() });
  });
}
