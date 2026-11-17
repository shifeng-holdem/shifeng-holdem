// 牌桌游戏：百家乐 / 21点 / 骰宝 / 牛牛 / 炸金花。前端只负责下注和播放动画，所有结果由服务器计算。
(() => {
  const GAMES = {
    baccarat: { title: "百家乐", tag: "庄闲之间，自有乾坤", multi: true },
    blackjack: { title: "21点", tag: "差一点是遗憾，刚刚好是传奇" },
    sicbo: { title: "骰宝", tag: "三骰落定，大小由天", multi: true },
    niuniu: { title: "牛牛", tag: "牛气冲天，一把定输赢" },
    zjh: { title: "炸金花", tag: "三张定胜负，胆大赢天下" },
  };
  const CHIPS = [10, 50, 100, 500, 1000, 5000, 10000];
  const chipLbl = (c) => (c >= 100 ? String(c / 100) : (c / 100).toFixed(1));
  let cfg = null, game = null, chip = +localStorage.getItem("tg_chip") || 100, bets = {}, last = {}, busy = false, round = null, road = JSON.parse(localStorage.getItem("tg_road") || "[]");
  if (!CHIPS.includes(chip)) chip = 100;
  const RMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const sleep = (ms) => new Promise((r) => setTimeout(r, RMQ.matches ? 0 : ms));
  const snd = (k, a) => { try { window.SFX && SFX[k](a); } catch (e) {} };
  const say = (id) => snd("voice", id);
  const call = async (method, path, body) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json", authorization: "Bearer " + authToken }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, d };
  };
  const lim = () => (cfg && cfg.limits[game]) || { min: 10, max: 50000 };
  const total = () => Object.values(bets).reduce((a, b) => a + b, 0);
  function setBal(b) { if (b == null || !me) return; setMe({ ...me, balance: b }); }
  function balRender() { if (me) $("tgBal").textContent = M(me.balance); }
  const card = (c, cls = "") => (c == null ? `<div class="pc t back ${cls}"></div>` : cardHtml(c, "t " + cls));

  // ---------- 公共：筹码、注位、结果横幅 ----------
  function chipsHtml() { return CHIPS.map((c) => `<button class="chip c${c} ${c === chip ? "on" : ""}" data-c="${c}"><span>${chipLbl(c)}</span></button>`).join(""); }
  function stackHtml(a) {
    if (!a) return "";
    let left = a, n = 0, h = ""; for (let i = CHIPS.length - 1; i >= 0 && n < 5; i--) while (left >= CHIPS[i] && n < 5) { h += `<i class="chip c${CHIPS[i]}" style="--k:${n}"></i>`; left -= CHIPS[i]; n++; }
    return `<span class="stk">${h}</span><b>${M(a)}</b>`;
  }
  const spot = (id, name, pay, cls = "") => `<div class="spot ${cls}" data-s="${id}"><div class="sn">${name}</div>${pay ? `<div class="sp">${pay}</div>` : ""}<div class="sb"></div></div>`;
  function paintSpots() {
    document.querySelectorAll("#tgTable .spot").forEach((el) => { const a = bets[el.dataset.s] || 0; el.querySelector(".sb").innerHTML = stackHtml(a); el.classList.toggle("has", a > 0); });
    const t = $("tgTotal"); if (t) t.textContent = M(total());
  }
  function addBet(s) {
    if (busy || (round && round.phase !== "done" && !["baccarat", "sicbo"].includes(game))) return;
    if (round && round.phase === "done") resetRound();
    const L = lim(), single = !GAMES[game].multi, t = total() + chip;
    if (t > L.max) return toast(`${single ? "下注" : "单局总下注"}最高 ${M(L.max)}`);
    const need = game === "niuniu" ? t * 5 : t;
    if (!me || me.balance < need) return toast(game === "niuniu" ? `余额不足：牛牛最多按 5 倍结算，需要 ${M(need)}` : "余额不足，请联系客服获取游戏币");
    bets[s] = (bets[s] || 0) + chip; snd("chip"); hideRes(); paintSpots(); renderActs();
    const el = document.querySelector(`#tgTable .spot[data-s="${s}"]`); if (el && el.animate && !RMQ.matches) el.animate([{ transform: "scale(.96)" }, { transform: "scale(1)" }], { duration: 160 });
  }
  function clearBets() { if (busy) return; bets = {}; paintSpots(); renderActs(); }
  function rebet() { if (busy) return; if (round && round.phase === "done") resetRound(); bets = { ...last }; paintSpots(); renderActs(); }
  function showRes(html, kind = "") { for (const id of ["tgRes", "tgRes2"]) { const r = $(id); r.className = "tgres " + kind; r.innerHTML = `<div class="in">${html}</div>`; if (r.animate && !RMQ.matches) r.firstChild.animate([{ transform: "perspective(600px) rotateX(50deg) scale(.5)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 420, easing: "cubic-bezier(.2,1.4,.4,1)" }); } }
  function hideRes() { $("tgRes").className = $("tgRes2").className = "tgres hidden"; }
  function winFx(net, stake) {
    if (net > 0) { snd(net >= stake * 5 ? "bigWin" : "win"); say("tg_win"); } else if (net < 0) { snd("lose"); } else say("tg_push");
  }
  const netTxt = (n) => (n > 0 ? `<span class="up">+${M(n)}</span>` : n < 0 ? `<span class="dn">-${M(-n)}</span>` : `<span>±0.00</span>`);
  async function dealIn(boxId, cardsArr, opts = {}) { // 一张一张发牌并翻开
    const box = $(boxId);
    for (let i = 0; i < cardsArr.length; i++) {
      const c = cardsArr[i]; const tmp = document.createElement("div"); tmp.innerHTML = card(c, (opts.cls ? opts.cls(i) : "") + " flip"); const el = tmp.firstChild;
      box.appendChild(el); snd("flip"); await sleep(opts.gap ?? 260);
    }
  }

  // ---------- 各游戏的牌桌 ----------
  const TABLE = {
    baccarat: () => `<div class="road" id="bcRoad"></div>
      <div class="bchands"><div class="bch p"><div class="hl">闲 <b class="pt" id="bcPt"></b></div><div class="cards" id="bcP"></div></div>
        <div class="bch b"><div class="hl">庄 <b class="pt" id="bcBt"></b></div><div class="cards" id="bcB"></div></div></div>
      <div class="spots bc"><div class="srow">${spot("ppair", "闲对", "1:11", "sm blue")}${spot("tie", "和", "1:8", "sm green")}${spot("bpair", "庄对", "1:11", "sm red")}</div>
        <div class="srow">${spot("player", "闲", "1:1", "big blue")}${spot("banker", "庄", "1:0.95", "big red")}</div></div>`,
    sicbo: () => {
      const S = cfg ? cfg.sicbo.sumPay : {};
      return `<div class="dicebox"><div class="bowl">${[0, 1, 2].map((i) => `<div class="die" id="die${i}">${[1, 2, 3, 4, 5, 6].map((n) => `<div class="f f${n}">${pips(n)}</div>`).join("")}</div>`).join("")}</div><div class="dsum" id="sbSum">请下注</div></div>
      <div class="spots sbo"><div class="srow">${spot("small", "小", "4–10 · 1:1", "red")}${spot("odd", "单", "1:1")}${spot("anyTriple", "全围", "1:30", "gold")}${spot("even", "双", "1:1")}${spot("big", "大", "11–17 · 1:1", "red")}</div>
        <div class="sgrid s7">${[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((n) => spot("sum" + n, n, "1:" + (S[n] || ""), "xs")).join("")}</div>
        <div class="sgrid s6">${[1, 2, 3, 4, 5, 6].map((n) => spot("triple" + n, `<span class="mini3">${pipDie(n)}${pipDie(n)}${pipDie(n)}</span>`, "1:180", "xs gold")).join("")}</div>
        <div class="sgrid s6">${[1, 2, 3, 4, 5, 6].map((n) => spot("single" + n, pipDie(n), "1/2/3", "xs")).join("")}</div></div>`;
    },
    niuniu: () => `<div class="hand2"><div class="hl">庄家 <span class="nt" id="nnBt"></span></div><div class="cards five" id="nnB"></div></div>
      <div class="hand2"><div class="hl">我的牌 <span class="nt" id="nnPt"></span></div><div class="cards five" id="nnP"></div></div>
      <div class="spots one">${spot("bet", "下注", "最多按 5 倍结算", "big gold")}</div>`,
    blackjack: () => `<div class="hand2"><div class="hl">庄家 <b class="pt" id="bjDt"></b></div><div class="cards" id="bjD"></div></div>
      <div class="bjhands" id="bjH"></div>
      <div class="spots one">${spot("bet", "下注", "黑杰克 3:2 · 软17停", "big gold")}</div>`,
    zjh: () => `<div class="hand2"><div class="hl">庄家 <span class="nt" id="zjDt"></span></div><div class="cards" id="zjD"></div></div>
      <div class="hand2"><div class="hl">我的牌 <span class="nt" id="zjPt"></span></div><div class="cards" id="zjP"></div></div>
      <div class="spots one">${spot("bet", "底注", "看牌跟 2 倍 · 闷跟 1 倍", "big gold")}</div>`,
  };
  const PIP = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  function pips(n) { return Array.from({ length: 9 }, (_, i) => `<i class="${PIP[n].includes(i + 1) ? "on" : ""}${n === 1 || n === 4 ? " r" : ""}"></i>`).join(""); }
  const pipDie = (n) => `<span class="pdie">${pips(n)}</span>`;
  const FACE_ROT = { 1: "rotateX(0deg) rotateY(0deg)", 2: "rotateX(-90deg)", 3: "rotateY(-90deg)", 4: "rotateY(90deg)", 5: "rotateX(90deg)", 6: "rotateY(180deg)" };
  function setDie(i, n, rolling) { const d = $("die" + i); if (!d) return; d.classList.toggle("rolling", !!rolling); d.style.transform = `rotateX(-22deg) rotateY(28deg) ${FACE_ROT[n]}`; }

  // ---------- 操作按钮 ----------
  function renderActs() {
    const a = $("tgAct"); let h = "";
    const t = total(), has = t > 0, lastT = Object.values(last).reduce((x, y) => x + y, 0);
    const basic = `<button class="ghost" data-a="clear" ${!has || busy ? "disabled" : ""}>清除</button><button class="ghost" data-a="rebet" ${!lastT || busy || has ? "disabled" : ""}>重复</button>`;
    if (game === "baccarat" || game === "sicbo") h = basic + `<button class="pri big" data-a="go" ${!has || busy ? "disabled" : ""}>${game === "sicbo" ? "摇骰" : "发牌"}</button>`;
    else if (game === "niuniu") h = basic + `<button class="pri big" data-a="go" ${!has || busy ? "disabled" : ""}>开牌</button>`;
    else if (game === "blackjack") {
      if (round && round.phase === "insurance") h = `<button class="blue" data-a="insurance">买保险 ${M(Math.floor(round.bet / 2))}</button><button class="ghost" data-a="noInsurance">不买</button>`;
      else if (round && round.phase === "play") h = ["hit:要牌", "stand:停牌", "double:加倍", "split:分牌"].map((x) => { const [k, n] = x.split(":"); return `<button class="${k === "stand" ? "pri" : k === "hit" ? "blue" : "ghost"}" data-a="${k}" ${round.legal.includes(k) && !busy ? "" : "disabled"}>${n}</button>`; }).join("");
      else h = basic + `<button class="pri big" data-a="go" ${!has || busy ? "disabled" : ""}>发牌</button>`;
    } else if (game === "zjh") {
      if (round && round.phase === "decide") h = `${round.seen ? "" : `<button class="blue" data-a="look" ${busy ? "disabled" : ""}>看牌</button>`}<button class="pri" data-a="call" ${busy ? "disabled" : ""}>${round.seen ? "跟" : "闷跟"} ${M(round.seen ? round.ante * 2 : round.ante)}</button><button class="red" data-a="fold" ${busy ? "disabled" : ""}>弃牌</button>`;
      else h = basic + `<button class="pri big" data-a="go" ${!has || busy ? "disabled" : ""}>下底注发牌</button>`;
    }
    a.innerHTML = h + `<div class="tgtot">本局下注 <b id="tgTotal">${M(t)}</b> · 限额 ${M(lim().min)}–${M(lim().max)}</div>`;
    a.querySelectorAll("button[data-a]").forEach((b) => b.onclick = () => act(b.dataset.a));
  }
  function act(a) {
    if (a === "clear") return clearBets();
    if (a === "rebet") return rebet();
    if (a === "go") return PLAY[game]();
    if (game === "blackjack") return bjAct(a);
    if (game === "zjh") return zjAct(a);
  }
  function resetRound() { round = null; if (game === "blackjack") { $("bjD").innerHTML = ""; $("bjH").innerHTML = ""; $("bjDt").textContent = ""; } if (game === "zjh") { $("zjD").innerHTML = ""; $("zjP").innerHTML = ""; $("zjDt").textContent = $("zjPt").textContent = ""; } if (game === "niuniu") { $("nnB").innerHTML = $("nnP").innerHTML = ""; $("nnBt").textContent = $("nnPt").textContent = ""; } }
  const fail = (r) => { if (r.d.code === "NO_CHIPS") say("mj_nochips"); toast(r.d.error || "出错了，请重试"); };

  // ---------- 百家乐 ----------
  function paintRoad() { const el = $("bcRoad"); if (!el) return; el.innerHTML = road.slice(-36).map((w) => `<i class="${w}">${{ player: "闲", banker: "庄", tie: "和" }[w]}</i>`).join("") || `<span class="muted">珠盘路</span>`; }
  const PLAY = {};
  PLAY.baccarat = async () => {
    if (busy || !total()) return; busy = true; renderActs(); hideRes();
    $("bcP").innerHTML = $("bcB").innerHTML = ""; $("bcPt").textContent = $("bcBt").textContent = ""; document.querySelectorAll(".spot.win").forEach((x) => x.classList.remove("win"));
    const r = await call("POST", "/api/games/baccarat/play", { bets });
    if (!r.ok) { busy = false; renderActs(); return fail(r); }
    const d = r.d; last = { ...bets }; snd("deal");
    const pt = (cs) => cs.reduce((a, c) => { const k = c % 13; return a + (k === 12 ? 1 : k <= 7 ? k + 2 : 0); }, 0) % 10;
    const order = [["bcP", d.player[0]], ["bcB", d.banker[0]], ["bcP", d.player[1]], ["bcB", d.banker[1]]];
    for (const [box, c] of order) { await dealIn(box, [c]); }
    $("bcPt").textContent = pt(d.player.slice(0, 2)); $("bcBt").textContent = pt(d.banker.slice(0, 2));
    if (d.player[2] != null) { await sleep(300); await dealIn("bcP", [d.player[2]], { cls: () => "third" }); $("bcPt").textContent = d.p; }
    if (d.banker[2] != null) { await sleep(300); await dealIn("bcB", [d.banker[2]], { cls: () => "third" }); $("bcBt").textContent = d.b; }
    await sleep(250);
    ["player", "banker", "tie"].forEach((k) => { if (k === d.winner) document.querySelector(`.spot[data-s="${k}"]`).classList.add("win"); });
    if (d.ppair) document.querySelector('.spot[data-s="ppair"]').classList.add("win"); if (d.bpair) document.querySelector('.spot[data-s="bpair"]').classList.add("win");
    road.push(d.winner); road = road.slice(-60); localStorage.setItem("tg_road", JSON.stringify(road)); paintRoad();
    say(d.winner === "tie" ? "bc_tie" : d.winner === "player" ? "bc_player" : "bc_banker");
    const net = d.payout - d.stake;
    showRes(`<div class="t">${{ player: "闲赢", banker: "庄赢", tie: "和局" }[d.winner]} <small>${d.p} : ${d.b}</small></div><div class="n">${netTxt(net)}</div>`, net > 0 ? "good" : "");
    await sleep(600); winFx(net, d.stake);
    setBal(d.balance); bets = {}; paintSpots(); busy = false; renderActs();
  };
  // ---------- 骰宝 ----------
  PLAY.sicbo = async () => {
    if (busy || !total()) return; busy = true; renderActs(); hideRes(); document.querySelectorAll(".spot.win").forEach((x) => x.classList.remove("win"));
    $("sbSum").textContent = "摇骰中…"; [0, 1, 2].forEach((i) => setDie(i, 1 + ((i * 2) % 6), true)); snd("dice");
    const r = await call("POST", "/api/games/sicbo/play", { bets });
    if (!r.ok) { [0, 1, 2].forEach((i) => setDie(i, 1, false)); $("sbSum").textContent = "请下注"; busy = false; renderActs(); return fail(r); }
    const d = r.d; last = { ...bets }; await sleep(900);
    for (let i = 0; i < 3; i++) { setDie(i, d.dice[i], false); snd("reelStop", i); await sleep(180); }
    const sum = d.dice[0] + d.dice[1] + d.dice[2], triple = d.dice[0] === d.dice[1] && d.dice[1] === d.dice[2];
    $("sbSum").innerHTML = `<b>${sum}</b> 点 · ${triple ? "围骰" : sum >= 11 ? "大" : "小"} · ${triple ? "" : sum % 2 ? "单" : "双"}`;
    d.lines.filter((l) => l.back > 0).forEach((l) => { const el = document.querySelector(`.spot[data-s="${l.spot}"]`); if (el) el.classList.add("win"); });
    say(triple ? "sb_triple" : sum >= 11 ? "sb_big" : "sb_small");
    const net = d.payout - d.stake; await sleep(500);
    showRes(`<div class="t">${d.dice.join(" · ")} = ${sum}</div><div class="n">${netTxt(net)}</div>`, net > 0 ? "good" : ""); winFx(net, d.stake);
    setBal(d.balance); bets = {}; paintSpots(); busy = false; renderActs();
  };
  // ---------- 牛牛 ----------
  function nnCards(box, cards, h) {
    const order = h.split ? [...h.split[0], ...h.split[1]] : [0, 1, 2, 3, 4];
    $(box).innerHTML = order.map((i, k) => card(cards[i], k === 3 && h.split ? "gap" : "")).join("");
  }
  PLAY.niuniu = async () => {
    const bet = total(); if (busy || !bet) return; busy = true; renderActs(); hideRes(); resetRound();
    const r = await call("POST", "/api/games/niuniu/play", { bet });
    if (!r.ok) { busy = false; renderActs(); return fail(r); }
    const d = r.d; last = { ...bets }; snd("deal");
    for (let i = 0; i < 5; i++) { await dealIn("nnB", [null], { gap: 90 }); await dealIn("nnP", [d.player[i]], { gap: 120 }); }
    await sleep(350); nnCards("nnP", d.player, d.ph); $("nnPt").innerHTML = `<b>${d.ph.name}</b> ×${d.ph.mult}`;
    if (d.ph.type >= 10) say(d.ph.type > 10 ? "nn_special" : "nn_niuniu");
    await sleep(700); snd("flip"); nnCards("nnB", d.banker, d.bh); $("nnBt").innerHTML = `<b>${d.bh.name}</b> ×${d.bh.mult}`;
    document.querySelectorAll("#nnB .pc").forEach((x) => x.classList.add("flip"));
    await sleep(450);
    showRes(`<div class="t">${d.win ? "你赢了" : "庄家赢"} · ${d.mult} 倍</div><div class="n">${netTxt(d.net)}</div><div class="s">${d.win ? "已扣 5% 佣金" : ""}</div>`, d.win ? "good" : ""); winFx(d.net, bet);
    setBal(d.balance); round = { phase: "done" }; bets = {}; paintSpots(); busy = false; renderActs();
  };
  // ---------- 21点 ----------
  function bjPaint(v, animate) {
    $("bjD").innerHTML = v.dealer.map((c) => card(c, animate ? "flip" : "")).join(""); $("bjDt").textContent = v.phase === "done" ? v.dealerTotal : v.dealerTotal ? v.dealerTotal + " + ?" : "";
    $("bjH").innerHTML = v.hands.map((h, i) => `<div class="bjh ${i === v.active && v.phase === "play" ? "on" : ""} ${v.result ? v.result.lines[i].res : ""}"><div class="hl">${v.hands.length > 1 ? `第 ${i + 1} 手 · ` : ""}<b class="pt">${h.total}${h.soft && h.total < 21 ? "（软）" : ""}</b> <span class="muted">下注 ${M(h.bet)}${h.doubled ? " · 加倍" : ""}</span>${v.result ? ` <span class="rs">${{ blackjack: "黑杰克", win: "赢", push: "平", lose: "输", bust: "爆牌" }[v.result.lines[i].res]}</span>` : ""}</div><div class="cards">${h.cards.map((c) => card(c)).join("")}</div></div>`).join("");
  }
  async function bjShow(v, prev) {
    round = v; const newCards = (a, b) => (b ? a.length - b.length : a.length);
    if (!prev) { // 新开一局：依次发牌
      $("bjD").innerHTML = ""; $("bjH").innerHTML = `<div class="bjh on"><div class="hl"><b class="pt"></b></div><div class="cards" id="bjP0"></div></div>`;
      await dealIn("bjP0", [v.hands[0].cards[0]]); await dealIn("bjD", [v.dealer[0]]); await dealIn("bjP0", [v.hands[0].cards[1]]); await dealIn("bjD", [v.phase === "done" ? v.dealer[1] : null]);
    } else if (v.phase === "done" && prev.dealer[1] == null) { bjPaint({ ...v, dealer: v.dealer.slice(0, 2), result: null, phase: "play", dealerTotal: "" }); await sleep(200); snd("flip"); }
    bjPaint(v); if (v.phase === "done" && prev) document.querySelectorAll("#bjD .pc").forEach((x, i) => { if (i >= 1) x.classList.add("flip"); });
    if (v.phase === "insurance") say("bj_insurance");
    if (v.phase === "done") {
      const stake = v.hands.reduce((a, h) => a + h.bet, 0) + v.insurance, net = v.result.payout - stake;
      const bj = v.result.lines.some((l) => l.res === "blackjack"); if (bj) say("bj_blackjack"); else if (v.result.lines.every((l) => l.res === "bust")) say("bj_bust");
      await sleep(300); showRes(`<div class="t">${bj ? "黑杰克！" : v.result.dealerBJ ? "庄家黑杰克" : net > 0 ? "你赢了" : net < 0 ? "庄家赢" : "平局"}</div><div class="n">${netTxt(net)}</div>`, net > 0 ? "good" : ""); if (!bj) winFx(net, stake); else snd("bigWin");
      bets = {}; paintSpots();
    }
    renderActs();
  }
  PLAY.blackjack = async () => {
    const bet = total(); if (busy || !bet) return; busy = true; renderActs(); hideRes(); resetRound();
    const r = await call("POST", "/api/games/blackjack/start", { bet });
    if (!r.ok) { busy = false; renderActs(); if (r.d.round) { round = r.d.round; bjPaint(round); renderActs(); } return fail(r); }
    last = { ...bets }; setBal(r.d.balance); snd("deal"); await bjShow(r.d.round, null); busy = false; renderActs();
  };
  async function bjAct(a) {
    if (busy || !round) return; busy = true; renderActs();
    const r = await call("POST", "/api/games/blackjack/action", { action: a }); busy = false;
    if (!r.ok) { renderActs(); return fail(r); }
    if (a === "hit" || a === "double" || a === "split") snd("flip"); if (a === "double") snd("chip");
    const prev = round; await bjShow(r.d.round, prev); if (r.d.balance != null) setBal(r.d.balance);
  }
  // ---------- 炸金花 ----------
  function zjPaint(v, end) {
    $("zjD").innerHTML = (v.dealer || [null, null, null]).map((c) => card(c, end ? "flip" : "")).join("");
    $("zjP").innerHTML = (v.player || [null, null, null]).map((c) => card(c)).join("");
    $("zjPt").innerHTML = v.hand ? `<b>${v.hand}</b>` : v.seen ? "" : `<span class="muted">未看牌</span>`;
    $("zjDt").innerHTML = end ? `<b>${end.de}</b>${end.qualified ? "" : " <span class='muted'>（不足 Q 高，不合格）</span>"}` : "";
  }
  PLAY.zjh = async () => {
    const ante = total(); if (busy || !ante) return; busy = true; renderActs(); hideRes(); resetRound();
    const r = await call("POST", "/api/games/zjh/start", { ante });
    if (!r.ok) { busy = false; if (r.d.round) { round = { ...r.d.round, phase: "decide" }; zjPaint(round); } renderActs(); return fail(r); }
    last = { ...bets }; setBal(r.d.balance); snd("deal");
    $("zjD").innerHTML = $("zjP").innerHTML = "";
    for (let i = 0; i < 3; i++) { await dealIn("zjP", [null], { gap: 120 }); await dealIn("zjD", [null], { gap: 120 }); }
    round = { ...r.d.round, phase: "decide" }; zjPaint(round); busy = false; renderActs();
  };
  async function zjAct(a) {
    if (busy || !round) return; busy = true; renderActs();
    const r = await call("POST", "/api/games/zjh/action", { action: a }); busy = false;
    if (!r.ok) { renderActs(); return fail(r); }
    const v = r.d.round;
    if (a === "look") { say("zj_look"); round = { ...v, phase: "decide" }; zjPaint(round); document.querySelectorAll("#zjP .pc").forEach((x) => x.classList.add("flip")); snd("flip"); if (/豹子/.test(v.hand)) say("zj_baozi"); return renderActs(); }
    say(a === "fold" ? "zj_fold" : "zj_call"); if (a === "call") snd("chip");
    const e = v.result; round = { ...v, phase: "done" }; await sleep(300); zjPaint(v, e); snd("flip");
    const net = e.payout - round.ante - e.play; await sleep(500);
    const msg = { fold: "已弃牌", noqualify: "庄家不合格 · 底注赢", win: "你赢了", lose: "庄家赢", push: "平局" }[e.result];
    showRes(`<div class="t">${msg}</div><div class="n">${netTxt(net)}</div><div class="s">${e.pe} 对 ${e.de}</div>`, net > 0 ? "good" : ""); winFx(net, round.ante + e.play);
    setBal(r.d.balance); bets = {}; paintSpots(); renderActs();
  }

  // ---------- 规则与记录 ----------
  const SAFE = `<div class="safe-note">游戏币仅供娱乐，不可兑换或交易</div>`;
  const RULES = {
    baccarat: `<div>8 副牌，每局重新洗牌。闲、庄各发两张，点数取个位（A=1，10/J/Q/K=0）。任意一方 8 或 9 点为“天牌”，不再补牌；否则按标准补牌规则：闲 0–5 点补一张；庄家根据自己点数和闲家第三张决定是否补牌。</div>
      <table class="ptab"><tr><td>注位</td><td>赔率</td><td>庄家优势</td></tr><tr><td>闲</td><td>1:1</td><td>1.24%</td></tr><tr><td>庄</td><td>1:0.95（抽 5%）</td><td>1.06%</td></tr><tr><td>和</td><td>1:8</td><td>14.36%</td></tr><tr><td>闲对 / 庄对</td><td>1:11</td><td>10.36%</td></tr></table>
      <div class="muted">出现和局时，押庄、押闲的下注全额退回。</div>`,
    blackjack: `<div>6 副牌，每一手都用新洗好的牌靴。目标是点数比庄家大且不超过 21。A 算 1 或 11，J/Q/K 算 10。</div>
      <ul><li>黑杰克（首两张 A + 10 点）赔 3:2</li><li>庄家软 17 停牌；庄家明牌是 A 或 10 点时先偷看是否黑杰克</li><li>任意两张可以加倍（只再拿一张）；分牌后也可以加倍</li><li>同点数可以分牌，最多分到 4 手；A 分牌后每手只补一张，21 点不算黑杰克</li><li>庄家明牌是 A 时可以买保险（下注的一半），庄家黑杰克时保险赔 2:1</li></ul>
      <div class="muted">按基本策略玩，庄家优势约 0.5%。</div>`,
    sicbo: `<div>三颗骰子，按点数结算：</div>
      <table class="ptab"><tr><td>注位</td><td>赔率</td></tr><tr><td>大（11–17）/ 小（4–10）</td><td>1:1，围骰通杀</td></tr><tr><td>单 / 双</td><td>1:1，围骰通杀</td></tr>
      <tr><td>点数 4 或 17</td><td>1:60</td></tr><tr><td>5 或 16</td><td>1:30</td></tr><tr><td>6 或 15</td><td>1:17</td></tr><tr><td>7 或 14</td><td>1:12</td></tr><tr><td>8 或 13</td><td>1:8</td></tr><tr><td>9–12</td><td>1:6</td></tr>
      <tr><td>全围（任意三同）</td><td>1:30</td></tr><tr><td>指定围骰</td><td>1:180</td></tr><tr><td>单骰（出现 1/2/3 次）</td><td>1:1 / 1:2 / 1:3</td></tr></table>
      <div class="muted">大小单双庄家优势 2.78%；单骰 7.87%；全围 13.89%；指定围骰 16.20%；点数 9.72%–18.98%。</div>`,
    niuniu: `<div>你和庄家各发 5 张（一副 52 张）。从 5 张里找 3 张凑成 10 的倍数（A=1，10/J/Q/K=10），剩下 2 张点数的个位就是“牛几”，个位为 0 是“牛牛”；找不到就是“无牛”。系统自动帮你选最好的组合，并显示 3+2 分组。</div>
      <table class="ptab"><tr><td>牌型</td><td>倍数</td></tr><tr><td>无牛 · 牛一 ~ 牛六</td><td>×1</td></tr><tr><td>牛七 ~ 牛九</td><td>×2</td></tr><tr><td>牛牛</td><td>×3</td></tr><tr><td>五花牛（5 张都是 J/Q/K）</td><td>×4</td></tr><tr><td>炸弹（4 张同点）</td><td>×4</td></tr><tr><td>五小牛（5 张都小于 5，总和 ≤ 10）</td><td>×5</td></tr></table>
      <div>大小：五小牛 > 炸弹 > 五花牛 > 牛牛 > 牛九 … > 无牛；同牌型比最大的一张（K 最大、A 最小，同点比花色 ♠>♥>♣>♦）。按赢家的牌型倍数结算；你赢时抽 5% 佣金。因为最多按 5 倍结算，余额需要不少于下注的 5 倍。</div>
      <div class="muted">庄家优势约 4.0%。</div>`,
    zjh: `<div>你和庄家各发 3 张。牌型从大到小：<b>豹子</b>（三张同点）> <b>同花顺</b> > <b>同花</b> > <b>顺子</b> > <b>对子</b> > <b>单张</b>。A 最大，A23 是最小的顺子。</div>
      <ul><li>先下底注，发牌后可以“看牌”，也可以不看</li><li>看牌后跟注 = 底注 × 2；不看直接“闷跟” = 底注 × 1；或者弃牌（输掉底注）</li><li>庄家至少要 Q 高（或对子以上）才“合格”。庄家不合格：底注 1:1，跟注退回</li><li>庄家合格：你大 → 底注 1:1、跟注 1:1（闷跟的跟注赔 1.4 倍）；庄家大 → 全输；一样大 → 全退</li></ul>
      <div class="muted">看牌后“K 高以上就跟”是最佳打法，庄家优势约 3.2%（按底注）；全程闷跟约 3.4%。</div>`,
  };
  function modal(t, html) { $("tgModalT").textContent = t; $("tgModalB").innerHTML = html; $("tgModal").classList.remove("hidden"); }
  async function showHistory() {
    const r = await call("GET", `/api/games/${game}/history`); if (!r.ok) return toast("读取记录失败");
    const t = r.d.totals, D = (h) => { const x = h.detail || {}; return game === "baccarat" ? `${{ player: "闲", banker: "庄", tie: "和" }[x.w] || ""} ${x.p ?? ""}:${x.b ?? ""}` : game === "sicbo" ? (x.dice || []).join("-") : game === "niuniu" ? `${x.ph || ""} 对 ${x.bh || ""}` : game === "zjh" ? `${x.pe || ""} 对 ${x.de || ""}` : (x.r || []).map((k) => ({ blackjack: "黑杰克", win: "赢", push: "平", lose: "输", bust: "爆" }[k])).join("/"); };
    modal(`${GAMES[game].title} · 我的记录`, `<div class="muted">累计 ${t.spins} 局 · 下注 ${M(t.bets)} · 返还 ${M(t.wins)}</div>` + (r.d.history.map((h) => `<div class="hrow"><span class="muted">${new Date(h.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><span>${esc(D(h))}</span><span>下注 ${M(h.bet)}</span><span>${netTxt(h.win - h.bet)}</span></div>`).join("") || `<div class="muted">还没有记录</div>`));
  }

  // ---------- 进入 / 离开 ----------
  async function open(g) {
    if (!GAMES[g]) return;
    if (!cfg) { try { cfg = await (await fetch("/api/games/config")).json(); } catch (e) {} }
    game = g; bets = {}; last = JSON.parse(localStorage.getItem("tg_last_" + g) || "{}"); round = null; busy = false;
    $("tg").dataset.g = g; $("tgTitle").textContent = GAMES[g].title; $("tgTag").textContent = GAMES[g].tag;
    $("tgWho").textContent = me ? `ID ${me.publicId} · ${me.username}` : "";
    $("tgTable").innerHTML = TABLE[g]() + `<div class="tgres hidden" id="tgRes"></div>`;
    $("tgChips").innerHTML = chipsHtml();
    $("tgChips").querySelectorAll(".chip").forEach((b) => b.onclick = () => { chip = +b.dataset.c; localStorage.setItem("tg_chip", chip); $("tgChips").querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b)); snd("tap"); });
    $("tgTable").querySelectorAll(".spot").forEach((el) => el.onclick = () => addBet(el.dataset.s));
    if (g === "baccarat") paintRoad();
    if (g === "sicbo") [0, 1, 2].forEach((i) => setDie(i, [1, 3, 5][i]));
    paintSpots(); balRender(); renderActs(); show("tg");
    location.hash !== "#t-" + g && history.replaceState(null, "", location.pathname + "#t-" + g);
    // 断线 / 刷新后继续未完成的牌局
    if (g === "blackjack") { const r = await call("GET", "/api/games/blackjack/state"); if (r.ok && r.d.round) { round = r.d.round; bets = { bet: round.bet }; paintSpots(); bjPaint(round); renderActs(); toast("继续上一手"); } else say("tg_bet"); }
    else if (g === "zjh") { const r = await call("GET", "/api/games/zjh/state"); if (r.ok && r.d.round) { round = { ...r.d.round, phase: "decide" }; bets = { bet: round.ante }; paintSpots(); zjPaint(round); renderActs(); toast("继续上一局"); } else say("tg_bet"); }
    else say("tg_bet");
  }
  window.tgOpen = open;
  window.tgOnMe = () => { if (!$("tg").classList.contains("hidden")) balRender(); };
  window.tgBusy = () => busy;
  $("tgBack").onclick = () => { if (busy) return toast("本局结算中，马上就好"); if (game) localStorage.setItem("tg_last_" + game, JSON.stringify(last)); show("hall"); };
  $("tgRules").onclick = () => modal(`${GAMES[game].title} · 规则`, RULES[game] + SAFE);
  $("tgHist").onclick = showHistory;
  $("tgModalX").onclick = () => $("tgModal").classList.add("hidden");
  $("tgModal").onclick = (e) => { if (e.target.id === "tgModal") $("tgModal").classList.add("hidden"); };
  $("tgSupport").onclick = () => contactSupport();
})();
