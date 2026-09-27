// lib/db.js — Mongo 连接与索引初始化
import { MongoClient, ObjectId } from 'mongodb';
import { CONFIG } from '../config.js';

let indexReady = false;   // 仅本模块内部使用（外部要读索引健康状态请用 indexGuardOk/indexGuardReport）
let dbPromise = null;
let indexJob = null;

// ==================== 资金级唯一索引的健康状态 ====================
// 背景（2026-09-26 批次 2 修复）：这里的索引原先全部是 fire-and-forget —— createIndexes().catch(warn)，
// 而且 indexReady 在建索引**之前**就置真，所以一旦某条唯一索引因为历史脏数据建不起来，
// 只会在启动日志里留一行 warn，之后永不重试。而代码里大量"并发防重"是靠捕获 11000 实现的：
// 索引不存在 → 11000 永远不抛 → 那些 catch 分支全是死代码，看起来有防护、实际没有。
// 现在：关键唯一索引改为启动期 await 真实校验，结果记录在 indexGuard；
// 任一条没成立，充值机器自动到账就会被硬关（见 indexGuardOk 的调用方），全部走人工审核。
export const indexGuard = { ok: true, checkedAt: 0, failures: [] };
/**
 * 某个能力所依赖的唯一索引是否全部就位。
 * 按能力分别设闸，而不是"任何一条索引没建成就停用全站自动放款" ——
 * 签到缺索引不该连累充值通道（反应过度会让人懒得修）。
 * 未确认过（checkedAt=0）时一律返回 false：失败即关闭，绝不默认放行。
 */
export function indexGuardOk(cap = 'autoPay') {
  if (!indexGuard.checkedAt) return false;
  return !indexGuard.failures.some(f => (f.gates || []).includes(cap));
}
export const indexGuardReport = () => ({
  ok: indexGuard.failures.length === 0, checkedAt: indexGuard.checkedAt, failures: indexGuard.failures.slice(),
});

const CRITICAL_UNIQUE = [
  {
    coll: 'wallet_log', name: 'wallet_log.kind_refId.unique', gates: ['autoPay', 'payout'],
    idx: [{
      key: { kind: 1, refId: 1 }, unique: true, name: 'kind_refId_unique',
      // 只约束带 refId 的新流水，历史无 refId 的流水不受影响（否则存量数据会直接建不起来）
      partialFilterExpression: { refId: { $type: 'string' } },
    }],
    why: '账本幂等键：同一笔业务（同一个单号/卡号）最多入账一次。缺了它，重复点击与重试可凭空造余额',
  },
  {
    coll: 'recharge_orders', name: 'recharge_orders.shotHash.unique', gates: ['autoPay'],
    idx: [{ key: { shotHash: 1 }, unique: true, name: 'shotHash_unique' }],
    why: '一张转账凭证全站只能用一次。缺了它，同一张真截图可被多个账号各自机器秒到账',
  },
  {
    coll: 'redpacket_records', name: 'redpacket_records.user_card.unique', gates: ['payout'],
    idx: [{ key: { userId: 1, cardId: 1 }, unique: true, name: 'userId_cardId_unique' }],
    why: '一个订单终身只拆一次红包。缺了它，并发拆包可重复发放奖励',
  },
  {
    coll: 'withdrawals', name: 'withdrawals.pending.unique', gates: ['payout'],
    idx: [{
      key: { userId: 1, status: 1 }, unique: true, name: 'userId_status_pending_unique',
      partialFilterExpression: { status: '待处理' },
    }],
    why: '一个用户同时只能有一笔待处理提现。缺了它，并发提交会产生多笔全额申请',
  },
  {
    coll: 'checkin_records', name: 'checkin_records.user_date.unique', gates: ['payout'],
    idx: [{ key: { userId: 1, date: 1 }, unique: true, name: 'userId_date_unique' }],
    why: '每天只能签到领一次钱',
  },
  {
    coll: 'monthly_claims', name: 'monthly_claims.user_month.unique', gates: ['payout'],
    idx: [{ key: { userId: 1, month: 1 }, unique: true, name: 'userId_month_unique' }],
    why: '月度活动奖励每月只能领一次',
  },
];

