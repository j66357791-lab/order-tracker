wp = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\index.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 1. 底部导航改成5个：商城、装备、战斗、山海录、挑战
old_nav = '''    <!-- 底部导航 -->
    <nav class="home-nav">
      <div class="hn-item on" data-tab="tabFight"><i>⚔</i>出 战</div>
      <div class="hn-item" data-tab="tabGrow"><i>◉</i>养 成</div>
      <div class="hn-item" data-tab="tabBoard"><i>榜</i>斩妖榜</div>
      <div class="hn-item" data-tab="tabSet"><i>设</i>更 多</div>
    </nav>'''

new_nav = '''    <!-- 底部导航（5个，中间战斗高亮） -->
    <nav class="home-nav nav-ink">
      <div class="hn-item" data-tab="tabShop"><i>🏪</i>商 城</div>
      <div class="hn-item" data-tab="tabGrow"><i>🛡</i>装 备</div>
      <div class="hn-item center on" data-tab="tabFight"><i>⚔</i>战 斗</div>
      <div class="hn-item" data-tab="tabShanhai"><i>📜</i>山海录</div>
      <div class="hn-item" data-tab="tabChallenge"><i>🏆</i>挑 战</div>
    </nav>'''

w = w.replace(old_nav, new_nav)
print("底部导航已改")

# 2. 加新的tab面板（商城、山海录、挑战占位）
old_tabs_end = '''      <!-- 设置 -->
      <div class="home-tab" id="tabSet">
        <div class="set-row"><span>音效</span><b class="soon">第二轮开放</b></div>
        <div class="set-row tap" onclick="location.href='/writer.html?tab=game'"><span>返回网站</span><b>›</b></div>
        <div class="set-row tap" id="btnLogout"><span>退出登录</span><b>›</b></div>
        <div class="set-ver">山海斩妖录 V1.5 · M1.5 养成版</div>
      </div>'''

new_tabs_end = '''      <!-- 商城（占位） -->
      <div class="home-tab" id="tabShop">
        <div class="empty-tip" style="padding:60px 0">商城敬请期待…</div>
      </div>
      <!-- 山海录（占位） -->
      <div class="home-tab" id="tabShanhai">
        <div class="empty-tip" style="padding:60px 0">山海录敬请期待…</div>
      </div>
      <!-- 挑战（占位） -->
      <div class="home-tab" id="tabChallenge">
        <div class="empty-tip" style="padding:60px 0">挑战模式敬请期待…</div>
      </div>'''

w = w.replace(old_tabs_end, new_tabs_end)
print("新tab面板已加")

# 3. 点头像弹出设置弹窗
old_avatar = '''      <div class="tb-user">
        <div class="avatar" id="avChar">御</div>
        <div class="tb-info">
          <b id="tbName">御火行者</b>
          <span id="tbTitle">初入山海</span>
        </div>
      </div>'''

new_avatar = '''      <div class="tb-user" onclick="showUserMenu()" style="cursor:pointer">
        <div class="avatar" id="avChar">御</div>
        <div class="tb-info">
          <b id="tbName">御火行者</b>
          <span id="tbTitle">初入山海</span>
        </div>
      </div>'''

w = w.replace(old_avatar, new_avatar)
print("头像点击已加")

# 4. 排行榜改成小图标放头像下（顶栏加排行榜图标）
old_currency = '''      <div class="tb-currency"><span class="yd-ico">◉</span><b id="tbYadan">0</b></div>'''

new_currency = '''      <div style="display:flex;align-items:center;gap:8px">
        <div class="tb-rank" onclick="showBoard()" style="width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,.3);border:1px solid rgba(212,184,122,.5);display:flex;align-items:center;justify-content:center;cursor:pointer" title="排行榜">🏆</div>
        <div class="tb-currency"><span class="yd-ico">◉</span><b id="tbYadan">0</b></div>
      </div>'''

w = w.replace(old_currency, new_currency)
print("排行榜图标已加")

# 5. 出战页面中间换成盆景山
old_stage_visual = '''        <div class="stage-visual">
          <div class="stage-arrow left" id="stagePrev">‹</div>
          <div class="stage-mountain">
            <img src="/games/shanhai/assets/mountain-main.png" alt="">
            <div class="stage-name" id="stageName">南山草泽</div>
            <div class="stage-sub" id="stageSub">15 波 · 山臊王</div>
            <div class="stage-stars" id="stageStars">☆☆☆</div>
          </div>
          <div class="stage-arrow right" id="stageNext">›</div>
        </div>'''

new_stage_visual = '''        <div class="stage-visual">
          <div class="stage-title" id="stageName">1. 南山草泽</div>
          <div class="stage-main">
            <div class="stage-arrow left" id="stagePrev">‹</div>
            <img src="/games/shanhai/assets/bonsai-mountain.png" class="stage-img" alt="">
            <div class="stage-arrow right" id="stageNext">›</div>
          </div>
          <div class="stage-stars" id="stageStars">☆☆☆</div>
          <div class="stage-sub" id="stageSub">15 波 · 山臊王</div>
        </div>'''

w = w.replace(old_stage_visual, new_stage_visual)
print("出战主视觉已改")

# 6. 加用户菜单弹窗JS（在script里加）
old_script_end = '''  // 点封面进入主页
  $("scrCover").addEventListener("click", () => {
    showScreen("scrHome");
  }, { once: true });'''

new_script_end = '''  // 点封面进入主页
  $("scrCover").addEventListener("click", () => {
    showScreen("scrHome");
  }, { once: true });

  // 用户菜单弹窗
  function showUserMenu() {
    const html = `
      <div id="userMenuMask" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:999;display:flex;align-items:center;justify-content:center" onclick="this.remove()">
        <div style="background:linear-gradient(180deg,#f5f0e0,#e8dcc8);border-radius:16px;padding:20px;width:280px;text-align:center" onclick="event.stopPropagation()">
          <div style="font-size:18px;font-weight:900;color:#3a5a4a;margin-bottom:16px">设置</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            <div style="padding:12px;background:#fff;border-radius:10px;cursor:pointer" onclick="this.parentElement.parentElement.parentElement.remove();alert('音效功能开发中')">🔊 音效设置</div>
            <div style="padding:12px;background:#fff;border-radius:10px;cursor:pointer" onclick="location.href='/writer.html?tab=game'">🏠 返回网站</div>
            <div style="padding:12px;background:#fff;border-radius:10px;cursor:pointer;color:#c0392b" onclick="localStorage.removeItem('jdy_token');localStorage.removeItem('jdy_user');location.href='/login.html'">🚪 退出登录</div>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }
  window.showUserMenu = showUserMenu;

  // 显示排行榜
  function showBoard() {
    document.querySelectorAll('.hn-item').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.home-tab').forEach(x => x.classList.remove('on'));
    document.querySelector('[data-tab="tabChallenge"]').classList.add('on');
    document.getElementById('tabChallenge').classList.add('on');
    // 加载榜单到挑战tab
    if (typeof loadBoard === 'function') loadBoard();
  }
  window.showBoard = showBoard;'''

w = w.replace(old_script_end, new_script_end)
print("用户菜单JS已加")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
print("完成")
