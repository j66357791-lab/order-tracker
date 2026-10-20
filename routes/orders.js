// routes/orders.js — 台账订单 CRUD
// 【2026-09-14 ES6 重构】自 server.js 原样迁出，行为不变
import { ObjectId } from 'mongodb';

export default function mount(ctx) {
  const { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, selfUser, ObjectId, cacheGet, cacheSet, cacheClear, cacheClearPrefix, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket, rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday, CONTRACT_VERSION, CONTRACT_TITLE, CONTRACT_TEXT, unfreezeRedpackets } = ctx;
function parseOrder(body) {
  const errors = [];
  const date = String(body.date || '').trim();
  const orderNo = String(body.orderNo || '').trim();
  const note = String(body.note || '').trim();
  const status = normalizeStatus(body.status);
  const amount = Number(body.amount);
  const shareRate = Number(body.shareRate);
  let doneDate = String(body.doneDate || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('日期格式应为 YYYY-MM-DD');
  if (!orderNo) errors.push('订单编号不能为空');
  if (!isFinite(amount) || amount < 0) errors.push('订单金额必须是非负数字');
  if (!isFinite(shareRate) || shareRate <= 0 || shareRate > 100) errors.push('分成比例必须是 1-100 之间的数字（%）');
  if (!status) errors.push('订单进度不合法');
  if (doneDate && !/^\d{4}-\d{2}-\d{2}$/.test(doneDate)) errors.push('完单日期格式应为 YYYY-MM-DD');
  if (errors.length) return { errors };

  // 完单口径：待结算/已结算都算「完单」，完单日期缺省=今天；未完单状态清空完单日期
  if (!DONE_STATUSES.includes(status)) doneDate = null;
  else if (!doneDate) doneDate = localToday();

  const doc = {
    date, orderNo,
    amount: Math.round(amount * 100) / 100,
    shareRate: Math.round(shareRate * 100) / 100,
    status, doneDate, note,
  };
  // 派单员是后加的字段：调用方没带 writer 时不能塞一个空串进去，
  // 否则对账卡、编辑弹窗这类只改状态的 PUT 会把这单原有的派单员抹掉
  if (body.writer !== undefined && body.writer !== null) doc.writer = cleanName(body.writer);
  return { doc };
}

// ---------- API ----------
app.get('/api/statuses', (req, res) => res.json({ statuses: STATUSES }));

// 列表（仅管理员；支持 month=YYYY-MM、status、q 关键词筛选；旧「已交付」自动显示为「待结算」）
app.get('/api/orders', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const query = {};
    if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
      query.date = { $regex: '^' + req.query.month };
    }
    if (req.query.status && STATUSES.includes(req.query.status)) {
      // 待结算需同时兼容旧库里的「已交付」
      const sts = req.query.status === '待结算' ? ['待结算', '已交付'] : [req.query.status];
      query.status = { $in: sts };
    }
    if (req.query.q) {
      // 【v20.8】搜索走后端：原来前端拉全量订单在浏览器里过滤。
      // 匹配口径与前台一致 —— 订单号 或 备注 模糊命中（大小写不敏感）。
      const rx = { $regex: String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      query.$or = [{ orderNo: rx }, { note: rx }];
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 500);
    // 【v20.8】按时间范围取数：前端传 month(YYYY-MM) / from / to 时只取该范围（台账页用它避免每次全量）
    if (req.query.from || req.query.to) {
      const rng = {};
      if (req.query.from) rng.$gte = String(req.query.from);
      if (req.query.to) rng.$lte = String(req.query.to);
      query.date = Object.assign(query.date || {}, rng);
    }
    // 【2026-09-26 批次2 正确性修复】缓存键必须包含 limit。
    // 原先键只有 query 对象、不含 limit：只要先发过一次 ?limit=1（预览/探针请求），
    // 这条只有 1 条结果的数据就被挂在"该筛选条件"的键下缓存 60 秒；
    // 台账页随后带默认 limit=500 命中同一个键 → 整页只拿到 1 条订单，
    // 而 KPI、汇总、图表全部基于这 1 条渲染 —— 管理员会据此做出结算判断。
    const cacheKey = 'orders:' + JSON.stringify({ query, limit });
    let orders = cacheGet(cacheKey);
    if (!orders) {
      orders = await db.collection(CONFIG.collection)
        .find(query).sort({ date: -1, _id: -1 }).limit(limit).toArray();
      // 附带分单信息（该订单绑定的派单卡：写手/报酬/卡状态）
      const ids = orders.map(o => o._id.toString());
      const dmap = {};
      if (ids.length) {
        const cards = await db.collection('cards')
          .find({ orderId: { $in: ids } })
          .project({ orderId: 1, toName: 1, reward: 1, status: 1 }).toArray();
        cards.forEach(c => { if (c.orderId && !dmap[c.orderId]) dmap[c.orderId] = { cardId: c._id.toString(), toName: c.toName || '', reward: c.reward || 0, status: c.status }; });
      }
      orders = orders.map(o => ({ ...o, status: normalizeStatus(o.status), dispatch: dmap[o._id.toString()] || null }));
      cacheSet(cacheKey, orders);
    }
    res.json({ ok: true, orders });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
});

// ============ 【v26.81】账单粘贴找单（只读） ============
// 场景：发工资后，管理员把支付宝「批量付款」明细整块复制过来，要按备注里的订单号找到台账对应行。
// 刻意做成只查询、不写库：状态变更仍由人工在明细里点「编辑」完成，避免把「已付工资」和
// 「分成已到账」这两个不同口径混在一起自动刷数据。
const LOOKUP_MAX_NOS = 500;
const LOOKUP_MAX_TEXT = 200000;
// 只取「前后都不是数字」的 10~20 位连续数字。支付宝流水号是 32 位，因此不会被误当成订单号。
const LOOKUP_NO_RE = /(?<!\d)\d{10,20}(?!\d)/g;
// 锚点行：行尾就是订单号，如「批量付款-工资-技术服务-3316375455202007954」
const ANCHOR_RE = /(?<!\d)(\d{10,20})(?!\d)\s*$/;
const MONEY_RE = /\d+\.\d{1,2}/g;

function extractOrderNos(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(LOOKUP_NO_RE)) {
    if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
    if (out.length >= LOOKUP_MAX_NOS) break;
  }
  return out;
}

