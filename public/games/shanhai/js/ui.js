// DOM UI 层：标题/横幅/三选一/结算/HUD
"use strict";
const UI = (() => {
  const $ = id => document.getElementById(id);
  let toastT = null, bannerT = null;

  function showHud() {
    $("hud").style.display = "block";
    $("overlay").style.display = "none";
  }

  function updateHud(hero, waveIdx, boss) {
    // 血条
    const hpPct = Math.max(0, hero.hp / hero.maxHp * 100);
    $("hpFill").style.width = hpPct + "%";
    $("hpText").textContent = `${Math.ceil(hero.hp)} / ${hero.maxHp}`;
    $("hpFill").style.background = hpPct < 25 ? "#E8503C" : "#4CAF50";
    // 经验条
    $("expFill").style.width = (hero.exp / hero.expNext * 100) + "%";
    $("lvText").textContent = `Lv.${hero.level}`;
    // 波次
    $("waveText").textContent = `波次 ${waveIdx + 1}/${CONFIG.waves.length}`;
    // 计时
    const t = Math.floor(hero.timeAlive);
    $("timeText").textContent = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    // 击杀
    $("killText").textContent = `斩妖 ${hero.kills}`;
    // 技能栏
    const skills = [];
    if (hero && window.__weapons) {}
    renderSkills(hero);
    // Boss 血条
    if (boss && boss.alive) {
      $("bossBar").style.display = "block";
      $("bossFill").style.width = Math.max(0, boss.hp / boss.maxHp * 100) + "%";
      $("bossName").textContent = "山臊王";
    } else {
      $("bossBar").style.display = "none";
    }
  }

  function renderSkills(hero) {
    const bar = $("skillBar");
    const ws = window.Game && Game.__weapons;
    bar.innerHTML = "";
    if (!ws) return;
    const icons = { fireline: "火", icepick: "冰", body: "体" };
    const names = { fireline: "凤凰火线", icepick: "寒冰锥", body: "修身体质" };
    for (const [key, s] of Object.entries(ws.slots)) {
      const el = document.createElement("div");
      el.className = "skill-chip";
      const max = CONFIG.weapons[key].maxLv;
      el.innerHTML = `<span class="sk-ico">${icons[key] || "?"}</span><span class="sk-name">${names[key]}</span><span class="sk-lv">${s.lv}/${max}</span>`;
      if (s.lv >= max) el.classList.add("maxed");
      bar.appendChild(el);
    }
  }

  function banner(main, sub) {
    const b = $("banner");
    $("bannerMain").textContent = main;
    $("bannerSub").textContent = sub || "";
    b.style.display = "block";
    b.style.opacity = "1";
    clearTimeout(bannerT);
    bannerT = setTimeout(() => { b.style.opacity = "0"; }, 1600);
  }

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.style.display = "block";
    t.style.opacity = "1";
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.style.opacity = "0"; }, 2000);
  }

  // ============ 升级三选一 ============
  function levelUp(level, choices, onPick) {
    const ov = $("overlay");
    ov.style.display = "flex";
    ov.innerHTML = `
      <div class="panel levelup-panel">
        <div class="panel-title">境界突破 · Lv.${level}</div>
        <div class="panel-sub">择其一而修之</div>
        <div class="choices" id="choiceRow"></div>
      </div>`;
    const row = $("choiceRow");
    const W = CONFIG.weapons;
    const meta = {
      fireline: { name: "凤凰火线", icon: "火", desc: lv => `自动射出火羽灼烧最近之敌<br>${W.fireline.baseDmg + W.fireline.dmgPerLv * (lv - 1)} 伤害 · ${(W.fireline.cd + W.fireline.cdPerLv * (lv - 1)).toFixed(2)}s` },
      icepick: { name: "寒冰锥", icon: "冰", desc: lv => `穿透冰锥减速敌人<br>${W.icepick.baseDmg + W.icepick.dmgPerLv * (lv - 1)} 伤害 · 减速 ${Math.round(W.icepick.slowPct * 100)}%` },
      body: { name: "修身体质", icon: "体", desc: lv => `气血上限提升 ${W.body.hpPerLv}%<br>当前上限 +${W.body.hpPerLv}` },
    };
    for (const c of choices) {
      const card = document.createElement("div");
      card.className = "choice-card";
      let title, icon, desc, tag;
      if (c.kind === "stat") {
        title = c.name; icon = c.icon; desc = c.desc; tag = "辅修";
      } else {
        const m = meta[c.key];
        const curLv = c.kind === "new" ? 0 : window.Game.__weapons.lv(c.key);
        title = m.name; icon = m.icon;
        desc = m.desc(curLv + 1);
        tag = c.kind === "new" ? "习得" : `升 至 ${curLv + 1} 层`;
      }
      card.innerHTML = `
        <div class="ch-tag ${c.kind === "new" ? "new" : c.kind === "up" ? "up" : ""}">${tag}</div>
        <div class="ch-icon">${icon}</div>
        <div class="ch-name">${title}</div>
        <div class="ch-desc">${desc}</div>`;
      card.onclick = () => {
        ov.style.display = "none";
        onPick(c);
      };
      row.appendChild(card);
    }
  }

  // ============ 结算 ============
  function fmtTime(s) {
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  function gameOver(stats, hero) {
    const ov = $("overlay");
    ov.style.display = "flex";
    const best = Math.max(+(localStorage.getItem("m1_best_time") || 0), stats.time);
    localStorage.setItem("m1_best_time", best);
    ov.innerHTML = `
      <div class="panel">
        <div class="panel-title dead">道陨于此</div>
        <div class="result-grid">
          <div><i>存活</i><b>${fmtTime(stats.time)}</b></div>
          <div><i>境界</i><b>Lv.${hero.level}</b></div>
          <div><i>斩妖</i><b>${hero.kills}</b></div>
          <div><i>输出</i><b>${Math.round(stats.dmg)}</b></div>
          <div><i>波次</i><b>${Math.floor(stats.time / 18) + 1}/15</b></div>
          <div><i>最佳存活</i><b>${fmtTime(best)}</b></div>
        </div>
        <button class="btn" onclick="Game.restart()">再入山海</button>
        <div class="hint">经验珠会强化你的拾取范围与输出节奏，避开精英怪的包围</div>
      </div>`;
  }

  function victory(stats, hero) {
    const ov = $("overlay");
    ov.style.display = "flex";
    const best = Math.max(+(localStorage.getItem("m1_best_win") || 0), stats.time);
    localStorage.setItem("m1_best_win", best);
    ov.innerHTML = `
      <div class="panel">
        <div class="panel-title win">斩妖功成</div>
        <div class="win-sub">山臊王授首 · 第一关通关</div>
        <div class="result-grid">
          <div><i>用时</i><b>${fmtTime(stats.time)}</b></div>
          <div><i>境界</i><b>Lv.${hero.level}</b></div>
          <div><i>斩妖</i><b>${hero.kills}</b></div>
          <div><i>承伤</i><b>${Math.round(hero.dmgTaken)}</b></div>
          <div><i>历史最快</i><b>${fmtTime(best)}</b></div>
        </div>
        <button class="btn" onclick="Game.restart()">再战一轮</button>
        <div class="hint">M1 原型到此为止 —— M2 将解锁装备词条与法宝流派</div>
      </div>`;
  }

  return { showHud, updateHud, banner, toast, levelUp, gameOver, victory };
})();
window.UI = UI;
