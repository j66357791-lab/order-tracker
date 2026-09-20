// routes/recharge.js — 写手端充值（支付宝转账 + 截图机器核验）与管理员审核
// 流程：
//   写手 → 看官方收款信息 → 支付宝转账 → 上传转账截图 + 填申报金额
//     → 服务端 OCR 识别金额 → 与申报额一致且 < 自动到账阈值 → 直接入账（机器审核）
//     → 金额 ≥ 阈值 / 识别失败 / 不一致 / 超日限额 → 落人工审核队列，管理员二审手动到账
// 安全：
//   · 签名与金额只信服务端 OCR 结果，客户端只传申报额（不参与入账判定）
//   · 同一张截图 sha256 去重，防重复提交
//   · 自动到账有单日笔数与金额上限（管理员可配），超出转人工
//   · 每次入账/审核都写流水（wallet_log + recharge_orders），可追溯
import path from 'path';
import crypto from 'node:crypto';
import { recognize, pickAmount, parseAmounts, status as ocrStatus } from '../lib/ocr.js';
import { limit } from '../lib/ratelimit.js';

export default function mountRecharge(app, ctx) {
  const { auth, getDb, upload, ObjectId, GridFSBucket } = ctx;
  const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

  // -------------------- 平台收款配置（管理员可改） --------------------
  const CFG_KEY = 'recharge_config';
  const DEFAULT_CFG = {
    enabled: true,
    alipayAccount: '',          // 官方收款支付宝账号
    alipayName: '',             // 收款人姓名（转账时会显示，写手核对用）
    qrFileId: '',               // 收款二维码（GridFS 文件 id）
    autoMax: 1000,              // 单笔 < 此金额且识别一致 → 机器自动到账
    autoDailyCount: 3,          // 单日自动到账笔数上限（超出转人工）
    autoDailyAmount: 2000,      // 单日自动到账金额上限
    minAmount: 1,               // 单笔最低充值
    maxAmount: 50000,           // 单笔最高充值（防误填）
    tip: '转账时请务必备注你的写手昵称，便于核对；截图需包含金额与收款人。',
  };
  async function getCfg(db) {
    const d = await db.collection('config').findOne({ key: CFG_KEY });
    return Object.assign({}, DEFAULT_CFG, (d && d.value) || {});
  }
  const isAdmin = req => req.user && req.user.role === 'admin';

  // 入账：写 wallet_log（余额是 wallet_log 求和，所以这一条即到账）
  // kind='recharge'，不会干扰 LV1 激励的历史特征匹配（那条只认 kind:'lv1_bonus' 或 无 kind+有 base+无 note）
  async function credit(db, userId, amount, note) {
    const now = new Date();
    const month = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    await db.collection('wallet_log').insertOne({
      userId, month, kind: 'recharge', amount: Math.round(amount * 100) / 100, note: note || '充值到账', createdAt: now,
    });
  }
  const todayStr = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  // ==================== 写手端 ====================

  // 收款信息（不含任何管理字段）
  app.get('/api/recharge/config', auth, async (req, res) => {
    try {
      const db = await getDb();
      const c = await getCfg(db);
      res.json({
        ok: true,
        enabled: !!c.enabled,
        alipayAccount: c.alipayAccount,
        alipayName: c.alipayName,
        qrFileId: c.qrFileId || '',
        autoMax: c.autoMax, minAmount: c.minAmount, maxAmount: c.maxAmount,
        tip: c.tip,
        ocr: ocrStatus(),
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 二维码/收款码图片（写手端只读）
  app.get('/api/recharge/qr', auth, async (req, res) => {
    try {
      const db = await getDb();
      const bucket = new GridFSBucket(db);
      const cfg = await getCfg(db);
      if (!cfg.qrFileId) return res.status(404).end();
      const f = (await bucket.find({ _id: new ObjectId(cfg.qrFileId) }).toArray())[0];
      if (!f) return res.status(404).end();
      res.setHeader('Content-Type', f.contentType || 'image/png');
      res.setHeader('Cache-Control', 'no-cache');
      bucket.openDownloadStream(f._id).pipe(res);
    } catch (e) { res.status(500).end(); }
  });

  // 提交充值（截图 + 申报金额）—— 机器核验
  app.post('/api/recharge', auth,
    ctx.limit ? ctx.limit({ name: 'recharge-submit', max: 8, windowMs: 60 * 1000, msg: '提交太频繁，请稍后再试' })
              : limit({ name: 'recharge-submit', max: 8, windowMs: 60 * 1000, msg: '提交太频繁，请稍后再试' }),
    upload.single('file'),
    async (req, res) => {
      try {
        const db = await getDb();
        const cfg = await getCfg(db);
        if (!cfg.enabled) return res.status(400).json({ ok: false, error: '充值通道暂未开放，请联系管理员' });
        if (!req.file) return res.status(400).json({ ok: false, error: '请上传支付宝转账截图' });
        const mt = String(req.file.mimetype || '');
        if (!/^image\/(png|jpe?g|webp|bmp)$/i.test(mt)) return res.status(400).json({ ok: false, error: '只支持 PNG / JPG / WEBP 截图' });
        if (req.file.size > 6 * 1024 * 1024) return res.status(400).json({ ok: false, error: '截图请控制在 6MB 以内' });

        const declared = Math.round((Number(req.body && req.body.amount) || 0) * 100) / 100;
        if (!(declared >= cfg.minAmount)) return res.status(400).json({ ok: false, error: `充值金额至少 ¥${cfg.minAmount}` });
        if (declared > cfg.maxAmount) return res.status(400).json({ ok: false, error: `单笔最高 ¥${cfg.maxAmount}，大额请分次或联系管理员` });

        // 同一张图只允许提交一次
        const hash = sha256(req.file.buffer);
        const dup = await db.collection('recharge_orders').findOne({ userId: req.user.id, shotHash: hash });
        if (dup) return res.status(400).json({ ok: false, error: '这张截图已经提交过了（单号 ' + (dup.no || '') + '），请勿重复提交' });

        // 存截图（GridFS 默认桶 fs，与站内其他附件一致）
          const bucket = new GridFSBucket(db);
        let fileName = String(req.file.originalname || 'recharge.png');
        try { fileName = Buffer.from(fileName, 'latin1').toString('utf8'); } catch (e) {}
        const up = bucket.openUploadStream(`recharge_${req.user.id}_${Date.now()}${path.extname(fileName) || '.png'}`, {
          contentType: mt, metadata: { kind: 'recharge', userId: req.user.id, declared },
        });
        await new Promise((resolve, reject) => up.end(req.file.buffer, err => (err ? reject(err) : resolve())));
        const shotFileId = String(up.id);

        // —— 机器核验：OCR 识别金额 ——
        const ocr = await recognize(req.file.buffer, 20000);
        const picked = ocr.ok ? pickAmount(ocr.text, declared) : { amount: null, list: [] };
        const ocrAmount = picked.amount;
        const amountMatched = ocrAmount != null && Math.abs(ocrAmount - declared) < 0.011;

        // 单日自动到账额度
        const today = todayStr();
        const autoToday = await db.collection('recharge_orders')
          .find({ status: 'auto_paid', autoDay: today }).toArray();
        const autoCount = autoToday.length;
        const autoSum = autoToday.reduce((s, o) => s + (o.amount || 0), 0);
        const withinAuto = declared < cfg.autoMax
          && autoCount < cfg.autoDailyCount
          && (autoSum + declared) <= cfg.autoDailyAmount;

        const no = 'RC' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
        const now = new Date();
        let status, reason, balance = null;
        if (ocr.ok && amountMatched && withinAuto) {
          status = 'auto_paid'; reason = '机器核验通过（截图金额与申报一致）';
          await credit(db, req.user.id, declared, `充值到账 · ${no}（支付宝截图机器核验）`);
        } else {
          status = 'pending';
          if (!ocr.ok) reason = '机器未识别成功，转人工审核（' + (ocr.reason || 'OCR 不可用') + '）';
          else if (!amountMatched) reason = ocrAmount == null ? '截图中未识别到金额，转人工审核' : `截图金额（¥${ocrAmount}）与申报金额（¥${declared}）不一致，转人工审核`;
          else if (!withinAuto) reason = '超出单日自动到账额度，转人工审核';
          else reason = '转人工审核';
        }
        const doc = {
          no, userId: req.user.id, username: req.user.displayName || req.user.username || '',
          amount: declared, declared, ocrAmount: ocrAmount == null ? null : ocrAmount,
          ocrConfidence: ocr.confidence || 0, ocrText: (ocr.text || '').slice(0, 800),
          ocrOk: !!ocr.ok, amountMatched,
          shotFileId, shotHash: hash, shotName: fileName, shotSize: req.file.size,
          status, reason, autoDay: status === 'auto_paid' ? today : null,
          createdAt: now, reviewedBy: null, reviewedAt: null,
        };
        await db.collection('recharge_orders').insertOne(doc);

        const grants = await db.collection('wallet_log').find({ userId: req.user.id }).toArray();
        balance = Math.round(grants.reduce((s, g) => s + (g.amount || 0), 0) * 100) / 100;
        res.json({
          ok: true, no, status, reason, amount: declared, ocrAmount, ocrOk: !!ocr.ok,
          amountMatched, ocrConfidence: ocr.confidence || 0, balance,
          message: status === 'auto_paid'
            ? `充值成功，¥${declared} 已到账`
            : '已提交，等待管理员人工审核（截图与金额已留档，可在充值记录查看进度）',
        });
      } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
    });

  // 我的充值记录
  app.get('/api/recharge/mine', auth, async (req, res) => {
    try {
      const db = await getDb();
      const rows = await db.collection('recharge_orders').find({ userId: req.user.id })
        .sort({ createdAt: -1 }).limit(50)
        .project({ ocrText: 0 }).toArray();
      res.json({
        ok: true,
        rows: rows.map(r => ({
          no: r.no, amount: r.amount, ocrAmount: r.ocrAmount, status: r.status, reason: r.reason,
          shotFileId: r.shotFileId, createdAt: r.createdAt, reviewedAt: r.reviewedAt, note: r.reviewNote || null,
        })),
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 我的截图（仅本人或管理员）
  app.get('/api/recharge/shot/:id', auth, async (req, res) => {
    try {
      const db = await getDb();
      const o = await db.collection('recharge_orders').findOne({ shotFileId: String(req.params.id) });
      if (!o) return res.status(404).end();
      if (o.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).end();
      const bucket = new GridFSBucket(db);
      const f = (await bucket.find({ _id: new ObjectId(o.shotFileId) }).toArray())[0];
      if (!f) return res.status(404).end();
      res.setHeader('Content-Type', f.contentType || 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=60');
      bucket.openDownloadStream(f._id).pipe(res);
    } catch (e) { res.status(500).end(); }
  });

  // ==================== 管理员：配置 ====================
  app.get('/api/admin/recharge/config', auth, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      const db = await getDb();
      res.json({ ok: true, config: await getCfg(db), ocr: ocrStatus() });
    } catch (e) { res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/admin/recharge/config', auth, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      const db = await getDb();
      const cur = await getCfg(db);
      const b = req.body || {};
      const next = Object.assign({}, cur);
      for (const k of ['enabled']) if (b[k] !== undefined) next[k] = !!b[k];
      for (const k of ['alipayAccount', 'alipayName', 'qrFileId', 'tip']) if (b[k] !== undefined) next[k] = String(b[k]).trim();
      for (const k of ['autoMax', 'autoDailyCount', 'autoDailyAmount', 'minAmount', 'maxAmount']) {
        if (b[k] !== undefined) { const v = Number(b[k]); if (Number.isFinite(v) && v >= 0) next[k] = v; }
      }
      await db.collection('config').updateOne({ key: CFG_KEY }, { $set: { value: next, updatedAt: new Date() } }, { upsert: true });
      res.json({ ok: true, config: next });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 上传收款二维码（管理员）
  app.post('/api/admin/recharge/qr', auth, upload.single('file'), async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: '请选择二维码图片' });
      if (!/^image\//i.test(String(req.file.mimetype || ''))) return res.status(400).json({ ok: false, error: '只支持图片' });
      const db = await getDb();
      const bucket = new GridFSBucket(db);
      const up = bucket.openUploadStream(`recharge_qr_${Date.now()}${path.extname(req.file.originalname || '') || '.png'}`, {
        contentType: req.file.mimetype, metadata: { kind: 'recharge_qr' },
      });
      await new Promise((resolve, reject) => up.end(req.file.buffer, err => (err ? reject(err) : resolve())));
      const qrFileId = String(up.id);
      const cur = await getCfg(db);
      await db.collection('config').updateOne({ key: CFG_KEY }, { $set: { value: Object.assign({}, cur, { qrFileId }), updatedAt: new Date() } }, { upsert: true });
      res.json({ ok: true, qrFileId });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '上传失败' }); }
  });

  // ==================== 管理员：审核 ====================
  app.get('/api/admin/recharge/orders', auth, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      const db = await getDb();
      const st = String(req.query.status || 'pending');
      const q = st === 'all' ? {} : { status: st };
      const rows = await db.collection('recharge_orders').find(q).sort({ createdAt: -1 }).limit(100).toArray();
      const stats = {
        pending: await db.collection('recharge_orders').countDocuments({ status: 'pending' }),
        autoPaid: await db.collection('recharge_orders').countDocuments({ status: 'auto_paid' }),
        paid: await db.collection('recharge_orders').countDocuments({ status: 'paid' }),
        rejected: await db.collection('recharge_orders').countDocuments({ status: 'rejected' }),
      };
      const sum = await db.collection('recharge_orders').aggregate([
        { $match: { status: { $in: ['auto_paid', 'paid'] } } },
        { $group: { _id: null, total: { $sum: '$amount' }, n: { $sum: 1 } } },
      ]).toArray();
      res.json({ ok: true, rows, stats, total: sum[0] || { total: 0, n: 0 }, ocr: ocrStatus() });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/admin/recharge/:id/review', auth, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      const db = await getDb();
      const { action, amount, note } = req.body || {};
      const o = await db.collection('recharge_orders').findOne({ _id: new ObjectId(req.params.id) });
      if (!o) return res.status(404).json({ ok: false, error: '充值单不存在' });
      if (!['pending', 'auto_paid', 'paid', 'rejected'].includes(o.status)) return res.status(400).json({ ok: false, error: '状态异常' });
      if (action === 'approve') {
        if (o.status === 'paid') return res.status(400).json({ ok: false, error: '该单已到账' });
        const amt = Math.round((Number(amount) || o.amount) * 100) / 100;
        if (!(amt > 0)) return res.status(400).json({ ok: false, error: '金额不合法' });
        // 条件更新：只有仍处于可审核状态才入账（防并发重复打款）
        const upd = await db.collection('recharge_orders').findOneAndUpdate(
          { _id: o._id, status: { $in: ['pending', 'auto_paid'] } },
          { $set: { status: 'paid', amount: amt, reviewedBy: req.user.displayName || req.user.username || 'admin', reviewedAt: new Date(), reviewNote: note || '' } },
          { returnDocument: 'after' }
        );
        const np = upd && (upd.value || upd);
        if (!np) return res.status(409).json({ ok: false, error: '该单已被处理，请刷新' });
        await credit(db, o.userId, amt, `充值到账 · ${o.no}（管理员审核通过）`);
        const grants = await db.collection('wallet_log').find({ userId: o.userId }).toArray();
        return res.json({ ok: true, status: 'paid', amount: amt, balance: Math.round(grants.reduce((s, g) => s + (g.amount || 0), 0) * 100) / 100 });
      }
      if (action === 'reject') {
        const upd = await db.collection('recharge_orders').findOneAndUpdate(
          { _id: o._id, status: { $in: ['pending', 'auto_paid'] } },
          { $set: { status: 'rejected', reviewedBy: req.user.displayName || req.user.username || 'admin', reviewedAt: new Date(), reviewNote: note || '' } },
          { returnDocument: 'after' }
        );
        if (!(upd && (upd.value || upd))) return res.status(409).json({ ok: false, error: '该单已被处理，请刷新' });
        return res.json({ ok: true, status: 'rejected' });
      }
      res.status(400).json({ ok: false, error: '未知操作' });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // OCR 自检（管理员）：上传一张图看识别结果，用于排查"识别不准"
  app.post('/api/admin/recharge/ocr-test', auth, upload.single('file'), async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: '请选择图片' });
      const r = await recognize(req.file.buffer, 25000);
      const declared = Number((req.body || {}).amount) || 0;
      const picked = r.ok ? pickAmount(r.text, declared) : { amount: null, list: [] };
      res.json({ ok: true, ocr: r, picked, candidates: r.ok ? parseAmounts(r.text) : [], state: ocrStatus() });
    } catch (e) { res.status(500).json({ ok: false, error: '识别失败' }); }
  });
}