// 把粘贴文本切成「一笔一条」的付款记录。账单侧的金额只用来给你核对，不参与任何计算。
// 锚点是行尾带订单号的那一行：往前 4 行找付款时间和流水号，往后 3 行找第一个金额。
// 认不出结构的粘贴退回通用扫描（只有订单号、没有金额），绝不静默丢数据。
function parsePayRecords(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t\u00a0]+$/g, ''));
  const recs = [];
  lines.forEach((line, i) => {
    const m = line.match(ANCHOR_RE);
    if (!m) return;
    const rec = { orderNo: m[1], pay: null, payExtra: [], payTime: null, serial: null };
    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      const nums = lines[j].match(MONEY_RE);
      if (nums && nums.length) {
        rec.pay = Number(nums[0]);
        rec.payExtra = nums.slice(1).map(Number);
        break;
      }
    }
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      if (!rec.payTime) {
        const dt = lines[j].match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
        if (dt) rec.payTime = dt[0];
      }
      if (!rec.serial) {
        const sn = lines[j].match(/^\s*(\d{20,})\s*$/);
        if (sn) rec.serial = sn[1];
      }
    }
    recs.push(rec);
    if (recs.length >= LOOKUP_MAX_NOS) return;
  });
  if (recs.length) return recs;
  // 没有任何行尾锚点：整段可能挤成一行，退回通用号码扫描，金额留空由人自己看
  return extractOrderNos(text).map(no => ({ orderNo: no, pay: null, payExtra: [], payTime: null, serial: null }));
}

app.post('/api/orders/lookup', auth, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const raw = String(b.text || '');
    if (raw.length > LOOKUP_MAX_TEXT) {
      return res.status(400).json({ ok: false, error: '一次粘贴超过 ' + LOOKUP_MAX_TEXT + ' 字，请分几批' });
    }
    const recs = parsePayRecords(raw);
    if (!recs.length) {
      return res.status(400).json({ ok: false, error: '没识别到订单号。需要 10-20 位连续数字，例如「批量付款-工资-技术服务-3316397630001242690」尾部那个号' });
    }
    const nos = [...new Set(recs.map(r => r.orderNo))];

    const db = await getDb();
    const proj = { projection: { date: 1, orderNo: 1, amount: 1, shareRate: 1, status: 1, doneDate: 1, note: 1 } };
    const rows = await db.collection(CONFIG.collection)
      .find({ orderNo: { $in: nos } }, proj).sort({ date: -1 }).limit(LOOKUP_MAX_NOS * 5).toArray();

    const byNo = new Map();
    rows.forEach(o => {
      const r = {
        _id: String(o._id), date: o.date || '', orderNo: o.orderNo || '',
        amount: Number(o.amount) || 0, shareRate: Number(o.shareRate) || 0,
        share: Math.round((Number(o.amount) || 0) * (Number(o.shareRate) || 0)) / 100,
        status: normalizeStatus(o.status), doneDate: o.doneDate || null, note: o.note || '',
      };
      if (!byNo.has(r.orderNo)) byNo.set(r.orderNo, []);
      byNo.get(r.orderNo).push(r);
    });

    const cards = recs.map(r => {
      const hits = byNo.get(r.orderNo) || [];
      return { ...r, rows: hits, state: hits.length ? (hits.length > 1 ? 'multi' : 'ok') : 'miss' };
    });

    const missing = nos.filter(n => !byNo.has(n));
    // 备注兜底：有些付款单号只写在备注里（如「补：3316…」），单独列一组给人判断，不混进命中
    // 号码已限定为纯数字，拼进 $regex 不存在注入面
    const noteHits = [];
    if (missing.length) {
      const probe = missing.slice(0, 50);
      const nrows = await db.collection(CONFIG.collection)
        .find({ $or: probe.map(n => ({ note: { $regex: n } })) }, proj).limit(200).toArray();
      nrows.forEach(r => {
        probe.filter(n => (r.note || '').includes(n)).forEach(n => {
          noteHits.push({ from: n, orderNo: r.orderNo, date: r.date || '', status: normalizeStatus(r.status), note: r.note || '' });
        });
      });
    }

    // 只回结构性计数；状态相关的数字由页面按 cards 现算，免得出现两份口径不同的汇总
    const multi = cards.filter(c => c.state === 'multi').length;
    const noPay = cards.filter(c => c.pay == null).length;
    res.json({
      ok: true, extracted: nos.length, records: cards.length,
      cards, noteHits, notFound: missing,
      counts: { multi, noPay },
      noteProbeCapped: missing.length > 50,
      truncated: rows.length >= LOOKUP_MAX_NOS * 5,
    });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
});

