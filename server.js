// 接单员订单统计系统 - 后端服务
// 启动: node server.js  (默认端口 3000，可用 PORT 环境变量覆盖)
// 数据库连接串从环境变量 MONGO_URI 读取，也可直接改 config.js

const express = require('express');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const CONFIG = {
  mongoUri: process.env.MONGO_URI ||
    'mongodb+srv://j66357791_db_user:hjh628727@cluster0.oiwbvje.mongodb.net/invest-jiedanyuan?retryWrites=true&w=majority',
  dbName: process.env.MONGO_DB || 'invest-jiedanyuan',
  collection: 'orders',
  port: process.env.PORT || 3000,
};

// 状态定义：「已交付」=「待结算」（旧数据自动归一化）
const STATUSES = ['待开始', '进行中', '待结算', '已结算'];
const DONE_STATUSES = ['待结算', '已结算'];   // 完单口径
function normalizeStatus(s) {
  if (s === '已交付') return '待结算';
  return STATUSES.includes(s) ? s : null;
}

// 派单卡状态机：待接单→已接单→待审核→待打款→已完成；旁路：已拒绝/已驳回
// 旧状态「已交付」归一化为「待打款」
const CARD_STATUSES = ['待接单', '已接单', '待审核', '待打款', '已完成', '已拒绝', '已驳回'];
const normCard = c => ({ ...c, status: c.status === '已交付' ? '待打款' : c.status });
const localToday = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

const app = express();
app.use(express.json());
// manifest.json 必须返回 application/manifest+json，否则 PWA 检测工具识别不到
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});
// TWA 验证文件，安卓 App 必须能访问到，否则只显示启动图标不加载网页
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.onrender.order_tracker_mgbh.twa',
      sha256_cert_fingerprints: ['69:41:2C:F4:1C:96:2C:E2:04:08:39:53:ED:5C:D3:FD:15:BB:61:50:19:21:98:0B:15:ED:BE:E1:38:8C:EB:BE']
    }
  }]);
});
app.use(express.static(path.join(__dirname, 'public')));

let dbPromise = null;
let indexReady = false;
async function getDb() {
  if (!dbPromise) {
    dbPromise = new MongoClient(CONFIG.mongoUri, { serverSelectionTimeoutMS: 15000 })
      .connect()
      .then((c) => c.db(CONFIG.dbName));
  }
  const db = await dbPromise;
  // 首次访问时建索引：按日期查/排序、按状态筛、按完单日查、按编号搜索，各走各的索引
  if (!indexReady) {
    indexReady = true;
    db.collection(CONFIG.collection).createIndexes([
      { key: { date: -1 } },
      { key: { status: 1 } },
      { key: { doneDate: 1 } },
      { key: { orderNo: 1 } },
      { key: { date: -1, _id: -1 } },
    ]).catch(() => {});
    // 派单模块索引
    db.collection('users').createIndexes([{ key: { username: 1 }, unique: true }]).catch(() => {});
    db.collection('invites').createIndexes([{ key: { code: 1 }, unique: true }]).catch(() => {});
    db.collection('messages').createIndexes([
      { key: { conversation: 1, createdAt: -1 } },
      // 聊天信息云端只保留3天，到期自动删除（客户端本地localStorage兜底留存）
      { key: { createdAt: 1 }, expireAfterSeconds: 3 * 24 * 3600 },
    ]).catch(() => {});
    db.collection('cards').createIndexes([{ key: { to: 1, createdAt: -1 } }, { key: { orderId: 1 } }]).catch(() => {});
    db.collection('schedule_days').createIndexes([{ key: { userId: 1, date: 1 }, unique: true }]).catch(() => {});
    // 启动时清掉历史遗留的假在线标记（真实在线以内存连接表为准）
    db.collection('users').updateMany({ sockOnline: true }, { $set: { sockOnline: false } }).catch(() => {});
    // 存量用户补齐7位数工号ID
    (async () => {
      try {
        const miss = await db.collection('users').find({ uid: { $exists: false } }).project({ _id: 1 }).sort({ createdAt: 1 }).toArray();
        for (const u of miss) await assignUid(db, u._id);
      } catch (e) { console.error('uid补齐失败:', e.message); }
    })();
  }
  return db;
}

// ---------- 查询缓存（写操作即全量失效，TTL 60秒兜底） ----------
const qCache = new Map();
const CACHE_TTL = 60 * 1000;
function cacheGet(key) {
  const hit = qCache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  qCache.delete(key);
  return null;
}
function cacheSet(key, val) { qCache.set(key, { v: val, t: Date.now() }); }
function cacheClear() { qCache.clear(); }

