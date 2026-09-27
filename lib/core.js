// lib/core.js — 公共工具：JWT鉴权/通知/验证码/时间/缓存
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { getDb } from './db.js';

// 【2026-09-17 安全加固 P0】JWT 密钥不再使用硬编码兜底值。
// 旧值写在源码里 = 公开密钥，任何人拿到源码就能伪造 admin token 接管后台。
// 规则：优先用环境变量 / .env；没配则随机生成（重启后需重新登录，但无法被伪造）。
const INSECURE_DEFAULTS = [
  'jdy-jwt-secret-2026-fallback',
  // 【2026-09-26】.env.example 里的那句占位文案：直接 cp .env.example .env 而不改值的话，
  // 全站就在用一个「源码里公开可查」的签名密钥 —— 任何人都能伪造 admin token 接管后台。
  '请换成一串你自己生成的32位以上随机字符',
];
function resolveJwtSecret() {
  const s = String(process.env.JWT_SECRET || '').trim();
  if (INSECURE_DEFAULTS.includes(s)) {
    console.error('[安全] JWT_SECRET 用了源码里的示例值，已忽略，改用随机密钥；请尽快换成自己的随机串。');
    return { secret: crypto.randomBytes(32).toString('hex'), fromEnv: false };
  }
  if (s.length >= 32) return { secret: s, fromEnv: true };
  if (s.length >= 16) {
    // 不拒绝（否则线上正在用的 16~31 位密钥会突然换成随机 → 全员被踢下线），但必须说清风险：
    // HS256 的密钥长度直接决定离线爆破成本，16~31 位的口令级密钥可被 hashcat 打穿后伪造 admin token
    console.warn('[安全] JWT_SECRET 只有 ' + s.length + ' 位（建议 32 位以上随机串）。'
      + '本次仍按配置使用，但请尽快更换为更长的随机串（更换后所有人需重新登录）。');
    return { secret: s, fromEnv: true };
  }
  // 【2026-09-26 修正】原这里 warn 说"本次按配置使用"，实际下一行走的是随机密钥 ——
  // 运维照这条日志判断"重启后 token 仍有效"，结果是反的。文案与行为已对齐。
  const gen = crypto.randomBytes(32).toString('hex');
  const suggestion = crypto.randomBytes(32).toString('hex');
  console.error('============================================================');
  console.error('[安全] JWT_SECRET 未配置或长度不足 16 位，本次启动改用随机密钥（配置的值为 ' + s.length + ' 位，未被使用）。');
  console.error('       影响：服务重启后所有用户需要重新登录。');
  console.error('       解决：在项目根目录建 .env，写入一行（下面给你一个现成的随机串）：');
  // 【2026-09-26】原先打印的是"本次实际使用的密钥"的前 16 位 —— 那是把密钥写进了日志。
  // 现在打印一个独立的建议值，与实际使用的随机密钥无关。
  console.error('       JWT_SECRET=' + suggestion);
  console.error('============================================================');
  return { secret: gen, fromEnv: false };
}
const _jwt = resolveJwtSecret();
export const JWT_SECRET = _jwt.secret;
export const JWT_FROM_ENV = _jwt.fromEnv;
export const qCache = new Map();
const CACHE_TTL = 60 * 1000;
export const cacheGet = (key) => { const e = qCache.get(key); if (e && Date.now() - e.t < CACHE_TTL) return e.v; qCache.delete(key); return undefined; };
export const cacheSet = (key, val) => qCache.set(key, { v: val, t: Date.now() });
export const cacheClear = () => qCache.clear();
// 【2026-09-26 批次2】按前缀失效。原先任何一张派单卡审核/打款都调用全量 cacheClear()，
// 把台账所有筛选组合的缓存一把清空（雪崩）；调用方本意只是"订单变了"，
// 现在写订单的 paths 用 cacheClearPrefix('orders:')，跨模块的大改动仍可保留全清。
export const cacheClearPrefix = (prefix) => { for (const k of qCache.keys()) if (k.startsWith(prefix)) qCache.delete(k); };

export function signToken(u) {
  return jwt.sign({ id: u._id.toString(), role: u.role }, JWT_SECRET, { expiresIn: '30d' });
}
// 【2026-09-17 安全加固】用户信息分档（默认安全）：
//   publicUser —— 只含可在第三方场景公示的字段，**不含** alipay / realname
//   selfUser   —— 本人或管理员场景，额外带上收款信息与实名信息
// 以前只有一个 publicUser 且带 alipay，只要哪处接口忘了 .project() 就会批量泄露写手收款账号。
export function publicUser(u) {
  return { id: u._id.toString(), uid: u.uid || null, username: u.username, role: u.role,
           displayName: u.displayName, shift: !!u.shift, sockOnline: !!u.sockOnline,
           level: u.level || 0 };
}
export function selfUser(u) {
  return { ...publicUser(u),
           alipay: u.alipay || null,
           realname: u.realname ? { name: u.realname.name, idMask: u.realname.idMask, verifiedAt: u.realname.verifiedAt } : null };
}


// —— 北京时间工具 ——
export const cnNow = () => new Date(Date.now() + 8 * 3600 * 1000);
export const cnDateStr = d => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');

