// 一次性：守护者×3 + 过期会话清理（执行后自删）
const fs = require("fs");
const f = "shanhai_game.js";
let s = fs.readFileSync(f, "utf8");
let n = 0;
const pairs = [
  ["hp: 320, atk: 4, def: 3,", "hp: 960, atk: 12, def: 9,"],
  ["hp: 640, atk: 6, def: 5,", "hp: 1920, atk: 18, def: 15,"],
  ["hp: 1100, atk: 9, def: 7,", "hp: 3300, atk: 27, def: 21,"],
  ["hp: 1700, atk: 12, def: 10,", "hp: 5100, atk: 36, def: 30,"],
  ["hp: 2600, atk: 10, def: 14,", "hp: 7800, atk: 30, def: 42,"],
];
for (const [a, b] of pairs) {
  if (!s.includes(a)) { console.log("MISS", a); continue; }
  s = s.split(a).join(b); n++;
}
const sweepOld = "  const occs = await db.collection(OCC_COL).find({ lastSettleAt: { $lte: new Date(now.getTime() - 3600e3) } }).limit(200).toArray();";
const sweepNew = sweepOld + "\n    await db.collection('shanhai_battles').deleteMany({ expireAt: { $lt: new Date() } }).catch(() => { });   // 过期战斗会话清理";
if (s.includes(sweepOld)) { s = s.replace(sweepOld, sweepNew); n++; }
else console.log("SWEEP ANCHOR MISS");
fs.writeFileSync(f, s, "utf8");
console.log("applied:", n);
