// lib/ratelimit.js — 极简内存限流（不引第三方依赖）
// 用途：登录防暴力破解、注册/咨询/AI 防刷。
// 注意：计数存在单个 Node 进程内存里；单机部署够用，多实例需换共享存储（Redis）。
const buckets = new Map();

// 定期清理过期桶，避免长跑内存膨胀
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
}, 60 * 1000);
if (sweeper.unref) sweeper.unref();

function ipOf(req) { return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown'; }

// 未登录接口（登录/注册）用的键：IP + 账号
// 【2026-09-26 修正】原来这里的注释写"同一人换个账号也受限"，但键是 name|ip|who 三段拼接 ——
// 换掉 who（而 username/phone 本来就是攻击者输入的）就等于换了一个桶，
// 单 IP 的实际可试次数是 max × 用户名数量，根本没有每 IP 总量闸。总量闸改由 hit() 里的 ip 桶负责。
function keyOf(req, name) {
  const who = String((req.body && (req.body.username || req.body.phone)) || '');
  return name + '|' + ipOf(req) + '|' + who;
}

/**
 * 计数并判断是否超限。已登录一律按 userId 分桶（不再需要每个调用点写 byUser:true），
 * 未登录按「IP+账号」+「纯 IP 总量」双桶：前者防针对单账号的撞库，后者防换用户名绕过。
 * @returns {null | { wait:number }}  null = 放行
 */
function hit(name, req, max, windowMs, ipMax) {
  const now = Date.now();
  const uid = req.user && req.user.id;
  const keys = [];
  if (uid) {
    keys.push(name + '|u:' + uid);
  } else {
    keys.push(keyOf(req, name));
    // 每 IP 的总量闸：比单账号阈值宽松得多（ipMax 默认 10 倍），
    // 只用来挡住"几百个用户名 × 每个 15 次"这种脚本，不会误伤正常 NAT 出口
    const who = String((req.body && (req.body.username || req.body.phone)) || '');
    if (who) keys.push(name + '|ip:' + ipOf(req));
  }
  let wait = 0;
  for (const k of keys) {
    let b = buckets.get(k);
    if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(k, b); }
    b.n += 1;
    const cap = k.indexOf('|ip:') > -1 ? (ipMax || max * 10) : max;
    if (b.n > cap) wait = Math.max(wait, Math.ceil((b.reset - now) / 1000));
  }
  if (wait > 0) return { wait: Math.max(1, wait) };
  req._limitKeys = keys;
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
  return (req, res, next) => {
    const over = hit(name, req, max, windowMs, ipMax);
    if (over) {
      res.setHeader('Retry-After', String(over.wait));
      return res.status(429).json({ ok: false, error: msg || `操作太频繁，请 ${over.wait} 秒后再试` });
    }
    next();
  };
}

/** 登录成功后调用，清掉这次尝试用到的所有桶（成功不该继续累计） */
export function limitPass(req) {
  if (!req || !Array.isArray(req._limitKeys)) return;
  for (const k of req._limitKeys) buckets.delete(k);
  req._limitKeys = null;
}

export const limitStats = () => buckets.size;
