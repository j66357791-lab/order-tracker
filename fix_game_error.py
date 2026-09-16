wp = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\index.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 删掉btnLogout那行
old = '''  $("btnQuitBattle").onclick = backHome;
  $("btnLogout").onclick = () => { localStorage.removeItem("jdy_token"); localStorage.removeItem("jdy_user"); location.href = "/login.html"; };'''

new = '''  $("btnQuitBattle").onclick = backHome;'''

if old in w:
    w = w.replace(old, new)
    print("btnLogout错误已修复")
else:
    print("未找到原代码")

# 修复奖杯跳转：改成跳排行榜，不是挑战
old_showboard = '''  // 显示排行榜
  function showBoard() {
    document.querySelectorAll('.hn-item').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.home-tab').forEach(x => x.classList.remove('on'));
    document.querySelector('[data-tab="tabChallenge"]').classList.add('on');
    document.getElementById('tabChallenge').classList.add('on');
    // 加载榜单到挑战tab
    if (typeof loadBoard === 'function') loadBoard();
  }'''

new_showboard = '''  // 显示排行榜
  function showBoard() {
    document.querySelectorAll('.hn-item').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.home-tab').forEach(x => x.classList.remove('on'));
    // 用弹窗显示排行榜，不跳tab
    const mask = document.createElement('div');
    mask.style = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px';
    mask.onclick = () => mask.remove();
    mask.innerHTML = `
      <div style="background:linear-gradient(180deg,#f5f0e0,#e8dcc8);border-radius:16px;padding:20px;width:90%;max-width:320px;max-height:80vh;overflow-y:auto" onclick="event.stopPropagation()">
        <div style="font-size:18px;font-weight:900;color:#3a5a4a;text-align:center;margin-bottom:16px">🏆 斩妖榜</div>
        <div id="boardList" style="font-size:14px;color:#5a6e5a">加载中…</div>
      </div>`;
    document.body.appendChild(mask);
    // 加载榜单数据
    fetch('/api/shanhai/leaderboard', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('jdy_token') } })
      .then(r => r.json())
      .then(d => {
        const el = document.getElementById('boardList');
        if (!el) return;
        el.innerHTML = (d.list || []).map((u, i) => `
          <div style="display:flex;justify-content:space-between;padding:10px;border-bottom:1px solid rgba(0,0,0,.05)">
            <span>${i+1}. ${u.name || '佚名'}</span>
            <span>${u.wins || 0}胜</span>
          </div>`).join('') || '<div style="text-align:center;padding:30px">暂无数据</div>';
      })
      .catch(e => { const el = document.getElementById('boardList'); if(el) el.textContent = '加载失败'; });
  }'''

if old_showboard in w:
    w = w.replace(old_showboard, new_showboard)
    print("排行榜弹窗已改")
else:
    print("未找到showboard代码")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
