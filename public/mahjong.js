// 时烽麻将消消乐：前端只负责播放动画，每一局的结果都由服务器计算
(() => {
  const BETS_DEFAULT = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];
  let cfg = null, betIdx = 4, busy = false, fast = localStorage.getItem("mj_fast") === "1", hurry = false, shownBal = null, grid = null;
  const NAMES = { fa: "發", zhong: "中", bai: "白", wan: "八萬", tong5: "五筒", tiao5: "五條", tong2: "二筒", tiao2: "二條", wild: "百搭", hu: "胡" };
  const fmt = (c) => M(c); // 金额：分 → 1,000.00
  const num = (n) => Number(n || 0).toLocaleString();
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
  const tileHtml = (s, cls = "") => `<div class="tile ${s === "wild" ? "wild" : s === "hu" ? "hu" : ""} ${cls}" title="${NAMES[s] || ""}"><div class="face">${FACE[s] || ""}</div></div>`;

  // ---- 界面 ----
  const bets = () => (cfg && cfg.bets) || BETS_DEFAULT;
  const bet = () => bets()[betIdx];
  function setBal(v) { shownBal = v; $("mjBal").textContent = fmt(v); }
  function setMults(mults, k, free) {
    const el = $("mjMults"); el.classList.toggle("free", !!free);
    el.innerHTML = mults.map((m, i) => `<span class="${i === Math.min(k, mults.length - 1) ? "on" : ""}">x${m}</span>`).join("");
  }
  // ---- 牌盘：20 个牌节点常驻，只在牌面变化时改内容；动画全部用 WAAPI 的 transform/opacity ----
  const RMQ = matchMedia("(prefers-reduced-motion: reduce)");
  let nodes = null, pitch = 0, fxCount = 0;
  function build() {
    const el = $("mjGrid"); el.innerHTML = "";
    nodes = Array.from({ length: 5 }, () => { const reel = document.createElement("div"); reel.className = "reel"; el.appendChild(reel);
      return Array.from({ length: 4 }, () => { const t = document.createElement("div"); t.className = "tile"; t._s = null; reel.appendChild(t); return t; }); });
  }
  function setFace(t, s) { if (t._s === s) return; t._s = s; t.innerHTML = `<div class="face">${FACE[s] || ""}</div>`; t.title = NAMES[s] || ""; t.classList.toggle("wild", s === "wild"); t.classList.toggle("hu", s === "hu"); }
  const getPitch = () => { if (!pitch && nodes) { const a = nodes[0][0], b = nodes[0][1]; pitch = b.offsetTop - a.offsetTop || a.offsetHeight + 6; } return pitch; };
  window.mjRelayout = () => { pitch = 0; };
  addEventListener("resize", () => { pitch = 0; }, { passive: true });
  const stopAnims = (t) => { if (t.getAnimations) t.getAnimations().forEach((a) => a.cancel()); };
  const bounce = (from) => [{ transform: `translate3d(0,${from}px,0)` }, { transform: "translate3d(0,0,0)", offset: 0.7 }, { transform: `translate3d(0,${-Math.min(10, Math.abs(from) * 0.06)}px,0)`, offset: 0.85 }, { transform: "translate3d(0,0,0)" }];
  function burst(t) { // 消除时的金色粒子
    if (RMQ.matches || fxCount > 120) return;
    const fx = $("mjFx"), b = fx.getBoundingClientRect(), r = t.getBoundingClientRect();
    const cx = r.left - b.left + r.width / 2, cy = r.top - b.top + r.height / 2;
    for (let i = 0; i < 7; i++) {
      const p = document.createElement("i"); p.className = "pt" + (i % 3 === 0 ? " j" : ""); p.style.left = cx + "px"; p.style.top = cy + "px"; fx.appendChild(p); fxCount++;
      const a = Math.random() * Math.PI * 2, d = 34 + Math.random() * 56;
      const an = p.animate([{ transform: "translate(-50%,-50%) scale(1)", opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d + 18}px)) scale(.2)`, opacity: 0 }], { duration: 520 + Math.random() * 260, easing: "cubic-bezier(.15,.7,.4,1)" });
      an.onfinish = () => { p.remove(); fxCount--; };
    }
  }
  function drawGrid(g, opts = {}) {
    if (!nodes) build();
    const prev = grid; grid = g;
    const anim = !RMQ.matches && !!document.body.animate, P = anim ? getPitch() : 0, speed = hurry ? 0.35 : fast ? 0.6 : 1;
    const winSet = new Set((opts.win || []).map(([r, row]) => r * 10 + row));
    $("mjGrid").classList.toggle("showing", !!(opts.win && opts.win.length && !opts.pop));
    g.forEach((col, r) => {
      // 连消：算出每张留下的牌往下掉了几格
      let shifts = null;
      if (opts.fresh && opts.removed) {
        const gone = new Set(opts.removed.filter(([rr]) => rr === r).map(([, row]) => row)), f = opts.fresh[r] || 0;
        shifts = []; let k = 0; for (let row = 0; row < 4; row++) if (!gone.has(row)) { shifts[f + k] = f + k - row; k++; }
      }
      col.forEach((s, row) => {
        const t = nodes[r][row], key = r * 10 + row;
        if (!opts.pop) { stopAnims(t); t.classList.remove("pop"); }
        setFace(t, s);
        t.classList.toggle("win", winSet.has(key) && !opts.pop);
        if (opts.pop && winSet.has(key)) {
          t.classList.add("pop");
          if (anim) t.animate([{ transform: "translateZ(0) scale(1.12)", opacity: 1 }, { transform: "translateZ(40px) scale(1.32)", opacity: 1, offset: 0.35 }, { transform: "translateZ(0) scale(.15) rotate(12deg)", opacity: 0 }], { duration: 300 * speed + 40, easing: "ease-in", fill: "forwards" });
          burst(t);
        }
        if (!anim || opts.pop) return;
        if (opts.all) t.animate(bounce(-(row + 1.4) * P - r * 6), { duration: 460 * speed, delay: (r * 60 + (3 - row) * 22) * speed, easing: "cubic-bezier(.3,.6,.4,1)", fill: "backwards" });
        else if (shifts) {
          const f = opts.fresh[r] || 0;
          if (row < f) t.animate(bounce(-(f + 0.4) * P), { duration: 420 * speed, delay: (f - 1 - row) * 40 * speed, easing: "cubic-bezier(.3,.6,.4,1)", fill: "backwards" });
          else if (shifts[row] > 0) t.animate(bounce(-shifts[row] * P), { duration: 360 * speed, easing: "cubic-bezier(.3,.6,.4,1)" });
        }
      });
    });
    void prev;
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
      const cells = [...new Map(st.wins.flatMap((w) => w.cells).map((c) => [c[0] * 10 + c[1], c])).values()]; // 去重：同一张牌可能属于多条路
      drawGrid(st.grid, { win: cells }); snd("cascade", st.mult);
      snd("voice", k === 0 ? "mj_hu" : ({ 2: "mj_c2", 3: "mj_c3", 4: "mj_c4", 5: "mj_c5", 6: "mj_c6", 10: "mj_c10" })[st.mult] || "mj_combo");
      const v = Math.round((betAmt * st.units) / 100); won += v;
      setWin(carry + won, st.mult > 1 ? `连消 x${st.mult}` : "赢得", st.mult >= 5);
      await sleep(820);
      drawGrid(st.grid, { win: cells, pop: true }); snd("pop");
      await sleep(300);
      // 计算每轴补了几张（用于下落动画）
      const next = steps[k + 1].grid; const fresh = st.grid.map((col, r) => cells.filter(([rr]) => rr === r).length);
      drawGrid(next, { fresh, removed: cells });
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
    if (!me || me.balance < b) { updateNoChips(); snd("voice", "mj_nochips"); toast("余额不足，请联系客服获取游戏币"); return { ok: false, error: "NO_CHIPS" }; }
    setBusy(true); localStorage.setItem("mj_bet", b); snd("spin"); if (!auto || auto.done <= 1) snd("voice", "mj_start");
    const before = me.balance; setBal(before - b); setWin(0, "转动中…");
    let r;
    try {
      const resp = await fetch("/api/mahjong/spin", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + authToken }, body: JSON.stringify({ bet: b }) });
      r = await resp.json().catch(() => ({}));
      if (!resp.ok) { setBal(before); setBusy(false); setWin(0, ""); if (r.code === "NO_CHIPS") { me.balance = Math.min(me.balance, b - 1); updateNoChips(); snd("voice", "mj_nochips"); } toast(r.error || "出错了，请重试"); return { ok: false, error: r.code || "HTTP_" + resp.status }; }
    } catch (e) { setBal(before); setBusy(false); toast("网络不稳定，请重试"); return { ok: false, error: "NETWORK" }; }
    try {
      const baseMults = cfg ? cfg.baseMults : [1, 2, 3, 5], freeMults = cfg ? cfg.freeMults : [2, 4, 6, 10];
      let total = await playSteps(r.base.steps, baseMults, false, b, 0);
      setBal(before - b + total);
      if (r.freeAwarded) {
        await sleep(400); snd("freeSpins"); snd("voice", "mj_free");
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
      if (x >= 8) { snd("bigWin"); snd("voice", x >= 20 ? "mj_super" : "mj_big"); } else if (r.win > 0) snd("mjWin");
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
      <label>单次赢超过（可选，0 = 不限）</label><input id="mjAWin" value="${last.winOver ? (last.winOver / 100).toFixed(2) : ""}" inputmode="decimal" placeholder="例如 500.00">
      <label>余额低于（可选，0 = 不限）</label><input id="mjABal" value="${last.balUnder ? (last.balUnder / 100).toFixed(2) : ""}" inputmode="decimal" placeholder="例如 100.00">
      <div class="muted" style="margin-top:6px">当前下注 ${fmt(bet())} · 余额不足、出错或离开页面时会自动停止</div>
      <button class="pri" id="mjAGo" style="width:100%;margin-top:12px">开始自动转</button>`);
    let pick = last.count ?? 10;
    document.querySelectorAll(".autogrid button").forEach((b) => b.onclick = () => { pick = +b.dataset.c; document.querySelectorAll(".autogrid button").forEach((x) => x.classList.toggle("on", x === b)); });
    $("mjAGo").onclick = () => {
      const opt = { winOver: toCents($("mjAWin").value), balUnder: toCents($("mjABal").value) };
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
      <div class="muted" style="margin-top:8px">单局最高赢得下注的 ${num(cfg ? cfg.maxWinX : 5000)} 倍。所有结果由服务器随机生成。</div><div class="safe-note">游戏币仅供娱乐，不可兑换或交易</div>`);
  };
  $("mjHistBtn").onclick = async () => {
    try {
      const r = await fetch("/api/mahjong/history", { headers: { authorization: "Bearer " + authToken } }); const d = await r.json();
      const t = d.totals;
      const list = d.history.map((h) => `<div class="hrow"><span class="muted">${new Date(h.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><span>下注 ${fmt(h.bet)}</span><span class="${h.win > 0 ? "" : "muted"}" style="color:${h.win > 0 ? "#f5d77a" : ""}">${h.win > 0 ? "赢 " + fmt(h.win) : "未中"}${h.freeSpins ? " · 免费" + h.freeSpins + "次" : ""}</span></div>`).join("") || `<div class="muted">还没有记录</div>`;
      modal("我的记录", `<div class="muted">累计 ${num(t.spins)} 局 · 下注 ${fmt(t.bets)} · 赢得 ${fmt(t.wins)}</div>${list}`);
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
