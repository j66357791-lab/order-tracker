// lib/jobs.js — 定时任务的跨实例租约
// 【v26.74 · 多实例必修】生产是多实例部署（2026-09-27 运营确认），而 setInterval 在每个进程里
// 各跑一份：N 个实例 = 同一批数据每轮被结算 N 次。这里用一条带唯一 _id 的租约文档把
// "每轮只有一个实例真正执行" 钉死。不引入 Redis，不改部署形态。
import crypto from 'node:crypto';
// 有意不 import lib/db.js：本模块由挂载函数调用，取库连接一律用调用方经 ctx 传进来的 getDb。
// 这样 jobs.js 保持零依赖、可被任何模块安全持有，测试也能直接把假库注进来（原来它自己去连真 Mongo，
// 结果就是 getDb 抛错会冒出到调度器外面、把这一轮变成未处理拒绝）。

const JOB_COL = 'job_leases';

// 实例标识：优先用平台注入的实例名（Render 会有 65435665-instance-1 之类），否则随机 + pid。
// 除了写进租约文档便于排查"到底是谁在跑"，也用于回答"请求是否粘滞到同一实例"。
export const INSTANCE_ID = String(
  process.env.INSTANCE_ID || process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || ''
).trim() || (`n-${crypto.randomBytes(4).toString('hex')}-${process.pid}`);

/**
 * 抢占一轮执行权。
 * @param {string} job     任务名（就是租约文档的 _id）
 * @param {number} windowMs 租约窗口：这段时间内其它实例都抢不到
 * @param {Function} getDb  取库连接的方法（由调用方经 ctx 传入）
 * @returns {Promise<boolean>} true = 本轮由本实例执行；false = 跳过
 */
export async function claimLease(job, windowMs, getDb) {
  const db = await getDb();
  const now = new Date();
  const next = new Date(now.getTime() + Math.max(1000, windowMs | 0));
  const token = `${INSTANCE_ID}@${now.getTime()}`;
  // 用 updateOne + insertOne 两步，而不是 findOneAndUpdate+upsert：
  // 后者在"文档已存在但筛选不命中"时各版本/服务端行为不一致（有的抛 E11000、有的返回 null），
  // 一旦判错就是"所有实例都认为别人会跑、结果谁都没跑"，比重复执行更难发现。
  try {
    const r = await db.collection(JOB_COL).updateOne(
      { _id: job, nextRunAt: { $lte: now } },
      { $set: { nextRunAt: next, holder: token, claimedAt: now }, $inc: { runs: 1 } },
    );
    if (r.matchedCount === 1) return true;
  } catch (e) {
    console.error(`[job:${job}] 租约更新失败，本轮跳过：`, e.message);
    return false;
  }
  // 走到这里说明 matchedCount===0：要么文档还没建过，要么租约未到期（别的实例持有）。
  // 用 insert 撞唯一 _id 来区分这两种情况——插入成功 = 我是第一个；撞键 = 已有人持有。
  try {
    await db.collection(JOB_COL).insertOne({ _id: job, nextRunAt: next, holder: token, claimedAt: now, runs: 1 });
    return true;
  } catch (e) {
    if (e && (e.code === 11000 || /E11000|duplicate key/i.test(String(e.message)))) return false;
    console.error(`[job:${job}] 租约创建失败，本轮跳过：`, e.message);
    return false;
  }
}

/**
 * 注册一个"多实例下每轮只有一个实例执行"的周期任务。
 * 出错时一律选择跳过而不是硬跑：这些任务重复执行的代价（重复发钱）远高于漏一轮。
 * @param {string} job
 * @param {number} ms        周期，同时也是租约窗口
 * @param {Function} fn      实际工作（async）
 * @param {{firstDelayMs?: number}} o  firstDelayMs>0 时启动后延迟跑第一轮（错开冷启动）
 */
export function everyJob(job, ms, fn, o = {}) {
  if (typeof o.getDb !== 'function') throw new Error(`everyJob(${job}): 必须传入 getDb，否则租约无处可写`);
  const run = async () => {
    // 抢租约本身失败也要吞下来（例如 Mongo 抖一下）：宁可这一轮不跑，也不能让异常冒到调度器外面
    let won = false;
    try { won = await claimLease(job, ms, o.getDb); } catch (e) { console.error(`[job:${job}] 租约异常，本轮跳过:`, (e && e.message) || e); return; }
    if (!won) return;
    try { await fn(); } catch (e) { console.error(`[job:${job}]`, (e && e.message) || e); }
  };
  let boot = null;
  if (o.firstDelayMs) boot = setTimeout(run, o.firstDelayMs);
  const t = setInterval(run, ms);
  if (t.unref) t.unref();
  if (boot && boot.unref) boot.unref();
  return { runOnce: run, stop() { clearInterval(t); if (boot) clearTimeout(boot); } };
}

/** 供后台/诊断读取各任务当前的租约归属 */
export async function jobLeaseStatus(getDb) {
  const db = await getDb();
  const rows = await db.collection(JOB_COL).find({}).sort({ _id: 1 }).toArray().catch(() => []);
  const now = Date.now();
  return rows.map(r => ({
    job: r._id, runs: r.runs || 0, holder: r.holder || '',
    heldBy: String(r.holder || '').split('@')[0],
    nextRunAt: r.nextRunAt || null,
    due: !r.nextRunAt ? true : new Date(r.nextRunAt).getTime() <= now,
  }));
}
