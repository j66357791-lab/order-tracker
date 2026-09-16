// lib/core.js — 公共工具：JWT鉴权/通知/验证码/时间/缓存
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { getDb } from './db.js';

// 【2026-09-17 安全加固 P0】JWT 密钥不再使用硬编码兜底值。
// 旧值写在源码里 = 公开密钥，任何人拿到源码就能伪造 admin token 接管后台。
// 规则：优先用环境变量 / .env；没配则随机生成（重启后需重新登录，但无法被伪造）。
const INSECURE_DEFAULTS = ['jdy-jwt-secret-2026-fallback'];
function resolveJwtSecret() {
  const s = String(process.env.JWT_SECRET || '').trim();
  if (INSECURE_DEFAULTS.includes(s)) {
    console.error('[安全] JWT_SECRET 用了源码里的示例值，已忽略，改用随机密钥；请尽快换成自己的随机串。');
    return { secret: crypto.randomBytes(32).toString('hex'), fromEnv: false };
  }
  if (s.length >= 16) return { secret: s, fromEnv: true };
  if (s) console.warn('[安全] JWT_SECRET 长度不足 16 位，建议换成 32 位以上随机串；本次按配置使用。');
  const gen = crypto.randomBytes(32).toString('hex');
  console.error('============================================================');
  console.error('[安全] 未配置 JWT_SECRET，本次启动使用随机密钥。');
  console.error('       影响：服务重启后所有用户需要重新登录。');
  console.error('       解决：在项目根目录建 .env，写入一行（值自定，32 位以上随机字符）：');
  console.error('       JWT_SECRET=' + gen.slice(0, 16) + '……');
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

export function cleanReplyTo(rt) {
  if (!rt || typeof rt !== 'object') return null;
  const id = String(rt.id || '').slice(0, 40);
  if (!id) return null;
  return { id, fromName: String(rt.fromName || '').slice(0, 40), preview: String(rt.preview || '').slice(0, 80), type: String(rt.type || 'text') };
}
// 7位数工号ID：从1000001起自增
export async function nextUid(db) {
  const rows = await db.collection('users').find({ uid: { $exists: true } }).project({ uid: 1 }).toArray();
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.uid, 10) || 0), 1000000);
  return String(max + 1);
}
export async function assignUid(db, userId) {
  for (let i = 0; i < 5; i++) {   // 并发兜底：重试拿号
    const uid = await nextUid(db);
    const ok = await db.collection('users').updateOne({ _id: userId, uid: { $exists: false } }, { $set: { uid } });
    if (ok.modifiedCount) return uid;
  }
  return null;
}
export const pairKey = (a, b) => [String(a), String(b)].sort().join(':');

export async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    let token = h.startsWith('Bearer ') ? h.slice(7) : null;
    // 【2026-09-17 安全加固】?token= 只允许文件下载链接使用，避免 token 出现在其他 URL 里被日志/Referer 带出去
    if (!token && req.query.token && /^\/api\/files\/[A-Za-z0-9_-]{6,}\/download$/.test(req.path)) token = String(req.query.token);
    if (!token) return res.status(401).json({ ok: false, error: '未登录' });
    const payload = jwt.verify(token, JWT_SECRET);
    const db = await getDb();
    const u = await db.collection('users').findOne({ _id: new ObjectId(payload.id) });
    if (!u) return res.status(401).json({ ok: false, error: '账号不存在' });
    req.user = { _id: u._id, id: u._id.toString(), role: u.role, username: u.username, displayName: u.displayName, uid: u.uid || null, level: u.level || 0, alipay: u.alipay || null, realname: u.realname || null };
    next();
  } catch (e) {
    res.status(401).json({ ok: false, error: '登录已过期，请重新登录' });
  }
}
export function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '需要管理员权限' });
  next();
}

// 【2026-09-17 安全加固】允许浏览器内联预览的文件类型白名单。
// 上传的 html / svg / js 等一律强制 attachment 下载，否则点开就在本站域内执行脚本（存储型 XSS，可偷登录态）。
export const INLINE_SAFE_TYPES = /^(image\/(png|jpeg|jpg|gif|webp|bmp)|application\/pdf|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|text\/plain)(\s*;.*)?$/;


// —— 通知工厂（依赖 socket.io 实例） ——
export const makeNotify = (io) => (userId, event, data) => {
  try { io.to(String(userId)).emit(event, data); } catch (e) {}
};
