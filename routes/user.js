// routes/user.js — 写手资料/等级/钱包/提现/在班/好友
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
import { ObjectId } from 'mongodb';

export default function mount(ctx) {
  const { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket, rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday, CONTRACT_VERSION, CONTRACT_TITLE, CONTRACT_TEXT, unfreezeRedpackets } = ctx;
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
    // 【2026-09-14 需求】单单拆红包冻结金额：钱包页展示 总金额（其中xx待解冻）
    const frozenRows = (await db.collection('redpacket_records').find({ userId: req.user.id, status: '冻结' }).sort({ createdAt: 1 }).toArray())
      .map(r => ({ cardId: String(r.cardId), amount: r.amount, title: r.title, createdAt: r.createdAt }));
    const frozenAmount = Math.round(frozenRows.reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100;
    const total = Math.round((balance + frozenAmount) * 100) / 100;
    // 本月预计奖励
    const ym = ymOf(cnNow());
    const cards = await db.collection('cards').find({ to: req.user.id, status: '已完成' }).toArray();
    const paidThisMonth = cards.filter(c => c.paidAt && ymOf(new Date(new Date(c.paidAt).getTime() + 8 * 3600 * 1000)) === ym)
      .reduce((s, c) => s + (c.reward || 0), 0);
    res.json({
      ok: true, level, balance, frozenAmount, total, frozen: frozenRows, stats: st,
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
      // 【2026-09-14】快照本次提现对应的派单卡（审批时按快照打款，避免申请后新增单子被误裹挟）
      doc.cardIds = cards.map(c => c._id.toString());
    }
    const r = await db.collection('withdrawals').insertOne(doc);
    res.json({ ok: true, _id: r.insertedId.toString(), amount: doc.amount, type });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/withdraw', auth, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection('withdrawals').find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(30).toArray();
    res.json({ ok: true, rows: rows.map(w => ({ _id: w._id.toString(), type: w.type, amount: w.amount, status: w.status, reason: w.reason || null, createdAt: w.createdAt })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- 【2026-09-14 新增】提现审批（管理端） ----------
// 列表：支持 status/type/q 筛选，附各状态数量
app.get('/api/admin/withdrawals', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const status = String(req.query.status || '');
    const type = String(req.query.type || '');
    const q = String(req.query.q || '').trim().toLowerCase();
    const filter = {};
    if (['待处理', '已打款', '已驳回'].includes(status)) filter.status = status;
    if (['bonus', 'order'].includes(type)) filter.type = type;
    const rows = (await db.collection('withdrawals').find(filter).sort({ createdAt: -1 }).limit(300).toArray());
    let list = rows;
    if (q) list = rows.filter(w =>
      (w.displayName || '').toLowerCase().includes(q) ||
      (w.alipay && (String(w.alipay.account || '').includes(q) || String(w.alipay.name || '').toLowerCase().includes(q))));
    const [pending, paid, rejected] = await Promise.all([
      db.collection('withdrawals').countDocuments({ status: '待处理' }),
      db.collection('withdrawals').countDocuments({ status: '已打款' }),
      db.collection('withdrawals').countDocuments({ status: '已驳回' }),
    ]);
    res.json({ ok: true, withdrawals: list, stats: { pending, paid, rejected } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 审批打款：标记已打款；订单型提现同时把这批派单卡结清（台账同步 + 红包解冻）
app.post('/api/admin/withdrawals/:id/pay', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const w = await db.collection('withdrawals').findOne({ _id: new ObjectId(req.params.id) });
    if (!w) return res.status(404).json({ ok: false, error: '提现申请不存在' });
    if (w.status !== '待处理') return res.status(400).json({ ok: false, error: '该申请已处理过（' + w.status + '）' });
    const note = String(req.body?.note || '').slice(0, 120);
    let paidCards = 0;
    if (w.type === 'order') {
      // 快照对应的派单卡 → 逐张结清（仍处于待打款的才结）
      const ids = (w.cardIds || []).filter(x => ObjectId.isValid(x)).map(x => new ObjectId(x));
      const cards = ids.length ? await db.collection('cards').find({ _id: { $in: ids }, status: '待打款' }).toArray() : [];
      for (const c of cards) {
        await db.collection('cards').updateOne(
          { _id: c._id, status: '待打款' },
          { $set: { status: '已完成', paidAt: new Date(), paidVia: 'withdrawal:' + w._id.toString() } });
        if (c.orderId && ObjectId.isValid(c.orderId)) {
          await db.collection(CONFIG.collection).updateOne(
            { _id: new ObjectId(c.orderId) },
            { $set: { status: '已结算', updatedAt: new Date() } });
        }
        notify(c.to, 'card', { ...c, status: '已完成' });
        paidCards++;
      }
      if (paidCards) cacheClear();
      // 关联订单完结 → 红包自动解冻
      try { await unfreezeRedpackets(db, w.userId); } catch (e) { console.warn('[红包] 提现审批解冻失败:', e.message); }
    }
    const r = await db.collection('withdrawals').findOneAndUpdate(
      { _id: w._id, status: '待处理' },
      { $set: { status: '已打款', paidAt: new Date(), note, paidCards } },
      { returnDocument: 'after' });
    res.json({ ok: true, withdrawal: r, paidCards });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 驳回：写明原因（写手端可见），激励型余额随之释放可再次发起
app.post('/api/admin/withdrawals/:id/reject', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const reason = String(req.body?.reason || '').slice(0, 120) || '管理员驳回';
    const r = await db.collection('withdrawals').findOneAndUpdate(
      { _id: new ObjectId(req.params.id), status: '待处理' },
      { $set: { status: '已驳回', rejectedAt: new Date(), reason } },
      { returnDocument: 'after' });
    if (!r) return res.status(400).json({ ok: false, error: '该申请不存在或已处理' });
    res.json({ ok: true, withdrawal: r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
}
