wp = r'C:\Users\某某\Desktop\接单后台\public\games\shanhai\index.html'
with open(wp, 'r', encoding='utf-8') as f:
    w = f.read()

old = '''  // —— 封面 → 加载 ——
  $("scrCover").addEventListener("click", () => {
    showScreen("scrLoad");
    Assets.load("assets/sprites", (done, total, name) => {
      const pct = Math.round(done / total * 100);
      $("loadPct").textContent = pct + "%";
      $("ringFg").style.strokeDashoffset = 327 - 327 * pct / 100;
      const tips = ["山河入梦…", "异兽蠢蠢欲动…", "御火者披挂上阵…", "妖丹淬炼中…"];
      $("loadTip").textContent = tips[Math.floor(done / total * tips.length)] || tips[0];
      $("loadName").textContent = name && !name.includes("…") ? "· " + name + " ·" : "";
    }).then(async () => {
      await META.load();
      renderHome();
      showScreen("scrHome");
    }).catch(e => { $("loadTip").textContent = "加载失败，请刷新重试"; console.error(e); });
  }, { once: true });'''

new = '''  // —— 自动加载资源（进度条在封面上）——
  Assets.load("assets/sprites", (done, total, name) => {
    const pct = Math.round(done / total * 100);
    $("loadPct").textContent = pct + "%";
    $("loadFill").style.width = pct + "%";
    const tips = ["山河入梦…", "异兽蠢蠢欲动…", "御火者披挂上阵…", "妖丹淬炼中…"];
    $("loadTip").textContent = tips[Math.floor(done / total * tips.length)] || tips[0];
  }).then(async () => {
    await META.load();
    renderHome();
    // 加载完，隐藏进度条，显示轻触进入
    $("loadBar").style.display = "none";
    $("tapEnter").style.display = "block";
  }).catch(e => { $("loadTip").textContent = "加载失败，请刷新重试"; console.error(e); });

  // 点封面进入主页
  $("scrCover").addEventListener("click", () => {
    showScreen("scrHome");
  }, { once: true });'''

if old in w:
    w = w.replace(old, new)
    print("加载逻辑已修改")
else:
    print("未找到原代码")

with open(wp, 'w', encoding='utf-8') as f:
    f.write(w)
