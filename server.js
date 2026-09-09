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
const FILE_LIMIT = 25 * 1024 * 1024;   // 单文件上限 25MB

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
  return { id: u._id.toString(), username: u.username, role: u.role,
           displayName: u.displayName, shift: !!u.shift, sockOnline: !!u.sockOnline,
           alipay: u.alipay || null };
}
// 写手绑定收款方式（支付宝：姓名+账号）
app.put('/api/me/alipay', auth, async (req, res) => {
  try {
    const db = await getDb();
    const name = String(req.body?.name || '').slice(0, 40).trim();
    const account = String(req.body?.account || '').slice(0, 60).trim();
    if (!name || !account) return res.status(400).json({ ok: false, error: '姓名和支付宝账号都必填' });
    await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $set: { alipay: { name, account, updatedAt: new Date() } } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 引用消息字段清洗（text/file消息均可带）
function cleanReplyTo(rt) {
  if (!rt || typeof rt !== 'object') return null;
  const id = String(rt.id || '').slice(0, 40);
  if (!id) return null;
  return { id, fromName: String(rt.fromName || '').slice(0, 40), preview: String(rt.preview || '').slice(0, 80), type: String(rt.type || 'text') };
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
    req.user = { _id: u._id, id: u._id.toString(), role: u.role, username: u.username, displayName: u.displayName, alipay: u.alipay || null };
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
    res.json({ ok: true, token: signToken({ _id: r.insertedId, role: 'admin' }), user: { ...publicUser(doc), id: r.insertedId.toString() } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 登录 / 注册（写手凭邀请码） ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const db = await getDb();
    const { username, password } = req.body || {};
    const u = await db.collection('users').findOne({ username: String(username || '') });
    if (!u || !(await bcrypt.compare(String(password || ''), u.passwordHash))) {
      return res.status(401).json({ ok: false, error: '用户名或密码错误' });
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
    const exists = await db.collection('users').findOne({ username });
    if (exists) return res.status(400).json({ ok: false, error: '用户名已被占用' });
    const doc = {
      username, passwordHash: await bcrypt.hash(String(password), 8),
      displayName: String(displayName || username).slice(0, 20), role: 'writer',
      shift: false, sockOnline: false, email: String(email || '').slice(0, 60),
      createdAt: new Date(),
    };
    const r = await db.collection('users').insertOne(doc);
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
    // 写手：会话对象=管理员
    const admins = await db.collection('users').find({ role: 'admin' }).toArray();
    const list = [];
    for (const a of admins) {
      const conv = pairKey(req.user.id, a._id.toString());
      const last = await db.collection('messages').find({ conversation: conv }).sort({ createdAt: -1 }).limit(1).toArray();
      const unread = await db.collection('messages').countDocuments({ conversation: conv, to: req.user.id, read: false });
      list.push({ user: publicUser(a), unread, last: last[0] || null });
    }
    res.json({ ok: true, chats: list });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 消息列表（自动标已读）
app.get('/api/messages', auth, async (req, res) => {
  try {
    const db = await getDb();
    const peer = String(req.query.peer || '');
    if (!ObjectId.isValid(peer)) return res.status(400).json({ ok: false, error: '无效会话' });
    const conv = pairKey(req.user.id, peer);
    const msgs = await db.collection('messages').find({ conversation: conv }).sort({ createdAt: 1 }).limit(500).toArray();
    await db.collection('messages').updateMany({ conversation: conv, to: req.user.id, read: false }, { $set: { read: true } });
    res.json({ ok: true, messages: msgs });
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
    // 权限：写手只能和管理员聊；管理员可和所有写手聊
    if (req.user.role !== 'admin' && target.role !== 'admin') return res.status(403).json({ ok: false, error: '只能和管理员聊天' });
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
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(f.filename) + '"');
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
    if (req.user.role !== 'admin' && target.role !== 'admin') return res.status(403).json({ ok: false, error: '只能和管理员聊天' });
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

// ---------- 文件3天保留：GridFS 定时清理（聊天附件过期即删，派单卡仅存元数据） ----------
async function cleanupOldFiles() {
  try {
    const db = await getDb();
    const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const bucket = new GridFSBucket(db);
    const old = await db.collection('fs.files').find({ uploadDate: { $lt: cutoff } }).project({ _id: 1 }).toArray();
    for (const f of old) { try { await bucket.delete(f._id); } catch (e) {} }
    if (old.length) console.log('[清理] 已删除', old.length, '个超过3天的聊天附件');
  } catch (e) { console.error('[清理] 文件清理失败:', e.message); }
}
setTimeout(cleanupOldFiles, 15 * 1000);                 // 启动后15秒清一次
setInterval(cleanupOldFiles, 6 * 3600 * 1000);          // 之后每6小时清一次

server.listen(CONFIG.port, () => {
  console.log(`订单统计系统V9已启动: http://localhost:${CONFIG.port}（含派单模块）`);
});
