// routes/authx.js — 初始化/认证/邀请/团队/聊天/文件
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
// 【2026-09-17 修复】补引入 node:crypto —— 原文件用了 crypto.randomBytes 生成邀请码，
// 但 ES 模块里没有该全局对象，/api/invites 必然抛 TypeError 返回 500
import crypto from 'node:crypto';
import { ObjectId, GridFSBucket } from 'mongodb';

import { limit, limitPass } from '../lib/ratelimit.js';
import { INLINE_SAFE_TYPES } from '../lib/core.js';

export default function mount(ctx) {
  const { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, selfUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket, rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday, CONTRACT_VERSION, CONTRACT_TITLE, CONTRACT_TEXT, unfreezeRedpackets } = ctx;
// ---------- 初始化：创建管理员（仅当没有任何账号时） ----------
app.get('/api/setup/state', async (req, res) => {
  try {
    const db = await getDb();
    const n = await db.collection('users').countDocuments();
    res.json({ ok: true, needsSetup: n === 0 });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
app.post('/api/setup', async (req, res) => {
  try {
    const db = await getDb();
    // 【2026-09-17 二次复核修正】先校验参数、再抢初始化标记——
    // 原顺序在"第一个请求参数不合规"时也会把 setup_done 标记写库，
    // 系统将被永久锁死无法初始化（二次核查发现的新问题）
    const { username, password, displayName } = req.body || {};
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ ok: false, error: '用户名限3-20位字母数字下划线' });
    if (!password || String(password).length < 6) return res.status(400).json({ ok: false, error: '密码至少6位' });
    const mark = await db.collection('config').findOneAndUpdate(
      { key: 'setup_done' }, { $setOnInsert: { key: 'setup_done', at: new Date() } },
      { upsert: true, returnDocument: 'before' }
    );
    // 【2026-09-17 二次复核修正】mongodb 驱动 v6 的 findOneAndUpdate 直接返回文档或 null
    // （不再有 .value 包装）——原 mark?.value 判断恒为 undefined，标记检测是死代码
    const n = await db.collection('users').countDocuments();
    if (mark || n > 0) return res.status(400).json({ ok: false, error: '系统已初始化，请直接登录' });
    const doc = {
      username, passwordHash: await bcrypt.hash(String(password), 8),
      displayName: String(displayName || username).slice(0, 20), role: 'admin',
      shift: false, sockOnline: false, email: '', createdAt: new Date(),
    };
    try {
      const r = await db.collection('users').insertOne(doc);
      await assignUid(db, r.insertedId);
      res.json({ ok: true, token: signToken({ _id: r.insertedId, role: 'admin' }), user: { ...selfUser(doc), id: r.insertedId.toString() } });
    } catch (e) {
      // 创建失败要释放标记，否则同样会锁死初始化（此时系统还没有任何账号）
      await db.collection('config').deleteOne({ key: 'setup_done' }).catch(() => {});
      throw e;
    }
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// ---------- 登录 / 注册（写手凭邀请码） ----------
app.post('/api/auth/login', limit({ name: 'login-internal', max: 15, windowMs: 5 * 60 * 1000, msg: '登录尝试次数过多，请 5 分钟后再试' }), async (req, res) => {
  try {
    const db = await getDb();
    const { username, password, passwordPlain } = req.body || {};
    const u = await db.collection('users').findOne({ username: String(username || '') });
    // 新体系：前端SHA-256预哈希；旧用户：前端同时带上原文，验证通过后静默升级为哈希体系
    const okNew = u && await bcrypt.compare(String(password || ''), u.passwordHash).catch(() => false);
    const okLegacy = !okNew && u && passwordPlain && await bcrypt.compare(String(passwordPlain), u.passwordHash).catch(() => false);
    if (!u || (!okNew && !okLegacy)) {
      return res.status(401).json({ ok: false, error: '用户名或密码错误' });
    }
    if (okLegacy) {
      // 静默升级：换成SHA-256预哈希存储，此后登录不再传输明文
      // 【2026-09-17 修复】老代码只传 passwordPlain 时 password 为 undefined，
      // bcrypt.hash('undefined') 会把该账号密码永久写坏，此处兜底按原文算 SHA-256
      const preHash = String(password || '') || sha256hex(String(passwordPlain || ''));
      await db.collection('users').updateOne({ _id: u._id }, { $set: { passwordHash: await bcrypt.hash(preHash, 8) } }).catch(() => {});
    }
    limitPass(req);   // 登录成功，清掉尝试计数
    res.json({ ok: true, token: signToken(u), user: selfUser(u) });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
app.post('/api/auth/register', limit({ name: 'reg-internal', max: 10, windowMs: 10 * 60 * 1000, msg: '注册请求过于频繁，请 10 分钟后再试' }), async (req, res) => {
  // 【二次复核修正】inv 声明提到 try 外：中途任何一步抛错（如 assignUid）时外层 catch 也要释放，
  // 否则邀请码永久卡在 __pending__
  let inv = null, createdId = null;
  try {
    const db = await getDb();
    const { inviteCode, username, password, displayName, email } = req.body || {};
    // 【2026-09-16】统一注册：邀请码选填——不填=用户端(client)，填写并有效=写手(writer)
    // 【2026-09-17 二次复核修正】所有参数校验放在邀请码抢占之前——
    // 原顺序在"验证码填错"等场景会把邀请码占成 __pending__ 永久卡死
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ ok: false, error: '用户名限3-20位字母数字下划线' });
    if (!password || String(password).length < 6) return res.status(400).json({ ok: false, error: '密码至少6位' });
    if (!req.body?.agree) return res.status(400).json({ ok: false, error: '请先阅读并同意《兼职写手合作签约协议》' });
    const capErr = verifyCaptcha(req);
    if (capErr) return res.status(400).json({ ok: false, error: capErr });
    const exists = await db.collection('users').findOne({ username: String(username) });
    if (exists) return res.status(400).json({ ok: false, error: '用户名已被占用' });
    const hasInvite = String(inviteCode || '').trim().length > 0;
    if (hasInvite) {
      // 【2026-09-17 修复】原子抢占邀请码（原"先查再改"两步操作在并发注册时同一码可用两次）
      // 先占用为 __pending__，账号创建成功后落为真实用户ID；创建失败则释放
      // 【二次复核修正】驱动 v6 的 findOneAndUpdate 直接返回文档或 null（无 .value 包装），
      // 原判空写法恒失败，带邀请码的注册会 100% 被拒且把码烧成 __pending__
      const claimed = await db.collection('invites').findOneAndUpdate(
        { code: String(inviteCode).trim().toUpperCase(), usedBy: null },
        { $set: { usedBy: '__pending__', usedAt: new Date() } },
        { returnDocument: 'before' }
      );
      if (!claimed) return res.status(400).json({ ok: false, error: '邀请码无效或已被使用' });
      inv = claimed;
    }
    const role = hasInvite ? 'writer' : 'client';
    const doc = {
      username, passwordHash: await bcrypt.hash(String(password), 8),
      displayName: String(displayName || username).slice(0, 20), role,
      shift: false, sockOnline: false, email: String(email || '').slice(0, 60),
      phone: String(req.body?.phone || '').slice(0, 11),
      level: 0, createdAt: new Date(),
    };
    let r;
    try {
      r = await db.collection('users').insertOne(doc);
    } catch (e) {
      // 用户名唯一索引兜底：并发同名的要返回友好提示；失败一律释放已抢占的邀请码
      if (inv) await db.collection('invites').updateOne({ _id: inv._id, usedBy: '__pending__' }, { $set: { usedBy: null } }).catch(() => {});
      if (e && e.code === 11000) return res.status(400).json({ ok: false, error: '用户名已被占用' });
      throw e;
    }
    createdId = r.insertedId;
    const myUid = await assignUid(db, r.insertedId);
    // 注册即签署合作协议（写手；用户端免协议）
    if (role === 'writer') {
      try {
        await db.collection('contracts').insertOne({ userId: r.insertedId.toString(), name: doc.displayName, uid: myUid, displayName: doc.displayName, version: CONTRACT_VERSION, title: CONTRACT_TITLE, signedAt: new Date(), source: 'register' });
        // 欢迎站内信
        await db.collection('announcements').insertOne({
          title: '👋 欢迎加入写手大家庭！', targets: [r.insertedId.toString()], readBy: [], createdAt: new Date(),
          content: `你好呀，${doc.displayName}！\n\n欢迎加入平台，这里有一份快速上手指南：\n\n① 去「工作台」看看待完成的单子，点「接单」开始赚第一笔；\n② 接单前记得先完成「实名认证」（我的-实名认证），否则接不了单哦；\n③ 「我的-钱包」里绑定收款方式（需与实名一致），审核通过后管理员会打款给你；\n④ 考勤页可以抢班、打卡，等级 LV1 有每月 1.5% 的激励奖励；\n⑤ 有问题随时在「聊天」里联系管理员，或留意顶部 ✉ 站内信通知。\n\n祝你接单顺利，稿费满满！`,
        });
      } catch (err) {
        // 配套数据写入失败时不回滚账号本身（写手仍可正常登录），只保证邀请码状态正确
        console.error('[register-writer-side]', err?.message || err);
      }
    }
    if (inv) {
      // 【2026-09-17】把邀请码占用从 __pending__ 落为真实用户ID
      const st = await db.collection('invites').updateOne(
        { _id: inv._id, usedBy: '__pending__' },
        { $set: { usedBy: r.insertedId.toString(), usedAt: new Date() } }
      );
      if (!st.modifiedCount) {
        // 抢占状态被破坏（理论上不会发生）：删除刚建的账号，避免无邀请码的写手
        await db.collection('users').deleteOne({ _id: r.insertedId });
        return res.status(400).json({ ok: false, error: '邀请码无效或已被使用' });
      }
    }
    res.json({ ok: true, role, redirect: role === 'writer' ? '/writer.html' : '/portal.html', token: signToken({ _id: r.insertedId, role }), user: { ...selfUser(doc), id: r.insertedId.toString() } });
  } catch (e) {
    // 【二次复核补充】中途抛错时释放已抢占的邀请码，避免永久卡在 __pending__；
    // 【终审补充】若账号已建成（createdId 存在）则同时删除该账号——
    // 否则账号占用了用户名、邀请码却放活给下一人，形成一码两用
    if (inv && inv._id || createdId) {
      try {
        const db2 = await getDb();
        if (createdId) await db2.collection('users').deleteOne({ _id: createdId });
        if (inv && inv._id) await db2.collection('invites').updateOne({ _id: inv._id, usedBy: '__pending__' }, { $set: { usedBy: null } });
      } catch (e2) { console.error('[register-release-invite]', e2?.message || e2); }
    }
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
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
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
app.get('/api/invites', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const invites = await db.collection('invites').find({}).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ ok: true, invites });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// ---------- 团队 / 在班打卡 ----------
app.get('/api/team', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const users = await db.collection('users').find({ role: 'writer' }).sort({ createdAt: 1 }).toArray();
    res.json({ ok: true, users: users.map(selfUser) });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
app.post('/api/shift', auth, async (req, res) => {
  try {
    const db = await getDb();
    const shift = !!req.body?.shift;
    await db.collection('users').updateOne({ _id: req.user._id }, { $set: { shift } });
    io.emit('presence', { userId: req.user.id, shift, sockOnline: true });
    res.json({ ok: true, shift });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
        list.push({ user: selfUser(w), unread, last: last[0] || null });
      }
      return res.json({ ok: true, chats: list });
    }
    // 写手：会话对象=管理员 + 好友（同事）
    const admins = await db.collection('users').find({ role: 'admin' }).toArray();
    const me = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
    const friendIds = (me.friends || []).filter(x => ObjectId.isValid(x) && x !== req.user.id);
    const friends = friendIds.length ? await db.collection('users').find({ _id: { $in: friendIds.map(x => new ObjectId(x)) } }).toArray() : [];
    const list = [];
    for (const a of [...admins, ...friends]) {
      const conv = pairKey(req.user.id, a._id.toString());
      const last = await db.collection('messages').find({ conversation: conv }).sort({ createdAt: -1 }).limit(1).toArray();
      const unread = await db.collection('messages').countDocuments({ conversation: conv, to: req.user.id, read: false });
      list.push({ user: selfUser(a), unread, last: last[0] || null });
    }
    list.sort((x, y) => (y.last?.createdAt || y.user.createdAt || 0) - (x.last?.createdAt || x.user.createdAt || 0));
    res.json({ ok: true, chats: list });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
// 消息列表（自动标已读 + 通知发送方更新已读水印）
app.get('/api/messages', auth, async (req, res) => {
  try {
    const db = await getDb();
    const peer = String(req.query.peer || '');
    if (!ObjectId.isValid(peer)) return res.status(400).json({ ok: false, error: '无效会话' });
    const conv = pairKey(req.user.id, peer);
    const msgs = await db.collection('messages').find({ conversation: conv }).sort({ createdAt: 1 }).limit(500).toArray();
    const unread = await db.collection('messages').countDocuments({ conversation: conv, to: req.user.id, read: false });
    if (unread) {
      await db.collection('messages').updateMany({ conversation: conv, to: req.user.id, read: false }, { $set: { read: true } });
      msgs.forEach(m => { if (m.to === req.user.id) m.read = true; });
      notify(peer, 'msg_read', { peer: req.user.id });   // 让对方刷新已读水印
    }
    res.json({ ok: true, messages: msgs });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
// 撤回消息（2分钟内、仅本人）
app.post('/api/messages/recall', auth, async (req, res) => {
  try {
    const db = await getDb();
    const id = String(req.body?.id || '');
    if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: '参数无效' });
    const m = await db.collection('messages').findOne({ _id: new ObjectId(id) });
    if (!m || m.from !== req.user.id) return res.status(404).json({ ok: false, error: '消息不存在' });
    if (m.recalled) return res.json({ ok: true });
    if (Date.now() - new Date(m.createdAt).getTime() > 2 * 60 * 1000) return res.status(400).json({ ok: false, error: '超过2分钟，不能撤回了' });
    await db.collection('messages').updateOne({ _id: m._id }, { $set: { recalled: true, text: '', fileId: null, fileName: null, cardId: null } });
    const updated = { ...m, recalled: true, text: '' };
    notify(m.to, 'msg_recall', { id, conversation: m.conversation });
    res.json({ ok: true, message: updated });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
// 清空聊天记录（双方会话消息全部删除）
app.delete('/api/messages', auth, async (req, res) => {
  try {
    const db = await getDb();
    const peer = String(req.query.peer || '');
    if (!ObjectId.isValid(peer)) return res.status(400).json({ ok: false, error: '无效会话' });
    const conv = pairKey(req.user.id, peer);
    const r = await db.collection('messages').deleteMany({ conversation: conv });
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// ---------- 工作台统计 ----------
app.get('/api/workbench', auth, async (req, res) => {
  try {
    const db = await getDb();
    const ym = /^\d{4}-\d{2}$/.test(String(req.query.ym || '')) ? String(req.query.ym) : ymOf(cnNow());
    const start = new Date(ym + '-01T00:00:00+08:00');
    const endDate = (() => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 1, 0, 0, 0) - 8 * 3600 * 1000) })();
    const monthCards = await db.collection('cards').find({ to: req.user.id, createdAt: { $gte: start, $lt: endDate } }).toArray();
    const allCards = await db.collection('cards').find({ to: req.user.id }).toArray();
    const pendingCount = allCards.filter(c => ['待接单', '已接单', '待审核'].includes(c.status)).length;
    const monthAccepted = Math.round(monthCards.filter(c => c.status !== '已拒绝').reduce((s, c) => s + (c.reward || 0), 0) * 100) / 100;
    const pendingPay = Math.round(allCards.filter(c => c.status === '待打款').reduce((s, c) => s + (c.reward || 0), 0) * 100) / 100;
    const cnDay = d => cnDateStr(new Date(new Date(d).getTime() + 8 * 3600 * 1000)).slice(0, 10);
    const daily = {};
    monthCards.forEach(c => {
      if (c.status === '已拒绝') return;
      const d = cnDay(c.createdAt);
      (daily[d] = daily[d] || { date: d, accepted: 0, acceptedCount: 0, completed: 0, completedCount: 0 });
      daily[d].accepted += (c.reward || 0); daily[d].acceptedCount++;
      if (c.status === '已完成' && c.paidAt) {
        const pd = cnDay(c.paidAt);
        if (pd.startsWith(ym)) {
          (daily[pd] = daily[pd] || { date: pd, accepted: 0, acceptedCount: 0, completed: 0, completedCount: 0 });
          daily[pd].completed += (c.reward || 0); daily[pd].completedCount++;
        }
      }
    });
    res.json({ ok: true, ym, pendingCount, monthAccepted, pendingPay, daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)) });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
    // 权限：管理员可和所有人聊；写手之间需互为好友（同事）
    if (req.user.role !== 'admin' && target.role !== 'admin') {
      const me = await db.collection('users').findOne({ _id: new ObjectId(req.user.id), friends: peer });
      if (!me) return res.status(403).json({ ok: false, error: '只能和管理员或已添加的同事聊天' });
    }
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
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
// 上传文件（≤25MB，任意格式，存数据库 GridFS）
// 【2026-09-17 安全加固】加限流：登录用户可反复传大文件刷爆 GridFS 存储
app.post('/api/files', auth, limit({ name: 'upload', max: 30, windowMs: 10 * 60 * 1000, msg: '上传太频繁，请 10 分钟后再试' }), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: '没有文件' });
    // multer/busboy 用 latin1 解码文件名，中文会乱码，转回 utf8
    try { req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8'); } catch (e) {}
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
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
    // 【2026-09-17 安全加固】inline 只放行浏览器可安全内联渲染的类型；
    // html / svg / js 等一律强制 attachment，否则上传一个网页发给你，点开就在同域执行脚本（存储型 XSS）
    const ct = String(f.contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const inline = String(req.query.inline) === '1' && INLINE_SAFE_TYPES.test(ct);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(f.filename));
    bucket.openDownloadStream(f._id).pipe(res);
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
    // 权限：管理员可和所有人聊；写手之间需互为好友（同事）
    if (req.user.role !== 'admin' && target.role !== 'admin') {
      const me = await db.collection('users').findOne({ _id: new ObjectId(req.user.id), friends: peer });
      if (!me) return res.status(403).json({ ok: false, error: '只能和管理员或已添加的同事聊天' });
    }
    const msg = {
      conversation: pairKey(req.user.id, peer),
      from: req.user.id, fromName: req.user.displayName, to: peer,
      type: 'file', fileId, fileName, fileSize, replyTo: cleanReplyTo(req.body?.replyTo), read: false, createdAt: new Date(),
    };
    const r = await db.collection('messages').insertOne(msg);
    msg._id = r.insertedId;
    notify(peer, 'msg', msg); notify(req.user.id, 'msg', msg);
    res.json({ ok: true, message: msg });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
}
