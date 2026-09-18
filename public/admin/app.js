// admin/app.js — 管理后台公共层（方案二重构 · 统一壳）
// 职责：登录守卫 / 接口封装 / 通用组件（toast、确认）/ 时间工具 / 导航渲染
// 各功能模块（台账/派单/游戏/用户端/安全）逐步迁入后共用本层，不再各自复制

export const TOKEN = localStorage.getItem('jdy_token') || '';
export let ME = null;
try { ME = JSON.parse(localStorage.getItem('jdy_user') || 'null'); } catch (e) {}

// —— 登录守卫：仅管理员可用；非管理员送回各自的页面 ——
export function guardAdmin() {
  if (!TOKEN || !ME) { location.replace('/login.html'); return false; }
  if (ME.role === 'writer') { location.replace('/writer.html'); return false; }
  if (ME.role === 'client') { location.replace('/portal.html'); return false; }
  return true;
}

// —— 接口封装：自动带 token；401 统一踢回登录 ——
export async function api(path, opt = {}) {
  const r = await fetch(path, { ...opt, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN, ...(opt.headers || {}) } });
  if (r.status === 401) {
    localStorage.removeItem('jdy_token'); localStorage.removeItem('jdy_user');
    location.href = '/login.html';
    throw new Error('未登录');
  }
  return r.json();
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
// 迁移进度：剩余 5 项为 frame，按「由易到难」逐个迁成 panel（每迁一个删一个 FRAMES 条目）
export const NAV_ITEMS = [
  { key: 'home',     icon: '🏠', title: '工作台',     type: 'panel' },
  { key: 'orders',   icon: '📒', title: '台账',           type: 'frame', href: '/index.html?embed=1', desc: '接单台账与利润统计' },
  { key: 'dispatch', icon: '🎧', title: '派单聊天',   type: 'frame', href: '/dispatch.html?embed=1', desc: '与写手沟通 / 发派单卡' },
  { key: 'overview', icon: '📋', title: '派单总览',   type: 'frame', href: '/dispatch-overview.html?embed=1', desc: '全部派单卡进度与审核' },
  { key: 'withdraw', icon: '💳', title: '提现审批',   type: 'frame', href: '/withdraw.html?embed=1', desc: '写手提现申请处理' },
  { key: 'recon',    icon: '💰', title: '财务对账',   type: 'frame', href: '/dispatch-overview.html?embed=1&tab=recon', desc: '台账 × 派单卡交叉核对' },
  { key: 'game',     icon: '🎮', title: '游戏控制器', type: 'panel', desc: '翻翻乐配置 / 山海数据 / 道具 / 审计' },
  { key: 'mall',     icon: '🛍', title: '用户端配置', type: 'panel', desc: '套餐 / 文案馆作品 / 咨询' },
  { key: 'ads',      icon: '📝', title: '广告管理',   type: 'panel', desc: '写手端活动中心公告' },
  { key: 'security', icon: '🛡', title: '安全与用户', type: 'panel', desc: '账号 / 密码重置 / 站内信 / 危险操作' },
];

// —— 渲染左侧导航（currentKey 高亮当前面板；badge：角标数值/函数） ——
// 【v20.6】文字包一层 .lbl：导航收起（.nav.mini）时只隐藏 .lbl，图标与角标保留；
//         同时给每个入口加 title，收起后鼠标划过仍能看到名字。
export function renderNav(currentKey, badges = {}) {
  const host = document.getElementById('navItems');
  if (!host) return;
  host.innerHTML = NAV_ITEMS.map(item => {
    const b = badges[item.key];
    const badge = b ? `<span class="badge">${b}</span>` : '';
    const label = `<span class="lbl">${item.title}</span>`;
    if (item.type === 'panel' || item.type === 'frame') {
      const tip = item.desc ? item.title + ' · ' + item.desc : item.title;
      return `<button class="nav-item ${item.key === currentKey ? 'on' : ''}" data-nav="${item.key}" title="${esc(tip)}"><span class="ico">${item.icon}</span>${label}${badge}</button>`;
    }
    return `<a class="nav-item external" href="${item.href}" title="${esc(item.title + (item.desc ? ' · ' + item.desc : ''))}"><span class="ico">${item.icon}</span>${label}${badge}</a>`;
  }).join('');
  host.querySelectorAll('[data-nav]').forEach(btn => {
    btn.onclick = () => {
      if (typeof window.navigate === 'function') window.navigate(btn.dataset.nav);
    };
  });
}
