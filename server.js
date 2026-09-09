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

// 列表（支持 month=YYYY-MM、status、q 关键词筛选；旧「已交付」自动显示为「待结算」）
app.get('/api/orders', async (req, res) => {
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
      orders = orders.map(o => ({ ...o, status: normalizeStatus(o.status) }));
      cacheSet(JSON.stringify(query), orders);
    }
    res.json({ ok: true, orders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 新增
app.post('/api/orders', async (req, res) => {
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
app.put('/api/orders/:id', async (req, res) => {
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
app.delete('/api/orders/:id', async (req, res) => {
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
app.post('/api/orders/batch', async (req, res) => {
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

app.listen(CONFIG.port, () => {
  console.log(`订单统计系统已启动: http://localhost:${CONFIG.port}`);
});
