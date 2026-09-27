#!/usr/bin/env node
// tools/audit_duiduile.mjs — 灵气堆堆乐发放对账（【只读】，不写库、不发钱、可放心在生产跑）
//
// 要回答的问题：玩家说"积分按 100 天发到邮箱，但今天没收到"。可能的原因有三类，
// 光看代码分不出来，必须看数据：
//   A. 释放起点还没到（releaseStart 在未来）→ 本来就该没发
//   B. 起点到了但任务没跑/被跳过 → 应发未发，且下一轮会一次补齐
//   C. 份额已推进（releasedDays 涨了）但邮箱里没有对应邮件 → 邮件丢了（v26.74 已加回退保护，
//      但历史上已丢的那部分需要在这里被查出来）
//
// 用法（在项目根目录，环境变量 MONGO_URI 与线上一致）：
//   node tools/audit_duiduile.mjs                # 汇总 + 异常明细
//   node tools/audit_duiduile.mjs --user 写手名  # 只看某个人
//   node tools/audit_duiduile.mjs --limit 50     # 明细条数
import { MongoClient } from 'mongodb';

const URI = String(process.env.MONGO_URI || '').trim();
if (!URI) { console.error('缺少环境变量 MONGO_URI'); process.exit(1); }

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY_USER = opt('user', '');
const DETAIL = Number(opt('limit', 30));
const DD_COL = 'shanhai_duiduile';
const MAIL_COL = 'shanhai_mails';
const DD_DAYS = 100;
const DAY = 86400e3;

// 北京时间口径（与游戏内 ddCnToday / 服务端结算一致），只用于展示
const cn = (d) => new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db();
const now = Date.now();

console.log('=== 灵气堆堆乐发放对账（只读） ===');
console.log('现在(北京)：' + cn(new Date()) + '   库：' + db.databaseName);

// —— 1. 活动窗口 ——
console.log('\n【1】活动配置 shanhai_activities (type=duiduile)');
const acts = await db.collection('shanhai_activities').find({ type: 'duiduile' }).sort({ updatedAt: -1 }).limit(5).toArray();
if (!acts.length) console.log('  ⚠ 没有任何 duiduile 活动记录');
for (const a of acts) {
  const st = a.start ? new Date(a.start).getTime() : null;
  const en = a.end ? new Date(a.end).getTime() : null;
  console.log(`  _id=${a._id} 「${a.title}」 enabled=${a.enabled !== false}`);
  console.log(`     开始 ${a.start ? cn(a.start) + (st <= now ? '（已过）' : '（未到）') : '未设置'}` +
    ` ｜ 结束 ${a.end ? cn(a.end) + (en >= now ? '（仍在进行）' : '（已结束）') : '未设置'}`);
}

// —— 2. 逐条记录：应发到第几天 vs 实际发到第几天 ——
const q = {};
if (ONLY_USER) {
  const u = await db.collection('users').findOne(/^\d{7}$/.test(ONLY_USER) ? { uid: ONLY_USER } : { username: ONLY_USER })
    || await db.collection('users').findOne({ displayName: ONLY_USER });
  if (!u) { console.log(`\n找不到用户 ${ONLY_USER}`); process.exit(0); }
  q.userId = u._id.toString();
  console.log(`\n只看用户：${u.username} / ${u.displayName || ''}（userId=${q.userId}）`);
}
const total = await db.collection(DD_COL).countDocuments(q);
const recs = await db.collection(DD_COL).find(q).sort({ releaseStart: -1 }).limit(5000).toArray();
console.log(`\n【2】参与记录共 ${total} 条${total > recs.length ? `（本次分析前 ${recs.length} 条）` : ''}`);

const stats = { 未到期: 0, 正常: 0, 落后: 0, 应发未发: 0, 邮件缺失: 0, 已结束: 0 };
const problems = [];
let sumShould = 0, sumDone = 0;