// ============ 【v26.83】二次核验清单 ============
// 逐单对账时撞上「金额对不上 / 重复单号 / 台账查无此号」的那几笔，先记下来最后处理。
// 刻意不写成订单的 status：分类里多一个值就会被 `status !== '已结算'` 这类现有判断当成
// 未结算计进收入、还会窜进分类看板和写手端。所以它是和分类垂直的一个标记，
// 存在 config 的一条文档里，订单本身不动。
const REVIEW_KEY = '***';
const REVIEW_MAX = 2000;
const REVIEW_REASONS = new Set(['diff', 'multi', 'miss']);

function cleanReviewItem(x) {
  const orderNo = String((x && x.orderNo) || '').slice(0, 24);
  if (!/^\d{6,24}$/.test(orderNo)) return null;
  const id = String((x && x._id) || '').slice(0, 24);
  if (id && !/^[0-9a-fA-F]{24}$/.test(id)) return null;
  const reason = REVIEW_REASONS.has(String(x && x.reason)) ? String(x.reason) : 'diff';
  const bill = (x && x.bill) || {};
  const pay = Number(bill.pay);
  return {
    key: id ? 'o:' + id : 'n:' + orderNo,
    orderNo, _id: id || null, reason,
    bill: {
      pay: Number.isFinite(pay) && pay >= 0 ? Math.round(pay * 100) / 100 : null,
      time: String(bill.time || '').slice(0, 20).replace(/[^\d\-: T]/g, ''),
      serial: String(bill.serial || '').slice(0, 40).replace(/\D/g, ''),
    },
    note: String((x && x.note) || '').slice(0, 80),
    at: String((x && x.at) || '').slice(0, 20).replace(/[^\d\-: T]/g, '') || null,
  };
}

async function readReview(db) {
  const d = await db.collection('config').findOne({ key: REVIEW_KEY });
  return d && Array.isArray(d.value && d.value.items) ? d.value.items : [];
}

async function writeReview(db, items, actor) {
  await db.collection('config').updateOne({ key: REVIEW_KEY }, {
    $set: { value: { items }, updatedAt: new Date(), updatedBy: actor },
    $setOnInsert: { key: REVIEW_KEY },
  }, { upsert: true });
}

app.get('/api/orders/review', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    res.json({ ok: true, items: await readReview(db) });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
});

// body: { op: 'add'|'clear'|'drop', items?: [...], keys?: [...] }
// add 按 key 覆盖（同一笔重复标记只留一条）；clear/drop 按 key 摘除。
app.post('/api/orders/review', auth, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const op = String(b.op || '');
    const db = await getDb();
    const cur = await readReview(db);
    let items = cur;
    if (op === 'add') {
      const incoming = (Array.isArray(b.items) ? b.items : []).map(cleanReviewItem).filter(Boolean);
      if (!incoming.length) return res.status(400).json({ ok: false, error: '要标记的内容不对（订单号需要 6-24 位数字）' });
      const map = new Map(cur.map(x => [x.key, x]));
      incoming.forEach(x => map.set(x.key, x));
      items = [...map.values()];
      if (items.length > REVIEW_MAX) {
        return res.status(400).json({ ok: false, error: '待核验已经 ' + cur.length + ' 条，超过 ' + REVIEW_MAX + ' 上限，请先清掉一批' });
      }
    } else if (op === 'clear' || op === 'drop') {
      const keys = new Set((Array.isArray(b.keys) ? b.keys : []).map(String));
      if (!keys.size) return res.status(400).json({ ok: false, error: '没指定要摘除哪几条' });
      items = cur.filter(x => !keys.has(x.key));
    } else {
      return res.status(400).json({ ok: false, error: '未知操作' });
    }
    await writeReview(db, items, req.user.username);
    res.json({ ok: true, items, added: op === 'add' ? items.length - cur.length : 0, removed: cur.length - items.length });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
});

// ============ 【v26.86】录单辅助：派单员记忆 与 收款信息 ============
// 派单员排序直接从不结算/已结算的订单里 tally writer —— 不另存一份计数器，
// 两处计数迟早对不上，而且删单/改单时计数器不会跟着动。
const PAYME_KEY = '***';
const ctrlRe = /[\u0000-\u001f\u007f]/g;
const cleanName = s => String(s || '').replace(ctrlRe, '').trim().slice(0, 30);

app.get('/api/orders/writers', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection(CONFIG.collection)
      .find({ writer: { $nin: [null, ''] } }, { projection: { writer: 1, date: 1, amount: 1 } })
      .limit(5000).toArray();
    const m = new Map();
    rows.forEach(o => {
      const k = cleanName(o.writer);
      if (!k) return;
      const c = m.get(k) || { name: k, n: 0, amount: 0, last: '' };
      c.n++;
      c.amount = Math.round((c.amount + (Number(o.amount) || 0)) * 100) / 100;
      if (String(o.date || '') > c.last) c.last = String(o.date);
      m.set(k, c);
    });
    res.json({ ok: true, writers: [...m.values()].sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1)).slice(0, 24) });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
});

// 固定收款资料：管理员自己收款用的支付宝账号+实名，全站就一份，录一次到处带出。
// 派单员是上游（给单的人），不是收款方，所以这里不去查任何写手账号。
// 账号和姓名只存这一条 config，绝不写进代码 —— 仓库是公开的。
app.get('/api/orders/payme', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const d = await db.collection('config').findOne({ key: PAYME_KEY });
    const v = (d && d.value) || {};
    res.json({ ok: true, account: v.account || '', realname: v.realname || '', updatedAt: v.updatedAt || '' });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
});

