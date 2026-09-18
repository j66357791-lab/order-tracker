// admin/mod-security.js — 网站安全与用户管理面板（方案二第二步迁入，来源 admin_security.html）
// 平台账号 / 密码重置 / 查人 / 站内信 / 部署核验 / 危险操作
// 注意：清对局 / 清钥匙已归游戏控制器，本面板危险操作只保留"清空全站聊天"
import { api, esc, toast, cnTime, copyText } from './app.js';

export function mount(root) {
  root.innerHTML = `
  <div class="content-head">
    <div><h1 class="serif">网站安全与用户管理</h1><div class="sub">平台账号 / 密码重置 / 站内信 / 部署核验 / 危险操作</div></div>
    <div class="spacer"></div>
    <button class="btn-ghost" id="secRefresh">刷新数据</button>
  </div>

  <div class="card">
    <h2 class="serif">平台账号</h2>
    <div class="sub">最近注册的 50 个账号 · 密码与身份证信息已脱敏，不会显示</div>
    <div class="inline" style="margin-bottom:12px">
      <input id="secFindKey" placeholder="按手机号（用户名）或 7 位工号精确查找">
      <button class="btn-main" id="secFindGo">查找用户</button>
    </div>
    <div id="secFindResult"></div>
    <div class="table-wrap" id="secUserTable"><div class="empty">加载中…</div></div>
  </div>

  <div class="card">
    <h2 class="serif">发送站内信</h2>
    <div class="sub">写给手端顶部 ✉ 站内信；全体发送或按用户ID定向（在上方用户列表点击ID复制）</div>
    <div class="f-row"><label>发送范围</label><select id="secNtTarget"><option value="all">全体写手</option><option value="one">定向用户（填用户ID）</option></select></div>
    <div class="f-row" id="secNtOneRow" style="display:none"><label>目标用户ID</label><input id="secNtOne" placeholder="用户列表里的 _id"></div>
    <div class="f-row"><label>标题</label><input id="secNtTitle" maxlength="60" placeholder="例如：本周结算通知"></div>
    <div class="f-row"><label>内容</label><textarea id="secNtBody" rows="4" maxlength="3000" placeholder="正文，支持换行"></textarea></div>
    <div class="err" id="secNtErr"></div>
    <button class="btn-main" id="secNtGo">发送</button>
  </div>

  <div class="card">
    <h2 class="serif">部署文件核验</h2>
    <div class="sub">校验线上关键文件是否齐全（完整清单含哈希指纹，仅管理员可见）</div>
    <div id="secDeploy"><div class="empty">加载中…</div></div>
    <button class="btn-ghost" id="secDeployRe" style="margin-top:12px">重新核验</button>
  </div>

  <div class="card danger">
    <h2 class="serif">⚠ 危险操作</h2>
    <div class="sub">以下操作不可恢复，务必确认后再执行（清理对局 / 清钥匙在「游戏控制器」）</div>
    <div class="inline" style="margin-bottom:12px">
      <button class="btn-danger" id="secClearChats">清空全站聊天记录</button>
    </div>
    <div class="warn-box">
      清空聊天：删除全站全部聊天消息与会话，写手端本地留有兜底，但云端不可恢复——
      需在输入框输入「清空全部聊天」并回车后才可点按钮。
    </div>
    <div class="f-row" style="margin-top:10px"><input id="secClearConfirm" placeholder="输入：清空全部聊天"></div>
  </div>`;

  const $ = id => root.querySelector('#' + id);
  let _USERS = [];

  // ---------- 用户列表 ----------
  async function loadUsers() {
    try {
      const j = await api('/api/admin/users');
      if (!j.ok) { $('secUserTable').innerHTML = '<div class="empty">' + esc(j.error || '加载失败') + '</div>'; return; }
      if (!j.users.length) { $('secUserTable').innerHTML = '<div class="empty">暂无账号</div>'; return; }
      _USERS = j.users;
      $('secUserTable').innerHTML = `<table>
        <tr><th>用户名</th><th>昵称</th><th>角色</th><th>工号</th><th>实名</th><th>注册时间</th><th>密码状态</th><th>用户ID</th><th>操作</th></tr>
        ${j.users.map(u => `<tr>
          <td class="num">${esc(u.username)}</td>
          <td>${esc(u.displayName || '-')}</td>
          <td><span class="tag t-${u.role}">${u.role === 'admin' ? '管理员' : u.role === 'writer' ? '写手' : '用户'}</span></td>
          <td class="num">${esc(u.uid || '—')}</td>
          <td>${u.realname && u.realname.idMask ? esc(u.realname.name) + ' ' + esc(u.realname.idMask) : '<span style="color:var(--ink2)">未实名</span>'}</td>
          <td class="num">${u.createdAt ? cnTime(u.createdAt) : '-'}</td>
          <td style="font-size:11.5px">${u.passwordResetAt ? '<span style="color:var(--ochre)">已重置 ' + cnTime(u.passwordResetAt) + '</span>' : '<span style="color:var(--ink2)">原始密码</span>'}</td>
          <td><span class="num" style="font-size:11px;color:var(--ink2);cursor:pointer" title="点击复制" onclick="secCopyUid('${u._id}')">${esc(String(u._id).slice(0, 8))}…</span></td>
          <td><button class="btn-ghost" style="padding:4px 10px;font-size:12px" onclick="secResetPw('${u._id}')">重置密码</button></td>
        </tr>`).join('')}
      </table>
      <div style="font-size:12px;color:var(--ink2);margin-top:10px">密码为加密存储，任何人都无法查看原文；用户忘记密码时用「重置密码」生成临时密码转告ta即可。</div>`;
    } catch (e) { $('secUserTable').innerHTML = '<div class="empty">加载失败，刷新重试</div>'; }
  }
  window.secCopyUid = (id) => copyText(id);
  window.secResetPw = async (id) => {
    const u = _USERS.find(x => String(x._id) === String(id));
    const name = u ? (u.displayName || u.username || '该用户') : '该用户';
    const pw = prompt('为「' + name + '」设置新密码（至少 8 位）。\n留空并点确定 = 自动生成 8 位临时密码：', '');
    if (pw === null) return;
    if (pw && pw.length < 8) { toast('密码至少 8 位'); return; }
    if (!confirm('确认重置「' + name + '」的密码？原密码将立即失效。')) return;
    try {
      const j = await api('/api/admin/users/' + id + '/reset-password', { method: 'POST', body: JSON.stringify({ newPassword: pw || '' }) });
      if (!j.ok) { toast(j.error || '重置失败'); return; }
      prompt('✅ 已重置！把下面的临时密码转告用户「' + (j.username || name) + '」即可登录：\n（选中后 Ctrl+C 复制；本次重置已写入审计日志）', j.tempPassword);
      loadUsers();
    } catch (e) { toast('网络异常，稍后再试'); }
  };

  // ---------- 查找用户 ----------
  $('secFindGo').onclick = async () => {
    const key = $('secFindKey').value.trim();
    $('secFindResult').innerHTML = '';
    if (!key) return toast('输入手机号或工号');
    try {
      const j = await api('/api/admin/find-user/' + encodeURIComponent(key));
      if (!j.ok) { $('secFindResult').innerHTML = '<div class="empty">' + esc(j.error || '未找到') + '</div>'; return; }
      const u = j.user;
      $('secFindResult').innerHTML = `<div class="ok-box">找到用户：<b>${esc(u.name || '-')}</b> · 手机号/账号 ${esc(u.phone || '-')} · 工号 ${esc(u.uid || '—')} · 用户ID <b>${esc(u._id)}</b>
        <button class="btn-ghost" style="margin-left:10px;padding:4px 12px;font-size:12px" onclick="secCopyUid('${esc(u._id)}')">复制ID（可去发道具/站内信）</button></div>`;
    } catch (e) { $('secFindResult').innerHTML = '<div class="empty">查找失败</div>'; }
  };
  $('secFindKey').addEventListener('keydown', e => { if (e.key === 'Enter') $('secFindGo').click(); });

  // ---------- 站内信 ----------
  $('secNtTarget').onchange = () => { $('secNtOneRow').style.display = $('secNtTarget').value === 'one' ? '' : 'none'; };
  $('secNtGo').onclick = async () => {
    const title = $('secNtTitle').value.trim(), content = $('secNtBody').value.trim();
    const one = $('secNtTarget').value === 'one';
    $('secNtErr').textContent = '';
    if (!title || !content) { $('secNtErr').textContent = '标题和内容不能为空'; return; }
    if (one && !$('secNtOne').value.trim()) { $('secNtErr').textContent = '请填写目标用户ID'; return; }
    $('secNtGo').disabled = true; $('secNtGo').textContent = '发送中…';
    try {
      const j = await api('/api/notify', { method: 'POST', body: JSON.stringify({ title, content, target: one ? $('secNtOne').value.trim() : 'all' }) });
      if (!j.ok) $('secNtErr').textContent = j.error || '发送失败';
      else { toast('已送达 ' + j.count + ' 位写手 ✓'); $('secNtTitle').value = ''; $('secNtBody').value = ''; }
    } catch (e) { $('secNtErr').textContent = '网络异常，稍后再试'; }
    $('secNtGo').disabled = false; $('secNtGo').textContent = '发送';
  };

  // ---------- 部署核验 ----------
  async function loadDeploy() {
    $('secDeploy').innerHTML = '<div class="empty">核验中…</div>';
    try {
      const j = await api('/api/deploy-check/detail');
      if (!j.ok) { $('secDeploy').innerHTML = '<div class="empty">核验失败</div>'; return; }
      $('secDeploy').innerHTML = j.missingCount === 0
        ? `<div class="ok-box"><span class="sec-ok">✓ 全部 ${j.filesTotal} 个关键文件在线且齐全</span> · 版本 v${esc(j.version)} · 完整指纹清单见下方详情</div>
           <details style="margin-top:10px"><summary style="cursor:pointer;font-size:12.5px;color:var(--ink2)">展开完整指纹清单</summary>
           <div style="max-height:220px;overflow:auto;margin-top:8px">${Object.entries(j.files).map(([f, v]) => `<div class="num" style="font-size:11px;padding:2px 0;border-bottom:1px dashed var(--line);display:flex;justify-content:space-between;gap:10px"><span>${esc(f)}</span><span style="color:var(--ink2)">${v.MISSING ? '<b class="sec-bad">缺失</b>' : v.kb + 'KB · ' + v.sha8}</span></div>`).join('')}</div></details>`
        : `<div class="warn-box"><span class="sec-bad">✗ 有 ${j.missingCount} 个文件缺失</span>（共 ${j.filesTotal} 个）：<br>${j.missing.map(m => '· ' + esc(m)).join('<br>')}<br>请重新运行同步脚本补传后刷新本页。</div>`;
    } catch (e) { $('secDeploy').innerHTML = '<div class="empty">核验失败，稍后再试</div>'; }
  }
  $('secDeployRe').onclick = loadDeploy;

  // ---------- 危险操作：清空聊天 ----------
  $('secClearChats').onclick = async () => {
    if ($('secClearConfirm').value !== '清空全部聊天') { toast('请先在输入框输入「清空全部聊天」'); return; }
    if (!confirm('最后确认：全站聊天记录将被永久删除！')) return;
    try {
      const j = await api('/api/admin/clear-chats', { method: 'POST', body: JSON.stringify({ confirm: '清空全部聊天' }) });
      if (j.ok) { toast('已清空：消息 ' + j.messages + ' 条 · 会话 ' + j.chats + ' 个'); $('secClearConfirm').value = ''; }
      else toast(j.error || '操作失败');
    } catch (e) { toast('网络异常'); }
  };

  loadUsers(); loadDeploy();
  return { refresh: () => { loadUsers(); loadDeploy(); } };
}
