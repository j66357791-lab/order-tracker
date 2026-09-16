wp = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\index.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

# 1. 关卡名改成横条框背景
old = '''        <div class="stage-visual">
          <div class="stage-title" id="stageName">1. 南山草泽</div>
          <div class="stage-main">
            <div class="stage-arrow left" id="stagePrev">‹</div>
            <img src="/games/shanhai/assets/bonsai-mountain.png" class="stage-img" alt="">
            <div class="stage-arrow right" id="stageNext">›</div>
          </div>
          <div class="stage-stars" id="stageStars">☆☆☆</div>
          <div class="stage-sub" id="stageSub">15 波 · 山臊王</div>
        </div>'''

new = '''        <div class="stage-visual">
          <div class="stage-title-bar">
            <img src="/games/shanhai/assets/stage-title-bar.png" alt="">
            <span id="stageName">南山草泽</span>
          </div>
          <div class="stage-main">
            <div class="stage-arrow left" id="stagePrev">‹</div>
            <img src="/games/shanhai/assets/bonsai-clean.png" class="stage-img" alt="">
            <div class="stage-arrow right" id="stageNext">›</div>
          </div>
          <div class="stage-level-badge" id="stageLevel">第 一 关</div>
          <div class="stage-stars" id="stageStars">
            <img src="/games/shanhai/assets/star-gold.png" alt="">
            <img src="/games/shanhai/assets/star-gold.png" alt="">
            <img src="/games/shanhai/assets/star-gold.png" alt="">
          </div>
          <div class="stage-sub" id="stageSub">15 波 · 山臊王</div>
        </div>'''

w = w.replace(old, new)
print("HTML结构已改")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
