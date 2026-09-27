// routes/orders.js — 台账订单 CRUD
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
import { ObjectId } from 'mongodb';

export default function mount(ctx) {
  const { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, selfUser, ObjectId, cacheGet, cacheSet, cacheClear, cacheClearPrefix, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket, rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday, CONTRACT_VERSION, CONTRACT_TITLE, CONTRACT_TEXT, unfreezeRedpackets } = ctx;
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
      // 【v20.8】搜索走后端：原来前端拉全量订单在浏览器里过滤。
      // 匹配口径与前台一致 —— 订单号 或 备注 模糊命中（大小写不敏感）。
      const rx = { $regex: String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      query.$or = [{ orderNo: rx }, { note: rx }];
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 500);
    // 【v20.8】按时间范围取数：前端传 month(YYYY-MM) / from / to 时只取该范围（台账页用它避免每次全量）
    if (req.query.from || req.query.to) {
      const rng = {};
      if (req.query.from) rng.$gte = String(req.query.from);
      if (req.query.to) rng.$lte = String(req.query.to);
      query.date = Object.assign(query.date || {}, rng);
    }
    // 【2026-09-26 批次2 正确性修复】缓存键必须包含 limit。
    // 原先键只有 query 对象、不含 limit：只要先发过一次 ?limit=1（预览/探针请求），
    // 这条只有 1 条结果的数据就被挂在"该筛选条件"的键下缓存 60 秒；
    // 台账页随后带默认 limit=500 命中同一个键 → 整页只拿到 1 条订单，
    // 而 KPI、汇总、图表全部基于这 1 条渲染 —— 管理员会据此做出结算判断。
    const cacheKey = 'orders:' + JSON.stringify({ query, limit });
    let orders = cacheGet(cacheKey);
    if (!orders) {
      orders = await db.collection(CONFIG.collection)
        .find(query).sort({ date: -1, _id: -1 }).limit(limit).toArray();
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
      cacheSet(cacheKey, orders);
    }
    res.json({ ok: true, orders });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
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
    cacheClearPrefix('orders:');   // 【2026-09-26】原先是全量 clear（把所有筛选组合一把清空，
                                      // 紧接着每个台账请求都穿透到库），改成只失效订单缓存
    res.json({ ok: true, _id: r.insertedId, order: doc });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
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
    cacheClearPrefix('orders:');   // 【2026-09-26】原先是全量 clear（把所有筛选组合一把清空，
                                      // 紧接着每个台账请求都穿透到库），改成只失效订单缓存
    res.json({ ok: true, order: r });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
});

// 删除
app.delete('/api/orders/:id', auth, adminOnly, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, error: '无效的订单ID' });
  try {
    const db = await getDb();
    const r = await db.collection(CONFIG.collection).deleteOne({ _id: new ObjectId(req.params.id) });
    if (r.deletedCount === 0) return res.status(404).json({ ok: false, error: '订单不存在' });
    cacheClearPrefix('orders:');   // 【2026-09-26】原先是全量 clear（把所有筛选组合一把清空，
                                      // 紧接着每个台账请求都穿透到库），改成只失效订单缓存
    res.json({ ok: true });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
});

// 批量导入（JSON数组，用于Excel迁移）
app.post('/api/orders/batch', auth, adminOnly, async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [];
    if (!list.length) return res.status(400).json({ ok: false, error: '没有数据' });
    // 一次灌几万条会把请求体、文档数组与 insertMany 结果全堆在内存里，给个明确上限让人分批
    if (list.length > 2000) return res.status(400).json({ ok: false, error: '单次最多导入 2000 条，请分批（同一批次可按订单号安全重放）' });
    const docs = []; const errs = [];
    list.forEach((item, i) => {
      const { doc, errors } = parseOrder(item);
      if (errors) errs.push(`第${i + 1}条: ${errors.join('；')}`);
      else { doc.createdAt = new Date(); docs.push(doc); }
    });
    if (errs.length) return res.status(400).json({ ok: false, error: errs.join(' | ') });
    const db = await getDb();
    // 【2026-09-26 批次2】原先 orderNo 没有唯一约束、insertMany 又是 ordered 模式
    // （中途抛错时前面已入库、响应却是 500），而运营遇到 500 的习惯动作就是"再点一次导入"
    // —— 一次网络抖动就能让台账与利润口径整体翻倍，数据库不会拦。
    // 现在按订单号先查已存在的并跳过，只插新的。
    const nos = [...new Set(docs.map(d => d.orderNo).filter(Boolean))];
    const existed = new Set();
    for (let i = 0; i < nos.length; i += 500) {
      const rows = await db.collection(CONFIG.collection)
        .find({ orderNo: { $in: nos.slice(i, i + 500) } }, { projection: { orderNo: 1 } }).toArray();
      rows.forEach(e => existed.add(e.orderNo));
    }
    const seen = new Set();
    const fresh = docs.filter(d => {
      if (!d.orderNo) return true;                       // 无订单号的行不参与去重（历史允许空）
      if (existed.has(d.orderNo) || seen.has(d.orderNo)) return false;
      seen.add(d.orderNo); return true;
    });
    const skipped = docs.length - fresh.length;
    let inserted = 0;
    if (fresh.length) {
      // ordered:false —— 单条失败不中断整批，避免"半截入库 + 整体报 500"
      try {
        const r = await db.collection(CONFIG.collection).insertMany(fresh, { ordered: false });
        inserted = r.insertedCount;
      } catch (e) {
        if (e && (e.code === 12587 || Array.isArray(e.writeErrors))) {
          inserted = (e.result && e.result.insertedCount) || 0;   // 部分成功：已写入的照实回报
          console.warn('[台账] 批量导入部分失败：', (e.writeErrors || []).length, '条被拒');
        } else throw e;
      }
    }
    if (inserted) cacheClearPrefix('orders:');
    res.json({ ok: true, inserted, skipped,
      message: skipped ? `新增 ${inserted} 条，跳过 ${skipped} 条重复订单号` : `新增 ${inserted} 条` });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
});
}