// ---------- 校验 ----------
function parseOrder(body) {
  const errors = [];
  const date = String(body.date || '').trim();
  const orderNo = String(body.orderNo || '').trim();
  const note = String(body.note || '').trim();
  const status = normalizeStatus(body.status);
  const amount = Number(body.amount);
  const shareRate = Number(body.shareRate);
  let doneDate = String(body.doneDate || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('日期格式应为 YYYY-MM-DD');
  if (!orderNo) errors.push('订单编号不能为空');
  if (!isFinite(amount) || amount < 0) errors.push('订单金额必须是非负数字');
  if (!isFinite(shareRate) || shareRate <= 0 || shareRate > 100) errors.push('分成比例必须是 1-100 之间的数字（%）');
  if (!status) errors.push('订单进度不合法');
  if (doneDate && !/^\d{4}-\d{2}-\d{2}$/.test(doneDate)) errors.push('完单日期格式应为 YYYY-MM-DD');
  if (errors.length) return { errors };

  // 完单口径：待结算/已结算都算「完单」，完单日期缺省=今天；未完单状态清空完单日期
  if (!DONE_STATUSES.includes(status)) doneDate = null;
  else if (!doneDate) doneDate = localToday();

  return {
    doc: {
      date, orderNo,
      amount: Math.round(amount * 100) / 100,
      shareRate: Math.round(shareRate * 100) / 100,
      status, doneDate, note,
    },
  };
}

// ---------- API ----------
app.get('/api/statuses', (req, res) => res.json({ statuses: STATUSES }));

// 列表（仅管理员；支持 month=YYYY-MM、status、q 关键词筛选；旧「已交付」自动显示为「待结算」）
app.get('/api/orders', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const query = {};
    if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
      query.date = { $regex: '^' + req.query.month };
    }
    if (req.query.status && STATUSES.includes(req.query.status)) {
      // 待结算需同时兼容旧库里的「已交付」
      const sts = req.query.status === '待结算' ? ['待结算', '已交付'] : [req.query.status];
      query.status = { $in: sts };
    }
    if (req.query.q) {
      query.orderNo = { $regex: String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }
    let orders = cacheGet(JSON.stringify(query));
    if (!orders) {
      orders = await db.collection(CONFIG.collection)
        .find(query).sort({ date: -1, _id: -1 }).limit(500).toArray();
      // 附带分单信息（该订单绑定的派单卡：写手/报酬/卡状态）
      const ids = orders.map(o => o._id.toString());
      const dmap = {};
      if (ids.length) {
        const cards = await db.collection('cards')
          .find({ orderId: { $in: ids } })
          .project({ orderId: 1, toName: 1, reward: 1, status: 1 }).toArray();
        cards.forEach(c => { if (c.orderId && !dmap[c.orderId]) dmap[c.orderId] = { cardId: c._id.toString(), toName: c.toName || '', reward: c.reward || 0, status: c.status }; });
      }
      orders = orders.map(o => ({ ...o, status: normalizeStatus(o.status), dispatch: dmap[o._id.toString()] || null }));
      cacheSet(JSON.stringify(query), orders);
    }
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 新增
app.post('/api/orders', auth, adminOnly, async (req, res) => {
  const { doc, errors } = parseOrder(req.body || {});
  if (errors) return res.status(400).json({ ok: false, error: errors.join('；') });
  try {
    const db = await getDb();
    doc.createdAt = new Date();
    const r = await db.collection(CONFIG.collection).insertOne(doc);
    cacheClear();
    res.json({ ok: true, _id: r.insertedId, order: doc });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 修改
app.put('/api/orders/:id', auth, adminOnly, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, error: '无效的订单ID' });
  const { doc, errors } = parseOrder(req.body || {});
  if (errors) return res.status(400).json({ ok: false, error: errors.join('；') });
  try {
    const db = await getDb();
    doc.updatedAt = new Date();
    const r = await db.collection(CONFIG.collection).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: doc },
      { returnDocument: 'after' }
    );
    if (!r) return res.status(404).json({ ok: false, error: '订单不存在' });
    cacheClear();
    res.json({ ok: true, order: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 删除
app.delete('/api/orders/:id', auth, adminOnly, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, error: '无效的订单ID' });
  try {
    const db = await getDb();
    const r = await db.collection(CONFIG.collection).deleteOne({ _id: new ObjectId(req.params.id) });
    if (r.deletedCount === 0) return res.status(404).json({ ok: false, error: '订单不存在' });
    cacheClear();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 批量导入（JSON数组，用于Excel迁移）
app.post('/api/orders/batch', auth, adminOnly, async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [];
    if (!list.length) return res.status(400).json({ ok: false, error: '没有数据' });
    const docs = []; const errs = [];
    list.forEach((item, i) => {
      const { doc, errors } = parseOrder(item);
      if (errors) errs.push(`第${i + 1}条: ${errors.join('；')}`);
      else { doc.createdAt = new Date(); docs.push(doc); }
    });
    if (errs.length) return res.status(400).json({ ok: false, error: errs.join(' | ') });
    const db = await getDb();
    const r = await db.collection(CONFIG.collection).insertMany(docs);
    cacheClear();
    res.json({ ok: true, inserted: r.insertedCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===================================================================
// 派单模块（V7）：账号/邀请码/在班打卡/实时聊天/文件传输/派单卡/利润联动
// ===================================================================
const http = require('http');
const crypto = require('crypto');
const { GridFSBucket } = require('mongodb');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Server } = require('socket.io');

const JWT_SECRET = process.env.JWT_SECRET || 'jdy-jwt-secret-2026-fallback';
const FILE_LIMIT = 100 * 1024 * 1024;  // 单文件上限 100MB（GridFS流式写入，不占内存）

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: FILE_LIMIT,
  // 链接稳定性：心跳+断线自动重连参数
  pingInterval: 20000,
  pingTimeout: 25000,
  transports: ['websocket', 'polling'],
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FILE_LIMIT, files: 1 },
});

function signToken(u) {
  return jwt.sign({ id: u._id.toString(), role: u.role }, JWT_SECRET, { expiresIn: '30d' });
}
function publicUser(u) {
  return { id: u._id.toString(), uid: u.uid || null, username: u.username, role: u.role,
           displayName: u.displayName, shift: !!u.shift, sockOnline: !!u.sockOnline,
           level: u.level || 0, alipay: u.alipay || null,
           realname: u.realname ? { name: u.realname.name, idMask: u.realname.idMask, verifiedAt: u.realname.verifiedAt } : null };
}
// 写手绑定收款方式（支付宝：姓名+账号）
app.put('/api/me/alipay', auth, async (req, res) => {
  try {
    const db = await getDb();
    const name = String(req.body?.name || '').slice(0, 40).trim();
    const account = String(req.body?.account || '').slice(0, 60).trim();
    if (!name || !account) return res.status(400).json({ ok: false, error: '姓名和支付宝账号都必填' });
    // 收款人与实名必须为同一人（自动关联）
    if (req.user.realname?.name && name !== req.user.realname.name) {
      return res.status(400).json({ ok: false, error: '已实名认证，收款姓名必须与实名姓名一致（' + req.user.realname.name + '）' });
    }
    await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $set: { alipay: { name, account, updatedAt: new Date() } } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 修改显示名
app.put('/api/me/name', auth, async (req, res) => {
  try {
    const db = await getDb();
    const displayName = String(req.body?.displayName || '').trim().slice(0, 20);
    if (!displayName) return res.status(400).json({ ok: false, error: '名字不能为空' });
    await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $set: { displayName, updatedAt: new Date() } });
    res.json({ ok: true, displayName });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 等级 / 钱包 / 权益 ----------
// LV0 试用期写手（注册默认）；LV1：累计已到账 ≥500元 且 被驳回占比 <20%
// LV1权益：已到账金额每月额外 1.5% 奖励，次月发放进钱包
const LV1_PAID = 500, LV1_REJECT_MAX = 0.2, BONUS_RATE = 0.015;
const ymOf = d => cnDateStr(d).slice(0, 7);
async function levelStats(db, userId) {
  const cards = await db.collection('cards').find({ to: userId }).toArray();
  const paid = cards.filter(c => c.status === '已完成').reduce((s, c) => s + (c.reward || 0), 0);
  const judged = cards.filter(c => c.status !== '已拒绝');
  const rejected = cards.filter(c => c.status === '已驳回').length;
  const rejectRate = judged.length ? rejected / judged.length : 0;
  return { paid: Math.round(paid * 100) / 100, total: judged.length, rejected, rejectRate: Math.round(rejectRate * 1000) / 1000 };
}
async function ensureLevel(db, user) {
  const st = await levelStats(db, user.id);
  let level = user.level || 0;
  if (level < 1 && st.paid >= LV1_PAID && st.rejectRate < LV1_REJECT_MAX) {
    level = 1;
    await db.collection('users').updateOne({ _id: new ObjectId(user.id) }, { $set: { level, leveledUpAt: new Date() } });
  }
  return { level, st };
}
// 月度奖励入账：每月1次发上个月的（LV1及以上才有）
async function ensureBonus(db, user, level) {
  if (level < 1) return { balance: 0, grants: [], grantedLast: 0 };
  const prev = (() => { const [y, m] = ymOf(cnNow()).split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
  const log = db.collection('wallet_log');
  const exists = await log.findOne({ userId: user.id, month: prev });
  if (exists) return null;
  const cards = await db.collection('cards').find({ to: user.id, status: '已完成' }).toArray();
  const paidPrev = cards.filter(c => c.paidAt && ymOf(new Date(new Date(c.paidAt).getTime() + 8 * 3600 * 1000)) === prev)
    .reduce((s, c) => s + (c.reward || 0), 0);
  const amount = Math.round(paidPrev * BONUS_RATE * 100) / 100;
  if (amount <= 0) {
    await log.insertOne({ userId: user.id, month: prev, amount: 0, note: '上月无到账，未产生奖励', createdAt: new Date() });
    return null;
  }
  await log.insertOne({ userId: user.id, month: prev, amount, base: paidPrev, rate: BONUS_RATE, createdAt: new Date() });
  return { grantedLast: amount, month: prev };
}
app.get('/api/wallet', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { level, st } = await ensureLevel(db, req.user);
    await ensureBonus(db, req.user, level);
    const grants = (await db.collection('wallet_log').find({ userId: req.user.id }).sort({ month: -1 }).toArray())
      .map(g => ({ month: g.month, amount: g.amount, note: g.note || null, base: g.base || null }));
    const balance = Math.round(grants.reduce((s, g) => s + g.amount, 0) * 100) / 100;
    // 本月预计奖励
    const ym = ymOf(cnNow());
    const cards = await db.collection('cards').find({ to: req.user.id, status: '已完成' }).toArray();
    const paidThisMonth = cards.filter(c => c.paidAt && ymOf(new Date(new Date(c.paidAt).getTime() + 8 * 3600 * 1000)) === ym)
      .reduce((s, c) => s + (c.reward || 0), 0);
    res.json({
      ok: true, level, balance, stats: st,
      estBonus: level >= 1 ? Math.round(paidThisMonth * BONUS_RATE * 100) / 100 : 0,
      estBase: Math.round(paidThisMonth * 100) / 100,
      bonusRate: BONUS_RATE, lv1Paid: LV1_PAID, lv1RejectMax: LV1_REJECT_MAX,
      grants,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 班次池（管理员发班，写手抢班） ----------
app.get('/api/shifts', auth, async (req, res) => {
  try {
    const db = await getDb();
    const ym = String(req.query.ym || '');
    const q = /^\d{4}-\d{2}$/.test(ym) ? { date: { $regex: '^' + ym } } : {};
    const rows = await db.collection('shifts').find(q).sort({ date: 1, start: 1 }).limit(300).toArray();
    const uidSet = [...new Set(rows.flatMap(r => r.claims || []))];
    const users = uidSet.length ? await db.collection('users').find({ _id: { $in: uidSet.map(x => new ObjectId(x)) } }).project({ displayName: 1 }).toArray() : [];
    const nameMap = Object.fromEntries(users.map(u => [u._id.toString(), u.displayName]));
    res.json({
      ok: true, shifts: rows.map(r => ({
        _id: r._id.toString(), date: r.date, start: r.start, end: r.end,
        claimCount: (r.claims || []).length, claims: (r.claims || []).map(x => nameMap[x] || '写手'),
        claimedByMe: (r.claims || []).includes(req.user.id),
      })),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/shifts', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const date = String(req.body?.date || ''), start = String(req.body?.start || ''), end = String(req.body?.end || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: '日期格式应为 YYYY-MM-DD' });
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return res.status(400).json({ ok: false, error: '时间格式应为 HH:MM' });
    if (toMin(end) <= toMin(start)) return res.status(400).json({ ok: false, error: '结束时间要晚于开始时间' });
    if (date < cnDateStr(cnNow())) return res.status(400).json({ ok: false, error: '班次日期不能在过去' });
    const dup = await db.collection('shifts').findOne({ date, start, end });
    if (dup) return res.status(400).json({ ok: false, error: '该日期已有相同时间段的班次' });
    const r = await db.collection('shifts').insertOne({ date, start, end, claims: [], createdBy: req.user.id, createdAt: new Date() });
    res.json({ ok: true, _id: r.insertedId.toString() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete('/api/shifts/:id', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    await db.collection('shifts').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 写手抢班：抢占后自动写入单日排班
app.post('/api/shifts/:id/claim', auth, async (req, res) => {
  try {
    const db = await getDb();
    const sh = await db.collection('shifts').findOne({ _id: new ObjectId(req.params.id) });
    if (!sh) return res.status(404).json({ ok: false, error: '班次不存在' });
    if (sh.date <= cnDateStr(cnNow())) return res.status(400).json({ ok: false, error: '该班次已开始或过期，不能抢' });
    if ((sh.claims || []).includes(req.user.id)) return res.status(400).json({ ok: false, error: '你已经抢过这个班次了' });
    await db.collection('shifts').updateOne({ _id: sh._id }, { $addToSet: { claims: req.user.id } });
    await db.collection('schedule_days').updateOne(
      { userId: req.user.id, date: sh.date },
      { $set: { userId: req.user.id, date: sh.date, start: sh.start, end: sh.end, fromShift: sh._id.toString(), updatedAt: new Date() } },
      { upsert: true });
    res.json({ ok: true, date: sh.date, start: sh.start, end: sh.end });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 放弃班次（未开始可退）
app.post('/api/shifts/:id/unclaim', auth, async (req, res) => {
  try {
    const db = await getDb();
    const sh = await db.collection('shifts').findOne({ _id: new ObjectId(req.params.id) });
    if (!sh) return res.status(404).json({ ok: false, error: '班次不存在' });
    if (sh.date <= cnDateStr(cnNow())) return res.status(400).json({ ok: false, error: '班次已开始，不能退出' });
    await db.collection('shifts').updateOne({ _id: sh._id }, { $pull: { claims: req.user.id } });
    const att = await db.collection('attendance').findOne({ userId: req.user.id, date: sh.date });
    if (!att) await db.collection('schedule_days').deleteOne({ userId: req.user.id, date: sh.date, fromShift: sh._id.toString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// ---------- 好友（加同事） ----------
app.get('/api/friends', auth, async (req, res) => {
  try {
    const db = await getDb();
    const me = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
    const ids = (me.friends || []).filter(x => ObjectId.isValid(x)).map(x => new ObjectId(x));
    const rows = ids.length ? await db.collection('users').find({ _id: { $in: ids } })
      .project({ displayName: 1, username: 1, uid: 1, role: 1, shift: 1, sockOnline: 1, level: 1 })
      .sort({ displayName: 1 }).toArray() : [];
    res.json({ ok: true, friends: rows.map(u => ({ ...publicUser(u), online: !!u.sockOnline })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 添加好友：发送申请，对方确认后互为好友
app.post('/api/friends', auth, async (req, res) => {
  try {
    const db = await getDb();
    const q = String(req.body?.query || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: '请输入对方的ID或用户名' });
    const target = await db.collection('users').findOne(
      /^\d{7}$/.test(q) ? { uid: q } : { username: q.toLowerCase() });
    if (!target) return res.status(404).json({ ok: false, error: '找不到该用户，确认ID（7位数）或用户名没输错' });
    if (target._id.toString() === req.user.id) return res.status(400).json({ ok: false, error: '不能添加自己' });
    const tid = target._id.toString();
    const meDoc = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
    if ((meDoc.friends || []).includes(tid)) return res.status(400).json({ ok: false, error: '你们已经是同事了' });
    const dup = await db.collection('friend_requests').findOne({ from: req.user.id, to: tid, status: '待确认' });
    if (dup) return res.status(400).json({ ok: false, error: '申请已发送，等待对方确认' });
    await db.collection('friend_requests').insertOne({ from: req.user.id, to: tid, status: '待确认', createdAt: new Date() });
    notify(tid, 'friend_request', { from: req.user.id, fromName: req.user.displayName });
    res.json({ ok: true, message: '申请已发送，等待对方确认' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete('/api/friends/:id', auth, async (req, res) => {
  try {
    const db = await getDb();
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, error: '参数无效' });
    await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $pull: { friends: req.params.id } });
    await db.collection('users').updateOne({ _id: new ObjectId(req.params.id) }, { $pull: { friends: req.user.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 提现申请（线下打款登记） ----------
app.post('/api/withdraw', auth, async (req, res) => {
  try {
    const db = await getDb();
    const type = String(req.body?.type || '');
    if (!['bonus', 'order'].includes(type)) return res.status(400).json({ ok: false, error: '提现类型无效' });
    const alipay = req.user.alipay;
    if (!alipay || !alipay.account) return res.status(400).json({ ok: false, error: '请先在我的-钱包里绑定收款方式' });
    const doc = {
      userId: req.user.id, displayName: req.user.displayName, type,
      status: '待处理', alipay: { name: alipay.name, account: alipay.account },
      createdAt: new Date(),
    };
    if (type === 'bonus') {
      const grants = await db.collection('wallet_log').find({ userId: req.user.id }).toArray();
      const withdrawn = await db.collection('withdrawals').find({ userId: req.user.id, type: 'bonus', status: { $in: ['待处理', '已打款'] } }).toArray();
      const balance = Math.round((grants.reduce((s, g) => s + (g.amount || 0), 0) - withdrawn.reduce((s, w) => s + (w.amount || 0), 0)) * 100) / 100;
      if (balance <= 0) return res.status(400).json({ ok: false, error: '激励奖励暂无可提现余额' });
      doc.amount = balance;
    } else {
      const cards = await db.collection('cards').find({ to: req.user.id, status: '待打款' }).toArray();
      const amount = Math.round(cards.reduce((s, c) => s + (c.reward || 0), 0) * 100) / 100;
      if (amount <= 0) return res.status(400).json({ ok: false, error: '暂无待打款的单子奖励' });
      doc.amount = amount;
    }
    const r = await db.collection('withdrawals').insertOne(doc);
    res.json({ ok: true, _id: r.insertedId.toString(), amount: doc.amount, type });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/withdraw', auth, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection('withdrawals').find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(30).toArray();
    res.json({ ok: true, rows: rows.map(w => ({ _id: w._id.toString(), type: w.type, amount: w.amount, status: w.status, createdAt: w.createdAt })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 人机验证码（算术图形码，内存5分钟过期） ----------
// ===== 广告/公告管理 =====
const DEFAULT_AD = {
  title: '📢 接单流程与等级规范',
  content: `<div style="line-height:1.8;font-size:13px">
<h4 style="color:#07c160;margin:10px 0 6px">一、接单流程</h4>
<p>1. 在「工作台」查看可接单子，点击卡片查看详细要求</p>
<p>2. 确认能做后点击「接单」，开始计时</p>
<p>3. 完成后在「聊天」里提交成果文件</p>
<p>4. 管理员审核通过后，单子进入「待打款」状态</p>
<p>5. 管理员打款后，单子变为「已完成」，报酬自动入账</p>
<h4 style="color:#3b82f6;margin:12px 0 6px">二、结算规则</h4>
<p>• 审核通过的单子，报酬在<b>次月15日</b>统一结算</p>
<p>• 提现：「我的 → 钱包 → 提现」，支付宝到账</p>
<p>• 单笔结算后可随时提现，不设门槛</p>
<p>• 恶意退单/虚假提交将扣除对应报酬并记录违约</p>
<h4 style="color:#8b5cf6;margin:12px 0 6px">三、等级规范</h4>
<p>• <b style="color:#f59e0b">LV1 新手</b>：刚注册，可接基础单子</p>
<p>• <b style="color:#3b82f6">LV2 熟练</b>：完单5单以上，解锁高单价单子</p>
<p>• <b style="color:#07c160">LV3 资深</b>：完单20单以上，享优先派单权</p>
<p>• 等级每自然月评定一次，连续两周0完单降级</p>
<h4 style="color:#d97706;margin:12px 0 6px">四、注意事项</h4>
<p>• 所有沟通和文件交付请在平台内进行</p>
<p>• 禁止私下交易，违者封号</p>
<p>• 有问题随时在「聊天」联系管理员</p>
</div>`
};
app.get('/api/ads', async (req, res) => {
  try {
    const db = await getDb();
    let ad = await db.collection('ads').findOne({ _id: 'main' });
    if (!ad) {
      ad = { _id: 'main', ...DEFAULT_AD, updatedAt: new Date() };
      await db.collection('ads').insertOne(ad);
    }
    res.json({ ok: true, ad });
  } catch (e) {
    res.json({ ok: true, ad: DEFAULT_AD });
  }
});
app.post('/api/ads', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const { title, content } = req.body;
    await db.collection('ads').updateOne(
      { _id: 'main' },
      { $set: { title: String(title || ''), content: String(content || ''), updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const captchaStore = new Map();
const rnd = n => Math.floor(Math.random() * n);
app.get('/api/captcha', (req, res) => {
  const a = rnd(8) + 2, b = rnd(8) + 1;
  const op = Math.random() < 0.5 ? '+' : '-';
  const ans = op === '+' ? a + b : a - b;
  const id = require('crypto').randomBytes(12).toString('hex');
  captchaStore.set(id, { ans, exp: Date.now() + 5 * 60 * 1000 });
  if (captchaStore.size > 500) for (const [k, v] of captchaStore) if (v.exp < Date.now()) captchaStore.delete(k);
  const noise = Array.from({ length: 3 }, () => `<path d="M${rnd(120)} ${rnd(44)} Q ${rnd(160)} ${rnd(60)} ${120 + rnd(80)} ${rnd(50)}" stroke="#94a3b8${rnd(9)}" fill="none" stroke-width="1.5" opacity=".5"/>`).join('');
  const dots = Array.from({ length: 26 }, () => `<circle cx="${rnd(200)}" cy="${rnd(56)}" r="${rnd(2) + 1}" fill="#cbd5e1" opacity=".7"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="56" viewBox="0 0 200 56"><rect width="200" height="56" rx="10" fill="#f1f5f9"/>${noise}${dots}
    <text x="100" y="36" text-anchor="middle" font-size="26" font-weight="700" font-family="Georgia,serif" fill="#1f2937" letter-spacing="4" transform="rotate(${rnd(7) - 3} 100 30)">${a} ${op} ${b} = ?</text></svg>`;
  res.json({ ok: true, id, svg });
});
function verifyCaptcha(req) {
  const { captchaId, captchaAnswer } = req.body || {};
  const rec = captchaStore.get(String(captchaId || ''));
  captchaStore.delete(String(captchaId || ''));
  if (!rec || rec.exp < Date.now()) return '验证码已过期，请刷新重试';
  if (parseInt(captchaAnswer, 10) !== rec.ans) return '验证码答案不对';
  return null;
}

// ---------- 合同（兼职写手合作签约协议） ----------
const CONTRACT_VERSION = 'V1.1';
const CONTRACT_TITLE = '兼职写手合作签约协议';
const CONTRACT_TEXT = `甲方：平台运营方（下称"平台"）
乙方：兼职写手（下称"写手"，即本平台注册账号持有人）

一、合作性质
1. 本协议为兼职合作协议，不构成劳动雇佣关系，写手自主安排工作时间与地点，平台不要求坐班考勤约束（平台排班与打卡仅为接单协作需要）。
2. 写手自愿在平台注册并通过接单获得报酬，双方按"多劳多得、按单结算"原则合作。

二、接单与交付规范
1. 写手应保证所提交作品为本人原创，可以适当使用AI工具辅助处理（资料检索、润色、排版等），但不得以AI直接生成内容未经加工就冒充人工原创交付，不得抄袭、洗稿，不得一稿多投。
2. 作品需符合派单卡标注的要求（主题、字数、格式、交付时间等），不合格作品甲方可驳回并要求修改或重做。
3. 接单后因个人原因无法完成的，应及时与管理员沟通释放订单；无故拖延、失联造成的损失由写手承担。
4. 严禁泄露甲方客户信息、订单信息及平台内部数据；严禁绕开平台私自与客户交易。

三、报酬与结算
1. 报酬按单计价，以派单卡标注金额为准；审核通过后进入待打款，由管理员按约定周期打款至写手绑定的收款方式。
2. 写手应保证绑定的收款账号真实有效，且收款人与实名认证信息一致，因账号错误导致的损失由写手自行承担。
3. 写手达到平台等级条件的，可享受平台额外激励奖励，具体规则以平台页面公示为准。

四、实名与隐私
1. 写手接单前应完成实名认证（姓名+身份证号，平台仅作位数校验与唯一性识别，不对接第三方数据库）。
2. 平台仅收集开展合作所必需的信息（账号、昵称、实名信息、收款方式等），并妥善保管，不用于合作以外用途。
3. 写手对合作过程中知悉的客户与业务信息负有保密义务，协议终止后仍持续有效。

五、违规与解除
1. 写手出现抄袭、泄密、私单、恶意刷单、冒名实名等行为的，平台有权视情节采取驳回订单、取消激励、暂停接单、封禁账号等措施，未结合格报酬仍按规定结算。
2. 任何一方可提前告知对方终止合作；已产生的合格订单报酬不受影响。

六、其他
1. 本协议自写手在平台完成电子签署（点击签署并确认姓名）之日起生效，长期有效；实名认证信息与本协议自动关联，须为同一人。
2. 写手签署本协议即视为已完整阅读并同意以上全部条款。
3. 本协议的修改与解释权归平台所有，重大变更将以平台公告或弹窗方式通知。`;

app.get('/api/contract/text', (req, res) => res.json({ ok: true, title: CONTRACT_TITLE, version: CONTRACT_VERSION, text: CONTRACT_TEXT }));
app.get('/api/contract', auth, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection('contracts').find({ userId: req.user.id }).sort({ signedAt: -1 }).limit(20).toArray();
    res.json({
      ok: true, title: CONTRACT_TITLE, version: CONTRACT_VERSION, text: CONTRACT_TEXT,
      signed: rows.some(r => r.version === CONTRACT_VERSION),
      realname: req.user.realname || null,
      contracts: rows.map(r => ({ _id: r._id.toString(), name: r.name, version: r.version, signedAt: r.signedAt })),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/contract/sign', auth, async (req, res) => {
  try {
    const db = await getDb();
    let name = String(req.body?.name || '').trim().slice(0, 30);
    if (!name) return res.status(400).json({ ok: false, error: '请输入签署姓名' });
    if (name !== (req.body?.nameConfirm || '').trim()) return res.status(400).json({ ok: false, error: '两次输入的姓名不一致' });
    // 已实名则强制与实名一致（自动关联）
    if (req.user.realname?.name) {
      if (name !== req.user.realname.name) return res.status(400).json({ ok: false, error: '已实名认证，签署姓名必须与实名姓名一致（' + req.user.realname.name + '）' });
    }
    const exist = await db.collection('contracts').findOne({ userId: req.user.id, version: CONTRACT_VERSION });
    if (exist) return res.json({ ok: true, already: true });
    await db.collection('contracts').insertOne({ userId: req.user.id, name, uid: req.user.uid, displayName: req.user.displayName, version: CONTRACT_VERSION, title: CONTRACT_TITLE, signedAt: new Date() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 实名认证（姓名+身份证18位位数校验，只存掩码与哈希） ----------
const sha256hex = s => require('crypto').createHash('sha256').update(String(s)).digest('hex');
app.put('/api/me/realname', auth, async (req, res) => {
  try {
    const db = await getDb();
    const name = String(req.body?.name || '').trim().slice(0, 30);
    const idCard = String(req.body?.idCard || '').trim().toUpperCase();
    if (!/^[\u4e00-\u9fa5·]{2,30}$/.test(name)) return res.status(400).json({ ok: false, error: '请输入真实中文姓名' });
    if (!/^\d{17}[\dX]$/.test(idCard)) return res.status(400).json({ ok: false, error: '身份证号应为18位（最后一位可为X）' });
    const idHash = sha256hex(idCard);
    const dup = await db.collection('users').findOne({ 'realname.idHash': idHash, _id: { $ne: new ObjectId(req.user.id) } });
    if (dup) return res.status(400).json({ ok: false, error: '该身份证号已被其他账号认证' });
    const idMask = idCard.slice(0, 3) + '***********' + idCard.slice(-4);
    const realname = { name, idMask, idHash, verifiedAt: new Date() };
    await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $set: { realname } });
    // 自动关联合同：已签合同签署姓名同步为实名姓名
    await db.collection('contracts').updateMany({ userId: req.user.id }, { $set: { name, linkedRealname: true } });
    res.json({ ok: true, realname: { name, idMask, verifiedAt: realname.verifiedAt } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 站内信（管理员群发/定向，写手查看） ----------
app.post('/api/notify', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const title = String(req.body?.title || '').trim().slice(0, 60);
    const content = String(req.body?.content || '').trim().slice(0, 3000);
    const target = String(req.body?.target || 'all');
    if (!title || !content) return res.status(400).json({ ok: false, error: '标题和内容不能为空' });
    let targets = [];
    if (target === 'all') targets = (await db.collection('users').find({ role: 'writer' }).project({ _id: 1 }).toArray()).map(u => u._id.toString());
    else {
      if (!ObjectId.isValid(target)) return res.status(400).json({ ok: false, error: '目标用户无效' });
      targets = [target];
    }
    if (!targets.length) return res.status(400).json({ ok: false, error: '没有可发送的用户' });
    await db.collection('announcements').insertOne({ title, content, from: '系统', targets, readBy: [], createdAt: new Date() });
    targets.forEach(t => notify(t, 'announce', { title }));
    res.json({ ok: true, count: targets.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/notify', auth, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection('announcements').find({ targets: req.user.id }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json({
      ok: true, rows: rows.map(r => ({ _id: r._id.toString(), title: r.title, content: r.content, createdAt: r.createdAt, read: (r.readBy || []).includes(req.user.id) })),
      unread: rows.filter(r => !(r.readBy || []).includes(req.user.id)).length,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/notify/:id/read', auth, async (req, res) => {
  try {
    const db = await getDb();
    await db.collection('announcements').updateOne({ _id: new ObjectId(req.params.id) }, { $addToSet: { readBy: req.user.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/notify/admin', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection('announcements').find().sort({ createdAt: -1 }).limit(50).toArray();
    res.json({ ok: true, rows: rows.map(r => ({ _id: r._id.toString(), title: r.title, content: r.content, createdAt: r.createdAt, targets: (r.targets || []).length, reads: (r.readBy || []).length })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 好友申请（需对方确认） ----------
app.get('/api/friends/requests', auth, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection('friend_requests').find({
      $or: [{ to: req.user.id, status: '待确认' }, { from: req.user.id, status: '待确认' }],
    }).sort({ createdAt: -1 }).limit(50).toArray();
    const ids = rows.flatMap(r => [r.from, r.to]).filter(x => ObjectId.isValid(x));
    const users = ids.length ? await db.collection('users').find({ _id: { $in: ids.map(x => new ObjectId(x)) } }).project({ displayName: 1, uid: 1, level: 1 }).toArray() : [];
    const um = Object.fromEntries(users.map(u => [u._id.toString(), u]));
    res.json({
      ok: true,
      incoming: rows.filter(r => r.to === req.user.id).map(r => ({ _id: r._id.toString(), from: r.from, name: um[r.from]?.displayName || '写手', uid: um[r.from]?.uid || null, createdAt: r.createdAt })),
      outgoing: rows.filter(r => r.from === req.user.id).map(r => ({ _id: r._id.toString(), to: r.to, name: um[r.to]?.displayName || '写手', uid: um[r.to]?.uid || null, createdAt: r.createdAt })),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/friends/requests/:id/accept', auth, async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.collection('friend_requests').findOne({ _id: new ObjectId(req.params.id) });
    if (!r || r.to !== req.user.id || r.status !== '待确认') return res.status(400).json({ ok: false, error: '申请不存在或已处理' });
    await db.collection('friend_requests').updateOne({ _id: r._id }, { $set: { status: '已同意', handledAt: new Date() } });
    await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $addToSet: { friends: r.from } });
    await db.collection('users').updateOne({ _id: new ObjectId(r.from) }, { $addToSet: { friends: req.user.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/friends/requests/:id/reject', auth, async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.collection('friend_requests').findOne({ _id: new ObjectId(req.params.id) });
    if (!r || (r.to !== req.user.id && r.from !== req.user.id) || r.status !== '待确认') return res.status(400).json({ ok: false, error: '申请不存在或已处理' });
    await db.collection('friend_requests').updateOne({ _id: r._id }, { $set: { status: r.to === req.user.id ? '已拒绝' : '已撤回', handledAt: new Date() } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

function cleanReplyTo(rt) {
  if (!rt || typeof rt !== 'object') return null;
  const id = String(rt.id || '').slice(0, 40);
  if (!id) return null;
  return { id, fromName: String(rt.fromName || '').slice(0, 40), preview: String(rt.preview || '').slice(0, 80), type: String(rt.type || 'text') };
}
// 7位数工号ID：从1000001起自增
async function nextUid(db) {
  const rows = await db.collection('users').find({ uid: { $exists: true } }).project({ uid: 1 }).toArray();
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.uid, 10) || 0), 1000000);
  return String(max + 1);
}
async function assignUid(db, userId) {
  for (let i = 0; i < 5; i++) {   // 并发兜底：重试拿号
    const uid = await nextUid(db);
    const ok = await db.collection('users').updateOne({ _id: userId, uid: { $exists: false } }, { $set: { uid } });
    if (ok.modifiedCount) return uid;
  }
  return null;
}
const pairKey = (a, b) => [String(a), String(b)].sort().join(':');

async function auth(req, res, next) {
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
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '需要管理员权限' });
  next();
}
function notify(userId, event, data) {
  io.to('user:' + userId).emit(event, data);
}

// ---------- 初始化：创建管理员（仅当没有任何账号时） ----------
app.get('/api/setup/state', async (req, res) => {
  try {
    const db = await getDb();
    const n = await db.collection('users').countDocuments();
    res.json({ ok: true, needsSetup: n === 0 });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/setup', async (req, res) => {
  try {
    const db = await getDb();
    const n = await db.collection('users').countDocuments();
    if (n > 0) return res.status(400).json({ ok: false, error: '系统已初始化，请直接登录' });
    const { username, password, displayName } = req.body || {};
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ ok: false, error: '用户名限3-20位字母数字下划线' });
    if (!password || String(password).length < 6) return res.status(400).json({ ok: false, error: '密码至少6位' });
    const doc = {
      username, passwordHash: await bcrypt.hash(String(password), 8),
      displayName: String(displayName || username).slice(0, 20), role: 'admin',
      shift: false, sockOnline: false, email: '', createdAt: new Date(),
    };
    const r = await db.collection('users').insertOne(doc);
    await assignUid(db, r.insertedId);
    res.json({ ok: true, token: signToken({ _id: r.insertedId, role: 'admin' }), user: { ...publicUser(doc), id: r.insertedId.toString() } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 登录 / 注册（写手凭邀请码） ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const db = await getDb();
    const { username, password, passwordPlain } = req.body || {};
    const u = await db.collection('users').findOne({ username: String(username || '') });
    // 新体系：前端SHA-256预哈希；旧用户：前端同时带上原文，验证通过后静默升级为哈希体系
    const okNew = u && await bcrypt.compare(String(password || ''), u.passwordHash).catch(() => false);
    const okLegacy = !okNew && u && passwordPlain && await bcrypt.compare(String(passwordPlain), u.passwordHash).catch(() => false);
    if (!u || (!okNew && !okLegacy)) {
      return res.status(401).json({ ok: false, error: '用户名或密码错误' });
    }
    if (okLegacy) {
      // 静默升级：换成SHA-256预哈希存储，此后登录不再传输明文
      await db.collection('users').updateOne({ _id: u._id }, { $set: { passwordHash: await bcrypt.hash(String(password), 8) } }).catch(() => {});
    }
    res.json({ ok: true, token: signToken(u), user: publicUser(u) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/auth/register', async (req, res) => {
  try {
    const db = await getDb();
    const { inviteCode, username, password, displayName, email } = req.body || {};
    const inv = await db.collection('invites').findOne({ code: String(inviteCode || '').trim().toUpperCase() });
    if (!inv || inv.usedBy) return res.status(400).json({ ok: false, error: '邀请码无效或已被使用' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ ok: false, error: '用户名限3-20位字母数字下划线' });
    if (!password || String(password).length < 6) return res.status(400).json({ ok: false, error: '密码至少6位' });
    if (!req.body?.agree) return res.status(400).json({ ok: false, error: '请先阅读并同意《兼职写手合作签约协议》' });
    const capErr = verifyCaptcha(req);
    if (capErr) return res.status(400).json({ ok: false, error: capErr });
    const exists = await db.collection('users').findOne({ username });
    if (exists) return res.status(400).json({ ok: false, error: '用户名已被占用' });
    const doc = {
      username, passwordHash: await bcrypt.hash(String(password), 8),
      displayName: String(displayName || username).slice(0, 20), role: 'writer',
      shift: false, sockOnline: false, email: String(email || '').slice(0, 60),
      level: 0, createdAt: new Date(),
    };
    const r = await db.collection('users').insertOne(doc);
    const myUid = await assignUid(db, r.insertedId);
    // 注册即签署合作协议
    await db.collection('contracts').insertOne({ userId: r.insertedId.toString(), name: doc.displayName, uid: myUid, displayName: doc.displayName, version: CONTRACT_VERSION, title: CONTRACT_TITLE, signedAt: new Date(), source: 'register' });
    // 欢迎站内信
    await db.collection('announcements').insertOne({
      title: '👋 欢迎加入写手大家庭！', targets: [r.insertedId.toString()], readBy: [], createdAt: new Date(),
      content: `你好呀，${doc.displayName}！\n\n欢迎加入平台，这里有一份快速上手指南：\n\n① 去「工作台」看看待完成的单子，点「接单」开始赚第一笔；\n② 接单前记得先完成「实名认证」（我的-实名认证），否则接不了单哦；\n③ 「我的-钱包」里绑定收款方式（需与实名一致），审核通过后管理员会打款给你；\n④ 考勤页可以抢班、打卡，等级 LV1 有每月 1.5% 的激励奖励；\n⑤ 有问题随时在「聊天」里联系管理员，或留意顶部 ✉ 站内信通知。\n\n祝你接单顺利，稿费满满！`,
    });
    await db.collection('invites').updateOne({ _id: inv._id }, { $set: { usedBy: r.insertedId.toString(), usedAt: new Date() } });
    res.json({ ok: true, token: signToken({ _id: r.insertedId, role: 'writer' }), user: { ...publicUser(doc), id: r.insertedId.toString() } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/me', auth, (req, res) => res.json({ ok: true, user: req.user }));

// ---------- 邀请码（管理员） ----------
app.post('/api/invites', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const n = Math.max(1, Math.min(20, Number(req.body?.count) || 1));
    const docs = [];
    for (let i = 0; i < n; i++) {
      docs.push({ code: 'W' + crypto.randomBytes(4).toString('hex').toUpperCase(), usedBy: null, createdAt: new Date() });
    }
    await db.collection('invites').insertMany(docs);
    res.json({ ok: true, invites: docs });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/invites', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const invites = await db.collection('invites').find({}).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ ok: true, invites });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 团队 / 在班打卡 ----------
app.get('/api/team', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const users = await db.collection('users').find({ role: 'writer' }).sort({ createdAt: 1 }).toArray();
    res.json({ ok: true, users: users.map(publicUser) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/shift', auth, async (req, res) => {
  try {
    const db = await getDb();
    const shift = !!req.body?.shift;
    await db.collection('users').updateOne({ _id: req.user._id }, { $set: { shift } });
    io.emit('presence', { userId: req.user.id, shift, sockOnline: true });
    res.json({ ok: true, shift });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 聊天 ----------
// 会话列表：管理员=全部写手（含未读/最后一条）；写手=和管理员的会话
app.get('/api/chats', auth, async (req, res) => {
  try {
    const db = await getDb();
    if (req.user.role === 'admin') {
      const writers = await db.collection('users').find({ role: 'writer' }).sort({ createdAt: 1 }).toArray();
      const list = [];
      for (const w of writers) {
        const conv = pairKey(req.user.id, w._id.toString());
        const last = await db.collection('messages').find({ conversation: conv }).sort({ createdAt: -1 }).limit(1).toArray();
        const unread = await db.collection('messages').countDocuments({ conversation: conv, to: req.user.id, read: false });
        list.push({ user: publicUser(w), unread, last: last[0] || null });
      }
      return res.json({ ok: true, chats: list });
    }
    // 写手：会话对象=管理员 + 好友（同事）
    const admins = await db.collection('users').find({ role: 'admin' }).toArray();
    const me = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
    const friendIds = (me.friends || []).filter(x => ObjectId.isValid(x) && x !== req.user.id);
    const friends = friendIds.length ? await db.collection('users').find({ _id: { $in: friendIds.map(x => new ObjectId(x)) } }).toArray() : [];
    const list = [];
    for (const a of [...admins, ...friends]) {
      const conv = pairKey(req.user.id, a._id.toString());
      const last = await db.collection('messages').find({ conversation: conv }).sort({ createdAt: -1 }).limit(1).toArray();
      const unread = await db.collection('messages').countDocuments({ conversation: conv, to: req.user.id, read: false });
      list.push({ user: publicUser(a), unread, last: last[0] || null });
    }
    list.sort((x, y) => (y.last?.createdAt || y.user.createdAt || 0) - (x.last?.createdAt || x.user.createdAt || 0));
    res.json({ ok: true, chats: list });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 消息列表（自动标已读 + 通知发送方更新已读水印）
app.get('/api/messages', auth, async (req, res) => {
  try {
    const db = await getDb();
    const peer = String(req.query.peer || '');
    if (!ObjectId.isValid(peer)) return res.status(400).json({ ok: false, error: '无效会话' });
    const conv = pairKey(req.user.id, peer);
    const msgs = await db.collection('messages').find({ conversation: conv }).sort({ createdAt: 1 }).limit(500).toArray();
    const unread = await db.collection('messages').countDocuments({ conversation: conv, to: req.user.id, read: false });
    if (unread) {
      await db.collection('messages').updateMany({ conversation: conv, to: req.user.id, read: false }, { $set: { read: true } });
      msgs.forEach(m => { if (m.to === req.user.id) m.read = true; });
      notify(peer, 'msg_read', { peer: req.user.id });   // 让对方刷新已读水印
    }
    res.json({ ok: true, messages: msgs });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 撤回消息（2分钟内、仅本人）
app.post('/api/messages/recall', auth, async (req, res) => {
  try {
    const db = await getDb();
    const id = String(req.body?.id || '');
    if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: '参数无效' });
    const m = await db.collection('messages').findOne({ _id: new ObjectId(id) });
    if (!m || m.from !== req.user.id) return res.status(404).json({ ok: false, error: '消息不存在' });
    if (m.recalled) return res.json({ ok: true });
    if (Date.now() - new Date(m.createdAt).getTime() > 2 * 60 * 1000) return res.status(400).json({ ok: false, error: '超过2分钟，不能撤回了' });
    await db.collection('messages').updateOne({ _id: m._id }, { $set: { recalled: true, text: '', fileId: null, fileName: null, cardId: null } });
    const updated = { ...m, recalled: true, text: '' };
    notify(m.to, 'msg_recall', { id, conversation: m.conversation });
    res.json({ ok: true, message: updated });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 清空聊天记录（双方会话消息全部删除）
app.delete('/api/messages', auth, async (req, res) => {
  try {
    const db = await getDb();
    const peer = String(req.query.peer || '');
    if (!ObjectId.isValid(peer)) return res.status(400).json({ ok: false, error: '无效会话' });
    const conv = pairKey(req.user.id, peer);
    const r = await db.collection('messages').deleteMany({ conversation: conv });
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 工作台统计 ----------
app.get('/api/workbench', auth, async (req, res) => {
  try {
    const db = await getDb();
    const ym = /^\d{4}-\d{2}$/.test(String(req.query.ym || '')) ? String(req.query.ym) : ymOf(cnNow());
    const start = new Date(ym + '-01T00:00:00+08:00');
    const endDate = (() => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 1, 0, 0, 0) - 8 * 3600 * 1000) })();
    const monthCards = await db.collection('cards').find({ to: req.user.id, createdAt: { $gte: start, $lt: endDate } }).toArray();
    const allCards = await db.collection('cards').find({ to: req.user.id }).toArray();
    const pendingCount = allCards.filter(c => ['待接单', '已接单', '待审核'].includes(c.status)).length;
    const monthAccepted = Math.round(monthCards.filter(c => c.status !== '已拒绝').reduce((s, c) => s + (c.reward || 0), 0) * 100) / 100;
    const pendingPay = Math.round(allCards.filter(c => c.status === '待打款').reduce((s, c) => s + (c.reward || 0), 0) * 100) / 100;
    const cnDay = d => cnDateStr(new Date(new Date(d).getTime() + 8 * 3600 * 1000)).slice(0, 10);
    const daily = {};
    monthCards.forEach(c => {
      if (c.status === '已拒绝') return;
      const d = cnDay(c.createdAt);
      (daily[d] = daily[d] || { date: d, accepted: 0, acceptedCount: 0, completed: 0, completedCount: 0 });
      daily[d].accepted += (c.reward || 0); daily[d].acceptedCount++;
      if (c.status === '已完成' && c.paidAt) {
        const pd = cnDay(c.paidAt);
        if (pd.startsWith(ym)) {
          (daily[pd] = daily[pd] || { date: pd, accepted: 0, acceptedCount: 0, completed: 0, completedCount: 0 });
          daily[pd].completed += (c.reward || 0); daily[pd].completedCount++;
        }
      }
    });
    res.json({ ok: true, ym, pendingCount, monthAccepted, pendingPay, daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 发文字消息
app.post('/api/messages', auth, async (req, res) => {
  try {
    const db = await getDb();
    const peer = String(req.body?.peer || '');
    const text = String(req.body?.text || '').slice(0, 2000).trim();
    if (!ObjectId.isValid(peer)) return res.status(400).json({ ok: false, error: '无效会话' });
    const target = await db.collection('users').findOne({ _id: new ObjectId(peer) });
    if (!target) return res.status(404).json({ ok: false, error: '对方不存在' });
    // 权限：管理员可和所有人聊；写手之间需互为好友（同事）
    if (req.user.role !== 'admin' && target.role !== 'admin') {
      const me = await db.collection('users').findOne({ _id: new ObjectId(req.user.id), friends: peer });
      if (!me) return res.status(403).json({ ok: false, error: '只能和管理员或已添加的同事聊天' });
    }
    if (!text) return res.status(400).json({ ok: false, error: '消息不能为空' });
    const msg = {
      conversation: pairKey(req.user.id, peer),
      from: req.user.id, fromName: req.user.displayName, to: peer,
      type: 'text', text, replyTo: cleanReplyTo(req.body?.replyTo), read: false, createdAt: new Date(),
    };
    const r = await db.collection('messages').insertOne(msg);
    msg._id = r.insertedId;
    notify(peer, 'msg', msg); notify(req.user.id, 'msg', msg);
    res.json({ ok: true, message: msg });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 上传文件（≤25MB，任意格式，存数据库 GridFS）
app.post('/api/files', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: '没有文件' });
    // multer/busboy 用 latin1 解码文件名，中文会乱码，转回 utf8
    try { req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8'); } catch (e) {}
    const peer = String(req.body?.peer || '');
    if (!ObjectId.isValid(peer)) return res.status(400).json({ ok: false, error: '无效会话' });
    const db = await getDb();
    const bucket = new GridFSBucket(db);
    const meta = { from: req.user.id, to: peer, fileName: req.file.originalname };
    const uploadStream = bucket.openUploadStream(req.file.originalname, {
      contentType: req.file.mimetype || 'application/octet-stream', metadata: meta,
    });
    await new Promise((resolve, reject) => {
      uploadStream.end(req.file.buffer, (err) => err ? reject(err) : resolve());
    });
    res.json({ ok: true, fileId: uploadStream.id.toString(), fileName: req.file.originalname, fileSize: req.file.size });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 下载文件（会话双方可下；支持 ?token= 供浏览器直接打开）
app.get('/api/files/:id/download', auth, async (req, res) => {
  try {
    const db = await getDb();
    const bucket = new GridFSBucket(db);
    const files = await bucket.find({ _id: new ObjectId(req.params.id) }).limit(1).toArray();
    const f = files[0];
    if (!f) return res.status(404).json({ ok: false, error: '文件不存在' });
    const meta = f.metadata || {};
    if (req.user.role !== 'admin' && meta.from !== req.user.id && meta.to !== req.user.id) {
      return res.status(403).json({ ok: false, error: '无权访问该文件' });
    }
    const inline = String(req.query.inline) === '1';
    res.setHeader('Content-Type', f.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(f.filename));
    bucket.openDownloadStream(f._id).pipe(res);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 发文件消息（文件先传 /api/files，再发这条）
app.post('/api/messages/file', auth, async (req, res) => {
  try {
    const db = await getDb();
    const peer = String(req.body?.peer || '');
    const fileId = String(req.body?.fileId || '');
    const fileName = String(req.body?.fileName || '文件').slice(0, 120);
    const fileSize = Number(req.body?.fileSize) || 0;
    if (!ObjectId.isValid(peer) || !ObjectId.isValid(fileId)) return res.status(400).json({ ok: false, error: '参数无效' });
    const target = await db.collection('users').findOne({ _id: new ObjectId(peer) });
    if (!target) return res.status(404).json({ ok: false, error: '对方不存在' });
    // 权限：管理员可和所有人聊；写手之间需互为好友（同事）
    if (req.user.role !== 'admin' && target.role !== 'admin') {
      const me = await db.collection('users').findOne({ _id: new ObjectId(req.user.id), friends: peer });
      if (!me) return res.status(403).json({ ok: false, error: '只能和管理员或已添加的同事聊天' });
    }
    const msg = {
      conversation: pairKey(req.user.id, peer),
      from: req.user.id, fromName: req.user.displayName, to: peer,
      type: 'file', fileId, fileName, fileSize, replyTo: cleanReplyTo(req.body?.replyTo), read: false, createdAt: new Date(),
    };
    const r = await db.collection('messages').insertOne(msg);
    msg._id = r.insertedId;
    notify(peer, 'msg', msg); notify(req.user.id, 'msg', msg);
    res.json({ ok: true, message: msg });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 派单卡 ----------
async function insertCardMessage(db, card, fromUser, toId) {
  const msg = {
    conversation: pairKey(fromUser.id, toId),
    from: fromUser.id, fromName: fromUser.displayName, to: toId,
    type: 'card', cardId: card._id.toString(), read: false, createdAt: new Date(),
  };
  const r = await db.collection('messages').insertOne(msg);
  msg._id = r.insertedId;
  return msg;
}
// 创建派单卡（管理员）：报酬自定义；**必须关联台账订单**（联动利润与交付同步），订单号同步给写手
app.post('/api/cards', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const to = String(req.body?.to || '');
    const title = String(req.body?.title || '').slice(0, 100).trim();
    const reward = Number(req.body?.reward);
    const requirement = String(req.body?.requirement || '').slice(0, 3000).trim();
    const deadline = String(req.body?.deadline || '').trim();
    const orderId = String(req.body?.orderId || '');
    const fileId = String(req.body?.fileId || '');
    const fileName = String(req.body?.fileName || '').slice(0, 120);
    if (!ObjectId.isValid(to)) return res.status(400).json({ ok: false, error: '无效的写手' });
    if (!title) return res.status(400).json({ ok: false, error: '标题不能为空' });
    if (!isFinite(reward) || reward < 0) return res.status(400).json({ ok: false, error: '报酬必须是≥0的数字' });
    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return res.status(400).json({ ok: false, error: '截止日期格式应为 YYYY-MM-DD' });
    // 订单必选：从台账拉取并绑定
    if (!ObjectId.isValid(orderId)) return res.status(400).json({ ok: false, error: '必须选择一个台账订单才能发送派单卡' });
    const order = await db.collection(CONFIG.collection).findOne({ _id: new ObjectId(orderId) });
    if (!order) return res.status(404).json({ ok: false, error: '关联的台账订单不存在' });
    const target = await db.collection('users').findOne({ _id: new ObjectId(to) });
    if (!target || target.role !== 'writer') return res.status(404).json({ ok: false, error: '写手不存在' });
    const card = {
      to, toName: target.displayName, from: req.user.id, fromName: req.user.displayName,
      title, reward: Math.round(reward * 100) / 100, requirement, deadline: deadline || null,
      orderId, orderNo: order.orderNo, orderDate: order.date,
      fileId: fileId || null, fileName: fileName || null,
      status: '待接单', acceptedAt: null, deliveredAt: null, finishedAt: null, createdAt: new Date(),
    };
    const r = await db.collection('cards').insertOne(card);
    card._id = r.insertedId;
    const msg = await insertCardMessage(db, card, req.user, to);
    notify(to, 'msg', msg); notify(to, 'card', card);
    res.json({ ok: true, card });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 写手：我的派单卡
app.get('/api/mycards', auth, async (req, res) => {
  try {
    const db = await getDb();
    const cards = (await db.collection('cards').find({ to: req.user.id }).sort({ createdAt: -1 }).limit(200).toArray()).map(normCard);
    res.json({ ok: true, cards });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 写手：接单（锁定）
app.post('/api/cards/:id/accept', auth, async (req, res) => {
  try {
    const db = await getDb();
    // 接单必须完成实名认证
    if (!req.user.realname?.name) return res.status(403).json({ ok: false, error: 'NEED_REALNAME:接单前请先完成实名认证（我的-实名认证）' });
    const card = await db.collection('cards').findOne({ _id: new ObjectId(req.params.id) });
    if (!card || card.to !== req.user.id) return res.status(404).json({ ok: false, error: '派单卡不存在' });
    if (card.status !== '待接单') return res.status(400).json({ ok: false, error: '该卡片当前状态不可接单' });
    const r = await db.collection('cards').findOneAndUpdate(
      { _id: card._id }, { $set: { status: '已接单', acceptedAt: new Date() } }, { returnDocument: 'after' });
    notify(card.from, 'card', r); notify(req.user.id, 'card', r);
    res.json({ ok: true, card: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 写手：拒绝（未接单时可拒）
app.post('/api/cards/:id/decline', auth, async (req, res) => {
  try {
    const db = await getDb();
    const card = await db.collection('cards').findOne({ _id: new ObjectId(req.params.id) });
    if (!card || card.to !== req.user.id) return res.status(404).json({ ok: false, error: '派单卡不存在' });
    if (card.status !== '待接单') return res.status(400).json({ ok: false, error: '该卡片当前状态不可拒绝' });
    const r = await db.collection('cards').findOneAndUpdate(
      { _id: card._id }, { $set: { status: '已拒绝' } }, { returnDocument: 'after' });
    notify(card.from, 'card', r); notify(req.user.id, 'card', r);
    res.json({ ok: true, card: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 写手：提交审核（做单完成 → 等管理员审核；此时不动台账）
async function submitHandler(req, res) {
  try {
    const db = await getDb();
    const card = await db.collection('cards').findOne({ _id: new ObjectId(req.params.id) });
    if (!card || card.to !== req.user.id) return res.status(404).json({ ok: false, error: '派单卡不存在' });
    if (card.status !== '已接单') return res.status(400).json({ ok: false, error: '只有做单中的卡片才能提交审核' });
    const note = String(req.body?.note || '').slice(0, 500).trim();
    const r = await db.collection('cards').findOneAndUpdate(
      { _id: card._id },
      { $set: { status: '待审核', submittedAt: new Date(), submitNote: note, rejectReason: null } },
      { returnDocument: 'after' });
    notify(card.from, 'card', r); notify(req.user.id, 'card', r);
    res.json({ ok: true, card: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}
app.post('/api/cards/:id/submit', auth, submitHandler);
app.post('/api/cards/:id/deliver', auth, submitHandler);   // 兼容旧客户端
// 写手：驳回后重新做单
app.post('/api/cards/:id/redo', auth, async (req, res) => {
  try {
    const db = await getDb();
    const card = await db.collection('cards').findOne({ _id: new ObjectId(req.params.id) });
    if (!card || card.to !== req.user.id) return res.status(404).json({ ok: false, error: '派单卡不存在' });
    if (card.status !== '已驳回') return res.status(400).json({ ok: false, error: '只有被驳回的卡片才能重新做单' });
    const r = await db.collection('cards').findOneAndUpdate(
      { _id: card._id }, { $set: { status: '已接单', rejectReason: null } }, { returnDocument: 'after' });
    notify(card.from, 'card', r); notify(req.user.id, 'card', r);
    res.json({ ok: true, card: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 管理员：审核通过 → 待打款；联动同步原单（状态→待结算，完单日→今天）
app.post('/api/cards/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const card = await db.collection('cards').findOne({ _id: new ObjectId(req.params.id) });
    if (!card) return res.status(404).json({ ok: false, error: '派单卡不存在' });
    if (card.status !== '待审核' && card.status !== '已交付') {
      return res.status(400).json({ ok: false, error: '只有待审核的卡片才能审核通过' });
    }
    const r = await db.collection('cards').findOneAndUpdate(
      { _id: card._id }, { $set: { status: '待打款', approvedAt: new Date() } }, { returnDocument: 'after' });
    let syncedOrder = null;
    if (card.orderId && ObjectId.isValid(card.orderId)) {
      syncedOrder = await db.collection(CONFIG.collection).findOneAndUpdate(
        { _id: new ObjectId(card.orderId) },
        { $set: { status: '待结算', doneDate: localToday(), updatedAt: new Date() } },
        { returnDocument: 'after' });
      if (syncedOrder) cacheClear();
    }
    notify(card.to, 'card', r); notify(req.user.id, 'card', r);
    res.json({ ok: true, card: r, syncedOrder });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 管理员：驳回（待审核 → 已驳回，带原因；写手可重新做单；台账不动）
app.post('/api/cards/:id/reject', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const card = await db.collection('cards').findOne({ _id: new ObjectId(req.params.id) });
    if (!card) return res.status(404).json({ ok: false, error: '派单卡不存在' });
    if (card.status !== '待审核') return res.status(400).json({ ok: false, error: '只有待审核的卡片才能驳回' });
    const reason = String(req.body?.reason || '').slice(0, 300).trim() || '未通过';
    const r = await db.collection('cards').findOneAndUpdate(
      { _id: card._id }, { $set: { status: '已驳回', rejectReason: reason, rejectedAt: new Date() } }, { returnDocument: 'after' });
    notify(card.to, 'card', r); notify(req.user.id, 'card', r);
    res.json({ ok: true, card: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 管理员：确认打款（待打款 → 已完成）；联动同步原单（状态→已结算）
async function payHandler(req, res) {
  try {
    const db = await getDb();
    const card = await db.collection('cards').findOne({ _id: new ObjectId(req.params.id) });
    if (!card) return res.status(404).json({ ok: false, error: '派单卡不存在' });
    if (card.status !== '待打款' && card.status !== '已交付') {
      return res.status(400).json({ ok: false, error: '只有待打款的卡片才能确认打款' });
    }
    const r = await db.collection('cards').findOneAndUpdate(
      { _id: card._id }, { $set: { status: '已完成', paidAt: new Date() } }, { returnDocument: 'after' });
    let syncedOrder = null;
    if (card.orderId && ObjectId.isValid(card.orderId)) {
      syncedOrder = await db.collection(CONFIG.collection).findOneAndUpdate(
        { _id: new ObjectId(card.orderId) },
        { $set: { status: '已结算', updatedAt: new Date() } },
        { returnDocument: 'after' });
      if (syncedOrder) cacheClear();
    }
    notify(card.to, 'card', r); notify(req.user.id, 'card', r);
    res.json({ ok: true, card: r, syncedOrder });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}
app.post('/api/cards/:id/pay', auth, adminOnly, payHandler);
app.post('/api/cards/:id/finish', auth, adminOnly, payHandler);   // 兼容旧客户端
// 管理员：补台账同步（对账发现「已给写手打款但台账还没标已结算」时一键同步）
app.post('/api/cards/:id/syncorder', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const card = await db.collection('cards').findOne({ _id: new ObjectId(req.params.id) });
    if (!card) return res.status(404).json({ ok: false, error: '派单卡不存在' });
    if (card.status !== '已完成') return res.status(400).json({ ok: false, error: '只有已完成的卡片才需要补同步' });
    if (!card.orderId || !ObjectId.isValid(card.orderId)) return res.status(400).json({ ok: false, error: '该卡片未关联台账订单' });
    const r = await db.collection(CONFIG.collection).findOneAndUpdate(
      { _id: new ObjectId(card.orderId) },
      { $set: { status: '已结算', doneDate: card.doneDate || localToday(), updatedAt: new Date() } },
      { returnDocument: 'after' });
    cacheClear();
    notify(card.to, 'card', card);
    res.json({ ok: true, syncedOrder: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 管理员：派单总览（含利润联动：原单分成 - 派单报酬；支持 q 关键词 / status 筛选）
app.get('/api/dispatch/overview', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const q = String(req.query.q || '').trim().toLowerCase();
    const st = String(req.query.status || '');
    let cards = (await db.collection('cards').find({}).sort({ createdAt: -1 }).limit(500).toArray()).map(normCard);
    if (st && CARD_STATUSES.includes(st)) cards = cards.filter(c => c.status === st);
    const rows = [];
    let totReward = 0, totShare = 0, totProfit = 0, linked = 0;
    for (const c of cards) {
      let order = null;
      if (c.orderId && ObjectId.isValid(c.orderId)) {
        order = await db.collection(CONFIG.collection).findOne({ _id: new ObjectId(c.orderId) });
      }
      const share = order ? Math.round(order.amount * order.shareRate) / 100 : null;
      const profit = order ? Math.round((share - c.reward) * 100) / 100 : null;
      if (order) { linked++; totReward += c.reward; totShare += share; totProfit += profit; }
      const row = {
        _id: c._id.toString(), title: c.title, to: c.to, toName: c.toName, reward: c.reward,
        status: c.status, deadline: c.deadline, createdAt: c.createdAt,
        submittedAt: c.submittedAt || null, submitNote: c.submitNote || null,
        rejectReason: c.rejectReason || null,
        requirement: c.requirement || null, fileId: c.fileId || null, fileName: c.fileName || null,
        orderId: c.orderId || null, orderNo: order ? order.orderNo : null,
        orderAmount: order ? order.amount : null, orderShare: share, profit,
      };
      if (q) {
        const hay = [c.title, c.toName, row.orderNo, c.orderNo, c.requirement].map(x => String(x || '').toLowerCase());
        if (!hay.some(h => h.includes(q))) continue;
      }
      rows.push(row);
    }
    res.json({ ok: true, rows, totals: { linked, totReward: Math.round(totReward*100)/100, totShare: Math.round(totShare*100)/100, totProfit: Math.round(totProfit*100)/100 } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 管理员：财务对账——台账到账状态 × 派单卡打款状态 交叉核对
// type: needPay = 台账已结算(客户已到账)但卡还没打款 → 提醒审批打款
//       needReview = 台账已结算但卡还停在待审核 → 提醒先审核
//       unsynced  = 卡已完成(已给写手打款)但台账还没标已结算 → 提醒补台账
app.get('/api/dispatch/reconcile', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const cards = (await db.collection('cards').find({})
      .sort({ createdAt: -1 }).limit(500).toArray()).map(normCard);
    const out = [];
    for (const c of cards) {
      if (!c.orderId || !ObjectId.isValid(c.orderId)) continue;
      if (!['待审核', '待打款', '已完成'].includes(c.status)) continue;
      const order = await db.collection(CONFIG.collection).findOne({ _id: new ObjectId(c.orderId) });
      if (!order) continue;
      const oStatus = normalizeStatus(order.status);
      let type = null;
      if (oStatus === '已结算' && c.status === '待打款') type = 'needPay';
      else if (oStatus === '已结算' && c.status === '待审核') type = 'needReview';
      else if (oStatus !== '已结算' && c.status === '已完成') type = 'unsynced';
      if (!type) continue;
      out.push({
        type,
        card: { _id: c._id.toString(), title: c.title, to: c.to, toName: c.toName, reward: c.reward, status: c.status, orderNo: c.orderNo },
        order: { _id: order._id.toString(), orderNo: order.orderNo, amount: order.amount, status: oStatus, doneDate: order.doneDate || null },
      });
    }
    out.sort((a, b) => (a.type === 'needReview' ? -1 : a.type === 'needPay' ? 0 : 1) - (b.type === 'needReview' ? -1 : b.type === 'needPay' ? 0 : 1));
    res.json({ ok: true, items: out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===================================================================
// 排班考勤 + 薪酬（V9）：写手自行排班，到点未打卡=旷工，到点须签退
// ===================================================================
// 统一用北京时间（服务器在UTC也正确）
const cnNow = () => new Date(Date.now() + 8 * 3600 * 1000);
const cnDateStr = d => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
const cnTimeStr = d => String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const GRACE = 15;   // 迟到宽限15分钟

// 当天应上班次：单日排班（日历）优先，无覆盖则用每周班表
async function dayPlan(db, userId, date, dow) {
  const ov = await db.collection('schedule_days').findOne({ userId, date });
  if (ov && ov.start && ov.end) return { start: ov.start, end: ov.end, override: true };
  const sched = await db.collection('schedules').findOne({ userId });
  const d = sched && sched.days ? sched.days[dow] : null;
  return (d && d.start && d.end) ? { start: d.start, end: d.end, override: false } : null;
}

// 评估某人今天的考勤状态（惰性计算：任何相关请求都会触发）
async function evalAttendance(db, userId) {
  const cn = cnNow();
  const date = cnDateStr(cn);
  const day = await dayPlan(db, userId, date, String(cn.getUTCDay()));
  if (!day) return;
  const nowMin = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  const startMin = toMin(day.start), endMin = toMin(day.end);
  let att = await db.collection('attendance').findOne({ userId, date });
  if (!att) {
    if (nowMin > startMin + GRACE) {
      await db.collection('attendance').insertOne({
        userId, date, planStart: day.start, planEnd: day.end,
        clockIn: null, clockOut: null, status: '旷工', updatedAt: new Date(),
      });
      // 旷工自动下线（在班标识不残留）
      const u = await db.collection('users').findOneAndUpdate(
        { _id: new ObjectId(userId), shift: true }, { $set: { shift: false } }, { returnDocument: 'after' });
      if (u) io.emit('presence', { userId, shift: false, sockOnline: !!u.sockOnline });
    }
    return;
  }
  if (att.clockIn && !att.clockOut && nowMin > endMin + 30) {
    await db.collection('attendance').updateOne({ _id: att._id }, { $set: { status: '未签退', updatedAt: new Date() } });
    // 到点未签退超过30分钟，自动置为下班（避免"在班"标识一直挂着）
    const u = await db.collection('users').findOneAndUpdate(
      { _id: new ObjectId(userId), shift: true }, { $set: { shift: false } }, { returnDocument: 'after' });
    if (u) io.emit('presence', { userId, shift: false, sockOnline: !!u.sockOnline });
  }
}
// 排班：写手自行设置每周班表（0=周日…6=周六；null=休）
app.get('/api/schedule', auth, async (req, res) => {
  const db = await getDb();
  const uid = req.user.role === 'admin' && req.query.userId ? String(req.query.userId) : req.user.id;
  await evalAttendance(db, uid);
  const sched = await db.collection('schedules').findOne({ userId: uid });
  res.json({ ok: true, schedule: sched ? sched.days : null });
});
app.post('/api/schedule', auth, async (req, res) => {
  try {
    const db = await getDb();
    const days = req.body?.days || {};
    for (const k of Object.keys(days)) {
      if (!['0', '1', '2', '3', '4', '5', '6'].includes(k)) return res.status(400).json({ ok: false, error: '非法星期' });
      if (days[k] && (!/^\d{2}:\d{2}$/.test(days[k].start || '') || !/^\d{2}:\d{2}$/.test(days[k].end || ''))) {
        return res.status(400).json({ ok: false, error: '时间格式应为 HH:MM' });
      }
    }
    await db.collection('schedules').updateOne({ userId: req.user.id }, { $set: { days, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 单日排班（日历视图）：写手提前一天安排具体某天的班次（小时级）
app.get('/api/schedule/days', auth, async (req, res) => {
  try {
    const db = await getDb();
    if (!/^\d{4}-\d{2}$/.test(String(req.query.ym || ''))) return res.status(400).json({ ok: false, error: '月份格式应为 YYYY-MM' });
    const uid = req.user.role === 'admin' && req.query.userId ? String(req.query.userId) : req.user.id;
    const rows = await db.collection('schedule_days')
      .find({ userId: uid, date: { $regex: '^' + req.query.ym } })
      .project({ date: 1, start: 1, end: 1, _id: 0 }).toArray();
    res.json({ ok: true, days: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/schedule/day', auth, async (req, res) => {
  try {
    const db = await getDb();
    const date = String(req.body?.date || '');
    const start = String(req.body?.start || '').trim();
    const end = String(req.body?.end || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: '日期格式应为 YYYY-MM-DD' });
    // 排班需提前一天：只允许排「明天及以后」
    if (date <= cnDateStr(cnNow())) return res.status(400).json({ ok: false, error: '排班需提前一天，只能安排明天及以后的班次' });
    if (!start && !end) {   // 清空 = 当天休息
      await db.collection('schedule_days').deleteOne({ userId: req.user.id, date });
      return res.json({ ok: true, cleared: true });
    }
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return res.status(400).json({ ok: false, error: '时间格式应为 HH:MM' });
    if (toMin(end) <= toMin(start)) return res.status(400).json({ ok: false, error: '下班时间要晚于上班时间' });
    await db.collection('schedule_days').updateOne(
      { userId: req.user.id, date },
      { $set: { userId: req.user.id, date, start, end, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 打卡上班
app.post('/api/attendance/clockin', auth, async (req, res) => {
  try {
    const db = await getDb();
    await evalAttendance(db, req.user.id);
    const cn = cnNow();
    const date = cnDateStr(cn), time = cnTimeStr(cn);
    const sched = await db.collection('schedules').findOne({ userId: req.user.id });
    const day = await dayPlan(db, req.user.id, date, String(cn.getUTCDay()));
    const exist = await db.collection('attendance').findOne({ userId: req.user.id, date });
    if (exist && exist.clockIn) return res.status(400).json({ ok: false, error: '今天已打过上班卡（' + exist.clockIn + '）' });
    let status = '出勤';
    if (day) {
      const nowMin = cn.getUTCHours() * 60 + cn.getUTCMinutes();
      const startMin = toMin(day.start);
      if (nowMin > startMin + GRACE) status = '旷工';
      else if (nowMin > startMin) status = '迟到';
    }
    const doc = {
      userId: req.user.id, date, planStart: day ? day.start : null, planEnd: day ? day.end : null,
      clockIn: time, clockOut: null, status, updatedAt: new Date(),
    };
    if (exist) await db.collection('attendance').updateOne({ _id: exist._id }, { $set: doc });
    else await db.collection('attendance').insertOne(doc);
    await db.collection('users').updateOne({ _id: req.user._id }, { $set: { shift: true } });
    io.emit('presence', { userId: req.user.id, shift: true, sockOnline: true });
    res.json({ ok: true, attendance: doc });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 打卡下班（到点须签退；早退会被记录）
app.post('/api/attendance/clockout', auth, async (req, res) => {
  try {
    const db = await getDb();
    const cn = cnNow();
    const date = cnDateStr(cn), time = cnTimeStr(cn);
    const att = await db.collection('attendance').findOne({ userId: req.user.id, date });
    if (!att || !att.clockIn) return res.status(400).json({ ok: false, error: '今天还没打上班卡' });
    if (att.clockOut) return res.status(400).json({ ok: false, error: '今天已签退（' + att.clockOut + '）' });
    let status = '出勤';
    if (att.planEnd && toMin(time) < toMin(att.planEnd)) status = '早退';
    await db.collection('attendance').updateOne({ _id: att._id }, { $set: { clockOut: time, status } });
    await db.collection('users').updateOne({ _id: req.user._id }, { $set: { shift: false } });
    io.emit('presence', { userId: req.user.id, shift: false, sockOnline: true });
    res.json({ ok: true, clockOut: time, status });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 考勤记录（本人或管理员查指定写手）
app.get('/api/attendance', auth, async (req, res) => {
  try {
    const db = await getDb();
    await evalAttendance(db, req.user.id);
    const uid = req.user.role === 'admin' && req.query.userId ? String(req.query.userId) : req.user.id;
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : null;
    const q = { userId: uid };
    if (month) q.date = { $regex: '^' + month };
    const rows = await db.collection('attendance').find(q).sort({ date: -1 }).limit(100).toArray();
    res.json({ ok: true, rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 薪酬（按派单卡统计：已完成=已到手；待打款=审核通过待打款；其余在途；已驳回/已拒绝不计钱）
app.get('/api/payroll', auth, async (req, res) => {
  try {
    const db = await getDb();
    const uid = req.user.role === 'admin' && req.query.userId ? String(req.query.userId) : req.user.id;
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : cnDateStr(cnNow()).slice(0, 7);
    const cards = (await db.collection('cards').find({ to: uid }).sort({ createdAt: -1 }).limit(300).toArray()).map(normCard);
    const rows = cards.filter(c => (c.createdAt ? cnDateStr(c.createdAt) : '').startsWith(month));
    const tot = { paid: 0, pending: 0, ongoing: 0, done: 0, pendingCnt: 0, ongoingCnt: 0 };
    rows.forEach(c => {
      if (c.status === '已完成') { tot.paid += c.reward; tot.done++; }
      else if (c.status === '待打款') { tot.pending += c.reward; tot.pendingCnt++; }
      else if (c.status === '已接单' || c.status === '待接单' || c.status === '待审核') { tot.ongoing += c.reward; tot.ongoingCnt++; }
    });
    ['paid', 'pending', 'ongoing'].forEach(k => tot[k] = Math.round(tot[k] * 100) / 100);
    res.json({ ok: true, month, cards: rows, totals: tot });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- WebSocket 实时推送 ----------
// 真实在线以内存连接表为准（一人多开=任一连接在线即在在线），不再信任数据库里的 sockOnline
const onlineMap = new Map();   // userId -> Set(socketId)
io.use((socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth?.token || '', JWT_SECRET);
    socket.userId = payload.id; socket.role = payload.role;
    next();
  } catch (e) { next(new Error('auth failed')); }
});
io.on('connection', async (socket) => {
  socket.join('user:' + socket.userId);
  if (socket.role === 'admin') socket.join('admins');
  try {
    if (!onlineMap.has(socket.userId)) onlineMap.set(socket.userId, new Set());
    onlineMap.get(socket.userId).add(socket.id);
    const firstConn = onlineMap.get(socket.userId).size === 1;
    const db = await getDb();
    if (firstConn) await db.collection('users').updateOne({ _id: new ObjectId(socket.userId) }, { $set: { sockOnline: true } });
    const u = await db.collection('users').findOne({ _id: new ObjectId(socket.userId) });
    io.emit('presence', { userId: socket.userId, shift: !!u?.shift, sockOnline: true });
  } catch (e) {}
  socket.on('disconnect', async () => {
    try {
      const set = onlineMap.get(socket.userId);
      if (set) { set.delete(socket.id); if (!set.size) onlineMap.delete(socket.userId); }
      if (set && set.size) return;   // 还有其他标签页在线，不算下线
      const db = await getDb();
      await db.collection('users').updateOne({ _id: new ObjectId(socket.userId) }, { $set: { sockOnline: false } });
      io.emit('presence', { userId: socket.userId, sockOnline: false });
    } catch (e) {}
  });
});

// ---------- 定时清理：附件3天销毁；消息=双方已读3天清理、未读30天兜底清理 ----------
const FILE_RETAIN_DAYS = 3, MSG_READ_RETAIN_DAYS = 3, MSG_UNREAD_RETAIN_DAYS = 30;
async function cleanupOldData() {
  try {
    const db = await getDb();
    const bucket = new GridFSBucket(db);
    const cutoff = new Date(Date.now() - FILE_RETAIN_DAYS * 24 * 3600 * 1000);
    const old = await db.collection('fs.files').find({ uploadDate: { $lt: cutoff } }).project({ _id: 1 }).toArray();
    for (const f of old) { try { await bucket.delete(f._id); } catch (e) {} }
    if (old.length) console.log('[清理] 已删除', old.length, '个超过' + FILE_RETAIN_DAYS + '天的聊天附件');
    // 已读消息3天后清理（省库）；未读兜底30天，防止漏看的信息凭空消失
    const readCut = new Date(Date.now() - MSG_READ_RETAIN_DAYS * 24 * 3600 * 1000);
    const unreadCut = new Date(Date.now() - MSG_UNREAD_RETAIN_DAYS * 24 * 3600 * 1000);
    const r1 = await db.collection('messages').deleteMany({ read: true, createdAt: { $lt: readCut } });
    const r2 = await db.collection('messages').deleteMany({ read: { $ne: true }, createdAt: { $lt: unreadCut } });
    if (r1.deletedCount || r2.deletedCount) console.log('[清理] 消息清理：已读', r1.deletedCount, '条，未读过期', r2.deletedCount, '条');
  } catch (e) { console.error('[清理] 失败:', e.message); }
}
setTimeout(cleanupOldData, 15 * 1000);                 // 启动后15秒清一次
setInterval(cleanupOldData, 6 * 3600 * 1000);          // 之后每6小时清一次

server.listen(CONFIG.port, () => {
  console.log(`订单统计系统V9已启动: http://localhost:${CONFIG.port}（含派单模块）`);
});