app.post('/api/orders/payme', auth, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const account = String(b.account || '').replace(ctrlRe, '').trim().slice(0, 50);
    const realname = cleanName(b.realname);
    if (account.length < 4) return res.status(400).json({ ok: false, error: '支付宝账号太短，确认一下是不是漏了字' });
    if (!realname) return res.status(400).json({ ok: false, error: '支付宝实名不能为空' });
    const value = { account, realname, updatedAt: new Date().toISOString() };
    const db = await getDb();
    await db.collection('config').updateOne({ key: PAYME_KEY },
      { $set: { value }, $setOnInsert: { key: PAYME_KEY } }, { upsert: true });
    res.json({ ok: true, account, realname, updatedAt: value.updatedAt });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
});

// ============ 【v26.84】未结算账龄报表（只读） ============
// 目的：按接单日算出每单已等待几天，时间段可筛，把三种金额口径各自汇总，
// 让管理员直接看出「下一次要打多少钱」。只读，不写库、不改状态。
// 为什么要单独一个接口而不是让页面在已加载的明细上算：
// 列表接口有 500 条上限且受当前期间筛选影响，拿它做金额决策会出现「没取到≠没有」，
// 报表必须自己到库里取全量。
const AGING_MAX_ROWS = 5000;
const AGING_BUCKETS = [[0, 7], [8, 15], [16, 30], [31, 60], [61, 90], [91, Infinity]];

