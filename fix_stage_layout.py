wp = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\index.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

old = '''      <!-- 出战 -->
      <div class="home-tab on" id="tabFight">
        <div class="stage-head"><span class="sh-line"></span><h3>斩妖路</h3><span class="sh-line"></span></div>
        <div class="stage-list" id="stageList"></div>
        <div class="daily-tip" id="dailyTip">每局皆得妖丹 · 首通另有重赏</div>
      </div>'''

new = '''      <!-- 出战 -->
      <div class="home-tab on" id="tabFight">
        <div class="stage-visual">
          <div class="stage-arrow left" id="stagePrev">‹</div>
          <div class="stage-mountain">
            <img src="/games/shanhai/assets/mountain-main.png" alt="">
            <div class="stage-name" id="stageName">南山草泽</div>
            <div class="stage-sub" id="stageSub">15 波 · 山臊王</div>
            <div class="stage-stars" id="stageStars">☆☆☆</div>
          </div>
          <div class="stage-arrow right" id="stageNext">›</div>
        </div>
        <div class="stage-actions">
          <button class="btn-stage-big" id="btnEnterBattle">出 战</button>
        </div>
        <div class="daily-tip">每局皆得妖丹 · 首通另有重赏</div>
      </div>'''

if old in w:
    w = w.replace(old, new)
    print("HTML结构已修改")
else:
    print("未找到原HTML")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
