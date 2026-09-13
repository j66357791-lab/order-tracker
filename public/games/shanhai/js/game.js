// 主游戏：状态机/波次/摄像机/碰撞/主循环
"use strict";

const Game = (() => {
  const cv = document.getElementById("game");
  const ctx = cv.getContext("2d");
  let W = 0, H = 0;

  // —— 状态 ——
  let state = "title";      // title / playing / levelup / over / win
  let hero, weapons, boss;
  let enemyPool, projPool, pickupPool, fxDmg, fxPool, dmgTextPool;
  let grid;
  let waveIdx = 0, waveT = 0, spawnQueue = [], spawnT = 0;
  let camera = { x: 0, y: 0 };
  let decor = [];           // 装饰物
  let stats = { time: 0, kills: 0, level: 1, dmg: 0 };
  let shakeT = 0;
  const input = { left: false, right: false, up: false, down: false };
  let touchVec = null;

  function resize() {
    W = cv.width = window.innerWidth;
    H = cv.height = window.innerHeight;
  }

  // ============ 开局 ============
  function startRun(stage = 1) {
    hero = new Hero();
    // —— 养成加成接入（来自 META 档案）——
    try {
      const B = (window.META && META.bonus) ? META.bonus() : null;
      if (B) {
        hero.hpMulExternal = B.hpMul * B.bodyHpMul;
        hero.dmgFireExternal = B.fireMul;
        hero.dmgIceExternal = B.iceMul;
        hero.fireScale = B.fireScale;
        hero.iceBonus = B.iceCount;
        hero.maxHpBase = Math.round(hero.maxHpBase * hero.hpMulExternal * B.bodyHpMul);
        hero.hp = hero.maxHp;
      }
    } catch (e) { console.warn("meta bonus fail", e); }
    weapons = new WeaponSystem(hero);
    boss = null;
    enemyPool = new Pool(() => new Enemy(), (e, t, x, y) => e.reset(t, x, y), 60);
    projPool = new Pool(() => new Projectile(), (p, k, x, y, dx, dy, prm) => p.reset(k, x, y, dx, dy, prm), 80);
    pickupPool = new Pool(() => new Pickup(), (p, k, x, y) => p.reset(k, x, y), 100);
    fxPool = new Pool(() => new Fx(), (f, k, x, y, s) => f.reset(k, x, y, s), 30);
    dmgTextPool = new Pool(() => new DamageText(), (d, x, y, t, c, b) => d.reset(x, y, t, c, b), 30);
    grid = new SpatialGrid(64);
    waveIdx = 0; waveT = 0; spawnT = 0; spawnQueue = [];
    stats = { time: 0, kills: 0, level: 1, dmg: 0 };
    camera.x = 0; camera.y = 0;
    genDecor();
    state = "playing";
    UI.showHud();
    UI.banner(`第 1 波`, CONFIG.waves[0].spawnText || "");
  }

  function genDecor() {
    decor = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 90; i++) {
      const kind = ["tree1", "tree2", "stone", "stele"][Math.floor(rnd() * 4)];
      decor.push({
        kind,
        x: (rnd() - 0.5) * 4000,
        y: (rnd() - 0.5) * 4000,
        scale: kind === "stele" ? 1 : 0.9 + rnd() * 0.4,
      });
    }
    // 出生点安全区清空
    decor = decor.filter(d => Math.hypot(d.x, d.y) > 200);
    decor.sort((a, b) => a.y - b.y);
  }

  // ============ 波次 ============
  function startWave(i) {
    if (i >= CONFIG.waves.length) return;
    const w = CONFIG.waves[i];
    waveT = w.dur;
    if (w.spawn[0][0] === "BOSS") {
      spawnBoss();
      UI.banner(`最终波`, `山臊王 现身！`);
      return;
    }
    // 生成节奏：整波怪在 dur 内分批刷
    spawnQueue = [];
    for (const [type, count] of w.spawn) {
      for (let k = 0; k < count; k++) spawnQueue.push(type);
    }
    // 洗牌
    for (let i = spawnQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [spawnQueue[i], spawnQueue[j]] = [spawnQueue[j], spawnQueue[i]];
    }
    spawnT = 0;
    UI.banner(`第 ${i + 1} 波`, "");
  }

  function spawnEnemy(type) {
    // 从玩家视野外圈生成
    const a = Math.random() * Math.PI * 2;
    const r = Math.max(W, H) * 0.62 + 60;
    enemyPool.spawn(type, hero.x + Math.cos(a) * r, hero.y + Math.sin(a) * r);
  }

  function spawnBoss() {
    boss = new Boss();
    boss.reset(hero.x + 300, hero.y - 200);
  }

  // ============ 弹幕发射桥 ============
  function fire(kind, x, y, dx, dy, params) {
    const prm = { ...params };
    if (kind === "fireline" || kind === "icepick") prm.speed = params.speed;
    projPool.spawn(kind, x, y, dx, dy, prm);
  }

  const bossApi = {
    spawnBullet(x, y, dx, dy, dmg, kind) {
      projPool.spawn(kind, x, y, dx, dy, { dmg, speed: 180, radius: 8 });
    },
    summonMinions(n) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        enemyPool.spawn("shanhao", boss.x + Math.cos(a) * 70, boss.y + Math.sin(a) * 70);
      }
      UI.toast(`山臊王 召唤了爪牙！`);
    },
    smashFx(x, y) {
      fxPool.spawn("smash", x, y, 1.2);
      shakeT = 0.35;
    },
  };

  // ============ 主循环 ============
  let last = 0;
  function loop(ts) {
    const dt = Math.min(0.033, (ts - last) / 1000 || 0.016);
    last = ts;
    if (state === "playing") {
      try { update(dt); }
      catch (ex) { console.error("update error:", ex); }   // 单帧异常不冻结游戏
    }
    render();
    requestAnimationFrame(loop);
  }

  function update(dt) {
    stats.time += dt;
    // 玩家
    hero.update(dt, touchVec ? touchKeys() : input);
    weapons.update(dt, enemyPool, fire, boss);

    // 波次推进
    waveT -= dt;
    if (spawnQueue.length) {
      spawnT -= dt;
      const rate = spawnQueue.length / Math.max(1, waveT + 2);   // 剩余时间内均匀刷完
      if (spawnT <= 0) {
        const batch = Math.max(1, Math.ceil(rate * 0.8));
        for (let i = 0; i < batch && spawnQueue.length; i++) {
          spawnEnemy(spawnQueue.pop());
          spawnT = 0.4;
        }
      }
    }
    if (waveT <= 0 && !spawnQueue.length) {
      if (waveIdx < CONFIG.waves.length - 1) {
        waveIdx++;
        startWave(waveIdx);
      }
      // 最后一波由 Boss 死亡结算
    }

    // 网格重建（每帧）
    grid.clear();
    for (const e of enemyPool.active) grid.insert(e);

    // 怪物更新 + 接触伤害
    const near = [];
    enemyPool.forEach(e => {
      e.update(dt, hero, (x, y, dx, dy, dmg) => projPool.spawn("enemyshot", x, y, dx, dy, { dmg, speed: 170, radius: 6 }));
      // 接触
      const d = Math.hypot(e.x - hero.x, e.y - hero.y);
      if (d < e.def.radius + hero.radius) {
        if (hero.hurt(e.def.dmg)) {
          dmgTextPool.spawn(hero.x, hero.y - 20, `-${e.def.dmg}`, "#FF8A70", true);
          shakeT = Math.max(shakeT, 0.18);
        }
      }
    });

    // Boss
    if (boss) {
      if (boss.alive) {
        boss.update(dt, hero, bossApi);
        const d = Math.hypot(boss.x - hero.x, boss.y - hero.y);
        if (d < CONFIG.boss.radius + hero.radius && hero.hurt(CONFIG.boss.contactDmg)) {
          dmgTextPool.spawn(hero.x, hero.y - 20, `-${CONFIG.boss.contactDmg}`, "#FF8A70", true);
          shakeT = 0.3;
        }
      } else {
        onBossDead();
      }
    }

    // 玩家弹 → 怪命中（网格查询）
    projPool.forEach(p => {
      p.update(dt);
      if (!p.alive) return;
      if (p.kind === "enemyshot" || p.kind === "bossrock") {
        // 敌弹 → 玩家
        const d = Math.hypot(p.x - hero.x, p.y - hero.y);
        if (d < p.radius + hero.radius) {
          if (hero.hurt(p.dmg)) {
            dmgTextPool.spawn(hero.x, hero.y - 20, `-${p.dmg}`, "#FF8A70", true);
            if (p.kind === "bossrock") fxPool.spawn("hit", p.x, p.y, 1);
          }
          p.alive = false;
        }
        return;
      }
      // 玩家弹 → 怪
      grid.query(p.x, p.y, p.radius + 14, near);
      for (const e of near) {
        if (!e.alive || p.hitIds.includes(e)) continue;
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < p.radius + e.def.radius) {
          const crit = Math.random() < CONFIG.critRate;
          const dmg = Math.round(p.dmg * (crit ? CONFIG.critMul : 1));
          const killed = e.hurt(dmg, p.slow);
          stats.dmg += dmg;
          dmgTextPool.spawn(e.x, e.y - 8, crit ? dmg + "!" : dmg, crit ? "#FFD24A" : "#FFE082", crit);
          fxPool.spawn("hit", e.x, e.y - 6, 0.8);
          if (killed) {
            onEnemyDead(e);
          }
          if (p.pierce > 0) {
            p.pierce--;
            p.hitIds.push(e);
          } else {
            p.alive = false;
          }
          break;
        }
      }
      // 玩家弹 → Boss
      if (p.alive && boss && boss.alive) {
        const d = Math.hypot(boss.x - p.x, boss.y - p.y);
        if (d < p.radius + CONFIG.boss.radius) {
          const crit = Math.random() < CONFIG.critRate;
          const dmg = Math.round(p.dmg * (crit ? CONFIG.critMul : 1));
          stats.dmg += dmg;
          boss.hurt(dmg);
          dmgTextPool.spawn(p.x, p.y, crit ? dmg + "!" : dmg, crit ? "#FFD24A" : "#FFB070", crit);
          fxPool.spawn("hit", p.x, p.y, 0.9);
          p.alive = false;
        }
      }
    });

    // 拾取
    pickupPool.forEach(pk => {
      if (!pk.alive) return;
      const r = pk.update(dt, hero);
      if (r === "exp") {
        pickupPool.despawn(pk);
        const ups = hero.gainExp(CONFIG.orbs.value);
        if (ups > 0) openLevelUp();
      } else if (r === "heal") {
        pickupPool.despawn(pk);
        hero.hp = Math.min(hero.maxHp, hero.hp + CONFIG.orbs.meat.heal);
        dmgTextPool.spawn(hero.x, hero.y - 24, `+${CONFIG.orbs.meat.heal}`, "#7FE89A", true);
      }
    });

    fxPool.forEach(f => f.update(dt));
    dmgTextPool.forEach(d => d.update(dt));

    // 摄像机
    camera.x += (hero.x - camera.x) * Math.min(1, dt * 5);
    camera.y += (hero.y - camera.y) * Math.min(1, dt * 5);
    if (shakeT > 0) shakeT -= dt;

    // 死亡
    if (hero.hp <= 0) {
      state = "over";
      UI.gameOver(stats, hero);
    }

    UI.updateHud(hero, waveIdx, boss);
  }

  function touchKeys() {
    if (!touchVec) return input;
    input.left = touchVec.x < -0.3;
    input.right = touchVec.x > 0.3;
    input.up = touchVec.y < -0.3;
    input.down = touchVec.y > 0.3;
    return input;
  }

  function onEnemyDead(e) {
    stats.kills++;
    hero.kills++;
    fxPool.spawn("die", e.x, e.y - 6, 1);
    pickupPool.spawn("orb", e.x, e.y);
    if (Math.random() < CONFIG.orbs.meat.dropRate) pickupPool.spawn("meat", e.x + 10, e.y + 6);
    enemyPool.despawn(e);
  }

  function onBossDead() {
    fxPool.spawn("die", boss.x, boss.y, 2.2);
    fxPool.spawn("smash", boss.x, boss.y, 1.5);
    for (let i = 0; i < 10; i++) pickupPool.spawn("orb", boss.x + (Math.random() - 0.5) * 90, boss.y + (Math.random() - 0.5) * 90);
    UI.toast(`山臊王 已被斩杀！`);
    boss = null;
    state = "win";
    UI.victory(stats, hero);
  }

  // ============ 升级三选一 ============
  function buildChoices() {
    const pool = [];
    const W = CONFIG.weapons;
    // 已有技能可升级
    for (const key of ["fireline", "icepick"]) {
      if (weapons.has(key)) {
        if (weapons.lv(key) < W[key].maxLv) pool.push({ key, kind: "up" });
      } else {
        pool.push({ key, kind: "new" });
      }
    }
    // 修身体质（被动，未满级）
    if (!weapons.has("body") || weapons.lv("body") < W.body.maxLv) pool.push({ key: "body", kind: weapons.has("body") ? "up" : "new" });
    // 属性强化
    pool.push({ key: "atk", kind: "stat", name: "煞气淬炼", desc: "攻击力 +12%", icon: "煞" });
    pool.push({ key: "spd", kind: "stat", name: "御风步", desc: "移动速度 +8%", icon: "风" });
    pool.push({ key: "hp", kind: "stat", name: "龟息吐纳", desc: "生命上限 +15 并回满", icon: "龟" });
    // 抽 3 个不重复
    const out = [];
    const used = new Set();
    while (out.length < 3 && pool.length) {
      const i = Math.floor(Math.random() * pool.length);
      const c = pool[i];
      if (!used.has(c.key + c.kind)) {
        used.add(c.key + c.kind);
        out.push(c);
        pool.splice(i, 1);
      } else pool.splice(i, 1);
    }
    return out;
  }

  function openLevelUp() {
    if (boss && !boss.alive) return;   // Boss 已亡：胜利结算优先，不再弹升级
    state = "levelup";
    fxPool.spawn("levelup", hero.x, hero.y, 1.4);
    const choices = buildChoices();
    UI.levelUp(hero.level, choices, pick => {
      applyChoice(pick);
      state = "playing";
    });
  }

  function applyChoice(p) {
    if (p.kind === "new") weapons.addWeapon(p.key);
    else if (p.kind === "up") weapons.upgrade(p.key);
    else if (p.kind === "stat") {
      if (p.key === "atk") hero.dmgMul += 0.12;
      if (p.key === "spd") hero.speed *= 1.08;
      if (p.key === "hp") { hero.maxHpBase += 15; hero.hp = hero.maxHp; }
    }
  }

  // ============ 渲染 ============
  function render() {
    ctx.fillStyle = "#5E7C46";
    ctx.fillRect(0, 0, W, H);
    if (state === "title") { UI && UI.drawTitleBg && UI.drawTitleBg(ctx); return; }
    if (!hero) return;

    ctx.save();
    let sx = 0, sy = 0;
    if (shakeT > 0) {
      sx = (Math.random() - 0.5) * 10 * shakeT * 3;
      sy = (Math.random() - 0.5) * 10 * shakeT * 3;
    }
    ctx.translate(Math.round(W / 2 - camera.x + sx), Math.round(H / 2 - camera.y + sy));

    // —— 地块（视口平铺）——
    const tile = Assets.get("tile");
    if (tile) {
      const TS = 64;
      const x0 = Math.floor((camera.x - W / 2) / TS) - 1;
      const y0 = Math.floor((camera.y - H / 2) / TS) - 1;
      const x1 = Math.ceil((camera.x + W / 2) / TS) + 1;
      const y1 = Math.ceil((camera.y + H / 2) / TS) + 1;
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          // 稳定伪随机变体（同格永远同图）
          const v = Math.abs((tx * 73856093) ^ (ty * 19349663)) % tile.frames;
          ctx.drawImage(tile.img, v * tile.fw, 0, tile.fw, tile.fh, tx * TS, ty * TS, TS, TS);
        }
      }
    }

    // —— 装饰（y 排序已做，直接画在实体前；树按底部 y 与实体一起排序更好，M1 简化：先画装饰）——
    for (const d of decor) {
      if (Math.abs(d.x - camera.x) > W / 2 + 80 || Math.abs(d.y - camera.y) > H / 2 + 90) continue;
      Assets.draw(ctx, d.kind, 0, d.x, d.y, d.scale);
    }

    // —— 拾取 ——
    for (const pk of pickupPool.active) pk.draw(ctx);

    // —— 怪 ——
    for (const e of enemyPool.active) e.draw(ctx);

    // —— Boss ——
    if (boss) boss.draw(ctx);

    // —— 玩家 ——
    hero.draw(ctx);

    // —— 弹幕 ——
    for (const p of projPool.active) p.draw(ctx);

    // —— 特效 + 伤害数字 ——
    for (const f of fxPool.active) f.draw(ctx);
    for (const d of dmgTextPool.active) d.draw(ctx);

    // —— 拾取半径提示（低透明圈）——
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath(); ctx.arc(hero.x, hero.y, hero.pickupRadius, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  // ============ 输入 ============
  const keyMap = {
    KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
    KeyW: "up", ArrowUp: "up", KeyS: "down", ArrowDown: "down",
  };
  window.addEventListener("keydown", ev => {
    if (keyMap[ev.code]) { input[keyMap[ev.code]] = true; ev.preventDefault(); }
  });
  window.addEventListener("keyup", ev => {
    if (keyMap[ev.code]) input[keyMap[ev.code]] = false;
  });

  // 触屏虚拟摇杆
  const joy = document.getElementById("joystick");
  const joyKnob = document.getElementById("joyKnob");
  let joyId = null, joyCx = 0, joyCy = 0;
  cv.addEventListener("touchstart", ev => {
    if (state !== "playing") return;
    const t = ev.changedTouches[0];
    joyId = t.identifier;
    joyCx = t.clientX; joyCy = t.clientY;
    joy.style.display = "block";
    joy.style.left = (joyCx - 60) + "px";
    joy.style.top = (joyCy - 60) + "px";
    ev.preventDefault();
  }, { passive: false });
  cv.addEventListener("touchmove", ev => {
    for (const t of ev.changedTouches) {
      if (t.identifier !== joyId) continue;
      let dx = t.clientX - joyCx, dy = t.clientY - joyCy;
      const d = Math.hypot(dx, dy);
      if (d > 44) { dx = dx / d * 44; dy = dy / d * 44; }
      joyKnob.style.transform = `translate(${dx}px,${dy}px)`;
      touchVec = { x: dx / 44, y: dy / 44 };
    }
    ev.preventDefault();
  }, { passive: false });
  const joyEnd = ev => {
    for (const t of ev.changedTouches) {
      if (t.identifier !== joyId) continue;
      joyId = null; touchVec = null;
      joy.style.display = "none";
      joyKnob.style.transform = "translate(0,0)";
    }
  };
  cv.addEventListener("touchend", joyEnd);
  cv.addEventListener("touchcancel", joyEnd);

  // 暴露
  const api = {
    start() {
      resize();
      window.addEventListener("resize", resize);
      requestAnimationFrame(loop);
    },
    startRun,
    restart: startRun,
    get state() { return state; },
    get hero() { return hero; },
    get __weapons() { return weapons; },
    get waveIdx() { return waveIdx; },
    pause() { state = "title"; },
    get __boss() { return boss; },
    __debug: {
      toWave(n) { waveIdx = Math.min(Math.max(n, 1), CONFIG.waves.length) - 1; startWave(waveIdx); },
      god(on) { if (hero) hero.godMode = !!on; },
      killBoss() { if (boss && boss.alive) boss.hp = 0; },
    },
  };
  return api;
})();

window.Game = Game;