app.get('/api/orders/aging', auth, adminOnly, async (req, res) => {
  try {
    const q = req.query;
    const dayRe = /^\d{4}-\d{2}-\d{2}$/;
    const field = q.field === 'doneDate' ? 'doneDate' : 'date';
    // Render 的容器是 UTC，直接用服务器本地日期会在北京时间 00:00-08:00 这段把「今天」
    // 算成前一天，等待天数跟着少一天。报表只读，这里按北京日历日算；
    // 写入路径的 localToday 不动（改了会牵动完单日默认值和历史统计口径）。
    const today = typeof cnDayStr === 'function' ? cnDayStr(new Date()) : localToday();
    if (!dayRe.test(today)) return res.status(500).json({ ok: false, error: '今天日期取不到，无法算等待天数' });

    const dateRange = {};
    if (q.from && dayRe.test(q.from)) dateRange.$gte = q.from;
    if (q.to && dayRe.test(q.to)) dateRange.$lte = q.to;
    if (Object.keys(dateRange).length === 0) delete dateRange.__none;

    // 默认看「还没结算」的三类；可以显式把已结算也拉进来（field=doneDate 时空值不计）
    const want = String(q.status || '').split(',').map(s => normalizeStatus(s.trim())).filter(s => STATUSES.includes(s));
    const statuses = want.length ? want : STATUSES.filter(s => s !== '已结算');

    const query = { status: { $in: statuses } };
    if (Object.keys(dateRange).length) query[field] = dateRange;
    if (q.minDays && /^\d{1,4}$/.test(String(q.minDays))) {
      const minD = Number(q.minDays);
      if (minD > 0) {
        const cut = new Date(today + 'T00:00:00');
        cut.setDate(cut.getDate() - minD);
        query[field] = Object.assign({}, query[field] || {}, { $lte: cut.toISOString().slice(0, 10) });
      }
    }
    if (q.q && q.q.trim()) {
      const rx = { $regex: String(q.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      query.$or = [{ orderNo: rx }, { note: rx }];
    }

    const db = await getDb();
    const rows = await db.collection(CONFIG.collection).find(query).limit(AGING_MAX_ROWS).toArray();
    const truncated = rows.length >= AGING_MAX_ROWS;

    // 派单卡的报酬：一次把涉及的卡捞出来，别按行 N 次查
    const ids = rows.map(r => String(r._id));
    const feeByOrder = new Map();
    if (ids.length) {
      const cards = await db.collection('cards')
        .find({ orderId: { $in: ids } })
        .project({ orderId: 1, reward: 1, toName: 1, status: 1 }).toArray();
      cards.forEach(c => {
        if (!c.orderId) return;
        const prev = feeByOrder.get(c.orderId) || { fee: 0, to: '', status: '' };
        prev.fee += Number(c.reward) || 0;
        prev.to = c.toName || prev.to;
        prev.status = c.status || prev.status;
        feeByOrder.set(c.orderId, prev);
      });
    }

    const r2 = x => Math.round(x * 100) / 100;
    const todayMs = Date.parse(today + 'T00:00:00');
    const list = rows.map(o => {
      const d = o[field] || o.date || '';
      const ms = Date.parse(d + 'T00:00:00');
      const days = Number.isFinite(ms) ? Math.max(0, Math.floor((todayMs - ms) / 86400000)) : 0;
      const amount = Number(o.amount) || 0, rate = Number(o.shareRate) || 0;
      const share = r2(amount * rate / 100);
      const dinfo = feeByOrder.get(String(o._id));
      return {
        _id: String(o._id), date: o.date || '', doneDate: o.doneDate || null, orderNo: o.orderNo || '',
        amount: r2(amount), shareRate: rate, share, days,
        status: normalizeStatus(o.status), note: o.note || '',
        writer: dinfo ? (dinfo.to || '') : '', writerFee: dinfo ? r2(dinfo.fee) : 0, cardStatus: dinfo ? dinfo.status : '',
      };
    });
    return finish(list);

    function finish(items) {
      const splitFilter = String(q.split || 'all');
      let out = items;
      if (splitFilter === 'yes') out = items.filter(x => x.writerFee > 0);
      else if (splitFilter === 'no') out = items.filter(x => x.writerFee === 0);
      out.sort((a, b) => b.days - a.days);
      const sum = { amount: 0, share: 0, writerFee: 0, net: 0 };
      const buckets = AGING_BUCKETS.map(([lo, hi]) => ({ lo, hi, n: 0, amount: 0, share: 0, writerFee: 0 }));
      out.forEach(x => {
        sum.amount += x.amount; sum.share += x.share; sum.writerFee += x.writerFee;
        sum.net += x.share - x.writerFee;
        const b = buckets.find(bk => x.days >= bk.lo && x.days <= bk.hi);
        if (b) { b.n++; b.amount = r2(b.amount + x.amount); b.share = r2(b.share + x.share); b.writerFee = r2(b.writerFee + x.writerFee); }
      });
      return res.json({
        ok: true, today, field, statuses, from: dateRange.$gte || null, to: dateRange.$lte || null,
        minDays: /^\d{1,4}$/.test(String(q.minDays || '0')) ? Number(q.minDays || 0) : 0,
        split: splitFilter, keyword: String(q.q || ''),
        total: out.length, truncated,
        sums: { amount: r2(sum.amount), share: r2(sum.share), writerFee: r2(sum.writerFee), net: r2(sum.net) },
        buckets: buckets.map(b => ({ ...b, hiLabel: Number.isFinite(b.hi) ? b.hi : '' })),
        oldestDays: out.length ? out[0].days : 0,
        rows: out.slice(0, 500),
      });
    }
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
});

// ============ 【v26.85】数据分析大屏（只读） ============
// 一次把月度/年度、完成速度、到账周期、每日环比、账龄概览全算好返回，
// 页面只负责画。同样是服务端全量取数：前端那份明细有 500 条上限，拿来算年度趋势会偏小。
const INS_MAX_ROWS = 5000;
const SPEED_BUCKETS = [[0, 0, '当天'], [1, 3, '1-3 天'], [4, 7, '4-7 天'], [8, 15, '8-15 天'], [16, 30, '16-30 天'], [31, Infinity, '30 天以上']];

app.get('/api/orders/insights', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.collection(CONFIG.collection).find({}, {
      projection: { date: 1, doneDate: 1, status: 1, amount: 1, shareRate: 1, settledAt: 1 },
    }).limit(INS_MAX_ROWS).toArray();

    const today = typeof cnDayStr === 'function' ? cnDayStr(new Date()) : localToday();
    const r2 = x => Math.round(x * 100) / 100;
    const dayNum = s => Date.parse(String(s).slice(0, 10) + 'T00:00:00Z');
    const dDiff = (a, b) => Math.round((dayNum(a) - dayNum(b)) / 86400000);
    const mean = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null;
    const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2 * 10) / 10; };
    const pct = (a, b) => (b ? Math.round((a - b) / b * 1000) / 10 : null);
    const shareOf = o => r2((Number(o.amount) || 0) * (Number(o.shareRate) || 0) / 100);
    const dayStr = v => typeof cnDayStr === 'function' ? cnDayStr(new Date(v)) : String(v).slice(0, 10);

    const byMonth = new Map(), byYear = new Map(), perDay = new Map();
    const speed = [], cycle = [];
    const stCount = {}, agingBuckets = [[0, 7], [8, 15], [16, 30], [31, 60], [61, 90], [91, Infinity]]
      .map(([lo, hi]) => ({ lo, hi, n: 0, amount: 0, share: 0 }));
    let totalAmount = 0, totalShare = 0, settledNoStamp = 0, unsettled = { n: 0, amount: 0, share: 0 }, oldest = 0;

    rows.forEach(o => {
      const amt = Number(o.amount) || 0, sh = shareOf(o), st = normalizeStatus(o.status) || '未知';
      totalAmount = r2(totalAmount + amt); totalShare = r2(totalShare + sh);
      stCount[st] = (stCount[st] || 0) + 1;

      const ym = String(o.date || '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(ym)) {
        const m = byMonth.get(ym) || { ym, n: 0, amount: 0, share: 0, settled: 0 };
        m.n++; m.amount = r2(m.amount + amt); m.share = r2(m.share + sh);
        if (st === '已结算') m.settled++;
        byMonth.set(ym, m);
      }
      const yy = String(o.date || '').slice(0, 4);
      if (/^\d{4}$/.test(yy)) {
        const y = byYear.get(yy) || { year: yy, n: 0, amount: 0, share: 0 };
        y.n++; y.amount = r2(y.amount + amt); y.share = r2(y.share + sh);
        byYear.set(yy, y);
      }
      if (o.date) {
        const d = perDay.get(o.date) || { d: o.date, n: 0, amount: 0, share: 0 };
        d.n++; d.amount = r2(d.amount + amt); d.share = r2(d.share + sh);
        perDay.set(o.date, d);
      }
      // 完成速度：接单日 → 完单日（两个都填了才算，缺一个就不进样本，避免瞎估）
      if (o.date && o.doneDate) { const d = dDiff(o.doneDate, o.date); if (d >= 0) speed.push(d); }
      // 到账周期：完单日 → 结算时间戳。没有戳的已结算单计入 missing，不冒充 0 天
      if (o.settledAt) {
        const base = o.doneDate || o.date;
        const sd = dayStr(o.settledAt);
        if (base && /^\d{4}-\d{2}-\d{2}$/.test(sd)) { const d = dDiff(sd, base); if (d >= 0) cycle.push(d); }
      } else if (st === '已结算') settledNoStamp++;
      // 未结算账龄：从接单日等到今天
      if (st !== '已结算' && o.date) {
        const d = Math.max(0, dDiff(today, o.date));
        unsettled.n++; unsettled.amount = r2(unsettled.amount + amt); unsettled.share = r2(unsettled.share + sh);
        if (d > oldest) oldest = d;
        const b = agingBuckets.find(x => d >= x.lo && d <= x.hi);
        if (b) { b.n++; b.amount = r2(b.amount + amt); b.share = r2(b.share + sh); }
      }
    });

    const sumOf = arr => arr.reduce((a, x) => ({ n: a.n + x.n, amount: r2(a.amount + x.amount), share: r2(a.share + x.share) }), { n: 0, amount: 0, share: 0 });
    const windowDays = n => { const out = []; for (let i = 0; i < n; i++) out.push(new Date(dayNum(today) - i * 86400000).toISOString().slice(0, 10)); return out; };
    const d30 = windowDays(30).reverse().map(d => perDay.get(d) || { d, n: 0, amount: 0, share: 0 });
    const w7 = sumOf(windowDays(7).map(d => perDay.get(d) || { n: 0, amount: 0, share: 0 }));
    const p7 = sumOf(windowDays(14).slice(7).map(d => perDay.get(d) || { n: 0, amount: 0, share: 0 }));
    const thisMonth = String(today).slice(0, 7);
    const dom = Number(String(today).slice(8, 10));
    const prevMonthYm = (() => { const t = new Date(dayNum(thisMonth + '-01')); t.setUTCMonth(t.getUTCMonth() - 1); return t.toISOString().slice(0, 7); })();
    const monthWindow = (ym) => windowDays(dom).map(d => ym + '-' + d.slice(8, 10)).map(k => perDay.get(k) || { n: 0, amount: 0, share: 0 });
    const mNow = sumOf(monthWindow(thisMonth)), mPrev = sumOf(monthWindow(prevMonthYm));
    const dayArr = [...perDay.values()].filter(x => x.n).sort((a, b) => b.amount - a.amount);

    const speedBuckets = SPEED_BUCKETS.map(([lo, hi, label]) => ({ label, n: speed.filter(d => d >= lo && d <= hi).length }));

    return res.json({
      ok: true, today, total: rows.length, truncated: rows.length >= INS_MAX_ROWS,
      sums: { amount: totalAmount, share: totalShare, avgOrder: rows.length ? r2(totalAmount / rows.length) : 0 },
      stCount,
      months: [...byMonth.values()].sort((a, b) => a.ym < b.ym ? -1 : 1),
      years: [...byYear.values()].sort((a, b) => a.year < b.year ? -1 : 1)
        .map((y, i, arr) => ({ ...y, prev: i ? arr[i - 1].amount : null, growth: i ? pct(y.amount, arr[i - 1].amount) : null })),
      speed: { samples: speed.length, noDoneDate: rows.length - speed.length, avg: mean(speed), median: median(speed), max: speed.length ? Math.max(...speed) : null, buckets: speedBuckets },
      cycle: { samples: cycle.length, avg: mean(cycle), median: median(cycle), settledTotal: stCount['已结算'] || 0, missing: settledNoStamp, since: cycle.length ? '已有戳的样本算出' : '还没有带结算时间戳的单据' },
      daily30: d30, dailyPeak: dayArr.slice(0, 3), dailySlow: dayArr.slice(-3).reverse(),
      compare: { last7: w7, prev7: p7, amountPct: pct(w7.amount, p7.amount), countPct: pct(w7.n, p7.n), monthNow: mNow, monthPrev: mPrev, monthPct: pct(mNow.amount, mPrev.amount), monthLabel: thisMonth, prevLabel: prevMonthYm, monthNote: '两月各取 1 号到 ' + dom + ' 号，同天数才可比' },
      aging: { ...unsettled, oldest, buckets: agingBuckets },
    });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
});

