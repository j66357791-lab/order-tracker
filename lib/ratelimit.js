// lib/ratelimit.js — MongoDB 共享限流（多实例安全 · 方案 A：不引入 Redis）
// 用途：登录防暴力破解、注册/咨询/AI 防刷、资金/活动接口频率闸。
// 【2026-09-27 审查修复 P2-6】计数原先存在单个 Node 进程内存里（文件头自注"多实例需换共享存储"）。
// 生产是多实例部署（config.js v26.74 确认）：N 个实例各记各的账，"15 次上限"实际可试 15×N 次；
// 同理内存态验证码在实例间对不上（注册随机失败的根因之一）。
// 现改为所有实例共写 MongoDB 的 rl_buckets 集合：
//   桶文档：{ _id: 桶键, n: 已用次数, winStart: 窗口起点, winMs: 窗口长, exp: 过期时间 }
//   原子性：条件更新一次完成"窗口过期则重置为 1，否则 n+1，超限不匹配"——抢不到即超限，
//           与 v26.74 灵脉结算的乐观锁、sh_locks 文档锁同一思想，不依赖任何单实例状态。
//   清理：  exp 上的 TTL 索引，Mongo 每分钟自动删除过期桶，无需进程内清扫器。
// 代价：  挂了 limit 的敏感接口每次多 1 次库端读写（普通请求零开销）。
// 故障策略：数据库异常时【放行】并每分钟留痕一次（fail-open）——库都不可用时登录/资金接口本身
//           也无法工作，不能让限流器在故障期把全站误杀成 429。
import { getDb } from './db.js';

const COL = 'rl_buckets';
let indexReady = false;
async function col() {
  const c = (await getDb()).collection(COL);
  if (!indexReady) {
    indexReady = true;   // createIndex 幂等，并发下重复执行无害
    await c.createIndex({ exp: 1 }, { expireAfterSeconds: 0 }).catch(() => { });
  }
  return c;
}

function ipOf(req) { return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown'; }

// 未登录接口（登录/注册）用的键：IP + 账号
// 【2026-09-26 修正】键是 name|ip|who 三段拼接——换掉 who（username/phone 是攻击者输入的）
// 等于换了一个桶，所以单 IP 的总量闸由 hit() 里单独的 ip 桶负责。
function keyOf(req, name) {
  const who = String((req.body && (req.body.username || req.body.phone)) || '');
  return name + '|' + ipOf(req) + '|' + who;
}

// 单桶原子自增：返回 true=放行（计数已+1），false=超限。
// 用聚合管道更新把"窗口是否过期"的分支塞进同一次原子操作：
//   过期  → n 重置为 1、winStart 换成当前时刻
//   未过期 → n+1、winStart 不变
// 过滤条件 [窗口过期 或 n<cap] 不满足 = 本窗口已用满 → 不匹配即超限。
async function bump(key, cap, windowMs) {
  const now = Date.now();
  const cut = new Date(now);
  const c = await col();
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await c.updateOne(
      { _id: key, $or: [{ winStart: { $lte: cut } }, { n: { $lt: cap } }] },
      [{ $set: {
        n: { $cond: [{ $lt: [{ $ifNull: ['$winStart', 0] }, cut] }, 1, { $add: [{ $ifNull: ['$n', 0] }, 1] }] },
        winStart: { $cond: [{ $lt: [{ $ifNull: ['$winStart', 0] }, cut] }, new Date(now), '$winStart'] },
        winMs: windowMs,
        exp: new Date(now + windowMs + 60000),   // 窗口结束 +1 分钟，TTL 到点自动删除
      } }],
      { upsert: true }
    ).catch(e => {
      if (e && e.code === 11000) return null;   // 两实例同时首次创建同一桶：文档已存在，重试一次
      throw e;
    });
    if (r === null) continue;
    return (r.upsertedCount || 0) + (r.modifiedCount || 0) > 0;
  }
  return false;
}

/**
 * 计数并判断是否超限。已登录一律按 userId 分桶，未登录按「IP+账号」+「纯 IP 总量」双桶。
 * @returns {null | { wait:number }}  null = 放行
 */
async function hit(name, req, max, windowMs, ipMax) {
  const uid = req.user && req.user.id;
  const keys = [];
  if (uid) {
    keys.push({ k: name + '|u:' + uid, cap: max });
  } else {
    keys.push({ k: keyOf(req, name), cap: max });
    // 每 IP 的总量闸：比单账号阈值宽松得多（ipMax 默认 10 倍），
    // 只用来挡住"几百个用户名 × 每个 15 次"这种脚本，不会误伤正常 NAT 出口
    const who = String((req.body && (req.body.username || req.body.phone)) || '');
    if (who) keys.push({ k: name + '|ip:' + ipOf(req), cap: ipMax || max * 10 });
  }
  // 与旧实现一致：所有相关桶都参与计数（即使别的桶已经超限）
  const blocked = (await Promise.all(keys.map(({ k, cap }) => bump(k, cap, windowMs).then(ok => ok ? null : k))))
    .filter(Boolean);
  if (blocked.length) {
    // 读被挡桶的窗口起点算剩余等待（只在超限路径发生，量极小）
    let wait = Math.ceil(windowMs / 1000);
    try {
      const docs = await (await col()).find({ _id: { $in: blocked } }).toArray();
      const now = Date.now();
      for (const d of docs) {
        const end = (d.winStart && d.winStart.getTime ? d.winStart.getTime() : now) + (d.winMs || windowMs);
        wait = Math.max(wait, Math.ceil((end - now) / 1000));
      }
    } catch (e) { }
    return { wait: Math.max(1, wait) };
  }
  req._limitKeys = keys.map(x => x.k);
  return null;
}

/**
 * @param {object} o
 * @param {string} o.name      桶名（区分不同接口）
 * @param {number} o.max       窗口内允许次数（已登录时即"每用户"次数）
 * @param {number} o.windowMs  窗口长度（毫秒）
 * @param {string} o.msg       触发时返回的提示
 * @param {boolean} o.byUser   【已废弃】登录态下本来就按用户分桶；保留参数只为兼容旧调用
 * @param {number} o.ipMax     未登录接口的每 IP 总量闸（默认 max*10）
 */
export function limit(o = {}) {
  const { name = 'default', max = 20, windowMs = 60 * 1000, msg = '', ipMax } = o;
  let lastWarn = 0;
  return async (req, res, next) => {
    let over = null;
    try {
      over = await hit(name, req, max, windowMs, ipMax);
    } catch (e) {
      // fail-open：库异常放行，一分钟最多报一次错避免刷屏
      if (Date.now() - lastWarn > 60000) {
        lastWarn = Date.now();
        console.error('[ratelimit] 共享计数异常，本次放行:', (e && e.message) || e);
      }
      return next();
    }
    if (over) {
      res.setHeader('Retry-After', String(over.wait));
      return res.status(429).json({ ok: false, error: msg || `操作太频繁，请 ${over.wait} 秒后再试` });
    }
    next();
  };
}

/** 登录成功后调用，清掉这次尝试用到的所有桶（成功不该继续累计）。异步删除，不阻塞响应 */
export async function limitPass(req) {
  if (!req || !Array.isArray(req._limitKeys)) return;
  const keys = req._limitKeys;
  req._limitKeys = null;
  try { await (await col()).deleteMany({ _id: { $in: keys } }); } catch (e) { }
}

// 【兼容】原先返回进程内桶数；现返回共享集合里的桶总数（未被调用，仅为签名兼容保留）
export async function limitStats() {
  try { return await (await col()).countDocuments(); } catch (e) { return -1; }
}
