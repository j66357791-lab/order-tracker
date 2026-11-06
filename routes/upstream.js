// routes/upstream.js — 上游对账（只读）：粘贴上游表格 或 拉几何视传 → 只回"有问题的行"
//
// 为什么放服务端而不是浏览器：
//   1) 台账侧不能再用 /api/orders 那份「一次 500 条」的列表去比，超 500 会静默漏；这里直接按单号查库。
//   2) 上游接口没有 CORS 头，浏览器直连必被拦，必须服务端转发。
//   3) 判定规则只有一份，不会前端一套后端一套。
// 红线：全程只读。不改台账、不改上游平台、不代申请结算。
const EXTERNAL_BASE = 'http://118.178.147.191/api/public/order-query';   // 几何视传只读查询
const EXT_TTL = 60000;          // 上游 60 秒缓存，防止手一抖连点把人家的服务打爆
const NOISE = 1;                // 金额差 ≤1 元：他录台账取整造成的噪声，单独一组不吓人

export default function mount(ctx) {
  const { app, auth, adminOnly, getDb, CONFIG, ObjectId, normalizeStatus, cacheGet, cacheSet } = ctx;
  const num = s => Number(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')) || 0;
  const r2 = n => Math.round(n * 100) / 100;
  const splitLine = (l, d) => l.split(d).map(s => String(s || '').trim());

  /* ---------- 解析粘贴文本：Tab 优先，逗号兜底；带引号的 CSV 也吃得下 ---------- */
  function parsePaste(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
      .map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
    if (lines.length < 2) return { error: '至少要表头 + 1 行数据' };
    const delim = (lines[0].match(/\t/g) || []).length >= 1 ? '\t' : ',';
    const unq = s => { s = String(s || '').trim(); return s.length > 1 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1).replace(/""/g, '"') : s; };
    const headers = splitLine(lines[0], delim).map(unq);
    if (headers.length < 2) return { error: '只识别出 ' + headers.length + ' 列，请用 Tab 或逗号分隔' };
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = splitLine(lines[i], delim).map(unq);
      if (String(cells[0] || '').trim() === '合计' || /^\d+\s*单$/.test(String(cells[1] || '').trim())) continue;  // 他 CSV 末尾的合计行在第一列
      const o = {};
      headers.forEach((h, k) => { o[h] = cells[k] || ''; });
      rows.push(o);
    }
    if (!rows.length) return { error: '剔掉合计行后没数据了' };
    return { headers, rows, delim };
  }

  /* ---------- 认列：按他真表（18 列那张）与几何字段调过 ---------- */
  const IGNORE = /身份证|授权码|查询数据编号|是否填写正确|打款手机号|打款实名/;
  function guess(h) {
    const s = String(h || '');
    if (IGNORE.test(s)) return '';
    if (/^(订单号|单号)|订单编号|order[_\s-]*no/i.test(s) && !/备注/.test(s)) return 'no';
    if (/实际发送工资|发送工资|已发工资|到账金额|实发/.test(s)) return 'paid';
    if (/订单金额|接单金额|金额|amount|total|price/i.test(s)) return 'amount';
    if (/初稿/.test(s)) return 'draft';
    if (/终稿|交付|完稿/.test(s)) return 'final';
    if (/预估|参考|等待系统/.test(s)) return '';
    if (/收货|结算日期|到账日期|完成日期/.test(s)) return 'doneDate';
    if (/付款|下单日期|接单日|创建日期/.test(s)) return 'takeDate';
    if (/^群|群$|客户/.test(s)) return 'group';
    if (/渠道|来源|channel|平台/.test(s)) return 'team';
    if (/审核状态|结算状态|打款状态/.test(s)) return 'status';
    if (/订单状态|交易|物流/.test(s)) return 'orderStatus';
    if (/状态|进度|status/.test(s)) return 'status';
    if (/派单|负责人|设计师|designer/.test(s)) return 'person';
    if (/备注|说明|note/.test(s)) return 'note';
    return '';
  }

  /* ---------- 状态合成：审核完成已打款=已结算；审核中+有确认收货=待结算；审核中+没收货=进行中 ---------- */
  function toStatus(audit, trade, doneDate) {
    const s = String(audit || '') + ' ' + String(trade || '');
    if (/审核完成|已打款|已结算|结算完|已到账/.test(s)) return '已结算';
    if (/审核中/.test(String(audit || ''))) return doneDate ? '待结算' : '进行中';
    if (/待结算|已交付|已收货|待打款/.test(s)) return '待结算';
    if (/进行中|制作/.test(s)) return '进行中';
    if (/待开始|未开始|排队/.test(s)) return '待开始';
    return '';
  }

  /* ---------- 外部行归一：source=paste 用认列结果，source=jihe 用固定字段 ---------- */
  function normPaste(rows, headers, colmap) {
    return rows.map(r => {
      const g = k => { const i = colmap.indexOf(k); return i > -1 ? String(r[headers[i]] || '') : ''; };
      const n = nosOf(g('no'));
      return {
        no: n.primary, nos: n.all, multi: n.multi, raw: String(g('no') || '').trim(),
        amount: num(g('amount')), paid: num(g('paid')), group: g('group'), team: g('team') || g('person'),
        person: g('person'), doneDate: g('doneDate').slice(0, 10), takeDate: g('takeDate').slice(0, 10),
        status: toStatus(g('status'), g('orderStatus'), g('doneDate').trim()),
        trade: g('orderStatus'), audit: g('status'),
        odd: (/交易关闭|关闭|退款/.test(g('orderStatus')) || (num(g('amount')) === 0 && !!n.primary)) ? '金额 ' + num(g('amount')) + '、状态「' + (g('orderStatus') || '空') + '」' : '',
      };
    });
  }
  const normJihe = list => list.map(o => {
    const n = nosOf(o.order_no);
    return {
      no: n.primary, nos: n.all, multi: n.multi, raw: String(o.order_no || '').trim(),
      amount: num(o.amount), paid: num(o.amount), group: String(o.customer_group_id || ''),
      team: String(o.channel_name || ''), person: String(o.designer_name || ''),
      doneDate: String(o.delivered_at || '').slice(0, 10), takeDate: String(o.created_at || '').slice(0, 10),
      status: o.settled ? '已结算' : o.production_status === 'delivered' ? '待结算' : o.production_status === 'final' ? '进行中' : '待开始',
      trade: String(o.settled_label || ''), audit: String(o.settlement || ''),
      odd: n.primary && num(o.amount) === 0 ? '金额 0、结算「' + (o.settled_label || '空') + '」' : (!n.primary ? '上游没给订单号（need_order_no=' + !!o.need_order_no + '）' : ''),
    };
  });

  /* ---------- 单号规整：上游真有"一格塞两个订单号"的行（逗号分隔），必须拆开匹配并单独列出来 ---------- */
  const SPLIT_NO = /[,，;；、\/\s]+/;
  const nosOf = raw => {
    const all = [...new Set(String(raw || '').split(SPLIT_NO).map(s => s.trim()).filter(s => /^\d{6,24}$/.test(s)))];
    return { primary: all[0] || '', all, multi: all.length > 1 };
  };

  /* ---------- 核心比对：台账侧直接按单号查库，绕开列表 500 上限 ---------- */
  async function match(db, ext) {
    const nos = [...new Set(ext.flatMap(x => x.nos || []))];
    const found = nos.length
      ? await db.collection(CONFIG.collection).find({ orderNo: { $in: nos } }, {
        projection: { orderNo: 1, date: 1, amount: 1, shareRate: 1, status: 1, doneDate: 1, writer: 1, note: 1 },
      }).limit(5000).toArray() : [];
    const byNo = new Map();
    found.forEach(o => { const k = String(o.orderNo || '').trim(); if (!byNo.has(k)) byNo.set(k, o); else { const d = byNo.get(k); (d._dup = d._dup || [d]).push(o); } });
    const out = { matched: 0, missLedger: [], missUp: [], amtBad: [], amtNoise: [], shareBad: [], stBad: [], odd: [], dup: [], noKey: [], multiNo: [] };
    ext.forEach(x => {
      const list = x.nos || [];
      if (x.multi) {
        const hit = list.map(n => byNo.get(n)).find(Boolean);
        out.multiNo.push({ ext: x, ledger: hit || null, nosText: list.join('、') });   // 让他看见这一格里其实塞了几个号
      }
      if (!list.length) { out.noKey.push({ ext: x }); return; }
      const l = list.map(n => byNo.get(n)).find(Boolean);
      if (x.odd) out.odd.push({ ext: x, ledger: l || null });
      if (!l) { out.missLedger.push({ ext: x }); return; }
      out.matched++;
      if (l._dup) out.dup.push({ ledger: l, count: l._dup.length, ext: x });
      const diff = r2(x.amount - num(l.amount));
      if (Math.abs(diff) > 0.01) (Math.abs(diff) <= NOISE ? out.amtNoise : out.amtBad).push({ ext: x, ledger: l, diff });
      if (x.paid > 0) {
        const share = r2(num(l.amount) * num(l.shareRate) / 100);
        if (Math.abs(x.paid - share) > 0.05) out.shareBad.push({ ext: x, ledger: l, share, diff: r2(x.paid - share) });
      }
      const ls = normalizeStatus(l.status);
      if (x.status && ls !== x.status) out.stBad.push({ ext: x, ledger: l, ledgerStatus: ls, extStatus: x.status });
    });
    // 「台账有、这批外部数据没有」：只在这次粘贴覆盖的日期区间里找，跨月历史不冤枉他
    const days = ext.map(x => String(x.takeDate || x.doneDate || '')).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (days.length) {
      const inSet = new Set(ext.flatMap(x => x.nos || []));
      const span = await db.collection(CONFIG.collection).find(
        { date: { $gte: days[0], $lte: days[days.length - 1] } },
        { projection: { orderNo: 1, amount: 1, shareRate: 1, status: 1, date: 1, writer: 1 } }).limit(5000).toArray();
      out.missUp = span.filter(o => o.orderNo && !inSet.has(String(o.orderNo).trim()))
        .map(o => ({ ledger: o }));
      out.span = { from: days[0], to: days[days.length - 1], scanned: span.length };
    }
    return out;
  }
  const pick = a => a.slice(0, 200).map(x => ({
    no: x.ext ? x.ext.no : String((x.ledger || {}).orderNo || ''),
    src: x.ext ? x.ext.src : undefined, raw: x.ext ? x.ext.raw : undefined, nos: x.ext ? x.ext.nos : undefined,
    extNosText: x.ext && x.ext.multi ? (x.ext.nos || []).join('、') : undefined,
    extAmount: x.ext ? x.ext.amount : undefined, extPaid: x.ext ? x.ext.paid : undefined,
    extStatus: x.ext ? x.ext.status : undefined, extTeam: x.ext ? x.ext.team : undefined, extDate: x.ext ? (x.ext.takeDate || x.ext.doneDate) : undefined,
    odd: x.ext ? x.ext.odd : undefined,
    ledId: x.ledger ? String(x.ledger._id) : undefined, ledAmount: x.ledger ? num(x.ledger.amount) : undefined,
    ledRate: x.ledger ? num(x.ledger.shareRate) : undefined, ledShare: x.ledger ? r2(num(x.ledger.amount) * num(x.ledger.shareRate) / 100) : undefined,
    ledStatus: x.ledger ? normalizeStatus(x.ledger.status) : undefined, ledDate: x.ledger ? String(x.ledger.date || '').slice(0, 10) : undefined,
    ledWriter: x.ledger ? String(x.ledger.writer || '') : undefined,
    diff: x.diff, share: x.share, count: x.count,
  }));

  /* ---------- 多来源合并：一次比对可以带「粘贴的表格」+「几何拉取」 ---------- */
  // 每段粘贴是一个 block（空行分段），几何是一整个来源；每条外部行都打上 src 标签，
  // 汇总一律分源给数，不混成一个总额 —— 金山给的是「订单金额 + 已发工资」两栏，
  // 几何只给「佣金」一栏，语义不同，相加会编出一个不存在的数字。
  function splitBlocks(text) {
    const out = []; let cur = [];
    for (const l of String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
      if (!l.trim()) { if (cur.length) { out.push(cur.join('\n')); cur = []; } continue; }
      cur.push(l);
    }
    if (cur.length) out.push(cur.join('\n'));
    return out;
  }

  async function collectSources(b) {
    const list = Array.isArray(b.sources) && b.sources.length ? b.sources
      : (b.source === 'jihe' ? [{ kind: 'jihe', account: b.account }] : [{ kind: 'paste', text: b.text, colmap: b.colmap }]);
    const ext = [], cols = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i] || {};
      if (s.kind === 'jihe') {
        const account = cleanAcc(s.account) || await savedAccount();
        if (!/^\d{6,20}$/.test(account)) throw Object.assign(new Error('几何视传要填你的结算账号（页面上填一次就存住）'), { userFacing: true });
        const cached = cacheGet('ext:jihe:' + account);
        const raw = cached || await fetchJihe(account);
        if (!cached) cacheSet('ext:jihe:' + account, raw);
        const src = '几何视传';
        normJihe(raw).forEach(x => { x.src = src; ext.push(x); });
        cols.push({ src, kind: 'jihe', rows: raw.length });
      } else {
        const blocks = b.singleBlock ? [String(s.text || '')] : splitBlocks(s.text);
        for (let k = 0; k < blocks.length; k++) {
          const p = parsePaste(blocks[k]);
          if (p.error) continue;                       // 这段是空白或说明文字，跳过
          const nm = String(s.name || '').trim() || '粘贴表';
          const src = blocks.length > 1 ? nm + ' ' + (k + 1) : nm;
          const colmap = Array.isArray(s.colmaps) && Array.isArray(s.colmaps[k]) && s.colmaps[k].length === p.headers.length
            ? s.colmaps[k] : p.headers.map(guess);            // 每段都可以单独修正列映射，不传就按表头猜
          normPaste(p.rows, p.headers, colmap).forEach(x => { x.src = src; ext.push(x); });
          cols.push({ src, kind: 'paste', rows: p.rows.length, headers: p.headers, colmap, delim: p.delim });
        }
      }
    }
    if (!ext.length) throw Object.assign(new Error('没解析出任何行：粘贴内容至少要有表头和一行数据'), { userFacing: true });
    return { ext, cols };
  }

  /* ---------- 跨源重复：两上游给了同一个单号时必须单独列，钱可能只到一次 ---------- */
  function crossDupOf(ext) {
    const byNo = new Map();
    ext.forEach(x => { if (x.no) { const a = byNo.get(x.no) || []; a.push(x); byNo.set(x.no, a); } });
    return [...byNo.entries()].filter(([, a]) => new Set(a.map(x => x.src)).size > 1)
      .map(([no, a]) => ({ no, sides: a.map(x => ({ src: x.src, amount: x.amount, paid: x.paid, status: x.status, odd: x.odd })) }));
  }

  app.post('/api/upstream/match', auth, adminOnly, async (req, res) => {
    try {
      const b = req.body || {};
      const { ext, cols } = await collectSources(b);
      const db = await getDb();
      const raw = await match(db, ext);
      const crossDup = crossDupOf(ext);
      const perSrc = cols.map(c => {
        const rows = ext.filter(x => x.src === c.src);
        return { src: c.src, kind: c.kind, rows: rows.length, headers: c.headers || null, colmap: c.colmap || null, delim: c.delim || null,
          amount: r2(rows.reduce((t, x) => t + x.amount, 0)), paid: r2(rows.reduce((t, x) => t + x.paid, 0)), noKey: rows.filter(x => !x.no).length };
      });
      res.json({
        ok: true, rows: ext.length, uniqueNo: new Set(ext.map(x => x.no).filter(Boolean)).size,
        sources: perSrc, crossDup, matched: raw.matched, span: raw.span || null,
        buckets: {
          missLedger: pick(raw.missLedger), missUp: pick(raw.missUp), noKey: pick(raw.noKey), odd: pick(raw.odd),
          multiNo: pick(raw.multiNo), amtBad: pick(raw.amtBad), amtNoise: pick(raw.amtNoise), shareBad: pick(raw.shareBad), stBad: pick(raw.stBad), dup: pick(raw.dup),
        },
      });
    } catch (e) { console.error('[upstream]', e); res.status(e.userFacing ? 400 : 500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  async function fetchJihe(account) {
    if (!/^\d{6,20}$/.test(String(account || ''))) throw Object.assign(new Error('结算账号要是 6-20 位数字'), { userFacing: true });
    const acc = new URLSearchParams(); acc.set('type', 'alipay'); acc.set('q', String(account));
    const key = 'ext:jihe:' + String(account);
    const hit = cacheGet(key);
    if (hit) return hit;
    let all = [], total = 0;
    for (let page = 0; page < 8; page++) {
      const u = EXTERNAL_BASE + '?type=alipay&q=' + encodeURIComponent(String(account)) + '&limit=50&offset=' + (page * 50);
      const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'order-tracker-readonly-recon' } });
      if (!r.ok) throw Object.assign(new Error('上游平台返回 ' + r.status), { userFacing: true });
      const j = await r.json();
      all = all.concat(j.orders || []); total = Number(j.total) || all.length;
      if (!j.hasMore || all.length >= total) break;
    }
    if (cacheSet) cacheSet(key, all);
    void acc;
    return all;
  }

  /* ---------- 结算账号存服务端 config：这是 PII，绝不写进代码，也绝不进公开仓库 ---------- */
  const ACC_KEY = 'upstr…count';
  const cleanAcc = s => String(s || '').replace(/[^\d]/g, '').slice(0, 20);

  app.get('/api/upstream/account', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const d = await db.collection('config').findOne({ key: ACC_KEY });
      const v = (d && d.value) || {};
      res.json({ ok: true, account: v.account || '', updatedAt: v.updatedAt || '' });
    } catch (e) { console.error('[upstream/account]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/upstream/account', auth, adminOnly, async (req, res) => {
    try {
      const account = cleanAcc((req.body || {}).account);
      if (!/^\d{6,20}$/.test(account)) return res.status(400).json({ ok: false, error: '结算账号要是 6-20 位数字' });
      const value = { account, updatedAt: new Date().toISOString() };
      const db = await getDb();
      await db.collection('config').updateOne({ key: ACC_KEY }, { $set: { value } }, { upsert: true });
      res.json({ ok: true, account });
    } catch (e) { console.error('[upstream/account]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  async function savedAccount() {
    try {
      const db = await getDb();
      const d = await db.collection('config').findOne({ key: ACC_KEY });
      return (d && d.value && d.value.account) || '';
    } catch (e) { return ''; }
  }

  app.get('/api/upstream/jihe', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const list = await fetchJihe(req.query.account || await savedAccount());
      const raw = await match(db, normJihe(list));
      res.json({ ok: true, source: 'jihe', rows: list.length, matched: raw.matched, totals: { extPaid: r2(list.reduce((t, x) => t + num(x.amount), 0)) }, buckets: Object.keys(raw).reduce((m, k) => (m[k] = Array.isArray(raw[k]) ? pick(raw[k]) : raw[k], m), {}) });
    } catch (e) { console.error('[upstream/jihe]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '拉取失败' }); }
  });
}