// ============ 【v26.66】分成比例：默认值配置 + 批量修改 ============
// 路由都挂在 /api/orders/xxx 上且只用 GET/POST —— 已存在的 PUT/DELETE /api/orders/:id 会
// 吃掉 /api/orders/<单个词> 的形态（Express 按注册顺序匹配），所以这里不用 PUT，避免抢路由。
const SHARE_CFG_KEY = 'ledger_share_rate';
// 2026-09-27 起新单默认分成比例 40% → 45%（历史订单不自动追溯改动，需要调的用下面的批量接口）
const DEFAULT_SHARE_RATE = 45;
const SETTLED = '已结算';

async function readShareDefault(db) {
  const d = await db.collection('config').findOne({ key: SHARE_CFG_KEY });
  const v = d && Number(d.value && d.value.shareRate);
  return isFinite(v) && v > 0 && v <= 100 ? Math.round(v * 100) / 100 : DEFAULT_SHARE_RATE;
}

// 前端读取默认比例（新增/快捷录入表单的预填值从这里来，不再写死在页面里）
app.get('/api/orders/share-default', auth, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    res.json({ ok: true, shareRate: await readShareDefault(db), fallback: DEFAULT_SHARE_RATE });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
});

// 修改默认比例（只影响之后新建的订单，不动历史数据）
app.post('/api/orders/share-default', auth, adminOnly, async (req, res) => {
  try {
    const rate = Number((req.body || {}).shareRate);
    if (!isFinite(rate) || rate <= 0 || rate > 100) return res.status(400).json({ ok: false, error: '分成比例必须是 1-100 之间的数字（%）' });
    const r = Math.round(rate * 100) / 100;
    const db = await getDb();
    await db.collection('config').updateOne({ key: SHARE_CFG_KEY },
      { $set: { value: { shareRate: r }, updatedBy: req.user.username, updatedAt: new Date() }, $setOnInsert: { key: SHARE_CFG_KEY } },
      { upsert: true });
    await db.collection('order_audit').insertOne({
      by: req.user.id, actor: req.user.username, action: 'set_default_share_rate', to: r, createdAt: new Date(),
    }).catch(e => console.warn('[台账] 审计写入失败:', e.message));
    res.json({ ok: true, shareRate: r });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
});

// 批量修改分成比例的「影响测算」：预览（dryRun）与真实写入必须走同一段代码、同一个 filter，
// 否则弹窗按当前页 20 行估算、服务端却改了库里 300 条，确认框上写的金额就成了假的。
async function planShareBatch(db, filter, to) {
  const targets = await db.collection(CONFIG.collection).find(filter, {
    projection: { orderNo: 1, amount: 1, shareRate: 1, status: 1 },
  }).toArray();
  const need = targets.filter(o => Math.round(Number(o.shareRate) * 100) / 100 !== to);
  const r2 = x => Math.round(x * 100) / 100;
  let before = 0, after = 0, amt = 0;
  const groups = new Map();
  for (const o of need) {
    const a = Number(o.amount) || 0, from = Number(o.shareRate) || 0;
    before += a * from / 100; after += a * to / 100; amt += a;
    const key = Math.round(from * 100) / 100;
    const g = groups.get(key) || { from: key, n: 0, amount: 0 };
    g.n += 1; g.amount = r2(g.amount + a);
    groups.set(key, g);
  }
  return {
    targets, need,
    stats: {
      matched: targets.length, willUpdate: need.length, skippedUnchanged: targets.length - need.length,
      overLimit: need.length > 5000,
      amountTotal: r2(amt), shareBefore: r2(before), shareAfter: r2(after), delta: r2(after - before),
      byRate: [...groups.values()].sort((x, y) => y.n - x.n).slice(0, 8),
    },
  };
}

// 批量修改分成比例
//   body: { ids?: string[], all?: boolean, shareRate: number, includeSettled?: boolean, dryRun?: boolean }
//   ids = 手动勾选的那批；all = 按"全部/仅未结算"整体调整。二者必给其一。
//   dryRun=true 只回影响测算，不落库、不写审计、不清缓存——给弹窗预览用。
app.post('/api/orders/share-batch', auth, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const rate = Number(b.shareRate);
    if (!isFinite(rate) || rate <= 0 || rate > 100) return res.status(400).json({ ok: false, error: '分成比例必须是 1-100 之间的数字（%）' });
    const to = Math.round(rate * 100) / 100;
    const includeSettled = !!b.includeSettled;
    const dryRun = b.dryRun === true;

    const filter = {};
    if (Array.isArray(b.ids) && b.ids.length) {
      const valid = b.ids.filter(x => ObjectId.isValid(String(x)));
      if (!valid.length) return res.status(400).json({ ok: false, error: '勾选的订单号无效' });
      if (valid.length !== b.ids.length) return res.status(400).json({ ok: false, error: '有 ' + (b.ids.length - valid.length) + ' 个订单号不合法，已拒绝整批' });
      filter._id = { $in: valid.map(x => new ObjectId(String(x))) };
    } else if (b.all === true) {
      // 全量模式：刻意不给"按当前筛选条件"的服务端猜测空间 —— 前端筛选口径（跨期接单/完单）
      // 与查询条件不是一回事，让调用方把实际要改的 _id 传过来，避免"以为改了 20 条其实改了 2000 条"
    } else {
      return res.status(400).json({ ok: false, error: '请指定要修改的订单（勾选若干条，或明确选择整体调整）' });
    }
    if (!includeSettled) filter.status = { $ne: SETTLED };

    const db = await getDb();
    // 先取快照：一是给"改了多少、从多少改到多少"的预览与留痕，二是历史可回滚
    // 【v26.68 修复线上 500】投影只能全用包含或全用排除（除 _id 外不可混用），
    // 原先写了 dispatch: 0 —— 而 dispatch 根本不是订单文档上的字段（它是列表接口
    // 查派单卡后临时拼出来的），混用让 Mongo 直接报 Cannot do inclusion/exception mix。
    const { targets, need, stats } = await planShareBatch(db, filter, to);
    if (dryRun) return res.json({ ok: true, preview: true, shareRate: to, includeSettled, ...stats });
    if (!need.length) {
      return res.json({ ok: true, updated: 0, skippedUnchanged: targets.length,
        message: targets.length ? '所选订单的分成比例已经都是 ' + to + '%，无需修改' : '没有符合条件的订单' });
    }
    if (stats.overLimit) return res.status(400).json({ ok: false, error: '一次最多改 5000 条，请分批操作' });

    const before = need.map(o => ({ id: String(o._id), orderNo: o.orderNo || '', from: o.shareRate, to, amount: o.amount || 0, status: o.status }));
    const r = await db.collection(CONFIG.collection).updateMany(
      { _id: { $in: need.map(o => o._id) } },
      { $set: { shareRate: to, updatedAt: new Date() } }
    );
    // 审计：整批一条记录，保留逐条原值，便于事后回滚与对账
    await db.collection('order_audit').insertOne({
      by: req.user.id, actor: req.user.username, action: 'batch_share_rate',
      to, includeSettled, matched: targets.length, updated: r.modifiedCount,
      before, createdAt: new Date(),
    }).catch(e => console.warn('[台账] 审计写入失败:', e.message));
    cacheClearPrefix('orders:');
    res.json({
      ok: true, updated: r.modifiedCount, skippedUnchanged: stats.skippedUnchanged,
      amountDelta: stats.delta, shareBefore: stats.shareBefore, shareAfter: stats.shareAfter,
      message: '已把 ' + r.modifiedCount + ' 条订单的分成比例改为 ' + to + '%',
    });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// 新增
app.post('/api/orders', auth, adminOnly, async (req, res) => {
  const { doc, errors } = parseOrder(req.body || {});
  if (errors) return res.status(400).json({ ok: false, error: errors.join('；') });
  try {
    const db = await getDb();
    doc.createdAt = new Date();
    if (doc.status === SETTLED) doc.settledAt = new Date();   // 建单即已结算，也记上时间戳
    const r = await db.collection(CONFIG.collection).insertOne(doc);
    cacheClearPrefix('orders:');   // 【2026-09-26】原先是全量 clear（把所有筛选组合一把清空，
                                      // 紧接着每个台账请求都穿透到库），改成只失效订单缓存
    res.json({ ok: true, _id: r.insertedId, order: doc });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
});

// 修改
app.put('/api/orders/:id', auth, adminOnly, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, error: '无效的订单ID' });
  const { doc, errors } = parseOrder(req.body || {});
  if (errors) return res.status(400).json({ ok: false, error: errors.join('；') });
  try {
    const db = await getDb();
    doc.updatedAt = new Date();
    // 结算时间戳只在「跨进/跨出已结算」那一刻写：历史单没有这个字段，
    // 到账周期报表会如实标出样本覆盖率，不拿缺失当 0。
    const prev = await db.collection(CONFIG.collection).findOne(
      { _id: new ObjectId(req.params.id) }, { projection: { status: 1 } });
    if (prev) {
      if (doc.status === SETTLED && normalizeStatus(prev.status) !== SETTLED) doc.settledAt = new Date();
      else if (doc.status !== SETTLED && normalizeStatus(prev.status) === SETTLED) doc.settledAt = null;
    }
    const r = await db.collection(CONFIG.collection).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: doc },
      { returnDocument: 'after' }
    );
    if (!r) return res.status(404).json({ ok: false, error: '订单不存在' });
    cacheClearPrefix('orders:');   // 【2026-09-26】原先是全量 clear（把所有筛选组合一把清空，
                                      // 紧接着每个台账请求都穿透到库），改成只失效订单缓存
    res.json({ ok: true, order: r });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
});