export const cnDayStr = (d) => cnDateStr(new Date(new Date(d).getTime() + 8 * 3600 * 1000));
export const cnMonthStr = (d) => cnDayStr(d).slice(0, 7);
export const ymOf = (d) => cnDateStr(d).slice(0, 7);
export const cnTimeStr = (d) => String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
export const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

// —— 验证码（算术码，内存5分钟） ——
export const captchaStore = new Map();
// 【2026-09-17 修复】定期清扫过期验证码——原来只在验证时删除条目，
// 生成了但从未提交的验证码会永久驻留内存，可被恶意脚本刷爆
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of captchaStore) if (v.exp < now) captchaStore.delete(k);
}, 60 * 1000).unref();
export const rnd = (n) => Math.floor(Math.random() * n);
export function verifyCaptcha(req) {
  const { captchaId, captchaAnswer } = req.body || {};
  const rec = captchaStore.get(String(captchaId || ''));
  captchaStore.delete(String(captchaId || ''));
  if (!rec || rec.exp < Date.now()) return '验证码已过期，请刷新重试';
  if (parseInt(captchaAnswer, 10) !== rec.ans) return '验证码答案不对';
  return null;
}

// ---------- 合同（兼职写手合作签约协议） ----------


// —— 工具 ——
export const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// 【v26.70】昵称清洗。displayName 原来只截 20 字、不做任何字符过滤，而它会被拼进
// 游戏排行榜、后台多个模块、聊天与充值记录的 innerHTML —— 只要有一个渲染点漏了转义，
// 就是一条存储型 XSS，而 20 字足够写下 <svg onload=eval(1)> 这种刚好能执行的有效载荷。
// 渲染端转义是正解（本次已补），这里是第二道闸：让脏数据根本进不了库，
// 保护的是以后新写的、还没来得及转义的渲染点。尖括号/换行去掉，连续空白并一格，不限制中文与常规符号。
export function cleanNick(v, max = 20) {
  const raw = String(v == null ? '' : v);
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) { out += ' '; continue; }  // 制表/换行折成空格，别把两个字并成一个
    if (c < 32 || c === 127) continue;          // 其余控制字符一律丢弃
    if (ch === '<' || ch === '>') continue;     // 尖括号：HTML 注入的入口
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanReplyTo(rt) {
  if (!rt || typeof rt !== 'object') return null;
  const id = String(rt.id || '').slice(0, 40);
  if (!id) return null;
  return { id, fromName: String(rt.fromName || '').slice(0, 40), preview: String(rt.preview || '').slice(0, 80), type: String(rt.type || 'text') };
}
// 7位数工号ID：从1000001起自增
export async function nextUid(db) {
  // 【2026-09-17 优化】改为取最大 uid 一条（uid 是 7 位定长字符串，字典序=数字序），
  // 原实现把全部用户的 uid 拉进内存求 max，注册时全表扫描，用户量上来后越来越慢
  const top = await db.collection('users')
    .find({ uid: { $exists: true, $ne: null } })
    .sort({ uid: -1 }).limit(1).project({ uid: 1 }).toArray();
  const max = top.length ? (parseInt(top[0].uid, 10) || 1000000) : 1000000;
  return String(max + 1);
}
export async function assignUid(db, userId) {
  for (let i = 0; i < 5; i++) {   // 并发兜底：重试拿号
    const uid = await nextUid(db);
    try {
      const ok = await db.collection('users').updateOne({ _id: userId, uid: { $exists: false } }, { $set: { uid } });
      if (ok.modifiedCount) return uid;
    } catch (e) {
      // 【二次复核补充】users.uid 唯一索引建好后，并发取到同一最大 uid 会撞 11000，重试即可
      if (e && e.code === 11000) continue;
      throw e;
    }
  }
  return null;
}
export const pairKey = (a, b) => [String(a), String(b)].sort().join(':');

