// tools/audit_recharge.mjs — 充值/提现链路「线上现状 + 是否已被刷过」只读排查脚本
//
// 只做 find/count/aggregate，不写任何东西、不改索引、不改配置。
// 用途有两块：
//   A. 判定自动到账通道现在到底是不是活的（回答"线上是哪一种情况"这个说不清的问题）
//   B. 回查历史上有没有已经被机器直接入账放走的可疑单 —— 收紧判定只是止损，
//      已经流出去的钱要靠这一步才知道规模
//
// 跑法（在项目根目录，服务器本机或有库权限的机器上）：
//   node tools/audit_recharge.mjs                       # 用 .env / 环境变量里的 MONGO_URI
//   MONGO_URI="mongodb://..." MONGO_DB=xxx node tools/audit_recharge.mjs
// 可选参数写在下面 ARGS 里，也可以直接改。
import '../lib/env.js';   // 项目自带的 .env 加载器（没有装 dotenv，别引第三方）
import { MongoClient } from 'mongodb';

const URI = process.env.MONGO_URI || '';
const DB_NAME = process.env.MONGO_DB || 'invest-jiedanyuan';
const ARGS = process.argv.slice(2);
const argNum = (name, dft) => { const a = ARGS.find(s => s.startsWith(name + '=')); return a ? Number(a.split('=')[1]) : dft; };
const SINCE_DAYS = argNum('sinceDays', 90);      // 回查窗口（天）
const TOP_N = argNum('topN', 10);                 // 榜单条数

if (!URI) { console.error('缺 MONGO_URI（写在 .env 里或直接给环境变量）'); process.exit(1); }

const since = new Date(Date.now() - SINCE_DAYS * 86400000);
const line = (t = '') => console.log(t);
const head = t => console.log('\n\x1b[1m══ ' + t + ' ══\x1b[0m');
const flag = (bad, okText, badText) => line('   ' + (bad ? '\x1b[31m● ' + badText + '\x1b[0m' : '\x1b[32m○ ' + okText + '\x1b[0m'));
const money = n => '¥' + (Math.round((n || 0) * 100) / 100).toFixed(2);

