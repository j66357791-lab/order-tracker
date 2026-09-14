// routes/orders.js — 台账订单 CRUD
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
import { ObjectId } from 'mongodb';

export default function mount(ctx) {
  const { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket } = ctx;
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
}
