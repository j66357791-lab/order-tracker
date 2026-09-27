// admin/app.js — 管理后台公共层（方案二重构 · 统一壳）
// 职责：登录守卫 / 接口封装 / 通用组件（toast、确认）/ 时间工具 / 导航渲染
// 各功能模块（台账/派单/游戏/用户端/安全）逐步迁入后共用本层，不再各自复制

// —— 登录态读取：localStorage 在无痕模式/被禁用时会抛异常，这里不能让它把整个后台打断 ——
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
export const TOKEN = lsGet('jdy_token') || '';
export let ME = null;
try { ME = JSON.parse(lsGet('jdy_user') || 'null'); } catch (e) {}

// —— 登录守卫：仅管理员可用；非管理员送回各自的页面 ——
export function guardAdmin() {
  if (!TOKEN || !ME) { location.replace('/login.html'); return false; }
  if (ME.role === 'writer') { location.replace('/writer.html'); return false; }
  if (ME.role === 'client') { location.replace('/portal.html'); return false; }
  return true;
}

// —— 接口封装：自动带 token；401 统一踢回登录 ——
// 【v26.71 关键】非 2xx 一律抛出带服务端原文的 Error。
// 原来这里只处理 401，400/403/409 都当成正常结果 return r.json() 给调用方，
// 而调用方普遍写的是 `try { const j = await api(...); toast('已到账 ¥' + j.amount) } catch (e) { toast(e.message) }`：
// 请求被服务端拒绝时 j 是 { ok:false, error:'…' }，j.amount 就是 undefined ——
// 于是「充值审核没通过」在管理员屏幕上显示成「已到账 ¥undefined（写手余额已更新）」，
// 派单卡打款、配置保存、数据清理等同理：钱没动、配置没存，提示却报成功。
// 全站核查过：服务端 511 处失败返回全部带非 2xx 状态码，且没有任何一处用 200 + {ok:false}，
// 所以「!r.ok 即失败」与真实约定完全对齐；60 个调用点里 48 处本就有 try/catch，
// 改这一处即可同时修好另外 12 处盲用返回值的调用，不需要在各模块重复加判断。
export async function api(path, opt = {}) {
  let r;
  try {
    // 【2026-09-27 审查修复 P2-15】默认 60 秒超时（后台存在批量清理/群发类慢操作，故放宽；不误杀即可）
    if (!opt.signal && window.AbortSignal && AbortSignal.timeout) opt = { ...opt, signal: AbortSignal.timeout(60000) };
    r = await fetch(path, { ...opt, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN, ...(opt.headers || {}) } });
  } catch (e) {
    throw new Error('网络请求失败（连接中断或被拦截），请重试');
  }
  if (r.status === 401) {
    try { localStorage.removeItem('jdy_token'); localStorage.removeItem('jdy_user'); } catch (e) {}
    location.href = '/login.html';
    throw new Error('未登录');
  }
  // 先按文本取，再自己解析：网关/代理返回 HTML 错误页时，r.json() 会抛一句看不懂的
  // "Unexpected token < in JSON"，把真实状态码盖掉；这里让它显式报 HTTP 码。
  const text = await r.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) {
    const err = new Error((data && (data.error || data.message)) || `操作失败（HTTP ${r.status}）`);
    err.status = r.status; err.data = data;
    throw err;
  }
  if (data === null) throw new Error(`服务器返回了无法解析的内容（HTTP ${r.status}）`);
  return data;
}


