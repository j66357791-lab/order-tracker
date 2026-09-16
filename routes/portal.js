// routes/portal.js — 用户端（客户端）：注册/登录/套餐/咨询/个人中心
// 【2026-09-16】用户端专属：开放注册（写手端仍需邀请码）
import { ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';

export default function mountPortal(app, ctx = {}) {
  const { auth, getDb, signToken, publicUser, notify, adminOnly } = ctx;

  // ---------- 用户端注册（开放，无需邀请码） ----------
  app.post('/api/portal/register', async (req, res) => {
    try {
      const db = await getDb();
      const { username, password, displayName, phone, inviteCode } = req.body || {};
      if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) return res.status(400).json({ ok: false, error: '请填写正确的手机号' });
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(String(username || ''))) return res.status(400).json({ ok: false, error: '账号限3-20位字母数字下划线' });
      if (!password || String(password).length < 6) return res.status(400).json({ ok: false, error: '密码至少6位' });
      const exists = await db.collection('users').findOne({ username });
      if (exists) return res.status(400).json({ ok: false, error: '账号已被占用' });
      // 【2026-09-16】统一注册：选填邀请码——填了且有效=写手，不填=用户端
      let role = 'client';
      if (String(inviteCode || '').trim()) {
        const inv = await db.collection('invites').findOne({ code: String(inviteCode).trim().toUpperCase() });
        if (!inv || inv.usedBy) return res.status(400).json({ ok: false, error: '邀请码无效或已被使用' });
        role = 'writer';
        await db.collection('invites').updateOne({ _id: inv._id }, { $set: { usedBy: username, usedAt: new Date() } });
      }
      const doc = {
        username, phone, passwordHash: await bcrypt.hash(String(password), 8),   // password 已是前端 SHA-256
        displayName: String(displayName || '').slice(0, 20) || (role === 'writer' ? '写手' : '用户') + String(username).slice(0, 4),
        role, createdAt: new Date(), portalLeads: 0, shift: false, sockOnline: false, email: '', level: 0,
      };
      const r = await db.collection('users').insertOne(doc);
      const u = { ...doc, _id: r.insertedId };
      res.json({ ok: true, token: signToken(u), user: publicUser(u), redirect: role === 'writer' ? '/writer.html' : '/portal.html' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---------- 用户端登录（按角色分流：client→portal / writer→writer / admin→后台） ----------
  app.post('/api/portal/login', async (req, res) => {
    try {
      const db = await getDb();
      const { username, password } = req.body || {};
      const u = await db.collection('users').findOne({ username: String(username || '') });
      // 【2026-09-16 修复】主体系密码为 SHA-256 预哈希后 bcrypt；兼容明文注册的旧测试号
      const ok = u && (await bcrypt.compare(String(password || ''), u.passwordHash).catch(() => false)
        || await bcrypt.compare(String(req.body?.passwordPlain || ''), u.passwordHash).catch(() => false));
      if (!ok) return res.status(401).json({ ok: false, error: '账号或密码错误' });
      res.json({ ok: true, token: signToken(u), user: publicUser(u), redirect: u.role === 'admin' ? '/dispatch.html' : (u.role === 'writer' ? '/writer.html' : '/portal.html') });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---------- 我的（用户端） ----------
  app.get('/api/portal/me', auth, async (req, res) => {
    try {
      if (req.user.role !== 'client') return res.status(403).json({ ok: false, error: '仅用户端账号' });
      const db = await getDb();
      const u = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
      const leads = await db.collection('portal_leads').find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(20).toArray();
      res.json({ ok: true, me: { displayName: u.displayName, phone: u.phone, username: u.username, createdAt: u.createdAt }, leads });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---------- 套餐（公开只读 + 管理端配置） ----------
  app.get('/api/portal/packages', async (req, res) => {
    try {
      const db = await getDb();
      let list = await db.collection('portal_packages').find({ active: true }).sort({ order: 1, price: 1 }).toArray();
      if (!list.length) {
        // 首次部署种子套餐
        const seeds = [
          { name: '轻量单', tagline: '单篇文案 · 快交', price: 39, originalPrice: 59, items: ['公众号/小红书文案 1篇（800字内）', '48小时交付', '免费改稿 1 次'], badge: '', order: 1, active: true },
          { name: '内容月卡', tagline: '整月内容不断更', price: 399, originalPrice: 599, items: ['每月 8 篇图文文案', '排版建议+标题库', '专属对接群 · 2次/篇改稿'], badge: '最受欢迎', order: 2, active: true },
          { name: '品牌全案', tagline: '从定位到落地', price: 1299, originalPrice: 1899, items: ['品牌故事+slogan+视觉建议', '20 篇全渠道文案', '月度复盘报告'], badge: '', order: 3, active: true },
        ];
        await db.collection('portal_packages').insertMany(seeds);
        list = await db.collection('portal_packages').find({ active: true }).sort({ order: 1 }).toArray();
      }
      res.json({ ok: true, packages: list });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---------- 咨询/下单（用户端提交，管理端跟进） ----------
  app.post('/api/portal/lead', auth, async (req, res) => {
    try {
      if (req.user.role !== 'client') return res.status(403).json({ ok: false, error: '仅用户端账号可提交' });
      const db = await getDb();
      const { packageName, note, contact } = req.body || {};
      const doc = {
        userId: req.user.id, displayName: req.user.displayName, phone: contact || req.user.phone || '',
        packageName: String(packageName || '').slice(0, 40), note: String(note || '').slice(0, 200),
        status: '待跟进', createdAt: new Date(),
      };
      await db.collection('portal_leads').insertOne(doc);
      await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $inc: { portalLeads: 1 } });
      // 通知所有管理员
      try {
        const admins = await db.collection('users').find({ role: 'admin' }).toArray();
        for (const a of admins) notify(String(a._id), 'msg', { title: '新用户咨询', content: '用户「' + doc.displayName + '」咨询套餐：' + (doc.packageName || '-') + (doc.note ? '，备注：' + doc.note : '') });
      } catch (e2) {}
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ---------- 小沐AI（结构就绪，回复引擎下一步接入） ----------
  app.post('/api/portal/ai', auth, async (req, res) => {
    const { message } = req.body || {};
    const q = String(message || '').slice(0, 300);
    if (!q) return res.status(400).json({ ok: false, error: '请输入内容' });
    // 关键词快捷引导（真实模型接入前的可用回复）
    const rules = [
      { k: ['价格', '多少钱', '收费', '套餐'], r: '我们的套餐从 ¥39 轻量单到 ¥1299 品牌全案都有，往下翻可以看到「套餐方案」卡组，选中适合你的直接点咨询就行～' },
      { k: ['ppt', 'PPT', '幻灯'], r: 'PPT 定制属于接单介绍里的「演示定制」类目，把要求发给你的专属写手就能开工，按页计价、可先看样张。' },
      { k: ['写什么', '能做', '业务'], r: '文案馆里的作品就是我们能做的：公众号推文、小红书种草、品牌故事、演讲稿、PPT、表格整理、视频脚本——基本文字类都能接。' },
      { k: ['多久', '交货', '交付', '快'], r: '常规文案 48 小时内交付；加急可以插队，具体和写手确认就好。' },
    ];
    let reply = '收到～小沐先把你的问题记下来了。文字类需求（文案/PPT/表格/脚本）都可以在「接单介绍」里找到对应卡组；具体的个性需求，点套餐里的「咨询此套餐」会有真人对接，比我说得更准。';
    for (const rule of rules) if (rule.k.some(kw => q.includes(kw))) { reply = rule.r; break; }
    res.json({ ok: true, reply, engine: 'guide-v1' });
  });

  // ---------- 管理端：套餐 CRUD ----------
  app.get('/api/admin/packages', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const packages = await db.collection('portal_packages').find({}).sort({ order: 1, price: 1 }).toArray();
      res.json({ ok: true, packages });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/admin/packages', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const b = req.body || {};
      if (!b.name) return res.status(400).json({ ok: false, error: '套餐名必填' });
      const doc = { name: String(b.name).slice(0, 20), tagline: String(b.tagline || '').slice(0, 30), price: Number(b.price) || 0, originalPrice: Number(b.originalPrice) || 0, badge: String(b.badge || '').slice(0, 10), items: (b.items || []).slice(0, 8).map(x => String(x).slice(0, 60)), order: Number(b.order) || 99, active: b.active !== false, createdAt: new Date() };
      const r = await db.collection('portal_packages').insertOne(doc);
      res.json({ ok: true, id: r.insertedId });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.put('/api/admin/packages/:id', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const b = req.body || {};
      const set = {};
      for (const k of ['name', 'tagline', 'badge']) if (b[k] !== undefined) set[k] = String(b[k]).slice(0, 30);
      for (const k of ['price', 'originalPrice', 'order']) if (b[k] !== undefined) set[k] = Number(b[k]) || 0;
      if (b.items !== undefined) set.items = (b.items || []).slice(0, 8).map(x => String(x).slice(0, 60));
      if (b.active !== undefined) set.active = !!b.active;
      await db.collection('portal_packages').updateOne({ _id: new ObjectId(req.params.id) }, { $set: set });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // ---------- 管理端：用户咨询列表 ----------
  app.get('/api/admin/leads', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const leads = await db.collection('portal_leads').find({}).sort({ createdAt: -1 }).limit(100).toArray();
      res.json({ ok: true, leads });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.put('/api/admin/leads/:id', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      await db.collection('portal_leads').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: String((req.body || {}).status || '已跟进') } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  console.log('[用户端] portal 路由已挂载：/api/portal/* + /api/admin/packages|leads（套餐配置/咨询跟进）');
}