async function getDb() {
  if (!dbPromise) {
    // 【2026-09-17 修复】连接失败时把 dbPromise 置回 null——
    // 原实现会把失败的 Promise 永久缓存，之后所有请求永远 500，只能重启进程恢复
    // 【2026-09-24 性能优化】连接池参数：
    //   maxPoolSize 20 —— 默认 100 偏大（Render 免费实例内存有限，每连接约 1MB 栈），
    //                    20 对单实例业务绰绰有余且省内存；
    //   minPoolSize 2  —— 预热保底连接，避免冷启动/突发流量时现建连接的高延迟；
    //   maxIdleTimeMS  —— 空闲连接 60s 回收，防代理/防火墙掐掉长连接后拿到死连接；
    //   compressors    —— 与 Atlas/MongoDB 4.2+ 协商 zlib 压缩，大结果集传输提速明显。
    dbPromise = new MongoClient(CONFIG.mongoUri, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 10000,
      maxPoolSize: Number(process.env.MONGO_MAX_POOL || 20),
      minPoolSize: 2,
      maxIdleTimeMS: 60 * 1000,
      compressors: ['zlib'],
    })
      .connect()
      .then((c) => c.db(CONFIG.dbName))
      .catch((e) => { dbPromise = null; throw e; });
  }
  const db = await dbPromise;
  // 【2026-09-26 批次2】建索引改成：首个请求触发、await 真实结果、并发共享同一个 job；
  // 关键唯一索引没全部成立时每 5 分钟随后续请求重试一次（历史脏数据被清洗后无需重启即可恢复）
  if (!indexReady || (!indexGuard.ok && Date.now() - indexGuard.checkedAt > 5 * 60 * 1000)) {
    if (!indexJob) indexJob = buildIndexes(db).finally(() => { indexJob = null; });
    await indexJob;
    indexReady = true;
  }
  return db;
}

