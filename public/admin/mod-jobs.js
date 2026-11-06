// admin/mod-jobs.js — 「做单中心」原型 v1：核心是**每单做到哪了、还剩多久**，录单收起来
//
// 他 2026-11-06 的原话定调：「我要的做单中心，是录单只是折叠，我是需要清晰的提醒我每个工作做到哪里了，
// 还剩多久，这个才是我核心需求，不然我也没必要去拆分。」
// 所以这一屏的主体是进度卡 + 到期倒计时，录入/上游设置/对账全部折叠成次要入口。
//
// 三条不变的红线：
//   1. 原型不落库：只存这台浏览器 localStorage，不写 orders 表，历史数据一律不动。
//   2. 上游平台只读：不登记、不改状态、不代申请结算。
//   3. 初稿/终稿 = 交期提醒（应交时间），不驱动状态；状态是他单独点的那一下。
import { api, esc, toast } from './app.js';

const LS_JOBS = 'jobs_v0';
const LS_UP = 'jobs_upstream_v0';
const ST = ['待开始', '进行中', '待结算', '已结算'];
const ST_COLOR = { '待开始': '#94a3b8', '进行中': '#2563eb', '待结算': '#d97706', '已结算': '#16a34a' };
const CLOSED = new Set(['待结算', '已结算']);   // 交了货的，不再占"还剩多久"的位置

const CSS = `
.wrap{max-width:1180px;margin:0 auto;padding:16px 22px 70px;font:14px/1.7 -apple-system,"Microsoft YaHei",sans-serif;color:#1e293b}
h1{font-size:20px;margin:0 0 2px}
.sub{font-size:12px;color:#64748b}
.banner{background:#fff7ed;border:1px solid #fdba74;border-radius:11px;padding:8px 12px;font-size:12px;color:#9a3412;margin:8px 0 14px}
/* 顶部到期汇总：大数字，点一下就筛 */
.sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:9px;margin-bottom:14px}
.sc{border:1px solid #e2e8f0;background:#fff;border-radius:12px;padding:10px 12px;text-align:left;cursor:pointer;font:inherit;color:#1e293b}
.sc b{display:block;font-size:26px;line-height:1.15;font-variant-numeric:tabular-nums}
.sc span{display:block;font-size:11.5px;color:#64748b}
.sc.late b{color:#dc2626}.sc.soon b{color:#d97706}.sc.doing b{color:#2563eb}.cash b{color:#0f766e}.sc.done b{color:#16a34a}
.sc:hover{border-color:#94a3b8}
.sc.on{border-color:#1e293b;box-shadow:inset 0 0 0 1px #1e293b;background:#f8fafc}
/* 进度卡 */
.jc{display:grid;grid-template-columns:1fr auto;gap:12px;border:1px solid #e2e8f0;border-left:5px solid #cbd5e1;border-radius:12px;background:#fff;padding:11px 14px;margin-bottom:9px}
.jc.late{border-left-color:#dc2626;background:#fff8f8}
.jc.soon{border-left-color:#f59e0b}
.jc.doing{border-left-color:#2563eb}
.jc.none{border-left-color:#cbd5e1}
.jc.done{border-left-color:#16a34a;background:#fbfefc}
.jc.closed-soft{opacity:.72}
.no{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.who{font-size:12px;color:#64748b;margin-top:1px}
.note{font-size:12px;color:#475569;margin-top:4px}
.right{text-align:right;min-width:170px}
.cd{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.2}
.cd.late{color:#dc2626}.cd.soon{color:#d97706}.cd.ok{color:#334155}.cd.none{color:#94a3b8;font-size:15px;font-weight:600}
.cd2{font-size:11.5px;color:#64748b;font-variant-numeric:tabular-nums}
.cd2.bad{color:#dc2626;font-weight:600}
.money{font-size:12px;color:#334155;margin-top:3px;font-variant-numeric:tabular-nums}
.money b{font-size:14px}
/* 四段步骤条 */
.steps{display:flex;gap:5px;margin-top:8px;flex-wrap:wrap}
.step{border:1px solid #e2e8f0;background:#f8fafc;border-radius:99px;padding:4px 12px;font:inherit;font-size:12px;cursor:pointer;color:#94a3b8}
.step:hover{border-color:#2563eb;color:#2563eb}
.step.hit{background:#1e293b;border-color:#1e293b;color:#fff;font-weight:600}
.step.next{border-style:dashed;border-color:#2563eb;color:#2563eb}
.step.dn{background:#dcfce7;border-color:#16a34a;color:#166534}
.jdel{border:0;background:transparent;color:#cbd5e1;cursor:pointer;font-size:15px;padding:0 2px}
.jdel:hover{color:#dc2626}
.row2{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-top:6px}
input,select{border:1px solid #cbd5e1;border-radius:8px;padding:7px 9px;font:inherit;background:#fff;color:#1e293b}
input:focus,select:focus{outline:2px solid #bfdbfe;border-color:#2563eb}
.btn{border:1px solid #cbd5e1;background:#fff;border-radius:9px;padding:7px 13px;font:inherit;cursor:pointer;white-space:nowrap;color:#1e293b}
.btn:hover{border-color:#2563eb;color:#2563eb}
.btn.p{background:#2563eb;border-color:#2563eb;color:#fff}
.btn.g{background:#f1f5f9}
.btn.sm{padding:4px 10px;font-size:12px}
/* 折叠：录单/上游/对账都收在这里，默认关闭 */
details.fold{background:#fff;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:11px;padding:0 14px}
details.fold > summary{list-style:none;cursor:pointer;padding:11px 0;font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:8px}
details.fold > summary::-webkit-details-marker{display:none}
details.fold > summary::before{content:"▸";color:#94a3b8;font-size:12px}
details.fold[open] > summary::before{content:"▾"}
details.fold > summary .sub{font-weight:400}
.fbody{border-top:1px solid #f1f5f9;padding:12px 0 14px}
.form{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:9px;align-items:end}
.f label{display:block;font-size:11.5px;color:#64748b;margin-bottom:3px}
.f input,.f select{width:100%}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#64748b;font-weight:500;font-size:12px;padding:6px 8px;border-bottom:1px solid #e2e8f0;white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid #f1f5f9}
.num{text-align:right;font-variant-numeric:tabular-nums}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 12px}
.chip{border:1px solid #e2e8f0;background:#fff;border-radius:99px;padding:3px 12px;font-size:12px;cursor:pointer;color:#1e293b}
.chip.on{background:#1e293b;color:#fff;border-color:#1e293b}
.empty{color:#94a3b8;font-size:13px;padding:26px 0;text-align:center;border:1px dashed #e2e8f0;border-radius:12px;background:#fff}
.tag{border-radius:6px;padding:1px 7px;font-size:11.5px;background:#eef2ff;color:#4338ca;display:inline-block;margin:0 6px 4px 0}
`;

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const dstr = off => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
const daysLeft = s => isDate(s) ? Math.round((new Date(s + 'T23:59:59') - Date.now()) / 86400000) : null;
const cdText = n => n === null ? '没填交期' : n < 0 ? `逾期 ${-n} 天` : n === 0 ? '今天到期' : n === 1 ? '明天到期' : `还剩 ${n} 天`;

