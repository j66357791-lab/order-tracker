// 主游戏：状态机/波次/摄像机/碰撞/主循环
"use strict";

const Game = (() => {
  const cv = document.getElementById("game");
  const ctx = cv.getContext("2d");
  let W = 0, H = 0;
  // 【P1-2】地块离屏画布：tileBase 记录当前预渲染覆盖的格子范围，跨界才重拼
  let tileCanvas = null, tileCtx = null;
  let tileBase = { x0: 0, y0: 0, cols: 0, rows: 0 };

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

  // 【2026-09-28】高清画质开关（用户菜单可切换，LS 'sh_hd'）：逻辑坐标保持 CSS 像素不变，
  // 画布物理分辨率乘 DPR（≤1.5），绘制前统一 setTransform——高分屏不再发糊，低端机默认标准档更省电。
  const dprOf = () => { try { return (window.LS && LS.get('sh_hd', '0') === '1') ? Math.min(window.devicePixelRatio || 1, 1.5) : 1; } catch (e) { return 1; } };
  let DPR = 1;
  function resize() {
    DPR = dprOf();
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    tileBase = { x0: 0, y0: 0, cols: 0, rows: 0 };   // 强制离屏地块按新 DPR 重拼
  }

  // ============ 开局 ============
  // 【v24.4】第一章 · 南山草泽 20 关：按关卡号缩放波次数量 / 怪物属性 / Boss
  // 设计（普通难度）：
  //   L1 练手（数量×0.7、Boss 600）→ L2 数量属性明显增强（×1.3 / HP×1.2）
  //   → L3 起线性爬坡（数量 +0.15/关，HP +0.22/关，伤害 +0.09/关）
  //   → L4 解锁毕方、L7 解锁旋龟；L5 起第 5/10/13 波出精英（体型×1.35、HP×3、经验×5）
  //   → L20 终局：Boss 4800 血且召唤翻倍
  function stageMul(n) {
    const count = n === 1 ? 0.7 : n === 2 ? 1.3 : 1.3 + 0.15 * (n - 2);
    return {
      n,
      count,                                  // 每波数量倍率
      hp: 1 + 0.22 * (n - 1),                 // 怪物生命倍率
      dmg: 1 + 0.09 * (n - 1),                // 怪物伤害倍率
      bossHp: (600 + 220 * (n - 1)) * (n === 20 ? 1.5 : 1),
      elite: n >= 5,                          // 精英开关
      unlockAt: { bifang: 4, xuangui: 7 },    // 新怪解锁关卡
    };
  }
  let stage = 1, MUL = stageMul(1);

  function startRun(stageNo = 1) {
    stage = Math.max(1, Math.min(20, stageNo | 0));
    MUL = stageMul(stage);
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
        // 【v24.3 属性统一】这四条装备加成原来只算不接——装备页显示有，局内实际无效：
        hero.dmgMul = B.dmgMul;                                        // 配饰：全伤害
        hero.speed = CONFIG.hero.speed * B.moveMul;                    // 鞋子：移速
        hero.pickupRadius = CONFIG.hero.pickupRadius * B.pickupMul;    // 腰带：拾取范围
        hero.expMul = B.expMul;                                        // 发冠：经验获取
        // 【v26.23】天赋被动接线：crit/dodge/shield/atkSpd 此前只汇总进 facRaw、对局从未消费——
        // 学了也没效果。现在接入英雄属性（闪避/护盾的判定在 Hero.hurt，攻速在武器冷却）。
        const fr = B.facRaw || {};
        hero.critBonus = (hero.critBonus || 0) + (fr.crit || 0) / 100;
        hero.dodgeBonus = (hero.dodgeBonus || 0) + (fr.dodge || 0) / 100;
        hero.shieldHp = (hero.shieldHp || 0) + (fr.shield || 0);
        hero.atkSpdBuff = (hero.atkSpdBuff || 0) + (fr.atkSpd || 0) / 100;
        hero.onDodge = (x, y) => { dmgTextPool.spawn(x, y - 20, "闪避", "#9fd8ff", true); };
        hero.onShield = (a) => { dmgTextPool.spawn(hero.x, hero.y - 30, `盾-${Math.round(a)}`, "#9fb8d8", true); };
      }
    } catch (e) { console.warn("meta bonus fail", e); }
    weapons = new WeaponSystem(hero);
    boss = null;
    // 【2026-09-24 性能优化】各池加存活上限（第 4 参数）：高负载战斗（Boss 召唤翻倍、
    // 全屏弹幕、伤害数字刷屏）下对象数有界，帧率稳定，低端机不再越打越卡
    // 【v26.70】enemyPool 的包装器原来只转发 3 个参数，spawnEnemy 传的第 4 个 isElite
    // 在这里被静默丢掉 → Enemy.elite 永远是 false：精英不放大、不出金条、不掉 3 颗经验珠、
    // 无提示音无 toast，整套精英机制形同虚设（且因参数个数不匹配，静态检查看不出来）。
    enemyPool = new Pool(() => new Enemy(), (e, t, x, y, elite) => e.reset(t, x, y, elite), 60, 240);
    projPool = new Pool(() => new Projectile(), (p, k, x, y, dx, dy, prm) => p.reset(k, x, y, dx, dy, prm), 80, 400);
    pickupPool = new Pool(() => new Pickup(), (p, k, x, y) => p.reset(k, x, y), 100, 300);
    fxPool = new Pool(() => new Fx(), (f, k, x, y, s) => f.reset(k, x, y, s), 30, 100);
    dmgTextPool = new Pool(() => new DamageText(), (d, x, y, t, c, b) => d.reset(x, y, t, c, b), 30, 60);
    grid = new SpatialGrid(64);
    waveIdx = 0; waveT = 0; spawnT = 0; spawnQueue = [];
    stats = { time: 0, kills: 0, level: 1, dmg: 0 };
    camera.x = 0; camera.y = 0;
    genDecor();
    state = "playing";
    UI.showHud();
    UI.banner(`第 1 波`, `第一关 第 ${stage} 关 · 第 1 波`);
    // 【v24.5】进入战斗：解锁音频（需用户手势）+ 起战斗 BGM
    if (window.SFX) { SFX.unlock(); SFX.bgmStart(); }
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
      UI.banner(`最终波`, `${CONFIG.boss.name} 现身！`);
      return;
    }
    // 生成节奏：整波怪在 dur 内分批刷
    // 【v24.4】按关卡缩放数量 + 过滤未解锁怪 + 精英注入（L5 起，第 5/10/13 波）
    spawnQueue = [];
    for (const [type, count] of w.spawn) {
      if (MUL.unlockAt[type] && stage < MUL.unlockAt[type]) continue;
      let n = Math.round(count * MUL.count);
      const eliteHere = MUL.elite && [4, 9, 12].includes(i);
      for (let k = 0; k < n; k++) spawnQueue.push(spawnQueue.length < 2 && eliteHere ? "elite:" + type : type);
    }
    // 洗牌（精英条目保持在队首先刷）
    const elites = spawnQueue.filter(s => s.indexOf("elite:") === 0);
    const normals = spawnQueue.filter(s => s.indexOf("elite:") !== 0);
    for (let i = normals.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [normals[i], normals[j]] = [normals[j], normals[i]];
    }
    spawnQueue = elites.concat(normals);
    spawnT = 0;
    UI.banner(`第 ${i + 1} 波`, "");
  }

  function spawnEnemy(type) {
    // 从玩家视野外圈生成
    const a = Math.random() * Math.PI * 2;
    const r = Math.max(W, H) * 0.62 + 60;
    let isElite = false;
    if (type.indexOf("elite:") === 0) { isElite = true; type = type.slice(6); }
    enemyPool.spawn(type, hero.x + Math.cos(a) * r, hero.y + Math.sin(a) * r, isElite);
  }

  function spawnBoss() {
    boss = new Boss();
    boss.reset(hero.x + 300, hero.y - 200);
    // 【v24.4】Boss 按关卡缩放（600 + 220×(n-1)，L20 ×1.5）
    const ratio = MUL.bossHp / CONFIG.boss.hp;
    boss.maxHp = boss.hp = Math.round(boss.hp * ratio);
    if (stage === 20) boss.enrage = true;   // 终局：召唤翻倍
  }

  // ============ 弹幕发射桥 ============
  let lastDt = 0.016;   // 供弹道动画用
  function fire(kind, x, y, dx, dy, params) {
    // 【2026-09-27 审查修复 P2-18】去掉 { ...params } 浅拷贝：参数对象要么是当帧新建的只读物、
    // 要么是只读共享参数表，Projectile.reset 只读字段不保存引用——直接透传即可，
    // 高攻速下每秒少创建几十个临时对象（GC 压力）。原先的 prm.speed = params.speed 是无效冗余。
    projPool.spawn(kind, x, y, dx, dy, params);
  }

  const bossApi = {
    spawnBullet(x, y, dx, dy, dmg, kind) {
      projPool.spawn(kind, x, y, dx, dy, { dmg, speed: 180, radius: 8 });
    },
    summonMinions(n) {
      const cnt = boss && boss.enrage ? n * 2 : n;   // 【v24.4】L20 终局：召唤翻倍
      for (let i = 0; i < cnt; i++) {
        const a = (i / cnt) * Math.PI * 2;
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
  // 【2026-09-27 审查修复 P2-17】非战斗状态按需渲染：主页/升级/结算的画面被 DOM 覆盖，
  // 原先 rAF 仍每帧全屏重绘，纯耗 GPU/CPU。改为只在状态切换/窗口变化后补画一帧。
  let needsRender = true;
  function invalidate() { needsRender = true; }
  function loop(ts) {
    const dt = Math.min(0.033, (ts - last) / 1000 || 0.016);
    last = ts;
    if (state === "playing") {
      try { update(dt); }
      catch (ex) { console.error("update error:", ex); }   // 单帧异常不冻结游戏
      render(dt);
    } else if (needsRender) {
      render(dt);
      needsRender = false;
    }
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
      if (d < e.effRadius() + hero.radius) {
        if (hero.hurt(Math.round(e.def.dmg * (e.dmgMul || 1)))) {
          if (window.SFX) SFX.hurt();
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
          if (window.SFX) SFX.hurt();
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
      // 【v24.4 重大修复】死亡弹幕原来说从不回收——一直留在池里、被反复画在最后位置：
      // 这就是"白色残影"、"旋风刃卡住掉在地上"、越玩越卡的共同根因
      if (!p.alive) { projPool.despawn(p); return; }
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
        if (d < p.radius + e.effRadius()) {
          const crit = Math.random() < CONFIG.critRate + (hero.critBonus || 0);
          const dmg = Math.round(p.dmg * (crit ? CONFIG.critMul : 1));
          const killed = e.hurt(dmg, p.slow);
          stats.dmg += dmg;
          // 【v24.5】打击音效：飞剑=金属脆响，火=呼，冰=叮，旋风刃=擦身声
          if (window.SFX) SFX.hit(p.kind, crit);
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
          const crit = Math.random() < CONFIG.critRate + (hero.critBonus || 0);
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
        if (window.SFX) SFX.orb();
        const ups = hero.gainExp(Math.max(1, Math.round(CONFIG.orbs.value * (hero.expMul || 1))));
        if (ups > 0) openLevelUp();
      } else if (r === "heal") {
        pickupPool.despawn(pk);
        if (window.SFX) SFX.heal();
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
    // 【v26.70】加 state 守卫：同一帧里 Boss 倒地（→win）与英雄血量归零（→over）可以先后成立，
    // 原写法两次都会执行 → 先上报通关、紧接着又上报阵亡，结算面板被「道陨于此」覆盖，
    // 玩家明明通关却看到自己死了。票据制度下第二次上报还会被服务端拒（成绩已入账，看着像出错）。
    if (state === "playing" && hero.hp <= 0) {
      state = "over";
      invalidate();   // 【P2-17】
      if (window.SFX) { SFX.hurt(); SFX.gameOver(); }   // 【v26.13】BGM 不停了：主页和战斗共用同一条背景乐，连续不断
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
    if (window.SFX) SFX.enemyDie(e.elite);
    fxPool.spawn("die", e.x, e.y - 6, 1);
    pickupPool.spawn("orb", e.x, e.y);
    // 【v24.4】精英多掉 2 颗经验珠
    const orbs = e.elite ? 3 : 1;
    for (let i = 1; i < orbs; i++) pickupPool.spawn("orb", e.x + (Math.random() - 0.5) * 30, e.y + (Math.random() - 0.5) * 30);
    if (Math.random() < CONFIG.orbs.meat.dropRate) pickupPool.spawn("meat", e.x + 10, e.y + 6);
    if (e.elite) UI.toast(`精英妖物被斩杀！`);
    enemyPool.despawn(e);
  }

  function onBossDead() {
    if (state !== "playing") return;   // 【v26.70】终局只结算一次（见上面死亡分支的同款守卫）
    if (window.SFX) SFX.bossDie();
    fxPool.spawn("die", boss.x, boss.y, 2.2);
    fxPool.spawn("smash", boss.x, boss.y, 1.5);
    for (let i = 0; i < 10; i++) pickupPool.spawn("orb", boss.x + (Math.random() - 0.5) * 90, boss.y + (Math.random() - 0.5) * 90);
    UI.toast(`山臊王 已被斩杀！`);
    boss = null;
    state = "win";
    invalidate();   // 【P2-17】
    if (window.SFX) { SFX.victory(); }   // 【v26.13】BGM 连续，不再战斗一结束就静音
    UI.victory(stats, hero);
  }

  // ============ 升级三选一 ============
  // 【v26.13】按定稿：局内**只**进行基础能力选择，不再出现任何技能/武器选项。
  // 上轮只是把基础能力"加进池子"，技能还在 → 三选一照样抽到技能，用户看到的就是旧版。
  // 内置一份兜底表：流派数据没加载出来时也能抽（数值与定稿一致）。
  const INBORN_FALLBACK = {
    white: { w: 50, name: "白色", color: "#cfd8dc", mods: [
      { k: "atk", v: 5, t: "攻击力 +5%" }, { k: "moveSpd", v: 10, t: "移动速度 +10%" },
      { k: "hp", v: 5, t: "生命值 +5%" }, { k: "atkSpd", v: 10, t: "攻击速度 +10%" },
      { k: "crit", v: 5, t: "暴击率 +5%" }, { k: "dodge", v: 5, t: "闪避率 +5%" },
      { k: "shield", v: 20, t: "护盾血量 +20" }, { k: "pickRange", v: 10, t: "经验拾取范围 +10%" },
      { k: "expRate", v: 10, t: "经验加成 +10%" }] },
    blue: { w: 25, name: "蓝色", color: "#8ecff0", mods: [
      { k: "atk", v: 10, t: "攻击力 +10%" }, { k: "moveSpd", v: 15, t: "移动速度 +15%" },
      { k: "hp", v: 10, t: "生命值 +10%" }, { k: "atkSpd", v: 20, t: "攻击速度 +20%" },
      { k: "crit", v: 8, t: "暴击率 +8%" }, { k: "dodge", v: 8, t: "闪避率 +8%" },
      { k: "shield", v: 40, t: "护盾血量 +40" }, { k: "pickRange", v: 20, t: "经验拾取范围 +20%" },
      { k: "expRate", v: 15, t: "经验加成 +15%" }] },
    purple: { w: 15, name: "紫色", color: "#c9a0ff", mods: [
      { k: "atk", v: 20, t: "攻击力 +20%" }, { k: "moveSpd", v: 30, t: "移动速度 +30%" },
      { k: "hp", v: 20, t: "生命值 +20%" }, { k: "atkSpd", v: 30, t: "攻击速度 +30%" },
      { k: "crit", v: 15, t: "暴击率 +15%" }, { k: "dodge", v: 15, t: "闪避率 +15%" },
      { k: "shield", v: 80, t: "护盾血量 +80" }, { k: "pickRange", v: 30, t: "经验拾取范围 +30%" },
      { k: "expRate", v: 20, t: "经验加成 +20%" }] },
    gold: { w: 8, name: "金色", color: "#ffd76a", mods: [
      { k: "atk", v: 40, t: "攻击力 +40%" }, { k: "moveSpd", v: 40, t: "移动速度 +40%" },
      { k: "hp", v: 40, t: "生命值 +40%" }, { k: "atkSpd", v: 40, t: "攻击速度 +40%" },
      { k: "crit", v: 20, t: "暴击率 +20%" }, { k: "dodge", v: 20, t: "闪避率 +20%" },
      { k: "shield", v: 180, t: "护盾血量 +180" }, { k: "pickRange", v: 40, t: "经验拾取范围 +40%" },
      { k: "expRate", v: 30, t: "经验加成 +30%" }] },
    myth: { w: 2, name: "神话", color: "#ff7a5c", mods: [
      { k: "atk", v: 60, t: "攻击力 +60%" }, { k: "moveSpd", v: 60, t: "移动速度 +60%" },
      { k: "hp", v: 60, t: "生命值 +60%" }, { k: "atkSpd", v: 60, t: "攻击速度 +60%" }] },
  };
  function buildChoices() {
    const IB = (window.META && META.factionCache && META.factionCache.inborn) ? META.factionCache.inborn : INBORN_FALLBACK;
    const rollQ = () => {
      const r = Math.random() * 100;
      let acc = 0;
      for (const k of ["white", "blue", "purple", "gold", "myth"]) { acc += IB[k].w; if (r < acc) return k; }
      return "white";
    };
    const out = [];
    const used = new Set();
    let guard = 0;
    // 抽 3 条**不同**的基础能力（各自独立掷品质；同条目同数值去重）
    while (out.length < 3 && guard++ < 80) {
      const q = rollQ();
      const mods = IB[q].mods;
      const m = mods[Math.floor(Math.random() * mods.length)];
      const sig = m.k + "|" + m.v;
      if (used.has(sig)) continue;
      used.add(sig);
      out.push({
        key: m.k, kind: "inborn", q, vNum: m.v,
        name: IB[q].name + " · " + m.t,
        desc: IB[q].name + "品质基础加成",
        icon: IB[q].name[0],
        color: IB[q].color,
      });
    }
    return out;
  }

  function openLevelUp() {
    if (boss && !boss.alive) return;   // Boss 已亡：胜利结算优先，不再弹升级
    state = "levelup";
    invalidate();   // 【P2-17】暂停期间仍需补画一帧定格画面
    if (window.SFX) SFX.levelUp();
    fxPool.spawn("levelup", hero.x, hero.y, 1.4);
    const choices = buildChoices();
    UI.levelUp(hero.level, choices, pick => {
      applyChoice(pick);
      state = "playing";
    });
  }

  function applyChoice(p) {
    // 【v26.11】基础能力（品质池抽出）：按 key 直接套到英雄属性
    if (p.kind === "inborn") {
      const v = p.vNum || 0;
      if (p.key === "atk") hero.dmgMul += v / 100;
      else if (p.key === "moveSpd") hero.speed *= 1 + v / 100;
      else if (p.key === "hp") { hero.maxHpBase = Math.round(hero.maxHpBase * (1 + v / 100)); hero.hp = Math.min(hero.maxHp, hero.hp + hero.maxHpBase * v / 100); }
      else if (p.key === "atkSpd") hero.atkSpdBuff = (hero.atkSpdBuff || 0) + v / 100;
      else if (p.key === "crit") hero.critBonus = (hero.critBonus || 0) + v / 100;
      else if (p.key === "dodge") hero.dodgeBonus = (hero.dodgeBonus || 0) + v / 100;
      else if (p.key === "shield") hero.shieldHp = (hero.shieldHp || 0) + v;
      else if (p.key === "pickRange") hero.pickupRadius *= 1 + v / 100;
      else if (p.key === "expRate") hero.expMul *= 1 + v / 100;
      if (window.SFX) SFX.levelUp();
      return;
    }
    if (p.kind === "sword") {
      const S = weapons.swordSkill;
      if (p.key === "swordcount") S.count++;
      if (p.key === "swordatk") S.atk++;
      if (p.key === "swordspd") S.spd++;
      if (p.key === "swordlock") S.lock = 1;
      if (p.key === "swordburst") S.burst = 1;
      return;
    }
    if (p.kind === "new") weapons.addWeapon(p.key);
    else if (p.kind === "up") weapons.upgrade(p.key);
    else if (p.kind === "stat") {
      if (p.key === "atk") hero.dmgMul += 0.12;
      if (p.key === "spd") hero.speed *= 1.08;
      if (p.key === "hp") { hero.maxHpBase += 15; hero.hp = hero.maxHp; }
    }
  }

  // ============ 渲染 ============
  function render(dt) {
    try {
      renderInner(dt);
    } catch (e) {
      // 【v24.4】渲染异常不再杀死整个循环（原来一帧异常=游戏永久卡死）
      if (window.__err) window.__err.push("render: " + e.message);
      console.error("render error:", e);
    }
    lastDt = dt || 0.016;
    window.Game && (Game.lastDt = lastDt);
  }

  function renderInner(dt) {
    ctx.fillStyle = "#5E7C46";
    ctx.fillRect(0, 0, W, H);
    if (state === "title") { UI && UI.drawTitleBg && UI.drawTitleBg(ctx); return; }
    if (!hero) return;

    ctx.save();
    let sx = 0, sy = 0;
    // 【v26.70】抖动只在战斗中生效：shakeT 是在 update() 里衰减的，而 update() 只在 state==="playing"
    // 时运行。被击杀那一发正好触发大抖动时结束战斗，shakeT 就永久停在正值上，
    // 结算面板底下整幅画面会一直随机抽搐（且不会再衰减回去）。
    if (shakeT > 0) {
      if (state !== "playing") shakeT = 0;
      else {
        sx = (Math.random() - 0.5) * 10 * shakeT * 3;
        sy = (Math.random() - 0.5) * 10 * shakeT * 3;
      }
    }
    ctx.translate(Math.round(W / 2 - camera.x + sx), Math.round(H / 2 - camera.y + sy));

    // —— 地块（离屏预渲染）——
    // 【2026-09-27 审查修复 P1-2】原先每帧把视口内约 300~700 格草地逐格 drawImage + 哈希选变体，
    // 是战斗中最大的单项绘制开销（比全部怪物+弹幕加起来还多）。地块图案是静态的，
    // 改为预渲染到一张离屏画布：每帧只做 1 次 drawImage；摄像机跨过格子边界时才重拼一次。
    const tile = Assets.get("tile");
    if (tile) {
      const TS = 64;
      const x0 = Math.floor((camera.x - W / 2) / TS) - 1;
      const y0 = Math.floor((camera.y - H / 2) / TS) - 1;
      const x1 = Math.ceil((camera.x + W / 2) / TS) + 1;
      const y1 = Math.ceil((camera.y + H / 2) / TS) + 1;
      const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
      if (!tileCanvas || tileBase.x0 !== x0 || tileBase.y0 !== y0 || tileBase.cols !== cols || tileBase.rows !== rows) {
        if (!tileCanvas) { tileCanvas = document.createElement("canvas"); tileCtx = tileCanvas.getContext("2d"); }
        tileCanvas.width = Math.round(cols * TS * DPR); tileCanvas.height = Math.round(rows * TS * DPR);
        tileCtx.setTransform(DPR, 0, 0, DPR, 0, 0);   // 离屏也按 DPR 绘制，高清模式下地块同样清晰
        tileBase = { x0, y0, cols, rows };
        for (let ty = y0; ty <= y1; ty++) {
          for (let tx = x0; tx <= x1; tx++) {
            // 稳定伪随机变体（同格永远同图）
            const v = Math.abs((tx * 73856093) ^ (ty * 19349663)) % tile.frames;
            tileCtx.drawImage(tile.img, v * tile.fw, 0, tile.fw, tile.fh, (tx - x0) * TS, (ty - y0) * TS, TS, TS);
          }
        }
      }
      ctx.drawImage(tileCanvas, x0 * TS, y0 * TS, cols * TS, rows * TS);   // 离屏物理分辨率更高时，按逻辑尺寸贴回
    }

    // —— 装饰（y 排序已做，直接画在实体前；树按底部 y 与实体一起排序更好，M1 简化：先画装饰）——
    for (const d of decor) {
      if (Math.abs(d.x - camera.x) > W / 2 + 80 || Math.abs(d.y - camera.y) > H / 2 + 90) continue;
      Assets.draw(ctx, d.kind, 0, d.x, d.y, d.scale);
    }

    // 【2026-09-24 性能优化】视口裁剪：屏幕外的实体不再发起 drawImage 调用。
    // 高关卡怪物/弹幕/特效数量大，视野外绘制是纯浪费（原本只有装饰做了裁剪）
    const cullL = camera.x - W / 2 - 80, cullR = camera.x + W / 2 + 80;
    const cullT = camera.y - H / 2 - 90, cullB = camera.y + H / 2 + 90;
    const inView = (x, y) => x > cullL && x < cullR && y > cullT && y < cullB;

    // —— 拾取 ——
    for (const pk of pickupPool.active) { if (inView(pk.x, pk.y)) pk.draw(ctx); }

    // —— 怪 ——
    for (const e of enemyPool.active) { if (inView(e.x, e.y)) e.draw(ctx); }

    // —— Boss ——
    if (boss) boss.draw(ctx);

    // —— 玩家 ——
    hero.draw(ctx);

    // —— 弹幕 ——
    for (const p of projPool.active) { if (inView(p.x, p.y)) p.draw(ctx); }

    // —— 特效 + 伤害数字 ——
    for (const f of fxPool.active) { if (inView(f.x, f.y)) f.draw(ctx); }
    // 【2026-09-27 审查修复 P2-20】伤害数字的公共状态只设一次、按字号切换；
    // DamageText.draw 只负责 alpha 与文字本体（原先每条每帧 save/restore + 拼 font，满屏时 120 次文字绘制）
    if (dmgTextPool.active.length) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(20,20,20,0.8)";
      let lastBig = null;
      for (const d of dmgTextPool.active) {
        if (!inView(d.x, d.y)) continue;
        if (lastBig !== d.big) {
          ctx.font = (d.big ? "bold 15px" : "bold 12px") + " 'SimHei', sans-serif";
          lastBig = d.big;
        }
        d.draw(ctx);
      }
      ctx.restore();
    }

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
      // 【v26.70】松手必须把方向键清零：touchKeys() 在 touchVec 为空时是直接返回 input 的，
      // 原来的写法让 input 保留最后一次滑动时的方向，角色朝着那个方向一路跑到地图边上，
      // 玩家得再按一次屏幕才能停下——触屏操作上完全不能接受。
      // 这里只清触屏带来的分量，键盘的 keyup 各自负责，互不干扰。
      input.left = input.right = input.up = input.down = false;
    }
  };
  cv.addEventListener("touchend", joyEnd);
  cv.addEventListener("touchcancel", joyEnd);

  // 暴露
  const api = {
    start() {
      resize();
      window.addEventListener("resize", () => { resize(); invalidate(); });   // 【P2-17】窗口变化补一帧
      // 【2026-09-24 稳定性】客户端全局错误兜底：
      // ① 未捕获异常/rejection 不再静默丢掉，记入 window.__err（结算页/客服可查，便于定位"闪退"）；
      // ② 页面切后台再回来时强制一帧小步长，避免超长 dt 造成瞬移/穿模（rAF 暂停期间 last 停在旧时间戳）
      window.__err = window.__err || [];
      window.addEventListener("error", e => {
        const msg = (e && e.message) || String(e);
        if (window.__err.length < 50) window.__err.push("error: " + msg);
        console.error("[game] uncaught:", e.error || e);
      });
      window.addEventListener("unhandledrejection", e => {
        const r = e && e.reason;
        if (window.__err.length < 50) window.__err.push("rejection: " + ((r && r.message) || String(r)));
        console.error("[game] unhandledRejection:", r);
      });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
          if (state === "playing") last = 0;   // 回前台第一帧按 0.016 起步
          invalidate();   // 【P2-17】切回前台补一帧，避免非战斗画面停在旧内容
        }
      });
      requestAnimationFrame(loop);
    },
    startRun,
    // 【v26.70】删掉 restart 别名：v26.67 起结算页改走宿主层 enterBattle（扣体力 + 领票据），
    // 这个别名已无人调用，留着等于给控制台留一条「不花体力、没票据地开一局」的旁路。
    get state() { return state; },
    get hero() { return hero; },
    get __weapons() { return weapons; },
    get waveIdx() { return waveIdx; },
    pause() { state = "title"; invalidate(); },   // 【P2-17】
    get __boss() { return boss; },
    get stageMul() { return MUL; },   // 【v24.4】供 entities 读取关卡倍率
    __debug: {
      toWave(n) { waveIdx = Math.min(Math.max(n, 1), CONFIG.waves.length) - 1; startWave(waveIdx); },
      god(on) { if (hero) hero.godMode = !!on; },
      killBoss() { if (boss && boss.alive) boss.hp = 0; },
      buildChoices,   // 【v24.3】暴露三选一构建，供内测与自动化验收
      // 【v24.4】关卡与旋风刃诊断
      stage() { return { stage, mul: MUL }; },
      blades() {
        const out = [];
        for (const p of (projPool ? projPool.active : [])) {
          if (p.kind === "gale") out.push({ x: Math.round(p.x), y: Math.round(p.y), life: +p.life.toFixed(1), alive: p.alive });
        }
        return { hero: hero ? { x: Math.round(hero.x), y: Math.round(hero.y) } : null, blades: out };
      },
    },
  };
  return api;
})();

window.Game = Game;
