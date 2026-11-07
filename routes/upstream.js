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
  // 【2026-11-07 修】他从 kdocs 复制有时带表头（224 行）有时不带（223 行）。
  // 原先无条件把第一行当表头 → 不带表头时整批列全认错，200 行掉进「上游没给单号」。
  // 现在先判第一行像不像表头，不像就改用"按内容认列"，并把判定结果回给前端说明。
  const HEADER_RX = /(订单号|单号|编号|金额|工资|状态|日期|收货|付款|派单|负责人|备注|渠道|群|创建|判断|是否|参考|预估|打款|实名|身份证|授权|查询|order|amount|date|status|note)/i;
  const looksLikeHeader = cells => {
    const hit = cells.filter(c => HEADER_RX.test(String(c))).length;
    const num = cells.filter(c => /^\d{6,}$/.test(String(c).trim())).length;
    return hit >= 2 && num === 0;
  };

  function parsePaste(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
      .map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
    if (lines.length < 2) return { error: '至少要表头 + 1 行数据（或没表头时至少 2 行数据）' };
    const delim = (lines[0].match(/\t/g) || []).length >= 1 ? '\t' : ',';
    const unq = s => { s = String(s || '').trim(); return s.length > 1 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1).replace(/""/g, '"') : s; };
    const first = splitLine(lines[0], delim).map(unq);
    const headerDetected = looksLikeHeader(first);
    const ncol = Math.max(...lines.map(l => splitLine(l, delim).length));
    const headers = headerDetected ? first : Array.from({ length: ncol }, (_, i) => '列' + (i + 1));
    if (headers.length < 2) return { error: '只识别出 ' + headers.length + ' 列，请用 Tab 或逗号分隔' };
    const rows = [];
    for (let i = headerDetected ? 1 : 0; i < lines.length; i++) {
      const cells = splitLine(lines[i], delim).map(unq);
      if (String(cells[0] || '').trim() === '合计' || /^\d+\s*单$/.test(String(cells[1] || '').trim())) continue;  // 他 CSV 末尾的合计行在第一列
      const o = {};
      headers.forEach((h, k) => { o[h] = cells[k] || ''; });
      rows.push(o);
    }
    if (!rows.length) return { error: '剔掉合计行后没数据了' };
    return { headers, rows, delim, headerDetected };
  }

  /* ---------- 没表头时按内容认列：每列取样本，看它长得像单号/钱/日期/状态/人名 ---------- */
  function guessByContent(rows, headers) {
    const col = i => rows.map(r => String(r[headers[i]] || '').trim()).filter(Boolean);
    const share = arr => { const n = arr.length; if (!n) return () => 0; return f => arr.filter(f).length / n; };
    const med = arr => { const a = arr.map(Number).filter(isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
    const n = headers.length;
    const info = [];
    for (let i = 0; i < n; i++) {
      const v = col(i), s = share(v);
      info.push({
        i, v,
        digits: s(x => /^\d{10,24}$/.test(x)),
        phone: s(x => /^1[3-9]\d{9}$/.test(x)),
        money: s(x => /^[¥￥]?\d+(\.\d{1,2})?$/.test(x)),
        hasYen: s(x => /^[¥￥]/.test(x)),
        date: s(x => /^\d{4}-\d{2}-\d{2}([ T]|$)/.test(x)),
        audit: s(x => /审核|已打款|结算|到账/.test(x)),
        trade: s(x => /交易|关闭|退款|收货/.test(x)),
        person: s(x => /负责人|派单|设计师/.test(x)),
        note: s(x => /技术服务|补[：:]|工资-/.test(x)),
        yesno: s(x => /^(正确|错误|是|否)$/.test(x)),
        median: med(v.map(x => x.replace(/[¥￥]/g, ''))),
      });
    }
    const map = new Array(n).fill('');
    // 占用记在 used 里：忽略列在 map 里是空串（falsy），后面 !map[i] 挡不住，会被当成"还没分配"再抢走
    const used = new Set();
    const take = (c, role) => { if (!c || used.has(c.i)) return; used.add(c.i); map[c.i] = role; };
    const best = (arr, key) => arr.slice().sort((a, b) => b[key] - a[key])[0];
    // 先占掉最独特的（人名/备注/收款资料/校验列），剩下的才轮到单号与钱，避免互相抢
    info.filter(c => c.person >= 0.5).forEach(c => take(c, 'person'));
    info.filter(c => c.note >= 0.5).forEach(c => take(c, 'note'));
    info.filter(c => c.phone >= 0.5).forEach(c => take(c, ''));                 // 收款资料：不进对账
    info.filter(c => c.yesno >= 0.6).forEach(c => take(c, ''));                 // 「正确/错误」那种校验列
    // 单号列和身份证列都是"整格长数字"，所以单号先抢：它排在前面，抢到后身份证自然落到忽略
    take(best(info.filter(c => !used.has(c.i) && c.audit >= 0.5), 'audit'), 'status');
    take(best(info.filter(c => !used.has(c.i) && c.trade >= 0.5), 'trade'), 'orderStatus');
    take(best(info.filter(c => !used.has(c.i) && c.digits >= 0.5), 'digits'), 'no');
    // 钱：带 ¥ 的那列是已发工资，另一列是订单金额；都不带符号就按中位数小的算工资
    const moneys = info.filter(c => !used.has(c.i) && c.money >= 0.5);
    take(best(moneys.filter(c => c.hasYen >= 0.3), 'hasYen')
      || (moneys.length >= 2 ? moneys.slice().sort((a, b) => a.median - b.median)[0] : null), 'paid');
    take(moneys.filter(c => !used.has(c.i)).sort((a, b) => b.median - a.median)[0], 'amount');
    // 日期：同一行里较早的是接单/付款，较晚的是收货/完单；剩下的（预估收货/预估打款）不参与判定
    const dates = info.filter(c => !used.has(c.i) && c.date >= 0.4);
    if (dates.length >= 2) {
      const [a, b] = dates;
      const both = rows.filter(r => String(r[headers[a.i]]) && String(r[headers[b.i]]));
      const aEarlier = both.filter(r => String(r[headers[a.i]]) < String(r[headers[b.i]])).length;
      const first = aEarlier >= both.length - aEarlier ? a : b, last = first === a ? b : a;
      take(first, 'takeDate'); take(last, 'doneDate');
      dates.filter(c => !used.has(c.i)).forEach(c => take(c, ''));
    } else if (dates.length === 1) take(dates[0], 'takeDate');
    info.filter(c => !used.has(c.i) && /群|客户/.test(c.v[0] || '')).forEach(c => take(c, 'group'));
    info.filter(c => !used.has(c.i) && /渠道|来源|平台/.test(c.v[0] || '')).forEach(c => take(c, 'team'));
    return map;
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

  /* ---------- 状态合成：审核完成已打款=已结算；其余（审核中/进行中/已收货没打款）=待结算 ----------
     他的口径（11-07）：上游表里出现这行＝已经提交了，没打款就是台账的「待结算」。
     原来「审核中+没收确认收货→进行中」把一大批正常单误报成状态不一致，已改。 */
  function toStatus(audit, trade, doneDate) {
    const s = String(audit || '') + ' ' + String(trade || '');
    if (/审核完成|已打款|已结算|结算完|已到账/.test(s)) return '已结算';
    if (/审核中|待结算|已交付|已收货|待打款/.test(s)) return '待结算';
    if (/进行中|制作/.test(s)) return '待结算';
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
        draft: g('draft').slice(0, 10), final: g('final').slice(0, 10),
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
      // 几何：未打款一律对台账「待结算」；制作阶段（进行中/终稿）不再是差异来源
      status: o.settled ? '已结算' : '待结算',
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
      // 【11-07 口径】只有「打款状态」不一致才报：上游已结算 vs 台账没结算、或反过来。
      // 上游还没打款（进行中/审核中/待结算）跟台账待开始/进行中/待结算之间只是制作阶段差，不算错。
      if (x.status && (x.status === '已结算') !== (ls === '已结算')) out.stBad.push({ ext: x, ledger: l, ledgerStatus: ls, extStatus: x.status });
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
    extGroup: x.ext ? x.ext.group : undefined, extPerson: x.ext ? x.ext.person : undefined,
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
            ? s.colmaps[k] : (p.headerDetected ? p.headers.map(guess) : guessByContent(p.rows, p.headers));
          normPaste(p.rows, p.headers, colmap).forEach(x => { x.src = src; ext.push(x); });
          // mapped 回给前端：没表头时他要能看见"我把第几列当成了什么"，不然又是一头雾水
          cols.push({
            src, kind: 'paste', rows: p.rows.length, headers: p.headers, colmap, delim: p.delim,
            headerDetected: p.headerDetected,
            mapped: colmap.map((r, i) => r ? r + '→第' + (i + 1) + '列' : '').filter(Boolean),
          });
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
          headerDetected: c.headerDetected !== false, mapped: c.mapped || null,
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

  // 【v26.88】从上游数据带出台账缺的新字段（渠道/群名/初稿/终稿）。
  // 仍然只读上游：这里只给「这一单还缺什么、上游有值」的候选，写不写由前端预览后决定。
  // 已有值的键不会进 fill —— 覆盖要走显式的 onlyEmpty:false，不能靠这条路偷偷改。
  app.post('/api/upstream/derive', auth, adminOnly, async (req, res) => {
    try {
      const { ext } = await collectSources(req.body || {});
      const nos = [...new Set(ext.filter(x => x.no).flatMap(x => x.nos || []))];
      const db = await getDb();
      const byNo = new Map();
      for (let i = 0; i < nos.length; i += 500) {
        const found = await db.collection(CONFIG.collection)
          .find({ orderNo: { $in: nos.slice(i, i + 500) } },
            { projection: { orderNo: 1, channel: 1, group: 1, draft: 1, final: 1 } }).limit(5000).toArray();
        found.forEach(o => { const k = String(o.orderNo || '').trim(); if (k && !byNo.has(k)) byNo.set(k, o); });
      }
      const DATE = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s).slice(0, 10) : '';
      const out = [];
      ext.forEach(x => {
        const l = x.no ? byNo.get(x.no) : null;
        if (!l) return;
        const channel = String(x.team || x.src || '').trim().slice(0, 40);
        const group = String(x.group || '').trim().slice(0, 40);
        const fill = {};
        if (!String(l.channel || '').trim() && channel) fill.channel = channel;
        if (!String(l.group || '').trim() && group) fill.group = group;
        if (!String(l.draft || '').trim() && DATE(x.draft)) fill.draft = DATE(x.draft);
        if (!String(l.final || '').trim() && DATE(x.final)) fill.final = DATE(x.final);
        if (!Object.keys(fill).length) return;
        out.push({ id: String(l._id), orderNo: x.no, src: x.src, fill });
      });
      res.json({
        ok: true, scannedNos: nos.length, matchedLedger: byNo.size,
        total: out.length, candidates: out.slice(0, 600), capped: out.length > 600,
      });
    } catch (e) { console.error('[upstream-derive]', e); res.status(e.userFacing ? 400 : 500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // 【v26.90】批次档案：他说"切换一下窗口就没了…哪怕粘贴表也需要留存档案"。
  // 存独立集合 recon_batches，绝不碰 orders；粘贴原文里有手机号，所以这份档案只存在他自己的库里（不进仓库、不进日志）。
  // 免费库只有 512MB，所以只留最近 60 批，超出自动淘汰最旧的。
  const BATCH_KEEP = 60;
  const batchCol = db => db.collection('recon_batches');

  app.post('/api/upstream/batch', auth, adminOnly, async (req, res) => {
    try {
      const b = req.body || {};
      const texts = Array.isArray(b.texts) ? b.texts.map(s => String(s || '')) : [];
      const bytes = texts.reduce((t, s) => t + s.length, 0);
      if (bytes > 900000) return res.status(400).json({ ok: false, error: '这批原文超过 90 万字符，先手动存成文件吧（库只有 512MB，别让它撑爆）' });
      const doc = {
        at: new Date(),
        name: String(b.name || '').trim().slice(0, 40) || '未命名批次',
        kind: b.kind === 'full' ? 'full' : 'recon',
        sources: (Array.isArray(b.sources) ? b.sources : []).slice(0, 20),
        stats: b.stats || null, counts: b.counts || null, span: b.span || null,
        rateMode: b.rateMode || null,
        texts,
      };
      const db = await getDb();
      const r = await batchCol(db).insertOne(doc);
      const all = await batchCol(db).find({}).sort({ at: -1 }).toArray();
      let removed = 0;
      for (const old of all.slice(BATCH_KEEP)) { await batchCol(db).deleteOne({ _id: old._id }); removed++; }
      res.json({ ok: true, id: String(r.insertedId), kept: Math.min(all.length, BATCH_KEEP), removed, bytes });
    } catch (e) { console.error('[upstream-batch]', e); res.status(500).json({ ok: false, error: '没存上：' + (e.message || e) }); }
  });

  app.get('/api/upstream/batches', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const rows = await batchCol(db).find({}).sort({ at: -1 }).limit(BATCH_KEEP).toArray();
      res.json({
        ok: true, keep: BATCH_KEEP,
        batches: rows.map(x => ({
          id: String(x._id), at: x.at, name: x.name, kind: x.kind,
          sources: x.sources || [], stats: x.stats || null, counts: x.counts || null, span: x.span || null,
          bytes: (x.texts || []).reduce((t, s) => t + String(s).length, 0),
        })),
      });
    } catch (e) { console.error('[upstream-batches]', e); res.status(500).json({ ok: false, error: '读不到档案' }); }
  });

  app.get('/api/upstream/batch', auth, adminOnly, async (req, res) => {
    try {
      const id = String(req.query.id || '');
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: '批次 ID 不对' });
      const db = await getDb();
      const x = await batchCol(db).findOne({ _id: new ObjectId(id) });
      if (!x) return res.status(404).json({ ok: false, error: '这批档案不在了（可能已被自动淘汰）' });
      res.json({ ok: true, batch: { id: String(x._id), at: x.at, name: x.name, kind: x.kind, sources: x.sources || [], stats: x.stats || null, counts: x.counts || null, span: x.span || null, rateMode: x.rateMode || null, texts: x.texts || [] } });
    } catch (e) { console.error('[upstream-batch-get]', e); res.status(500).json({ ok: false, error: '读不到这批档案' }); }
  });

  app.delete('/api/upstream/batch', auth, adminOnly, async (req, res) => {
    try {
      const id = String((req.body || {}).id || '');
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: '批次 ID 不对' });
      const db = await getDb();
      const r = await batchCol(db).deleteOne({ _id: new ObjectId(id) });
      res.json({ ok: true, deleted: r.deletedCount });
    } catch (e) { console.error('[upstream-batch-del]', e); res.status(500).json({ ok: false, error: '没删掉' }); }
  });

  // 【v26.89】完整单子：台账【全量】（内部翻页，不吃列表接口那个 500 上限）× 这批上游 → 一行一单，两侧并排。
  // 他要的是"先把老单子全部整理"，所以这里不是差异清单，是总账：每单都给「缺什么 / 上游有没有 / 建议补什么」。
  // 比例不让他再填一遍：他说"粘贴这些数据都是 45%"，那就从这批的 工资÷订单金额 里取众数读出来。
  // 红线不变：这里只读；写由前端预览后走 /api/orders/jobfields 与 /api/orders/writer-patch，shareRate 不开口。
  app.post('/api/upstream/full', auth, adminOnly, async (req, res) => {
    try {
      const b = req.body || {};
      const { ext, cols } = await collectSources(b);
      const db = await getDb();
      const all = [];
      const PAGES = 20, PAGE = 500;              // 最多 1 万单；现在他 300 多单，一页就够
      for (let i = 0; i < PAGES; i++) {
        const rs = await db.collection(CONFIG.collection).find({}).sort({ date: -1, _id: -1 }).skip(i * PAGE).limit(PAGE).toArray();
        all.push(...rs);
        if (rs.length < PAGE) break;
      }
      const byNo = new Map();
      ext.forEach(x => (x.nos || []).forEach(n => { const a = byNo.get(n) || []; a.push(x); byNo.set(n, a); }));

      const rateMode = {};
      cols.filter(c => c.kind === 'paste').forEach(c => {
        const rr = ext.filter(x => x.src === c.src && x.paid > 0 && x.amount > 0);
        const m = {};
        rr.forEach(x => { const r = Math.round(x.paid / x.amount * 1000) / 10; m[r] = (m[r] || 0) + 1; });
        const best = Object.entries(m).sort((a, z) => z[1] - a[1])[0];
        if (best && Number(best[0]) > 0 && Number(best[0]) < 100) rateMode[c.src] = { rate: Number(best[0]), n: best[1], of: rr.length };
      });

      const isD = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
      const dadd = (ds, n) => { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
      // 上游那列写的是「A订单负责人-钦钦」，台账 writer 里存的是「钦钦」——不剥前缀两边永远对不上
      const person = s => String(s || '').replace(/^(A?订单负责人|负责人|派单员|设计师|A)[-·:：\s]*/, '').trim().slice(0, 30);
      const DD = Number(b.dueDraft) > 0 ? Number(b.dueDraft) : 2;
      const DF = Number(b.dueFinal) > 0 ? Number(b.dueFinal) : 4;

      const rows = [];
      const stats = { total: all.length, withUp: 0, noUp: 0, noKey: 0, crossDup: 0, personBad: 0, rateBad: 0, statusBad: 0, amtBad: 0 };
      const missCnt = { channel: 0, group: 0, draft: 0, final: 0, writer: 0 };
      const ledgerNos = new Set(all.map(o => String(o.orderNo || '').trim()).filter(Boolean));
      all.forEach(o => {
        const no = String(o.orderNo || '').trim();
        const ups = no ? (byNo.get(no) || []) : [];
        const u = ups[0] || null;
        const srcs = [...new Set(ups.map(x => x.src))];
        if (!no) stats.noKey++;
        if (u) stats.withUp++; else stats.noUp++;
        if (srcs.length > 1) stats.crossDup++;
        const rate = num(o.shareRate), share = r2(num(o.amount) * rate / 100);
        const miss = [];
        ['channel', 'group', 'draft', 'final'].forEach(k => { if (!String(o[k] || '').trim()) { miss.push(k); missCnt[k]++; } });
        if (!String(o.writer || '').trim()) missCnt.writer++;
        const upRate = u && rateMode[u.src] ? rateMode[u.src].rate : null;
        const flags = [];
        if (u) {
          const upPerson = person(u.person);
          if (String(o.writer || '').trim() && upPerson && o.writer !== upPerson && !String(o.writer || '').includes(upPerson)) flags.push('personBad'), stats.personBad++;
          if (upRate !== null && Math.abs(rate - upRate) > 0.5) flags.push('rateBad'), stats.rateBad++;
          // 同上：只报打款状态不一致（上游已结算 vs 台账没结算，或反过来）
          if (u.status && (u.status === '已结算') !== (normalizeStatus(o.status) === '已结算')) flags.push('statusBad'), stats.statusBad++;
          if (u.amount > 0 && Math.abs(u.amount - num(o.amount)) > 1) flags.push('amtBad'), stats.amtBad++;
        }
        const suggest = {};
        if (!String(o.channel || '').trim() && (u ? u.src : '')) suggest.channel = u.src;
        if (!String(o.group || '').trim() && u && u.group) suggest.group = String(u.group).slice(0, 40);
        if (!String(o.writer || '').trim() && u && person(u.person)) suggest.writer = person(u.person);
        if (!isD(o.draft) && isD(o.date)) suggest.draft = dadd(String(o.date).slice(0, 10), DD);
        if (!isD(o.final) && isD(o.date)) suggest.final = dadd(String(o.date).slice(0, 10), DF);
        rows.push({
          id: String(o._id), no, date: String(o.date || '').slice(0, 10), amount: num(o.amount), rate, share,
          status: normalizeStatus(o.status), doneDate: String(o.doneDate || '').slice(0, 10),
          writer: String(o.writer || ''), note: String(o.note || '').slice(0, 60),
          channel: String(o.channel || ''), group: String(o.group || ''), draft: String(o.draft || ''), final: String(o.final || ''),
          miss, flags, suggest, srcs,
          up: u ? { src: u.src, amount: u.amount, paid: u.paid, status: u.status, person: String(u.person || ''), group: String(u.group || ''), upRate } : null,
          upN: ups.length,
        });
      });
      // 迁移要用的是"谁有谁没有"，不是差异计数：他说"那些是台账有但结算粘贴或几何没的，
      // 那些是几何或粘贴表有的但台账没录的，都要说清楚"。
      // 关键口径：上游表只覆盖它那段时间，跨月老单不能算成"上游没有"——所以 ledOnly 只在这批覆盖的日期区间内判，
      // 区间外的老实标成 outSpan，不混进来吓人。
      const days = ext.map(x => String(x.takeDate || x.doneDate || '')).filter(isD).sort();
      const span = days.length ? { from: days[0], to: days[days.length - 1] } : null;
      const ledOnly = [], outSpan = [];
      rows.forEach(r => {
        if (r.up) return;
        if (!span) { ledOnly.push(r); return; }
        if (isD(r.date) && r.date >= span.from && r.date <= span.to) ledOnly.push(r);
        else outSpan.push({ id: r.id, no: r.no, date: r.date, amount: r.amount, status: r.status });
      });
      const upOnly = ext.filter(x => !(x.nos || []).some(n => ledgerNos.has(n))).map(x => ({
        no: x.no, raw: x.raw, src: x.src, amount: x.amount, paid: x.paid, status: x.status,
        person: String(x.person || ''), group: String(x.group || ''), takeDate: x.takeDate, odd: x.odd || '',
      }));
      // 他台账里那几行「微信：LM003415」是手工号：纯数字匹配永远碰不到，单独一档，别让它冒充"上游没这单"
      const manualNo = rows.filter(r => r.no && !/^\d{6,24}$/.test(r.no)).map(r => ({ id: r.id, no: r.no, date: r.date, amount: r.amount, status: r.status, note: r.note }));
      // 金额录成 0、真实数字写在备注里（他样例里的 1000 / 50 / 840）：只列出来，金额是红线，不批量改
      const noteAmt = rows.filter(r => r.amount === 0 && /(^|[^\d])\d{2,9}([^\d]|$)/.test(r.note)).map(r => ({
        id: r.id, no: r.no, date: r.date, status: r.status, note: r.note,
        inNote: (r.note.match(/\d{2,9}/) || [''])[0],
      }));
      const migrate = {
        span,
        ledOnly: ledOnly.slice(0, 400), ledOnlyN: ledOnly.length,
        upOnly: upOnly.slice(0, 400), upOnlyN: upOnly.length,
        outSpan: outSpan.slice(0, 200), outSpanN: outSpan.length,
        manualNo: manualNo.slice(0, 200), manualNoN: manualNo.length,
        noteAmt: noteAmt.slice(0, 200), noteAmtN: noteAmt.length,
        bothBad: rows.filter(r => r.flags.length).length,
      };
      res.json({
        ok: true, scanned: all.length, truncated: all.length >= PAGES * PAGE,
        sources: cols.map(c => ({ src: c.src, kind: c.kind, rows: c.rows })),
        rateMode, missCnt, stats, rows, migrate,
      });
    } catch (e) { console.error('[upstream-full]', e); res.status(e.userFacing ? 400 : 500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
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