for (const r of recs) {
  const startMs = new Date(r.releaseStart).getTime();
  const perDay = Number(r.perDay) || 0;
  const reward = Number(r.reward) || 0;
  const released = Number(r.releasedDays) || 0;
  const releasedAmt = r2(r.releasedAmount);
  if (Number.isNaN(startMs) || now < startMs) { stats.未到期++; continue; }
  const dayIdx = Math.floor((now - startMs) / DAY);
  const target = Math.min(DD_DAYS, dayIdx + 1);
  const shouldAmt = r2(perDay * Math.min(target, DD_DAYS - 1) + (target >= DD_DAYS ? Math.max(0, reward - perDay * (DD_DAYS - 1)) : 0));
  sumShould += shouldAmt; sumDone += releasedAmt;
  if (released >= DD_DAYS) { stats.已结束++; continue; }
  if (released >= target) { stats.正常++; continue; }
  // 进度落后于"应该发到的天数"
  const gap = target - released;
  stats.落后++;
  // 关键区分：任务今天跑过吗？（lastDay 是不是今天）
  const cnToday = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
  const ranToday = String(r.lastDay || '') === cnToday;
  if (!ranToday) { stats.应发未发++; problems.push({ kind: '应发未发（释放任务没把它算进去）', r, target, released, gap, perDay, shouldAmt, releasedAmt }); continue; }
  problems.push({ kind: '进度落后但今天已跑过（可能是历史欠账或邮件失败）', r, target, released, gap, perDay, shouldAmt, releasedAmt });
}

console.log('  统计：' + JSON.stringify(stats, null, 0));
console.log(`  灵气合计：应发 ${r2(sumShould)}，账上已推进 ${r2(sumDone)}，差额 ${r2(sumShould - sumDone)}`);

// —— 3. 邮箱侧核对 ——
console.log('\n【3】邮箱侧核对（标题含「灵气堆堆乐」的站内信）');
const titles = ['灵气堆堆乐 · 每日释放'];
const mailAgg = await db.collection(MAIL_COL).aggregate([
  { $match: { title: { $regex: '灵气堆堆乐' } } },
  { $group: { _id: '$to', n: { $sum: 1 }, attach: { $sum: '$attach.lingqi' }, last: { $max: '$createdAt' }, first: { $min: '$createdAt' } } },
  { $sort: { last: -1 } },
]).toArray();
const mailBy = new Map(mailAgg.map(m => [String(m._id), m]));
console.log(`  涉及 ${mailAgg.length} 个收件人。最近 5 位：`);
for (const m of mailAgg.slice(0, 5)) {
  console.log(`    to=${m._id} 邮件 ${m.n} 封 · 附件灵气合计 ${r2(m.attach)} · 首封 ${cn(m.first)} · 最近 ${cn(m.last)}`);
}
// 账上推进了、邮箱里却没有对应邮件 → 就是"邮件丢了"
let lost = 0;
for (const r of recs) {
  const adv = r2(r.releasedAmount);
  if (adv <= 0) continue;
  const m = mailBy.get(String(r.userId));
  if (!m) { lost++; if (lost <= 5) console.log(`    ⚠ 账上已推进 ${adv} 灵气，但邮箱里【一封堆堆乐邮件都没有】userId=${r.userId}`); continue; }
  if (r2(m.attach) + 0.5 < adv) console.log(`    ⚠ userId=${r.userId} 账上推进 ${adv}，邮件附件合计 ${r2(m.attach)}，少 ${r2(adv - m.attach)}`);
}
if (!lost) console.log('    （没有发现"账上推进了但邮件缺失"的记录）');

// —— 4. 异常明细 ——
console.log(`\n【4】异常明细（前 ${DETAIL} 条，共 ${problems.length} 条）`);
for (const p of problems.slice(0, DETAIL)) {
  console.log(`  [${p.kind}] userId=${p.r.userId} 记录起于 ${cn(p.r.releaseStart)}` +
    `｜应为第 ${p.target} 天、实际 ${p.released} 天（差 ${p.gap} 天）` +
    `｜perDay=${p.perDay} 应发 ${p.shouldAmt} 已推进 ${p.releasedAmt}｜lastDay=${JSON.stringify(p.r.lastDay)}`);
}

// —— 5. 结论提示 ——
console.log('\n【5】怎么看结果');
console.log('  · 「未到期」占多数 → 正常：释放起点由活动结束时间推出，没到就不发。');
console.log('  · 「应发未发」> 0   → 释放任务没把这些记录算进去：核对 lastDay 是否被提前写成今天、');
console.log('                        以及多实例下租约是否把任务卡住（后台「数据库占用」页可看 job_leases）。');
console.log('  · 出现「邮件都没有」→ 邮件写入失败但进度已推进（v26.74 已加回退保护，历史欠账需按上面的明细补发）。');
await client.close();
