wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# ========== 1. 修复频繁刷新：收到消息不重新loadChats，只更新本地 ==========
old_socket_msg = """socket.on('msg', m => {
  const convKey = currentPeer && ME ? [String(ME.id), String(currentPeer)].sort().join(':') : null;
  const isCurrent = currentPeer && m.conversation === convKey;
  if (isCurrent) {
    if (addMsg(m)) renderMsgs(msgs);
  }
  loadChats().then(() => {
    updateTitleUnread();
    // 不在当前会话时才提醒
    if (!isCurrent) {
      playNotifySound();
      vibratePhone([100, 50, 200]);
      const preview = m.type === 'file' ? '[文件]' : (m.text || '').slice(0, 30);
      showNotifBanner(m.fromName || '新消息', preview);
    }
  }).catch(() => {});
  if (m.type === 'file' && isCurrent) toast((m.fromName || '') + ' 发来文件：' + m.fileName);
});"""

new_socket_msg = """socket.on('msg', m => {
  const convKey = currentPeer && ME ? [String(ME.id), String(currentPeer)].sort().join(':') : null;
  const isCurrent = currentPeer && m.conversation === convKey;
  if (isCurrent) {
    if (addMsg(m)) renderMsgs(msgs);
  }
  // 不重新loadChats，只本地更新会话列表
  const fromId = String(m.from);
  const idx = chats.findIndex(c => String(c.user.id) === fromId);
  if (idx >= 0) {
    chats[idx].last = m;
    if (!isCurrent) chats[idx].unread = (chats[idx].unread || 0) + 1;
    // 移到最上面
    const c = chats.splice(idx, 1)[0];
    chats.unshift(c);
    renderConvList();
  } else {
    // 新会话，需要重新获取
    loadChats().catch(() => {});
  }
  updateTitleUnread();
  if (!isCurrent) {
    playNotifySound();
    vibratePhone([100, 50, 200]);
    const preview = m.type === 'file' ? '[文件]' : (m.text || '').slice(0, 30);
    showNotifBanner(m.fromName || '新消息', preview);
  }
  if (m.type === 'file' && isCurrent) toast((m.fromName || '') + ' 发来文件：' + m.fileName);
});"""

if old_socket_msg in w:
    w = w.replace(old_socket_msg, new_socket_msg)
    print("socket消息处理已优化")
else:
    print("未找到socket原文")

# ========== 2. 修复串台：openChat加版本号防止竞态 ==========
old_open = """async function openChat(peer) {
  currentPeer = peer;
  const c = chats.find(x => x.user.id === peer);
  $('peerName').textContent = c ? c.user.displayName : '会话';
  $('peerDot').className = 'dot ' + (c && c.user.sockOnline ? 'd-on' : 'd-off');
  $('peerSt').textContent = c ? ((c.user.sockOnline ? '在线' : '离线') + (c.user.shift ? ' · 在班' : '')) : '';
  msgs = loadCache();
  renderMsgs(msgs);
  // 只更新active状态，不重新渲染整个列表
  document.querySelectorAll('.conv').forEach(el => el.classList.toggle('on', el.dataset.id === String(peer)));
  try {
    const j = await authFetch('/api/messages?peer=' + peer);
    const map = new Map(msgs.map(m => [m._id, m]));
    j.messages.forEach(m => map.set(m._id, m));
    msgs = [...map.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    saveCache(msgs);
    renderMsgs(msgs);
    const ch = chats.find(x => x.user.id === peer); if (ch) { ch.unread = 0; updateUnreadBadge(); }
  } catch (e) { toast(e.message); }
  // 卡片数据只在第一次加载时拉取
  if (!cardsMap._loaded) {
    try { const cj = await authFetch('/api/mycards'); cj.cards.forEach(c => cardsMap[c._id] = c); cardsMap._loaded = true; renderMsgs(msgs); } catch (e) {}
  }
}"""

new_open = """let openChatVersion = 0;
async function openChat(peer) {
  currentPeer = peer;
  const myVer = ++openChatVersion;
  const c = chats.find(x => x.user.id === peer);
  $('peerName').textContent = c ? c.user.displayName : '会话';
  $('peerDot').className = 'dot ' + (c && c.user.sockOnline ? 'd-on' : 'd-off');
  $('peerSt').textContent = c ? ((c.user.sockOnline ? '在线' : '离线') + (c.user.shift ? ' · 在班' : '')) : '';
  msgs = loadCache();
  renderMsgs(msgs);
  // 只更新active状态，不重新渲染整个列表
  document.querySelectorAll('.conv').forEach(el => el.classList.toggle('on', el.dataset.id === String(peer)));
  try {
    const j = await authFetch('/api/messages?peer=' + peer);
    // 检查是否已经切换到别的会话了，是的话丢弃这次结果
    if (myVer !== openChatVersion) return;
    const map = new Map(msgs.map(m => [m._id, m]));
    j.messages.forEach(m => map.set(m._id, m));
    msgs = [...map.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    saveCache(msgs);
    renderMsgs(msgs);
    const ch = chats.find(x => x.user.id === peer); if (ch) { ch.unread = 0; updateUnreadBadge(); }
  } catch (e) { if (myVer === openChatVersion) toast(e.message); }
  // 卡片数据只在第一次加载时拉取
  if (!cardsMap._loaded) {
    try { const cj = await authFetch('/api/mycards'); cj.cards.forEach(c => cardsMap[c._id] = c); cardsMap._loaded = true; if (myVer === openChatVersion) renderMsgs(msgs); } catch (e) {}
  }
}"""

if old_open in w:
    w = w.replace(old_open, new_open)
    print("openChat竞态已修复")
else:
    print("未找到openChat原文")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
