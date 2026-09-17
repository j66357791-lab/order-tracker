// routes/gameadmin.js — 活动数据/维护/发钥匙/清理
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
import { ObjectId } from 'mongodb';

export default function mount(ctx) {
  const { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, selfUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket, rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday, CONTRACT_VERSION, CONTRACT_TITLE, CONTRACT_TEXT, unfreezeRedpackets } = ctx;
// 【2026-09-12】管理员：活动数据总览
app.get('/api/admin/activity-stats', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    // 【2026-09-14 修复】签到统计用北京时间口径（旧代码 UTC 日期，晚8点后统计错位一天）
    const today = cnDayStr(new Date());
    const totalPlayers = await db.collection('game_profiles').countDocuments();
    const playingSessions = await db.collection('game_sessions').countDocuments({ status: { $in: ['playing','wave_done'] } });
    const agg = await db.collection('game_profiles').aggregate([
      { $group: { _id: null, total: { $sum: '$totalGames' }, totalKeys: { $sum: '$keys' }, totalBalls: { $sum: '$balls' } } }
    ]).toArray();
    const todayCheckins = await db.collection('checkin_records').countDocuments({ date: today });
    res.json({
      ok: true,
      game: { totalPlayers, playingSessions, totalGames: agg[0]?.total || 0, totalKeysLeft: agg[0]?.totalKeys || 0, totalBallsLeft: agg[0]?.totalBalls || 0 },
      checkin: { today: todayCheckins },
    });
  } catch(e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});






// 【2026-09-12】活动维护开关
app.get('/api/admin/activity-maintenance', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const cfg = await db.collection('config').findOne({ key: 'game_maintenance' });
    res.json({ ok: true, maintenance: cfg ? cfg.value : false });
  } catch(e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

app.post('/api/admin/activity-maintenance', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const { maintenance } = req.body;
    await db.collection('config').updateOne({ key: 'game_maintenance' }, { $set: { value: !!maintenance, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true, maintenance: !!maintenance });
  } catch(e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// 【2026-09-12】管理员：清空所有用户的钥匙
app.post('/api/admin/reset-all-keys', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.collection('game_profiles').updateMany({}, { $set: { keys: 0 } });
    res.json({ ok: true, modified: r.modifiedCount });
  } catch(e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// 【2026-09-12】管理员：列出所有用户
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    // 【2026-09-17 安全修复】原投影写的是 password:0，但字段名是 passwordHash，等于没排除——
    // 接口曾把全部用户的 bcrypt 哈希、身份证哈希、支付宝账号一次性返回
    // 【终审修正】补排序：自然序在文档频繁 update 后不可靠，按注册时间倒序才是"最近注册的 50 个"
    const users = await db.collection('users').find({}, { projection: {
      passwordHash: 0, alipay: 0, 'realname.idHash': 0,
    } }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json({ ok: true, users });
  } catch(e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// 【2026-09-12】管理员：根据手机号查用户ID
app.get('/api/admin/find-user/:phone', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    // 【2026-09-14 修复】本系统没有 users.phone 字段——手机号即登录用户名（username）；
    // 旧代码查 phone 永远 404，管理端"查找用户发放道具"整条链路是坏的
    const key = String(req.params.phone || '').trim();
    const u = await db.collection('users').findOne({ username: key }) ||
      await db.collection('users').findOne({ username: key.toLowerCase() }) ||
      (/^\d{7}$/.test(key) ? await db.collection('users').findOne({ uid: key }) : null);
    if (!u) return res.status(404).json({ ok: false, error: '未找到该手机号/工号对应的用户' });
    res.json({ ok: true, user: { _id: u._id.toString(), phone: u.username, name: u.displayName || '', uid: u.uid || '' } });
  } catch(e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// 【2026-09-12】管理员：游戏道具发放/收回/查询
app.post('/api/admin/game-grant', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const { userId, item, amount } = req.body;
    if (!userId || !item) return res.status(400).json({ ok: false, error: '缺少参数' });
    const validItems = ['keys','balls','frags','revives','bagS','bagM','bagL'];
    if (!validItems.includes(item)) return res.status(400).json({ ok: false, error: '无效道具类型' });
    // 【2026-09-17 安全修复】校验数量为有限数值并限制单次幅度，防止 NaN 报错或一次刷出巨额道具
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 100000) {
      return res.status(400).json({ ok: false, error: '数量需为有限数字（单次±10万以内）' });
    }
    const update = { $inc: { [item]: amt }, $set: { updatedAt: new Date() } };
    const p = await db.collection('game_profiles').findOneAndUpdate(
      { userId: String(userId) }, update, { returnDocument: 'after', upsert: true }
    );
    const profile = p.value || p;
    await db.collection('game_logs').insertOne({
      userId: String(userId), action: 'admin_grant', detail: { item, amount: amt, by: req.user.username || String(req.user._id) }, createdAt: new Date()
    });
    res.json({ ok: true, profile: profile });
  } catch(e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// 【2026-09-12】管理员：查询某用户游戏道具
app.get('/api/admin/game-profile/:userId', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const p = await db.collection('game_profiles').findOne({ userId: req.params.userId });
    res.json({ ok: true, profile: p || null });
  } catch(e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// 【2026-09-12】管理员：清理所有进行中的游戏会话（退还钥匙）
app.post('/api/admin/game-cleanup', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const sessions = await db.collection('game_sessions').find({ status: { $in: ['playing','wave_done'] } }).toArray();
    for (const s of sessions) {
      await db.collection('game_sessions').updateOne({ _id: s._id }, { $set: { status: 'aborted', endedAt: new Date() } });
      await db.collection('game_profiles').updateOne({ userId: s.userId }, { $inc: { keys: 1 } });
    }
    res.json({ ok: true, cleaned: sessions.length });
  } catch(e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// 【2026-09-12】挂载魔法翻翻乐游戏模块
}
