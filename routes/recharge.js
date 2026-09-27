// routes/recharge.js — 写手端充值（支付宝转账 + 截图机器核验）与管理员审核
// 流程：
//   写手 → 看官方收款信息 → 支付宝转账 → 上传转账截图 + 填申报金额
//     → 服务端 OCR 识别金额 → 与申报额一致且 < 自动到账阈值 → 直接入账（机器审核）
//     → 金额 ≥ 阈值 / 识别失败 / 不一致 / 超日限额 → 落人工审核队列，管理员二审手动到账
// 安全（2026-09-26 收紧后的实际口径，改代码请同步这里）：
//   · 入账判定只用**服务端 OCR 的严格主金额**（带 ¥/元 标识、同屏唯一、置信度达标），
//     客户端只传申报额；订单号只作为"金额已核一致"时的附加证据，不再是独立入账理由
//   · 同一张截图 sha256 **全站**去重（防一张真截图多账号各刷一次）
//   · 自动到账有单日笔数与金额上限（管理员可配），口径是**每个用户**，且先原子占额度再入账
//   · 每次入账/审核都写流水（wallet_log + recharge_orders），可追溯
import path from 'path';
import crypto from 'node:crypto';
import multer from 'multer';
import { recognize, pickAmount, parseAmounts, primaryAmount, status as ocrStatus } from '../lib/ocr.js';
import { limit } from '../lib/ratelimit.js';
import { writerOnly } from '../lib/core.js';
import { addLedgerEntry, ledgerSumOfRef } from '../lib/ledger.js';
import { indexGuardOk, indexGuardReport } from '../lib/db.js';

