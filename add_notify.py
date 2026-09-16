wp = r'C:\Users\某某\Desktop\接单后台\public\writer.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 1. 在socket.on('msg')前加通知工具函数
notify_utils = """
/* ================= 消息通知工具 ================= */
let audioCtx = null;
function playNotifySound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.3, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
    o.start(audioCtx.currentTime);
    o.stop(audioCtx.currentTime + 0.3);
  } catch(e) {}
}
function vibratePhone(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern || [100, 50, 100]); } catch(e) {}
}
let notifBannerTimer = null;
function showNotifBanner(name, preview) {
  let bar = document.getElementById('notifBanner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'notifBanner';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:12px 16px;display:flex;align-items:center;gap:10px;box-shadow:0 2px 12px rgba(0,0,0,.2);transform:translateY(-100%);transition:transform .3s ease;font-size:13px';
    document.body.appendChild(bar);
  }
  bar.innerHTML = '<div style="width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:18px">💬</div><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:14px">' + name + '</div><div style="opacity:.9;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + preview + '</div></div><div style="font-size:11px;opacity:.7">点击查看</div>';
  bar.style.transform = 'translateY(0)';
  bar.onclick = () => { bar.style.transform = 'translateY(-100%)'; openChatByName(name); };
  if (notifBannerTimer) clearTimeout(notifBannerTimer);
  notifBannerTimer = setTimeout(() => { bar.style.transform = 'translateY(-100%)'; }, 4000);
}
function updateTitleUnread() {
  const total = chats.reduce((s, c) => s + (c.unread || 0), 0);
  document.title = total > 0 ? `(${total}) 写手工作台` : '写手工作台';
}
async function openChatByName(name) {
  try {
    await loadChats();
    const c = chats.find(x => x.user.displayName === name);
    if (c) openChat(c.user.id);
  } catch(e) {}
}
"""
w = w.replace("socket.on('msg', m => {", notify_utils + "\nsocket.on('msg', m => {")

# 2. 修改socket.on('msg')处理：加声音、震动、横幅
old_msg = """socket.on('msg', m => {
  // 只收属于当前会话的消息：会话键=双方id排序拼接，防止别人聊天串台进当前窗口
  const convKey = currentPeer && ME ? [String(ME.id), String(currentPeer)].sort().join(':') : null;
  if (currentPeer && m.conversation === convKey) {
    if (addMsg(m)) renderMsgs(msgs);
  }
  loadChats().catch(() => {});
  if (m.type === 'file') toast((m.fromName || '') + ' 发来文件：' + m.fileName);
});"""

new_msg = """socket.on('msg', m => {
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

if old_msg in w:
    w = w.replace(old_msg, new_msg)
    print("消息通知功能已添加")
else:
    print("未找到原文")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
