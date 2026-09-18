// admin/mod-chat.js — 派单聊天面板（iframe → 原生面板迁移 · 第 5 批 / 最后一批，来源 dispatch.html）
//
// 迁移要点见文件末尾注释。核心：Shadow DOM 隔离样式；socket.io 改成按需加载；
// 面板不可见时 socket 只收不发重绘；原业务逻辑（本地缓存、引用回复、图片/文件预览、
// 派单卡发送与审核打款、在线状态）一行没改。
const MARKUP = "\n<div id=\"connBar\">⚠ 网络连接断开，正在自动重连…（恢复后无需刷新）</div>\n\n<header class=\"topbar\">\n  <div class=\"logo\">📨</div>\n  <div><h1>派单工作台</h1><div class=\"sub\">管理端 · 派单系统 V17</div></div>\n  <div class=\"grow\"></div>\n  <button class=\"tbtn\" onclick=\"this.getRootNode().host.__ledger.pGo('/index.html','orders')\">📊 台账</button>\n  <button class=\"tbtn\" id=\"btnInvite\">🎟️ 邀请码</button>\n  <button class=\"tbtn\" id=\"btnLogout\">退出</button>\n</header>\n\n<div class=\"subtabs\">\n  <div class=\"stab\" onclick=\"this.getRootNode().host.__ledger.pGo('/admin.html','home')\" style=\"color:var(--green2)\">🏠 工作台</div>\n      <div class=\"stab\" onclick=\"this.getRootNode().host.__ledger.pGo('/admin.html#game','game')\" style=\"color:#7c4dff\">🎮 游戏控制器</div>\n      <div class=\"stab on\" data-v=\"vChat\">💬 聊天/派单<span class=\"reddot\" id=\"tabUnread\" style=\"display:none\">0</span></div>\n  <div class=\"stab\" onclick=\"this.getRootNode().host.__ledger.pGo('/admin.html#mall','mall')\">📦 用户端配置</div>\n  <div class=\"stab\" onclick=\"this.getRootNode().host.__ledger.pGo('/index.html','orders')\">📊 台账统计</div>\n</div>\n\n<main class=\"main\">\n  <!-- 聊天 + 发卡 -->\n  <section id=\"vChat\" class=\"panel on\">\n    <div id=\"chatLayout\">\n      <div id=\"convList\"></div>\n      <div id=\"chatRight\">\n        <div id=\"chatHead\"><span class=\"dot d-off\" id=\"peerDot\"></span><span id=\"peerName\">选择会话</span><span class=\"sub\" id=\"peerSt\"></span>\n          <span style=\"flex:1\"></span>\n          <button class=\"btn btn-g btn-sm\" id=\"btnNewCard\">＋ 发派单卡</button>\n        </div>\n        <div id=\"chatBox\"><div class=\"empty\">左侧选择写手，开始沟通 / 派单</div></div>\n        <div id=\"dragOver\">📥 松手发送 · 文件夹需确认</div>\n        <div id=\"chatInputBar\">\n          <div id=\"quoteBar\"><span>↩</span><span class=\"qb-txt\" id=\"quoteTxt\"></span><button class=\"qb-x\" onclick=\"this.getRootNode().host.__ledger.clearQuote()\">✕</button></div>\n          <div class=\"input-row\">\n            <button class=\"icon-btn\" id=\"btnFile\" title=\"发文件\">📎</button>\n            <textarea id=\"chatInput\" rows=\"1\" placeholder=\"输入消息，回车发送 · Shift+回车换行 · 支持粘贴/拖入截图和文件\"></textarea>\n            <button class=\"icon-btn\" id=\"btnSend\" style=\"background:var(--green);color:#fff\" title=\"发送\">➤</button>\n            <input type=\"file\" id=\"fileInput\" style=\"display:none\">\n          </div>\n        </div>\n      </div>\n    </div>\n  </section>\n\n</main>\n\n<div class=\"mask\" id=\"mask\"><div class=\"sheet\" id=\"sheet\"></div></div>\n<div id=\"imgMask\" onclick=\"this.getRootNode().host.__ledger.closePreview()\"><a class=\"dl\" id=\"imgDl\" href=\"#\" target=\"_blank\" onclick=\"event.stopPropagation()\">⬇ 下载原图</a><img id=\"imgBig\" alt=\"图片预览\"><iframe id=\"pvFrame\" title=\"文件预览\"></iframe></div>\n<div id=\"toast\"></div>\n\n";

