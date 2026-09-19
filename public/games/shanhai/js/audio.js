// audio.js — 山海斩妖录音效与背景音乐（Web Audio 实时合成，零音频素材、离线可用）
// 设计思路：与翻翻乐同出一辙——不引入任何音频文件，全部用振荡器 + 噪声实时合成。
//   打击音：短促金属"锵"（三角波下滑 + 高通噪声瞬态），命中反馈要脆
//   火/冰：火焰是低频噪声扫频的"呼"，冰锥是高频方波的"叮"
//   BGM  ：五声音阶（宫商角徵羽 = C D E G A）循环乐句 + 轻鼓点，国风但不喧宾夺主
"use strict";
const SFX = (() => {
  let ctx = null, master = null, bgmGain = null;
  let enabled = localStorage.getItem("sh_snd") !== "0";
  let bgmTimer = null, bgmBar = 0, bgmOn = false;

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
      bgmGain = ctx.createGain(); bgmGain.gain.value = 0.0; bgmGain.connect(master);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // —— 基础音色 ——
  function tone(freq, dur, type, vol, when, slideTo, dest) {
    if (!enabled) return;
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + (when || 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(dest || master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function noise(dur, vol, filterType, freq, when, sweepTo) {
    if (!enabled) return;
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + (when || 0);
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = filterType || "highpass"; f.frequency.setValueAtTime(freq, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0);
  }

  // ================= 战斗音效 =================
  const api = {
    get enabled() { return enabled; },
    unlock() { try { ac(); } catch (e) {} },   // 首次手势后调用（自动播放策略）
    setEnabled(on) { enabled = !!on; localStorage.setItem("sh_snd", enabled ? "1" : "0"); if (!enabled) api.bgmStop(); return enabled; },
    toggle() { return api.setEnabled(!enabled); },

    // 飞剑命中：脆金属"锵"（三角波下滑 + 高通噪声瞬态）
    swordHit(crit) {
      tone(1250, 0.09, "triangle", 0.16, 0, 520);
      noise(0.05, 0.13, "highpass", 2600);
      if (crit) { tone(1900, 0.12, "square", 0.10, 0.02, 1200); }
    },
    // 火球命中：低频"呼" + 一点噼啪
    fireHit() { noise(0.20, 0.10, "lowpass", 900, 0, 260); tone(220, 0.14, "sawtooth", 0.07, 0, 120); },
    // 冰锥命中：高频"叮" + 微弱回响
    iceHit() { tone(2100, 0.11, "square", 0.10, 0, 1500); tone(2600, 0.09, "sine", 0.06, 0.05, 1900); },
    // 旋风刃：更轻的擦身声
    galeHit() { noise(0.07, 0.09, "bandpass", 1800); tone(900, 0.06, "triangle", 0.07, 0, 620); },
    hit(kind, crit) {
      if (kind === "fireline") return api.fireHit();
      if (kind === "icepick") return api.iceHit();
      if (kind === "gale") return api.galeHit();
      return api.swordHit(crit);
    },
    // 玩家受伤：低沉短促
    hurt() { tone(180, 0.22, "sawtooth", 0.16, 0, 90); noise(0.10, 0.07, "lowpass", 500); },
    // 拾取经验珠：极轻的"叮"（量大，音量必须小）
    orb() { tone(1400, 0.05, "sine", 0.035); },
    heal() { tone(700, 0.14, "sine", 0.10, 0, 1100); },
    // 升级三选一：上行三音
    levelUp() { [523, 659, 880].forEach((f, i) => tone(f, 0.16, "triangle", 0.13, i * 0.09)); },
    // 精英 / 小怪死亡
    enemyDie(elite) {
      if (elite) { noise(0.30, 0.14, "lowpass", 1400, 0, 200); tone(300, 0.28, "sawtooth", 0.12, 0, 90); }
      else { noise(0.14, 0.09, "lowpass", 1200, 0, 300); tone(420, 0.10, "triangle", 0.08, 0, 180); }
    },
    bossDie() {
      noise(0.7, 0.18, "lowpass", 1800, 0, 120);
      tone(140, 0.9, "sawtooth", 0.18, 0, 60);
      [392, 523, 659, 784].forEach((f, i) => tone(f, 0.26, "triangle", 0.13, 0.35 + i * 0.13));
    },
    waveStart() { tone(330, 0.12, "triangle", 0.09); tone(440, 0.14, "triangle", 0.09, 0.10); },
    victory() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.30, "triangle", 0.15, i * 0.16)); },
    gameOver() { [392, 330, 262].forEach((f, i) => tone(f, 0.34, "sine", 0.14, i * 0.20)); },

    // ================= 战斗 BGM（五声音阶循环乐句） =================
    bgmStart() {
      if (bgmOn || !enabled) return;
      const c = ac(); if (!c) return;
      bgmOn = true; bgmBar = 0;
      // 淡入
      bgmGain.gain.cancelScheduledValues(c.currentTime);
      bgmGain.gain.setValueAtTime(0.0001, c.currentTime);
      bgmGain.gain.linearRampToValueAtTime(0.10, c.currentTime + 1.5);
      const PENTA = [261.6, 293.7, 329.6, 392.0, 440.0];   // 宫 商 角 徵 羽
      const BAR = 2.0;                                      // 每小节 2 秒
      const playBar = () => {
        if (!bgmOn) return;
        const t = c.currentTime;
        // 低音（每小节根音）
        const root = [130.8, 146.8, 164.8, 196.0][bgmBar % 4];
        tone(root, BAR * 0.9, "sine", 0.10, 0, root, bgmGain);
        // 旋律：五声音阶随机游走（每小节 4 音）
        for (let i = 0; i < 4; i++) {
          const f = PENTA[Math.floor(Math.random() * PENTA.length)] * (Math.random() < 0.3 ? 2 : 1);
          tone(f, 0.42, "triangle", 0.055, i * (BAR / 4), f, bgmGain);
        }
        // 鼓点：kick 在 1/3 拍，hat 在每个八分
        for (let i = 0; i < 4; i++) {
          if (i % 2 === 0) tone(70, 0.16, "sine", 0.14, i * (BAR / 4), 45, bgmGain);
          noise(0.04, 0.02, "highpass", 6000);
        }
        bgmBar++;
        bgmTimer = setTimeout(playBar, BAR * 1000);
      };
      playBar();
    },
    bgmStop() {
      if (!bgmOn) return;
      bgmOn = false;
      clearTimeout(bgmTimer); bgmTimer = null;
      try {
        const c = ctx; if (!c) return;
        bgmGain.gain.cancelScheduledValues(c.currentTime);
        bgmGain.gain.setValueAtTime(bgmGain.gain.value, c.currentTime);
        bgmGain.gain.linearRampToValueAtTime(0.0001, c.currentTime + 0.8);
      } catch (e) {}
    },
    get bgmOn() { return bgmOn; },
  };
  return api;
})();
window.SFX = SFX;
