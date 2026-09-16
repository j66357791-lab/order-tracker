wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 优化 openChat：减少 renderConvList 调用
old_open = """async function openChat(peer) {
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
  // 拉取卡片数据用于聊天里的卡片气泡
  try { const cj = await authFetch('/api/mycards'); cj.cards.forEach(c => cardsMap[c._id] = c); renderMsgs(msgs); } catch (e) {}
}"""

new_open = """async function openChat(peer) {
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
}
// 只更新未读角标，不重新渲染列表
function updateUnreadBadge() {
  const totalUnread = chats.reduce((s, c) => s + (c.unread || 0), 0);
  const tu = $('tabUnread'); if (tu) { tu.style.display = totalUnread ? 'flex' : 'none'; tu.textContent = totalUnread > 99 ? '99+' : totalUnread; }
}"""

if old_open in w:
    w = w.replace(old_open, new_open)
    print("openChat 已优化")
else:
    print("未找到openChat原文")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