// 只影响查询速度、不影响资金正确性的索引 —— 保持并发、失败只 warn，不拖慢请求
const BEST_EFFORT_INDEXES = [
  // 台账：按日期查/排序、按状态筛、按完单日查、按编号搜索，各走各的索引
  { coll: () => CONFIG.collection, idx: [{ key: { date: -1 } }, { key: { status: 1 } }, { key: { doneDate: 1 } }, { key: { orderNo: 1 } }, { key: { date: -1, _id: -1 } }] },
  { coll: () => 'invites', idx: [{ key: { code: 1 }, unique: true }] },
  {
    coll: () => 'users', idx: [{ key: { username: 1 }, unique: true },
      // 工号唯一（partial：只约束已有工号的文档）—— 防并发注册发到同一个号
      { key: { uid: 1 }, unique: true, partialFilterExpression: { uid: { $gt: null } } },
      // 一个身份证只能绑定一个账号（partial：只约束已实名的文档）
      { key: { 'realname.idHash': 1 }, unique: true, partialFilterExpression: { 'realname.idHash': { $gt: null } } }],
  },
  {
    coll: () => 'messages', idx: [{ key: { conversation: 1, createdAt: -1 } },
      // 聊天信息云端只保留3天，到期自动删除（客户端本地localStorage兜底留存）
      { key: { createdAt: 1 }, expireAfterSeconds: 3 * 24 * 3600 }],
  },
  { coll: () => 'cards', idx: [{ key: { to: 1, createdAt: -1 } }, { key: { orderId: 1 } }, { key: { createdAt: -1 } }, { key: { to: 1, status: 1 } }] },
  // 【2026-09-17 补充】LV1 月度奖励一个用户一月只发一次（partial：只约束带 kind 标记的新记录）
  { coll: () => 'wallet_log', idx: [{ key: { userId: 1, month: 1 }, unique: true, partialFilterExpression: { kind: 'lv1_bonus' } }] },
  // config.key 唯一索引：/api/setup 的初始化锁靠 upsert 占位，无唯一索引时并发可产生第二个管理员账号
  { coll: () => 'config', idx: [{ key: { key: 1 }, unique: true }] },
  { coll: () => 'recharge_orders', idx: [{ key: { userId: 1, shotHash: 1 }, unique: true }, { key: { orderNo: 1 } }, { key: { status: 1, autoDay: 1 } }, { key: { userId: 1, createdAt: -1 } }] },
  // 【2026-09-24 性能优化】wallet_log 是全站余额账本：充值/提现/转交易所/交易所页全在按 userId 拉流水求和，
  // 没有索引就是每次 COLLSCAN，流水涨到几万条后每个请求都是慢查询
  { coll: () => 'wallet_log', idx: [{ key: { userId: 1, createdAt: -1 } }, { key: { userId: 1, kind: 1 } }] },
  // 游戏模块高频集合
  { coll: () => 'game_sessions', idx: [{ key: { userId: 1, status: 1 } }, { key: { endedAt: 1 } }] },
  { coll: () => 'game_profiles', idx: [{ key: { userId: 1 }, unique: true }] },
  { coll: () => 'shanhai_profiles', idx: [{ key: { userId: 1 }, unique: true }] },
  // 【2026-09-26 批次2 补】交易所钱包此前没有任何索引：
  //   ① exWalletOf 的注释假设"两个请求同时 upsert 会抛 E11000"，但没建唯一索引它根本不会抛，
  //      并发下真的会插入两条同 userId 的钱包 → 余额从此分裂、账对不上；
  //   ② 交易所每个接口都按 {userId} 找/改，全是全表扫描。
  { coll: () => 'shanhai_ex_wallet', idx: [{ key: { userId: 1 }, unique: true }] },
  {
    coll: () => 'shanhai_exchange', idx: [
      // 行情列表：按方向+状态+价格排序取前 50
      { key: { side: 1, status: 1, price: 1, createdAt: 1 } }, { key: { userId: 1, status: 1, createdAt: -1 } }],
  },
  { coll: () => 'shanhai_ex_deals', idx: [{ key: { createdAt: -1 } }, { key: { buyerId: 1, createdAt: -1 } }, { key: { sellerId: 1, createdAt: -1 } }, { key: { orderId: 1 } }] },
  { coll: () => 'shanhai_logs', idx: [{ key: { createdAt: -1 } }, { key: { userId: 1, createdAt: -1 } }] },
  // 【v26.67 批次3】开局票据：结算按 _id 查一次；过期票据靠 TTL 自动清，
  // 不然每局一条会一直堆（正常玩家一天十几局，一年就是几万条死数据）
  { coll: () => 'shanhai_runs', idx: [{ key: { userId: 1, used: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }] },
  { coll: () => 'checkin_records', idx: [{ key: { userId: 1, date: -1 } }] },
  { coll: () => 'schedules', idx: [{ key: { userId: 1 } }] },
  { coll: () => 'schedule_days', idx: [{ key: { userId: 1, date: 1 } }] },
  // 考勤：一人一天一条（此前无唯一索引，双击打卡产生两条同日记录、重放 clockin 还会覆盖已签退）
  { coll: () => 'attendance', idx: [{ key: { userId: 1, createdAt: -1 } }, { key: { userId: 1, date: 1 }, unique: true }] },
  { coll: () => 'redpacket_records', idx: [{ key: { userId: 1 } }] },
  // 【2026-09-26 批次2 补】此前完全没建索引的高频查询集合
  { coll: () => 'announcements', idx: [{ key: { targets: 1, createdAt: -1 } }] },
  { coll: () => 'withdrawals', idx: [{ key: { userId: 1, createdAt: -1 } }, { key: { status: 1, createdAt: -1 } }] },
  { coll: () => 'friend_requests', idx: [{ key: { to: 1, status: 1 } }, { key: { from: 1, status: 1 } }] },
];

async function hasEquivalentIndex(db, coll, keySpec, partial) {
  // 集合上是否已经有"同键 + 唯一"的索引（名字可能不同）。
  // 带 partialFilterExpression 的还要核对过滤条件 —— 否则一个"全量唯一"的旧索引
  // 会被当成等效，而它约束的范围其实完全不同。
  try {
    const want = Object.keys(keySpec).join('+');
    const wantPartial = partial ? JSON.stringify(partial) : null;
    const list = await db.collection(coll).listIndexes().toArray();
    return list.some(i => {
      if (!i.unique || Object.keys(i.key).join('+') !== want) return false;
      if (wantPartial === null) return true;
      return i.partialFilterExpression && JSON.stringify(i.partialFilterExpression) === wantPartial;
    });
  } catch (e) { return false; }
}

async function buildIndexes(db) {
  indexGuard.checkedAt = Date.now();
  // 1) 关键唯一索引：串行 await，真实确认每一条都建起来了（或已存在）
  const failures = [];
  for (const spec of CRITICAL_UNIQUE) {
    try {
      await db.collection(spec.coll).createIndexes(spec.idx);
    } catch (e) {
      // 线上库很可能已经有一个"同键不同名"的唯一索引（历史上没写 name，Mongo 自动命名）。
      // 这种情况 createIndexes 会抛 85/86 冲突错，但**约束其实是在的** ——
      // 若把它当失败处理，就会莫名其妙停用自动到账。所以先核对索引列表再决定。
      const conflict = e && (e.code === 85 || e.code === 86 || /already exists/i.test(String(e.message)));
      if (conflict && await hasEquivalentIndex(db, spec.coll, spec.idx[0].key, spec.idx[0].partialFilterExpression)) {
        console.log('[db] 关键唯一索引已存在（同名不同键冲突，按等效处理）：' + spec.name);
        continue;
      }
      failures.push({ name: spec.name, coll: spec.coll, gates: spec.gates || [], reason: String((e && e.message) || e).slice(0, 200) });
      console.error('[db] ✗ 关键唯一索引创建失败：' + spec.name + '\n     作用：' + spec.why
        + '\n     原因：' + (e && e.message || e) + '\n     → 该防重目前只剩应用层判断，受影响能力：' + (spec.gates || []).join('/') + '（对应通道已停用）');
    }
  }
  // 2) 二次确认：createIndexes 对"同名但键不同"的旧索引不一定报错，直接核对实际索引列表
  for (const spec of CRITICAL_UNIQUE) {
    if (failures.some(f => f.name === spec.name)) continue;
    try {
      const ok = await hasEquivalentIndex(db, spec.coll, spec.idx[0].key, spec.idx[0].partialFilterExpression);
      if (!ok) failures.push({ name: spec.name, coll: spec.coll, gates: spec.gates || [], reason: '索引列表中未找到该唯一索引（可能被同名不同键的旧索引占用）' });
    } catch (e) { /* 读不到索引列表（权限/版本较低）时不追加判失败，上面 createIndexes 的结论已足够 */ }
  }
  indexGuard.failures = failures;
  indexGuard.ok = failures.length === 0;
  if (indexGuard.ok) {
    console.log('[db] 关键唯一索引全部就位 ✓（' + CRITICAL_UNIQUE.length + ' 条，含账本幂等键 wallet_log(kind,refId)）');
  } else {
    const caps = [...new Set(failures.flatMap(f => f.gates || []))];
    console.error('[db] ⚠ 关键唯一索引缺失 ' + failures.length + ' 条：' + failures.map(f => f.name).join('、'));
    if (caps.includes('autoPay')) {
      console.error('[db]   → 自动到账（机器直接入账）已停用，所有充值单转人工审核');
    }
    if (caps.includes('payout')) {
      console.error('[db]   → 涉及签到/红包/月度/提现的防重缺口，相关入账建议改走人工复核后再放量');
    }
    console.error('[db]   清洗历史重复数据后 5 分钟内会自动重试恢复，无需重启进程');
  }
  // 3) 其余索引：不阻塞、不判失败
  for (const spec of BEST_EFFORT_INDEXES) {
    db.collection(spec.coll()).createIndexes(spec.idx)
      .catch((e) => console.warn('[db] 建索引失败(' + spec.coll() + ')', e?.message || e));
  }
}

export { getDb };
