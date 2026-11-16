// 时烽麻将消消乐：前端只负责播放动画，每一局的结果都由服务器计算
(() => {
  const BETS_DEFAULT = [10, 20, 50, 100, 200, 500, 1000, 2000];
  let cfg = null, betIdx = 3, busy = false, fast = localStorage.getItem("mj_fast") === "1", hurry = false, shownBal = null, grid = null;
  const NAMES = { fa: "發", zhong: "中", bai: "白", wan: "八萬", tong5: "五筒", tiao5: "五條", tong2: "二筒", tiao2: "二條", wild: "百搭", hu: "胡" };
  const fmt = (n) => Number(n || 0).toLocaleString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, hurry ? Math.min(ms, 60) : fast ? ms * 0.45 : ms));

  // ---- 牌面（CSS + SVG 原创绘制）----
  const dot = (cx, cy, r, c) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="3.2"/><circle cx="${cx}" cy="${cy}" r="${r * 0.42}" fill="${c}"/>`;
  const stick = (x, y, c) => `<g><rect x="${x - 3.2}" y="${y}" width="6.4" height="26" rx="3" fill="${c}"/><rect x="${x - 4.2}" y="${y + 11}" width="8.4" height="3.2" rx="1.5" fill="#fff8"/></g>`;
  const FACE = {
    fa: `<span class="big fa">發</span>`,
    zhong: `<span class="big zh">中</span>`,
    bai: `<span class="bai"></span>`,
    wan: `<span class="wan"><b>八</b><i>萬</i></span>`,
    tong5: `<svg viewBox="0 0 60 80">${dot(16, 18, 10, "#1f5fbf")}${dot(44, 18, 10, "#178a3e")}${dot(30, 40, 10, "#c8182c")}${dot(16, 62, 10, "#178a3e")}${dot(44, 62, 10, "#1f5fbf")}</svg>`,
    tong2: `<svg viewBox="0 0 60 80">${dot(30, 22, 13, "#178a3e")}${dot(30, 58, 13, "#1f5fbf")}</svg>`,
    tiao5: `<svg viewBox="0 0 60 80">${stick(15, 8, "#178a3e")}${stick(45, 8, "#178a3e")}${stick(30, 27, "#c8182c")}${stick(15, 46, "#178a3e")}${stick(45, 46, "#178a3e")}</svg>`,
    tiao2: `<svg viewBox="0 0 60 80">${stick(30, 8, "#178a3e")}${stick(30, 44, "#1f5fbf")}</svg>`,
    wild: `<span class="wd"><span>百</span><span>搭</span></span>`,
    hu: `<span class="big">胡</span>`,
  };
  const tileHtml = (s, cls = "") => `<div class="tile ${s === "wild" ? "wild" : s === "hu" ? "hu" : ""} ${cls}" title="${NAMES[s] || ""}">${FACE[s] || ""}</div>`;

  // ---- 界面 ----
  const bets = () => (cfg && cfg.bets) || BETS_DEFAULT;
  const bet = () => bets()[betIdx];
  function setBal(v) { shownBal = v; $("mjBal").textContent = fmt(v); }
  function setMults(mults, k, free) {
    const el = $("mjMults"); el.classList.toggle("free", !!free);
    el.innerHTML = mults.map((m, i) => `<span class="${i === Math.min(k, mults.length - 1) ? "on" : ""}">x${m}</span>`).join("");
  }
  function drawGrid(g, opts = {}) {
    grid = g;
    const fresh = opts.fresh || []; // 每轴顶部新落下的牌数
    const winSet = new Set((opts.win || []).map(([r, row]) => r * 10 + row));
    $("mjGrid").classList.toggle("showing", !!(opts.win && opts.win.length && !opts.pop));
    $("mjGrid").innerHTML = g.map((col, r) => `<div class="reel">${col.map((s, row) => {
      let cls = winSet.has(r * 10 + row) ? (opts.pop ? "pop" : "win") : "";
      if (opts.all || row < (fresh[r] || 0)) cls += " drop";
      return tileHtml(s, cls).replace('class="tile', `style="animation-delay:${opts.all ? r * 60 + row * 25 : row * 40}ms" class="tile`);
    }).join("")}</div>`).join("");
  }
  function setWin(v, label = "赢得", big = false) {
    const w = $("mjWin"); w.classList.toggle("big", big);
    w.innerHTML = v > 0 ? `<span class="lbl">${label}</span> <b>${fmt(v)}</b>` : `<span class="lbl">${label}</span>`;
  }
  function updateBet() {
    $("mjBet").textContent = fmt(bet());
    $("mjMinus").disabled = busy || betIdx === 0; $("mjPlus").disabled = busy || betIdx === bets().length - 1;
  }
  function updateNoChips() { $("mjNoChips").classList.toggle("hidden", !(me && me.balance < bet()) || busy); }
  function setBusy(b) { busy = b; hurry = false; $("mjSpin").classList.toggle("busy", b); if (!auto) $("mjSpin").querySelector("span").textContent = b ? "✦" : "开始"; updateBet(); updateNoChips(); }
  const randomFace = () => { const k = ["fa", "zhong", "bai", "wan", "tong5", "tiao5", "tong2", "tiao2"]; return Array.from({ length: 5 }, (_, r) => Array.from({ length: 4 }, (_, i) => (r === 2 && i === 1 ? "wild" : k[(r * 3 + i * 5) % k.length]))); };

  async function loadCfg() {
    if (cfg) return;
    try { cfg = await (await fetch("/api/mahjong/config")).json(); } catch (e) { cfg = null; }
    const saved = +localStorage.getItem("mj_bet"); const i = bets().indexOf(saved); if (i >= 0) betIdx = i;
  }
  window.mjEnter = async () => {
    await loadCfg();
    if (!busy) { if (me) setBal(me.balance); if (!grid) { drawGrid(randomFace(), { all: true }); setMults(cfg ? cfg.baseMults : [1, 2, 3, 5], 0); setWin(0, "祝你连消大胜"); } }
    updateBet(); updateNoChips();
  };
  window.mjOnMe = (u) => { if (!busy && !$("mj").classList.contains("hidden")) { setBal(u.balance); updateNoChips(); } };

  // 播放一次转动（含连消）；返回这一轮赢的筹码
  async function playSteps(steps, mults, free, betAmt, carry) {
    let won = 0;
    for (let k = 0; k < steps.length; k++) {
      const st = steps[k];
      setMults(mults, k, free);
      if (k === 0) { drawGrid(st.grid, { all: true }); reelSounds(); await sleep(520); }
      if (!st.wins.length) break;
      const cells = st.wins.flatMap((w) => w.cells);
      drawGrid(st.grid, { win: cells }); snd("cascade", st.mult);
      const v = Math.round((betAmt * st.units) / 100); won += v;
      setWin(carry + won, st.mult > 1 ? `连消 x${st.mult}` : "赢得", st.mult >= 5);
      await sleep(820);
      drawGrid(st.grid, { win: cells, pop: true }); snd("pop");
      await sleep(300);
      // 计算每轴补了几张（用于下落动画）
      const next = steps[k + 1].grid; const fresh = st.grid.map((col, r) => cells.filter(([rr]) => rr === r).length);
      drawGrid(next, { fresh });
      await sleep(380);
    }
    return won;
  }
  const snd = (k, a) => { try { window.SFX && SFX[k](a); } catch (e) {} };
  const reelSounds = () => { const d = hurry ? 15 : fast ? 40 : 90; for (let r = 0; r < 5; r++) setTimeout(() => snd("reelStop", r), 180 + r * d); };
  function splash(html, ms) {
    return new Promise((res) => {
      const el = $("mjSplash"); el.innerHTML = `<div class="in">${html}</div>`; el.classList.remove("hidden");
      const done = () => { el.classList.add("hidden"); el.onclick = null; res(); };
      el.onclick = done; setTimeout(done, hurry ? 400 : ms);
    });
  }

  // 播放一局（一次请求 /api/mahjong/spin）；返回 { ok, win, balance, error }
  async function spinOnce() {
    const b = bet();
    if (!me || me.balance < b) { updateNoChips(); toast("余额不足，请联系客服获取游戏币"); return { ok: false, error: "NO_CHIPS" }; }
    setBusy(true); localStorage.setItem("mj_bet", b); snd("spin");
    const before = me.balance; setBal(before - b); setWin(0, "转动中…");
    let r;
    try {
      const resp = await fetch("/api/mahjong/spin", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + authToken }, body: JSON.stringify({ bet: b }) });
      r = await resp.json().catch(() => ({}));
      if (!resp.ok) { setBal(before); setBusy(false); setWin(0, ""); if (r.code === "NO_CHIPS") { me.balance = Math.min(me.balance, b - 1); updateNoChips(); } toast(r.error || "出错了，请重试"); return { ok: false, error: r.code || "HTTP_" + resp.status }; }
    } catch (e) { setBal(before); setBusy(false); toast("网络不稳定，请重试"); return { ok: false, error: "NETWORK" }; }
    try {
      const baseMults = cfg ? cfg.baseMults : [1, 2, 3, 5], freeMults = cfg ? cfg.freeMults : [2, 4, 6, 10];
      let total = await playSteps(r.base.steps, baseMults, false, b, 0);
      setBal(before - b + total);
      if (r.freeAwarded) {
        await sleep(400); snd("freeSpins");
        await splash(`<div class="t">🀄 集齐 ${r.base.scatters} 个「胡」</div><div class="muted" style="margin:8px 0">恭喜获得免费游戏</div><div class="n">${r.freeAwarded} 次</div><div class="muted">连消倍数 x2 → x4 → x6 → x10</div>`, 2200);
        let totalFree = r.freeAwarded - r.free.reduce((a, f) => a + f.extra, 0);
        $("mjFree").classList.remove("hidden");
        for (let i = 0; i < r.free.length; i++) {
          const f = r.free[i];
          $("mjFreeN").textContent = i + 1; $("mjFreeT").textContent = totalFree;
          total += await playSteps(f.steps, freeMults, true, b, total);
          setBal(before - b + total);
          if (f.extra) { totalFree += f.extra; $("mjFreeT").textContent = totalFree; await splash(`<div class="t">再次触发！</div><div class="n">+${f.extra} 次</div>`, 1500); }
          await sleep(250);
        }
        $("mjFree").classList.add("hidden");
        await splash(`<div class="t">免费游戏结束</div><div class="muted" style="margin:8px 0">共赢得</div><div class="n">${fmt(r.win)}</div>`, 2200);
      }
      setMults(baseMults, 0, false);
      const x = r.win / b;
      setWin(r.win, r.win ? (x >= 20 ? "🎉 超级大赢" : x >= 8 ? "大赢" : "本局赢得") : (auto ? "未中奖" : "未中奖，再来一次"), x >= 8);
      if (x >= 8) snd("bigWin"); else if (r.win > 0) snd("mjWin");
    } finally {
      me.balance = r.balance; setBal(r.balance); $("uBal").textContent = $("uBal2").textContent = fmt(r.balance);
      setBusy(false);
    }
    return { ok: true, win: r.win, balance: r.balance };
  }

  // ---- 自动转：每局依次调用一次服务器 /spin，不做批量 ----
  let auto = null;
  function renderAuto() {
    const sp = $("mjSpin"), ab = $("mjAutoBtn");
    sp.classList.toggle("auto", !!auto); ab.classList.toggle("on", !!auto);
    if (auto) { sp.querySelector("span").innerHTML = `停止<small>${MJAuto.label(auto)}</small>`; ab.textContent = `🔁 剩 ${MJAuto.label(auto)}`; }
    else { if (!busy) sp.querySelector("span").textContent = "开始"; ab.textContent = "🔁 自动"; }
  }
  function stopAuto(reason) { if (!auto) return; auto = null; renderAuto(); if (reason) toast(reason); }
  async function runAuto(a) {
    const why = MJAuto.canStart({ balance: me ? me.balance : 0, bet: bet() }); if (why) { updateNoChips(); return toast(why); }
    auto = a; renderAuto();
    while (auto === a) {
      MJAuto.consume(a); renderAuto();
      const r = await spinOnce();
      if (auto !== a) break;
      const reason = MJAuto.afterSpin(a, { balance: me ? me.balance : 0, bet: bet(), win: r.win || 0, error: !r.ok, hidden: document.hidden, left: $("mj").classList.contains("hidden") });
      if (reason) { stopAuto(r.ok ? reason : null); break; }
      renderAuto(); await sleep(fast ? 200 : 450);
      if (auto === a && ($("mj").classList.contains("hidden") || document.hidden)) { stopAuto("已离开游戏，自动已停止"); break; }
    }
    renderAuto();
  }
  function openAutoSheet() {
    if (auto) return stopAuto("自动已停止");
    if (busy) return;
    const last = JSON.parse(localStorage.getItem("mj_auto") || "{}");
    modal("自动转", `<div class="muted">每一局都单独向服务器结算，触发的免费游戏会自动玩完。点“停止”或离开页面随时结束。</div>
      <label>次数</label><div class="autogrid">${MJAuto.COUNTS.map((c) => `<button class="${(last.count ?? 10) === (c === Infinity ? -1 : c) ? "on" : ""}" data-c="${c === Infinity ? -1 : c}">${c === Infinity ? "无限" : c}</button>`).join("")}</div>
      <label>单次赢超过（可选，0 = 不限）</label><input id="mjAWin" type="number" inputmode="numeric" min="0" value="${last.winOver || ""}" placeholder="例如 5000">
      <label>余额低于（可选，0 = 不限）</label><input id="mjABal" type="number" inputmode="numeric" min="0" value="${last.balUnder || ""}" placeholder="例如 1000">
      <div class="muted" style="margin-top:6px">当前下注 ${fmt(bet())} · 余额不足、出错或离开页面时会自动停止</div>
      <button class="pri" id="mjAGo" style="width:100%;margin-top:12px">开始自动转</button>`);
    let pick = last.count ?? 10;
    document.querySelectorAll(".autogrid button").forEach((b) => b.onclick = () => { pick = +b.dataset.c; document.querySelectorAll(".autogrid button").forEach((x) => x.classList.toggle("on", x === b)); });
    $("mjAGo").onclick = () => {
      const opt = { winOver: +$("mjAWin").value || 0, balUnder: +$("mjABal").value || 0 };
      localStorage.setItem("mj_auto", JSON.stringify({ count: pick, ...opt }));
      $("mjModal").classList.add("hidden");
      runAuto(MJAuto.create(pick === -1 ? Infinity : pick, opt));
    };
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopAuto(null); });
  window.addEventListener("pagehide", () => stopAuto(null));
  window.mjStopAuto = stopAuto;
  window.mjAuto = () => auto;

  // ---- 玩法与记录 ----
  function modal(title, html) { $("mjModalT").textContent = title; $("mjModalB").innerHTML = html; $("mjModal").classList.remove("hidden"); }
  $("mjModalX").onclick = () => $("mjModal").classList.add("hidden");
  $("mjModal").onclick = (e) => { if (e.target.id === "mjModal") $("mjModal").classList.add("hidden"); };
  $("mjRulesBtn").onclick = async () => {
    await loadCfg(); const pt = (cfg && cfg.paytable) || {};
    const rows = Object.keys(pt).map((s) => `<tr><td>${tileHtml(s)}</td><td>${NAMES[s]}</td><td>${pt[s][3]}%</td><td>${pt[s][4]}%</td><td>${pt[s][5]}%</td></tr>`).join("");
    modal("玩法说明", `<div>5 轴 × 4 行，共 <b>1024 路</b>。同一种牌从最左边第 1 轴开始，连续出现在 3 轴或以上即中奖（不用在同一行）。每路赢得 = 下注 × 下表百分比，同一轴有几张就乘几路。</div>
      <table class="ptab"><tr><td></td><td>牌</td><td>3 轴</td><td>4 轴</td><td>5 轴</td></tr>${rows}</table>
      <div class="row" style="flex-wrap:nowrap;gap:10px;margin:6px 0"><div style="flex:none;width:40px">${tileHtml("wild")}</div><div><b>百搭</b>：只出现在第 2–4 轴，可以代替除「胡」以外的任何牌。</div></div>
      <div class="row" style="flex-wrap:nowrap;gap:10px;margin:6px 0"><div style="flex:none;width:40px">${tileHtml("hu")}</div><div><b>胡</b>：任意位置出现 3 个触发 <b>10 次免费游戏</b>，每多 1 个再加 2 次；免费游戏里还可以再次触发。</div></div>
      <div><b>连消</b>：中奖的牌会消除，上面的牌落下、顶部补新牌，可以接着中奖。每次连消倍数提升：普通 x1 → x2 → x3 → x5，免费游戏 x2 → x4 → x6 → x10。</div>
      <div class="muted" style="margin-top:8px">单局最高赢得下注的 ${fmt(cfg ? cfg.maxWinX : 5000)} 倍。所有结果由服务器随机生成。只用游戏币娱乐，不涉及真钱，游戏币不能购买或兑现。</div>`);
  };
  $("mjHistBtn").onclick = async () => {
    try {
      const r = await fetch("/api/mahjong/history", { headers: { authorization: "Bearer " + authToken } }); const d = await r.json();
      const t = d.totals;
      const list = d.history.map((h) => `<div class="hrow"><span class="muted">${new Date(h.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><span>下注 ${fmt(h.bet)}</span><span class="${h.win > 0 ? "" : "muted"}" style="color:${h.win > 0 ? "#f5d77a" : ""}">${h.win > 0 ? "赢 " + fmt(h.win) : "未中"}${h.freeSpins ? " · 免费" + h.freeSpins + "次" : ""}</span></div>`).join("") || `<div class="muted">还没有记录</div>`;
      modal("我的记录", `<div class="muted">累计 ${fmt(t.spins)} 局 · 下注 ${fmt(t.bets)} · 赢得 ${fmt(t.wins)}</div>${list}`);
    } catch (e) { toast("读取记录失败"); }
  };

  $("mjSpin").onclick = () => { if (auto) return stopAuto("自动已停止"); if (busy) { hurry = true; return; } spinOnce(); };
  $("mjAutoBtn").onclick = openAutoSheet;
  $("mjMinus").onclick = () => { if (!busy && betIdx > 0) { betIdx--; updateBet(); updateNoChips(); } };
  $("mjPlus").onclick = () => { if (!busy && betIdx < bets().length - 1) { betIdx++; updateBet(); updateNoChips(); } };
  const fastLbl = () => ($("mjFast").textContent = `⚡ 极速：${fast ? "开" : "关"}`);
  $("mjFast").onclick = () => { fast = !fast; localStorage.setItem("mj_fast", fast ? "1" : "0"); fastLbl(); }; fastLbl();
  $("mjSupport").onclick = () => contactSupport();
  $("btnHall2").onclick = () => { stopAuto(null); if (busy) { hurry = true; return toast("本局结算中，马上就好"); } show("hall"); };
})();