export default function mountRecharge(app, ctx) {
  const { auth, getDb, ObjectId, GridFSBucket } = ctx;
  const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

  // 【2026-09-26 内存保护】充值/二维码用各自的上限，不再共用全局 25MB 的 ctx.upload：
  // 原先 multer 把 25MB 完整读进内存后，业务层的 6MB 判定才开始拒绝 ——
  // 8 路并发即 200MB 常驻，而部署实例是 512MB（见 lib/ocr.js 头的事故记录）。
  const shotUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1 } });
  const qrUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

  // 【2026-09-26 安全加固】真类型嗅探：客户端 mimetype 完全可伪造，不能拿它当白名单依据。
  // 只认位图（PNG/JPG/WEBP/BMP）—— 故意排除 SVG：SVG 是 XML，可携带 <script>，
  // 而这两类图片都会被内联回吐给浏览器（无 CSP），管理员误传一次即等于同域存储型 XSS。
  function sniffImage(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
    return null;
  }

  // -------------------- 平台收款配置（管理员可改） --------------------
  const CFG_KEY = 'recharge_config';
  const DEFAULT_CFG = {
    enabled: true,
    alipayAccount: '',          // 官方收款支付宝账号
    alipayName: '',             // 收款人姓名（转账时会显示，写手核对用）
    qrFileId: '',               // 收款二维码（GridFS 文件 id）
    autoMax: 1000,              // 单笔 < 此金额且识别一致 → 机器自动到账
    autoDailyCount: 3,          // 【2026-09-26 修正】单日自动到账笔数上限 —— 口径是**每个用户**
                                //   （原先统计的是全平台当日 auto_paid 总数，既不并发安全，
                                //   又会被人用满：机器人当天跑满 3 笔后全网正常写手永远转人工）
    autoDailyAmount: 2000,      // 单日自动到账金额上限（同样按每个用户计）
    ocrEnabled: true,           // 【v25.3】OCR 自动识别开关（后台可随时关；关了即全部转人工）
    orderNoVerify: true,        // 【v25.4】订单号核验：免 OCR 的机器核验（写入截图里的支付宝订单号，唯一且不重复即放行小额）
    // 【2026-09-26 安全收紧】以下三项是自动到账（无人工复核）的判定门槛，只影响"能不能机器直接入账"，
    // 不满足就转人工 —— 收紧它们的代价是人工队列变长，不会拒单。
    autoMinConfidence: 85,      // OCR 平均置信度低于此值 → 不自动入账（模糊/倾斜截图交给肉眼）
    autoMaxPri: 2,              // 主金额必须是 pri<=2（带 ¥/￥ 或"元"）才自动入账；pri3 的"金额 100"这类只作参考
    requirePayeeInOcr: false,   // 是否强制截图里出现官方收款账号。开启前请先用「后台·识别自检」验证
                                //   你的收款账号（手机号/邮箱）能被 OCR 读出来，否则自动通道会全部转人工
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
  // 【2026-09-26 批次2】改走 lib/ledger.js 并带上 refId=充值单号：
  // 原先这里是裸 insertOne，而"余额"就是流水求和 —— 任何一次重复写入即凭空多钱、
  // 任何一次写入失败即少钱且无法补。有了 (kind,refId) 幂等键之后，
  // 管理员双击、请求重试、进程半路被杀后重跑，都不会二次入账。
  async function credit(db, userId, amount, note, refId) {
    return addLedgerEntry(db, { userId, kind: 'recharge', refId, amount, note: note || '充值到账' });
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
        orderNoVerify: c.orderNoVerify !== false,
        ocr: ocrStatus(c.ocrEnabled !== false),
        // 【2026-09-26 批次2】资金级索引没就位时自动到账是被硬性停用的，必须让后台看得见，
        // 否则会表现为"通道开着但每单都转人工"这种极难定位的现象
        autoPayEnabled: indexGuardOk(),
        autoPayBlockedBy: indexGuardOk() ? null : indexGuardReport().failures.map(f => f.name),
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
      pipeImage(bucket, f, res, 'no-cache');
    } catch (e) { if (!res.headersSent) res.status(500).end(); else res.destroy(); }
  });

  // 【2026-09-26 安全加固】图片内联输出统一走这里：
  //   ① Content-Type 只允许位图白名单（历史数据里可能存着当年用 svg 上传的文件）；
  //   ② 显式 attachment 兜底，不给浏览器解释成文档的机会；
  //   ③ 监听源流 'error' —— 原写法 openDownloadStream(...).pipe(res) 不带 error 处理，
  //      文件元数据在、chunk 被清理任务删掉时（worktime.js 每 6 小时跑一次）会抛未捕获的
  //      流错误，被 server.js 的全局兜底吞掉，而这个 HTTP 响应既不 200 也不 500 地悬挂。
  const SAFE_INLINE = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];
  function pipeImage(bucket, f, res, cache) {
    const ct = SAFE_INLINE.includes(String(f.contentType || '')) ? f.contentType : 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', cache);
    if (ct === 'application/octet-stream') {
      res.setHeader('Content-Disposition', 'attachment; filename="' + String(f.filename || 'file') + '"');
    }
    const s = bucket.openDownloadStream(f._id);
    s.on('error', e => {
      console.error('[recharge] 文件流读取失败:', e && e.message || e);
      if (!res.headersSent) res.status(500).end(); else res.destroy();
    });
    s.pipe(res);
  }

  // 提交充值（截图 + 申报金额）—— 机器核验
  // 【2026-09-26】限流改按用户维度：原先 keyOf 里的 body.username 在 multipart 下取不到
  //（限流中间件挂在 upload.single 之前，此时 req.body 还是 undefined），退化成纯 IP 桶 ——
  // 移动网络 CGNAT 后多个写手共用出口 IP 互相顶号，而攻击者换 IP 即无限。
  app.post('/api/recharge', auth, writerOnly,   // 【v26.73】资金入口只开放给写手
    ctx.limit ? ctx.limit({ name: 'recharge-submit', max: 8, windowMs: 60 * 1000, byUser: true, msg: '提交太频繁，请稍后再试' })
              : limit({ name: 'recharge-submit', max: 8, windowMs: 60 * 1000, byUser: true, msg: '提交太频繁，请稍后再试' }),
    shotUpload.single('file'),
    async (req, res) => {
      try {
        const db = await getDb();
        const cfg = await getCfg(db);
        if (!cfg.enabled) return res.status(400).json({ ok: false, error: '充值通道暂未开放，请联系管理员' });
        if (!req.file) return res.status(400).json({ ok: false, error: '请上传支付宝转账截图' });
        const mt = sniffImage(req.file.buffer);
        if (!mt) return res.status(400).json({ ok: false, error: '只支持 PNG / JPG / WEBP / BMP 截图（不支持 SVG）' });

        const declared = Math.round((Number(req.body && req.body.amount) || 0) * 100) / 100;
        if (!(declared >= cfg.minAmount)) return res.status(400).json({ ok: false, error: `充值金额至少 ¥${cfg.minAmount}` });
        if (declared > cfg.maxAmount) return res.status(400).json({ ok: false, error: `单笔最高 ¥${cfg.maxAmount}，大额请分次或联系管理员` });

        // 同一张图只允许提交一次 —— 【2026-09-26 安全收紧】查重范围从「同一用户」改为「全站」：
        // 一张真实转账截图发给 N 个账号，原先每个账号都能各自机器秒到账一次（N 倍放大）。
        const hash = sha256(req.file.buffer);
        const dup = await db.collection('recharge_orders').findOne({ shotHash: hash });
        if (dup) return res.status(400).json({ ok: false, error: '这张截图已被提交过（单号 ' + (dup.no || '') + '），请勿重复提交' });

        // 存截图（GridFS 默认桶 fs，与站内其他附件一致）
          const bucket = new GridFSBucket(db);
        let fileName = String(req.file.originalname || 'recharge.png');
        try { fileName = Buffer.from(fileName, 'latin1').toString('utf8'); } catch (e) {}
        const up = bucket.openUploadStream(`recharge_${req.user.id}_${Date.now()}${path.extname(fileName) || '.png'}`, {
          contentType: mt, metadata: { kind: 'recharge', userId: req.user.id, declared },
        });
        await new Promise((resolve, reject) => up.end(req.file.buffer, err => (err ? reject(err) : resolve())));
        const shotFileId = String(up.id);

        // —— 【v25.4】订单号核验（免 OCR 的第二条机器核验路径）——
        // 写手从截图里抄支付宝订单号（20~40 位纯数字），唯一且未被用过 → 小额直接放行
        const orderNoRaw = String((req.body && req.body.orderNo) || '').replace(/[^0-9]/g, '');
        const orderNoOk = orderNoRaw.length >= 16 && orderNoRaw.length <= 40;
        let orderNoDup = false;
        if (orderNoOk) {
          const dupNo = await db.collection('recharge_orders').findOne({ orderNo: orderNoRaw });
          orderNoDup = !!dupNo;
        }

        // —— 机器核验：OCR 识别金额（可用则作为第一重信号） ——
        const ocr = await recognize(req.file.buffer, 25000, cfg.ocrEnabled !== false);
        const ocrConf = ocr.ok ? (ocr.confidence || 0) : 0;
        // ocrAmount 仅用于台账展示与人工比对（沿用"最贴近申报值"的读数口径）
        const picked = ocr.ok ? pickAmount(ocr.text, declared) : { amount: null, list: [] };
        const ocrAmount = picked.amount;
        // 【2026-09-26 安全收紧】自动入账的判定不再用 picked，改用严格主金额：
        //   ① 截图里优先级最高的一组候选必须只有一个金额（同屏两个 ¥ 金额 → 不自动入账）
        //   ② 该金额必须是显式金额（pri <= autoMaxPri，即带 ¥/￥ 或"元"）
        //   ③ OCR 置信度 >= autoMinConfidence
        // 原 picked 是"任一候选等于申报额即算命中"，优惠券「10元」、账单其他行、
        // 甚至任意一个能读到大字的页面都能凑成"金额一致"。
        const prim = ocr.ok ? primaryAmount(ocr.text) : { amount: null, pri: null, distinct: [] };
        const tol = 0.011;
        const amountMatched = !!(ocr.ok && prim.amount != null
          && Math.abs(prim.amount - declared) < tol
          && prim.pri != null && prim.pri <= cfg.autoMaxPri
          && ocrConf >= cfg.autoMinConfidence);
        // 收款账号交叉核验（默认关；后台确认 OCR 能读出你的账号后再开）
        let payeeOk = true, payeeChecked = false;
        if (cfg.requirePayeeInOcr) {
          payeeChecked = true;
          const acct = String(cfg.alipayAccount || '').trim();
          const hay = String(ocr.text || '').replace(/\s+/g, '').toLowerCase();
          payeeOk = !!(ocr.ok && acct && hay.includes(acct.replace(/\s+/g, '').toLowerCase()));
        }
        // 【2026-09-24 安全修复】订单号通道必须与 OCR 文本交叉验证：
        // 原先只校验"16~40位数字 + 未用过"，订单号是用户手抄自报的，随便编一个就能免审核入账（刷余额）。
        // 现要求：OCR 可用且订单号确实出现在截图文本里才放行；OCR 不可用/对不上 → 一律转人工。
        const orderNoInOcr = !!(ocr.ok && orderNoOk
          && String(ocr.text || '').replace(/[^0-9]/g, '').includes(orderNoRaw));

        const no = 'RC' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
        const now = new Date();
        const today = todayStr();
        let status, reason, verifyMethod = null, balance = null;
        // 【2026-09-26 安全收紧】自动到账改为「先原子占额度、占不到就不入账」。
        // 原实现是 find 出当日全部 auto_paid 再在内存里数笔数/求和：
        //   ① 读-判-写非原子，10 路并发全部读到 0 → autoDailyCount=3 形同虚设；
        //   ② 统计没有 userId 过滤 → 是全平台配额，被人用满后正常写手永久转人工。
        // 现在每个用户每天一份计数文档，$inc 后按 returnDocument:'after' 的结果判定，天然并发安全。
        async function takeAutoQuota() {
          if (declared >= cfg.autoMax) return { ok: false, why: '超出单笔自动到账上限' };
          const id = 'auto:' + today + ':' + req.user.id;
          const inc = { n: 1, sum: declared };
          const after = await db.collection('recharge_auto_quota').findOneAndUpdate(
            { _id: id }, { $inc: inc, $setOnInsert: { userId: req.user.id, day: today, createdAt: new Date() } },
            { upsert: true, returnDocument: 'after' });
          const d = after && (after.value || after);
          if (!d || (d.n <= cfg.autoDailyCount && d.sum <= cfg.autoDailyAmount + 1e-9)) {
            return { ok: !!d, why: d ? '' : '配额计数写入失败' };
          }
          // 超出：把刚占的额度还回去，本单转人工
          await db.collection('recharge_auto_quota').updateOne({ _id: id }, { $inc: { n: -1, sum: -declared } }).catch(() => {});
          return { ok: false, why: '超出单日自动到账额度' };
        }
        // 【2026-09-26 批次2】资金级唯一索引没全部就位时，硬性禁止无人复核的自动入账。
        // 本文件里"防并发双发"大量依赖捕获 11000（截图查重、幂等入账），
        // 而那些唯一索引历史上是 fire-and-forget 创建的：历史脏数据会让它静默失败，
        // 索引不在 → 11000 永远不抛 → 那些 catch 分支全是死代码，看起来有防护实际没有。
        // 现在 lib/db.js 会真实校验并把结果暴露出来，缺失时宁可全部转人工。
        const ledgerSafe = indexGuardOk();
        const machineVerified = ledgerSafe && ocr.ok && amountMatched && (!payeeChecked || payeeOk);
        const orderNoVerified = cfg.orderNoVerify !== false && orderNoOk && !orderNoDup && orderNoInOcr;
        // 【2026-09-26 安全收紧】订单号不再作为独立入账理由（它只能证明"截图里出现过这串数字"，
        // 而这串数字与截图内容都由提交者提供，等于自证）。它现在的角色是：金额已核一致时的
        // 更强证据标记（verifyMethod=orderNo，便于人工抽检与对账）。
        if (machineVerified) {
          const q = await takeAutoQuota();
          if (q.ok) {
            status = 'auto_paid';
            verifyMethod = orderNoVerified ? 'orderNo' : 'ocr';
            reason = orderNoVerified
              ? '机器核验通过（截图主金额与申报一致 + 订单号交叉核验）'
              : '机器核验通过（截图主金额与申报一致）';
          } else {
            status = 'pending'; reason = q.why ? q.why + '，转人工审核' : '转人工审核';
          }
        } else {
          status = 'pending';
          if (!ledgerSafe) reason = '防重复入账的数据库约束未全部就位，本单已转人工复核（技术侧：' + (indexGuardReport().failures[0]?.name || '索引待建') + '）';
          else if (payeeChecked && ocr.ok && amountMatched && !payeeOk) reason = '截图中未出现官方收款账号，转人工审核';
          else if (orderNoDup) reason = '该订单号已提交过，转人工审核';
          else if (!ocr.ok) {
            reason = '机器核验未通过，转人工审核（' + (ocr.reason || '识别不可用') + '）'
              + (orderNoRaw && !orderNoOk ? '；订单号格式不对（需 16~40 位数字）' : (orderNoRaw ? '' : '；未填写订单号'));
          } else if (prim.amount == null) {
            reason = (prim.distinct.length > 1 ? '截图中有多个主金额，无法判定' : '截图中未识别到明确主金额') + '，转人工审核';
          } else if (Math.abs(prim.amount - declared) >= tol) {
            reason = `截图主金额（¥${prim.amount}）与申报金额（¥${declared}）不一致，转人工审核`;
          } else if (prim.pri > cfg.autoMaxPri) reason = `识别到的金额（¥${prim.amount}）缺少 ¥/元 标识，不足以自动入账，转人工审核`;
          else if (ocrConf < cfg.autoMinConfidence) reason = `截图识别置信度偏低（${ocrConf}%），转人工核对`;
          else if (orderNoOk && !orderNoInOcr) reason = '订单号未能在截图中核验到，转人工审核';
          else reason = '转人工审核（订单号缺失或格式不对）';
        }
        const doc = {
          no, userId: req.user.id, username: req.user.displayName || req.user.username || '',
          amount: declared, declared, ocrAmount: ocrAmount == null ? null : ocrAmount,
          // 【2026-09-26】把自动入账真正依据的"严格主金额"也留档：ocrAmount 仍是"最贴近申报值"
          // 的读数（仅供人工比对），两者不一致时能一眼看出是哪一个把单子判过去的
          ocrPrimaryAmount: prim.amount == null ? null : prim.amount, ocrPrimaryPri: prim.pri ?? null,
          ocrConfidence: ocr.confidence || 0, ocrText: (ocr.text || '').slice(0, 800),
          ocrOk: !!ocr.ok, amountMatched, orderNoInOcr, payeeChecked, payeeOk,
          orderNo: orderNoOk ? orderNoRaw : null, verifyMethod,
          shotFileId, shotHash: hash, shotName: fileName, shotSize: req.file.size,
          status, reason, autoDay: status === 'auto_paid' ? today : null,
          createdAt: now, reviewedBy: null, reviewedAt: null,
        };
        // 【2026-09-24 安全修复】先落单、后入账（原顺序反了：并发同图可双份入账，
        // 且 insertOne 失败时出现"钱已到账却无单据"的孤儿流水）。
        // 并发同图由 recharge_orders 的 shotHash 唯一索引兜底（见 lib/db.js）。
        try {
          await db.collection('recharge_orders').insertOne(doc);
        } catch (err) {
          // 【2026-09-26】落单失败时截图已经在 GridFS 里了 —— 不清就会长期堆孤儿文件
          //（清理任务只删"聊天附件"，充值截图被特意保护，所以孤儿永远不会被回收）
          try { await bucket.delete(new ObjectId(shotFileId)); }
          catch (e) { console.warn('[充值] 落单失败且截图清理失败，需人工核对:', shotFileId, e.message); }
          if (err && err.code === 11000) {
            return res.status(400).json({ ok: false, error: '这张截图已经提交过了，请勿重复提交' });
          }
          throw err;
        }
        if (status === 'auto_paid') {
          // 【2026-09-26 批次2】入账失败必须把单子退回去，不能留着"已到账"的假状态：
          // 之前这里 credit 抛错会被外层 catch 成 500，但单据已经以 auto_paid 落库了，
          // 而 336 行又禁止对 auto_paid 二次 approve —— 于是这笔钱**永久没有任何路径能补进去**。
          // 现在：带 refId 幂等入账；真失败了就把单降级为 pending 并说明原因，走人工补。
          try {
            await credit(db, req.user.id, declared,
              verifyMethod === 'orderNo' ? `充值到账 · ${no}（转账订单号核验）` : `充值到账 · ${no}（支付宝截图机器核验）`, no);
          } catch (e) {
            console.error('[充值] 自动入账失败，单据回退为待人工审核 no=' + no + ' user=' + req.user.id, e && e.message || e);
            await db.collection('recharge_orders').updateOne({ _id: doc._id },
              { $set: { status: 'pending', autoDay: null, reason: '机器核验通过但自动入账失败，已转人工复核（若已收到款请勿重复提交）' } })
              .catch(e2 => console.error('[充值] 回退单据也失败，需人工核对！no=' + no, e2 && e2.message || e2));
            status = 'pending'; reason = '机器核验通过，但入账环节异常，已转人工复核';
          }
        }

        // 【2026-09-24 性能优化】余额求和改库端聚合（原先全量流水拉进 Node 再 reduce）
        const grantsAgg = await db.collection('wallet_log').aggregate([
          { $match: { userId: req.user.id } },
          { $group: { _id: null, sum: { $sum: { $cond: [{ $isNumber: '$amount' }, '$amount', 0] } } } },
        ]).toArray();
        balance = Math.round(((grantsAgg[0] && grantsAgg[0].sum) || 0) * 100) / 100;
        res.json({
          ok: true, no, status, reason, amount: declared, ocrAmount, ocrOk: !!ocr.ok,
          amountMatched, ocrConfidence: ocr.confidence || 0, balance, verifyMethod,
          message: status === 'auto_paid'
            ? `充值成功，¥${declared} 已到账${verifyMethod === 'orderNo' ? '（订单号核验）' : ''}`
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
          verifyMethod: r.verifyMethod || null,
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
      if (!ObjectId.isValid(o.shotFileId)) return res.status(404).end();
      const f = (await bucket.find({ _id: new ObjectId(o.shotFileId) }).toArray())[0];
      if (!f) return res.status(404).end();
      pipeImage(bucket, f, res, 'private, max-age=60');
    } catch (e) { if (!res.headersSent) res.status(500).end(); else res.destroy(); }
  });

  // ==================== 管理员：配置 ====================
  app.get('/api/admin/recharge/config', auth, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      const db = await getDb();
      const cfg = await getCfg(db);   // 【2026-09-26】原先这里调了两次 getCfg（两次库往返），复用一个
      res.json({ ok: true, config: cfg, ocr: ocrStatus(cfg.ocrEnabled !== false) });
    } catch (e) { res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/admin/recharge/config', auth, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      const db = await getDb();
      const cur = await getCfg(db);
      const b = req.body || {};
      const next = Object.assign({}, cur);
      for (const k of ['enabled', 'ocrEnabled', 'orderNoVerify', 'requirePayeeInOcr']) if (b[k] !== undefined) next[k] = !!b[k];
      for (const k of ['alipayAccount', 'alipayName', 'qrFileId', 'tip']) if (b[k] !== undefined) next[k] = String(b[k]).trim();
      for (const k of ['autoMax', 'autoDailyCount', 'autoDailyAmount', 'minAmount', 'maxAmount']) {
        if (b[k] !== undefined) { const v = Number(b[k]); if (Number.isFinite(v) && v >= 0) next[k] = v; }
      }
      // 自动到账门槛：置信度 0~100、主金额优先级 1~5（越大越松）
      if (b.autoMinConfidence !== undefined) { const v = Number(b.autoMinConfidence); if (Number.isFinite(v) && v >= 0 && v <= 100) next.autoMinConfidence = v; }
      if (b.autoMaxPri !== undefined) { const v = Math.floor(Number(b.autoMaxPri)); if (v >= 1 && v <= 5) next.autoMaxPri = v; }
      // 不合理组合直接挡掉：原先 minAmount>maxAmount、autoMax=0 这类能被提交，表现为"通道开着但永远报错"
      if (!(next.minAmount >= 0 && next.minAmount <= next.maxAmount)) return res.status(400).json({ ok: false, error: '最低金额不能大于最高金额' });
      if (!(next.autoMax > 0)) return res.status(400).json({ ok: false, error: '自动到账单笔上限需大于 0' });
      if (next.requirePayeeInOcr && !String(next.alipayAccount || '').trim()) return res.status(400).json({ ok: false, error: '开启「截图须含收款账号」前请先填写官方收款账号' });
      await db.collection('config').updateOne({ key: CFG_KEY }, { $set: { value: next, updatedAt: new Date() } }, { upsert: true });
      res.json({ ok: true, config: next });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 上传收款二维码（管理员）
  // 【2026-09-26 安全修复】原先中间件顺序是 auth → upload.single → handler，
  // 非管理员的 403 判定发生在 25MB 文件**已经完整进内存之后**（并发即可打爆 512MB 实例）；
  // 且类型只信客户端 mimetype、/^image\// 放过 image/svg+xml —— SVG 可带 <script>，
  // 而 /api/recharge/qr 又把落库的 contentType 原样内联回吐，等于同域存储型 XSS。
  // 现在：权限校验前置 + 单独 2MB 限流 + magic bytes 嗅探（排除 svg）+ 按用户维度限流。
  const qrGate = (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    next();
  };
  app.post('/api/admin/recharge/qr', auth, qrGate,
    limit({ name: 'qr-upload', max: 10, windowMs: 10 * 60 * 1000, byUser: true, msg: '二维码上传太频繁，请稍后再试' }),
    qrUpload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: '请选择二维码图片' });
      if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ ok: false, error: '二维码图片请控制在 2MB 以内' });
      const sniffed = sniffImage(req.file.buffer);
      if (!sniffed) return res.status(400).json({ ok: false, error: '只支持 PNG / JPG / WEBP / BMP 二维码（不支持 SVG）' });
      const db = await getDb();
      const bucket = new GridFSBucket(db);
      // contentType 由服务端嗅探结果决定，绝不用客户端声明的 mimetype
      const up = bucket.openUploadStream(`recharge_qr_${Date.now()}`, {
        contentType: sniffed, metadata: { kind: 'recharge_qr' },
      });
      await new Promise((resolve, reject) => up.end(req.file.buffer, err => (err ? reject(err) : resolve())));
      const qrFileId = String(up.id);
      const cur = await getCfg(db);
      await db.collection('config').updateOne({ key: CFG_KEY }, { $set: { value: Object.assign({}, cur, { qrFileId }), updatedAt: new Date() } }, { upsert: true });
      // 收款码换了新图，旧图就没有引用了；而它的 kind 属于清理白名单之外（财务凭证不自动删），
      // 不主动删就会永久留在桶里 —— 这里显式删掉上一次的那张。
      const prev = String(cur.qrFileId || '');
      if (prev && prev !== qrFileId && ObjectId.isValid(prev)) {
        try { await bucket.delete(new ObjectId(prev)); } catch (e) { console.warn('[充值] 旧收款码清理失败（不影响本次上传）:', e.message); }
      }
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
      res.json({ ok: true, rows, stats, total: sum[0] || { total: 0, n: 0 }, ocr: ocrStatus((await getCfg(db)).ocrEnabled !== false) });
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
        // 【2026-09-24 资金安全修复】auto_paid 单在提交时已自动入账过一次，重复 approve 会二次 credit。
        // 【2026-09-26 批次2 细化】有了 (kind,refId) 幂等键之后，这里可以精确区分
        //   "真已入账"（拒绝，避免误导）和"标了 auto_paid 但流水根本没写进去"（允许补一次）——
        //   后者正是之前那个死结：单据是 auto_paid、代码禁止再审核、却又没有任何路径能把钱补进去。
        if (o.status === 'auto_paid') {
          const already = await ledgerSumOfRef(db, 'recharge', o.no);
          if (already > 0) return res.status(400).json({ ok: false, error: '该单机器核验时已自动到账（' + already + ' 元），不能重复审核；如需撤回请走驳回（将自动扣回）' });
        }
        // 【2026-09-26 批次2】顺序改成「先幂等入账，再条件改状态」。
        // 原先是先抢状态再入账：入账抛错时单据已变 paid、钱却没进，重试又撞 409，永久丢账。
        // 现在 credit 带 refId 幂等，重复调用只会有一条流水；状态改失败（并发被他人抢走）也不会有第二笔钱。
        await credit(db, o.userId, amt, `充值到账 · ${o.no}（管理员审核通过）`, o.no);
        // 允许从 pending 与 rejected 两个状态放行（rejected 改判此前完全没有入口，只能让写手重新付一次款）
        const upd = await db.collection('recharge_orders').findOneAndUpdate(
          { _id: o._id, status: { $in: ['pending', 'rejected', 'auto_paid'] } },
          { $set: { status: 'paid', amount: amt, reviewedBy: req.user.displayName || req.user.username || 'admin', reviewedAt: new Date(), reviewNote: note || '' } },
          { returnDocument: 'after' }
        );
        const np = upd && (upd.value || upd);
        if (!np) return res.status(409).json({ ok: false, error: '该单状态已变化，请刷新后核对（本次入账已按幂等处理，不会重复到账）' });
        const grantsAgg = await db.collection('wallet_log').aggregate([
          { $match: { userId: o.userId } },
          { $group: { _id: null, sum: { $sum: { $cond: [{ $isNumber: '$amount' }, '$amount', 0] } } } },
        ]).toArray();
        return res.json({ ok: true, status: 'paid', amount: amt, balance: Math.round(((grantsAgg[0] && grantsAgg[0].sum) || 0) * 100) / 100 });
      }
      if (action === 'reject') {
        // 【2026-09-24 资金安全修复】驳回 auto_paid 单必须同步扣回已入账金额——
        // 原先只改状态，钱还留在钱包里（"假驳回真到账"）。扣回用负向流水，保留审计链。
        // 【2026-09-26 批次2】扣回额改为**按真实流水核算**而不是直接取单据金额取反：
        // 若机器环节当时入账失败（单据是 auto_paid 但钱包没钱），按 o.amount 扣就会把用户扣成负数。
        const canRejectFrom = ['pending', 'auto_paid'];
        const alreadyIn = await ledgerSumOfRef(db, 'recharge', o.no);
        const wasPaid = o.status === 'auto_paid' && alreadyIn > 0;
        const upd = await db.collection('recharge_orders').findOneAndUpdate(
          { _id: o._id, status: { $in: canRejectFrom } },
          { $set: { status: 'rejected', reviewedBy: req.user.displayName || req.user.username || 'admin', reviewedAt: new Date(), reviewNote: note || '' } },
          { returnDocument: 'after' }
        );
        if (!(upd && (upd.value || upd))) return res.status(409).json({ ok: false, error: '该单已被处理，请刷新' });
        if (wasPaid) {
          const back = await addLedgerEntry(db, {
            userId: o.userId, kind: 'recharge_revoke', refId: o.no, amount: -alreadyIn,
            note: `充值单 ${o.no} 审核驳回，扣回已入账金额 ${alreadyIn} 元`,
          });
          if (back === 'dup') console.warn('[充值] 驳回扣回幂等命中（此前已扣回过）no=' + o.no);
        }
        return res.json({ ok: true, status: 'rejected', revoked: wasPaid, revokedAmount: wasPaid ? alreadyIn : 0 });
      }
      res.status(400).json({ ok: false, error: '未知操作' });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // OCR 自检（管理员）：上传一张图看识别结果，用于排查"识别不准"
  // 【2026-09-24 安全修复】权限校验提到 upload.single 之前（原先普通用户可先把文件体灌进内存才被 403），
  // 并补限流（原先无任何限流，可无限打外部 OCR 服务烧配额）
  app.post('/api/admin/recharge/ocr-test', auth, limit({ name: 'ocr-test', max: 5, windowMs: 10 * 60 * 1000, msg: 'OCR 自检太频繁，请 10 分钟后再试' }), (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    next();
  }, shotUpload.single('file'), async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: '请选择图片' });
      const db = await getDb();
      const cfg = await getCfg(db);
      // 【2026-09-26】原先第三参 allow 缺省 → 后台已关 OCR 时这里仍能识别，状态显示口径对不上；
      // 现在按后台开关走，并把"自动到账会怎么判"一起回显，便于调门槛前先验证真实截图
      const r = await recognize(req.file.buffer, 25000, cfg.ocrEnabled !== false);
      const declared = Number((req.body || {}).amount) || 0;
      const picked = r.ok ? pickAmount(r.text, declared) : { amount: null, list: [] };
      const prim = r.ok ? primaryAmount(r.text) : { amount: null, pri: null, distinct: [] };
      const autoWouldPass = !!(r.ok && prim.amount != null && Math.abs(prim.amount - declared) < 0.011
        && prim.pri != null && prim.pri <= cfg.autoMaxPri && (r.confidence || 0) >= cfg.autoMinConfidence);
      res.json({
        ok: true, ocr: r, picked, candidates: r.ok ? parseAmounts(r.text) : [],
        primary: prim, autoWouldPass,
        gates: { autoMaxPri: cfg.autoMaxPri, autoMinConfidence: cfg.autoMinConfidence, requirePayeeInOcr: !!cfg.requirePayeeInOcr },
        state: ocrStatus(cfg.ocrEnabled !== false),
      });
    } catch (e) { console.error('[充值·OCR自检]', e); res.status(500).json({ ok: false, error: '识别失败' }); }
  });
}