// 删除
app.delete('/api/orders/:id', auth, adminOnly, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, error: '无效的订单ID' });
  try {
    const db = await getDb();
    const r = await db.collection(CONFIG.collection).deleteOne({ _id: new ObjectId(req.params.id) });
    if (r.deletedCount === 0) return res.status(404).json({ ok: false, error: '订单不存在' });
    cacheClearPrefix('orders:');   // 【2026-09-26】原先是全量 clear（把所有筛选组合一把清空，
                                      // 紧接着每个台账请求都穿透到库），改成只失效订单缓存
    res.json({ ok: true });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
});

// 批量导入（JSON数组，用于Excel迁移）
app.post('/api/orders/batch', auth, adminOnly, async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : [];
    if (!list.length) return res.status(400).json({ ok: false, error: '没有数据' });
    // 一次灌几万条会把请求体、文档数组与 insertMany 结果全堆在内存里，给个明确上限让人分批
    if (list.length > 2000) return res.status(400).json({ ok: false, error: '单次最多导入 2000 条，请分批（同一批次可按订单号安全重放）' });
    const docs = []; const errs = [];
    list.forEach((item, i) => {
      const { doc, errors } = parseOrder(item);
      if (errors) errs.push(`第${i + 1}条: ${errors.join('；')}`);
      else { doc.createdAt = new Date(); docs.push(doc); }
    });
    if (errs.length) return res.status(400).json({ ok: false, error: errs.join(' | ') });
    const db = await getDb();
    // 【2026-09-26 批次2】原先 orderNo 没有唯一约束、insertMany 又是 ordered 模式
    // （中途抛错时前面已入库、响应却是 500），而运营遇到 500 的习惯动作就是"再点一次导入"
    // —— 一次网络抖动就能让台账与利润口径整体翻倍，数据库不会拦。
    // 现在按订单号先查已存在的并跳过，只插新的。
    const nos = [...new Set(docs.map(d => d.orderNo).filter(Boolean))];
    const existed = new Set();
    for (let i = 0; i < nos.length; i += 500) {
      const rows = await db.collection(CONFIG.collection)
        .find({ orderNo: { $in: nos.slice(i, i + 500) } }, { projection: { orderNo: 1 } }).toArray();
      rows.forEach(e => existed.add(e.orderNo));
    }
    const seen = new Set();
    const fresh = docs.filter(d => {
      if (!d.orderNo) return true;                       // 无订单号的行不参与去重（历史允许空）
      if (existed.has(d.orderNo) || seen.has(d.orderNo)) return false;
      seen.add(d.orderNo); return true;
    });
    const skipped = docs.length - fresh.length;
    let inserted = 0;
    if (fresh.length) {
      // ordered:false —— 单条失败不中断整批，避免"半截入库 + 整体报 500"
      try {
        const r = await db.collection(CONFIG.collection).insertMany(fresh, { ordered: false });
        inserted = r.insertedCount;
      } catch (e) {
        if (e && (e.code === 12587 || Array.isArray(e.writeErrors))) {
          inserted = (e.result && e.result.insertedCount) || 0;   // 部分成功：已写入的照实回报
          console.warn('[台账] 批量导入部分失败：', (e.writeErrors || []).length, '条被拒');
        } else throw e;
      }
    }
    if (inserted) cacheClearPrefix('orders:');
    res.json({ ok: true, inserted, skipped,
      message: skipped ? `新增 ${inserted} 条，跳过 ${skipped} 条重复订单号` : `新增 ${inserted} 条` });
  } catch (e) {
    console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' });
  }
});
}
