// routes/worktime.js — 排班/打卡/薪资/socket
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
import { ObjectId, GridFSBucket } from 'mongodb';

export default function mount(ctx) {
  const { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket, rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday, CONTRACT_VERSION, CONTRACT_TITLE, CONTRACT_TEXT, unfreezeRedpackets } = ctx;
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
}
