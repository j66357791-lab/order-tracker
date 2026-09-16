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

function keyOf(req, name) {
  // 优先按「IP + 账号」分桶：同一人换个账号也受限，同一账号被人肉撞库也受限
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const who = String((req.body && (req.body.username || req.body.phone)) || '');
  return name + '|' + ip + '|' + who;
}

/**
 * @param {object} o
 * @param {string} o.name      桶名（区分不同接口）
 * @param {number} o.max       窗口内允许次数
 * @param {number} o.windowMs  窗口长度（毫秒）
 * @param {string} o.msg       触发时返回的提示
 * @param {boolean} o.byUser   已登录接口按 userId 分桶（配合 auth 之后挂载）
 */
export function limit(o = {}) {
  const { name = 'default', max = 20, windowMs = 60 * 1000, msg = '', byUser = false } = o;
  return (req, res, next) => {
    const key = byUser
      ? name + '|u:' + (req.user?.id || req.ip || 'unknown')
      : keyOf(req, name);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.n += 1;
    if (b.n > max) {
      const wait = Math.max(1, Math.ceil((b.reset - now) / 1000));
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ ok: false, error: msg || `操作太频繁，请 ${wait} 秒后再试` });
    }
    req._limitKey = key;
    next();
  };
}

/** 登录成功后调用，清掉该次尝试的计数（成功不该继续累计） */
export function limitPass(req) {
  if (req && req._limitKey) buckets.delete(req._limitKey);
}

export const limitStats = () => buckets.size;
