// 山海斩妖录 M1 — 数值配置（与立项策划案第一关完全对应）
"use strict";
const CONFIG = {
  // —— 玩家（山海行者）——
  hero: {
    hp: 100,
    speed: 102,          // 3.2格/s × 32px
    pickupRadius: 80,    // 2.5格
    iframe: 0.5,         // 受击无敌秒
    radius: 10,          // 碰撞半径
  },

  // —— 怪物（第1关基准值，策划案第四章）——
  enemies: {
    zheng:   { name: "狰",   hp: 18, speed: 83,  dmg: 10, exp: 1, radius: 10, anim: "zheng",      behavior: "chase"   },
    shanhao: { name: "山臊", hp: 8,  speed: 122, dmg: 6,  exp: 1, radius: 8,  anim: "shanhaogt",  behavior: "chase"   },
    bifang:  { name: "毕方", hp: 14, speed: 70,  dmg: 8,  exp: 2, radius: 10, anim: "bifang",     behavior: "ranged", shotDmg: 5, shotCd: 2.2, shotRange: 260 },
    xuangui: { name: "旋龟", hp: 55, speed: 45,  dmg: 14, exp: 3, radius: 12, anim: "xuangui",    behavior: "chase"   },
  },

  // —— Boss：山臊王（第6关位登场于M1第15波，HP用第1关缩放基准800）——
  boss: {
    name: "山臊王", hp: 800, speed: 60, contactDmg: 20, radius: 20, exp: 40,
    // 技能循环（策划案4.3）：投石 → 召唤4山臊 → 跳砸AOE
    rockDmg: 20, rockCd: 3.2,
    summonCount: 4, summonCd: 7.0,
    smashDmg: 30, smashRadius: 110, smashCd: 5.5,
  },

  // —— 技能（策划案第五章：火系凤凰火线 / 冰系冰锥 / 通用修身体质）——
  weapons: {
    fireline: {
      name: "凤凰火线", desc: "灼羽射向最近之敌",
      baseDmg: 8, cd: 0.4, projSpeed: 300, projRadius: 6,
      dmgPerLv: 4, cdPerLv: -0.03, maxLv: 5,
      lvDesc: ["1枚灼羽", "伤害+4", "灼羽+1", "伤害+4", "灼羽+1·伤+4"],
    },
    icepick: {
      name: "寒冰锥", desc: "穿透冰锥，减速敌军",
      baseDmg: 12, cd: 2.5, projSpeed: 340, projRadius: 7, pierce: 4,
      slowPct: 0.30, slowDur: 2.0,
      dmgPerLv: 5, cdPerLv: -0.2, piercePerLv: 1, maxLv: 5,
      lvDesc: ["1枚冰锥·减速30%", "伤害+5", "冰锥+1", "冷却-0.2s·穿透+1", "伤害+5·穿透+1"],
    },
    body: {
      name: "修身体质", desc: "体魄强健，血气充盈",
      hpPerLv: 20, maxLv: 5, kind: "passive",
      lvDesc: ["生命上限+20%", "生命上限+40%", "生命上限+60%", "生命上限+80%", "生命上限+100%"],
    },
  },

  // 升级选项池（三选一权重：策划案5.3）
  upgrades: {
    newSkillBias: 0.6,     // 未拥有技能权重
    stats: {
      movespeed: { name: "疾行", desc: "移速+8%", apply: (H) => H.speed *= 1.08, max: 5 },
      attack:    { name: "聚力", desc: "伤害+10%", apply: (H) => H.dmgMul *= 1.10, max: 5 },
      magnet:    { name: "聚灵", desc: "拾取范围+20%", apply: (H) => H.pickupRadius *= 1.2, max: 5 },
    },
  },

  // —— 经验曲线 ——
  expBase: 5, expStep: 3,   // L→L+1 = 5 + 3L

  // —— 波次（第1关模板：15波，策划案7.1）——
  // [波号, 持续s, 组成{type:count}, 间隔s]
  waves: [
    { dur: 18, spawn: [["zheng", 6]] },
    { dur: 16, spawn: [["zheng", 8], ["shanhao", 4]] },
    { dur: 16, spawn: [["shanhao", 10]] },
    { dur: 16, spawn: [["zheng", 8], ["shanhao", 6]] },
    { dur: 14, spawn: [["bifang", 6], ["shanhao", 8]] },
    { dur: 16, spawn: [["zheng", 12], ["bifang", 4]] },
    { dur: 14, spawn: [["shanhao", 14]] },
    { dur: 14, spawn: [["xuangui", 4], ["zheng", 8]] },
    { dur: 12, spawn: [["bifang", 8], ["shanhao", 10]] },
    { dur: 12, spawn: [["zheng", 16], ["xuangui", 3]] },
    { dur: 12, spawn: [["shanhao", 18], ["bifang", 6]] },
    { dur: 12, spawn: [["xuangui", 6], ["zheng", 14]] },
    { dur: 10, spawn: [["shanhao", 22], ["bifang", 8]] },
    { dur: 10, spawn: [["xuangui", 8], ["zheng", 16], ["shanhao", 10]] },
    { dur: 0,  spawn: [["BOSS", 1]] },   // 第15波：山臊王
  ],

  // —— 拾取 ——
  orbs: { value: 1, radius: 6, lifetime: 999, meat: { heal: 25, dropRate: 0.04 } },

  // —— 通用战斗参数 ——
  critRate: 0.05,    // 基础暴击率 5%
  critMul: 1.5,      // 暴击倍率
};
window.CONFIG = CONFIG;