export async function mount(host) {
  const shDoc = host.attachShadow({ mode: 'open' });
  shDoc.innerHTML =
    '<link rel="stylesheet" href="/admin/chat.css">' +
    MARKUP;

  const $ = id => shDoc.getElementById(id);
  const TOKEN = localStorage.getItem('jdy_token');
  const USER = JSON.parse(localStorage.getItem('jdy_user') || 'null');
  // 【v20.3】embed=1 嵌入管理工作台 iframe：隐藏自家顶栏
  // 【v20.4】嵌套修复：嵌入模式下所有页面跳转改走壳导航（parent.navGo），
  // 否则 iframe 里再加载整个后台会无限嵌套
  function pGo(path, panelKey) {
    // 【v21.0】面板内：一律走外壳导航（原来嵌入模式靠 parent.navGo，现在同处一个文档）
    if (panelKey && typeof window.navigate === 'function') { window.navigate(panelKey); return; }
    location.href = path;
  }
  let ME = null;

  function toast(t, ms = 2200) { const el = $('toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(el._t); el._t = setTimeout(() => el.style.display = 'none', ms); }
  const fmt = n => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtT = d => d ? (new Date(new Date(d).getTime() + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ')) : '';
  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB';
  const dl = id => '/api/files/' + id + '/download?token=' + encodeURIComponent(TOKEN);
  const stPill = st => '<span class="pill st-' + esc(st) + '">' + esc(st) + '</span>';

  async function authFetch(url, opt = {}) {
    opt.headers = Object.assign({}, opt.headers, { 'Authorization': 'Bearer ' + TOKEN });
    if (opt.body && !(opt.body instanceof FormData) && !opt.headers['Content-Type']) opt.headers['Content-Type'] = 'application/json';
    const r = await fetch(url, opt);
    if (r.status === 401) { localStorage.removeItem('jdy_token'); localStorage.removeItem('jdy_user'); location.href = '/login.html'; throw new Error('未登录'); }
    const j = await r.json().catch(() => ({ ok: false, error: '响应异常' }));
    if (!j.ok) throw new Error(j.error || '请求失败');
    return j;
  }

  /* ================= 聊天（含本地缓存） ================= */
  let chats = [], currentPeer = null, msgs = [], cardsAll = {};
  function cacheKey() { return 'jdy_msg_' + (ME ? ME.id : USER.id) + '_' + (currentPeer || 'none'); }
  function loadCache() { try { return JSON.parse(localStorage.getItem(cacheKey()) || '[]'); } catch (e) { return []; } }
  function saveCache(arr) { try { localStorage.setItem(cacheKey(), JSON.stringify(arr.slice(-600))); } catch (e) {} }
  // 统一的消息入列：按 _id 去重（防止 socket 推送与请求响应竞态导致消息显示两条）
  function addMsg(m) {
    if (!m || !m._id) return false;
    if (msgs.find(x => String(x._id) === String(m._id))) return false;
    msgs.push(m); saveCache(msgs);
    return true;
  }

  /* ================= 引用回复 ================= */
  let quoteTarget = null;
  function msgPreview(m) {
    if (!m) return '';
    if (m.type === 'text') return m.text || '';
    if (m.type === 'file') return '[文件] ' + (m.fileName || '');
    if (m.type === 'card') return '[派单卡] ' + ((cardsAll[m.cardId] || {}).title || '');
    return '';
  }
  function setQuote(m) {
    quoteTarget = m;
    $('quoteTxt').textContent = (m.fromName || '') + '：' + msgPreview(m).slice(0, 60);
    $('quoteBar').classList.add('show');
    $('chatInput').focus();
  }
  function clearQuote() { quoteTarget = null; $('quoteBar').classList.remove('show'); }
  function jumpToMsg(id) {
    const el = shDoc.querySelector('.msg[data-mid="' + id + '"]');
    if (!el) return toast('原消息不在当前记录里');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }
  // 旧数据乱码文件名修复：latin1 误读的 utf8 中文，反向还原
  function fixName(n) {
    if (!n || !/[\u00C0-\u00FF]/.test(n)) return n || '';
    try {
      const bytes = new Uint8Array([...n].map(c => c.charCodeAt(0) & 0xFF));
      const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (/[\u4e00-\u9fff]/.test(s)) return s;
    } catch (e) {}
    return n;
  }
  // 图片灯箱预览
  function openImg(src) {
    $('imgBig').src = src;
    $('imgDl').href = src;
    $('imgMask').classList.add('show');
  }
  // 文件在线预览：图片/pdf/txt类/音视频 浏览器直开，其他格式转下载
  const previewIndex = {};   // fileId -> {url, name}
  const fileIcon = name => {
    const n = (name || '').toLowerCase();
    if (/\.(pdf)$/.test(n)) return '📕';
    if (/\.(docx?|wps|odt)$/.test(n)) return '📘';
    if (/\.(xlsx?|csv|et)$/.test(n)) return '📗';
    if (/\.(pptx?|dps)$/.test(n)) return '📙';
    if (/\.(zip|rar|7z|tar|gz)$/.test(n)) return '🗜️';
    if (/\.(mp4|mov|avi|mkv|webm)$/.test(n)) return '🎬';
    if (/\.(mp3|wav|m4a|flac)$/.test(n)) return '🎵';
    if (/\.(psd|ai|cdr|sketch)$/.test(n)) return '🎨';
    return '📄';
  };
  function openPreview(fileId) {
    const f = previewIndex[fileId];
    if (!f) return;
    const name = (f.name || '').toLowerCase();
    const mask = $('imgMask'), frame = $('pvFrame'), img = $('imgBig');
    $('imgDl').href = f.url;
    mask.classList.remove('pv'); img.style.display = '';
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) {
      frame.src = 'about:blank';
      img.src = f.url; img.style.display = '';
      mask.classList.add('show');
    } else if (/\.(pdf|txt|md|csv|log|json|html?|xml|mp4|webm|mp3|wav|m4a|ogg)$/i.test(name)) {
      img.src = '';
      frame.src = f.url + '&inline=1';
      mask.classList.add('show', 'pv');
    } else {
      toast('该格式暂不支持在线预览，已为你打开下载');
      const a = document.createElement('a'); a.href = f.url; a.download = f.name || ''; a.click();
    }
  }
  function closePreview() {
    const mask = $('imgMask');
    mask.classList.remove('show', 'pv');
    $('pvFrame').src = 'about:blank';
    $('imgBig').src = '';
  }

  function renderConvList() {
    $('convList').innerHTML = chats.map(c => {
      const u = c.user;
      return `<div class="conv ${u.id === currentPeer ? 'on' : ''}" data-id="${u.id}">
        <div class="avatar av-g">${esc((u.displayName || '?')[0])}<span class="dot ${u.sockOnline ? 'd-on' : 'd-off'}"></span></div>
        <div class="info"><div class="nm"><span>${esc(u.displayName)}</span>${u.shift ? '<span class="sh">在班</span>' : ''}</div>
        <div class="last">${c.last ? (c.last.type === 'text' ? esc(c.last.text).slice(0, 18) : c.last.type === 'file' ? '[文件]' : '[派单卡]') : '开始沟通'}</div></div>
        ${c.unread ? '<div class="unread">' + (c.unread > 99 ? '99+' : c.unread) + '</div>' : ''}
      </div>`;
    }).join('') || '<div class="empty">还没有写手，先生成邀请码</div>';
    shDoc.querySelectorAll('.conv').forEach(el => el.onclick = () => openChat(el.dataset.id));
    const totalUnread = chats.reduce((s, c) => s + (c.unread || 0), 0);
    $('tabUnread').style.display = totalUnread ? 'inline-block' : 'none';
    $('tabUnread').textContent = totalUnread > 99 ? '99+' : totalUnread;
  }
  function adminOps(c) {
    const s = c.status;
    if (s === '待审核') return `<button class="btn btn-g btn-sm" onclick="actApprove('${c._id}')">✔ 审核通过</button><button class="btn btn-r btn-sm" onclick="actReject('${c._id}')">✖ 驳回</button>`;
    if (s === '待打款' || s === '已交付') return `<button class="btn btn-cy btn-sm" onclick="actPay('${c._id}')">💸 确认打款 ¥${c.reward}</button>`;
    if (s === '已接单') return '<span style="font-size:11px;color:var(--blue)">✍️ 写手做单中</span>';
    if (s === '待接单') return '<span style="font-size:11px;color:var(--amber)">⏳ 等待写手接单</span>';
    if (s === '已驳回') return '<span style="font-size:11px;color:var(--red)">已驳回，等写手重新提交</span>';
    return '';
  }
  function renderCardBub(c) {
    return `<div class="card-bub">
      <div class="cb-hd">🃏 <span class="cb-t">${esc(c.title)}</span>${stPill(c.status)}</div>
      <div class="cb-meta"><span>报酬 <b>¥${c.reward}</b></span>${c.deadline ? '<span>截止 ' + esc(c.deadline) + '</span>' : ''}${c.toName ? '<span>写手 ' + esc(c.toName) + '</span>' : ''}${c.orderNo ? '<span>单号 ' + esc(c.orderNo) + '</span>' : ''}</div>
      ${c.requirement ? '<div class="cb-req">' + esc(c.requirement) + '</div>' : ''}
      ${c.status === '已驳回' && c.rejectReason ? '<div class="ov-card note warn" style="margin-bottom:6px">❌ 已驳回：' + esc(c.rejectReason) + '</div>' : ''}
      ${c.submitNote ? '<div class="ov-card note info" style="margin-bottom:6px">📝 写手提交说明：' + esc(c.submitNote) + '</div>' : ''}
      ${c.fileId ? '<div style="font-size:12px;margin-bottom:6px"><a href="' + dl(c.fileId) + '" target="_blank">📎 ' + esc(c.fileName || '附件') + '</a></div>' : ''}
      ${adminOps(c) ? '<div class="cb-ops">' + adminOps(c) + '</div>' : ''}
    </div>`;
  }
  function renderMsgs(list) {
    if (!currentPeer) return;
    if (!list.length) { $('chatBox').innerHTML = '<div class="empty">还没有消息，打个招呼吧</div>'; return; }
    $('chatBox').innerHTML = list.map(m => {
      const mine = m.from === ME.id;
      const qref = m.replyTo && m.replyTo.id ? '<div class="qref" onclick="this.getRootNode().host.__ledger.jumpToMsg(\'' + m.replyTo.id + '\')">↩ ' + esc(m.replyTo.fromName || '') + '：' + esc(m.replyTo.preview || '') + '</div>' : '';
      const rbtn = m.type !== 'card' ? '<button class="rbtn" onclick="this.getRootNode().host.__ledger.setQuote(this.getRootNode().host.__ledger.msgs.find(x=>String(x._id)===\'' + m._id + '\'))">引用</button>' : '';
      if (m.type === 'card') {
        const c = cardsAll[m.cardId];
        return `<div class="msg ${mine ? 'mine' : ''}" data-mid="${m._id}">${c ? renderCardBub(c) : '<div class="bub">🃏 [派单卡]（详情见「派单总览」）</div>'}</div>`;
      }
      if (m.type === 'file') {
        m.fileName = fixName(m.fileName);
        const isImg = /\.(png|jpe?g|gif|webp|bmp)$/i.test(m.fileName || '');
        previewIndex[m.fileId] = { url: dl(m.fileId), name: m.fileName || '' };
        const body = isImg
          ? `${qref}<img class="imgmsg" src="${dl(m.fileId)}" loading="lazy" onclick="this.getRootNode().host.__ledger.openPreview('${m.fileId}')"><div class="tm" style="margin-top:4px">${fmtT(m.createdAt)}</div>`
          : `${qref}<div class="filecard"><div class="fic">${fileIcon(m.fileName)}</div><div class="fbody">
              <div class="fn">${esc(m.fileName)}</div><div class="fs">${fmtSize(m.fileSize)}</div>
              <div class="fo"><button class="fc-prev" onclick="this.getRootNode().host.__ledger.openPreview('${m.fileId}')">预览</button><a class="fc-dl" href="${dl(m.fileId)}" download="${esc(m.fileName)}">下载</a></div>
            </div></div><div class="tm" style="margin-top:4px">${fmtT(m.createdAt)}</div>`;
        return `<div class="msg ${mine ? 'mine' : ''}" data-mid="${m._id}">${rbtn}<div class="bub hasfile">${body}</div></div>`;
      }
      return `<div class="msg ${mine ? 'mine' : ''}" data-mid="${m._id}">${rbtn}<div class="bub">${qref}${esc(m.text)}<div class="tm">${fmtT(m.createdAt)}</div></div></div>`;
    }).join('');
    $('chatBox').scrollTop = $('chatBox').scrollHeight;
  }
  async function loadChats() {
    const j = await authFetch('/api/chats');
    chats = j.chats;
    renderConvList();
    if (!currentPeer && chats.length) openChat(chats[0].user.id);
    if (currentPeer) {
      const c = chats.find(x => x.user.id === currentPeer);
      if (c) { $('peerDot').className = 'dot ' + (c.user.sockOnline ? 'd-on' : 'd-off'); $('peerSt').textContent = (c.user.sockOnline ? '在线' : '离线') + (c.user.shift ? ' · 在班' : ''); }
    }
  }
  async function openChat(peer) {
    currentPeer = peer;
    const c = chats.find(x => x.user.id === peer);
    $('peerName').textContent = c ? c.user.displayName : '会话';
    $('peerDot').className = 'dot ' + (c && c.user.sockOnline ? 'd-on' : 'd-off');
    $('peerSt').textContent = c ? ((c.user.sockOnline ? '在线' : '离线') + (c.user.shift ? ' · 在班' : '')) : '';
    msgs = loadCache();
    renderMsgs(msgs);
    renderConvList();
    try {
      const j = await authFetch('/api/messages?peer=' + peer);
      const map = new Map(msgs.map(m => [m._id, m]));
      j.messages.forEach(m => map.set(m._id, m));
      msgs = [...map.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      saveCache(msgs);
      renderMsgs(msgs);
      const ch = chats.find(x => x.user.id === peer); if (ch) { ch.unread = 0; renderConvList(); }
    } catch (e) { toast(e.message); }
  }
  async function sendText() {
    const t = $('chatInput').value.trim();
    if (!t || !currentPeer) return;
    $('chatInput').value = ''; autoGrow();
    const replyTo = quoteTarget ? { id: String(quoteTarget._id), fromName: quoteTarget.fromName || '', preview: msgPreview(quoteTarget).slice(0, 80), type: quoteTarget.type || 'text' } : null;
    clearQuote();
    try {
      const j = await authFetch('/api/messages', { method: 'POST', body: JSON.stringify({ peer: currentPeer, text: t, replyTo }) });
      if (addMsg(j.message)) renderMsgs(msgs);
    } catch (e) { toast(e.message); $('chatInput').value = t; }
  }
  async function sendFile(f) {
    if (!f || !currentPeer) return;
    if (f.size > 100 * 1024 * 1024) return toast('文件不能超过100MB');
    toast('上传中：' + f.name + '…', 8000);
    const replyTo = quoteTarget ? { id: String(quoteTarget._id), fromName: quoteTarget.fromName || '', preview: msgPreview(quoteTarget).slice(0, 80), type: quoteTarget.type || 'text' } : null;
    clearQuote();
    const fd = new FormData(); fd.append('file', f); fd.append('peer', currentPeer);
    try {
      const up = await authFetch('/api/files', { method: 'POST', body: fd });
      const j = await authFetch('/api/messages/file', { method: 'POST', body: JSON.stringify({ peer: currentPeer, fileId: up.fileId, fileName: up.fileName, fileSize: up.fileSize, replyTo }) });
      if (addMsg(j.message)) renderMsgs(msgs);
      toast('发送成功');
    } catch (e) { toast('上传失败：' + e.message); }
  }

  /* ================= 审核 / 打款 / 驳回 ================= */
  async function cardAct(id, path, body, okMsg) {
    try {
      const j = await authFetch('/api/cards/' + id + '/' + path, { method: 'POST', body: JSON.stringify(body || {}) });
      toast(okMsg);
      await loadChats();
      if (j.syncedOrder) toast(okMsg + '（台账单已同步为「' + j.syncedOrder.status + '」）');
    } catch (e) { toast(e.message); }
  }
  // 查写手收款信息（优先会话缓存，缺失再拉团队）
  function alipayOf(uid) {
    const c = chats.find(x => x.user.id === uid);
    if (c && c.user.alipay && c.user.alipay.account) return c.user.alipay;
    return null;
  }
  window.actApprove = id => { if (confirm('审核通过？通过后该单进入「待打款」，台账订单自动变为「待结算」')) cardAct(id, 'approve', {}, '审核通过 ✅'); };
  window.actReject = id => {
    const reason = prompt('驳回原因（将展示给写手）：');
    if (reason === null) return;
    cardAct(id, 'reject', { reason }, '已驳回，写手可重新做单');
  };
  window.actPay = id => {
    const row = (window._ovRows || []).find(r => r._id === id)
      || ((window._reconItems || []).find(i => i.card._id === id) || {}).card || {};
    const ali = alipayOf(row.to);
    let msg = '确认已打款 ¥' + row.reward + ' 给 ' + row.toName + '？\n台账订单将自动变为「已结算」';
    if (ali) msg = '💸 打款前请核对收款方式：\n\n收款人：' + ali.name + '\n支付宝账号：' + ali.account + '\n\n' + msg;
    else msg = '⚠️ 该写手未绑定收款方式，请线下与其确认。\n\n' + msg;
    if (confirm(msg)) cardAct(id, 'pay', {}, '打款完成 💸');
  };
  window.actSync = id => { if (confirm('将该卡关联的台账订单标记为「已结算」？')) cardAct(id, 'syncorder', {}, '台账已同步 ✅'); };

  /* ================= 发派单卡（订单选择器带搜索） ================= */
  let pickedOrder = null, ordPool = [];
  $('btnNewCard').onclick = async () => {
    if (!currentPeer) return toast('先在左侧选择要派单的写手');
    const writer = chats.find(c => c.user.id === currentPeer);
    if (!writer) return toast('找不到写手信息');
    pickedOrder = null;
    $('sheet').innerHTML = `<button class="close-x" onclick="closeSheet()">✕</button>
      <h3>🃏 发派单卡 → ${esc(writer.user.displayName)}</h3>
      <div class="frow"><label>标题 *</label><input id="ncTitle" placeholder="如：XX项目文案撰写"></div>
      <div class="f2">
        <div class="frow"><label>报酬（元）*</label><input id="ncReward" type="number" min="0" step="0.01" placeholder="0.00"></div>
        <div class="frow"><label>截止日期（选填）</label><input id="ncDeadline" type="date"></div>
      </div>
      <div class="frow"><label>从台账选择订单 *（支持单号/备注搜索，按状态筛选）</label>
        <div class="ord-picker">
          <div class="ph">
            <input id="ordQ" placeholder="🔍 搜单号 / 备注…">
            <select id="ordSt">
              <option value="">全部状态</option>
              <option>待开始</option><option>进行中</option><option>待结算</option><option>已结算</option>
            </select>
          </div>
          <div id="ordList"><div class="empty" style="padding:18px">加载台账中…</div></div>
        </div>
        <div class="sel-summary" id="ordSummary"></div>
      </div>
      <div class="frow"><label>任务要求（选填）</label><textarea id="ncReq" rows="3" placeholder="写清楚交付要求、格式、注意事项…"></textarea></div>
      <div class="frow"><label>附件（选填，≤100MB，云端保留3天）</label>
        <input type="file" id="ncFile" style="padding:7px;font-size:12px">
      </div>
      <div style="display:flex;gap:8px"><button class="btn btn-g" style="flex:1" id="ncSend">发送派单卡</button></div>`;
    $('mask').classList.add('show');
    $('ordQ').oninput = paintOrdList;
    $('ordSt').onchange = paintOrdList;
    $('ncSend').onclick = submitCard;
    try {
      const j = await authFetch('/api/orders');
      ordPool = j.orders;
      paintOrdList();
    } catch (e) { $('ordList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  };
  function paintOrdList() {
    const q = $('ordQ').value.trim().toLowerCase();
    const st = $('ordSt').value;
    const rows = ordPool.filter(o => {
      if (st && o.status !== st) return false;
      if (q && ![o.orderNo, o.note, o.date].some(x => String(x || '').toLowerCase().includes(q))) return false;
      return true;
    }).slice(0, 80);
    $('ordList').innerHTML = rows.length ? rows.map(o => `
      <div class="ord-row ${pickedOrder && pickedOrder._id === o._id ? 'sel' : ''}" data-id="${o._id}">
        <span class="no">${esc(o.orderNo)}</span>
        <span class="info">${esc(o.date)} · ${esc(o.note || '无备注')}</span>
        <span class="amt">¥${o.amount}</span>
        ${stPill(o.status)}
      </div>`).join('') : '<div class="empty" style="padding:18px">没有匹配的订单，换个关键词试试</div>';
    shDoc.querySelectorAll('.ord-row').forEach(el => el.onclick = () => {
      pickedOrder = ordPool.find(o => o._id === el.dataset.id);
      paintOrdList();
      const share = Math.round(pickedOrder.amount * pickedOrder.shareRate) / 100;
      $('ordSummary').classList.add('show');
      $('ordSummary').textContent = '已选：' + pickedOrder.orderNo + '（' + pickedOrder.date + '）· 金额 ¥' + pickedOrder.amount + ' · 分成 ¥' + share;
    });
  }
  async function submitCard() {
    const title = $('ncTitle').value.trim();
    const reward = Number($('ncReward').value);
    if (!title) return toast('标题不能为空');
    if (!isFinite(reward) || reward < 0) return toast('报酬必须是≥0的数字');
    if (!pickedOrder) return toast('必须从台账选择一个订单');
    const btn = $('ncSend'); btn.disabled = true; btn.textContent = '发送中…';
    try {
      let fileId = '', fileName = '';
      const f = $('ncFile').files[0];
      if (f) {
        if (f.size > 100 * 1024 * 1024) { toast('附件不能超过100MB'); btn.disabled = false; btn.textContent = '发送派单卡'; return; }
        toast('上传附件中…', 6000);
        const fd = new FormData(); fd.append('file', f); fd.append('peer', currentPeer);
        const up = await authFetch('/api/files', { method: 'POST', body: fd });
        fileId = up.fileId; fileName = up.fileName;
      }
      await authFetch('/api/cards', { method: 'POST', body: JSON.stringify({
        to: currentPeer, title, reward, deadline: $('ncDeadline').value,
        orderId: pickedOrder._id, requirement: $('ncReq').value.trim(), fileId, fileName,
      }) });
      closeSheet();
      toast('派单卡已发出 ✅');
      loadChats().catch(() => {});
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = '发送派单卡'; }
  }
  window.closeSheet = () => $('mask').classList.remove('show');
  $('mask').onclick = e => { if (e.target === $('mask')) closeSheet(); };

  /* ================= 邀请码 ================= */
  $('btnInvite').onclick = async () => {
    let codes = [];
    try { const j = await authFetch('/api/invites'); codes = j.invites || []; } catch (e) {}
    $('sheet').innerHTML = `<button class="close-x" onclick="closeSheet()">✕</button>
      <h3>🎟️ 写手邀请码</h3>
      <div style="margin-bottom:12px"><button class="btn btn-g btn-sm" id="invNew">＋ 生成新邀请码</button></div>
      <div id="invList">${codes.length ? codes.map(c => `<div class="kv"><span class="k">${esc(c.code)}</span><span class="v" style="color:var(--sub)">${c.usedBy ? '已被使用' : '未使用'}</span></div>`).join('') : '<div class="empty">还没有邀请码，点上面按钮生成</div>'}</div>`;
    $('mask').classList.add('show');
    $('invNew').onclick = async () => {
      try {
        const j = await authFetch('/api/invites', { method: 'POST', body: '{}' });
        $('invList').insertAdjacentHTML('afterbegin', '<div class="kv"><span class="k" style="color:var(--green-dk);font-weight:700">' + esc(j.invite.code) + '</span><span class="v" style="color:var(--sub)">未使用</span></div>');
        toast('已生成：' + j.invite.code);
      } catch (e) { toast(e.message); }
    };
  };

  /* ================= 实时推送 + 稳定性 ================= */
  // 【v21.0】socket.io 原来是靠页面里的 <script src> 暴露全局 io；面板里改成按需加载（全局只加一次）
  let socket = null;
  if (typeof window.io !== 'function') {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/socket.io/socket.io.js';
      s.onload = res; s.onerror = () => rej(new Error('socket.io 脚本加载失败'));
      document.head.appendChild(s);
    });
  }
  socket = window.io({
    auth: { token: TOKEN },
    reconnection: true, reconnectionAttempts: Infinity,
    reconnectionDelay: 800, reconnectionDelayMax: 5000, randomizationFactor: 0.5,
    timeout: 20000,
  });
  socket.on('connect', async () => {
    $('connBar').classList.remove('on');
    if (ME) toast('已恢复连接 ✅');
    loadChats().catch(() => {});
  });
  socket.on('disconnect', () => $('connBar').classList.add('on'));
  socket.on('connect_error', () => $('connBar').classList.add('on'));
  socket.on('reconnect', () => $('connBar').classList.remove('on'));

  // 【2026-09-17 性能修复】socket 每条消息/每张卡都触发一次全量 loadChats / loadOverview +
  // renderMsgs 整列表重建——群发或批量审批时页面狂重绘、明显掉帧。改为 500ms 防抖合并
  let _sockChatTimer = null, _sockCardTimer = null;
  function scheduleChatsReload() {
    if (_sockChatTimer) return;
    _sockChatTimer = setTimeout(() => { _sockChatTimer = null; loadChats().catch(() => {}); }, 500);
  }

  // 【v21.0】面板可见性判断用「实际渲染尺寸」而不是 offsetParent ——
  // 实测这里 offsetParent 恒为 null（面板明明高 900px），会把实时刷新整个判掉。
  const panelVisible = () => { const r = host.getBoundingClientRect(); return r.height > 0 && r.width > 0; };
  let _dirty = false;
  socket.on('msg', m => {
    // 只收属于当前会话的消息：会话键=双方id排序拼接，防止串台
    const convKey = currentPeer && ME ? [String(ME.id), String(currentPeer)].sort().join(':') : null;
    if (currentPeer && m.conversation === convKey) {
      if (addMsg(m) && panelVisible()) renderMsgs(msgs); else if (!panelVisible()) _dirty = true;
    }
    scheduleChatsReload();
    if (m.type === 'file') toast((m.fromName || '') + ' 发来文件：' + m.fileName);
  });
  socket.on('card', c => {
    cardsAll[c._id] = c;
    if (panelVisible()) renderMsgs(msgs); else _dirty = true;
    // 【2026-09-17 性能修复】卡片更新同样防抖：只挂起一次刷新，批量更新只刷一次
    if (!_sockCardTimer) {
      _sockCardTimer = setTimeout(() => {
        _sockCardTimer = null;
        scheduleChatsReload();
      }, 500);
    }
    toast('派单卡更新：' + c.title + ' → ' + c.status);
  });
  socket.on('presence', p => {
    const c = chats.find(x => x.user.id === p.userId);
    if (!c || !panelVisible()) return;
    if (p.sockOnline !== undefined) c.user.sockOnline = p.sockOnline;
    if (p.shift !== undefined) c.user.shift = p.shift;
    renderConvList();
    if (p.userId === currentPeer) {
      $('peerDot').className = 'dot ' + (c.user.sockOnline ? 'd-on' : 'd-off');
      $('peerSt').textContent = (c.user.sockOnline ? '在线' : '离线') + (c.user.shift ? ' · 在班' : '');
    }
  });

  /* ================= 输入事件 ================= */
  function autoGrow() {
    const el = $('chatInput');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }
  $('btnSend').onclick = sendText;
  $('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  });
  $('chatInput').addEventListener('input', autoGrow);
  $('btnFile').onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => { const f = e.target.files[0]; if (f) sendFile(f); e.target.value = ''; };
  $('btnLogout').onclick = () => { localStorage.removeItem('jdy_token'); localStorage.removeItem('jdy_user'); if (EMBED) { parent.location.href = '/login.html'; } else location.href = '/login.html'; };

  // 截图粘贴直接发送
  document.addEventListener('paste', e => {
    if (!$('vChat').classList.contains('on') || !currentPeer) return;
    const items = (e.clipboardData || window.clipboardData)?.items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        e.preventDefault();
        const blob = it.getAsFile();
        if (blob) {
          const ext = (it.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          sendFile(new File([blob], '截图_' + Date.now() + '.' + ext, { type: it.type }));
        }
        return;
      }
    }
  });

  // 拖拽发送：文件直接发；文件夹递归收集后二次确认
  let dragDepth = 0;
  function entryFiles(entry) {
    return new Promise(resolve => {
      if (!entry) return resolve([]);
      if (entry.isFile) {
        entry.file(f => resolve([f]), () => resolve([]));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        const readBatch = () => reader.readEntries(async ents => {
          if (!ents.length) {
            const sub = [];
            for (const en of all) sub.push(...await entryFiles(en));
            return resolve(sub);
          }
          all.push(...ents); readBatch();
        }, () => resolve([]));
        readBatch();
      } else resolve([]);
    });
  }
  const chatRight = $('chatRight');
  chatRight.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; chatRight.classList.add('dragging'); });
  chatRight.addEventListener('dragover', e => e.preventDefault());
  chatRight.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; chatRight.classList.remove('dragging'); } });
  chatRight.addEventListener('drop', async e => {
    e.preventDefault(); dragDepth = 0; chatRight.classList.remove('dragging');
    if (!currentPeer) return toast('先选择会话');
    const items = [...(e.dataTransfer.items || [])];
    const entries = items.map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    let files = [];
    if (entries.length && entries.some(en => en.isDirectory)) {
      for (const en of entries) files.push(...await entryFiles(en));
      files = files.filter(f => f.size <= 25 * 1024 * 1024);
      if (!files.length) return toast('文件夹里没有可发送的文件（单个≤100MB）');
      if (!confirm('文件夹「' + (entries[0].name) + '」共 ' + files.length + ' 个文件（总计 ' + fmtSize(files.reduce((s, f) => s + f.size, 0)) + '），确认全部发送？')) return;
    } else {
      files = [...(e.dataTransfer.files || [])];
    }
    toast('开始发送 ' + files.length + ' 个文件…', 6000);
    for (const f of files) await sendFile(f);
  });

  /* ================= 启动 ================= */
  (async () => {
    // 【v21.0】原来 /api/me 抛错就会让整个面板静默空白（未捕获的 promise rejection）。
    // 现在即使拿不到用户信息，也照样把会话列表拉出来。
    try {
      const j = await authFetch('/api/me');
      ME = j.user;
    } catch (e) { toast('用户信息载入失败：' + (e.message || '')); }
    try {
      const cj = await authFetch('/api/dispatch/overview');
      (cj.rows || []).forEach(c => { cardsAll[c._id] = Object.assign(cardsAll[c._id] || {}, c); });
    } catch (e) {}
    loadChats().catch(e => toast(e.message));
  })();

  // 行内 onclick 的落点（模块作用域里的函数不是全局的）
  // 注意：actApprove / actReject / actPay / closeSheet 原页面就是 window.xxx = ...，仍然是全局，不在这里
  host.__ledger = {
    pGo, clearQuote, closePreview, jumpToMsg, setQuote, openPreview,
    logout: () => {
      localStorage.removeItem('jdy_token');
      localStorage.removeItem('jdy_user');
      location.href = '/login.html';
    },
  };
  // 行内还有 setQuote(msgs.find(...)) —— msgs 会被整体重新赋值，用 getter 桥接
  Object.defineProperty(host.__ledger, 'msgs', { get: () => msgs, configurable: true });

  return {
    refresh: () => loadChats().then(() => { if (currentPeer) return openChat(currentPeer); }),
  };
}
