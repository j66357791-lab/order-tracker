// routes/gameadmin.js — 活动数据/维护/发钥匙/清理
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
import { ObjectId } from 'mongodb';
import crypto from 'node:crypto';

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

// 【2026-09-18 新增 v20.1】管理员重置用户密码（找回密码场景）
// 说明：密码为 bcrypt 单向哈希存储，明文任何人都不可查看（安全底线）；
// 管理员设置的新密码按主体系哈希（bcrypt(前端SHA-256(新密码))），用户用新密码直接登录
app.post('/api/admin/users/:id/reset-password', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const id = String(req.params.id || '');
    if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: '参数无效' });
    let newPassword = String(req.body?.newPassword || '').trim();
    // 不传则自动生成 12 位临时密码（大写字母 + 数字，易读无歧义字符）
    // 【2026-09-24 安全修复】改用 CSPRNG（crypto.randomInt）且加长到 12 位——
    // 原先 Math.random() 生成的 8 位临时密码熵约 30bit，可被在线快速爆破
    if (!newPassword) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      newPassword = 'Xy' + Array.from({ length: 10 }, () => chars[crypto.randomInt(chars.length)]).join('');
    }
    if (newPassword.length < 8 || newPassword.length > 64) {
      return res.status(400).json({ ok: false, error: '新密码需为 8-64 位' });
    }
    const u = await db.collection('users').findOne({ _id: new ObjectId(id) }, { projection: { username: 1, role: 1 } });
    if (!u) return res.status(404).json({ ok: false, error: '用户不存在' });
    // 与登录体系对齐：登录时前端传 SHA-256(用户输入)，后端 bcrypt 比对——重置时同样存 bcrypt(SHA-256(新密码))
    // 【2026-09-24 安全修复】bcrypt cost 8 → 10
    const passwordHash = await bcrypt.hash(sha256hex(newPassword), 10);
    // 【2026-09-26 批次3】重置密码同时作废所有已签发的令牌：
    // token 有效期 30 天且原先无吊销机制，"帮用户重置密码"这个动作根本踢不掉被盗的会话
    await db.collection('users').updateOne(
      { _id: u._id },
      { $set: { passwordHash, passwordResetAt: new Date(), tokenAfter: new Date(), passwordResetBy: req.user.username || String(req.user._id) } });
    // 审计流水（谁在什么时候重置了谁的密码）
    await db.collection('game_logs').insertOne({
      userId: id, action: 'admin_reset_password',
      detail: { target: u.username, targetRole: u.role, by: req.user.username || String(req.user._id) },
      createdAt: new Date(),
    });
    res.json({ ok: true, tempPassword: newPassword, username: u.username });
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
    // 【v26.71】userId 必须是一个真实存在的账号。下面的写入是 { userId: String(userId) } + upsert，
    // 原本对 userId 毫不校验：管理端「按手机号查人」失败时（500 / 网络抖动）会把手机号原样当 ID 发过来，
    // 于是库里凭空多出一条以 "13800138000" 为键的孤儿档案，接口照样回「发放成功，档案已更新」——
    // 道具实际打给了一个玩家永远查不到的档案，属于静默丢失。
    // 注意：这里只要求「账号存在」，不要求「玩过游戏」，所以给新用户预先建档的用法不受影响。
    if (!/^[0-9a-fA-F]{24}$/.test(String(userId))) {
      return res.status(400).json({ ok: false, error: '用户 ID 不合法：请先用手机号/工号查到玩家再发放，不要直接填手机号' });
    }
    const target = await db.collection('users').findOne({ _id: new ObjectId(String(userId)) }, { projection: { _id: 1, username: 1, role: 1 } });
    if (!target) return res.status(404).json({ ok: false, error: '该用户 ID 在账号表里不存在，已阻止发放（道具未变动）' });
    // 【2026-09-17 安全修复】校验数量为有限数值并限制单次幅度，防止 NaN 报错或一次刷出巨额道具
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 100000) {
      return res.status(400).json({ ok: false, error: '数量需为有限数字（单次±10万以内）' });
    }
    // 【2026-09-24 修复】收回（负数）时校验当前存量足够，防止道具被打成大负数
    if (amt < 0) {
      const cur = await db.collection('game_profiles').findOne({ userId: String(userId) });
      if (cur && (cur[item] || 0) + amt < 0) {
        return res.status(400).json({ ok: false, error: `收回数量超过当前存量（现有 ${cur[item] || 0}）` });
      }
    }
    // 【v23.2】upsert 建档时补全标准字段——否则发给一个从没玩过游戏的玩家，
    // 档案里只有被发放的那一个字段，管理端查询会显示一排 undefined
    const defaults = { keys: 0, balls: 0, frags: 0, revives: 0, bagS: 0, bagM: 0, bagL: 0, totalGames: 0 };
    delete defaults[item];   // 被发放的道具走 $inc，避免和 $setOnInsert 冲突
    const update = {
      $inc: { [item]: amt },
      $set: { updatedAt: new Date() },
      $setOnInsert: Object.assign({ userId: String(userId), createdAt: new Date() }, defaults),
    };
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
    let cleaned = 0;
    for (const s of sessions) {
      // 【2026-09-24 修复】条件更新 + 只有真正把会话置为 aborted 才退钥匙——
      // 原先无条件 $set：会话若恰在清理间隙被玩家正常结算，玩家已领过奖励，这里又退一把钥匙（双发）
      const r = await db.collection('game_sessions').findOneAndUpdate(
        { _id: s._id, status: { $in: ['playing','wave_done'] } },
        { $set: { status: 'aborted', endedAt: new Date() } });
      if (r) {
        await db.collection('game_profiles').updateOne({ userId: s.userId }, { $inc: { keys: 1 } });
        cleaned++;
      }
    }
    res.json({ ok: true, cleaned });
  } catch(e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// ==================== 【2026-09-28】经济总屏（方向三）：灵气/仙玉/钱包/交易所一屏总览 ====================
// 管理员需要一眼看出"今天印了多少、花了多少、水位是否正常"。数据来自 8 个轻量聚合
// （档案/钱包都是小集合；流水查询走 createdAt 索引，7 天窗口可控）。
// 告警三类：负余额（灵气/仙玉/交易所钱包/做市额度）、24h 大额流水（|amount| ≥ 100）。
app.get('/api/game/admin/economy', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const BOT_ID = '__market__';
    const DAY = 86400000;
    const since7 = new Date(Date.now() - 7 * DAY);
    const since1 = new Date(Date.now() - DAY);
    const bigMoveMin = 100;   // 大额异动阈值
    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const dayKey = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+08:00' } };
    const num = f => ({ $cond: [{ $isNumber: f }, f, 0] });

    // ① 存量：档案（灵气/冻结/仙玉）与玩家数
    const [profAgg] = await db.collection('shanhai_profiles').aggregate([
      { $group: { _id: null, players: { $sum: 1 },
        lingqi: { $sum: num('$lingqi') }, lingqiFrozen: { $sum: num('$lingqiFrozen') }, xianyu: { $sum: num('$xianyu') } } },
    ]).toArray();
    // ② 交易所：玩家钱包合计 + 机器人钱包 + 做市额度
    const [exAgg] = await db.collection('shanhai_ex_wallet').aggregate([
      { $group: { _id: null, balance: { $sum: num('$balance') }, frozen: { $sum: num('$frozen') } } },
    ]).toArray();
    const botW = await db.collection('shanhai_ex_wallet').findOne({ userId: BOT_ID });
    const fund = await db.collection('shanhai_market_fund').findOne({ _id: 'market' });
    // ③ 交易所成交（近 7 天按北京日）
    const deals7d = await db.collection('shanhai_ex_deals').aggregate([
      { $match: { createdAt: { $gte: since7 } } },
      { $group: { _id: { day: dayKey }, count: { $sum: 1 }, total: { $sum: num('$total') }, fee: { $sum: num('$fee') } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    // ④ 主站钱包流水（近 7 天：流入/流出，按北京日）
    const wallet7d = await db.collection('wallet_log').aggregate([
      { $match: { createdAt: { $gte: since7 } } },
      { $group: { _id: { day: dayKey },
        inflow: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$amount', 0] }, 0] }, { $ifNull: ['$amount', 0] }, 0] } },
        outflow: { $sum: { $cond: [{ $lt: [{ $ifNull: ['$amount', 0] }, 0] }, { $multiply: [{ $ifNull: ['$amount', 0] }, -1] }, 0] } } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    // ⑤ 提现按状态分布（状态词动态分组，不硬编码）
    const withdrawByStatus = await db.collection('withdrawals').aggregate([
      { $group: { _id: '$status', count: { $sum: 1 }, sum: { $sum: num('$amount') } } },
      { $sort: { count: -1 } },
    ]).toArray();
    // ⑥ 灵气/交易所事件（近 7 天，动作 × 日；只挑资产相关动作，避免日志噪声）
    const logEvents7d = await db.collection('shanhai_logs').aggregate([
      { $match: { createdAt: { $gte: since7 },
        action: { $in: ['lingqi_mine', 'duiduile_claim', 'duiduile_play', 'ex_deposit', 'ex_withdraw', 'exchange_deal', 'exchange_publish', 'exchange_cancel'] } } },
      { $group: { _id: { day: dayKey, action: '$action' }, count: { $sum: 1 },
        gain: { $sum: { $cond: [{ $isNumber: '$detail.gain' }, '$detail.gain', 0] } },
        amount: { $sum: { $cond: [{ $isNumber: '$detail.amount' }, '$detail.amount', 0] } } } },
      { $sort: { '_id.day': 1, '_id.action': 1 } },
    ]).toArray();
    // ⑦ 大额异动（24h，|amount| ≥ 阈值，前 20 条）
    const bigMoves = await db.collection('wallet_log').aggregate([
      { $match: { createdAt: { $gte: since1 } } },
      { $addFields: { abs: { $abs: { $ifNull: ['$amount', 0] } } } },
      { $match: { abs: { $gte: bigMoveMin } } },
      { $sort: { abs: -1 } }, { $limit: 20 },
      { $project: { createdAt: 1, userId: 1, kind: 1, amount: 1, note: 1 } },
    ]).toArray();
    // ⑧ 告警：负余额（任何一处为负都说明有账没对平）
    const negLingqi = await db.collection('shanhai_profiles').countDocuments({ lingqi: { $lt: 0 } });
    const negXianyu = await db.collection('shanhai_profiles').countDocuments({ xianyu: { $lt: 0 } });
    const negExw = await db.collection('shanhai_ex_wallet').countDocuments({ balance: { $lt: 0 } });
    res.json({ ok: true, generatedAt: new Date(),
      profiles: { players: (profAgg && profAgg.players) || 0, lingqi: r2(profAgg && profAgg.lingqi), lingqiFrozen: r2(profAgg && profAgg.lingqiFrozen), xianyu: r2(profAgg && profAgg.xianyu) },
      exchange: { playerBalance: r2(exAgg && exAgg.balance), playerFrozen: r2(exAgg && exAgg.frozen),
        bot: { balance: r2(botW && botW.balance), frozen: r2(botW && botW.frozen) },
        fund: { lingqi: r2(fund && fund.lingqi), lingqiFrozen: r2(fund && fund.lingqiFrozen) } },
      deals7d: deals7d.map(x => ({ day: x._id.day, count: x.count, total: r2(x.total), fee: r2(x.fee) })),
      wallet7d: wallet7d.map(x => ({ day: x._id.day, inflow: r2(x.inflow), outflow: r2(x.outflow), net: r2(x.inflow - x.outflow) })),
      withdrawByStatus: withdrawByStatus.map(x => ({ status: x._id || '未知', count: x.count, sum: r2(x.sum) })),
      logEvents7d: logEvents7d.map(x => ({ day: x._id.day, action: x._id.action, count: x.count, gain: r2(x.gain), amount: r2(x.amount) })),
      bigMoves: bigMoves.map(x => ({ createdAt: x.createdAt, userId: x.userId, kind: x.kind, amount: r2(x.amount), note: x.note || '' })),
      alerts: { negLingqi, negXianyu, negExw, fundNegative: !!(fund && (fund.lingqi || 0) < 0), bigMoveMin } });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// 【2026-09-12】挂载魔法翻翻乐游戏模块
}