export async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  let token = h.startsWith('Bearer ') ? h.slice(7) : null;
  // 【2026-09-27 审查修复 P2-12】HttpOnly Cookie 作为第 2 顺位令牌来源：
  // 文件预览/下载的 <img>/<a> 标签带不了 Authorization 头，原先只能把 JWT 拼进查询串
  // （泄漏进浏览器历史与服务端访问日志）。Cookie 由浏览器自动携带、JS 读不到。
  // 前端通过 POST /api/auth/cookie 签发（见 authx.js），登出时 DELETE 清除。
  if (!token && req.headers.cookie) {
    const m = /(?:^|;\s*)jdy_token=([^;]+)/.exec(req.headers.cookie);
    if (m) token = decodeURIComponent(m[1]);
  }
  // 【2026-09-17 安全加固】?token= 只允许文件下载链接使用，避免 token 出现在其他 URL 里被日志/Referer 带出去
  //（保留为兼容期通道：改版发布后旧标签页里的旧链接仍可用，新代码一律不再拼 token）
  if (!token && req.query.token && /^\/api\/files\/[A-Za-z0-9_-]{6,}\/download$/.test(req.path)) token = String(req.query.token);
  if (!token) return res.status(401).json({ ok: false, error: '未登录' });
  // 【2026-09-26 修复】原先整个函数一个大 try/catch，任何异常一律回 401"登录已过期"：
  // Mongo 抖动/断连时 getDb() 抛错 → **全站已登录请求都被告知"登录过期"**，前端引导所有人反复重登，
  // 现场表现和口令被爆破几乎一样，排查方向直接被带偏；而且 next() 在 try 内，
  // 下游同步处理器的异常也会落回这里，在响应已发出之后再补一次 401（ERR_HEADERS_SENT）。
  // 现在按类别分流：令牌问题 401、后端不可用 503，并且 next() 移出 try。
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) return res.status(401).json({ ok: false, error: '登录已过期，请重新登录' });
    return res.status(401).json({ ok: false, error: '登录状态无效，请重新登录' });
  }
  if (!payload || typeof payload.id !== 'string' || !ObjectId.isValid(payload.id)) {
    return res.status(401).json({ ok: false, error: '登录状态无效，请重新登录' });
  }
  let u;
  try {
    const db = await getDb();
    u = await db.collection('users').findOne({ _id: new ObjectId(payload.id) });
  } catch (e) {
    console.error('[auth] 读取用户失败（数据库不可用？）:', e && e.message || e);
    return res.status(503).json({ ok: false, error: '服务暂时不可用，请稍后重试' });
  }
  if (!u) return res.status(401).json({ ok: false, error: '账号不存在' });
  // 【2026-09-26 批次3】令牌吊销：token 有效期 30 天，且原先没有任何失效机制 ——
  // 管理员重置密码、改密之后，被盗用的旧 token 在剩余有效期内照样能进（auth 只验签名+过期+账号存在）。
  // 现在只要账号上有 tokenAfter，签发时间早于它的 token 一律作废；
  // 改密/重置/封禁时写入 tokenAfter 即可立即踢掉旧会话。没有该字段的历史账号不受影响（不会误伤）。
  if (u.tokenAfter) {
    const ta = new Date(u.tokenAfter).getTime();
    const iat = Number(payload.iat) * 1000;
    if (Number.isFinite(ta) && Number.isFinite(iat) && iat < ta) {
      return res.status(401).json({ ok: false, error: '登录状态已失效，请重新登录' });
    }
  }
  req.user = { _id: u._id, id: u._id.toString(), role: u.role, username: u.username, displayName: u.displayName, uid: u.uid || null, level: u.level || 0, alipay: u.alipay || null, realname: u.realname || null };
  next();
}
export function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: '未登录' });
  // 【2026-09-26】原先直接读 req.user.role：漏挂 auth 的路由会把 undefined 传进来 →
  // TypeError 变成 500（而不是清楚的 401/403），掩盖"这路由忘挂鉴权"这个真正的 bug。
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '需要管理员权限' });
  next();
}

// 【v26.73 · 2026-09-27 运营决定】资金入口收紧为「只有写手可充值/提现/绑收款」。
// 为什么现在才收：注册是开放的（portal 注册无需邀请码即得 client 角色），而充值链路是
// 「上传截图 → OCR/订单号核验 → 自动到账」，提现是「余额 → 线下支付宝」。只要 client 能走这两条，
// 任何一个路人注册一个账号就能尝试凭空造余额再套现，攻击成本≈0。
// 核查过实际用量：前端只有 writer.html 调用 /api/recharge 与 /api/withdraw，
// portal.html / member.html 一次都没调用过，所以这道门槛不会挡掉任何现有功能。
// admin 一并放行：运营自己要拿 writer.html 走一遍流程验证，且管理员没有可套现的余额，不构成风险。
export function writerOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: '未登录' });
  const role = req.user.role;
  if (role !== 'writer' && role !== 'admin') {
    // 留一行日志：万一真有 client 账号在充值，运营能在 Render 日志里看到是哪几个，而不是只收到投诉
    console.warn(`[权限] 已拦截 ${role || '未知角色'} 账号访问 ${req.method} ${req.originalUrl}（userId=${req.user.id}）`);
    return res.status(403).json({ ok: false, error: '仅写手可使用充值与提现功能' });
  }
  next();
}

// 【2026-09-17 安全加固】允许浏览器内联预览的文件类型白名单。
// 上传的 html / svg / js 等一律强制 attachment 下载，否则点开就在本站域内执行脚本（存储型 XSS，可偷登录态）。
export const INLINE_SAFE_TYPES = /^(image\/(png|jpeg|jpg|gif|webp|bmp)|application\/pdf|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|text\/plain)(\s*;.*)?$/;


// —— 通知工厂（依赖 socket.io 实例） ——
// 【2026-09-17 二次复核修正】连接侧加入的房间是 'user:<id>'（worktime.js），
// 原来推给裸 userId 房间——没有任何客户端在房间里，实时推送（消息/派单卡/站内信）
// 从未真正送达过，聊天只能靠手动刷新兜底。房间名对齐后推送恢复。
export const makeNotify = (io) => (userId, event, data) => {
  try { io.to('user:' + String(userId)).emit(event, data); } catch (e) {}
};
