// routes/cards.js — 派单卡/打款/对账总览
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
import { ObjectId } from 'mongodb';

export default function mount(ctx) {
  const { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket, rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday, CONTRACT_VERSION, CONTRACT_TITLE, CONTRACT_TEXT, unfreezeRedpackets } = ctx;
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
    // 【2026-09-14 需求】关联订单完结（打款/台账已结算）→ 该写手冻结红包自动解冻入账
    let unlockedRedpackets = 0;
    try { unlockedRedpackets = await unfreezeRedpackets(db, card.to); } catch (e) { console.warn('[红包] 打款自动解冻失败:', e.message); }
    notify(card.to, 'card', r); notify(req.user.id, 'card', r);
    res.json({ ok: true, card: r, syncedOrder: syncedOrder ? syncedOrder.value || syncedOrder : null, unlockedRedpackets });
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
    // 【2026-09-14 性能修复】旧代码循环内逐卡 findOne（500 卡 = 500 次 Atlas 往返，
    // 页面要等半分钟起步"卡成狗"）→ 改为一次 $in 批量拉取
    const orderIds = cards.map(c => c.orderId).filter(x => x && ObjectId.isValid(x)).map(x => new ObjectId(x));
    const orderMap = new Map();
    if (orderIds.length) {
      const orders = await db.collection(CONFIG.collection).find({ _id: { $in: orderIds } }).toArray();
      for (const o of orders) orderMap.set(o._id.toString(), o);
    }
    const rows = [];
    let totReward = 0, totShare = 0, totProfit = 0, linked = 0;
    for (const c of cards) {
      const order = c.orderId && ObjectId.isValid(c.orderId) ? (orderMap.get(String(c.orderId)) || null) : null;
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
    // 【2026-09-14 性能修复】同样改为 $in 批量拉取订单
    const cand = cards.filter(c => c.orderId && ObjectId.isValid(c.orderId) && ['待审核', '待打款', '已完成'].includes(c.status));
    const orderMap = new Map();
    if (cand.length) {
      const orders = await db.collection(CONFIG.collection).find({ _id: { $in: cand.map(c => new ObjectId(c.orderId)) } }).toArray();
      for (const o of orders) orderMap.set(o._id.toString(), o);
    }
    const out = [];
    for (const c of cand) {
      const order = orderMap.get(String(c.orderId));
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
}
