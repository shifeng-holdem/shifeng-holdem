// 时烽音效与背景音乐：全部用 Web Audio API 现场合成（原创五声音阶旋律，没有任何外部音频文件）
// iOS 安全：第一次点击屏幕后才创建/恢复音频；开关记在 localStorage。
(() => {
  const LS = { music: "sf_music", sfx: "sf_sfx", voice: "sf_voice" };
  const st = { music: localStorage.getItem(LS.music) !== "0", sfx: localStorage.getItem(LS.sfx) !== "0", voice: localStorage.getItem(LS.voice) !== "0", area: null, unlocked: false };
  let ctx = null, master, musicBus, sfxBus, voiceBus, timer = null, nextT = 0, step = 0, song = null;
  const VOL = { music: 0.16, sfx: 0.42, voice: 0.9, duck: 0.3 };

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC();
    master = ctx.createDynamicsCompressor(); master.threshold.value = -18; master.ratio.value = 4; master.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = st.music ? VOL.music : 0; musicBus.connect(master);
    // 简单混响：两条反馈延迟，让古筝更有空间感
    const d1 = ctx.createDelay(1), d2 = ctx.createDelay(1), fb1 = ctx.createGain(), fb2 = ctx.createGain(), wet = ctx.createGain(), lp = ctx.createBiquadFilter();
    d1.delayTime.value = 0.23; d2.delayTime.value = 0.37; fb1.gain.value = fb2.gain.value = 0.32; wet.gain.value = 0.35; lp.type = "lowpass"; lp.frequency.value = 2600;
    musicBus.connect(d1); d1.connect(fb1); fb1.connect(d1); musicBus.connect(d2); d2.connect(fb2); fb2.connect(d2);
    d1.connect(lp); d2.connect(lp); lp.connect(wet); wet.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = st.sfx ? VOL.sfx : 0; sfxBus.connect(master);
    voiceBus = ctx.createGain(); voiceBus.gain.value = VOL.voice; voiceBus.connect(ctx.destination);
    return ctx;
  }
  const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

  // ---------- 乐器 ----------
  function pluck(bus, midi, t, dur = 1.6, vol = 0.5) { // 古筝/琵琶式拨弦
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = "triangle"; o2.type = "sine"; o.frequency.setValueAtTime(hz(midi) * 1.012, t); o.frequency.exponentialRampToValueAtTime(hz(midi), t + 0.08);
    o2.frequency.value = hz(midi) * 2; f.type = "lowpass"; f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(700, t + dur);
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); o2.connect(g2); g2.connect(f); f.connect(g); g.connect(bus);
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }
  function flute(bus, midi, t, dur = 1, vol = 0.18) { // 笛箫式长音，带颤音
    const o = ctx.createOscillator(), g = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
    o.type = "sine"; o.frequency.value = hz(midi); lfo.frequency.value = 5.2; lg.gain.value = hz(midi) * 0.006;
    lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.18); g.gain.setValueAtTime(vol, t + dur * 0.7); g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus); o.start(t); lfo.start(t); o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
  }
  function pad(bus, midi, t, dur, vol = 0.07) { // 低音持续音
    for (const m of [midi, midi + 7]) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine"; o.frequency.value = hz(m);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + dur * 0.3); g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(bus); o.start(t); o.stop(t + dur + 0.05);
    }
  }
  function noise(bus, t, dur, { freq = 2000, q = 1, vol = 0.3, type = "bandpass", sweep } = {}) {
    const n = Math.floor(ctx.sampleRate * dur), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = b; f.type = type; f.frequency.setValueAtTime(freq, t); if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur); f.Q.value = q;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(bus); s.start(t); s.stop(t + dur);
  }
  function tone(bus, freq, t, dur, { type = "sine", vol = 0.3, to } = {}) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(freq, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + dur + 0.02);
  }

  // ---------- 原创五声音阶背景音乐（用固定种子生成，所以每次循环都是同一首） ----------
  const PENTA = [0, 2, 4, 7, 9]; // 宫 商 角 徵 羽
  function seeded(seed) { let x = seed; return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648); }
  function compose(seed, root, bars, mode) {
    const R = seeded(seed); const notes = []; let deg = 5 + mode; // 在两个八度的五声音阶上随机游走
    const scale = []; for (let o = 0; o < 3; o++) for (const p of PENTA) scale.push(root + o * 12 + p);
    for (let i = 0; i < bars * 8; i++) {
      const beatStrong = i % 8 === 0, end = i === bars * 8 - 1;
      const rest = !beatStrong && R() < 0.38;
      if (end) deg = 5 + mode; else if (!rest) deg = Math.max(2, Math.min(12, deg + [-2, -1, -1, 0, 1, 1, 2][Math.floor(R() * 7)]));
      notes.push(rest ? null : scale[deg]);
    }
    return { notes, scale };
  }
  const SONGS = {
    hall: { bpm: 72, root: 62, ...compose(20261115, 62, 8, 0), bass: [50, 47, 43, 45] },           // D 宫：大气
    poker: { bpm: 64, root: 57, ...compose(3141592, 57, 8, 1), bass: [45, 43, 40, 38] },          // A 羽：沉静
    mj: { bpm: 84, root: 60, ...compose(8888, 60, 8, 2), bass: [48, 45, 43, 50] },                // C 徵：轻快
  };
  function tick() {
    if (!ctx || !song) return;
    const eighth = 60 / song.bpm / 2;
    while (nextT < ctx.currentTime + 0.4) {
      const i = step % song.notes.length, n = song.notes[i];
      if (i % 16 === 0) pad(musicBus, song.bass[(i / 16) % song.bass.length], nextT, eighth * 16);
      if (n) { if (i % 16 === 8 && song === SONGS.hall) flute(musicBus, n + 12, nextT, eighth * 6); else pluck(musicBus, n, nextT, 1.8, i % 8 === 0 ? 0.42 : 0.3); }
      if (i % 4 === 2 && Math.random() < 0.18) pluck(musicBus, n ? n + 12 : song.scale[10], nextT + eighth / 2, 0.9, 0.12); // 轻轻的装饰音
      nextT += eighth; step++;
    }
  }
  function startMusic() {
    if (!ctx || !st.music || !st.area || document.hidden) return;
    const s = SONGS[st.area]; if (!s) return;
    if (song !== s) { song = s; step = 0; nextT = ctx.currentTime + 0.1; }
    if (!timer) { nextT = Math.max(nextT, ctx.currentTime + 0.1); timer = setInterval(tick, 120); }
  }
  function stopMusic() { clearInterval(timer); timer = null; }

  // ---------- 音效 ----------
  const now = () => ctx.currentTime;
  const ok = () => ctx && st.sfx && st.unlocked;
  const FX = {
    tap() { if (!ok()) return; tone(sfxBus, 880, now(), 0.06, { type: "triangle", vol: 0.12 }); },
    deal() { if (!ok()) return; const t = now(); noise(sfxBus, t, 0.09, { freq: 3500, q: 0.8, vol: 0.35, sweep: 1500 }); },
    chip() { if (!ok()) return; const t = now(); tone(sfxBus, 2400, t, 0.08, { vol: 0.18 }); tone(sfxBus, 3100, t + 0.05, 0.1, { vol: 0.14 }); noise(sfxBus, t, 0.05, { freq: 5000, vol: 0.12 }); },
    check() { if (!ok()) return; const t = now(); tone(sfxBus, 180, t, 0.08, { vol: 0.35, to: 120 }); tone(sfxBus, 180, t + 0.12, 0.08, { vol: 0.3, to: 120 }); },
    fold() { if (!ok()) return; noise(sfxBus, now(), 0.25, { freq: 1800, q: 0.6, vol: 0.25, sweep: 400 }); },
    win() { if (!ok()) return; const t = now(); [0, 2, 4, 7, 9, 12].forEach((p, k) => pluck(sfxBus, 72 + p, t + k * 0.08, 1.2, 0.35)); },
    tick() { if (!ok()) return; tone(sfxBus, 1320, now(), 0.09, { type: "square", vol: 0.07 }); },
    spin() { if (!ok()) return; const t = now(); noise(sfxBus, t, 0.35, { freq: 600, q: 0.7, vol: 0.18, sweep: 2600 }); tone(sfxBus, 330, t, 0.25, { type: "triangle", vol: 0.1, to: 660 }); },
    reelStop(r = 0) { if (!ok()) return; const t = now(); tone(sfxBus, 260 - r * 12, t, 0.09, { vol: 0.3, to: 140 }); noise(sfxBus, t, 0.04, { freq: 2500, vol: 0.12 }); },
    cascade(mult = 1) { if (!ok()) return; const t = now(); const base = 67 + Math.min(12, [0, 0, 2, 4, 7, 7, 9, 9, 9, 9, 12][Math.min(10, mult)] ); pluck(sfxBus, base, t, 0.8, 0.35); pluck(sfxBus, base + 7, t + 0.07, 0.8, 0.25); },
    pop() { if (!ok()) return; noise(sfxBus, now(), 0.12, { freq: 4200, q: 2, vol: 0.12 }); },
    mjWin() { if (!ok()) return; const t = now(); [0, 4, 7].forEach((p, k) => pluck(sfxBus, 76 + p, t + k * 0.07, 1, 0.3)); },
    bigWin() { if (!ok()) return; const t = now(); [0, 2, 4, 7, 9, 12, 14, 16, 19].forEach((p, k) => pluck(sfxBus, 67 + p, t + k * 0.09, 1.4, 0.32)); [0, 4, 7].forEach((p) => flute(sfxBus, 79 + p, t + 0.9, 1.4, 0.07)); },
    freeSpins() { if (!ok()) return; const t = now(); for (let k = 0; k < 3; k++) { tone(sfxBus, 520, t + k * 0.18, 0.5, { type: "triangle", vol: 0.12 }); } [0, 4, 7, 12, 16, 19, 24].forEach((p, k) => pluck(sfxBus, 64 + p, t + 0.5 + k * 0.07, 1.4, 0.3)); noise(sfxBus, t + 0.5, 1.2, { freq: 6000, q: 3, vol: 0.1, sweep: 9000 }); },
  };

  // ---------- 配音（public/voice/*.mp3，普通话女声，离线生成的静态文件） ----------
  const LINES = {
    hall_welcome: "欢迎来到时烽", pk_turn: "轮到你了", pk_check: "过牌", pk_call: "跟注", pk_raise: "加注", pk_allin: "全下", pk_fold: "弃牌",
    pk_deal: "发牌", pk_flop: "翻牌", pk_turncard: "转牌", pk_river: "河牌", pk_youwin: "你赢了", pk_showdown: "摊牌",
    mj_start: "开始", mj_hu: "胡了", mj_combo: "连消", mj_c2: "二连消", mj_c3: "三连消", mj_c4: "四连消", mj_c5: "五连消", mj_c6: "六连消", mj_c10: "十连消",
    mj_free: "免费游戏", mj_big: "大奖", mj_super: "超级大奖", mj_nochips: "余额不足",
  };
  // 优先级：高的可以打断低的；同时最多排队 1 句，排队超过 1.5 秒就丢掉，避免越积越多
  const PRIO = { hall_welcome: 3, pk_turn: 4, pk_youwin: 5, pk_showdown: 3, mj_free: 5, mj_big: 5, mj_super: 6, mj_nochips: 4, mj_hu: 2, mj_start: 1 };
  const prio = (id) => PRIO[id] || 2;
  const bufs = new Map(); let cur = null, queued = null, pendingWelcome = false;
  function loadVoice(id) {
    if (!ctx || !LINES[id]) return Promise.resolve(null);
    if (!bufs.has(id)) bufs.set(id, fetch(`/voice/${id}.mp3`).then((r) => { if (!r.ok) throw new Error("404"); return r.arrayBuffer(); })
      .then((ab) => new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej))).catch(() => null));
    return bufs.get(id);
  }
  function preload(area) { if (!ctx) return; Object.keys(LINES).filter((k) => (area === "mj" ? k.startsWith("mj_") : area === "poker" ? k.startsWith("pk_") : k.startsWith("hall_"))).forEach(loadVoice); }
  function duck(on) { if (ctx) musicBus.gain.setTargetAtTime(st.music ? VOL.music * (on ? VOL.duck : 1) : 0, ctx.currentTime, on ? 0.05 : 0.25); }
  function speakFallback(id) { // 音频文件加载失败时才用浏览器朗读
    try { const sy = window.speechSynthesis; if (!sy) return; sy.cancel(); const u = new SpeechSynthesisUtterance(LINES[id]); u.lang = "zh-CN"; u.rate = 1.1; u.volume = 0.9; sy.speak(u); } catch (e) {}
  }
  async function playVoice(id) {
    const b = await loadVoice(id);
    if (!st.voice) return;
    if (!b) { speakFallback(id); return; }
    const src = ctx.createBufferSource(); src.buffer = b; src.connect(voiceBus);
    const me = { id, src, p: prio(id) }; cur = me; duck(true);
    src.onended = () => { if (cur !== me) return; cur = null; const q = queued; queued = null; if (q && Date.now() - q.at < 1500) playVoice(q.id); else duck(false); };
    src.start();
  }
  function voice(id) {
    if (!LINES[id] || !st.voice) return;
    if (!st.unlocked || !ctx) { if (id === "hall_welcome") pendingWelcome = true; return; }
    const p = prio(id);
    if (cur) {
      if (p > cur.p) { const c = cur; cur = null; try { c.src.onended = null; c.src.stop(); } catch (e) {} queued = null; return playVoice(id); }
      if (!queued || p >= prio(queued.id)) queued = { id, at: Date.now() }; // 只留最新/最重要的一句
      return;
    }
    playVoice(id);
  }

  // ---------- 开关 ----------
  function apply() {
    if (ctx && !st.voice && cur) { try { cur.src.stop(); } catch (e) {} cur = null; queued = null; }
    if (ctx) { musicBus.gain.setTargetAtTime(st.music ? VOL.music * (cur ? VOL.duck : 1) : 0, ctx.currentTime, 0.1); sfxBus.gain.setTargetAtTime(st.sfx ? VOL.sfx : 0, ctx.currentTime, 0.05); }
    if (st.music) startMusic(); else stopMusic();
    document.querySelectorAll(".sndgrp").forEach(render);
  }
  function render(el) {
    el.innerHTML = `<button class="snd ${st.music ? "on" : ""}" data-k="music" aria-label="背景音乐" title="背景音乐">${st.music ? "🎵" : "🎵"}<i>${st.music ? "" : "╲"}</i></button><button class="snd ${st.sfx ? "on" : ""}" data-k="sfx" aria-label="音效" title="音效">${st.sfx ? "🔊" : "🔇"}</button><button class="snd ${st.voice ? "on" : ""}" data-k="voice" aria-label="配音" title="配音">🗣<i>${st.voice ? "" : "╲"}</i></button>`;
    el.querySelectorAll("button").forEach((b) => b.onclick = (e) => { e.stopPropagation(); unlock(); const k = b.dataset.k; st[k] = !st[k]; localStorage.setItem(LS[k], st[k] ? "1" : "0"); apply(); if (k === "sfx" && st.sfx) FX.tap(); if (window.toast) toast(`${k === "music" ? "背景音乐" : k === "sfx" ? "音效" : "配音"}已${st[k] ? "开启" : "关闭"}`); });
  }
  function unlock() {
    if (!ensure()) return;
    if (ctx.state === "suspended") ctx.resume();
    if (!st.unlocked) { // iOS：在点击里播一个静音片段解锁
      const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
      st.unlocked = true; startMusic(); preload(st.area);
      if (pendingWelcome && st.area === "hall") { pendingWelcome = false; setTimeout(() => voice("hall_welcome"), 150); }
    }
  }
  window.addEventListener("pointerdown", unlock, { capture: true, passive: true });
  window.addEventListener("touchend", unlock, { capture: true, passive: true });
  window.addEventListener("keydown", unlock, { capture: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { stopMusic(); if (ctx && ctx.state === "running") ctx.suspend(); } else if (ctx && st.unlocked) { ctx.resume(); startMusic(); } });

  window.SFX = {
    ...FX,
    area(a) { if (st.area === a) return; st.area = a; if (ctx) { stopMusic(); song = null; startMusic(); if (st.unlocked) preload(a); } },
    voice,
    welcome() { if (sessionStorage.getItem("sf_welcomed")) return; sessionStorage.setItem("sf_welcomed", "1"); voice("hall_welcome"); },
    lines: LINES,
    voiceState: () => ({ cur: cur && cur.id, queued: queued && queued.id, loaded: [...bufs.keys()] }),
    state: () => ({ ...st, ctx: ctx ? ctx.state : "none", playing: !!timer }),
    mount() { document.querySelectorAll(".sndgrp").forEach(render); },
  };
  if (document.readyState !== "loading") window.SFX.mount(); else document.addEventListener("DOMContentLoaded", () => window.SFX.mount());
})();
