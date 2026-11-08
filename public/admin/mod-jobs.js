// admin/mod-jobs.js — 「做单中心」：主数据是台账真单，核心是「做到哪了 + 还剩多久」
//
// 他 2026-11-07 把初衷说死了：「台账目前待结算之前状态单子应该正常进入做单中心啊，
// 需要补足数据才对，然后进行订单的提醒功能了不是？这才是我修改的最重要的初衷。」
// 所以这一屏不再是本地小本本：
//   列表 = /api/orders 的真单，待开始/进行中 自动进「在做的」；
//   状态点一下 = 走台账原有 PUT 写真库（已结算仍逐单 + 二次确认）；
//   缺初稿/终稿的先按「接单日 + 该渠道默认天数」推算出提醒并标「推算」，补录实填后标记消失。
//
// 三条红线（服务端兜着，不靠前端自觉）：
//   1. 新字段（渠道/群名/初稿/终稿）只走 /api/orders/jobfields，白名单写死在路由里；
//      金额 / 状态 / 备注 / 完单日 / 单号 / 接单日 / 分成 / 派单员 这条路进不去。
//   2. 批量写必须先 dryRun 预览、再显式 apply:true，并留上一批快照可撤销。
//   3. 上游平台只读；不代申请结算。
import { api, esc, toast } from './app.js';

const LS_UP = 'jobs_upstream_v0';
const LS_LOCAL = 'jobs_v0';          // 旧「原型单」：暂时没平台号时先落这里，号到手并入台账
const LS_DRAFT = 'jobs_draft_v1';    // 补录草稿：改动先进这里，预览后才写库
const LS_UNDO = 'jobs_undo_v1';      // 上一批写入的 before 快照
const LS_OLD = 'jobs_backfill_v0';   // 旧版「补录只存浏览器」用的键，迁一次就挪走
const ST = ['待开始', '进行中', '待结算', '已结算'];
// 【v26.96】做单工序：时间限制全部从「初稿开始」起算；终稿只需要一个预计
const STAGES = ['制作初稿', '修改初稿', '确认初稿制作正文', '正式稿修改', '交付正式稿', '售后修改'];
const STAGE_DAYS_DEF = [2, 3, 4, 6, 7, 9];   // 初稿开始 +N 天 = 该工序截止
const CLOSED = new Set(['待结算', '已结算']);
const WIP = new Set(['待开始', '进行中']);   // 「待结算之前」= 该出现在做单中心的
const JF = [['channel', '渠道'], ['group', '群名'], ['draft', '初稿'], ['final', '终稿']];
const JF_KEYS = JF.map(x => x[0]);
const BF_LABEL = { channel: '渠道', group: '群名', draft: '初稿', final: '终稿' };
const DEF_DUE = { draft: 2, final: 4 };

const CSS = `
.wrap{max-width:1180px;margin:0 auto;padding:16px 22px 70px;font:14px/1.7 -apple-system,"Microsoft YaHei",sans-serif;color:#1e293b}
h1{font-size:20px;margin:0 0 2px}
.sub{font-size:12px;color:#64748b}
.banner{background:#f0f9ff;border:1px solid #bae6fd;border-radius:11px;padding:8px 12px;font-size:12px;color:#075985;margin:8px 0 14px}
.banner.warn{background:#fff7ed;border-color:#fdba74;color:#9a3412}
/* 顶部到期汇总：大数字，点一下就筛 */
.sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:9px;margin-bottom:14px}
.sc{border:1px solid #e2e8f0;background:#fff;border-radius:12px;padding:10px 12px;text-align:left;cursor:pointer;font:inherit;color:#1e293b}
.sc b{display:block;font-size:26px;line-height:1.15;font-variant-numeric:tabular-nums}
.sc span{display:block;font-size:11.5px;color:#64748b}
.sc.late b{color:#dc2626}.sc.soon b{color:#d97706}.sc.doing b{color:#2563eb}.cash b{color:#0f766e}
.sc:hover{border-color:#94a3b8}
.sc.on{border-color:#1e293b;box-shadow:inset 0 0 0 1px #1e293b;background:#f8fafc}
/* 【v26.95】做单情况：紧凑指标 + 7 天时间轴 */
.stats{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}
.st{border:1px solid #e2e8f0;background:#fff;border-radius:10px;padding:7px 12px;cursor:pointer;font:inherit;color:#1e293b;display:flex;align-items:baseline;gap:6px}
.st b{font-size:19px;font-variant-numeric:tabular-nums}
.st span{font-size:11.5px;color:#64748b}
.st.on{border-color:#1e293b;box-shadow:inset 0 0 0 1px #1e293b;background:#f8fafc}
.st.late b{color:#dc2626}.st.soon b{color:#d97706}.st.doing b{color:#2563eb}.st.cash b{color:#0f766e;font-size:17px}
.week{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:6px;margin:2px 0 12px}
.day{border:1px solid #e2e8f0;border-radius:10px;background:#fff;padding:6px 4px 7px;text-align:center;cursor:pointer;font:inherit;color:#1e293b}
.day .d{font-size:11px;color:#64748b}
.day .n{font-size:17px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.3}
.day .k{font-size:10.5px;color:#94a3b8}
.day.on{border-color:#1e293b;box-shadow:inset 0 0 0 1px #1e293b;background:#f8fafc}
.day.late .n{color:#dc2626}.day.today .n{color:#d97706}
.day.empty .n{color:#cbd5e1}
@media (max-width:700px){.week{grid-template-columns:repeat(4,minmax(0,1fr))}}
/* 列表的时间轴分组 */
.grp{display:flex;align-items:center;gap:8px;margin:13px 0 6px;font-size:12px;color:#475569}
.grp b{font-size:12.5px;font-weight:600}
.grp::after{content:"";flex:1;height:1px;background:#e2e8f0}
.grp.late b{color:#dc2626}.grp.today b{color:#b45309}
/* 卡片内时间轴：接单 → 初稿 → 终稿 */
.tl{display:flex;align-items:flex-start;margin-top:9px;font-size:11px;color:#64748b}
.tl .node{display:flex;flex-direction:column;align-items:center;min-width:70px;text-align:center}
.tl .dot{width:9px;height:9px;border-radius:99px;background:#cbd5e1;margin-bottom:2px}
.tl .node.ok .dot{background:#16a34a}.tl .node.late .dot{background:#dc2626}.tl .node.today .dot{background:#f59e0b}
.tl .line{flex:1;height:2px;background:#e2e8f0;margin-top:4px}
.tl .node.late .t{color:#dc2626;font-weight:600}
.tl .node.today .t{color:#b45309;font-weight:600}
/* 【v26.96】做单工序标签（时间从初稿开始起算） */
.stages{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
.stage{border:1px solid #e2e8f0;background:#fff;border-radius:99px;padding:2px 9px;font:inherit;font-size:11.5px;cursor:pointer;color:#64748b}
.stage:hover{border-color:#2563eb;color:#2563eb}
.stage.on{background:#0f766e;border-color:#0f766e;color:#fff;font-weight:600}
.stage.past{background:#f0fdf4;border-color:#86efac;color:#15803d}
.stagedue{font-size:11.5px;color:#64748b;margin-top:4px}
.stagedue.bad{color:#dc2626;font-weight:600}
/* 挂起：不算催办，灰一档 */
.jc.susp{opacity:.68;background:#fbfbfc;border-left-color:#94a3b8}
/* 编辑弹窗：居中，✕/Esc 关，点空白不关 */
.modal{position:relative}
.modal .mx{position:absolute;top:8px;right:10px;border:0;background:transparent;font-size:16px;line-height:1;color:#94a3b8;cursor:pointer}
.modal .mx:hover{color:#dc2626}
/* 分组可折叠 */
details.gfold{margin:8px 0 0}
details.gfold > summary{list-style:none;cursor:pointer;padding:3px 0}
details.gfold > summary::-webkit-details-marker{display:none}
details.gfold > summary::before{content:"▸";color:#94a3b8;font-size:11px;margin-right:2px}
details.gfold[open] > summary::before{content:"▾"}
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
.right{text-align:right;min-width:170px}
.cd{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.2}
.cd.late{color:#dc2626}.cd.soon{color:#d97706}.cd.ok{color:#334155}.cd.none{color:#94a3b8;font-size:15px;font-weight:600}
.cd2{font-size:11.5px;color:#64748b;font-variant-numeric:tabular-nums}
.cd2.bad{color:#dc2626;font-weight:600}
.money{font-size:12px;color:#334155;margin-top:3px;font-variant-numeric:tabular-nums}
.money b{font-size:14px}
/* 四段步骤条 */
.steps{display:flex;gap:5px;margin-top:8px;flex-wrap:wrap;align-items:center}
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
/* 折叠：录单/对账/补录/设置都收在这里 */
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
.bkb table{min-width:820px}
/* 推算 / 待写 / 缺 —— 让他一眼看出这个提醒是实的还是暂定的 */
.est{color:#b45309;background:#fef3c7;border-radius:5px;padding:0 5px;font-size:11px}
.dft{color:#4338ca;background:#eef2ff;border-radius:5px;padding:0 5px;font-size:11px}
.miss{color:#94a3b8}
.dup{font-size:12px;margin-top:4px;line-height:1.5}
.dup.bad{color:#b91c1c}
.dup.warn{color:#b45309}
.dup.ok{color:#15803d}
.fix{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px;padding-top:8px;border-top:1px dashed #e2e8f0}
.fix input{padding:5px 7px;font-size:12px}
.fix input[type=date]{width:132px}
.bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 11px;font-size:12.5px;margin-bottom:9px}
.bar b{font-size:15px;font-variant-numeric:tabular-nums}
.bwrap{overflow-x:auto}
.bfIn{width:100%;padding:4px 6px;font-size:12px}
tr.dirty td{background:#f5f3ff}
tr.done-row td{opacity:.6}
/* 对账卡片：一单一卡，两侧并排，状态就地改 */
.rcard{border:1px solid #e2e8f0;border-left:4px solid #cbd5e1;border-radius:11px;background:#fff;padding:9px 12px;margin-bottom:8px}
.rcard.bad{border-left-color:#dc2626}.rcard.warn{border-left-color:#d97706}.rcard.info{border-left-color:#0891b2}
.rh{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rh .no{font-size:14.5px;font-weight:700;font-variant-numeric:tabular-nums}
.r2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:7px;font-size:12.5px}
.r2 .side{background:#f8fafc;border-radius:8px;padding:6px 9px}
.r2 .side b{font-size:13px}
.rdiff{margin-top:6px;font-size:12.5px;color:#b91c1c}
.rdiff.ok{color:#15803d}
.rdet{margin-top:7px;font-size:12px;background:#fffdf5;border:1px solid #fde68a;border-radius:8px;padding:7px 9px}
.rdet table{font-size:12px}
.ract{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:7px}
/* 【v26.92】就地编辑弹窗（对账卡片 / 快捷搜索共用） */
.mask{display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:80;align-items:center;justify-content:center;padding:16px}
.mask.show{display:flex}
.modal{background:#fff;border-radius:12px;width:640px;max-width:100%;padding:16px 18px;max-height:92vh;overflow:auto;box-shadow:0 18px 50px rgba(15,23,42,.25)}
.modal h3{font-size:16px;margin:0 0 10px}
.modal .form{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.mfoot{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
/* 对账区快速查台账 */
.rfind{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:4px 0 8px}
.rfind input{flex:1;min-width:220px}
.rfind table{font-size:12.5px}
`;

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const numOr = (v, d) => { const n = Number(v); return n > 0 ? n : d; };
// 【v27.2】「今天」统一用北京时间（UTC+8），跟服务端报表一致；不受设备时区/跨天影响
const localDate = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const dadd = (ds, n) => { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + Number(n)); return d.toISOString().slice(0, 10); };
// 天数差按日期字符串算（UTC 解析），与设备时区无关
const daysLeft = s => isDate(s) ? Math.round((Date.parse(s + 'T00:00:00Z') - Date.parse(localDate() + 'T00:00:00Z')) / 86400000) : null;
const cdText = n => n === null ? '没填交期' : n < 0 ? `逾期 ${-n} 天` : n === 0 ? '今天到期' : n === 1 ? '明天到期' : `还剩 ${n} 天`;

