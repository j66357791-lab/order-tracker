// routes/portal.js — 用户端（客户端）：注册/登录/套餐/咨询/个人中心
// 【2026-09-16】用户端专属：开放注册（写手端仍需邀请码）
import { ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';
import { limit, limitPass } from '../lib/ratelimit.js';

export default function mountPortal(app, ctx = {}) {
  const { auth, getDb, signToken, publicUser, selfUser, notify, adminOnly, verifyCaptcha,
          assignUid, CONTRACT_VERSION, CONTRACT_TITLE, CONTRACT_TEXT } = ctx;

  // ---------- 用户端注册（开放，无需邀请码 · 需图形验证码防刷） ----------
  app.post('/api/portal/register', limit({ name: 'reg-portal', max: 10, windowMs: 10 * 60 * 1000, msg: '注册请求过于频繁，请 10 分钟后再试' }), async (req, res) => {
    // 【二次复核修正】inv 在 handler 内、try 外声明（不能提到 handler 外——那会跨请求共享互相污染）
    let inv = null, createdId = null;
    try {
      const capErr = verifyCaptcha(req);
      if (capErr) return res.status(400).json({ ok: false, error: capErr, needCaptcha: true });
      const db = await getDb();
      const { username, password, displayName, phone, inviteCode } = req.body || {};
      if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) return res.status(400).json({ ok: false, error: '请填写正确的手机号' });
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(String(username || ''))) return res.status(400).json({ ok: false, error: '账号限3-20位字母数字下划线' });
      if (!password || String(password).length < 6) return res.status(400).json({ ok: false, error: '密码至少6位' });
      const exists = await db.collection('users').findOne({ username: String(username) });
      if (exists) return res.status(400).json({ ok: false, error: '账号已被占用' });
      // 【2026-09-16】统一注册：选填邀请码——填了且有效=写手，不填=用户端
      // 【2026-09-17 修复】邀请码改为原子抢占（与 /api/auth/register 一致），防止并发一码多用
      let role = 'client';
      if (String(inviteCode || '').trim()) {
        // 【2026-09-17 二次复核修正】驱动 v6 的 findOneAndUpdate 直接返回文档或 null（无 .value 包装）
        const claimed = await db.collection('invites').findOneAndUpdate(
          { code: String(inviteCode).trim().toUpperCase(), usedBy: null },
          { $set: { usedBy: '__pending__', usedAt: new Date() } },
          { returnDocument: 'before' }
        );
        if (!claimed) return res.status(400).json({ ok: false, error: '邀请码无效或已被使用' });
        inv = claimed;
        role = 'writer';
      }
      const doc = {
        username: String(username), phone: String(phone), passwordHash: await bcrypt.hash(String(password), 8),   // password 已是前端 SHA-256
        displayName: String(displayName || '').slice(0, 20) || (role === 'writer' ? '写手' : '用户') + String(username).slice(0, 4),
        role, createdAt: new Date(), portalLeads: 0, shift: false, sockOnline: false, email: '', level: 0,
      };
      let r;
      try {
        r = await db.collection('users').insertOne(doc);
      } catch (e) {
        // 建号失败要释放邀请码，否则码被 __pending__ 占死
        if (inv) await db.collection('invites').updateOne({ _id: inv._id, usedBy: '__pending__' }, { $set: { usedBy: null } }).catch(() => {});
        // 【2026-09-17 二次复核补充】并发同名注册撞唯一索引 → 友好提示而非 500
        if (e && e.code === 11000) return res.status(400).json({ ok: false, error: '账号已被占用' });
        throw e;
      }
      createdId = r.insertedId;
      // 【2026-09-17 修复】写手分支与主注册接口对齐：补工号/合同/欢迎站内信
      // （原来通过门户注册的写手没有工号、没签合同、邀请码 usedBy 存的是用户名无法溯源）
      if (role === 'writer') {
        const myUid = assignUid ? await assignUid(db, r.insertedId) : null;
        try {
          await db.collection('contracts').insertOne({
            userId: r.insertedId.toString(), name: doc.displayName, uid: myUid,
            displayName: doc.displayName, version: CONTRACT_VERSION, title: CONTRACT_TITLE,
            signedAt: new Date(), source: 'portal-register',
          });
          await db.collection('announcements').insertOne({
            title: '👋 欢迎加入写手大家庭！', targets: [r.insertedId.toString()], readBy: [], createdAt: new Date(),
            content: `你好呀，${doc.displayName}！\n\n欢迎加入平台，这里有一份快速上手指南：\n\n① 去「工作台」看看待完成的单子，点「接单」开始赚第一笔；\n② 接单前记得先完成「实名认证」（我的-实名认证），否则接不了单哦；\n③ 「我的-钱包」里绑定收款方式（需与实名一致），审核通过后管理员会打款给你；\n④ 考勤页可以抢班、打卡，等级 LV1 有每月 1.5% 的激励奖励；\n⑤ 有问题随时在「聊天」里联系管理员，或留意顶部 ✉ 站内信通知。\n\n祝你接单顺利，稿费满满！`,
          });
        } catch (e2) { console.error('[portal-register-writer-side]', e2?.message || e2); }
      }
      if (inv) {
        const st = await db.collection('invites').updateOne(
          { _id: inv._id, usedBy: '__pending__' },
          { $set: { usedBy: r.insertedId.toString(), usedAt: new Date() } });
        if (!st.modifiedCount) {
          await db.collection('users').deleteOne({ _id: r.insertedId });
          return res.status(400).json({ ok: false, error: '邀请码无效或已被使用' });
        }
      }
      const u = { ...doc, _id: r.insertedId };
      res.json({ ok: true, token: signToken(u), user: selfUser(u), redirect: role === 'writer' ? '/writer.html' : '/portal.html' });
    } catch (e) {
      // 【二次复核补充】中途抛错（assignUid/落定 updateOne 等）时释放已抢占的邀请码；
      // 【终审补充】账号已建成时同时删除，防止用户名被占而邀请码放活造成一码两用
      if (inv && inv._id || createdId) {
        try {
          const db2 = await getDb();
          if (createdId) await db2.collection('users').deleteOne({ _id: createdId });
          await db2.collection('invites').updateOne({ _id: inv._id, usedBy: '__pending__' }, { $set: { usedBy: null } });
        } catch (e2) { console.error('[portal-register-release-invite]', e2?.message || e2); }
      }
      console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
    }
  });

  // ---------- 用户端登录（按角色分流：client→portal / writer→writer / admin→后台） ----------
  app.post('/api/portal/login', limit({ name: 'login-portal', max: 15, windowMs: 5 * 60 * 1000, msg: '登录尝试次数过多，请 5 分钟后再试' }), async (req, res) => {
    try {
      const db = await getDb();
      const { username, password } = req.body || {};
      const u = await db.collection('users').findOne({ username: String(username || '') });
      // 【2026-09-16 修复】主体系密码为 SHA-256 预哈希后 bcrypt；兼容明文注册的旧测试号
      // 【2026-09-24 安全修复】用户不存在时也对哑哈希做一次 bcrypt 比较，
      // 两条路径耗时一致，消除"用户名是否存在"的时序枚举侧信道
      const ok = u
        ? (await bcrypt.compare(String(password || ''), u.passwordHash).catch(() => false)
          || await bcrypt.compare(String(req.body?.passwordPlain || ''), u.passwordHash).catch(() => false))
        : await bcrypt.compare(String(password || ''), '$2a$10$CwTycUXWue0Thq9StjUM0uJ8DsCjW.P8FTkWPnrAgv9VHCJy4mRLu').catch(() => false);
      if (!ok) return res.status(401).json({ ok: false, error: '账号或密码错误' });
      limitPass(req);   // 登录成功，清掉尝试计数
      res.json({ ok: true, token: signToken(u), user: selfUser(u), redirect: u.role === 'admin' ? '/admin.html' : (u.role === 'writer' ? '/writer.html' : '/portal.html') });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ---------- 我的（用户端） ----------
  app.get('/api/portal/me', auth, async (req, res) => {
    try {
      if (req.user.role !== 'client') return res.status(403).json({ ok: false, error: '仅用户端账号' });
      const db = await getDb();
      const u = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
      const leads = await db.collection('portal_leads').find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(20).toArray();
      res.json({ ok: true, me: { displayName: u.displayName, phone: u.phone, username: u.username, createdAt: u.createdAt }, leads });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ---------- 修改我的资料（用户端工作台） ----------
  app.put('/api/portal/profile', auth, async (req, res) => {
    try {
      if (req.user.role !== 'client') return res.status(403).json({ ok: false, error: '仅用户端账号' });
      const name = String((req.body || {}).displayName || '').trim().slice(0, 20);
      if (!name) return res.status(400).json({ ok: false, error: '昵称不能为空' });
      const db = await getDb();
      await db.collection('users').updateOne({ _id: new ObjectId(req.user.id) }, { $set: { displayName: name } });
      res.json({ ok: true, displayName: name });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ---------- 咨询/下单（用户端提交，管理端跟进） ----------
  app.post('/api/portal/lead', auth, limit({ name: 'lead', max: 10, windowMs: 10 * 60 * 1000, byUser: true, msg: '提交太频繁了，请稍后再试' }), async (req, res) => {
    try {
      if (req.user.role !== 'client') return res.status(403).json({ ok: false, error: '仅用户端账号可提交' });
      const db = await getDb();
      const { packageName, note, contact } = req.body || {};
      // 【2026-09-17 修复】contact 补长度截断与手机号校验（同组的 packageName/note 都有截断，唯独它没有）
      const contactStr = String(contact || '').slice(0, 20).trim();
      if (contactStr && !/^1[3-9]\d{9}$/.test(contactStr)) return res.status(400).json({ ok: false, error: '请填写正确的联系手机号' });
      const doc = {
        userId: req.user.id, displayName: req.user.displayName, phone: contactStr || req.user.phone || '',
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
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ---------- 小沐AI（关键词引导 + 价格实时读后台套餐，避免与配置脱钩） ----------
  // 【2026-09-17】guide-v2：补"优惠/领券"查询——实时算各套餐划线价差，商城改版后首页即 AI
  app.post('/api/portal/ai', auth, limit({ name: 'ai', max: 30, windowMs: 60 * 1000, byUser: true, msg: '问得有点快，歇一分钟再问小沐～' }), async (req, res) => {
    try {
      const { message } = req.body || {};
      const q = String(message || '').slice(0, 300);
      if (!q) return res.status(400).json({ ok: false, error: '请输入内容' });
      // 实时读上架套餐，价格区间与套餐名不再写死
      let plans = [];
      try {
        const db = await getDb();
        plans = await db.collection('portal_packages').find({ active: true }).sort({ price: 1 }).toArray();
      } catch (e) {}
      const min = plans.length ? plans[0].price : null;
      const max = plans.length ? plans[plans.length - 1].price : null;
      const names = plans.map(p => p.name).join('、');
      const priceReply = plans.length
        ? `现在在售的套餐有 ${names}，价格 ¥${min} 起${max && max !== min ? `，最高 ¥${max}` : ''}。「商城」页可以看到每档具体包含什么，选中后点「我要这个」提交需求就行～`
        : '套餐正在配置中，可以直接在「商城」页提交需求，我们按你的情况报价～';
      // 优惠查询：实时计算划线价立减（originalPrice > price 的部分），会员券位后续接入
      let dealReply;
      const deals = plans
        .filter(p => Number(p.originalPrice) > Number(p.price))
        .map(p => `${p.name}直降 ¥${Math.round((Number(p.originalPrice) - Number(p.price)) * 100) / 100}`)
        .slice(0, 3);
      if (!plans.length) dealReply = '优惠活动正在筹备中，可以先在「商城」页提交需求，客服会给你报价当下最优方案～';
      else if (deals.length) dealReply = `现在下单有立减优惠：${deals.join('，')}。「商城」页下单时价格直接生效，不用领券码。会员专属折扣（每月券包、优先排期）在开发中了，上线第一时间通知你～`;
      else dealReply = `当前在售 ${names} 暂时是直购价，没有额外的券。会员权益（专属折扣、优先排期、每月配额）在开发中了，上线后会第一时间在「商城」页提示你～`;
      const rules = [
        { k: ['优惠', '领', '券', '活动', '便宜', '折扣', '划算', '减免'], r: dealReply },
        { k: ['价格', '多少钱', '收费', '套餐', '报价', '商城', '购买', '下单'], r: priceReply },
        { k: ['ppt', 'PPT', '幻灯'], r: 'PPT 定制属于「演示定制」类目，在「商城」页提交需求时注明页数和用途，写手按页计价、可先看样张再铺开。' },
        { k: ['写什么', '能做', '业务', '接什么'], r: '文案馆里的作品就是我们能做的：公众号推文、小红书种草、品牌故事、演讲稿、PPT、表格整理、视频脚本——基本文字类都能接。' },
        { k: ['多久', '交货', '交付', '加急', '快'], r: '常规文案 48 小时内交付；加急可以插队，下单前会先跟你确认时间。' },
        { k: ['进度', '跟进', '联系', '找人'], r: '提交需求后管理员 48 小时内联系你，进度在「我的 → 我的咨询」里随时看。急的话直接在咨询里留言催一下～' },
      ];
      let reply = '收到～小沐先帮你记下来了。可以先逛逛「商城」看套餐，或直接描述需求提交；个性需求点「提交定制需求」会有真人对接，比我说得更准。';
      for (const rule of rules) if (rule.k.some(kw => q.includes(kw))) { reply = rule.r; break; }
      res.json({ ok: true, reply, engine: 'guide-v2' });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ---------- 作品（公开只读 + 管理端配置） ----------
  // cat 分类对应前台「作品 · 能做什么」的四个标签，老数据没有 cat 时前台默认归到「文案」
  const GALLERY_CATS = ['文案', '演示', '数据', '视频'];
  const GALLERY_SEED = [
    { title: '公众号推文', sub: '茶饮品牌 · 节气借势', tag: '阅读 2.4w', img: '/assets/portal/gallery1.jpg?v=1', cat: '文案', order: 1, active: true },
    { title: '小红书种草', sub: '文具好物 · 学生党', tag: '点赞 5,700+', img: '/assets/portal/gallery2.jpg?v=1', cat: '文案', order: 2, active: true },
    { title: '品牌故事', sub: '民宿品牌 · 从一间房开始', tag: '官网在用', img: '/assets/portal/gallery3.jpg?v=1', cat: '文案', order: 3, active: true },
    { title: '演讲稿', sub: '毕业致辞 · 一所中学', tag: '现场 8 分钟', img: '/assets/portal/gallery4.jpg?v=1', cat: '文案', order: 4, active: true },
  ];
  app.get('/api/portal/gallery', async (req, res) => {
    try {
      const db = await getDb();
      let list = await db.collection('portal_gallery').find({ active: true }).sort({ order: 1 }).toArray();
      if (!list.length) {
        await db.collection('portal_gallery').insertMany(GALLERY_SEED.map(x => ({ ...x, createdAt: new Date() })));
        list = await db.collection('portal_gallery').find({ active: true }).sort({ order: 1 }).toArray();
      }
      res.json({ ok: true, gallery: bumpLegacyGallery(list) });
    } catch (e) {
      res.json({ ok: true, gallery: bumpLegacyGallery(GALLERY_SEED) });   // 读库失败也保证首页能渲染
    }
  });

  // 【2026-09-17】旧示例图已整体替换为真实案例样张：旧的无版本号/旧版本号路径动态升级到 ?v=2，
  // 让浏览器视为新资源立即拉取——否则 30 天强缓存会让老访客一直看到旧图（不改库，只改响应）
  // 【二次复核修正】只升级"无版本号或 v=1"的路径，管理员以后手动升到 ?v=3 及以上不会被降回
  const LEGACY_GALLERY = /^\/assets\/portal\/gallery[1-4]\.jpg(\?v=1)?$/;
  function bumpLegacyGallery(list) {
    return (list || []).map(g => {
      if (g && typeof g.img === 'string' && LEGACY_GALLERY.test(g.img)) {
        return { ...g, img: g.img.split('?')[0] + '?v=2' };
      }
      return g;
    });
  }

  // ---------- 管理端：文案馆 CRUD ----------
  app.get('/api/admin/gallery', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const gallery = await db.collection('portal_gallery').find({}).sort({ order: 1 }).toArray();
      if (!gallery.length) {
        await db.collection('portal_gallery').insertMany(GALLERY_SEED.map(x => ({ ...x, createdAt: new Date() })));
        return res.json({ ok: true, gallery: await db.collection('portal_gallery').find({}).sort({ order: 1 }).toArray() });
      }
      res.json({ ok: true, gallery });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });
  app.post('/api/admin/gallery', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const b = req.body || {};
      if (!b.title) return res.status(400).json({ ok: false, error: '标题必填' });
      if (!b.img) return res.status(400).json({ ok: false, error: '图片地址必填' });
      const doc = {
        title: String(b.title).slice(0, 20), sub: String(b.sub || '').slice(0, 30),
        tag: String(b.tag || '').slice(0, 14), img: String(b.img).slice(0, 300),
        cat: GALLERY_CATS.includes(String(b.cat)) ? String(b.cat) : '文案',
        order: Number(b.order) || 99, active: b.active !== false, createdAt: new Date(),
      };
      const r = await db.collection('portal_gallery').insertOne(doc);
      res.json({ ok: true, id: r.insertedId });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });
  app.put('/api/admin/gallery/:id', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const b = req.body || {}, set = {};
      for (const k of ['title', 'sub', 'tag', 'img']) if (b[k] !== undefined) set[k] = String(b[k]).slice(0, k === 'img' ? 300 : 30);
      if (b.cat !== undefined && GALLERY_CATS.includes(String(b.cat))) set.cat = String(b.cat);
      if (b.order !== undefined) set.order = Number(b.order) || 0;
      if (b.active !== undefined) set.active = !!b.active;
      await db.collection('portal_gallery').updateOne({ _id: new ObjectId(req.params.id) }, { $set: set });
      res.json({ ok: true });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });
  app.delete('/api/admin/gallery/:id', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      await db.collection('portal_gallery').deleteOne({ _id: new ObjectId(req.params.id) });
      res.json({ ok: true });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ---------- 管理端：套餐 CRUD ----------
  app.get('/api/admin/packages', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const packages = await db.collection('portal_packages').find({}).sort({ order: 1, price: 1 }).toArray();
      res.json({ ok: true, packages });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });
  app.post('/api/admin/packages', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const b = req.body || {};
      if (!b.name) return res.status(400).json({ ok: false, error: '套餐名必填' });
      const doc = { name: String(b.name).slice(0, 20), tagline: String(b.tagline || '').slice(0, 30), price: Number(b.price) || 0, originalPrice: Number(b.originalPrice) || 0, badge: String(b.badge || '').slice(0, 10), items: (b.items || []).slice(0, 8).map(x => String(x).slice(0, 60)), order: Number(b.order) || 99, active: b.active !== false, createdAt: new Date() };
      const r = await db.collection('portal_packages').insertOne(doc);
      res.json({ ok: true, id: r.insertedId });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });
  // ---------- 管理端：用户咨询列表 ----------
  app.get('/api/admin/leads', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const leads = await db.collection('portal_leads').find({}).sort({ createdAt: -1 }).limit(100).toArray();
      res.json({ ok: true, leads });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });
  app.put('/api/admin/leads/:id', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      await db.collection('portal_leads').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: String((req.body || {}).status || '已跟进') } });
      res.json({ ok: true });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  console.log('[用户端] portal 路由已挂载：/api/portal/*（注册带验证码）+ /api/admin/packages|gallery|leads（套餐/作品/咨询）');
}
