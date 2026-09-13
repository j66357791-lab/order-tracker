// meta.js — 养成状态管理（服务端档案 + 本地缓存 + 加成计算）
"use strict";
const META = (() => {
  let profile = null;

  // —— 加成计算（战斗读这里） ——
  function bonus() {
    const p = profile || {};
    const sl = p.skillLv || { fireline: 0, icepick: 0, body: 0 };
    const w = p.equip?.weapon, t = p.equip?.talisman;
    return {
      atkMul: 1 + (w ? w.val / 100 : 0),                  // 武器攻击%
      hpMul: 1 + (t ? t.val / 100 : 0),                   // 护符生命%
      fireMul: 1 + (w ? w.val / 100 : 0) + sl.fireline * 0.06,
      iceMul: 1 + (w ? w.val / 100 : 0) + sl.icepick * 0.06,
      bodyHpMul: 1 + sl.body * 0.08,
      fireScale: 1 + (sl.fireline * 0.12),                // 火羽视觉大小
      iceCount: 1 + (sl.icepick >= 3 ? 1 : 0),            // 3层冰锥+1枚
    };
  }

  async function load() {
    const d = await shApi("/api/shanhai/profile");
    profile = d.profile;
    return profile;
  }
  async function report(win, stage) {
    const h = Game.hero;
    if (!h) return null;
    try {
      const d = await shApi("/api/shanhai/result", { method: "POST", body: JSON.stringify({
        win, stage, timeSec: Math.round(h.timeAlive), kills: h.kills, level: h.level, dmgTaken: Math.round(h.dmgTaken),
      }) });
      profile = d.profile;
      return d.gain;
    } catch (e) { console.warn("report fail", e); return null; }
  }
  async function upgradeSkill(key) {
    const d = await shApi("/api/shanhai/upgrade", { method: "POST", body: JSON.stringify({ key }) });
    profile = d.profile;
    return d;
  }
  async function draw() {
    const d = await shApi("/api/shanhai/draw", { method: "POST", body: JSON.stringify({}) });
    profile = d.profile;
    return d;
  }

  return { load, report, upgradeSkill, draw, bonus, get profile() { return profile; } };
})();
window.META = META;
