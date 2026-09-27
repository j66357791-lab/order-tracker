// routes/worktime.js — 排班/打卡/薪资/socket
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
import { ObjectId, GridFSBucket } from 'mongodb';
// 【v26.74 多实例必修】清理任务改为带租约的周期任务
import { everyJob } from '../lib/jobs.js';

export default function mount(ctx) {
  const { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, selfUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket, rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday, CONTRACT_VERSION, CONTRACT_TITLE, CONTRACT_TEXT, unfreezeRedpackets } = ctx;
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
      // 【2026-09-27 审查修复 P2-8】并发首次访问会同时走到这里，第二条撞 (userId,date)
      // 唯一索引：撞上说明别人已经补记了，当无事发生即可（原先直接抛错走 500）
      await db.collection('attendance').insertOne({
        userId, date, planStart: day.start, planEnd: day.end,
        clockIn: null, clockOut: null, status: '旷工', updatedAt: new Date(),
      }).catch(e => { if (e && e.code !== 11000) throw e; });
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
  // 【2026-09-24 修复】补 try/catch——原 handler 无任何异常保护，
  // Express 4 不捕获 async rejection，getDb/evalAttendance 抛错会变成 unhandledRejection 直接崩进程
  try {
    const db = await getDb();
    const uid = req.user.role === 'admin' && req.query.userId ? String(req.query.userId) : req.user.id;
    await evalAttendance(db, uid);
    const sched = await db.collection('schedules').findOne({ userId: uid });
    res.json({ ok: true, schedule: sched ? sched.days : null });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
app.post('/api/schedule', auth, async (req, res) => {
  try {
    const db = await getDb();
    const days = req.body?.days || {};
    const cleanDays = {};
    for (const k of Object.keys(days)) {
      if (!['0', '1', '2', '3', '4', '5', '6'].includes(k)) return res.status(400).json({ ok: false, error: '非法星期' });
      if (days[k] && (!/^\d{2}:\d{2}$/.test(days[k].start || '') || !/^\d{2}:\d{2}$/.test(days[k].end || ''))) {
        return res.status(400).json({ ok: false, error: '时间格式应为 HH:MM' });
      }
      // 【2026-09-24 修复】重建干净对象入库：原先 days[k] 整个对象原样落库，任意额外字段会被一并写入
      cleanDays[k] = days[k] ? { start: days[k].start, end: days[k].end } : null;
    }
    await db.collection('schedules').updateOne({ userId: req.user.id }, { $set: { days: cleanDays, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
    // 【2026-09-26 批次2】两处修正（配套 attendance 的 (userId,date) 唯一索引，见 lib/db.js）：
    //   ① 原"先查后插"非原子，双击会产生两条同日记录，考勤/旷工判定随之错乱；
    //   ② 原来 exist 分支用整包 { $set: doc } 覆盖，而 doc 里 clockOut: null ——
    //      已签退的人只要再触发一次上班卡（脚本重放、页面重复提交）就会把签退记录抹掉，
    //      状态也被改回"出勤"。现在过滤条件钉死 clockIn 为空，只补上班卡、绝不碰已签退的字段。
    try {
      const r = await db.collection('attendance').updateOne(
        { userId: req.user.id, date, clockIn: null },
        { $set: { clockIn: time, status, planStart: doc.planStart, planEnd: doc.planEnd, updatedAt: doc.updatedAt },
          $setOnInsert: { userId: req.user.id, date, createdAt: new Date() } },
        { upsert: true });
      if (r.matchedCount === 0 && r.upsertedCount === 0) {
        return res.status(409).json({ ok: false, error: '今天已打过上班卡，请刷新查看' });
      }
    } catch (e) {
      if (e && e.code === 11000) {
        const cur = await db.collection('attendance').findOne({ userId: req.user.id, date });
        return res.status(400).json({ ok: false, error: '今天已打过上班卡（' + ((cur && cur.clockIn) || '--') + '）' });
      }
      throw e;
    }
    await db.collection('users').updateOne({ _id: req.user._id }, { $set: { shift: true } });
    io.emit('presence', { userId: req.user.id, shift: true, sockOnline: true });
    res.json({ ok: true, attendance: doc });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
    // 【2026-09-26 批次2】带 clockOut:null 条件，避免并发双击把第一次的签退时间覆盖掉
    const r = await db.collection('attendance').updateOne(
      { _id: att._id, clockOut: null }, { $set: { clockOut: time, status, updatedAt: new Date() } });
    if (!r.matchedCount) return res.status(409).json({ ok: false, error: '今天已签退，请刷新查看' });
    await db.collection('users').updateOne({ _id: req.user._id }, { $set: { shift: false } });
    io.emit('presence', { userId: req.user.id, shift: false, sockOnline: true });
    res.json({ ok: true, clockOut: time, status });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
    // 【2026-09-24 资金安全修复】只清理聊天附件（原先无差别删除 fs 桶 3 天前的所有文件——
    //   充值截图 kind:'recharge' 是财务凭证，3 天后 404 会让审计链条断裂、历史截图全部裂图）
    // 【2026-09-26 修正】那条修复用的是「排除单个 kind」的黑名单写法：
    //   { 'metadata.kind': { $ne: 'recharge' } }
    // 而充值还有另一个 kind —— recharge_qr（收款二维码，recharge.js 上传时写的），
    // 它 ≠ 'recharge' 所以照样被删：管理员上传的收款码 3 天后消失，cfg.qrFileId 变悬空引用，
    // GET /api/recharge/qr 404 → **全站充值页没有收款码**（收入通道挂掉，且现场看起来像"二维码坏了"）。
    // 改为白名单：只有"明确是聊天附件"的才清理，将来新增任何 kind 都不会被误删。
    const old = await db.collection('fs.files')
      .find({
        uploadDate: { $lt: cutoff },
        $or: [{ 'metadata.kind': { $exists: false } }, { 'metadata.kind': null }, { 'metadata.kind': 'chat' }],
      }).project({ _id: 1, filename: 1 }).toArray();
    let deleted = 0, failed = 0;
    for (const f of old) {
      try { await bucket.delete(f._id); deleted++; }
      // 原先是 catch(e){} 静默吞掉：删不掉的孤儿文件永远不会有人知道
      catch (e) { failed++; console.warn('[清理] 删除失败', f.filename || String(f._id), e?.message || e); }
    }
    if (deleted) console.log('[清理] 已删除', deleted, '个超过' + FILE_RETAIN_DAYS + '天的聊天附件' + (failed ? '（另有 ' + failed + ' 个删除失败）' : ''));
    // 已读消息3天后清理（省库）；未读兜底30天，防止漏看的信息凭空消失
    const readCut = new Date(Date.now() - MSG_READ_RETAIN_DAYS * 24 * 3600 * 1000);
    const unreadCut = new Date(Date.now() - MSG_UNREAD_RETAIN_DAYS * 24 * 3600 * 1000);
    const r1 = await db.collection('messages').deleteMany({ read: true, createdAt: { $lt: readCut } });
    const r2 = await db.collection('messages').deleteMany({ read: { $ne: true }, createdAt: { $lt: unreadCut } });
    if (r1.deletedCount || r2.deletedCount) console.log('[清理] 消息清理：已读', r1.deletedCount, '条，未读过期', r2.deletedCount, '条');
  } catch (e) { console.error('[清理] 失败:', e.message); }
}
// 【v26.74】改为租约任务：原来每个实例各自每 6 小时清一遍。删除本身是幂等的（第二次删不到东西），
// 但 GridFS 清理会真的并发跑，配合"下载流未监听 error"(#53) 容易把别人正在下载的文件删掉。
everyJob('worktime:cleanup', 6 * 3600 * 1000, cleanupOldData, { firstDelayMs: 15 * 1000, getDb });
}
