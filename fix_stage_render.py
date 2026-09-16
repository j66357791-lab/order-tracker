wp = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\index.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

old = '''    // 关卡卡
    $("stageList").innerHTML = STAGES.map((s, i) => {
      const stars = (p.stageStars || {})[s.id] || 0;
      const best = s.id === 1 && p.bestTimeSec ? fmtT(p.bestTimeSec) : null;
      return `<div class="stage-card ${s.open ? "" : "locked"}" ${s.open ? `data-stage="${s.id}"` : ""}>
        <div class="st-num">${s.id}</div>
        <div class="st-info"><b>${s.name}</b><span>${s.sub}</span>
          ${s.open ? `<em class="st-stars">${"★".repeat(stars)}${"☆".repeat(3 - stars)}${best ? " · 最快 " + best : ""}</em>` : `<em class="st-lock">🔒 未解锁</em>`}
        </div>
        ${s.open ? `<button class="btn-stage">出 战</button>` : ""}
      </div>`;
    }).join("");
    document.querySelectorAll(".stage-card[data-stage]").forEach(c =>
      c.querySelector(".btn-stage").onclick = () => enterBattle(+c.dataset.stage));'''

new = '''    // 关卡展示（单关卡+左右切换）
    let curStageIdx = 0;
    function renderStage(i) {
      curStageIdx = i;
      const s = STAGES[i];
      const stars = (p.stageStars || {})[s.id] || 0;
      $("stageName").textContent = s.name;
      $("stageSub").textContent = s.sub;
      $("stageStars").textContent = "★".repeat(stars) + "☆".repeat(3 - stars);
      // 左右箭头显示
      document.getElementById("stagePrev").style.opacity = i > 0 ? "1" : ".3";
      document.getElementById("stageNext").style.opacity = i < STAGES.length - 1 ? "1" : ".3";
      // 出战按钮状态
      const btn = document.getElementById("btnEnterBattle");
      if (s.open) {
        btn.disabled = false;
        btn.textContent = "出 战";
      } else {
        btn.disabled = true;
        btn.textContent = "未解锁";
      }
    }
    renderStage(0);
    document.getElementById("stagePrev").onclick = () => { if (curStageIdx > 0) renderStage(curStageIdx - 1); };
    document.getElementById("stageNext").onclick = () => { if (curStageIdx < STAGES.length - 1) renderStage(curStageIdx + 1); };
    document.getElementById("btnEnterBattle").onclick = () => {
      if (STAGES[curStageIdx].open) enterBattle(STAGES[curStageIdx].id);
    };'''

if old in w:
    w = w.replace(old, new)
    print("渲染逻辑已修改")
else:
    print("未找到原渲染代码")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