// —— 轻提示 ——
let _toastTimer = null;
export function toast(msg) {
  let el = document.getElementById('adminToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'adminToast';
    el.style.cssText = 'position:fixed;left:50%;top:76px;transform:translateX(-50%);background:#2b2a26;color:#fff;padding:10px 22px;border-radius:99px;font-size:13px;z-index:200;display:none;max-width:88vw;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2600);
}

// —— HTML 转义 ——
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// —— 北京时间工具 ——
export const cnTime = (d) => new Date(new Date(d).getTime() + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
export const cnDate = (d) => new Date(new Date(d).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);

// —— 复制到剪贴板 ——
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制：' + text); }
  catch (e) { toast(text); }
}

// —— 导航定义（方案二：十项；panel=已迁入本壳的面板，frame=仍在外部页面用 iframe 装） ——
// 迁移进度：已完成 ads / withdraw / overview / recon；剩余 2 项（台账 orders / 派单聊天 dispatch）
export const NAV_ITEMS = [
  { key: 'home',     icon: '🏠', title: '工作台',     type: 'panel' },
  { key: 'orders',   icon: '📒', title: '台账',           type: 'frame', href: '/index.html?embed=1', desc: '接单台账与利润统计' },
  { key: 'dispatch', icon: '🎧', title: '派单聊天',   type: 'frame', href: '/dispatch.html?embed=1', desc: '与写手沟通 / 发派单卡' },
  { key: 'overview', icon: '📋', title: '派单总览',   type: 'panel', desc: '全部派单卡进度与审核' },
  { key: 'withdraw', icon: '💳', title: '提现审批',   type: 'panel', desc: '写手提现申请处理' },
  { key: 'recharge', icon: '📥', title: '充值管理',   type: 'panel', desc: '收款账号配置 / 截图充值审核' },
  { key: 'recon',    icon: '💰', title: '财务对账',   type: 'panel', desc: '台账 × 派单卡交叉核对' },
  { key: 'game',     icon: '🎮', title: '游戏控制器', type: 'panel', desc: '翻翻乐配置 / 山海数据 / 道具 / 审计' },
  { key: 'shanhai',  icon: '💱', title: '山海·交易所', type: 'panel', desc: '做市机器人 / 成交台账 / 玩家道具管控' },
  { key: 'mall',     icon: '🛍', title: '用户端配置', type: 'panel', desc: '套餐 / 文案馆作品 / 咨询' },
  { key: 'ads',      icon: '📝', title: '广告管理',   type: 'panel', desc: '写手端活动中心公告' },
  { key: 'security', icon: '🛡', title: '安全与用户', type: 'panel', desc: '账号 / 密码重置 / 站内信 / 危险操作' },
];

// —— 渲染左侧导航（currentKey 高亮当前面板；badge：角标数值/函数） ——
// 【v20.6】文字包一层 .lbl：导航收起（.nav.mini）时只隐藏 .lbl，图标与角标保留；
//         同时给每个入口加 title，收起后鼠标划过仍能看到名字。
// 【v20.8】每个入口加 data-key，配合下面的 updateNav 做局部更新（切页不再重建整块 DOM）。
export function renderNav(currentKey, badges = {}) {
  const host = document.getElementById('navItems');
  if (!host) return;
  host.innerHTML = NAV_ITEMS.map(item => {
    const b = badges[item.key];
    const badge = b ? `<span class="badge">${b}</span>` : '';
    const label = `<span class="lbl">${item.title}</span>`;
    if (item.type === 'panel' || item.type === 'frame') {
      const tip = item.desc ? item.title + ' · ' + item.desc : item.title;
      return `<button class="nav-item ${item.key === currentKey ? 'on' : ''}" data-key="${item.key}" data-nav="${item.key}" title="${esc(tip)}"><span class="ico">${item.icon}</span>${label}${badge}</button>`;
    }
    return `<a class="nav-item external" data-key="${item.key}" href="${item.href}" title="${esc(item.title + (item.desc ? ' · ' + item.desc : ''))}"><span class="ico">${item.icon}</span>${label}${badge}</a>`;
  }).join('');
  host.querySelectorAll('[data-nav]').forEach(btn => {
    btn.onclick = () => {
      if (typeof window.navigate === 'function') window.navigate(btn.dataset.nav);
    };
  });
}

// —— 【v20.8】只更新高亮与角标，不重建 DOM ——
// 切页时用这个替代 renderNav：避免每次重建 10 个按钮造成的高亮闪烁与 hover 丢失。
// 首次（导航为空）自动回退到完整渲染。
export function updateNav(currentKey, badges = {}) {
  const host = document.getElementById('navItems');
  if (!host) return;
  const items = host.querySelectorAll('.nav-item');
  if (!items.length) { renderNav(currentKey, badges); return; }
  items.forEach(btn => {
    const k = btn.dataset.key;
    btn.classList.toggle('on', k === currentKey);
    const cur = btn.querySelector('.badge');
    const val = badges[k];
    if (val) {
      if (cur) cur.textContent = val;
      else btn.insertAdjacentHTML('beforeend', `<span class="badge">${esc(val)}</span>`);
    } else if (cur) {
      cur.remove();
    }
  });
}