let client;
try {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 12000 });
  await client.connect();
  const db = client.db(DB_NAME);
  line('库：' + DB_NAME + '　回查窗口：最近 ' + SINCE_DAYS + ' 天');

  // ───────────────────────── A. 通道现状 ─────────────────────────
  head('A. 自动到账通道现在的配置（库里的 recharge_config）');
  const cfgDoc = await db.collection('config').findOne({ key: 'recharge_config' });
  const cfg = cfgDoc && cfgDoc.value;
  if (!cfg) {
    flag(true, '', '库里没有 recharge_config 文档 → 一切走代码默认值：通道开、¥1000/笔、每人每日 3 笔 / ¥2000');
  } else {
    line('   enabled(充值总开关)      : ' + (cfg.enabled === false ? 'false ← 全站已关闭' : 'true'));
    line('   ocrEnabled(机器识别)     : ' + (cfg.ocrEnabled === false ? 'false ← 已关，所有单走人工' : 'true/未设置 ← 默认开'));
    line('   orderNoVerify(订单号通道): ' + (cfg.orderNoVerify === false ? 'false' : 'true/未设置 ← 默认开'));
    line('   autoMax / autoDailyCount / autoDailyAmount : '
      + [money(cfg.autoMax ?? 1000), cfg.autoDailyCount ?? 3, money(cfg.autoDailyAmount ?? 2000)].join(' / '));
    line('   收款账号是否已配置       : ' + (cfg.alipayAccount ? '已配（' + String(cfg.alipayAccount).slice(0, 4) + '***）' : '未配置'));
    line('   requirePayeeInOcr(收款账号核验): ' + (cfg.requirePayeeInOcr ? '开' : '关（默认）'));
    line('   autoMinConfidence / autoMaxPri : ' + (cfg.autoMinConfidence ?? 85) + ' / ' + (cfg.autoMaxPri ?? 2)
      + '　\x1b[90m← v26.64 新增的自动到账门槛，后台可调\x1b[0m');
    if (cfg.orderNoVerify !== false) {
      flag(true, '', 'orderNoVerify 仍是开的。v26.64 之前这条通道**不看金额**就能秒到账；'
        + 'v26.64 起它只能作为"金额已核一致"的附加证据。若线上还没部署新版本，这个敞口是活的。');
    }
  }
  line('   ⚠ 环境变量 OCR_ENABLED=0 / TRUST_PROXY 这类不在库里，脚本读不到 ——');
  line('     请在服务器上看启动日志的 [自检] / [充值] 两行，或 node -e 检查 process.env');

  // ───────────────────── B. 机器入账的实际流量 ─────────────────────
  head('B. 最近 ' + SINCE_DAYS + ' 天机器直接入账的规模');
  const auto = await db.collection('recharge_orders').aggregate([
    { $match: { status: 'auto_paid', createdAt: { $gte: since } } },
    { $group: { _id: '$verifyMethod', n: { $sum: 1 }, sum: { $sum: '$amount' } } },
  ]).toArray();
  if (!auto.length) line('   ○ 没有 auto_paid 单（机器通道没放过钱，或还没人用）');
  for (const a of auto.sort((x, y) => y.n - x.n)) {
    line('   verifyMethod=' + (a._id || '(空)') + '　' + a.n + ' 笔　合计 ' + money(a.sum));
  }
  const totalAuto = auto.reduce((s, a) => s + a.sum, 0);
  const totalAutoN = auto.reduce((s, a) => s + a.n, 0);
  line('   —— 机器入账合计：' + totalAutoN + ' 笔 ' + money(totalAuto));

  // ─────────────── C. 三类可疑模式的定向回查 ───────────────
  head('C. 可疑模式定向回查（这三类对应本次收紧的三个判定）');

  // C1：只凭"订单号在截图里出现过"就入账的（旧版独立通道，最可疑）
  const byOrderNo = await db.collection('recharge_orders').aggregate([
    { $match: { verifyMethod: 'orderNo', createdAt: { $gte: since } } },
    { $project: { userId: 1, amount: 1, declared: 1, ocrAmount: 1, ocrOk: 1, ocrConfidence: 1, orderNo: 1, createdAt: 1 } },
    { $sort: { amount: -1 } }, { $limit: TOP_N },
  ]).toArray();
  line('C1　走 orderNo 通道秒到账的单据（TOP ' + TOP_N + ' by 金额）：' + byOrderNo.length + ' 条');
  for (const r of byOrderNo) {
    const mismatch = r.ocrOk && r.ocrAmount != null && Math.abs(r.ocrAmount - r.declared) >= 0.011;
    line('     ' + (mismatch ? '\x1b[31m✗\x1b[0m' : ' ') + ' ' + money(r.declared)
      + '　OCR读额=' + (r.ocrAmount == null ? '未读出' : money(r.ocrAmount))
      + '　置信=' + (r.ocrConfidence || 0) + '%　user=' + r.userId
      + '　' + (r.createdAt ? r.createdAt.toISOString().slice(0, 16) : '')
      + (mismatch ? '　\x1b[31m← 金额本来就不一致，旧版仍放行了\x1b[0m' : ''));
  }

  // C2：同一张截图被多个账号提交（旧版查重只看 userId，拦不住）
  const dupShot = await db.collection('recharge_orders').aggregate([
    { $match: { createdAt: { $gte: since }, shotHash: { $type: 'string' } } },
    { $group: { _id: '$shotHash', users: { $addToSet: '$userId' }, n: { $sum: 1 }, sum: { $sum: '$amount' }, statuses: { $push: '$status' } } },
    { $match: { $expr: { $gt: [{ $size: '$users' }, 1] } } },
    { $sort: { n: -1 } }, { $limit: TOP_N },
  ]).toArray();
  line('C2　同一张截图跨账号重复提交：' + dupShot.length + ' 组　\x1b[90m（新代码已全站查重 + shotHash 唯一索引）\x1b[0m');
  for (const d of dupShot) {
    line('     hash=' + String(d._id).slice(0, 10) + '…　' + d.users.length + ' 个账号 / ' + d.n + ' 单　合计 '
      + money(d.sum) + '　状态=' + JSON.stringify([...new Set(d.statuses)])
      + (d.users.length > 3 ? '　\x1b[31m← 批量特征\x1b[0m' : ''));
  }

  // C3：同一账号单日机器入账超过配置上限（旧配额是全平台统计，单人可超）
  const perUserDay = await db.collection('recharge_orders').aggregate([
    { $match: { status: 'auto_paid', createdAt: { $gte: since } } },
    { $group: { _id: { u: '$userId', d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+08:00' } } }, n: { $sum: 1 }, sum: { $sum: '$amount' } } },
    { $match: { $expr: { $gt: ['$n', (cfg && cfg.autoDailyCount) || 3] } } },
    { $sort: { n: -1 } }, { $limit: TOP_N },
  ]).toArray();
  line('C3　单日机器入账超过 autoDailyCount 的「人·天」：' + perUserDay.length + ' 个');
  for (const p of perUserDay) line('     ' + p._id.d + '　user=' + p._id.u + '　' + p.n + ' 笔 ' + money(p.sum));

  // C4：低置信度也放行的（新代码加了 autoMinConfidence=85 门槛，回查历史上有多少）
  const lowConf = await db.collection('recharge_orders').countDocuments({
    status: 'auto_paid', createdAt: { $gte: since }, ocrConfidence: { $gt: 0, $lt: 85 },
  });
  line('C4　置信度 <85 却机器入账的：' + lowConf + ' 笔　\x1b[90m（新门槛 85，可调）\x1b[0m');

  // ─────────── D. 账实核对：有没有"标了已到账但钱包没进钱" ───────────
  // 两步查再在内存里比对，而不是写一条深层 $lookup 管道：这里要的是"看得懂、改得动"，
  // 而且单号 note 的匹配本身是历史遗留的模糊口径（v26.64 之后新流水才带 refId）
  head('D. 账实核对（本批未修的幂等/事务问题，先摸清有没有已经踩上的）');
  const PAID_WINDOW = argNum('paidWindow', 500);
  const paid = await db.collection('recharge_orders').find(
    { status: { $in: ['auto_paid', 'paid'] }, createdAt: { $gte: since } },
    { projection: { no: 1, userId: 1, amount: 1, status: 1, createdAt: 1 }, limit: PAID_WINDOW },
  ).sort({ createdAt: -1 }).toArray();
  const uids = [...new Set(paid.map(o => o.userId))];
  const logs = await db.collection('wallet_log').find(
    { userId: { $in: uids }, kind: 'recharge' },
    { projection: { userId: 1, note: 1, amount: 1, createdAt: 1 } },
  ).toArray();
  const noteKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const logIndex = new Set(logs.map(l => l.userId + '|' + noteKey(l.note)));
  const orphans = paid.filter(o => !logIndex.has(o.userId + '|' + noteKey(o.no)));
  if (!orphans.length) line('   \x1b[32m○\x1b[0m 抽样的 ' + paid.length + ' 条已到账单据都能找到对应流水（窗口内最近 ' + PAID_WINDOW + ' 条）');
  for (const o of orphans.slice(0, TOP_N)) {
    line('   \x1b[31m●\x1b[0m 单据 ' + o.no + '　' + money(o.amount) + '　状态=' + o.status + '　user=' + o.userId
      + '　' + (o.createdAt ? o.createdAt.toISOString().slice(0, 16) : '')
      + '　→ 找不到匹配流水（钱可能从未入账）');
  }
  if (orphans.length > TOP_N) line('     …另有 ' + (orphans.length - TOP_N) + ' 条同类，去掉 TOP_N 截断可看全');
  const neg = await db.collection('wallet_log').aggregate([
    { $match: { kind: 'recharge_revoke', createdAt: { $gte: since } } },
    { $group: { _id: '$userId', n: { $sum: 1 }, sum: { $sum: '$amount' } } },
    { $sort: { sum: 1 } }, { $limit: TOP_N },
  ]).toArray();
  line('D2　驳回扣回产生的负向流水（TOP ' + TOP_N + ' 最负）：' + neg.length + ' 个账号');
  for (const v of neg) line('     user=' + v._id + '　' + v.n + ' 笔　' + money(v.sum));
  const negBal = await db.collection('wallet_log').aggregate([
    { $match: { createdAt: { $gte: new Date(0) } } },
    { $group: { _id: '$userId', bal: { $sum: { $cond: [{ $isNumber: '$amount' }, '$amount', 0] } } } },
    { $match: { bal: { $lt: 0 } } }, { $sort: { bal: 1 } }, { $limit: TOP_N },
  ]).toArray();
  line('D3　余额为负的账号：' + negBal.length + ' 个');
  for (const b of negBal) line('     user=' + b._id + '　' + money(b.bal));

  // ─────────────── E. 索引是否真的建成了（尽力而为建索引的盲区） ───────────────
  head('E. 关键唯一索引是否真的存在（代码是 fire-and-forget 建的，可能静默失败）');
  const expect = {
    // 这批是 v26.65 声明为"资金级"的唯一索引：任一条缺失，服务端会自动停用机器秒到账
    // （看启动日志 [db] 关键唯一索引 那一行，或 GET /api/recharge/config 的 autoPayEnabled）
    wallet_log: [[['kind', 'refId']]],
    recharge_orders: [[['userId', 'shotHash']], [['shotHash']]],
    redpacket_records: [[['userId', 'cardId']]],
    withdrawals: [[['userId', 'status']]],
    checkin_records: [[['userId', 'date']]],
    monthly_claims: [[['userId', 'month']]],
    users: [[['uid']], [['realname.idHash']]],
    shanhai_ex_wallet: [[['userId']]],
  };
  for (const [coll, keys] of Object.entries(expect)) {
    let idx = [];
    try { idx = await db.collection(coll).listIndexes().toArray(); } catch (e) { line('   ' + coll + ' 读取索引失败: ' + e.message); continue; }
    const flat = idx.map(i => Object.keys(i.key).join('+'));
    for (const k of keys) {
      const want = k.map(x => x[0]).join('+');
      const hit = idx.find(i => Object.keys(i.key).join('+') === want && i.unique);
      flag(!hit, want + ' 唯一索引存在 ✓', want + ' 唯一索引**不存在** ← 该集合的并发防重目前只靠应用层判断');
    }
    if (flat.length) line('     \x1b[90m现有索引：' + flat.join('　') + '\x1b[0m');
  }

  // ───────────────────── F. 资金出口总览 ─────────────────────
  head('F. 资金出口（提现）最近 ' + SINCE_DAYS + ' 天');
  const wd = await db.collection('withdrawals').aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: '$status', n: { $sum: 1 }, sum: { $sum: '$amount' } } },
  ]).toArray();
  for (const w of wd) line('   ' + w._id + '　' + w.n + ' 笔　' + money(w.sum));
  const topRecv = await db.collection('withdrawals').aggregate([
    { $match: { status: '已打款', createdAt: { $gte: since } } },
    { $group: { _id: { u: '$userId', name: '$displayName', alipay: '$alipay.account' }, sum: { $sum: '$amount' }, n: { $sum: 1 } } },
    { $sort: { sum: -1 } }, { $limit: TOP_N },
  ]).toArray();
  line('   已打款 TOP ' + TOP_N + '（同名收款账号出现在多个 userId 上请重点核对）：');
  for (const t of topRecv) line('     ' + money(t.sum) + '　' + t.n + ' 笔　' + (t._id.name || '?') + '　alipay=' + (t._id.alipay ? String(t._id.alipay).slice(0, 4) + '***' : '?') + '　user=' + t._id.u);

  head('完成');
  line('本脚本全程只读（find/count/aggregate/listIndexes），未做任何写入或索引变更。');
} catch (e) {
  console.error('\n\x1b[31m排查失败：\x1b[0m' + (e && e.message || e));
  if (/serverSelection/i.test(String(e.message))) console.error('→ 连不上数据库。确认 MONGO_URI、IP 白名单（Atlas 要加你的出口 IP）、以及是否需要 ?retryWrites 之外的 tlsAllowInvalidCertificates。');
  process.exitCode = 1;
} finally {
  if (client) await client.close().catch(() => {});
}
