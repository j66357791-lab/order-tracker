// 一次性迁移：守护者数值缩至游戏尺度 + 玩家攻击与装备页"攻击力（飞剑）"完全一致（执行后自删）
const fs = require("fs");
const f = "shanhai_game.js";
let s = fs.readFileSync(f, "utf8");
let n = 0;
const rep = (a, b) => {
  if (!s.includes(a)) { console.log("MISS:", a.slice(0, 70)); return; }
  s = s.split(a).join(b); n++;
};

rep("1: { name: '石傀·初醒', hp: 3000, atk: 12, def: 20, defRate: 20, critRes: 20, skill: '石肤：受到的伤害降低 10%' },",
    "1: { name: '石傀·初醒', hp: 320, atk: 4, def: 3, defRate: 20, critRes: 20, skill: '石肤：受到的伤害降低 10%' },");
rep("2: { name: '石傀·撼地', hp: 6000, atk: 24, def: 40, defRate: 25, critRes: 25, skill: '石肤+重击：20% 概率 1.5 倍伤害' },",
    "2: { name: '石傀·撼地', hp: 640, atk: 6, def: 5, defRate: 25, critRes: 25, skill: '石肤+重击：20% 概率 1.5 倍伤害' },");
rep("3: { name: '石傀·碎岳', hp: 12000, atk: 48, def: 80, defRate: 30, critRes: 30, skill: '石肤+石化凝视：命中后减速' },",
    "3: { name: '石傀·碎岳', hp: 1100, atk: 9, def: 7, defRate: 30, critRes: 30, skill: '石肤+石化凝视：命中后减速' },");
rep("4: { name: '石傀·镇脉', hp: 24000, atk: 96, def: 160, defRate: 35, critRes: 35, skill: '石肤+大地脉动：每 3 回合回复 5% 生命' },",
    "4: { name: '石傀·镇脉', hp: 1700, atk: 12, def: 10, defRate: 35, critRes: 35, skill: '石肤+大地脉动：每 3 回合回复 5% 生命' },");
rep("5: { name: '石傀·灵脉之主', hp: 48000, atk: 192, def: 320, defRate: 40, critRes: 40, skill: '石肤+灵脉共鸣：生命低于 30% 攻击翻倍' },",
    "5: { name: '石傀·灵脉之主', hp: 2600, atk: 10, def: 14, defRate: 40, critRes: 40, skill: '石肤+灵脉共鸣：生命低于 30% 攻击翻倍' },");

rep('const atk = Math.round(300 * (1 + V("weapon") + ((sl.fireline || 0) + (sl.icepick || 0)) * 0.06));',
    'const atk = 5 + (eq.weapon && Number(eq.weapon.val) || 0);   // 【v26.55】与装备页"攻击力（飞剑）"完全一致');

fs.writeFileSync(f, s, "utf8");
console.log("replacements applied:", n);
