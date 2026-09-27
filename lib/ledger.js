// lib/ledger.js — 钱包账本的唯一写入口（幂等入账）
//
// 为什么要单独收这一层（2026-09-26 批次 2）：
// 全站"余额"没有字段，就是 wallet_log 按 userId 求和。所以任何一次重复 insertOne = 凭空多钱，
// 任何一次 insertOne 失败 = 少钱且无法补。而历史上充值/签到/月度/红包/福袋/交易所提现
// 六处各自手写 insertOne，全仓库没有用过一次 Mongo 事务，也没有任何幂等键
// —— 只有 LV1 激励那一处靠 (userId,month,kind) partial 唯一索引做了防重，其它全是裸写。
//
// 现在统一走这里：写入时带上 (kind, refId) 业务幂等键，撞唯一索引就当"已经入过账"静默跳过，
// 不报错、不重复发钱。这样上层可以放心重试，管理员双击、网络重放、进程中途被杀之后重跑，
// 都不会造成二次入账。refId 缺失时退化为"无幂等"并打警告（历史调用点迁移期用）。
import { cnMonthStr } from './core.js';

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/**
 * 写一条账本流水。
 * @returns {Promise<'ok'|'dup'>} dup = 该 refId 已入过账，本次按幂等跳过
 * @throws 其它数据库错误照抛（调用方需自行决定补偿）
 */
export async function addLedgerEntry(db, { userId, kind, refId, amount, note, extra }, opts = {}) {
  const amt = round2(amount);
  if (!Number.isFinite(amt) || amt === 0) {
    // 0 或 NaN 的流水会污染余额求和，且没有任何审计意义 —— 直接拒绝，让调用方看到问题
    throw new Error('账本流水金额非法：' + amount + '（kind=' + kind + ', refId=' + refId + '）');
  }
  if (refId == null || refId === '') {
    // allowNoRef：调用方明确声明"这次写入没有天然幂等键"（例如背包计数是累加器、
    // 拆一袋生成不出一条可复现的业务单号），此时防重靠"先原子扣道具、失败再退回"保证，
    // 就不再每次刷警告。除此之外缺 refId 一律告警，避免无声地丢掉防重。
    if (!opts.allowNoRef) console.warn('[账本] 缺少 refId 幂等键，本次写入不受防重保护 kind=' + kind + ' user=' + userId);
  }
  const doc = Object.assign({}, extra || {}, {
    userId,
    month: cnMonthStr(new Date()),
    kind,
    refId: refId == null ? undefined : String(refId),
    amount: amt,
    note: note || '',
    createdAt: new Date(),
  });
  if (doc.refId === undefined) delete doc.refId;
  try {
    await db.collection('wallet_log').insertOne(doc);
    return 'ok';
  } catch (e) {
    // 11000 有两种来源：① (kind,refId) 幂等键 —— 预期内，静默跳过；
    // ② (userId,month,kind='lv1_bonus') 那条 partial 唯一索引 —— 同样是"本月已发过"，也跳过
    if (e && e.code === 11000) {
      console.log('[账本] 幂等命中，跳过重复入账 kind=' + kind + ' refId=' + refId + ' user=' + userId);
      return 'dup';
    }
    throw e;
  }
}

/** 某个 refId 是否已经入过账（用于"补入账"判断与驳回扣回金额核算） */
export async function ledgerHasRef(db, kind, refId) {
  if (refId == null || refId === '') return false;
  const hit = await db.collection('wallet_log').findOne({ kind, refId: String(refId) }, { projection: { _id: 1 } });
  return !!hit;
}

/** 某个 refId 实际入账净额（驳回/冲正必须以真实流水为准，不能拿单据金额取反） */
export async function ledgerSumOfRef(db, kind, refId) {
  if (refId == null || refId === '') return 0;
  const rows = await db.collection('wallet_log').find({ kind, refId: String(refId) }, { projection: { amount: 1 } }).toArray();
  return round2(rows.reduce((s, r) => s + (typeof r.amount === 'number' && Number.isFinite(r.amount) ? r.amount : 0), 0));
}