// 一单的紧急度与排序权重：逾期最久 → 今天/明天 → 余下天数 → 没交期 → 已交的沉底
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
  const $$ = (s, root) => [...(root || sh).querySelectorAll(s)];
  const money = n => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const LS = {
    read: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } },
    write: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('这台浏览器存不下（可能隐私模式）'); } },
  };

  /* ============ 状态 ============ */
  // 两条窄写入口，各自一份预览与撤销快照：新字段一条、派单员一条。分成比例没有入口（口径未决，只在完整单子里列出来）
  const CH = {
    jf: { path: '/api/orders/jobfields', ls: LS_UNDO, label: '渠道/群名/初稿/终稿' },
    w: { path: '/api/orders/writer-patch', ls: 'jobs_undo_writer_v1', label: '派单员' },
  };
  let UP = LS.read(LS_UP, []);
  let LOCAL = LS.read(LS_LOCAL, []);
  let DRAFT = LS.read(LS_DRAFT, {});
  let UNDO = { jf: LS.read(CH.jf.ls, null), w: LS.read(CH.w.ls, null) };
  let PREV = { jf: null, w: null };
  let LED = [], TRUNC = false, LOADING = true, LOADERR = '';
  let VIEW = 'doing', Q = '', TEAM = '';
  let DAY = '';   // 【v26.95】时间轴：点某一天只看那天到期的（'' / 'overdue' / 'YYYY-MM-DD'）
  // 【v26.96】工序默认天数（本机可改）：初稿开始 +N 天 = 该工序截止
  let STAGE_DAYS = LS.read('jobs_stage_days_v0', STAGE_DAYS_DEF);
  if (!Array.isArray(STAGE_DAYS) || STAGE_DAYS.length !== STAGES.length) STAGE_DAYS = STAGE_DAYS_DEF.slice();
  // 【v26.91】提醒排序：默认按初稿应交时间先后跟进；可切终稿顺序或原来的紧急度。选择存本机。
  let SORT = LS.read('jobs_sort_v0', 'draft');
  if (!['draft', 'final', 'heat'].includes(SORT)) SORT = 'draft';
  let RECON = null, COLMAPS = [];
  let RVIEW = 'card', RDET = {};     // 对账结果默认卡片；RDET 存"就地查这单"的台账详情
  let RQ = '';                       // 【v26.92】对账区快速查台账的关键词
  let SEL = new Set(), FIX = new Set();
  let BFONLY = true, BFALL = false;
  let FULL = null, FVIEW = 'all', FQ = '', FPAGE = 0, FSEL = new Set(), FBUSY = '';
  let DUPRES = null, DUPT = null, DUPSEQ = 0;
  let DUPG = null, DUPTG = null;   // 【v27.0】同群名+同金额的重复识别（没单号时也能查）
  let MIGRATED = 0;

  // 旧版「补录只存浏览器」的草稿搬进新草稿区：搬一次就把原件挪到 *_moved，免得下次又当新数据重复计
  try {
    const old = LS.read(LS_OLD, null);
    if (old && typeof old === 'object' && Object.keys(old).length) {
      let n = 0;
      for (const [id, v] of Object.entries(old)) {
        if (!v || typeof v !== 'object') continue;
        DRAFT[id] = DRAFT[id] || {};
        for (const k of JF_KEYS) {
          const val = String(v[k] || '').trim();
          if (val && !DRAFT[id][k]) { DRAFT[id][k] = val; n++; }
        }
        if (!Object.keys(DRAFT[id]).length) delete DRAFT[id];
      }
      LS.write(LS_DRAFT, DRAFT);
      localStorage.setItem(LS_OLD + '_moved', JSON.stringify(old));
      localStorage.removeItem(LS_OLD);
      MIGRATED = n;
    }
  } catch (e) { /* 搬不动就照常用新键，旧数据还留在原键里 */ }

  const upOf = team => UP.find(u => u.team === team) || {};
  const liveOf = (o, k) => String(o[k] === undefined || o[k] === null ? '' : o[k]).trim();
  const draftOf = id => DRAFT[String(id)] || {};
  const effOf = (o, k) => liveOf(o, k) || String(draftOf(o._id)[k] || '').trim();

  // 台账真单 → 卡片行：交期实填优先；没填就按「接单日 + 该渠道默认天数」推算，并带 est 标记
  function rowOfLedger(o) {
    const f = {};
    JF_KEYS.forEach(k => { f[k] = effOf(o, k); });
    const u = upOf(f.channel);
    // 工序时间从「初稿开始」起算；没填初稿开始就退回接单日
    const start = isDate(liveOf(o, 'draftStart')) ? String(liveOf(o, 'draftStart')).slice(0, 10)
      : (isDate(o.date) ? String(o.date).slice(0, 10) : null);
    const est = (v, n) => isDate(v) ? { v: String(v), est: false }
      : (start ? { v: dadd(start, n), est: true } : { v: null, est: false });
    const D = est(f.draft, numOr(u.dueDraft, DEF_DUE.draft)), F = est(f.final, numOr(u.dueFinal, DEF_DUE.final));
    const stage = String(o.stage || '').trim();
    const si = STAGES.indexOf(stage);
    return {
      key: 'L' + o._id, src: 'ledger', id: String(o._id), o,
      no: o.orderNo || '', amount: Number(o.amount) || 0, rate: Number(o.shareRate) || 0,
      status: o.status || '待开始', note: o.note || '', person: o.writer || '',
      channel: f.channel, group: f.group, draft: f.draft, final: f.final,
      draftStart: start, stage, stageDue: si >= 0 && start ? dadd(start, STAGE_DAYS[si]) : null,
      suspended: /^1$|true/.test(String(o.suspended || '').trim()),
      draftDue: D.v, draftEst: D.est, finalDue: F.v, finalEst: F.est,
      takeDate: String(o.date || '').slice(0, 10), doneDate: o.doneDate || null,
      missing: JF_KEYS.filter(k => !liveOf(o, k)),
      dirty: JF_KEYS.filter(k => { const d = draftOf(o._id)[k]; return d !== undefined && String(d).trim() !== liveOf(o, k); }),
    };
  }
  // 本机单：还没拿到平台号的先落这里，号到手一键并入台账
  function rowOfLocal(j) {
    return {
      key: 'J' + j.id, src: 'local', id: j.id, j,
      no: j.no || '', amount: Number(j.amount) || 0, rate: Number(j.rate) || 0,
      status: j.status || '待开始', note: j.note || '', person: j.person || '',
      channel: j.team || '', group: j.group || '',
      stage: '', stageDue: null, draftStart: isDate(j.takeDate) ? j.takeDate : null, suspended: false,
      draftDue: isDate(j.draftDue) ? j.draftDue : null, draftEst: false,
      finalDue: isDate(j.finalDue) ? j.finalDue : null, finalEst: false,
      takeDate: isDate(j.takeDate) ? j.takeDate : '', missing: [], dirty: [],
    };
  }
  const rowsAll = () => LED.map(rowOfLedger).concat(LOCAL.map(rowOfLocal));
  // 【v27.1】当前应交：还在初稿阶段（制作/修改初稿、或没设工序）按「初稿应交」排最前；
  // 工序走到确认初稿及以后，才按该工序截止往下放。
  const DRAFT_PHASE = new Set(['制作初稿', '修改初稿']);
  const dueNow = j => {
    if (j.stage && !DRAFT_PHASE.has(j.stage)) return j.stageDue || j.finalDue || j.draftDue;
    return j.draftDue || j.stageDue || j.finalDue;
  };
  const jOf = key => rowsAll().find(x => x.key === key);
  const draftCount = () => Object.keys(DRAFT).filter(id => DRAFT[id] && Object.keys(DRAFT[id]).length).length;

  const inList = j => {
    const h = heat(j);
    const dDraft = daysLeft(j.draftDue);
    if (VIEW === 'all') { /* 全部含已闭环 */ }
    else if (VIEW === 'nonum') { if (String(j.no || '').trim()) return false; }   // 候补区：所有缺单号的
    else if (VIEW === 'susp') { if (!j.suspended) return false; }                 // 挂起中
    else if (VIEW === 'pay') { if (j.status !== '待结算') return false; }
    else if (VIEW === 'late') { if (CLOSED.has(j.status) || h.cls !== 'late') return false; }
    else if (VIEW === 'soon') { if (CLOSED.has(j.status) || h.cls !== 'soon') return false; }
    else if (VIEW === 'draft') { if (CLOSED.has(j.status) || dDraft === null || dDraft >= 0) return false; }
    else if (VIEW === 'est') { if (CLOSED.has(j.status) || !(j.draftEst || j.finalEst)) return false; }
    else if (!WIP.has(j.status)) return false;   // 默认「在做的」= 待结算之前，台账里这几档自动进来
    if (TEAM && j.channel !== TEAM) return false;
    // 时间轴选了一天：当前应交（初稿阶段按初稿，过了初稿按工序）落在那天
    if (DAY) {
      const nd = dueNow(j);
      const hit = DAY === 'overdue'
        ? (isDate(nd) && daysLeft(nd) < 0 && !CLOSED.has(j.status) && !j.suspended)
        : (nd === DAY);
      if (!hit) return false;
    }
    const q = Q.trim().toLowerCase();
    if (q && ![j.no, j.group, j.person, j.note, j.channel].some(x => String(x || '').toLowerCase().includes(q))) return false;
    return true;
  };
  const listed = () => {
    const arr = rowsAll().filter(inList);
    // 【v26.91】已闭环的沉底；没填日期的排在有日期的后面；同日再按紧急度
    const closedLast = (a, b) => (CLOSED.has(a.status) ? 1 : 0) - (CLOSED.has(b.status) ? 1 : 0);
    const due = (j, k) => isDate(j[k]) ? String(j[k]) : '9999-12-31';
    if (SORT === 'draft') {
      // 【v27.1】初稿阶段按初稿应交排最前；过了初稿按工序截止。今天 → 已逾期 → 明天 → 以后；挂起沉底
      const pri = j => {
        if (j.suspended) return 10;
        if (CLOSED.has(j.status)) return 9;
        const dl = daysLeft(dueNow(j));
        return dl === 0 ? 0 : dl !== null && dl < 0 ? 1 : dl === 1 ? 2 : 3;
      };
      arr.sort((a, b) => pri(a) - pri(b) || String(dueNow(a) || '9999').localeCompare(String(dueNow(b) || '9999')) || due(a, 'finalDue').localeCompare(due(b, 'finalDue')) || heat(a).score - heat(b).score);
    }
    else if (SORT === 'final') arr.sort((a, b) => (a.suspended ? 1 : 0) - (b.suspended ? 1 : 0) || closedLast(a, b) || due(a, 'finalDue').localeCompare(due(b, 'finalDue')) || due(a, 'draftDue').localeCompare(due(b, 'draftDue')) || heat(a).score - heat(b).score);
    else arr.sort((a, b) => (a.suspended ? 1 : 0) - (b.suspended ? 1 : 0) || heat(a).score - heat(b).score);
    return arr;
  };

  /* ============ 骨架 ============ */
  // 【v26.90】外壳每次切回本面板都会调 refresh()，以前它等于重建整块 DOM ——
  // 他粘进框里的表格、勾好的来源、刚跑出来的对账结果就这么没了。现在骨架只建一次，切回来只重画数据。
  let BUILT = false;
  function paintAll() {
    paintHead(); paintSum(); paintWeek(); paintViews(); paintTeamFilter(); paintList();
    paintUpstream(); paintNewTeam(true); paintBackfill(); paintFull(); paintArchives();
  }
  function skeleton() {
    if (BUILT) { paintAll(); return; }
    $('#app').innerHTML = `
      <h1>🛠 做单中心 <span class="sub">今天该做什么 · 一眼看完</span></h1>
      <div class="banner" id="head">正在读台账…</div>
      <div class="stats" id="sum"></div>
      <div class="week" id="week"></div>
      <div class="sub" style="margin:-8px 0 10px">时间轴＝当前应交：还在做初稿的按初稿时间排最前，工序过了初稿才按工序截止往下放；点一天只看那天，再点取消。</div>
      <div class="chips" id="views"></div>
      <div class="chips" style="margin-top:-6px">
        <select id="fTeam" style="max-width:180px"></select>
        <select id="fSort" title="提醒按什么顺序排" style="max-width:170px">
          <option value="draft">按初稿时间顺序</option>
          <option value="final">按终稿时间顺序</option>
          <option value="heat">按紧急度（逾期优先）</option>
        </select>
        <input id="fQ" style="width:230px" placeholder="搜单号 / 群名 / 派单员 / 备注">
        <span class="sub" id="cnt"></span>
      </div>

      <details class="fold" id="foldNew"><summary>＋ 记一单<span class="sub">（有平台单号就直接写进台账；暂时没号先留本机，号到手再并入）</span></summary>
        <div class="fbody"><div class="form">
          <div class="f"><label>渠道（上游）*</label><select id="nTeam"></select></div>
          <div class="f"><label>群名称</label><input id="nGroup" placeholder="客户群名 / 群ID"></div>
          <div class="f"><label>接单金额（元）*</label><input id="nAmount" type="number" min="0" step="1" placeholder="例：300"></div>
          <div class="f"><label>抽成比例 %</label><input id="nRate" type="number" min="1" max="100" step="0.5" placeholder="选渠道自动带"></div>
          <div class="f"><label>派单员</label><input id="nPerson" placeholder="自动带，可改"></div>
          <div class="f"><label>平台单号（填了才写得进台账，也才能与上游对上）</label><input id="nNo" placeholder="19 位平台号，可直接粘贴"><div class="dup" id="dupLine"></div></div>
          <div class="f"><label>接单日</label><input id="nTake" type="date" value="${localDate()}"></div>
          <div class="f"><label>初稿开始（工序起算日）</label><input id="nStart" type="date" value="${localDate()}"></div>
          <div class="f"><label>初稿应交</label><input id="nDraft" type="date"></div>
          <div class="f"><label>终稿预计（可不填）</label><input id="nFinal" type="date"></div>
          <div class="f"><label>当前工序</label><select id="nStage">${STAGES.map((s, i) => `<option${i === 0 ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
          <div class="f"><label>起始状态</label><select id="nStatus">${ST.map(s => `<option${s === '待开始' ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
          <div class="f" style="grid-column:1/-1"><label>备注</label><input id="nNote" placeholder="内容要求、客户要求、群里原话…"></div>
          <div class="dup" id="dupG" style="grid-column:1/-1"></div>
          <button class="btn p" id="nAdd">＋ 存进台账</button>
          <button class="btn g" id="nLocal">只留本机</button>
          <span class="sub">没单号也能存台账（进候补区补号）；初/终稿留空 = 按初稿开始 + 渠道默认天数推算。</span>
        </div></div>
      </details>

      <div id="list"></div>

      <details class="fold" id="foldBackfill"><summary>🧾 老单补录 / 批量修正<span class="sub">历史单缺的渠道·群名·初稿·终稿：完全展示、按月折叠、勾选批量，先预览再写库</span></summary>
        <div class="fbody"><div id="bfBox"><div class="sub">正在读台账…</div></div></div>
      </details>

      <details class="fold" id="foldUp"><summary>⚙️ 渠道 / 上游设置<span class="sub">渠道、派单员、分成比例、默认交期天数 —— 配一次长期用</span></summary>
        <div class="fbody"><div id="upBox"></div><hr style="border:0;border-top:1px solid #f1f5f9;margin:12px 0">
          <div class="form">
            <div class="f"><label>渠道（上游团队）*</label><input id="upTeam" placeholder="例：几何团队"></div>
            <div class="f"><label>派单员</label><input id="upPerson" placeholder="给这单派活的人"></div>
            <div class="f"><label>分成比例 %</label><input id="upRate" type="number" min="1" max="100" step="0.5" value="45"></div>
            <div class="f"><label>初稿默认 + 天</label><input id="upDD" type="number" min="1" max="60" value="2"></div>
            <div class="f"><label>终稿默认 + 天</label><input id="upDF" type="number" min="1" max="60" value="4"></div>
            <div class="f"><label>备注</label><input id="upNote"></div>
            <button class="btn p" id="upAdd">＋ 添加</button>
          </div>
          <div class="sub" style="margin-top:12px"><b>工序时间</b>（从「初稿开始」起算，改完点保存；本机保存）</div>
          <div class="form">
            ${STAGES.map((s, i) => `<div class="f"><label>${s} + 天</label><input id="sd${i}" type="number" min="1" max="60" value="${STAGE_DAYS[i]}"></div>`).join('')}
            <button class="btn g" id="sdSave">保存工序天数</button>
          </div></div>
      </details>

      <details class="fold" id="foldRecon"><summary>🔎 上游对账（只读）<span class="sub">就在这里 · 几何视传拉取 + 粘贴表格合并比对，只列有问题的行</span></summary>
        <div class="fbody">
          <div class="rfind">
            <input id="rFind" placeholder="🔍 快速查台账：单号 / 群名 / 派单员 / 备注 / 渠道（不用切去数据中心，查到就能就地编辑）" autocomplete="off">
            <span class="sub" id="rFindN"></span>
          </div>
          <div id="rFindOut"></div>
          <div class="row2">
            <label class="ck"><input type="checkbox" id="rJihe" checked>几何视传（接口拉取）</label>
            <label class="ck"><input type="checkbox" id="rPaste">粘贴的表格（金山这类没接口）</label>
            <span class="grow"></span>
            <button class="btn p" id="rGo">开始对账</button>
            <button class="btn g" id="rCsv" disabled>导出差异 CSV</button>
            <span class="sub" id="rBusy"></span>
          </div>
          <div class="bar" id="archBar"><b>📦 档案</b>
            <span class="sub">每次对账自动存一批，含粘贴原文（只存在你自己的库里，不进代码仓库；只留最近 60 批）</span>
            <span class="grow"></span>
            <select id="archSel" style="max-width:300px"></select>
            <button class="btn sm g" id="archUse">回填这批原文</button>
            <button class="btn sm g" id="archRe">回填并重跑</button>
            <button class="btn sm g" id="archDel">删掉这批</button>
            <span class="sub" id="archN"></span>
          </div>
          <div class="form" style="margin-top:8px">
            <div class="f"><label>几何结算账号（只存服务端配置，不进代码不进仓库）</label><input id="rAcc" placeholder="结算账号" inputmode="numeric"></div>
            <button class="btn g" id="rAccSave">存住</button><span class="sub" id="rAccSaved"></span>
          </div>
          <div id="rPasteBox" hidden style="margin-top:8px">
            <div class="form"><div class="f"><label>这批表格叫什么（例：金山-再飞）</label><input id="rName" placeholder="留空自动叫 粘贴表"></div></div>
            <textarea id="rText" rows="4" placeholder="把上游表格整块 Ctrl+C 粘这里；两张表之间空一行，各自表头可以不同"></textarea>
          </div>
          <div class="sub" style="margin-top:8px">红线：全程只读——不改你台账、不改上游平台、不代你申请结算。判定规则只有一份，在服务端，与台账 500 条上限无关。</div>
          <div id="rSrc" class="sub" style="margin-top:6px"></div>
          <div class="sub" style="margin:6px 0"><button class="btn sm g" id="rReCalc" hidden>按修正后的列映射重算</button></div>
          <div id="rCols"></div>
          <div id="rOut" style="margin-top:8px"></div>
        </div>
      </details>

      <details class="fold" id="foldFull"><summary>🗂 完整单子 · 全量整理<span class="sub">台账全部老单 + 上游两侧并排：每单缺什么、建议补什么，一次整理完</span></summary>
        <div class="fbody">
          <div class="row2">
            <span class="sub">来源勾法跟上面「上游对账」共用，改完直接拉：</span>
            <button class="btn p" id="fGo">拉全量并合并</button>
            <input id="fFq" style="width:200px" placeholder="搜单号 / 派单员 / 群名 / 备注">
            <span class="sub" id="fBusy"></span>
          </div>
          <div class="chips" id="fStats" style="margin-top:8px"></div>
          <div class="bar" id="fBar" style="display:none"></div>
          <div id="fPrevBox"></div>
          <div class="bwrap" id="fOut"></div>
        </div>
      </details>

      <div class="mask" id="edMask"><div class="modal" id="edBox"></div></div>`;
    BUILT = true;
    $('#fSort').value = SORT;
    paintAll();
    if (!$('#nDraft').value) syncNewDue();
    bind();
  }

  /* ============ 顶部横幅：把「读的是真库、写要预览」说清楚 ============ */
  function paintHead() {
    const b = $('#head');
    if (!b) return;
    if (LOADING) { b.className = 'banner'; b.textContent = '正在读台账…'; return; }
    if (LOADERR) { b.className = 'banner warn'; b.textContent = '读台账失败：' + LOADERR + '（列表是空的，别在这个状态下改东西）'; return; }
    const all = rowsAll();
    const open = all.filter(j => WIP.has(j.status)).length;
    const estN = all.filter(j => !CLOSED.has(j.status) && (j.draftEst || j.finalEst)).length;
    const dn = draftCount();
    b.className = 'banner';
    b.innerHTML = `台账 <b>${LED.length}</b> 单 + 本机 <b>${LOCAL.length}</b> 单，其中 <b>${open}</b> 单还没交付，已自动进下面这张表。`
      + (LOCAL.length ? `　<b style="color:#b45309">本机 ${LOCAL.length} 单只在这台浏览器，数据中心看不到；点卡片「并入台账」才会进数据中心。</b>` : '')
      + `　<span class="est">${estN} 单的交期是按接单日推算的</span>，补录实填后这个标记会消失。`
      + (MIGRATED ? `　已把这台浏览器里旧版补录的 <b>${MIGRATED}</b> 处草稿接过来（还没写库）。` : '')
      + (dn ? `　当前 <b>${dn}</b> 单有改动待写入，展开「老单补录」预览后再写。` : '')
      + (TRUNC ? `<br><b style="color:#b45309">接口一次最多返回 500 单，现在拿到 ${LED.length} 单，列表被截断</b>：提醒和补录只覆盖拿到的这部分，服务端分页排在下一期。` : '');
  }

  /* ============ 做单情况（紧凑指标，点=筛） + 7 天时间轴 ============ */
  function paintSum() {
    const all = rowsAll();
    const open = all.filter(j => !CLOSED.has(j.status) && !j.suspended);
    const susp = all.filter(j => !CLOSED.has(j.status) && j.suspended).length;
    const late = open.filter(j => heat(j).cls === 'late');
    const soon = open.filter(j => heat(j).cls === 'soon');
    const draftBad = open.filter(j => { const n = daysLeft(dueNow(j)); return n !== null && n < 0; });
    const est = open.filter(j => j.draftEst || j.finalEst);
    const waitPay = all.filter(j => j.status === '待结算');
    const cell = (cls, n, label, view) => `<button class="st ${cls}${VIEW === view ? ' on' : ''}" data-view="${view}"><b>${n}</b><span>${label}</span></button>`;
    $('#sum').innerHTML =
      cell('doing', open.length, '在做的', 'doing') +
      cell('soon', soon.length, '今天/明天到期', 'soon') +
      cell('', draftBad.length, '工序/初稿过期', 'draft') +
      cell('late', late.length, '终稿逾期', 'late') +
      `<button class="st cash${VIEW === 'pay' ? ' on' : ''}" data-view="pay"><b>¥${money(waitPay.reduce((t, j) => t + j.amount * j.rate / 100, 0))}</b><span>待结算应得（${waitPay.length} 单）</span></button>` +
      cell('', est.length, '交期靠推算', 'est') +
      (susp ? cell('', susp, '挂起中', 'susp') : '');
    $$('#sum [data-view]').forEach(x => x.onclick = () => {
      VIEW = VIEW === x.dataset.view ? 'doing' : x.dataset.view;   // 再点一次=取消
      paintSum(); paintViews(); paintList();
    });
    paintWeek();   // 数据变了就跟着重画，否则加载完还是第一次的空时间轴
  }

  // 【v26.95】7 天时间轴：每天有几单到期（初稿或终稿），点一天只看那天
  function paintWeek() {
    const box = $('#week');
    if (!box) return;
    const open = rowsAll().filter(j => !CLOSED.has(j.status) && !j.suspended);
    // 当前应交：初稿阶段按初稿，过了初稿按工序截止
    const nextDue = dueNow;
    const overdue = open.filter(j => isDate(nextDue(j)) && daysLeft(nextDue(j)) < 0).length;
    const cells = [`<button class="day late${DAY === 'overdue' ? ' on' : ''}" data-day="overdue"><div class="d">逾期</div><div class="n">${overdue}</div><div class="k">单</div></button>`];
    for (let i = 0; i < 7; i++) {
      const d = dadd(localDate(), i);
      const n = open.filter(j => nextDue(j) === d).length;
      cells.push(`<button class="day${DAY === d ? ' on' : ''}${i === 0 ? ' today' : ''}${n ? '' : ' empty'}" data-day="${d}"><div class="d">${i === 0 ? '今天' : i === 1 ? '明天' : d.slice(5)}</div><div class="n">${n}</div><div class="k">单</div></button>`);
    }
    box.innerHTML = cells.join('');
    $$('#week [data-day]').forEach(b => b.onclick = () => {
      DAY = DAY === b.dataset.day ? '' : b.dataset.day;
      paintWeek(); paintList();
    });
  }

  function paintViews() {
    const named = { doing: '在做的（待结算之前）', late: '终稿逾期', soon: '今天/明天到期', pay: '待结算', draft: '工序/初稿过期', est: '交期靠推算', nonum: '候补区（缺单号）', susp: '挂起中' };
    const nonum = rowsAll().filter(j => !String(j.no || '').trim()).length;
    const susp = rowsAll().filter(j => j.suspended && !CLOSED.has(j.status)).length;
    $('#views').innerHTML = `<button class="chip${VIEW === 'all' ? ' on' : ''}" data-v="all">全部（含已闭环）</button>`
      + `<button class="chip${VIEW === 'doing' ? ' on' : ''}" data-v="doing">在做的</button>`
      + `<button class="chip${VIEW === 'nonum' ? ' on' : ''}" data-v="nonum">候补区·缺单号${nonum ? '（' + nonum + '）' : ''}</button>`
      + (susp ? `<button class="chip${VIEW === 'susp' ? ' on' : ''}" data-v="susp">挂起中（${susp}）</button>` : '')
      + `<span class="sub">当前视图：<b style="color:#1e293b">${VIEW === 'all' ? '全部（含已闭环）' : named[VIEW]}</b>　·　卡片上四个圈就是状态，点一下写进台账；上面数字点一下就是筛。</span>`;
    $$('#views [data-v]').forEach(x => x.onclick = () => { VIEW = x.dataset.v; paintSum(); paintViews(); paintList(); });
  }

  function paintTeamFilter() {
    const teams = [...new Set(UP.map(u => u.team).concat(rowsAll().map(j => j.channel)).filter(Boolean))];
    $('#fTeam').innerHTML = '<option value="">全部渠道</option>' + teams.map(t => `<option value="${esc(t)}"${TEAM === t ? ' selected' : ''}>${esc(t)}</option>`).join('');
  }

  /* ============ 进度卡列表 ============ */
  function paintList() {
    // 【v26.91】重画卡片前记住滚动位置，画完还回去：点状态圈写库后不再跳顶
    const _keepY = window.scrollY;
    if (LOADING) { $('#list').innerHTML = '<div class="empty">正在读台账…</div>'; return; }
    const rows = listed();
    const sortTxt = SORT === 'draft' ? '当前应交（初稿阶段按初稿，过了初稿按工序）从早到晚' : SORT === 'final' ? '终稿应交时间从早到晚' : '逾期最久的在最上面';
    $('#cnt').textContent = `台账+本机共 ${rowsAll().length} 单，这里 ${rows.length} 单（${sortTxt}${DAY ? ' · 只看 ' + (DAY === 'overdue' ? '逾期' : DAY) : ''}）`;
    if (!rows.length) {
      $('#list').innerHTML = `<div class="empty">${LED.length || LOCAL.length ? '这个视图/筛选下没有单。切「全部」看看，或点上面数字换个筛。' : '台账里读不到单（也可能还没交付的确实是 0 单）。展开「老单补录」可以直接翻全部历史单。'}</div>`;
      return;
    }
    $('#list').innerHTML = (() => {
      if (SORT === 'heat') return rows.map(j => card(j)).join('');
      // 按交期分组：同一天的单排在一起，像时间轴一样往下走；只有「今天」默认展开
      const keyOf = j => {
        if (j.suspended) return '⏸ 挂起中（不计入提醒）';
        if (CLOSED.has(j.status)) return '已闭环';
        const v = SORT === 'draft' ? dueNow(j) : j.finalDue;
        if (!isDate(v)) return '没填交期';
        const dl = daysLeft(v);
        if (dl < 0) return v + ' · 已逾期 ' + (-dl) + ' 天';
        if (dl === 0) return v + ' · 今天';
        if (dl === 1) return v + ' · 明天';
        return v;
      };
      const groups = [];
      rows.forEach(j => {
        const g = keyOf(j);
        if (!groups.length || groups[groups.length - 1].key !== g) groups.push({ key: g, rows: [] });
        groups[groups.length - 1].rows.push(j);
      });
      const anyToday = groups.some(g => g.key.includes('今天'));
      return groups.map((g, i) => {
        const open = anyToday ? g.key.includes('今天') : i === 0;
        const cls = g.key.includes('逾期') ? ' late' : g.key.includes('今天') ? ' today' : '';
        return `<details class="gfold"${open ? ' open' : ''}><summary class="grp${cls}"><b>${esc(g.key)}</b><span class="sub">${g.rows.length} 单</span></summary>${g.rows.map(card).join('')}</details>`;
      }).join('');
    })();
    $$('#list [data-st-to]').forEach(x => x.onclick = () => setStatus(jOf(x.dataset.key), x.dataset.stTo));
    $$('#list [data-stage-to]').forEach(x => x.onclick = () => setStage(jOf(x.dataset.stage), x.dataset.stageTo));
    $$('#list [data-suspend]').forEach(x => x.onclick = () => setSuspend(jOf(x.dataset.suspend), x.dataset.suspendTo === '1'));
    $$('#list [data-jedit]').forEach(x => x.onclick = () => openEdit(x.dataset.jedit, x.dataset.jno));
    $$('#list [data-fixtog]').forEach(x => x.onclick = () => { FIX.has(x.dataset.fixtog) ? FIX.delete(x.dataset.fixtog) : FIX.add(x.dataset.fixtog); paintList(); });
    $$('#list [data-wone]').forEach(x => x.onclick = () => writeOne(x, x.dataset.wone));
    $$('#list [data-merge]').forEach(x => x.onclick = () => mergeLocal(jOf(x.dataset.merge)));
    $$('#list [data-jdel]').forEach(x => x.onclick = () => delLocal(jOf(x.dataset.jdel)));
    window.scrollTo(0, _keepY);
  }

  function card(j) {
    const h = heat(j);
    const dFinal = daysLeft(j.finalDue), dDraft = daysLeft(j.draftDue);
    const cdCls = CLOSED.has(j.status) ? 'ok' : h.cls === 'none' ? 'none' : h.cls;
    const closedSoft = j.status === '已结算' ? ' closed-soft' : '';
    const steps = ST.map(s => {
      const hit = s === j.status, next = !hit && ST.indexOf(s) === ST.indexOf(j.status) + 1;
      const cls = hit ? (j.status === '已结算' ? 'step dn hit' : 'step hit') : next ? 'step next' : 'step';
      return `<button class="${cls}" data-key="${esc(j.key)}" data-st-to="${esc(s)}" title="把状态改成「${s}」（写进台账）">${s}</button>`;
    }).join('');
    const estTag = n => n ? ' <span class="est">推算</span>' : '';
    // 草稿值和台账真值不能长一个样：没写库的一律挂「草稿」，否则他以为已经存好了
    const dk = k => j.dirty.includes(k) ? '<span class="dft">草稿</span>' : '';
    const ledger = j.src === 'ledger';
    const chips = ledger ? `　<button class="btn sm g" data-fixtog="${esc(j.key)}">补字段${j.missing.length ? '（还缺 ' + j.missing.length + '）' : ''}</button>` : '';
    // 【v26.95】卡片上直接整单编辑：金额/备注/派单员/渠道/初稿/终稿错了不用再去数据中心
    const editBtn = ledger ? `<button class="btn sm p" data-jedit="${esc(j.id)}" data-jno="${esc(j.no || '')}">编辑整单</button>` : '';
    // 卡片内的小时间轴：接单 → 初稿 → 终稿
    const nodeCls = (v) => {
      if (!isDate(v)) return '';
      if (CLOSED.has(j.status)) return 'ok';
      const dl = daysLeft(v);
      return dl < 0 ? 'late' : dl <= 1 ? 'today' : '';
    };
    const tl = `<div class="tl">
      <div class="node ok"><span class="dot"></span><span class="t">接单<br>${esc(j.takeDate || '—')}</span></div>
      <div class="line"></div>
      <div class="node ${nodeCls(j.draftDue)}"><span class="dot"></span><span class="t">初稿<br>${isDate(j.draftDue) ? esc(j.draftDue) : '未填'}${j.draftEst ? ' 推算' : ''}</span></div>
      <div class="line"></div>
      <div class="node ${nodeCls(j.finalDue)}"><span class="dot"></span><span class="t">终稿<br>${isDate(j.finalDue) ? esc(j.finalDue) : '未填'}${j.finalEst ? ' 推算' : ''}</span></div>
    </div>`;
    // 工序：点标签就改，截止＝初稿开始 + 该工序天数
    const si = STAGES.indexOf(j.stage || '');
    const stageHtml = ledger ? `<div class="stages">${STAGES.map((s, i) => `<button class="stage${s === j.stage ? ' on' : ''}${si > i ? ' past' : ''}" data-stage="${esc(j.key)}" data-stage-to="${esc(s)}" title="把工序改成「${s}」">${s}</button>`).join('')}</div>`
      + (j.stage
        ? `<div class="stagedue${j.stageDue && daysLeft(j.stageDue) < 0 && !CLOSED.has(j.status) ? ' bad' : ''}">工序「${esc(j.stage)}」截止 ${esc(j.stageDue || '—')}${j.stageDue && !CLOSED.has(j.status) ? '（' + cdText(daysLeft(j.stageDue)) + '）' : ''}</div>`
        : '<div class="stagedue">未设工序：点上面的标签设置，截止按「初稿开始 + 天数」算</div>')
      : '';
    const nonum = !String(j.no || '').trim();
    const abnormal = nonum && (j.status === '待结算' || j.status === '已结算');
    const suspBtn = ledger ? `<button class="btn sm g" data-suspend="${esc(j.key)}" data-suspend-to="${j.suspended ? '' : '1'}">${j.suspended ? '恢复' : '挂起'}</button>` : '';
    const fix = (ledger && FIX.has(j.key)) ? `<div class="fix">
        <input placeholder="渠道" data-fixin="channel" value="${esc(j.channel || '')}">
        <input placeholder="群名" data-fixin="group" value="${esc(j.group || '')}">
        <input type="date" data-fixin="draft" value="${esc(j.draft || '')}">
        <input type="date" data-fixin="final" value="${esc(j.final || '')}">
        <button class="btn sm p" data-wone="${esc(j.id)}">写这一单</button>
        <span class="sub">只写这 4 个字段；这里只填不清，要清空去「老单补录」勾覆盖。</span></div>` : '';
    return `<div class="jc ${h.cls}${closedSoft}${j.suspended ? ' susp' : ''}">
      <div>
        <div class="no">${esc(j.no || '（没填单号）')}<span class="sub">　${esc(j.channel || '没填渠道')}${dk('channel')}</span>${ledger ? '' : '<span class="dft">本机</span>'}${abnormal ? '<span class="tag" style="background:#fee2e2;color:#b91c1c">异常·缺单号</span>' : ''}${j.suspended ? '<span class="tag" style="background:#f1f5f9;color:#475569">挂起</span>' : ''}</div>
        <div class="who">👥 ${esc(j.group || '没填群名')}${dk('group')}　·　派单员 ${esc(j.person || '未记')}　·　接单 ${esc(j.takeDate || '未记')}${j.note ? '　·　📝 ' + esc(j.note) : ''}</div>
        <div class="steps">${steps}${chips}${editBtn}${suspBtn}</div>
        ${stageHtml}
        ${tl}
        ${fix}
      </div>
      <div class="right">
        <div class="cd ${cdCls}">${CLOSED.has(j.status) ? (j.status === '已结算' ? '已闭环' : '已交付·等钱') : cdText(dFinal)}</div>
        <div class="cd2 ${dDraft !== null && dDraft < 0 && !CLOSED.has(j.status) ? 'bad' : ''}">终稿 ${isDate(j.finalDue) ? j.finalDue : '未填'}${estTag(j.finalEst)}${dk('final')}　初稿 ${isDate(j.draftDue) ? j.draftDue : '未填'}${estTag(j.draftEst)}${dk('draft')}${dDraft !== null && dDraft < 0 && !CLOSED.has(j.status) ? '（初稿已过期）' : ''}</div>
        <div class="money">接单 <b>${money(j.amount)}</b> 元 × ${Number(j.rate) || 0}% = 应得 <b>${money(j.amount * j.rate / 100)}</b></div>
        ${ledger ? '' : `<button class="btn sm g" data-merge="${esc(j.key)}">并入台账</button> <button class="jdel" data-jdel="${esc(j.key)}" title="删这单（只删本机记录）">✕</button>`}
      </div></div>`;
  }

  /* ============ 状态写库：沿用台账原有 PUT，整份字段回传，只改 status ============ */
  async function setStatus(j, to) {
    if (!j || to === j.status) return;
    if (j.src === 'local') {
      j.j.status = to; LS.write(LS_LOCAL, LOCAL);
      paintSum(); paintList();
      return toast((j.no || '这单') + ' → ' + to + '（本机单，还没进台账）');
    }
    const o = j.o;
    // 【v26.96】没单号也能改状态：走到待结算会自动进候补区（标异常）
    if (to === '已结算' && !confirm('把 ' + (o.orderNo || '这单') + ' 改成「已结算」？\n\n已结算按你定的规矩只逐单点，这一步会写进台账。')) return;
    const body = {
      date: String(o.date || '').slice(0, 10), orderNo: o.orderNo, amount: Number(o.amount) || 0,
      shareRate: Number(o.shareRate) || 0, status: to, doneDate: o.doneDate || '', note: o.note || '',
    };
    if (String(o.writer || '').trim()) body.writer = o.writer;
    try {
      await api('/api/orders/' + o._id, { method: 'PUT', body: JSON.stringify(body) });
      const noNum = !String(o.orderNo || '').trim();
      toast((o.orderNo || '（没号）') + ' → ' + to + '（已写进台账）' + (noNum && to === '待结算' ? ' · 缺单号已进候补区、标异常' : ''));
      await loadLedger(true);
    } catch (e) { toast('状态没改成：' + (e.message || e)); }
  }

  /* ============ 挂起：临时不催办（不影响台账状态），恢复就回来 ============ */
  async function setSuspend(j, to) {
    if (!j) return;
    if (j.src !== 'ledger') return toast('本机单先并入台账才能挂起');
    try {
      await api('/api/orders/jobfields', { method: 'POST', body: JSON.stringify({ patches: [{ id: j.id, fields: { suspended: to ? '1' : '' } }], apply: true, onlyEmpty: false }) });
      j.o.suspended = to ? '1' : '';
      toast((j.no || '这单') + (to ? ' 已挂起（不计入提醒和时间轴，点「恢复」回来）' : ' 已恢复'));
      paintSum(); paintViews(); paintWeek(); paintList();
    } catch (e) { toast('挂起没改成：' + (e.message || e)); }
  }

  /* ============ 工序写库：只碰 stage 一个键 ============ */
  async function setStage(j, to) {
    if (!j || j.stage === to) return;
    if (j.src !== 'ledger') return toast('本机单先并入台账才能记工序');
    try {
      await api('/api/orders/jobfields', { method: 'POST', body: JSON.stringify({ patches: [{ id: j.id, fields: { stage: to } }], apply: true, onlyEmpty: false }) });
      j.o.stage = to;
      toast((j.no || '这单') + ' 工序 → ' + to);
      paintSum(); paintWeek(); paintList();
    } catch (e) { toast('工序没改成：' + (e.message || e)); }
  }

  /* ============ 单号查重：边打边查，别等存了才发现重复 ============ */
  const noCandidates = raw => [...new Set(String(raw || '').replace(/[，、;；\s]/g, ' ').match(/\d{6,24}/g) || [])];
  function onNoInput() {
    clearTimeout(DUPT);
    const raw = $('#nNo').value;
    const c = noCandidates(raw);
    if (c.length !== 1) { DUPRES = null; paintDup(raw); return; }
    paintDup(raw);   // 先落一句「查台账中…」：不然上一个号的「已有 1 条」还挂在下面，看着像在新号也重复
    DUPT = setTimeout(() => checkDup(c[0]), 350);
  }
  async function checkDup(no) {
    if (!no) return;
    const seq = ++DUPSEQ;
    try {
      const j = await api('/api/orders/lookup', { method: 'POST', body: JSON.stringify({ text: no }) });
      if (seq !== DUPSEQ) return;                    // 输入又变了，旧结果作废，不能拿上一条的命中吓他
      const rows = ((j.cards || [])[0] || {}).rows || [];
      DUPRES = { no, state: rows.length ? (rows.length > 1 ? 'multi' : 'ok') : 'miss', count: rows.length, rows };
      paintDup($('#nNo').value);
    } catch (e) {
      if (seq !== DUPSEQ) return;
      DUPRES = { no, state: 'err', count: 0, rows: [], msg: e.message || String(e) };
      paintDup($('#nNo').value);
    }
  }
  function paintDup(raw) {
    const el = $('#dupLine');
    if (!el) return;
    const c = noCandidates(raw);
    if (!String(raw || '').trim()) { el.className = 'dup'; el.textContent = ''; return; }
    if (!c.length) { el.className = 'dup warn'; el.textContent = '这串里没识别到 6-24 位数字：当手工号处理（写不进台账，只能先留本机）'; return; }
    if (c.length > 1) { el.className = 'dup warn'; el.innerHTML = `粘进来 ${c.length} 个号，只用第一个查：<b>${esc(c[0])}</b>，还有 ${esc(c.slice(1).join(' / '))}`; return; }
    const d = DUPRES;
    if (!d || d.no !== c[0]) { el.className = 'dup'; el.textContent = '查台账中…'; return; }
    if (d.state === 'err') { el.className = 'dup warn'; el.textContent = '查重没成功：' + esc(d.msg) + '（不影响保存，但重复就没提示了）'; return; }
    if (d.state === 'miss') { el.className = 'dup ok'; el.textContent = '✓ 台账里没有这个号，放心录'; return; }
    const r = d.rows.map(x => `${x.date} · ${x.status} · ${money(x.amount)}元`).join('；');
    el.className = 'dup bad';
    el.innerHTML = `⚠ 单号 ${esc(d.no)} 台账里已有 <b>${d.count}</b> 条：${esc(r)}。<br>你台账确实有合法同号单（实测过同号两行），确认不是重复再存。 <button class="btn sm g" data-goto="${esc(d.no)}">在台账里看</button>`;
    $$('[data-goto]', el).forEach(x => x.onclick = () => gotoLedger(x.dataset.goto));
  }
  // 【v27.0】同群名 + 同金额：没单号时也能识别疑似重复（用本页已读到的台账单比，500 单以内全量）
  function checkDupG() {
    const el = $('#dupG');
    if (!el) return;
    const group = $('#nGroup').value.trim();
    const amount = Number($('#nAmount').value);
    if (!group || !(amount > 0)) { el.textContent = ''; el.className = 'dup'; DUPG = null; return; }
    const hits = LED.filter(o => String(o.group || '').trim() === group && Math.abs(Number(o.amount) - amount) < 0.01);
    DUPG = hits.length ? hits : null;
    if (!hits.length) { el.className = 'dup ok'; el.textContent = '✓ 台账里没有同群名+同金额的单'; return; }
    el.className = 'dup bad';
    el.innerHTML = `⚠ 台账里已有 <b>${hits.length}</b> 单同群名 + 同金额：`
      + hits.slice(0, 3).map(o => esc((o.orderNo || '（没号）') + ' · ' + String(o.date || '').slice(0, 10) + ' · ' + o.status)).join('；')
      + (hits.length > 3 ? ' …' : '') + '。确认不是重复再存。';
  }

  /* ============ 建单 ============ */
  function formDraft() {
    return {
      channel: $('#nTeam').value.trim(), group: $('#nGroup').value.trim(),
      amount: Number($('#nAmount').value) || 0, rate: Number($('#nRate').value) || 45,
      person: $('#nPerson').value.trim(), no: noCandidates($('#nNo').value)[0] || '',
      note: $('#nNote').value.trim(), takeDate: isDate($('#nTake').value) ? $('#nTake').value : localDate(),
      start: isDate($('#nStart').value) ? $('#nStart').value : (isDate($('#nTake').value) ? $('#nTake').value : localDate()),
      draft: $('#nDraft').value, final: $('#nFinal').value, stage: $('#nStage').value, status: $('#nStatus').value,
    };
  }
  async function addJob() {
    const d = formDraft();
    if (!(d.amount > 0)) return toast('接单金额要大于 0');
    // 【v26.96】没单号也能进台账：进候补区，等号到手再补
    if (!d.no && !confirm('这单还没有平台单号。\n\n存进台账后它会进「候补区」等补号；状态走到待结算时会自动标异常。这样存吗？')) return;
    if (d.no && DUPRES && DUPRES.no === d.no && DUPRES.state !== 'miss' &&
      !confirm('单号 ' + d.no + ' 台账里已经有 ' + DUPRES.count + ' 条。\n\n确定这是另一单、真要再存一条吗？（点了就写进台账）')) return;
    if (!d.no) {
      const gHits = LED.filter(o => String(o.group || '').trim() === d.group && Math.abs(Number(o.amount) - d.amount) < 0.01);
      if (gHits.length && !confirm('台账里已有 ' + gHits.length + ' 单同群名+同金额（'
        + gHits.slice(0, 2).map(o => (o.orderNo || '没号') + ' ' + String(o.date || '').slice(0, 10)).join('；') + '）。\n\n仍要再存一单吗？')) return;
    }
    const body = { date: d.takeDate, orderNo: d.no, amount: d.amount, shareRate: d.rate, status: d.status, doneDate: '', note: d.note };
    if (d.person) body.writer = d.person;
    try {
      const r = await api('/api/orders', { method: 'POST', body: JSON.stringify(body) });
      const id = String((r.order && r.order._id) || r._id || '');
      const fields = {};
      if (d.channel) fields.channel = d.channel;
      if (d.group) fields.group = d.group;
      if (isDate(d.start)) fields.draftStart = d.start;
      if (isDate(d.draft)) fields.draft = d.draft;
      if (isDate(d.final)) fields.final = d.final;
      if (d.stage) fields.stage = d.stage;
      let filled = 0;
      if (id && Object.keys(fields).length) {
        const k = await api('/api/orders/jobfields', { method: 'POST', body: JSON.stringify({ patches: [{ id, fields }], apply: true, onlyEmpty: false }) });
        filled = (k.rows || []).length;
      }
      toast((d.no ? '已写进台账：' + d.no : '已写进台账（没单号，进候补区）') + '（' + d.status + '）' + (filled ? ' · 渠道/工序一并填好' : ''));
      ['#nNo', '#nGroup', '#nAmount', '#nNote'].forEach(s => $(s).value = '');
      DUPRES = null; paintDup('');
      DUPG = null; const dg = $('#dupG'); if (dg) { dg.textContent = ''; dg.className = 'dup'; }
      await loadLedger(true);
    } catch (e) { toast('没存上：' + (e.message || e)); }
  }
  function saveLocal(d) {
    LOCAL.push({
      id: 'j' + Date.now(), team: d.channel, group: d.group, amount: d.amount, rate: d.rate,
      person: d.person, note: d.note, no: d.no, takeDate: d.takeDate,
      draftDue: isDate(d.draft) ? d.draft : null, finalDue: isDate(d.final) ? d.final : null,
      status: d.status, createdAt: new Date().toISOString(),
    });
    LS.write(LS_LOCAL, LOCAL);
    ['#nNo', '#nGroup', '#nAmount', '#nNote'].forEach(s => $(s).value = '');
    paintSum(); paintList(); paintTeamFilter(); paintHead();
    toast('还没平台号，先留本机；号到手在卡上点「并入台账」');
  }
  // 上游那行拿去填「记一单」：只填框，不写库 —— 漏录还是号写错，得他自己认
  function prefillNew(o) {
    $('#foldNew').open = true;
    $('#nNo').value = o.no || '';
    if (o.amount) $('#nAmount').value = o.amount;
    if (o.person) $('#nPerson').value = String(o.person).replace(/^(A?订单负责人|负责人|派单员|设计师|A)[-·:：\s]*/, '');
    const u = UP.find(x => x.team === o.src);
    if (u) { $('#nTeam').value = u.team; $('#nTeam').dispatchEvent(new Event('change')); }
    $('#nNote').value = '来自 ' + (o.src || '上游') + '：' + ($('#nNote').value || '');
    onNoInput();
    $('#nNo').focus();
    toast('已把这行填进记一单，核对完再点「存进台账」——我没替你录');
  }

  async function mergeLocal(j) {
    if (!j) return;
    const no = noCandidates(j.no)[0] || '';
    // 【v26.97】没单号也能并入：进候补区补号（v26.96 起台账收缺号）
    const tip = no
      ? '把这单写进台账？\n\n单号 ' + no + ' · ' + money(j.amount) + ' 元 × ' + j.rate + '% · ' + j.status
      : '这单还没有平台单号。\n\n并入台账后会进「候补区」等补号；状态走到待结算会自动标异常。要并入吗？';
    if (!confirm(tip)) return;
    const body = { date: isDate(j.takeDate) ? j.takeDate : localDate(), orderNo: no, amount: j.amount, shareRate: j.rate, status: j.status, doneDate: '', note: j.note || '' };
    if (j.person) body.writer = j.person;
    try {
      const r = await api('/api/orders', { method: 'POST', body: JSON.stringify(body) });
      const id = String((r.order && r.order._id) || r._id || '');
      const fields = {};
      if (j.channel) fields.channel = j.channel;
      if (j.group) fields.group = j.group;
      if (isDate(j.j.draftDue)) fields.draft = j.j.draftDue;
      if (isDate(j.j.finalDue)) fields.final = j.j.finalDue;
      if (id && Object.keys(fields).length) await api('/api/orders/jobfields', { method: 'POST', body: JSON.stringify({ patches: [{ id, fields }], apply: true, onlyEmpty: false }) });
      LOCAL = LOCAL.filter(x => String(x.id) !== String(j.id)); LS.write(LS_LOCAL, LOCAL);
      toast('已并入台账：' + (no || '（没号，已进候补区）'));
      await loadLedger(true);
    } catch (e) { toast('并入失败：' + (e.message || e)); }
  }
  function delLocal(j) {
    if (!j || j.src !== 'local') return;
    if (!confirm('删掉这笔本机单？台账里本来就没有它。')) return;
    LOCAL = LOCAL.filter(x => String(x.id) !== String(j.id)); LS.write(LS_LOCAL, LOCAL);
    paintSum(); paintList(); paintHead();
  }

  // 卡片上就地补字段：单笔写库，只填不清（要清空去补录勾覆盖）
  async function writeOne(btn, id) {
    const box = btn.closest('.fix');
    if (!box) return;
    const o = LED.find(x => String(x._id) === id);
    if (!o) return toast('这单在台账里找不到了，刷新一下');
    const fields = {};
    $$('[data-fixin]', box).forEach(i => {
      const v = i.value.trim();
      if (v || !liveOf(o, i.dataset.fixin)) fields[i.dataset.fixin] = v;
    });
    if (!Object.keys(fields).length) return toast('这几个框都是空的，没东西可写');
    try {
      const j = await api('/api/orders/jobfields', { method: 'POST', body: JSON.stringify({ patches: [{ id, fields }], apply: true }) });
      if (!j.wrote) { const s = (j.skipped || [])[0] || {}; toast('没写入：' + (s.why || '这几项和台账里的值一样')); return; }
      const r = (j.rows || [])[0] || {};
      toast('已写进台账：' + (r.labels || []).join('、') + '（金额/状态/备注都没动）');
      FIX.delete('L' + id);
      await loadLedger(true);
    } catch (e) { toast('没写进：' + (e.message || e)); }
  }

  /* ============ 渠道 / 上游设置 ============ */
  function paintUpstream() {
    $('#upBox').innerHTML = `<table><thead><tr><th>渠道（上游团队）</th><th>派单员</th><th class="num">分成%</th><th class="num">初稿+天</th><th class="num">终稿+天</th><th>备注</th><th style="width:52px">删</th></tr></thead>
      <tbody>${UP.length ? UP.map(u => `<tr>
        <td><input data-up="team" data-id="${esc(u.id)}" value="${esc(u.team)}"></td>
        <td><input data-up="person" data-id="${esc(u.id)}" value="${esc(u.person || '')}" placeholder="可留空"></td>
        <td class="num"><input data-up="rate" data-id="${esc(u.id)}" type="number" min="1" max="100" step="0.5" value="${Number(u.rate) || 45}" style="width:74px;text-align:right"></td>
        <td class="num"><input data-up="dueDraft" data-id="${esc(u.id)}" type="number" min="1" max="60" value="${Number(u.dueDraft) || DEF_DUE.draft}" style="width:66px;text-align:right"></td>
        <td class="num"><input data-up="dueFinal" data-id="${esc(u.id)}" type="number" min="1" max="60" value="${Number(u.dueFinal) || DEF_DUE.final}" style="width:66px;text-align:right"></td>
        <td><input data-up="note" data-id="${esc(u.id)}" value="${esc(u.note || '')}"></td>
        <td><button class="btn sm g" data-updel="${esc(u.id)}">✕</button></td></tr>`).join('')
        : '<tr><td colspan="7" class="sub" style="padding:14px">还没配渠道。下面加一行，例：几何团队 / 张三 / 45% / 初稿+2 / 终稿+4。默认天数决定「没填交期」时提醒怎么推算。</td></tr>'}</tbody></table>`;
    $$('#upBox [data-up]').forEach(i => i.onchange = () => {
      const u = UP.find(x => x.id === i.dataset.id); if (!u) return;
      const k = i.dataset.up;
      u[k] = (k === 'rate' || k === 'dueDraft' || k === 'dueFinal') ? (Number(i.value) || 0) : i.value.trim();
      LS.write(LS_UP, UP); paintNewTeam(true); paintTeamFilter(); paintSum(); paintList(); paintHead();
    });
    $$('#upBox [data-updel]').forEach(b => b.onclick = () => {
      if (!confirm('删掉这行渠道？已建的单不受影响。')) return;
      UP = UP.filter(u => u.id !== b.dataset.updel); LS.write(LS_UP, UP); paintUpstream(); paintNewTeam(true); paintTeamFilter();
    });
  }
  function paintNewTeam(keepDue) {
    const cur = $('#nTeam') ? $('#nTeam').value : '';
    $('#nTeam').innerHTML = '<option value="">（先在下面「渠道/上游设置」里加）</option>' + UP.map(u => `<option value="${esc(u.team)}">${esc(u.team)}${u.person ? ' · ' + esc(u.person) : ''} · ${Number(u.rate) || 45}%</option>`).join('');
    if (cur) $('#nTeam').value = cur;
    // 重画时不要把他填过的交期盖掉：只有首次建骨架和换渠道/换接单日时才推默认值
    if (!keepDue) syncNewDue();
  }
  // 默认交期跟着所选渠道走；起算日是「初稿开始」
  function syncNewDue() {
    if (!$('#nTeam') || !$('#nDraft')) return;
    const u = upOf($('#nTeam').value);
    const base = isDate($('#nStart').value) ? $('#nStart').value : (isDate($('#nTake').value) ? $('#nTake').value : localDate());
    $('#nDraft').value = dadd(base, numOr(u.dueDraft, DEF_DUE.draft));
    $('#nFinal').value = dadd(base, numOr(u.dueFinal, DEF_DUE.final));
  }

  /* ============ 台账读取 ============ */
  async function loadLedger(force) {
    if (LED.length && !force) return;
    LOADING = true; paintHead();
    try {
      const j = await api('/api/orders?limit=500');
      LED = j.orders || []; TRUNC = LED.length >= 500; LOADERR = '';
    } catch (e) { LOADERR = e.message || String(e); LED = []; }
    LOADING = false;
    paintHead(); paintSum(); paintViews(); paintTeamFilter(); paintList(); paintBackfill();
  }

  /* ============ 老单补录 / 批量修正 ============ */
  const bfVal = (o, k) => effOf(o, k);
  const bfLive = (o, k) => liveOf(o, k);
  const bfDirty = o => JF_KEYS.filter(k => { const d = draftOf(o._id)[k]; return d !== undefined && String(d).trim() !== bfLive(o, k); });
  const bfMissing = o => JF_KEYS.filter(k => !bfLive(o, k));
  const bfPatches = () => Object.keys(DRAFT).filter(id => DRAFT[id] && Object.keys(DRAFT[id]).length).map(id => ({ id, fields: DRAFT[id] }));

  function paintBackfill() {
    const box = $('#bfBox');
    if (!box) return;
    if (LOADING) { box.innerHTML = '<div class="sub">正在读台账…</div>'; return; }
    if (!LED.length) { box.innerHTML = '<div class="sub">' + (LOADERR ? '读台账失败：' + esc(LOADERR) : '台账里没有单可读。') + '</div>'; return; }
    const need = LED.filter(o => bfMissing(o).length);
    const perKey = {};
    JF.forEach(([k, n]) => { perKey[n] = LED.filter(o => !bfLive(o, k)).length; });
    const set = BFONLY ? need : LED;
    box.innerHTML = `
      <div class="bar">
        <span>已补齐 <b>${LED.length - need.length}</b> / ${LED.length} 单</span>
        <span class="sub">${JF.map(([k, n]) => n + ' 缺 ' + perKey[n]).join(' · ')}</span>
        <span class="tag">${draftCount()} 单有改动待写入</span>
        ${TRUNC ? '<span class="est">台账一次最多返回 500 单，下面只是拿到的这批</span>' : ''}
        <span class="grow"></span>
        <button class="btn sm g" id="bfOnly">${BFONLY ? '看全部单' : '只看还缺的'}</button>
        <button class="btn sm g" id="bfAll">${BFALL ? '按月折叠' : '完全展示'}</button>
      </div>
      <div class="bar" style="background:#fffbeb;border-color:#fde68a">
        <b>批量</b>
        <span class="sub">先勾行 → 填下面任一项 → 「应用到所选」（只进草稿）→「预览改动」→「写入台账」</span>
        <span class="grow"></span>
        <button class="btn sm g" id="bfSelAll">全选当前这批</button>
        <button class="btn sm g" id="bfSelNo">清空勾选</button>
        <span class="sub" id="bfSelN"></span>
      </div>
      <div class="bar" style="background:#f0fdf4;border-color:#bbf7d0">
        <b>一键整理</b>
        <span class="sub">不用勾行：自动挑「还缺的」单，先预览再写、可撤销</span>
        <span class="grow"></span>
        <button class="btn sm p" id="bfAutoChan">按派单员补渠道</button>
        <button class="btn sm p" id="bfAutoDue">按接单日补初/终稿</button>
      </div>
      <div class="row2">
        <select id="bCh" style="max-width:150px"></select>
        <input id="bGp" placeholder="群名" style="width:130px">
        <label class="ck">初稿 接单+<input id="bDd" type="number" min="1" max="90" value="2" style="width:56px">天</label>
        <label class="ck">终稿 接单+<input id="bDf" type="number" min="1" max="90" value="4" style="width:56px">天</label>
        <label class="ck"><input type="checkbox" id="bOv">覆盖已填的</label>
        <button class="btn g" id="bfApply">应用到所选</button>
        <button class="btn p" id="bfPrev">预览改动（不写库）</button>
        <button class="btn g" id="bfDrop">丢弃全部草稿</button>
        <button class="btn g" id="bfDerive">用上游数据带出渠道/群名</button>
        ${UNDO.jf ? `<button class="btn g" id="bfUndo">撤销上一批新字段（${(UNDO.jf.rows || []).length} 单）</button>` : ''}
      </div>
      <div class="sub" style="margin:8px 0">写库只碰 <b>渠道 / 群名 / 初稿 / 终稿</b> 四个字段：金额、状态（分类）、备注、完单日、单号、接单日、分成、派单员都由台账原有接口管，这条路进不去。已结算的老单同样能批量补，状态不动。</div>
      <div id="bfPrevBox"></div>
      ${BFALL ? `<div class="bwrap">${bfTable(set)}</div>` : `<div>${groupHtml(set)}</div>`}`;
    paintBfPrev();
    bindBackfill();
  }

  function groupHtml(rows) {
    const by = new Map();
    rows.forEach(o => { const m = String(o.date || '无日期').slice(0, 7); if (!by.has(m)) by.set(m, []); by.get(m).push(o); });
    return [...by.keys()].sort().reverse().map((m, i) => {
      const arr = by.get(m).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const n = arr.filter(o => bfMissing(o).length).length;
      return `<details class="bk ${n ? 'warn' : 'quiet'}"${i === 0 ? ' open' : ''}><summary>${esc(m)}：<b>${arr.length}</b> 单　还缺 <b>${n}</b>　<button class="btn sm g" data-grp="${esc(m)}">全选这组</button></summary>
        <div class="bkb">${bfTable(arr)}</div></details>`;
    }).join('');
  }

  function bfTable(rows) {
    return `<table><thead><tr><th style="width:34px">选</th><th>接单日</th><th>单号</th><th class="num">金额</th><th>状态</th><th>渠道</th><th>群名</th><th>初稿</th><th>终稿</th><th>标记</th></tr></thead>
      <tbody>${rows.map(o => {
        const miss = bfMissing(o), dirty = bfDirty(o);
        return `<tr class="${dirty.length ? 'dirty' : (!miss.length ? 'done-row' : '')}">
          <td><input type="checkbox" data-sel="${esc(String(o._id))}"${SEL.has(String(o._id)) ? ' checked' : ''}></td>
          <td class="sub">${esc(String(o.date || '').slice(0, 10))}</td>
          <td class="mono">${esc(o.orderNo || '—')}</td>
          <td class="num">${money(o.amount)}</td>
          <td class="sub">${esc(o.status || '')}</td>
          <td><input class="bfIn" data-bf="${esc(String(o._id))}:channel" value="${esc(bfVal(o, 'channel'))}" placeholder="${miss.includes('channel') ? '待补' : ''}" list="bfTeams"></td>
          <td><input class="bfIn" data-bf="${esc(String(o._id))}:group" value="${esc(bfVal(o, 'group'))}" placeholder="${miss.includes('group') ? '待补' : ''}" style="min-width:110px"></td>
          <td><input type="date" class="bfIn" data-bf="${esc(String(o._id))}:draft" value="${esc(bfVal(o, 'draft'))}"></td>
          <td><input type="date" class="bfIn" data-bf="${esc(String(o._id))}:final" value="${esc(bfVal(o, 'final'))}"></td>
          <td class="sub">${dirty.length ? '<span class="dft">待写 ' + dirty.map(k => BF_LABEL[k]).join('/') + '</span>' : (miss.length ? '<span class="miss">缺 ' + miss.map(k => BF_LABEL[k]).join('/') + '</span>' : '<span style="color:#15803d">齐</span>')}</td></tr>`;
      }).join('')}</tbody></table>
      <datalist id="bfTeams">${UP.map(u => `<option value="${esc(u.team)}"></option>`).join('')}</datalist>`;
  }

  function bindBackfill() {
    $('#bfOnly').onclick = () => { BFONLY = !BFONLY; SEL.clear(); paintBackfill(); };
    $('#bfAll').onclick = () => { BFALL = !BFALL; paintBackfill(); };
    $$('#bfBox [data-grp]').forEach(b => b.onclick = e => {
      e.preventDefault(); e.stopPropagation();          // 别一点全选就把整组折叠起来
      // 只勾这一组里【显示出来】的行：按 LED 筛会把被「只看还缺的」隐掉的行也选进去，
      // 他会看见「已勾 37」而表上只有 35 行，然后批量写到没检查过的单上
      const det = b.closest('details');
      $$('[data-sel]', det).forEach(x => { x.checked = true; SEL.add(x.dataset.sel); });
      paintSelN();
    });
    $('#bfSelAll').onclick = () => { $$('#bfBox [data-sel]').forEach(x => { x.checked = true; SEL.add(x.dataset.sel); }); paintSelN(); };
    $('#bfSelNo').onclick = () => { SEL.clear(); $$('#bfBox [data-sel]').forEach(x => x.checked = false); paintSelN(); };
    $$('#bfBox [data-sel]').forEach(x => x.onchange = () => { x.checked ? SEL.add(x.dataset.sel) : SEL.delete(x.dataset.sel); paintSelN(); });
    $$('#bfBox [data-bf]').forEach(i => i.onchange = () => {
      const [id, k] = i.dataset.bf.split(':');
      const o = LED.find(x => String(x._id) === id); if (!o) return;
      const v = i.value.trim();
      DRAFT[id] = DRAFT[id] || {};
      if (v === bfLive(o, k)) delete DRAFT[id][k]; else DRAFT[id][k] = v;
      if (!Object.keys(DRAFT[id]).length) delete DRAFT[id];
      LS.write(LS_DRAFT, DRAFT);
      PREV.jf = null;                 // 草稿又变了，旧预览作废，免得拿着过期对照表去点写入
      paintBackfill(); paintHead();
    });
    const teams = [...new Set(UP.map(u => u.team).filter(Boolean))];
    $('#bCh').innerHTML = '<option value="">（不改渠道）</option>' + teams.map(t => `<option>${esc(t)}</option>`).join('');
    $('#bfApply').onclick = applyBatch;
    $('#bfPrev').onclick = () => runPreview();
    $('#bfDrop').onclick = () => {
      if (!draftCount()) return toast('没有待写入的草稿');
      if (!confirm('丢弃全部草稿？（还没写库的改动会没掉；台账本来就一行没动）')) return;
      DRAFT = {}; LS.write(LS_DRAFT, DRAFT); PREV.jf = null; paintBackfill(); paintHead();
    };
    $('#bfDerive').onclick = runDerive;
    $('#bfAutoChan').onclick = autoChan;
    $('#bfAutoDue').onclick = autoDue;
    if (UNDO.jf && $('#bfUndo')) $('#bfUndo').onclick = () => undoPatches('jf');
    paintSelN();
  }
  function paintSelN() { const el = $('#bfSelN'); if (el) el.textContent = `已勾 ${SEL.size} 单`; }

  // 【v27.4】一键整理：不勾行，自动挑还缺的单，走同一套 预览→写入→撤销
  async function previewDirect(patches, label) {
    $('#bfPrevBox').innerHTML = '<div class="sub">正在算 ' + patches.length + ' 单会补什么（只预览，一行没写）…</div>';
    try {
      PREV.jf = await patchPreview(CH.jf, patches, true);   // onlyEmpty：只补空的，不碰已填的
      paintBfPrev();
      toast(label + '：' + patches.length + ' 单待补，看下面预览，确认才写库');
    } catch (e) { $('#bfPrevBox').innerHTML = '<div class="sub">预览失败：' + esc(e.message || String(e)) + '</div>'; }
  }
  async function autoChan() {
    const patches = [];
    LED.forEach(o => {
      if (String(o.channel || '').trim()) return;
      const w = String(o.writer || '').trim();
      const hit = UP.find(u => u.person && w && (w.includes(u.person) || u.person.includes(w)));
      const team = hit ? hit.team : (w ? (UP.find(u => !u.person) || {}).team : '');
      if (team) patches.push({ id: String(o._id), fields: { channel: team } });
    });
    if (!patches.length) return toast('没有可补渠道的单：要么都填了，要么派单员认不出渠道（先在渠道设置里配派单员）');
    await previewDirect(patches, '按派单员补渠道');
  }
  async function autoDue() {
    const patches = [];
    LED.forEach(o => {
      const base = String(o.draftStart || o.date || '').slice(0, 10);
      if (!isDate(base)) return;
      const u = upOf(String(o.channel || '').trim());
      const f = {};
      if (!String(o.draft || '').trim()) f.draft = dadd(base, numOr(u.dueDraft, DEF_DUE.draft));
      if (!String(o.final || '').trim()) f.final = dadd(base, numOr(u.dueFinal, DEF_DUE.final));
      if (Object.keys(f).length) patches.push({ id: String(o._id), fields: f });
    });
    if (!patches.length) return toast('没有可补交期的单（初/终稿都填了，或没有接单日）');
    await previewDirect(patches, '按接单日补初/终稿');
  }

  // 批量只写进草稿，不直接碰库：让「预览」成为写库前唯一那道门
  function applyBatch() {
    if (!SEL.size) return toast('先在行首勾选要批量处理的单');
    const ch = $('#bCh').value, gp = $('#bGp').value.trim();
    const dd = Number($('#bDd').value), df = Number($('#bDf').value);
    const ov = $('#bOv').checked;
    if (!ch && !gp && !(dd > 0) && !(df > 0)) return toast('渠道/群名/初稿天数/终稿天数至少填一项');
    let n = 0, skip = 0;
    SEL.forEach(id => {
      const o = LED.find(x => String(x._id) === id);
      if (!o) { skip++; return; }
      const put = (k, v) => {
        if (!v) return;
        const cur = bfLive(o, k);
        if (cur && !ov) { skip++; return; }
        if (cur === v) return;
        DRAFT[id] = DRAFT[id] || {}; DRAFT[id][k] = v;
      };
      const base = String(o.date || '').slice(0, 10);
      if (ch) put('channel', ch);
      if (gp) put('group', gp);
      if (dd > 0 && isDate(base)) put('draft', dadd(base, dd));
      if (df > 0 && isDate(base)) put('final', dadd(base, df));
      n++;
    });
    Object.keys(DRAFT).forEach(id => { if (!Object.keys(DRAFT[id] || {}).length) delete DRAFT[id]; });
    LS.write(LS_DRAFT, DRAFT);
    PREV.jf = null;
    paintBackfill(); paintHead();
    toast(`已写进草稿 ${n} 单${skip ? `（跳过 ${skip} 处：已有值且没勾「覆盖已填的」）` : ''}　下一步点「预览改动」`);
  }

  // 预览 → 写入 → 撤销：两条通道（新字段 / 派单员）共用一套流程，差别只在走哪个端点、快照存哪个键
  async function patchPreview(ch, patches, onlyEmpty) {
    const j = await api(ch.path, { method: 'POST', body: JSON.stringify({ patches, apply: false, onlyEmpty }) });
    return { ch, j, patches, onlyEmpty };
  }

  function prevBlock(tag, p) {
    const j = p.j, rows = j.rows || [];
    return `<details class="bk ${rows.length ? 'info' : 'quiet'}" open><summary>预览 ${esc(p.ch.label)}：<b>${rows.length}</b> 单将要写入（共 ${rows.reduce((t, r) => t + (r.changed || []).length, 0)} 处）${j.skippedCount ? ' · 跳过 ' + j.skippedCount + ' 处' : ''}${j.badCount ? ' · 格式不对 ' + j.badCount + ' 处' : ''}</summary><div class="bkb">
      ${rows.length ? `<div class="row2"><button class="btn p" data-pw="${tag}">确认写入台账（${rows.length} 单）</button>
        <button class="btn g" data-pdrop="${tag}">丢弃这次预览</button>
        <span class="sub">一单一单写，写完留快照可撤销。${j.onlyEmpty ? '这次是「不覆盖」：已有值的字段服务端直接跳过。' : '这次勾了「覆盖已填的」。'}</span></div>
        <table><thead><tr><th>单号</th><th>接单日</th><th>状态</th><th>改哪些</th><th>现在</th><th>将要</th></tr></thead>
        <tbody>${rows.slice(0, 120).map(r => `<tr><td class="mono">${esc(r.orderNo || '—')}</td><td class="sub">${esc(r.date || '')}</td><td class="sub">${esc(r.status || '')}</td>
          <td>${esc((r.labels || []).join('、'))}</td>
          <td class="sub">${esc((r.changed || []).map(k => ((r.before || {})[k] || '（空）')).join(' / '))}</td>
          <td><b>${esc((r.changed || []).map(k => ((r.after || {})[k] || '（清空）')).join(' / '))}</b></td></tr>`).join('')}</tbody></table>
        ${rows.length > 120 ? '<div class="sub">只列前 120 行，写入是全部 ' + rows.length + ' 行。</div>' : ''}`
        : '<div class="empty">没有可写入的改动：要么值本来就一样，要么都被「不覆盖」挡住了。</div>'}
      ${j.capped ? '<div class="est">一次最多 600 单，这次被截断了，请分批写。</div>' : ''}
      ${(j.bad || []).length ? '<div class="dup bad">格式不对：' + esc(j.bad.map(x => x.field + '「' + x.value + '」').join('；')) + '</div>' : ''}
      ${(j.skipped || []).length ? '<div class="sub" style="margin-top:6px">跳过（前 20 条）：' + esc(j.skipped.slice(0, 20).map(s => (s.orderNo || s.id || '') + ' ' + s.why).join('　|　')) + '</div>' : ''}
      </div></details>`;
  }

  // 预览表上的按钮都在重绘出来的 DOM 里，统一在这里挂：data-pw=写入，data-pdrop=丢弃
  function bindPrev(root) {
    $$('[data-pw]', root).forEach(b => b.onclick = () => writePatches(b.dataset.pw));
    $$('[data-pdrop]', root).forEach(b => b.onclick = () => {
      PREV[b.dataset.pdrop] = null;
      b.dataset.pdrop === 'jf' ? paintBackfill() : paintFull();
    });
  }

  async function writePatches(tag) {
    const p = PREV[tag];
    if (!p) return toast('先预览');
    const rows = p.j.rows || [];
    if (!rows.length) return toast('预览里没有可写的行');
    if (!confirm('确认写入台账？\n\n' + rows.length + ' 单 · ' + rows.reduce((t, r) => t + (r.changed || []).length, 0) + ' 处\n只改「' + p.ch.label + '」；金额 / 状态 / 备注 / 完单日 / 单号 / 接单日 / 分成一律不动。')) return;
    try {
      const j = await api(p.ch.path, { method: 'POST', body: JSON.stringify({ patches: p.patches, apply: true, onlyEmpty: p.onlyEmpty }) });
      const done = (j.rows || []).filter(r => r.wrote);
      if (done.length) {   // 快照：存这次真正改动的键的旧值，撤销按旧值写回（原来空着就清成空）
        UNDO[tag] = { at: new Date().toISOString(), label: p.ch.label, rows: done.map(r => ({ id: r.id, orderNo: r.orderNo, before: r.before, changed: r.changed })) };
        LS.write(p.ch.ls, UNDO[tag]);
      }
      if (tag === 'jf') {
        done.forEach(r => { delete DRAFT[r.id]; });
        Object.keys(DRAFT).forEach(id => { if (!Object.keys(DRAFT[id] || {}).length) delete DRAFT[id]; });
        LS.write(LS_DRAFT, DRAFT);
      }
      PREV[tag] = null;
      toast('已写入 ' + done.length + ' 单' + (j.skippedCount ? '，跳过 ' + j.skippedCount + ' 处' : ''));
      await loadLedger(true);
      if (FULL) await runFull(true);
    } catch (e) { toast('写入失败：' + (e.message || e) + '（可能只写进去一部分，展开台账核对一下）'); }
  }

  async function undoPatches(tag) {
    const u = UNDO[tag];
    if (!u || !(u.rows || []).length) return toast('没有上一批记录');
    const patches = u.rows.map(r => ({ id: r.id, fields: Object.fromEntries((r.changed || []).map(k => [k, (r.before || {})[k] || ''])) }));
    if (!confirm('把上一批「' + (u.label || '') + '」' + patches.length + ' 单改回写入前的值？\n\n原来空着的会改回空。')) return;
    try {
      const j = await api(CH[tag].path, { method: 'POST', body: JSON.stringify({ patches, apply: true, onlyEmpty: false }) });
      UNDO[tag] = null; try { localStorage.removeItem(CH[tag].ls); } catch (e) { }
      toast('已回退 ' + (j.wrote || 0) + ' 单');
      await loadLedger(true);
      if (FULL) await runFull(true);
    } catch (e) { toast('回退失败：' + (e.message || e)); }
  }

  async function runPreview() {
    const patches = bfPatches();
    if (!patches.length) return toast('没有待写入的改动');
    const ov = $('#bOv') ? $('#bOv').checked : false;
    $('#bfPrevBox').innerHTML = '<div class="sub">正在算这 ' + patches.length + ' 单会改成什么（只是预览，一行都没写）…</div>';
    try {
      PREV.jf = await patchPreview(CH.jf, patches, !ov);
      paintBfPrev();
    } catch (e) { $('#bfPrevBox').innerHTML = '<div class="sub">预览失败：' + esc(e.message || String(e)) + '</div>'; }
  }

  function paintBfPrev() {
    const box = $('#bfPrevBox');
    if (!box) return;
    box.innerHTML = PREV.jf ? prevBlock('jf', PREV.jf) : '';
    bindPrev(box);
  }

  // 「我不是可以导出别处的数据吗」：粘的表 / 几何拉取里带的渠道、群名，直接带成台账缺的字段
  async function runDerive() {
    const sources = reconSources();
    if (!sources) return;
    $('#bfPrevBox').innerHTML = '<div class="sub">正在从上游数据里挑台账还缺的字段…</div>';
    try {
      const j = await api('/api/upstream/derive', { method: 'POST', body: JSON.stringify({ sources }) });
      const c = j.candidates || [];
      if (!c.length) { $('#bfPrevBox').innerHTML = '<div class="empty">这批上游没带出台账还缺的字段（渠道列没识别出来，或已经填过了）。可以在对账那折里改列映射再试。</div>'; return; }
      let n = 0;
      c.forEach(x => {
        DRAFT[x.id] = DRAFT[x.id] || {};
        Object.entries(x.fill || {}).forEach(([k, v]) => { if (!DRAFT[x.id][k]) { DRAFT[x.id][k] = v; n++; } });
      });
      LS.write(LS_DRAFT, DRAFT);
      PREV.jf = null;
      paintBackfill();
      await runPreview();
      toast('从上游带出 ' + c.length + ' 单、' + n + ' 处字段，已进草稿并算好预览（还没写库）');
    } catch (e) { $('#bfPrevBox').innerHTML = '<div class="sub">带出失败：' + esc(e.message || String(e)) + '</div>'; }
  }

  /* ============ 完整单子 · 全量整理：台账全部老单 × 上游两侧并排 ============ */
  // 他要的是"先把老单子全部整理"，所以这张表不是差异清单，是总账：每单一行，两侧都在，缺什么一目了然。
  // 派单员三处各有一份（台账 writer / 金山「A订单负责人-钦钦」/ 几何 designer_name），这里并排给出来，
  // 搬运只走 /api/orders/writer-patch；分成比例故意只列出不写（45% 与自留 100% 的口径还没定）。
  const FLAG_LABEL = { personBad: '两边派单员不一致', rateBad: '比例≠这批众数', statusBad: '状态与上游不一致', amtBad: '金额差>1元' };
  const FCHIPS = [
    ['all', '全部'], ['miss', '还缺东西的'], ['channel', '缺渠道'], ['group', '缺群名'],
    ['draft', '缺初稿'], ['final', '缺终稿'], ['writer', '缺派单员'],
    ['up', '上游有这单'], ['noUp', '这批上游没这单'], ['flag', '两侧对不上的'], ['noKey', '台账没单号的'],
    ['migLed', '台账有 · 这批没有'], ['migUp', '这批有 · 台账没录'], ['migOut', '区间外 · 判不了'],
    ['manual', '手工号（自动对不上）'], ['noteAmt', '金额 0 · 备注里有数'],
  ];
  // 迁移要的就是"谁有谁没有"：MIGV 把筛子对上服务端算出来的那几堆
  const MIGV = { migLed: 'ledOnly', migUp: 'upOnly', migOut: 'outSpan', manual: 'manualNo', noteAmt: 'noteAmt' };
  const SUG_LABEL = { channel: '渠道', group: '群名', draft: '初稿', final: '终稿', writer: '派单员' };

  function fullFilter() {
    const rows = (FULL && FULL.rows) || [];
    const kw = FQ.trim().toLowerCase();
    // 「台账有 · 这批没有」服务端已经算好（且只在批次覆盖的日期区间内判），这里照形状接进来，批量补建议仍能用
    const base = FVIEW === 'migLed' ? ((FULL.migrate || {}).ledOnly || []) : rows;
    return base.filter(r => {
      if (FVIEW === 'all' || FVIEW === 'migLed') { /* 不再加条件 */ }
      else if (FVIEW === 'miss') { if (!(r.miss.length || !r.writer)) return false; }
      else if (FVIEW === 'channel' || FVIEW === 'group' || FVIEW === 'draft' || FVIEW === 'final') { if (!r.miss.includes(FVIEW)) return false; }
      else if (FVIEW === 'writer') { if (r.writer) return false; }
      else if (FVIEW === 'up') { if (!r.up) return false; }
      else if (FVIEW === 'noUp') { if (r.up) return false; }
      else if (FVIEW === 'flag') { if (!r.flags.length) return false; }
      else if (FVIEW === 'noKey') { if (r.no) return false; }
      if (kw && ![r.no, r.writer, r.group, r.note, r.channel, (r.up || {}).person || ''].some(x => String(x || '').toLowerCase().includes(kw))) return false;
      return true;
    });
  }

  // 迁移专用小表：这几堆不是"台账的一行"，形状各不一样，硬塞进主表只会误导
  function migHtml(key, mg) {
    const kw = FQ.trim().toLowerCase();
    const hit = r => !kw || Object.keys(r).some(k => String(r[k] || '').toLowerCase().includes(kw));
    const head = (cols) => `<table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
    const td = v => `<td class="sub">${v === '' || v === undefined || v === null ? '—' : esc(v)}</td>`;
    if (key === 'migUp') {
      const arr = (mg.upOnly || []).filter(hit);
      return `<div class="sub" style="margin-bottom:6px">这批上游给了、但<b>你台账里查不到这个号</b>：${arr.length} 行。要么漏录，要么上游那格写的号本身不对（一格塞多号 / 手工号）。<b>我不替你录</b>：点「拿去录一单」把它填进记一单，你核对完再存。</div>`
        + head(['单号', '来源', '订单金额', '已发/佣金', '上游状态', '负责人', '群名', '接单日', '上游自己就异常', '操作'])
        + `<tbody>${arr.slice(0, 200).map(x => `<tr><td class="mono">${esc(x.raw || x.no || '（没给号）')}</td>${td(x.src)}${td(x.amount)}${td(x.paid)}${td(x.status)}${td(x.person)}${td(x.group)}${td(x.takeDate)}${td(x.odd)}<td>${x.no ? `<button class="btn sm g" data-newone="${esc(JSON.stringify({ no: x.no, amount: x.amount, src: x.src, person: x.person }))}">拿去录一单</button>` : ''}</td></tr>`).join('')}</tbody></table>`
        + (arr.length > 200 ? `<div class="sub">只列前 200 行，共 ${arr.length} 行。</div>` : '');
    }
    if (key === 'migOut') {
      const arr = (mg.outSpan || []).filter(hit);
      const sp = mg.span || {};
      return `<div class="sub" style="margin-bottom:6px">这些单的接单日<b>在这批表覆盖区间（${esc(sp.from || '?')} ~ ${esc(sp.to || '?')}）之外</b>，所以"这批没有"根本判不了 —— 不是漏录，是人家表里本来就没这个月。要判就粘那个月的表进来。</div>`
        + head(['接单日', '单号', '金额', '状态']) + `<tbody>${arr.slice(0, 200).map(r => `<tr>${td(r.date)}<td class="mono">${esc(r.no || '—')}</td>${td(r.amount)}${td(r.status)}</tr>`).join('')}</tbody></table>`
        + (arr.length > 200 ? `<div class="sub">共 ${arr.length} 单，只列前 200。</div>` : '');
    }
    if (key === 'manual') {
      const arr = (mg.manualNo || []).filter(hit);
      return `<div class="sub" style="margin-bottom:6px">订单编号<b>不是纯数字</b>的那些行（微信：LM003415 这类手工号）：自动匹配永远碰不到上游，只能人工认。它们不该被算进"上游没这单"。</div>`
        + head(['接单日', '单号（手工）', '金额', '状态', '备注']) + `<tbody>${arr.slice(0, 200).map(r => `<tr>${td(r.date)}<td class="mono">${esc(r.no)}</td>${td(r.amount)}${td(r.status)}${td(r.note)}<td><button class="btn sm g" data-goto="${esc(r.no)}">在台账里看</button></td></tr>`).join('')}</tbody></table>`;
    }
    if (key === 'noteAmt') {
      const arr = (mg.noteAmt || []).filter(hit);
      return `<div class="sub" style="margin-bottom:6px">台账金额录成 <b>0</b>、真实数字写在<b>备注</b>里的那些行（你样例里的 1000 / 50 / 840）。金额是钱、也是红线，<b>这里只列出来，不批量改</b>；要改就逐单在台账里编辑。</div>`
        + head(['接单日', '单号', '状态', '备注原文', '备注里的数']) + `<tbody>${arr.slice(0, 200).map(r => `<tr>${td(r.date)}<td class="mono">${esc(r.no || '—')}</td>${td(r.status)}${td(r.note)}<td><b>${esc(r.inNote)}</b></td><td><button class="btn sm g" data-goto="${esc(r.no)}">去台账改</button></td></tr>`).join('')}</tbody></table>`;
    }
    return '';
  }

  async function runFull(keep) {
    const sources = reconSources();
    if (!sources) return;
    FBUSY = '正在翻台账全量并合并上游…'; paintFull();
    try {
      const j = await api('/api/upstream/full', { method: 'POST', body: JSON.stringify({ sources, dueDraft: DEF_DUE.draft, dueFinal: DEF_DUE.final }) });
      FULL = j;
      if (!keep) { FSEL = new Set(); FPAGE = 0; }
      FBUSY = '';
      paintFull();
      toast('完整单子：台账 ' + j.scanned + ' 单，其中 ' + j.stats.withUp + ' 单在这批上游里');
      const mg = j.migrate || {};
      saveArchive('full', {
        name: j.sources.map(s => s.src).join('+') || '完整单子', sources: j.sources, stats: j.stats,
        counts: { ledOnly: mg.ledOnlyN || 0, upOnly: mg.upOnlyN || 0, manualNo: mg.manualNoN || 0, noteAmt: mg.noteAmtN || 0 },
        span: mg.span || null, rateMode: j.rateMode || null,
      });
    } catch (e) { FBUSY = e.message || String(e); paintFull(); }
  }

  function paintFull() {
    const out = $('#fOut'), stats = $('#fStats'), bar = $('#fBar');
    if (!out) return;
    if (FBUSY) { out.innerHTML = '<div class="empty">' + esc(FBUSY) + '</div>'; bar.style.display = 'none'; return; }
    if (!FULL) {
      out.innerHTML = '<div class="empty">还没拉。上面勾好来源（几何拉取 / 粘贴表格），点「拉全量并合并」。<br>这张表是<b>台账全部老单</b>一行一单，不是只列差异 —— 服务端翻页读，不吃列表接口那个 500 上限。</div>';
      stats.innerHTML = ''; bar.style.display = 'none'; $('#fPrevBox').innerHTML = '';
      return;
    }
    const s = FULL.stats, mc = FULL.missCnt, mg = FULL.migrate || {};
    const chipN = k => k === 'all' ? s.total : (MIGV[k] ? (mg[MIGV[k] + 'N'] !== undefined ? mg[MIGV[k] + 'N'] : (mg[MIGV[k]] || []).length) : null);
    stats.innerHTML = FCHIPS.map(([k, n]) => {
      const c = chipN(k);
      return `<button class="chip${FVIEW === k ? ' on' : ''}" data-fv="${k}">${n}${c === null ? '' : '（' + c + '）'}</button>`;
    }).join('');
    const rm = Object.entries(FULL.rateMode || {});
    $('#fBusy').innerHTML = `<span class="tag">台账 ${s.total} 单 · 上游有 ${s.withUp} · 这批没有 ${s.noUp} · 跨源重复 ${s.crossDup}</span>`
      + `<span class="tag">缺：渠道 ${mc.channel} · 群名 ${mc.group} · 初稿 ${mc.draft} · 终稿 ${mc.final} · 派单员 ${mc.writer}</span>`
      + `<span class="tag">对不上：派单员 ${s.personBad} · 比例 ${s.rateBad} · 状态 ${s.statusBad} · 金额 ${s.amtBad}</span>`
      + rm.map(([k, v]) => `<span class="tag">${esc(k)} 这批分成比例众数 = <b>${v.rate}%</b>（${v.n}/${v.of} 行）</span>`).join('')
      + (FULL.truncated ? '<span class="est">台账超过 1 万单，这里只翻了前 1 万</span>' : '');

    // 迁移那几堆形状各不相同，走专用小表；批量按钮对它们没意义（「台账有·这批没有」本来就是台账行，仍走主表）
    if (MIGV[FVIEW] && FVIEW !== 'migLed') {
      bar.style.display = '';
      bar.innerHTML = `<b>${esc((FCHIPS.find(c => c[0] === FVIEW) || ['', '迁移对照'])[1])}</b><span class="sub">这一堆只用来认账，不改数据；要批量补字段请切回「全部 / 还缺东西的」</span>`;
      out.innerHTML = migHtml(FVIEW, mg);
      $('#fPrevBox').innerHTML = '';
      $$('#fStats [data-fv]').forEach(x => x.onclick = () => { FVIEW = x.dataset.fv; FPAGE = 0; paintFull(); });
      $$('#fOut [data-goto]').forEach(x => x.onclick = () => gotoLedger(x.dataset.goto));
      $$('#fOut [data-newone]').forEach(x => x.onclick = () => prefillNew(JSON.parse(x.dataset.newone)));
      return;
    }

    const rows = fullFilter();
    const pages = Math.max(1, Math.ceil(rows.length / 100));
    if (FPAGE >= pages) FPAGE = pages - 1;
    const view = rows.slice(FPAGE * 100, FPAGE * 100 + 100);
    bar.style.display = '';
    bar.innerHTML = `<b>批量按建议补</b>
      <span class="sub">只填台账空着的位置，已有值的一律不动；先预览再写，写完能撤销</span>
      <span class="grow"></span>
      <button class="btn sm g" id="fSelAll">全选这批 ${rows.length} 单</button>
      <button class="btn sm g" id="fSelNo">清空勾选</button>
      <span class="sub" id="fSelN"></span>
      <button class="btn g" id="fSugJf">按建议补「渠道/群名/初稿/终稿」</button>
      <button class="btn g" id="fSugW">把上游派单员搬进台账</button>
      ${UNDO.w ? `<button class="btn g" id="fUndoW">撤销上一批派单员（${(UNDO.w.rows || []).length} 单）</button>` : ''}`;

    out.innerHTML = `<table><thead><tr><th style="width:34px">选</th><th>接单日</th><th>单号</th><th class="num">金额</th><th class="num">比例</th><th class="num">分成</th><th>状态</th><th>派单员(台账)</th><th>上游侧</th><th>渠道</th><th>群名</th><th>初稿</th><th>终稿</th><th>问题</th><th>建议补</th></tr></thead>
      <tbody>${view.length ? view.map(r => {
        const up = r.up ? `${esc(r.up.src)} ${money(r.up.amount)}元${r.up.paid && r.up.paid !== r.up.amount ? ' · 发 ' + money(r.up.paid) : ''}${r.up.person ? ' · ' + esc(r.up.person) : ''}${r.up.status ? ' · ' + esc(r.up.status) : ''}` : '<span class="miss">这批没有</span>';
        const flags = r.flags.map(f => `<span class="tag" style="background:#fef3c7;color:#b45309">${esc(FLAG_LABEL[f] || f)}</span>`).join('')
          + (r.srcs.length > 1 ? `<span class="tag" style="background:#fee2e2;color:#b91c1c">跨源 ${esc(r.srcs.join('+'))}</span>` : '')
          + (!r.no ? '<span class="tag" style="background:#fee2e2;color:#b91c1c">没单号</span>' : '');
        const sug = Object.entries(r.suggest || {}).map(([k, v]) => `<span class="tag">${esc(SUG_LABEL[k])}=${esc(v)}</span>`).join('') || '<span class="miss">—</span>';
        const cell = (k, v) => v ? esc(v) : '<span class="miss">缺</span>';
        return `<tr${r.miss.length || !r.writer ? '' : ' class="done-row"'}>
          <td><input type="checkbox" data-fsel="${esc(r.id)}"${FSEL.has(r.id) ? ' checked' : ''}></td>
          <td class="sub">${esc(r.date)}</td><td class="mono">${esc(r.no || '—')}</td>
          <td class="num">${money(r.amount)}</td><td class="num">${r.rate}%</td><td class="num">${money(r.share)}</td>
          <td class="sub">${esc(r.status)}</td>
          <td>${r.writer ? esc(r.writer) : '<span class="miss">缺</span>'}</td>
          <td class="sub">${up}</td>
          <td>${cell('channel', r.channel)}</td><td>${cell('group', r.group)}</td>
          <td>${cell('draft', r.draft)}</td><td>${cell('final', r.final)}</td>
          <td>${flags || '<span class="miss">—</span>'}</td>
          <td>${sug}</td></tr>`;
      }).join('') : '<tr><td colspan="15" class="sub" style="padding:12px">这批筛选下没有单。</td></tr>'}</tbody></table>
      <div class="row2" style="margin-top:8px">
        <button class="btn sm g" id="fPrevPg" ${FPAGE ? '' : 'disabled'}>‹ 上一页</button>
        <span class="sub">第 ${FPAGE + 1} / ${pages} 页（每页 100 行，共 ${rows.length} 单）</span>
        <button class="btn sm g" id="fNextPg" ${FPAGE + 1 < pages ? '' : 'disabled'}>下一页 ›</button>
        <span class="sub">一次只画 100 行是给眼睛看的，批量勾选和写入按<b>全部筛选结果</b>算，不受这一页限制。</span>
      </div>`;
    $('#fPrevBox').innerHTML = PREV.jf ? prevBlock('jf', PREV.jf) : PREV.w ? prevBlock('w', PREV.w) : '';
    bindPrev($('#fPrevBox'));
    bindFull(rows);
  }

  function bindFull(rows) {
    $$('#fStats [data-fv]').forEach(b => b.onclick = () => { FVIEW = b.dataset.fv; FPAGE = 0; paintFull(); });
    $('#fSelAll').onclick = () => { rows.forEach(r => FSEL.add(r.id)); paintFull(); };
    $('#fSelNo').onclick = () => { FSEL = new Set(); paintFull(); };
    $$('#fOut [data-fsel]').forEach(x => x.onchange = () => { x.checked ? FSEL.add(x.dataset.fsel) : FSEL.delete(x.dataset.fsel); paintSelN2(); });
    $('#fPrevPg').onclick = () => { FPAGE--; paintFull(); };
    $('#fNextPg').onclick = () => { FPAGE++; paintFull(); };
    $('#fSugJf').onclick = () => previewSuggest('jf');
    $('#fSugW').onclick = () => previewSuggest('writer');
    if (UNDO.w && $('#fUndoW')) $('#fUndoW').onclick = () => undoPatches('w');
    paintSelN2();
  }
  function paintSelN2() { const el = $('#fSelN'); if (el) el.textContent = `已勾 ${FSEL.size} 单`; }

  // 「建议」是服务端算出来的（渠道=来源名、群名/派单员=上游那格、交期=接单+N），这里只负责把它变成补丁
  function suggestPatches(kind) {
    const out = [];
    fullFilter().forEach(r => {
      if (!FSEL.has(r.id)) return;
      const f = {};
      if (kind === 'jf') ['channel', 'group', 'draft', 'final'].forEach(k => { if (r.suggest[k]) f[k] = r.suggest[k]; });
      else if (r.suggest.writer) f.writer = r.suggest.writer;
      if (Object.keys(f).length) out.push({ id: r.id, fields: f });
    });
    return out;
  }
  async function previewSuggest(kind) {
    const tag = kind === 'writer' ? 'w' : 'jf';
    if (!FSEL.size) return toast('先勾选要处理的单');
    const patches = suggestPatches(kind);
    if (!patches.length) return toast('这批里没有可带的建议：要么台账已经有值，要么这批上游没给这一项');
    $('#fPrevBox').innerHTML = '<div class="sub">正在算这 ' + patches.length + ' 单会改成什么（只是预览，一行都没写）…</div>';
    try {
      PREV[tag] = await patchPreview(CH[tag], patches, true);   // 这条路上只Empty=true：建议永远不覆盖已有值
      paintFull();
    } catch (e) { $('#fPrevBox').innerHTML = '<div class="sub">预览失败：' + esc(e.message || String(e)) + '</div>'; }
  }

  /* ============ 批次档案：切个窗口不该把粘了半天的表弄丢 ============ */
  let ARCHIVES = [];
  async function loadArchives() {
    try { const j = await api('/api/upstream/batches'); ARCHIVES = j.batches || []; paintArchives(); } catch (e) { /* 读不到档案不影响对账本身，别在这里报错吓人 */ }
  }
  function paintArchives() {
    const sel = $('#archSel');
    if (!sel) return;
    sel.innerHTML = ARCHIVES.length ? ARCHIVES.map(a => `<option value="${esc(a.id)}">${esc(String(a.at || '').slice(0, 16).replace('T', ' '))} · ${esc(a.name)} · ${a.kind === 'full' ? '完整单子' : '对账'} · ${(a.sources || []).reduce((t, s) => t + (s.rows || 0), 0)} 行 · ${Math.round((a.bytes || 0) / 1024)}KB</option>`).join('')
      : '<option value="">（还没有档案）</option>';
    const n = $('#archN');
    if (n) n.textContent = ARCHIVES.length ? `共 ${ARCHIVES.length} 批 · 只留最近 60 批 · 原文在你自己的库里，不在代码仓库` : '';
  }
  function bucketCounts(b) {
    const o = {};
    Object.keys(b || {}).forEach(k => { if (Array.isArray(b[k])) o[k] = b[k].length; });
    return o;
  }
  async function saveArchive(kind, meta) {
    const texts = [];
    if ($('#rPaste') && $('#rPaste').checked && $('#rText').value.trim()) texts.push($('#rText').value);
    try {
      const j = await api('/api/upstream/batch', {
        method: 'POST', body: JSON.stringify({
          name: meta.name || ($('#rName') ? $('#rName').value.trim() : '') || (kind === 'full' ? '完整单子' : '对账'),
          kind, sources: meta.sources || [], stats: meta.stats || null, counts: meta.counts || null,
          span: meta.span || null, rateMode: meta.rateMode || null, texts,
        }),
      });
      ARCHIVES.unshift({ id: j.id, at: new Date().toISOString(), name: meta.name || '这批', kind, sources: meta.sources || [], bytes: j.bytes || 0 });
      paintArchives();
      toast(j.removed ? '已存档案（顺手清掉超期的 ' + j.removed + ' 批）' : '已存档案，切窗口不会再丢');
    } catch (e) { toast('档案没存上：' + (e.message || e)); }
  }
  async function useArchive(re) {
    const id = $('#archSel').value;
    if (!id) return toast('先在下拉里选一批档案');
    try {
      const j = await api('/api/upstream/batch?id=' + encodeURIComponent(id));
      const b = j.batch;
      // 来源勾法照这批存档时的样子还原：那批只粘了表就别再默认去连几何（会白等一次外网）
      const kinds = new Set((b.sources || []).map(s => s.kind));
      if (kinds.size) {
        $('#rJihe').checked = kinds.has('jihe');
        $('#rPaste').checked = kinds.has('paste');
        $('#rPaste').dispatchEvent(new Event('change'));
      }
      if (b.texts && b.texts.length) {
        $('#rPaste').checked = true; $('#rPaste').dispatchEvent(new Event('change'));
        $('#rText').value = b.texts.join('\n\n');
        if (b.name) $('#rName').value = b.name;
        toast('已回填这批原文（' + b.texts.join('').length + ' 字）' + (re ? '，开始重跑' : ''));
      } else toast('这批没有粘贴原文（是几何接口拉取的那批，本来就没有文本）');
      // 存的是完整单子那批就重跑完整单子，别拿对账那套去跑它
      if (re) b.kind === 'full' ? runFull(false) : runRecon();
    } catch (e) { toast('取不到这批档案：' + (e.message || e)); }
  }
  async function delArchive() {
    const id = $('#archSel').value;
    if (!id) return toast('先选要删的批次');
    if (!confirm('删掉这批档案？（只删档案，你台账一行没动）')) return;
    try {
      await api('/api/upstream/batch', { method: 'DELETE', body: JSON.stringify({ id }) });
      ARCHIVES = ARCHIVES.filter(a => a.id !== id);
      paintArchives();
      toast('已删掉这批档案');
    } catch (e) { toast('没删掉：' + (e.message || e)); }
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

  function reconSources() {
    const out = [];
    if ($('#rJihe').checked) out.push({ kind: 'jihe', account: $('#rAcc').value.trim() });
    if ($('#rPaste').checked) {
      const text = $('#rText').value;
      if (!text.trim()) { toast('勾了「粘贴的表格」但框里是空的'); return null; }
      out.push({ kind: 'paste', text, name: $('#rName').value.trim(), colmaps: COLMAPS.length ? COLMAPS : undefined });
    }
    if (!out.length) { toast('至少勾一个来源'); return null; }
    return out;
  }

  async function runRecon() {
    const sources = reconSources();
    if (!sources) return;
    $('#rBusy').textContent = '比对中…（几何那路要外连一次，几秒）';
    try {
      const j = await api('/api/upstream/match', { method: 'POST', body: JSON.stringify({ sources }) });
      RECON = j;
      $('#rBusy').textContent = '';
      renderRecon();
      toast('对完：配上 ' + j.matched + ' / ' + j.uniqueNo + ' 个单号');
      saveArchive('recon', { name: j.sources.map(s => s.src).join('+'), sources: j.sources, counts: bucketCounts(j.buckets), span: j.span });
    } catch (e) { $('#rBusy').textContent = ''; toast('对账失败：' + (e.message || e)); }
  }

  function saveAccount() {
    const v = $('#rAcc').value.trim();
    if (!/^\d{6,20}$/.test(v)) return toast('账号要是 6-20 位数字');
    api('/api/upstream/account', { method: 'POST', body: JSON.stringify({ account: v }) })
      .then(() => { toast('已存进服务端配置（不进代码、不进仓库）'); $('#rAccSaved').textContent = '已存'; })
      .catch(e => toast('没存上：' + (e.message || e)));
  }

  function rowHtml(x, kind) {
    const led = x.ledStatus
      ? `台账 ${x.ledStatus} · ${money(x.ledAmount)}×${x.ledRate || 0}% = ${money(x.ledShare)}`
      : (kind === 'missUp' ? `台账 ${x.ledStatus || ''} · ${money(x.ledAmount)}×${x.ledRate || 0}% = ${money(x.ledShare)}` : '台账没有这单');
    const up = x.src ? `${x.src}：订单 ${money(x.extAmount)}${x.extPaid ? ' · 已发 ' + money(x.extPaid) : ''}${x.extStatus ? ' · ' + x.extStatus : ''}` : '';
    // 【v26.93】表格里也带群名/派单员，没单号的行能拿去上游后台查
    const upMeta = [x.extGroup ? '群名 ' + x.extGroup : '', x.extPerson ? '派单员 ' + x.extPerson : ''].filter(Boolean).join(' · ');
    const tail = kind === 'amtBad' ? `差 ${x.diff > 0 ? '+' : ''}${money(x.diff)} 元`
      : kind === 'shareBad' ? `差 ${x.diff > 0 ? '+' : ''}${money(x.diff)} 元（台账分成 ${money(x.share)}）`
        : kind === 'dup' ? `台账里出现 ${x.count + 1} 次`
          : kind === 'multiNo' ? `这格是 ${(x.extNosText || '').replace(/、/g, ' , ')}` : '';
    return `<tr>
      <td class="mono">${esc(x.no || '（没单号）')}</td>
      <td>${esc(x.src || '—')}</td><td>${esc(up || '—')}${upMeta ? '<div class="sub">' + esc(upMeta) + '</div>' : ''}</td><td>${esc(led)}${x.ledDate ? ' · 接单 ' + esc(x.ledDate) : ''}</td>
      <td class="sub">${esc(tail)}</td>
      <td>${x.ledId ? `<button class="btn sm p" data-redit="${esc(x.ledId)}" data-rno="${esc(x.no || '')}">编辑</button>
        <button class="btn sm g" data-goto="${esc(x.no || '')}">定位</button>` : (x.no ? `<button class="btn sm g" data-rnew="${esc(x.no)}" data-ramt="${Number(x.extAmount) || 0}">录进台账</button>` : '')}
        ${x.no ? `<button class="btn sm g" data-copyno="${esc(x.no)}">复制</button>` : (x.extGroup ? `<button class="btn sm g" data-copyg="${esc(x.extGroup)}">复制群名</button>` : '')}</td></tr>`;
  }

  // 一单一卡：上游侧、台账侧并排，差异一句话，状态就在这张卡上改（改前先按单号取回整行，避免把备注/完单日写空）
  function reconCard(x, kind, cls) {
    const up = x.src ? `订单 <b>${money(x.extAmount)}</b> 元${x.extPaid ? ' · 已发 ' + money(x.extPaid) : ''}${x.extStatus ? ' · ' + esc(x.extStatus) : ''}${x.extDate ? ' · ' + esc(x.extDate) : ''}${x.raw ? '<div class="sub" style="margin-top:3px">原文：' + esc(String(x.raw).slice(0, 60)) + '</div>' : ''}` : '—';
    // 【v26.93】没单号的行要能拿去上游后台查：把群名/派单员/渠道带出来
    const meta = [x.extGroup ? '群名 ' + esc(x.extGroup) : '', x.extPerson ? '派单员 ' + esc(x.extPerson) : '', x.extTeam ? '渠道 ' + esc(x.extTeam) : ''].filter(Boolean).join(' · ');
    const led = x.ledId
      ? `${esc(x.ledStatus || '')} · ${money(x.ledAmount)} × ${x.ledRate || 0}% = <b>${money(x.ledShare)}</b>${x.ledDate ? ' · 接单 ' + esc(x.ledDate) : ''}${x.ledWriter ? ' · 派单员 ' + esc(x.ledWriter) : ''}`
      : (kind === 'missUp' ? `${esc(x.ledStatus || '')} · ${money(x.ledAmount)} × ${x.ledRate || 0}% = <b>${money(x.ledShare)}</b>` : '<span class="miss">台账没有这单</span>');
    const diff = kind === 'amtBad' ? `金额差 ${x.diff > 0 ? '+' : ''}${money(x.diff)} 元`
      : kind === 'shareBad' ? `到账比台账分成${x.diff > 0 ? '多' : '少'} ${money(Math.abs(x.diff))} 元`
        : kind === 'stBad' ? `状态：上游 ${esc(x.extStatus || '')} / 台账 ${esc(x.ledStatus || '')}`
          : kind === 'dup' ? `台账里这个号出现 ${x.count + 1} 次`
            : kind === 'multiNo' ? `这一格塞了多个号：${esc((x.extNosText || '').replace(/、/g, ' , '))}`
              : kind === 'odd' ? `上游自己就异常：${esc(x.odd || '')}`
                : kind === 'noKey' ? '上游这行没给单号：拿群名/派单员去几何后台查到单号，再回「记一单」录进来'
                  : kind === 'amtNoise' ? `只差 ${money(Math.abs(x.diff))} 元（录台账取整，一般不是错）` : '';
    const steps = x.ledId && x.no ? ST.map(s => `<button class="step${s === x.ledStatus ? ' hit' : ''}" data-rst="${esc(x.no)}" data-rid="${esc(x.ledId)}" data-to="${esc(s)}" title="把台账这单改成「${s}」">${s}</button>`).join('') : '';
    return `<div class="rcard ${cls}">
      <div class="rh"><span class="no">${esc(x.no || '（没单号）')}</span><span class="tag">${esc(x.src || '—')}</span>
        <span class="grow"></span>
        ${x.no ? `<button class="btn sm g" data-rdet="${esc(x.no)}">${RDET[x.no] ? '收起台账详情' : '查这单（就地）'}</button>` : ''}
        ${x.ledId ? `<button class="btn sm p" data-redit="${esc(x.ledId)}" data-rno="${esc(x.no || '')}">编辑</button>` : (x.no ? `<button class="btn sm g" data-rnew="${esc(x.no)}" data-ramt="${Number(x.extAmount) || 0}">录进台账</button>` : '')}
        ${!x.no && x.extGroup ? `<button class="btn sm g" data-copyg="${esc(x.extGroup)}">复制群名</button>` : ''}
        ${x.no ? `<button class="btn sm g" data-copyno="${esc(x.no)}">复制</button>` : ''}</div>
      <div class="r2"><div class="side">上游侧<br>${up}${meta ? '<div class="sub" style="margin-top:3px">' + meta + '</div>' : ''}</div><div class="side">台账侧<br>${led}</div></div>
      ${diff ? `<div class="rdiff ${kind === 'amtNoise' ? 'ok' : ''}">${diff}</div>` : ''}
      ${RDET[x.no] ? detHtml(x.no) : ''}
      ${steps ? `<div class="ract"><span class="sub">改台账状态：</span>${steps}</div>` : ''}
    </div>`;
  }

  // 就地检索：直接在本屏按单号取台账整行，不用切面板再搜一遍
  function detHtml(no) {
    const d = RDET[no];
    if (d.loading) return '<div class="rdet">查台账中…</div>';
    if (d.err) return '<div class="rdet">查不到：' + esc(d.err) + '</div>';
    if (!d.rows.length) return '<div class="rdet">台账里没有单号 ' + esc(no) + ' —— 这单还没录。</div>';
    return `<div class="rdet">台账里 ${d.rows.length} 行命中 ${esc(no)}：
      <table><thead><tr><th>接单日</th><th>单号</th><th class="num">金额</th><th class="num">比例</th><th class="num">分成</th><th>分类</th><th>完单日</th><th>派单员</th><th>备注</th></tr></thead>
      <tbody>${d.rows.map(o => `<tr><td>${esc(o.date)}</td><td class="mono">${esc(o.orderNo)}</td><td class="num">${money(o.amount)}</td>
        <td class="num">${Number(o.shareRate) || 0}%</td><td class="num">${money((Number(o.amount) || 0) * (Number(o.shareRate) || 0) / 100)}</td>
        <td>${esc(o.status)}</td><td>${esc(o.doneDate || '—')}</td><td>${esc(o.writer || '—')}</td><td class="sub">${esc(o.note || '')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  async function toggleDet(no) {
    if (RDET[no]) { delete RDET[no]; return renderRecon(); }
    RDET[no] = { loading: true, rows: [] };
    renderRecon();
    try {
      const j = await api('/api/orders?q=' + encodeURIComponent(no));
      RDET[no] = { rows: (j.orders || []).filter(o => String(o.orderNo || '').trim() === no) };
    } catch (e) { RDET[no] = { rows: [], err: e.message || String(e) }; }
    renderRecon();
  }
  // 卡片上改状态：先按单号取回整行再 PUT（只换 status），否则会把备注/完单日/派单员写空
  async function reconSet(no, id, to) {
    if (!no) return toast('这行没有单号，改不了');
    const cur = ((RECON.buckets.stBad || []).concat(RECON.buckets.amtBad || [], RECON.buckets.shareBad || [], RECON.buckets.dup || [], RECON.buckets.missUp || [])
      .find(x => String(x.ledId) === String(id)) || {}).ledStatus;
    if (to === cur) return;
    if (to === '已结算' && !confirm('把 ' + no + ' 改成「已结算」？\n\n已结算按你定的规矩只逐单点，这一步会写进台账。')) return;
    try {
      const j = await api('/api/orders?q=' + encodeURIComponent(no));
      const rows = (j.orders || []).filter(o => String(o.orderNo || '').trim() === no);
      if (rows.length !== 1) return toast(rows.length ? '这个号在台账里有 ' + rows.length + ' 行，一键改会打到多行 —— 去数据中心逐单点' : '台账里查不到这单了，刷新看看');
      const o = rows[0];
      const body = {
        date: String(o.date || '').slice(0, 10), orderNo: o.orderNo, amount: Number(o.amount) || 0,
        shareRate: Number(o.shareRate) || 0, status: to, doneDate: o.doneDate || '', note: o.note || '',
      };
      if (String(o.writer || '').trim()) body.writer = o.writer;
      await api('/api/orders/' + o._id, { method: 'PUT', body: JSON.stringify(body) });
      Object.values(RECON.buckets || {}).forEach(arr => (arr || []).forEach(x => { if (String(x.ledId) === String(o._id)) x.ledStatus = to; }));
      if (RDET[no]) RDET[no] = { rows: [{ ...o, status: to }] };
      toast(no + ' → ' + to + '（已写进台账，卡片就地更新，没重跑外网）');
      renderRecon();
    } catch (e) { toast('状态没改成：' + (e.message || e)); }
  }

  /* ============ 【v26.92】就地编辑：对账卡片 / 快捷搜索共用一张弹窗 ============ */
  // 主字段走台账原来的整单 PUT（同数据中心）；渠道/群名/初稿/终稿走只碰这 4 个键的 jobfields 窄口。
  // 留空的新字段＝不改，避免把已有值清掉。
  let ED = null, EDSAVE = false;
  const findLedger = id => LED.find(o => String(o._id) === String(id));
  function openEdit(id, no) {
    let o = findLedger(id);
    if (!o) {
      toast('台账列表里没这单，正在按单号取…');
      if (!no) return;
      api('/api/orders?q=' + encodeURIComponent(no)).then(j => {
        const hit = (j.orders || []).find(x => String(x._id) === String(id)) || (j.orders || []).find(x => String(x.orderNo || '').trim() === no);
        if (!hit) return toast('台账里取不到这单，刷新一下再做');
        ED = hit; EDSAVE = false; $('#edMask').classList.add('show'); paintEdit();
      }).catch(e => toast('取这单失败：' + (e.message || e)));
      return;
    }
    ED = o; EDSAVE = false;
    $('#edMask').classList.add('show');
    paintEdit();
  }
  function closeEdit() { ED = null; const m = $('#edMask'); if (m) m.classList.remove('show'); }
  function paintEdit() {
    const o = ED; if (!o) return;
    const teams = [...new Set(UP.map(u => u.team).concat([String(o.channel || '')]))].filter(Boolean);
    $('#edBox').innerHTML = `
      <button class="mx" id="edX" title="关闭（Esc）">✕</button>
      <h3>编辑台账单 <span class="mono">${esc(o.orderNo || '')}</span></h3>
      <div class="form">
        <div class="f"><label>接单日</label><input id="eDate" type="date" value="${esc(String(o.date || '').slice(0, 10))}"></div>
        <div class="f"><label>单号</label><input id="eNo" value="${esc(o.orderNo || '')}"></div>
        <div class="f"><label>金额（元）</label><input id="eAmt" type="number" step="0.01" value="${o.amount == null ? '' : o.amount}"></div>
        <div class="f"><label>分成比例 %</label><input id="eRate" type="number" step="0.1" value="${o.shareRate == null ? '' : o.shareRate}"></div>
        <div class="f"><label>分类</label><select id="eSt">${ST.map(s => `<option${s === (o.status || '') ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="f"><label>完单日（待结算/已结算要填）</label><input id="eDone" type="date" value="${esc(String(o.doneDate || '').slice(0, 10))}"></div>
        <div class="f"><label>派单员</label><input id="eWriter" value="${esc(o.writer || '')}"></div>
        <div class="f"><label>渠道</label><input id="eTeam" list="eTeamList" value="${esc(o.channel || '')}"><datalist id="eTeamList">${teams.map(t => `<option value="${esc(t)}">`).join('')}</datalist></div>
        <div class="f"><label>群名</label><input id="eGroup" value="${esc(o.group || '')}"></div>
        <div class="f"><label>初稿</label><input id="eDraft" type="date" value="${esc(String(o.draft || '').slice(0, 10))}"></div>
        <div class="f"><label>终稿（预计）</label><input id="eFinal" type="date" value="${esc(String(o.final || '').slice(0, 10))}"></div>
        <div class="f"><label>初稿开始（工序起算）</label><input id="eStart" type="date" value="${esc(String(o.draftStart || '').slice(0, 10))}"></div>
        <div class="f"><label>工序</label><select id="eStage"><option value="">（未设）</option>${STAGES.map(s => `<option${s === (o.stage || '') ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="f"><label>备注</label><input id="eNote" value="${esc(o.note || '')}"></div>
      </div>
      <div class="sub" style="margin-top:8px">金额/比例/分类/备注/派单员走台账原来的整单保存；渠道/群名/初稿/终稿/工序/初稿开始只写这几个键。<b>留空＝不改</b>；分类改成待结算/已结算时完单日会自动补今天。</div>
      <div class="mfoot"><button class="btn p" id="eSave">保存</button><button class="btn g" id="eCancel">取消</button></div>`;
    $('#eSt').onchange = () => {
      const done = CLOSED.has($('#eSt').value);
      const d = $('#eDone');
      if (done && !d.value) d.value = localDate();
    };
    $('#eCancel').onclick = closeEdit;
    $('#edX').onclick = closeEdit;
    $('#eSave').onclick = saveEdit;
  }
  async function saveEdit() {
    const o = ED;
    if (!o || EDSAVE) return;
    const st = $('#eSt').value;
    const doc = {
      date: $('#eDate').value, orderNo: $('#eNo').value.trim(),
      amount: Number($('#eAmt').value), shareRate: Number($('#eRate').value),
      status: st, doneDate: CLOSED.has(st) ? ($('#eDone').value || localDate()) : ($('#eDone').value || ''),
      note: $('#eNote').value.trim(), writer: $('#eWriter').value.trim(),
    };
    const errs = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.date)) errs.push('接单日要选');
    // 【v26.99】单号留空允许保存：没号的单进候补区补号
    if (!(doc.amount >= 0) || isNaN(doc.amount)) errs.push('金额要是非负数字');
    if (!(doc.shareRate > 0 && doc.shareRate <= 100)) errs.push('比例要在 1-100');
    if (errs.length) return toast(errs.join('；'));
    if (st === '已结算' && o.status !== '已结算' && !confirm('把 ' + doc.orderNo + ' 改成「已结算」？\n\n这一步会写进台账。')) return;
    EDSAVE = true;
    const btn = $('#eSave'); btn.disabled = true; btn.textContent = '保存中…';
    try {
      await api('/api/orders/' + o._id, { method: 'PUT', body: JSON.stringify(doc) });
      const fields = {};
      const team = $('#eTeam').value.trim(), group = $('#eGroup').value.trim();
      const draft = $('#eDraft').value, final = $('#eFinal').value;
      const start = $('#eStart').value, stage = $('#eStage').value;
      if (team && team !== String(o.channel || '')) fields.channel = team;
      if (group && group !== String(o.group || '')) fields.group = group;
      if (isDate(draft) && draft !== String(o.draft || '')) fields.draft = draft;
      if (isDate(final) && final !== String(o.final || '')) fields.final = final;
      if (isDate(start) && start !== String(o.draftStart || '')) fields.draftStart = start;
      if (stage && stage !== String(o.stage || '')) fields.stage = stage;
      let jfErr = '';
      if (Object.keys(fields).length) {
        try { await api('/api/orders/jobfields', { method: 'POST', body: JSON.stringify({ patches: [{ id: o._id, fields }], apply: true, onlyEmpty: false }) }); }
        catch (e) { jfErr = '（渠道/初稿这些没写上：' + (e.message || e) + '）'; }
      }
      Object.assign(o, doc, fields);
      // 对账结果就地同步：桶里的台账摘要 + 「查这单」详情，不重跑外网
      Object.values((RECON && RECON.buckets) || {}).forEach(arr => (arr || []).forEach(x => {
        if (String(x.ledId) === String(o._id)) {
          x.ledStatus = o.status; x.ledAmount = Number(o.amount) || 0; x.ledRate = Number(o.shareRate) || 0;
          x.ledShare = Math.round((Number(o.amount) || 0) * (Number(o.shareRate) || 0)) / 100;
          x.ledDate = doc.date; x.ledWriter = doc.writer;
        }
      }));
      if (RDET[doc.orderNo]) RDET[doc.orderNo] = { rows: [o] };
      EDSAVE = false; closeEdit();
      toast('已保存 ' + doc.orderNo + '（写进台账了）' + jfErr);
      paintHead(); paintSum(); paintList(); paintTeamFilter();
      if (RECON) renderRecon();
      paintFind();
    } catch (e) {
      EDSAVE = false;
      toast('没存上：' + (e.message || e));
      btn.disabled = false; btn.textContent = '保存';
    }
  }

  /* ============ 【v26.92】对账区快速查台账（就地搜 + 就地改） ============ */
  function paintFind() {
    const out = $('#rFindOut'), n = $('#rFindN');
    if (!out) return;
    const q = RQ.trim().toLowerCase();
    if (!q) { out.innerHTML = ''; if (n) n.textContent = ''; return; }
    const all = LED.filter(o => [o.orderNo, o.group, o.writer, o.note, o.channel].some(v => String(v || '').toLowerCase().includes(q)));
    const hit = all.slice(0, 30);
    if (n) n.textContent = `命中 ${all.length} 单` + (all.length > 30 ? '（显示前 30）' : '') + (LED.length >= 500 ? '（列表只拿到 500 单，可能不全）' : '');
    out.innerHTML = hit.length ? `<div class="bwrap"><table><thead><tr><th>接单日</th><th>单号</th><th class="num">金额</th><th class="num">比例</th><th>分类</th><th>派单员</th><th>渠道</th><th>初稿</th><th>终稿</th><th>备注</th><th style="width:64px">操作</th></tr></thead><tbody>${hit.map(o => `<tr>
      <td>${esc(String(o.date || '').slice(0, 10))}</td><td class="mono">${esc(o.orderNo || '')}</td>
      <td class="num">${money(o.amount)}</td><td class="num">${Number(o.shareRate) || 0}%</td><td>${esc(o.status || '')}</td>
      <td>${esc(o.writer || '—')}</td><td>${esc(o.channel || '—')}</td><td>${esc(String(o.draft || '').slice(0, 10) || '—')}</td><td>${esc(String(o.final || '').slice(0, 10) || '—')}</td>
      <td class="sub">${esc((o.note || '').slice(0, 24))}</td><td><button class="btn sm p" data-redit="${esc(o._id)}">编辑</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">台账里没搜到（单号 / 群名 / 派单员 / 备注 / 渠道都试了）。</div>';
    $$('#rFindOut [data-redit]').forEach(b => b.onclick = () => openEdit(b.dataset.redit));
  }

  // 上游有、台账没有的那行：把内容带进「记一单」，录不录由他点头
  function recordNew(no, amt) {
    $('#foldNew').open = true;
    const f = $('#foldNew');
    if (f && f.scrollIntoView) f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#nNo').value = no || '';
    if (amt) $('#nAmount').value = amt;
    onNoInput();
    $('#nNo').focus();
    toast('已把这行填进「记一单」，核对完点存进台账——我没替你录');
  }

  function bucketBlock(k, title, cls, arr) {
    const moneyK = ['missLedger', 'amtBad', 'shareBad', 'stBad'].includes(k);
    const open = (k === 'stBad' || k === 'missLedger' || k === 'amtBad' || k === 'shareBad');
    const sum = arr.reduce((t, x) => t + (x.extAmount || x.ledAmount || 0), 0);
    const body = RVIEW === 'card'
      ? arr.slice(0, 120).map(x => reconCard(x, k, cls)).join('') + (arr.length > 120 ? `<div class="sub">只列前 120 张卡，共 ${arr.length} 条。</div>` : '')
      : `<table><thead><tr><th>单号</th><th>来源</th><th>上游侧</th><th>台账侧</th><th>差在哪</th><th style="width:110px">操作</th></tr></thead>
         <tbody>${arr.map(x => rowHtml(x, k)).join('')}</tbody></table>`;
    return `<details class="bk ${cls}"${open ? ' open' : ''}><summary>${title}：<b>${arr.length}</b> 条${moneyK ? ' · 涉及金额 ' + money(sum) + ' 元' : ''}</summary>
      <div class="bkb">${body}</div></details>`;
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
    $('#rOut').innerHTML = `<div class="row2" style="margin-bottom:8px">
        <button class="chip${RVIEW === 'card' ? ' on' : ''}" data-rv="card">卡片（一单一卡，状态就地改）</button>
        <button class="chip${RVIEW === 'table' ? ' on' : ''}" data-rv="table">表格（扫得快）</button>
        <span class="sub">卡片上「查这单」是就地按单号取台账整行；「编辑」直接改整单（金额/状态/备注/派单员/渠道/初稿/终稿），不用切去数据中心。</span>
      </div>`
      + (total ? '' : '<div class="empty">这批上游跟你台账对得上，没问题单。</div>')
      + BUCKETS.map(([k, title, cls]) => {
        const arr = rowsOf(k);
        return arr.length ? bucketBlock(k, title, cls, arr) : '';
      }).join('')
      + (noise ? bucketBlock('amtNoise', '⑩ 只差 ≤1 元（你录台账时把金额取整了，不是错）', 'quiet', rowsOf('amtNoise')) : '');
    $$('#rOut [data-rv]').forEach(b2 => b2.onclick = () => { RVIEW = b2.dataset.rv; renderRecon(); });
    $$('#rOut [data-copyno]').forEach(b2 => b2.onclick = () => {
      const v = b2.dataset.copyno; if (!v) return;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject())
        .then(() => toast('已复制单号 ' + v), () => toast('浏览器不让复制，手动选：' + v));
    });
    $$('#rOut [data-copyg]').forEach(b2 => b2.onclick = () => {
      const v = b2.dataset.copyg; if (!v) return;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject())
        .then(() => toast('已复制群名 ' + v), () => toast('浏览器不让复制，手动选：' + v));
    });
    $$('#rOut [data-goto]').forEach(b2 => b2.onclick = () => gotoLedger(b2.dataset.goto));
    $$('#rOut [data-rdet]').forEach(b2 => b2.onclick = () => toggleDet(b2.dataset.rdet));
    $$('#rOut [data-rst]').forEach(b2 => b2.onclick = () => reconSet(b2.dataset.rst, b2.dataset.rid, b2.dataset.to));
    $$('#rOut [data-redit]').forEach(b2 => b2.onclick = () => openEdit(b2.dataset.redit, b2.dataset.rno));
    $$('#rOut [data-rnew]').forEach(b2 => b2.onclick = () => recordNew(b2.dataset.rnew, Number(b2.dataset.ramt) || 0));
    $('#rCsv').disabled = !total && !noise;
  }

  // 台账那一屏在同一个文档里：切面板 + 填它的搜索框，让他逐单去确认（不在这里改状态）
  async function gotoLedger(no) {
    if (!no) return toast('这行没有单号，定位不了');
    if (typeof window.navigate === 'function') window.navigate('orders');
    await new Promise(r => setTimeout(r, 500));
    const panel = document.getElementById('panel-orders');
    const sr = panel && panel.shadowRoot;
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
    const csv = '﻿' + lines.join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = '上游对账差异_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('差异清单已导出（' + (lines.length - 1) + ' 行）');
  }

  /* ============ 事件绑定（骨架只建一次，之后都局部重绘） ============ */
  function bind() {
    $('#fQ').oninput = () => { Q = $('#fQ').value; paintList(); };
    $('#rFind').oninput = () => { RQ = $('#rFind').value; paintFind(); };
    $('#fSort').onchange = () => { SORT = $('#fSort').value; LS.write('jobs_sort_v0', SORT); paintList(); };
    $('#fTeam').onchange = () => { TEAM = $('#fTeam').value; paintList(); };
    $('#nAdd').onclick = addJob;
    $('#nLocal').onclick = () => saveLocal(formDraft());
    $('#nNo').oninput = onNoInput;
    $('#nNo').onpaste = () => setTimeout(onNoInput, 30);
    ['#nGroup', '#nAmount'].forEach(s => $(s).addEventListener('input', () => {
      clearTimeout(DUPTG); DUPTG = setTimeout(checkDupG, 350);
    }));
    $('#nTeam').onchange = () => {
      const u = upOf($('#nTeam').value);
      if (u.team) { $('#nRate').value = u.rate || 45; $('#nPerson').value = u.person || ''; }
      syncNewDue();
    };
    $('#nTake').onchange = syncNewDue;
    $('#nStart').onchange = syncNewDue;
    $('#upAdd').onclick = () => {      const team = $('#upTeam').value.trim();
      if (!team) return toast('渠道名必填');
      UP.push({
        id: 'u' + Date.now(), team, person: $('#upPerson').value.trim(), rate: Number($('#upRate').value) || 45,
        dueDraft: Number($('#upDD').value) || DEF_DUE.draft, dueFinal: Number($('#upDF').value) || DEF_DUE.final, note: $('#upNote').value.trim(),
      });
      LS.write(LS_UP, UP);
      ['#upTeam', '#upPerson', '#upNote'].forEach(s => $(s).value = '');
      paintUpstream(); paintNewTeam(true); paintTeamFilter(); toast('已加一行渠道（只存这台浏览器）');
    };
    $('#sdSave').onclick = () => {
      const v = STAGES.map((s, i) => Number($('#sd' + i).value));
      if (v.some(n => !(n > 0 && n <= 60))) return toast('工序天数要填 1-60');
      STAGE_DAYS = v; LS.write('jobs_stage_days_v0', v);
      paintList(); toast('工序天数已保存（本机）');
    };
    $('#rGo').onclick = runRecon;
    $('#fGo').onclick = () => runFull(false);
    $('#archUse').onclick = () => useArchive(false);
    $('#archRe').onclick = () => useArchive(true);
    $('#archDel').onclick = delArchive;
    loadArchives();
    $('#fFq').oninput = () => { FQ = $('#fFq').value; FPAGE = 0; paintFull(); };
    $('#rCsv').onclick = exportCsv;
    $('#rAccSave').onclick = saveAccount;
    $('#rReCalc').onclick = runRecon;
    $('#rPaste').onchange = () => { $('#rPasteBox').hidden = !$('#rPaste').checked; };
    $('#rPaste').onchange();
    api('/api/upstream/account').then(j => {
      if (j && j.ok && j.account) { $('#rAcc').value = j.account; $('#rAccSaved').textContent = '已存'; }
    }).catch(() => { });
  }

  skeleton();
  loadLedger();
  // 编辑弹窗只认 ✕ / Esc / 取消，点空白（遮罩）不关，避免误触丢改动
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#edMask') && $('#edMask').classList.contains('show')) {
      e.preventDefault(); e.stopPropagation(); closeEdit();
    }
  }, true);

  // 【v26.96】实时：45 秒自动拉一次台账（页面可见、没开弹窗、没在输入时），录完不用手动刷新
  setInterval(() => {
    if (document.hidden) return;
    if (LOADING) return;
    if (sh.querySelector('#edMask.show') || sh.querySelector('.mask.show')) return;
    const ae = sh.activeElement || document.activeElement;
    if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    loadLedger(true);
  }, 45000);

  return { refresh: () => { skeleton(); loadLedger(true); } };
}