// 一单的紧急度与排序权重：逾期最久 → 今天/明天 → 余下天数 → 没填交期 → 已交的沉底
function heat(j) {
  if (CLOSED.has(j.status)) return { cls: 'done', score: 1e9 + (j.status === '已结算' ? 1 : 0) };
  const d = daysLeft(j.finalDue);
  if (d === null) return { cls: 'none', score: 1e8 };
  if (d < 0) return { cls: 'late', score: d };
  if (d <= 1) return { cls: 'soon', score: 1000 + d };   // soon 必须排在 doing(1e6) 前面，否则"今天到期"会掉到"还剩3天"后面
  return { cls: 'doing', score: 1e6 + d };
}

export function mount(host) {
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = `<style>${CSS}</style><div class="wrap" id="app"></div>`;
  const $ = s => sh.querySelector(s);
  const $$ = s => [...sh.querySelectorAll(s)];
  const money = n => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const LS = {
    read: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } },
    write: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('这台浏览器存不下（可能隐私模式）'); } },
  };
  let UP = LS.read(LS_UP, []);
  let JOBS = LS.read(LS_JOBS, []);
  let VIEW = 'doing';                       // doing=在做的 / all=全部 / late=只看逾期
  let Q = '', TEAM = '';
  let RECON = null;
  let LEDGER = [];                       // 数据中心真实单（只读进来，不回写）
  let LEDGER_TRUC = false;
  const LS_PATCH = 'jobs_backfill_v0';
  let PATCH = LS.read(LS_PATCH, {});     // 老单补录的本地补丁
  let BFONLY = true;
  let COLMAPS = [];

  const inList = j => {
    const h = heat(j);
    const dFinal = daysLeft(j.finalDue), dDraft = daysLeft(j.draftDue);
    if (VIEW === 'all') { /* 全部含已闭环 */ }
    else if (VIEW === 'pay') { if (j.status !== '待结算') return false; }
    else if (VIEW === 'late') { if (CLOSED.has(j.status) || h.cls !== 'late') return false; }
    else if (VIEW === 'soon') { if (CLOSED.has(j.status) || h.cls !== 'soon') return false; }
    else if (VIEW === 'draft') { if (CLOSED.has(j.status) || dDraft === null || dDraft >= 0) return false; }
    else if (CLOSED.has(j.status)) return false;   // 默认 doing：只看还没交付的
    if (TEAM && j.team !== TEAM) return false;
    const q = Q.trim().toLowerCase();
    if (q && ![j.no, j.group, j.person, j.note, j.team].some(x => String(x || '').toLowerCase().includes(q))) return false;
    return true;
  };
  const listed = () => JOBS.filter(inList).sort((a, b) => heat(a).score - heat(b).score);

  /* ============ 骨架 ============ */
  function skeleton() {
    $('#app').innerHTML = `
      <h1>🛠 做单中心 <span class="sub">原型 v1 · 做到哪了 + 还剩多久</span></h1>
      <div class="banner"><b>原型：数据只存这台浏览器，一行都没进你的台账。</b>确认样子后第二期才接真库，接库也只「新增」，历史单不动。</div>
      <div class="sum" id="sum"></div>
      <div class="chips" id="views"></div>
      <div class="chips" style="margin-top:-6px">
        <select id="fTeam" style="max-width:180px"></select>
        <input id="fQ" style="width:230px" placeholder="搜单号 / 群名 / 派单员 / 备注">
        <span class="sub" id="cnt"></span>
      </div>
      <details class="fold" id="foldNew"><summary>＋ 记一单<span class="sub">（录单只是入口，放顶部收着，要记就点开）</span></summary>
        <div class="fbody"><div class="form">
          <div class="f"><label>上游团队 *</label><select id="nTeam"></select></div>
          <div class="f"><label>群名称</label><input id="nGroup" placeholder="客户群名 / 群ID"></div>
          <div class="f"><label>接单金额（元）*</label><input id="nAmount" type="number" min="0" step="1" placeholder="例：300"></div>
          <div class="f"><label>抽成比例 %</label><input id="nRate" type="number" min="1" max="100" step="0.5" placeholder="选上游自动带"></div>
          <div class="f"><label>派单员</label><input id="nPerson" placeholder="自动带，可改"></div>
          <div class="f"><label>单号（可空，填了才能与平台对上）</label><input id="nNo" placeholder="平台订单号 / 群里给的号"></div>
          <div class="f"><label>初稿应交</label><input id="nDraft" type="date" value="${dstr(2)}"></div>
          <div class="f"><label>终稿应交</label><input id="nFinal" type="date" value="${dstr(4)}"></div>
          <div class="f"><label>起始状态</label><select id="nStatus">${ST.map(s => `<option${s === '待开始' ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
          <div class="f" style="grid-column:1/-1"><label>备注</label><input id="nNote" placeholder="内容要求、客户要求、群里原话…"></div>
          <button class="btn p" id="nAdd">＋ 存这一单</button>
          <button class="btn g" id="expBtn">⬇ 导出 / 导入</button>
          <span class="sub">「同步到数据中心」第二期再开：那时是往台账<b>新增</b>一条。</span>
        </div></div>
      </details>

      <div id="list"></div>

      <details class="fold" id="foldBackfill"><summary>🧾 老单补录<span class="sub">数据中心历史单缺的新字段，在这里一单一单补齐</span></summary>
        <div class="fbody"><div id="bfBox"><div class="sub">展开后从数据中心读真实单（当前是假库）…</div></div></div>
      </details>

      <details class="fold"><summary>⚙️ 上游设置<span class="sub">上游团队 / 派单员 / 分成比例，配一次长期用</span></summary>
        <div class="fbody"><div id="upBox"></div><hr style="border:0;border-top:1px solid #f1f5f9;margin:12px 0">
          <div class="form">
            <div class="f"><label>上游团队 *</label><input id="upTeam" placeholder="例：几何团队"></div>
            <div class="f"><label>派单员</label><input id="upPerson" placeholder="给这单派活的人"></div>
            <div class="f"><label>分成比例 %</label><input id="upRate" type="number" min="1" max="100" step="0.5" value="45"></div>
            <div class="f"><label>备注</label><input id="upNote"></div>
            <button class="btn p" id="upAdd">＋ 添加</button>
          </div></div>
      </details>

<details class="fold"><summary>🔎 上游对账（只读）<span class="sub">几何视传拉取 + 粘贴表格合并比对，只列有问题的行</span></summary>
        <div class="fbody">
          <div class="row2">
            <label class="ck"><input type="checkbox" id="rJihe" checked>几何视传（接口拉取）</label>
            <label class="ck"><input type="checkbox" id="rPaste">粘贴的表格（金山这类没接口）</label>
            <span class="grow"></span>
            <button class="btn p" id="rGo">开始对账</button>
            <button class="btn g" id="rCsv" disabled>导出差异 CSV</button>
            <span class="sub" id="rBusy"></span>
          </div>
          <div class="form" style="margin-top:8px">
            <div class="f"><label>几何结算账号（只存服务端配置，不进代码不进仓库）</label><input id="rAcc" placeholder="11 位手机号" inputmode="numeric"></div>
            <button class="btn g" id="rAccSave">存住</button><span class="sub" id="rAccSaved"></span>
          </div>
          <div id="rPasteBox" hidden style="margin-top:8px">
            <div class="form"><div class="f"><label>这批表格叫什么（例：金山-再飞）</label><input id="rName" placeholder="留空自动叫 粘贴表"></div></div>
            <textarea id="rText" rows="4" placeholder="把上游表格整块 Ctrl+C 粘这里；两张表之间空一行，各自表头可以不同"></textarea>
          </div>
          <div class="sub" style="margin-top:8px">红线：全程只读——不改你台账、不改上游平台、不代你申请结算。判定规则只有一份，在服务端，跟台账 500 条上限无关。</div>
          <div id="rSrc" class="sub" style="margin-top:6px"></div>
          <div class="sub" style="margin:6px 0"><button class="btn sm g" id="rReCalc" hidden>按修正后的列映射重算</button></div>
          <div id="rCols"></div>
          <div id="rOut" style="margin-top:8px"></div>
        </div>
      </details>`;
    paintSum(); paintViews(); paintTeamFilter(); paintList(); paintUpstream(); paintNewTeam();
    bind();
  }

  /* ============ 顶部到期汇总（点=筛） ============ */
  function paintSum() {
    const open = JOBS.filter(j => !CLOSED.has(j.status));
    const late = open.filter(j => heat(j).cls === 'late');
    const soon = open.filter(j => heat(j).cls === 'soon');
    const d3 = open.filter(j => { const n = daysLeft(j.finalDue); return n !== null && n >= 2 && n <= 3; });
    const draftBad = open.filter(j => { const n = daysLeft(j.draftDue); return n !== null && n < 0; });
    const waitPay = JOBS.filter(j => j.status === '待结算');
    const cell = (cls, n, label, view) => `<button class="sc ${cls}${VIEW === view ? ' on' : ''}" data-view="${view}"><b>${n}</b><span>${label}</span></button>`;
    $('#sum').innerHTML =
      cell('late', late.length, '终稿已逾期', 'late') +
      cell('soon', soon.length, '今天/明天到期', 'soon') +
      cell('doing', open.length, '在做（未交付）', 'doing') +
      `<button class="sc cash${VIEW === 'pay' ? ' on' : ''}" data-view="pay"><b>${money(waitPay.reduce((t, j) => t + Number(j.amount || 0) * Number(j.rate || 0) / 100, 0))}</b><span>待结算应得（${waitPay.length} 单）</span></button>` +
      cell('', draftBad.length, '初稿早过还没交', 'draft');
    $$('#sum [data-view]').forEach(b => b.onclick = () => {
      VIEW = VIEW === b.dataset.view ? 'doing' : b.dataset.view;   // 再点一次=取消
      paintSum(); paintViews(); paintList();
    });
  }

  function paintViews() {
    const named = { doing: '在做（未交付）', late: '终稿逾期', soon: '今天/明天到期', pay: '待结算', draft: '初稿过期未交' };
    $('#views').innerHTML = `<button class="chip${VIEW === 'all' ? ' on' : ''}" data-v="all">全部（含已闭环）</button>`
      + `<button class="chip${VIEW === 'doing' ? ' on' : ''}" data-v="doing">在做的</button>`
      + `<span class="sub">当前视图：<b style="color:#1e293b">${VIEW === 'all' ? '全部（含已闭环）' : named[VIEW]}</b>　·　卡片上那四个圈就是状态，点一下即推进/回退；上面五个数字点一下就是筛。</span>`;
    $$('#views [data-v]').forEach(b => b.onclick = () => { VIEW = b.dataset.v; paintSum(); paintViews(); paintList(); });
  }

  function paintTeamFilter() {
    const teams = [...new Set(UP.map(u => u.team).concat(JOBS.map(j => j.team)).filter(Boolean))];
    $('#fTeam').innerHTML = '<option value="">全部上游</option>' + teams.map(t => `<option value="${esc(t)}"${TEAM === t ? ' selected' : ''}>${esc(t)}</option>`).join('');
  }

  /* ============ 进度卡列表 ============ */
  function paintList() {
    const rows = listed();
    $('#cnt').textContent = `共 ${JOBS.length} 单，这里 ${rows.length} 单（按紧急度排：逾期最久的在最上面）`;
    if (!rows.length) {
      $('#list').innerHTML = `<div class="empty">${JOBS.length ? '这个视图/筛选下没有单。上面切「全部（含已交）」看看。' : '还没有单。点「＋ 记一单」录第一笔（先在上游设置里加一行上游）。'}</div>`;
      return;
    }
    $('#list').innerHTML = rows.map(j => card(j)).join('');
    $$('#list [data-st-to]').forEach(b => b.onclick = () => {
      const j = JOBS.find(x => String(x.id) === b.dataset.id); if (!j) return;
      j.status = b.dataset.stTo; j.statusSetAt = new Date().toISOString();
      LS.write(LS_JOBS, JOBS); paintSum(); paintList();
      toast((j.no || j.group || '这单') + ' → ' + j.status + '（本地原型，台账没动）');
    });
    $$('#list [data-jdel]').forEach(b => b.onclick = () => {
      if (!confirm('删掉这笔做单？只删本地原型数据，台账没动过。')) return;
      JOBS = JOBS.filter(j => String(j.id) !== b.dataset.jdel);
      LS.write(LS_JOBS, JOBS); paintSum(); paintList(); paintTeamFilter();
    });
  }

  function card(j) {
    const h = heat(j);
    const dFinal = daysLeft(j.finalDue), dDraft = daysLeft(j.draftDue);
    const cdCls = CLOSED.has(j.status) ? 'ok' : h.cls === 'none' ? 'none' : h.cls;
    const closedSoft = j.status === '已结算' ? ' closed-soft' : '';
    const steps = ST.map(s => {
      const hit = s === j.status, next = !hit && ST.indexOf(s) === ST.indexOf(j.status) + 1;
      const cls = hit ? (j.status === '已结算' ? 'step dn hit' : 'step hit') : next ? 'step next' : 'step';
      return `<button class="${cls}" data-id="${esc(j.id)}" data-st-to="${esc(s)}" title="把状态改成「${s}」">${s}</button>`;
    }).join('');
    return `<div class="jc ${h.cls}${closedSoft}">
      <div>
        <div class="no">${esc(j.no || '（没填单号）')}<span class="sub">　${esc(j.team || '')}</span></div>
        <div class="who">👥 ${esc(j.group || '没填群名')}　·　派单员 ${esc(j.person || '未记')}${j.note ? '　·　📝 ' + esc(j.note) : ''}</div>
        <div class="steps">${steps}</div>
      </div>
      <div class="right">
        <div class="cd ${cdCls}">${CLOSED.has(j.status) ? (j.status === '已结算' ? '已闭环' : '已交付·等钱') : cdText(dFinal)}</div>
        <div class="cd2 ${dDraft !== null && dDraft < 0 && !CLOSED.has(j.status) ? 'bad' : ''}">终稿 ${isDate(j.finalDue) ? j.finalDue : '未填'}　初稿 ${isDate(j.draftDue) ? j.draftDue : '未填'}${dDraft !== null && dDraft < 0 && !CLOSED.has(j.status) ? '（初稿已过期）' : ''}</div>
        <div class="money">接单 <b>${money(j.amount)}</b> 元 × ${Number(j.rate) || 0}% = 应得 <b>${money((Number(j.amount) || 0) * (Number(j.rate) || 0) / 100)}</b></div>
        <button class="jdel" data-jdel="${esc(j.id)}" title="删这单（只删本地原型）">✕</button>
      </div></div>`;
  }

  /* ============ 上游设置 ============ */
  function paintUpstream() {
    $('#upBox').innerHTML = `<table><thead><tr><th>上游团队</th><th>派单员</th><th class="num">分成比例</th><th>备注</th><th style="width:52px">删</th></tr></thead>
      <tbody>${UP.length ? UP.map(u => `<tr>
        <td><input data-up="team" data-id="${esc(u.id)}" value="${esc(u.team)}"></td>
        <td><input data-up="person" data-id="${esc(u.id)}" value="${esc(u.person || '')}" placeholder="可留空"></td>
        <td class="num"><input data-up="rate" data-id="${esc(u.id)}" type="number" min="1" max="100" step="0.5" value="${Number(u.rate) || 45}" style="width:80px;text-align:right"></td>
        <td><input data-up="note" data-id="${esc(u.id)}" value="${esc(u.note || '')}"></td>
        <td><button class="btn sm g" data-updel="${esc(u.id)}">✕</button></td></tr>`).join('')
        : '<tr><td colspan="5" class="sub" style="padding:14px">还没配上游。下面加一行，例：几何团队 / 张三 / 45。</td></tr>'}</tbody></table>`;
    $$('#upBox [data-up]').forEach(i => i.onchange = () => {
      const u = UP.find(x => x.id === i.dataset.id); if (!u) return;
      const k = i.dataset.up;
      u[k] = k === 'rate' ? (Number(i.value) || 0) : i.value.trim();
      LS.write(LS_UP, UP); paintNewTeam(); paintTeamFilter();
    });
    $$('#upBox [data-updel]').forEach(b => b.onclick = () => {
      if (!confirm('删掉这行上游？已建的单不受影响。')) return;
      UP = UP.filter(u => u.id !== b.dataset.updel); LS.write(LS_UP, UP); paintUpstream(); paintNewTeam(); paintTeamFilter();
    });
  }
  function paintNewTeam() {
    $('#nTeam').innerHTML = '<option value="">（先在上游设置里加）</option>' + UP.map(u => `<option value="${esc(u.team)}">${esc(u.team)}${u.person ? ' · ' + esc(u.person) : ''} · ${Number(u.rate) || 45}%</option>`).join('');
  }

  /* ============ 建单 / 导出 ============ */
  function addJob() {
    const team = $('#nTeam').value;
    if (!team) { $('#foldNew').open = true; return toast('先选上游团队（没有就展开「上游设置」加一行）'); }
    const amount = Number($('#nAmount').value);
    if (!(amount > 0)) return toast('接单金额要大于 0');
    JOBS.push({
      id: 'j' + Date.now(), team, person: $('#nPerson').value.trim(), group: $('#nGroup').value.trim(),
      amount, rate: Number($('#nRate').value) || 45, note: $('#nNote').value.trim(), no: $('#nNo').value.trim(),
      draftDue: isDate($('#nDraft').value) ? $('#nDraft').value : null,
      finalDue: isDate($('#nFinal').value) ? $('#nFinal').value : null,
      status: $('#nStatus').value, createdAt: new Date().toISOString(),
    });
    LS.write(LS_JOBS, JOBS);
    ['#nNo', '#nGroup', '#nAmount', '#nNote'].forEach(s => $(s).value = '');
    paintSum(); paintList(); paintTeamFilter();
    toast('存好了（只在本地，没进台账）');
  }
  function exportImport() {
    const data = JSON.stringify({ _note: '做单中心原型数据（本地）', upstream: UP, jobs: JOBS }, null, 1);
    const ta = prompt('导出：全选复制存成 .json。导入：把之前导出的内容粘进来再点确定。', data);
    if (ta === null) return;
    const t = ta.trim();
    if (!t || t === data.trim()) return;
    try {
      const j = JSON.parse(t);
      if (!Array.isArray(j.jobs) || !Array.isArray(j.upstream)) throw new Error('缺 jobs / upstream 数组');
      JOBS = j.jobs; UP = j.upstream;
      LS.write(LS_JOBS, JOBS); LS.write(LS_UP, UP);
      paintUpstream(); paintNewTeam(); paintTeamFilter(); paintSum(); paintList();
      toast('导入成功：' + JOBS.length + ' 单 · ' + UP.length + ' 上游');
    } catch (e) { toast('导入失败：' + (e.message || 'JSON 解析不了') + '（本地数据没动）'); }
  }

  /* ============ 上游对账：一次合并「几何拉取 + 粘贴表格」，判定全在服务端一份规则里 ============ */
  const BUCKETS = [
    ['missLedger', '① 上游有 · 你台账没录', 'bad'],
    ['noKey', '② 上游没给单号 · 要人工认', 'bad'],
    ['stBad', '③ 状态不一致', 'warn'],
    ['amtBad', '④ 订单金额不一致（差超过 1 元）', 'warn'],
    ['shareBad', '⑤ 到账工资 ≠ 台账分成金额', 'warn'],
    ['odd', '⑥ 上游自己就异常（金额 0 / 交易关闭）', 'info'],
    ['dup', '⑦ 你台账里同一单号出现多次', 'info'],
    ['multiNo', '⑧ 上游一格塞了多个单号', 'info'],
    ['missUp', '⑨ 你台账有 · 这批上游没有', 'info'],
  ];
  const COL_LABEL = { '': '忽略', no: '订单号', amount: '订单金额', paid: '到账工资', group: '群名', team: '渠道', draft: '初稿', final: '终稿', takeDate: '接单日', doneDate: '完单日', status: '结算状态', orderStatus: '交易状态', person: '派单员', note: '备注' };

  async function runRecon() {
    const sources = [];
    if ($('#rJihe').checked) sources.push({ kind: 'jihe', account: $('#rAcc').value.trim() });
    if ($('#rPaste').checked) {
      const text = $('#rText').value;
      if (!text.trim()) return toast('勾了「粘贴的表格」但框里是空的');
      sources.push({ kind: 'paste', text, name: $('#rName').value.trim(), colmaps: COLMAPS.length ? COLMAPS : undefined });
    }
    if (!sources.length) return toast('至少勾一个来源');
    $('#rBusy').textContent = '比对中…（几何那路要外连一次，几秒）';
    try {
      const j = await api('/api/upstream/match', { method: 'POST', body: JSON.stringify({ sources }) });
      if (!j.ok) throw new Error(j.error || '对账失败');
      RECON = j;
      $('#rBusy').textContent = '';
      renderRecon();
      toast('对完：配上 ' + j.matched + ' / ' + j.uniqueNo + ' 个单号');
    } catch (e) { $('#rBusy').textContent = ''; toast('对账失败：' + (e.message || e)); }
  }

  function saveAccount() {
    const v = $('#rAcc').value.trim();
    if (!/^\d{6,20}$/.test(v)) return toast('账号要是 6-20 位数字');
    api('/api/upstream/account', { method: 'POST', body: JSON.stringify({ account: v }) })
      .then(j => { if (!j.ok) throw new Error(j.error); toast('已存进服务端配置（不进代码、不进仓库）'); $('#rAccSaved').textContent = '已存'; })
      .catch(e => toast('没存上：' + (e.message || e)));
  }

  function rowHtml(x, kind) {
    const led = x.ledStatus
      ? `台账 ${x.ledStatus} · ${money(x.ledAmount)}×${x.ledRate || 0}% = ${money(x.ledShare)}`
      : (kind === 'missUp' ? `台账 ${x.ledStatus || ''} · ${money(x.ledAmount)}×${x.ledRate || 0}% = ${money(x.ledShare)}` : '台账没有这单');
    const up = x.src ? `${x.src}：订单 ${money(x.extAmount)}${x.extPaid ? ' · 已发 ' + money(x.extPaid) : ''}${x.extStatus ? ' · ' + x.extStatus : ''}` : '';
    const tail = kind === 'amtBad' ? `差 ${x.diff > 0 ? '+' : ''}${money(x.diff)} 元`
      : kind === 'shareBad' ? `差 ${x.diff > 0 ? '+' : ''}${money(x.diff)} 元（台账分成 ${money(x.share)}）`
        : kind === 'dup' ? `台账里出现 ${x.count + 1} 次`
          : kind === 'multiNo' ? `这格是 ${(x.extNosText || '').replace(/、/g, ' , ')}` : '';
    return `<tr>
      <td class="mono">${esc(x.no || '（没单号）')}</td>
      <td>${esc(x.src || '—')}</td><td>${esc(up || '—')}</td><td>${esc(led)}${x.ledDate ? ' · 接单 ' + esc(x.ledDate) : ''}</td>
      <td class="sub">${esc(tail)}</td>
      <td>${x.ledId ? `<button class="btn sm g" data-goto="${esc(x.no || '')}" data-id="${esc(x.ledId)}">定位</button>` : ''}
        <button class="btn sm g" data-copyno="${esc(x.no || '')}">复制</button></td></tr>`;
  }

  function renderRecon() {
    if (!RECON) return;
    const b = RECON.buckets || {};
    const rowsOf = k => Array.isArray(b[k]) ? b[k] : [];
    const sumMoney = k => rowsOf(k).reduce((t, x) => t + (x.extAmount || x.ledAmount || 0), 0);
    $('#rSrc').innerHTML = RECON.sources.map(s => `<span class="tag">${esc(s.src)}：${s.kind === 'jihe' ? '接口拉取' : '粘贴'} · ${s.rows} 行 · 金额 ${money(s.amount)}${s.paid !== s.amount ? ' · 到账 ' + money(s.paid) : ''}${s.noKey ? ' · 无单号 ' + s.noKey : ''}</span>`).join('')
      + `<span class="tag">合并 ${RECON.rows} 行 · 唯一单号 ${RECON.uniqueNo} · 台账配上 ${RECON.matched}</span>`
      + (RECON.crossDup && RECON.crossDup.length ? `<span class="tag" style="background:#fee2e2;color:#b91c1c">⚠ 跨源重复 ${RECON.crossDup.length} 个单号，钱可能只到一次，先人工认</span>` : `<span class="tag">跨源重复 0</span>`)
      + (RECON.span ? `<span class="tag">台账侧扫描区间 ${esc(RECON.span.from)} ~ ${esc(RECON.span.to)}（${RECON.span.scanned} 单）</span>` : '');

    // 列映射修正：只在粘贴来源存在时出现，改完点「重算」再发一次
    const pastes = RECON.sources.filter(s => s.kind === 'paste' && s.headers);
    $('#rCols').innerHTML = pastes.length ? pastes.map((s, i) => `<details class="fold" style="margin:8px 0"><summary>列映射：${esc(s.src)}（我按表头猜的，不对就改，改完点「重算」）</summary>
      <div class="fbody"><div class="form">${s.headers.map((h, k) => `<div class="f"><label>${esc(h)}</label>
        <select data-col="${i}-${k}">${Object.keys(COL_LABEL).map(v => `<option value="${v}"${(s.colmap[k] || '') === v ? ' selected' : ''}>${COL_LABEL[v]}</option>`).join('')}</select></div>`).join('')}</div></div></details>`).join('') : '';
    $$('#rCols [data-col]').forEach(sel => sel.onchange = () => {
      const [i, k] = sel.dataset.col.split('-').map(Number);
      const list = RECON.sources.filter(s => s.kind === 'paste');
      if (list[i]) list[i].colmap[k] = sel.value;
      COLMAPS = list.map(s => s.colmap);
      $('#rReCalc').hidden = false;
    });

    const total = BUCKETS.reduce((t, [k]) => t + rowsOf(k).length, 0);
    const noise = rowsOf('amtNoise').length;
    $('#rOut').innerHTML = (total ? '' : '<div class="empty">这批上游跟你台账对得上，没问题单。</div>')
      + BUCKETS.map(([k, title, cls]) => {
        const arr = rowsOf(k);
        if (!arr.length) return '';
        return `<details class="bk ${cls}"${(k === 'stBad' || k === 'missLedger' || k === 'amtBad' || k === 'shareBad') ? ' open' : ''}><summary>${title}：<b>${arr.length}</b> 条`
          + `${['missLedger', 'amtBad', 'shareBad', 'stBad'].includes(k) ? ' · 涉及金额 ' + money(sumMoney(k)) + ' 元' : ''}</summary>
          <div class="bkb"><table><thead><tr><th>单号</th><th>来源</th><th>上游侧</th><th>台账侧</th><th>差在哪</th><th style="width:110px">操作</th></tr></thead>
          <tbody>${arr.map(x => rowHtml(x, k)).join('')}</tbody></table></div></details>`;
      }).join('')
      + (noise ? `<details class="bk quiet"><summary>⑩ 只差 ≤1 元：<b>${noise}</b> 条（你录台账时把金额取整了，不是错，展开看看就行）</summary>
        <div class="bkb"><table><thead><tr><th>单号</th><th>来源</th><th>上游侧</th><th>台账侧</th><th>差在哪</th><th style="width:110px">操作</th></tr></thead>
        <tbody>${rowsOf('amtNoise').map(x => rowHtml(x, 'amtNoise')).join('')}</tbody></table></div></details>` : '');
    $$('#rOut [data-copyno]').forEach(b2 => b2.onclick = () => {
      const v = b2.dataset.copyno; if (!v) return;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject())
        .then(() => toast('已复制单号 ' + v), () => toast('浏览器不让复制，手动选：' + v));
    });
    $$('#rOut [data-goto]').forEach(b2 => b2.onclick = () => gotoLedger(b2.dataset.goto));
    $('#rCsv').disabled = !total && !noise;
  }

  // 台账那一屏在同一个文档里，直接切面板 + 填它的搜索框，让他逐单去点确认（不在这里改状态）
  async function gotoLedger(no) {
    if (!no) return toast('这行没有单号，定位不了');
    if (typeof window.navigate === 'function') window.navigate('orders');
    await new Promise(r => setTimeout(r, 500));
    const host = document.getElementById('panel-orders');
    const sr = host && host.shadowRoot;
    const inp = sr && sr.getElementById('fKeyword');
    if (!inp) return toast('台账面板没准备好，你手动在「兼职数据中心」搜：' + no);
    inp.value = no; inp.dispatchEvent(new Event('input', { bubbles: true }));
    toast('已在台账里搜出：' + no + '（要改状态就在行上点编辑，一单一单来）');
  }

  function exportCsv() {
    if (!RECON) return toast('先对账一次');
    const b = RECON.buckets || {};
    const head = ['桶', '单号', '来源', '上游订单金额', '上游到账/佣金', '上游状态', '台账状态', '台账金额', '台账比例%', '台账分成', '差(元)', '接单日'];
    const lines = [head.join(',')];
    const push = (name, arr, d) => (arr || []).forEach(r => lines.push([name, r.no || '', r.src || '', r.extAmount ?? '', r.extPaid ?? '', r.extStatus || '', r.ledStatus || '', r.ledAmount ?? '', r.ledRate ?? '', r.ledShare ?? '', d ? (r.diff ?? '') : '', r.ledDate || ''].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')));
    BUCKETS.forEach(([k, title]) => push(title, b[k], k === 'amtBad' || k === 'shareBad'));
    push('⑩ ≤1元取整', b.amtNoise, true);
    const csv = '\uFEFF' + lines.join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = '上游对账差异_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('差异清单已导出（' + (lines.length - 1) + ' 行）');
  }


  /* ============ 老单补录：数据中心历史单缺的新字段，逐单人工补 ============ */
  const BF = [['channel', '渠道'], ['group', '群名'], ['draft', '初稿'], ['final', '终稿']];
  async function loadBackfill() {
    if (LEDGER.length) return paintBackfill();
    $('#bfBox').innerHTML = '<div class="sub">从数据中心读取中…</div>';
    try {
      const j = await api('/api/orders?limit=500');
      LEDGER = j.orders || [];
      LEDGER_TRUC = LEDGER.length >= 500;
      paintBackfill();
    } catch (e) { $('#bfBox').innerHTML = '<div class="sub">读不到数据中心：' + esc(e.message || e) + '</div>'; }
  }
  const bfGet = (o, k) => { const p = PATCH[String(o._id)] || {}; return p[k] !== undefined ? p[k] : ''; };
  const bfMissing = o => BF.map(([k]) => k).filter(k => !bfGet(o, k));
  function paintBackfill() {
    const need = LEDGER.filter(o => bfMissing(o).length);
    const perKey = {};
    BF.forEach(([k, n]) => { perKey[n] = LEDGER.filter(o => !bfGet(o, k)).length; });
    const rows = (BFONLY ? need : LEDGER).slice(0, 40);
    const teams = [...new Set(UP.map(u => u.team))];
    $('#bfBox').innerHTML = `
      <div class="del">补齐进度 <b>${LEDGER.length - need.length}</b> / ${LEDGER.length} 单
        <span class="sub">${BF.map(([k, n]) => n + ' 缺 ' + perKey[n]).join(' · ')}</span>
        ${LEDGER_TRUC ? '<span class="sub">（接口一次最多 500 单，这里只是前面一批）</span>' : ''}
        <button class="btn sm g" id="bfOnly">${BFONLY ? '看全部单' : '只看还缺的'}</button></div>
      <div class="sub" style="margin-bottom:7px"><b>原型：补的内容只存这台浏览器</b>（jobs_backfill_v0）。真上线时这套界面照用，落库走原有编辑接口一单一单写，<b>只填新字段，金额 / 分类 / 备注 / 完单日一律不动</b>。</div>
      <table><thead><tr><th>接单日</th><th>单号</th><th class="num">金额</th><th>分类</th><th>渠道</th><th>群名</th><th>初稿</th><th>终稿</th></tr></thead>
      <tbody>${rows.length ? rows.map(o => `<tr${bfMissing(o).length ? '' : ' style="opacity:.62"'}>
        <td class="sub">${esc(String(o.date || '').slice(0, 10))}</td>
        <td>${esc(o.orderNo || '—')}</td>
        <td class="num">${money(o.amount)}</td>
        <td class="sub">${esc(o.status || '')}</td>
        <td><input list="bfTeams" data-bf="${esc(String(o._id))}:channel" value="${esc(bfGet(o, 'channel'))}" style="width:104px"></td>
        <td><input data-bf="${esc(String(o._id))}:group" value="${esc(bfGet(o, 'group'))}" style="width:116px"></td>
        <td><input type="date" data-bf="${esc(String(o._id))}:draft" value="${esc(bfGet(o, 'draft'))}" style="width:130px"></td>
        <td><input type="date" data-bf="${esc(String(o._id))}:final" value="${esc(bfGet(o, 'final'))}" style="width:130px"></td></tr>`).join('')
        : '<tr><td colspan="8" class="sub" style="padding:12px">没有可读的单。</td></tr>'}</tbody></table>
      <datalist id="bfTeams">${teams.map(t => `<option value="${esc(t)}"></option>`).join('')}</datalist>
      ${rows.length >= 40 ? '<div class="sub" style="margin-top:6px">一次显示 40 行，其余回数据中心翻页补。</div>' : ''}
.ck{display:inline-flex;gap:6px;align-items:center;font-size:13px;cursor:pointer}
.grow{flex:1}
.mono{font-variant-numeric:tabular-nums}
textarea{width:100%;border:1px solid #cbd5e1;border-radius:9px;padding:9px;font:12.5px/1.6 Consolas,monospace;color:#1e293b}
.bk{border:1px solid #e2e8f0;border-left:4px solid #cbd5e1;border-radius:10px;margin-bottom:8px;background:#fff}
.bk > summary{cursor:pointer;padding:9px 11px;font-size:13px;font-weight:600;list-style:none}
.bk > summary::-webkit-details-marker{display:none}
.bk > summary::before{content:"▸";margin-right:7px;color:#94a3b8;font-size:11px}
.bk[open] > summary::before{content:"▾"}
.bk > summary b{font-size:14px}
.bkb{padding:0 11px 10px;overflow-x:auto}
.bk.bad{border-left-color:#dc2626}.bk.bad > summary b{color:#dc2626}
.bk.warn{border-left-color:#d97706}.bk.warn > summary b{color:#d97706}
.bk.info{border-left-color:#0891b2}.bk.info > summary b{color:#0891b2}
.bk.quiet{border-left-color:#94a3b8;background:#fcfcfd}
.bkb table{min-width:820px}`;
    $('#bfOnly').onclick = () => { BFONLY = !BFONLY; paintBackfill(); };
    $$('#bfBox [data-bf]').forEach(i => i.onchange = () => {
      const id = i.dataset.bf.split(':')[0], k = i.dataset.bf.split(':')[1];
      PATCH[id] = PATCH[id] || {};
      const v = i.value.trim();
      if (v) PATCH[id][k] = v; else delete PATCH[id][k];
      LS.write(LS_PATCH, PATCH); paintBackfill();
    });
  }

  /* ============ 事件绑定（骨架只建一次，之后都局部重绘） ============ */
  function bind() {
    $('#fQ').oninput = () => { Q = $('#fQ').value; paintList(); };
    $('#fTeam').onchange = () => { TEAM = $('#fTeam').value; paintList(); };
    $('#nAdd').onclick = addJob;
    $('#expBtn').onclick = exportImport;
    $('#upAdd').onclick = () => {
      const team = $('#upTeam').value.trim();
      if (!team) return toast('上游团队名必填');
      UP.push({ id: 'u' + Date.now(), team, person: $('#upPerson').value.trim(), rate: Number($('#upRate').value) || 45, note: $('#upNote').value.trim() });
      LS.write(LS_UP, UP);
      ['#upTeam', '#upPerson', '#upNote'].forEach(s => $(s).value = '');
      paintUpstream(); paintNewTeam(); paintTeamFilter(); toast('已加一行上游（只存本地）');
    };
    $('#nTeam').onchange = () => {
      const u = UP.find(x => x.team === $('#nTeam').value);
      if (u) { $('#nRate').value = u.rate; $('#nPerson').value = u.person || ''; }
    };
$('#rGo').onclick = runRecon;
    $('#rCsv').onclick = exportCsv;
    $('#rAccSave').onclick = saveAccount;
    $('#rReCalc').onclick = runRecon;
    $('#rPaste').onchange = () => { $('#rPasteBox').hidden = !$('#rPaste').checked; };
    $('#rPaste').onchange();
    api('/api/upstream/account').then(j => {
      if (j && j.ok && j.account) { $('#rAcc').value = j.account; $('#rAccSaved').textContent = '已存'; }
    }).catch(() => { });
    $('#foldBackfill').addEventListener('toggle', () => { if ($('#foldBackfill').open) loadBackfill(); });
  }

  skeleton();
  return { refresh: skeleton };
}
