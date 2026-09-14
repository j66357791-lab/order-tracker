// lib/core.js — 公共工具：JWT鉴权/通知/验证码/时间/缓存
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { getDb } from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'jdy-jwt-secret-2026-fallback';
export const qCache = new Map();
const CACHE_TTL = 60 * 1000;
export const cacheGet = (key) => { const e = qCache.get(key); if (e && Date.now() - e.t < CACHE_TTL) return e.v; qCache.delete(key); return undefined; };
export const cacheSet = (key, val) => qCache.set(key, { v: val, t: Date.now() });
export const cacheClear = () => qCache.clear();

export function signToken(u) {
  return jwt.sign({ id: u._id.toString(), role: u.role }, JWT_SECRET, { expiresIn: '30d' });
}
export function publicUser(u) {
  return { id: u._id.toString(), uid: u.uid || null, username: u.username, role: u.role,
           displayName: u.displayName, shift: !!u.shift, sockOnline: !!u.sockOnline,
           level: u.level || 0, alipay: u.alipay || null,
           realname: u.realname ? { name: u.realname.name, idMask: u.realname.idMask, verifiedAt: u.realname.verifiedAt } : null };
}


// —— 北京时间工具 ——
export const cnNow = () => new Date(Date.now() + 8 * 3600 * 1000);
export const cnDateStr = d => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');

export const cnDayStr = (d) => cnDateStr(new Date(new Date(d).getTime() + 8 * 3600 * 1000));
export const cnMonthStr = (d) => cnDayStr(d).slice(0, 7);
export const ymOf = (d) => cnDateStr(d).slice(0, 7);

// —— 验证码（算术码，内存5分钟） ——
export const captchaStore = new Map();
const rnd = n => Math.floor(Math.random() * n);
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
import crypto from 'crypto';
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
    if (!token && req.query.token) token = String(req.query.token);   // 浏览器直开下载链接用
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


// —— 通知工厂（依赖 socket.io 实例） ——
export const makeNotify = (io) => (userId, event, data) => {
  try { io.to(String(userId)).emit(event, data); } catch (e) {}
};
