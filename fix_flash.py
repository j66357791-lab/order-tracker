wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 加一个增量更新函数：只更新变化的会话，不重建整个列表
incremental_update = """
// 增量更新单个会话（收到新消息时调用，不重建整个列表）
function updateConvItem(peerId) {
  const idx = chats.findIndex(c => String(c.user.id) === String(peerId));
  if (idx < 0) return;
  const c = chats[idx];
  const el = document.querySelector('.conv[data-id="' + CSS.escape(String(peerId)) + '"]');
  if (!el) { renderConvList(); return; } // 找不到就重建

  // 更新最后一条消息预览
  const lastEl = el.querySelector('.last');
  if (lastEl) {
    lastEl.textContent = c.last ? (c.last.type === 'text' ? (c.last.text || '').slice(0, 18) : c.last.type === 'file' ? '[文件]' : '[派单卡]') : '开始沟通';
  }
  // 更新未读数
  const oldUnread = el.querySelector('.unread');
  if (c.unread) {
    if (oldUnread) oldUnread.textContent = c.unread > 99 ? '99+' : c.unread;
    else {
      const badge = document.createElement('div');
      badge.className = 'unread';
      badge.textContent = c.unread > 99 ? '99+' : c.unread;
      el.appendChild(badge);
    }
  } else if (oldUnread) oldUnread.remove();

  // 移到最上面（搜索框下面）
  const convList = $('convList');
  const searchBox = convList.querySelector('input');
  if (convList.firstElementChild !== el) {
    if (searchBox) {
      convList.insertBefore(el, searchBox.nextSibling);
    } else {
      convList.insertBefore(el, convList.firstChild);
    }
  }
  updateUnreadBadge();
}
"""
w = w.replace("function renderConvList() {", incremental_update + "\nfunction renderConvList() {")

# 修改socket.on('msg')：收到消息时调用增量更新，不调用renderConvList
old_local_update = """  // 不重新loadChats，只本地更新会话列表
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
  }"""

new_local_update = """  // 不重新loadChats，只本地增量更新
  const fromId = String(m.from);
  const idx = chats.findIndex(c => String(c.user.id) === fromId);
  if (idx >= 0) {
    chats[idx].last = m;
    if (!isCurrent) chats[idx].unread = (chats[idx].unread || 0) + 1;
    const c = chats.splice(idx, 1)[0];
    chats.unshift(c);
    updateConvItem(fromId); // 只更新这一个会话，不重建整个列表
  } else {
    loadChats().catch(() => {});
  }"""

if old_local_update in w:
    w = w.replace(old_local_update, new_local_update)
    print("增量更新已替换")
else:
    print("未找到本地更新原文")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
