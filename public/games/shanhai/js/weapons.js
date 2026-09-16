// 技能系统：御剑术（初始飞剑）/ 火球术 / 寒冰锥 / 敌方弹幕
"use strict";

// —— 玩家武器总控 ——
class WeaponSystem {
  constructor(hero) {
    this.hero = hero;
    this.slots = {};          // key -> {lv, t}
    // 【2026-09-15】初始武器：御剑术（飞剑）——进游戏就有；火球术改为升级习得
    this.addWeapon("sword");
    // 飞剑五诀技能点（升级三选一里点）
    this.swordSkill = { count: 0, atk: 0, spd: 0, lock: 0, burst: 0 };
    this.swordShot = 0;       // 发剑计数（万剑归宗触发器）
  }
  has(key) { return !!this.slots[key]; }
  lv(key) { return this.slots[key] ? this.slots[key].lv : 0; }
  addWeapon(key) {
    if (this.slots[key]) return false;
    this.slots[key] = { lv: 1, t: 0 };
    if (key === "body") {
      // 被动：立即生效（回满按比例）
      const h = this.hero;
      const ratio = h.hp / h.maxHp;
      h.bodyLv = 1;
      h.hp = Math.min(h.maxHp, Math.round(h.maxHp * ratio + 20));
    }
    return true;
  }
  upgrade(key) {
    const s = this.slots[key];
    if (!s) return this.addWeapon(key);
    if (s.lv >= CONFIG.weapons[key].maxLv) return false;
    s.lv++;
    if (key === "body") {
      const h = this.hero;
      h.bodyLv = s.lv;
      h.hp = Math.min(h.maxHp, h.hp + CONFIG.weapons.body.hpPerLv);
    }
    return true;
  }

  // —— 飞剑参数（御剑术 + 五诀加成 + 装备武器数值）——
  swordParams() {
    const W = CONFIG.weapons.sword, S = this.swordSkill;
    const wpn = (window.META && META.profile && META.profile.equip && META.profile.equip.weapon) || null;
    // 【2026-09-16】卸掉武器也能打：角色基础攻击力 5（武器数值叠在其上）
    const wpnAtk = wpn ? (wpn.val || 0) : 0;
    return {
      dmg: (5 + wpnAtk) * (1 + 0.2 * S.atk) * this.hero.dmgMul,
      cd: W.cd / (1 + 0.2 * S.spd),
      count: 1 + S.count,                       // 诀一：+1把（可点两次→3把）
      speed: W.projSpeed, radius: W.projRadius,
      homing: S.lock > 0,                       // 诀四：锁定怪物（追踪弹道）
      burst: S.burst > 0,                       // 诀五：每50发触发万剑归宗
    };
  }
  // 弹幕参数（按等级）
  firelineParams() {
    const W = CONFIG.weapons.fireline, lv = this.lv("fireline");
    return {
      dmg: (W.baseDmg + W.dmgPerLv * (lv - 1) + (lv >= 5 ? W.dmgPerLv : 0)) * this.hero.dmgMul * (this.hero.dmgFireExternal || 1),
      cd: W.cd + W.cdPerLv * (lv - 1),
      count: 1 + (lv >= 3 ? 1 : 0) + (lv >= 5 ? 1 : 0),
      speed: W.projSpeed, radius: W.projRadius * (this.hero.fireScale || 1),
      scale: this.hero.fireScale || 1,
    };
  }
  icepickParams() {
    const W = CONFIG.weapons.icepick, lv = this.lv("icepick");
    if (!lv) return null;
    return {
      dmg: (W.baseDmg + W.dmgPerLv * (lv - 1)) * this.hero.dmgMul * (this.hero.dmgIceExternal || 1),
      cd: W.cd + W.cdPerLv * (lv - 1),
      count: 1 + (lv >= 3 ? 1 : 0) + (this.hero.iceBonus || 0),
      pierce: W.pierce + W.piercePerLv * (lv - 1),
      speed: W.projSpeed, radius: W.projRadius,
      slow: { pct: W.slowPct, dur: W.slowDur },
    };
  }

  update(dt, enemies, fire, boss) {
    for (const s of Object.values(this.slots)) s.t -= dt;
    // 索敌候选 = 小怪池 + Boss（修复：Boss 战小怪清空后停火）
    const cand = enemies.active.concat(boss && boss.alive ? [boss] : []);
    // —— 御剑术：飞剑射向最近之敌 ——
    const sp = this.swordParams();
    const sslot = this.slots.sword;
    if (sslot && sslot.t <= 0) {
      const targets = nearestEnemies(cand, this.hero, Math.max(sp.count, 1));
      if (targets.length) {
        sslot.t = sp.cd;
        for (const tgt of targets) {
          const dx = tgt.x - this.hero.x, dy = tgt.y - this.hero.y;
          const d = Math.hypot(dx, dy) || 1;
          this.swordShot++;
          fire("sword", this.hero.x, this.hero.y - 8, dx / d, dy / d, { ...sp, target: sp.homing ? tgt : null });
        }
        // 诀五·万剑归宗：每射50剑，人物同时飞出10把旋转飞剑轰向妖群（不锁定）
        if (sp.burst && this.swordShot % 50 === 0 && cand.length) {
          let cx = 0, cy = 0, n = 0;
          for (const e of cand) { if (e.x !== undefined) { cx += e.x; cy += e.y; n++; } }
          if (n) { cx /= n; cy /= n;
            for (let i = 0; i < 10; i++) {
              const a = Math.atan2(cy - this.hero.y, cx - this.hero.x) + (Math.random() - 0.5) * 1.6;
              fire("swordburst", this.hero.x, this.hero.y, Math.cos(a), Math.sin(a), { ...sp, dmg: sp.dmg * 0.6, homing: false, target: null });
            }
            UI.toast('万剑归宗！');
          }
        }
      }
    }
    // 火球术：射最近敌人
    const fp = this.firelineParams();
    const slot = this.slots.fireline;
    if (slot && slot.t <= 0) {
      const targets = nearestEnemies(cand, this.hero, fp.count);
      if (targets.length) {
        slot.t = fp.cd;
        for (const tgt of targets) {
          const dx = tgt.x - this.hero.x, dy = tgt.y - this.hero.y;
          const d = Math.hypot(dx, dy) || 1;
          fire("fireline", this.hero.x, this.hero.y - 8, dx / d, dy / d, fp);
        }
      }
    }
    // 寒冰锥
    const ip = this.icepickParams();
    const islot = this.slots.icepick;
    if (ip && islot && islot.t <= 0) {
      const targets = nearestEnemies(cand, this.hero, ip.count);
      if (targets.length) {
        islot.t = ip.cd;
        for (const tgt of targets) {
          const dx = tgt.x - this.hero.x, dy = tgt.y - this.hero.y;
          const d = Math.hypot(dx, dy) || 1;
          fire("icepick", this.hero.x, this.hero.y - 8, dx / d, dy / d, ip);
        }
      }
    }
  }
}

function nearestEnemies(candidates, hero, n) {
  // 索敌：候选（含Boss）中取距离最小的 n 个（量≤60，直接扫描足够快）
  const arr = [];
  for (const e of candidates) {
    const d = (e.x - hero.x) ** 2 + (e.y - hero.y) ** 2;
    if (d < 420 * 420) arr.push({ e, d });
  }
  arr.sort((a, b) => a.d - b.d);
  return arr.slice(0, n).map(o => o.e);
}

// —— 投射物（玩家弹 & 敌方弹共用）——
class Projectile {
  constructor() { this.alive = false; }
  reset(kind, x, y, dx, dy, params) {
    this.kind = kind;        // fireline / icepick / enemyshot / bossrock
    this.x = x; this.y = y;
    this.dx = dx; this.dy = dy;
    this.dmg = params.dmg;
    this.speed = params.speed ?? 260;
    this.radius = params.radius ?? 6;
    this.pierce = params.pierce ?? 0;
    this.slow = params.slow || null;
    this.hitIds = [];
    this.animT = Math.random() * 2;
    this.alive = true;
    this.life = 3.2;        // 寿命
    this.spin = Math.random() * Math.PI * 2;
    this.scale = params.scale || 1;
    // 【2026-09-15】飞剑：锁定目标（追踪）与旋转形态
    this.target = params.target || null;
    this.homing = !!params.homing;
    this.isSword = (kind === "sword" || kind === "swordburst");
  }
  update(dt) {
    this.animT += dt;
    this.life -= dt;
    if (this.life <= 0) { this.alive = false; return; }
    // 锁妖剑诀：弹道追踪目标（目标死亡则直线飞出）
    if (this.homing && this.target && this.target.alive !== false) {
      const tx = this.target.x - this.x, ty = this.target.y - this.y;
      const d = Math.hypot(tx, ty) || 1;
      const steer = 6 * dt;   // 转向速率
      this.dx += (tx / d - this.dx) * steer;
      this.dy += (ty / d - this.dy) * steer;
      const dd = Math.hypot(this.dx, this.dy) || 1;
      this.dx /= dd; this.dy /= dd;
    } else if (this.homing) { this.homing = false; }
    this.x += this.dx * this.speed * dt;
    this.y += this.dy * this.speed * dt;
  }
  draw(ctx) {
    if (this.isSword) {
      if (this.kind === "swordburst") {
        // 万剑归宗：旋转序列帧飞剑
        this.spin += (window.Game && Game.lastDt || 0.016) * 14;
        const f = Assets.frame("swordspin", this.animT, 10);
        ctx.save(); ctx.translate(this.x, this.y); ctx.rotate(this.spin);
        Assets.draw(ctx, "swordspin", f, 0, 0, 1.1);
        ctx.restore();
      } else {
        // 普通飞剑：剑尖朝向飞行方向（+90°，贴图竖直向上）+ 剑光拖尾强化方向感
        ctx.save();
        ctx.strokeStyle = "rgba(230, 245, 235, .5)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(this.x - this.dx * 22, this.y - this.dy * 22);
        ctx.lineTo(this.x - this.dx * 6, this.y - this.dy * 6);
        ctx.stroke();
        ctx.restore();
        ctx.save(); ctx.translate(this.x, this.y);
        ctx.rotate(Math.atan2(this.dy, this.dx) + Math.PI / 2);
        Assets.draw(ctx, "sword", 0, 0, 1.25);
        ctx.restore();
      }
      return;
    }
    if (this.kind === "fireline") {
      const f = Assets.frame("fireball", this.animT, 12);
      Assets.draw(ctx, "fireball", f, this.x, this.y, this.scale || 1);
      // 运动拖尾残影（视觉强化）
      ctx.save();
      ctx.globalAlpha = 0.3;
      Assets.draw(ctx, "fireball", f, this.x - this.dx * 10, this.y - this.dy * 10, (this.scale || 1) * 0.8);
      ctx.restore();
    } else if (this.kind === "icepick") {
      const f = Assets.frame("icepick", this.animT, 10);
      // 朝向旋转
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(Math.atan2(this.dy, this.dx));
      Assets.draw(ctx, "icepick", f, 0, 0, 1);
      ctx.restore();
    } else if (this.kind === "bossrock") {
      const f = Assets.frame("rock", this.animT, 6);
      this.spin += 0.2;
      ctx.save(); ctx.translate(this.x, this.y); ctx.rotate(this.spin);
      Assets.draw(ctx, "rock", f, 0, 0, 1.2);
      ctx.restore();
    } else if (this.kind === "enemyshot") {
      // 敌方火弹：程序绘制小火球
      ctx.save();
      ctx.fillStyle = "#F49B30";
      ctx.beginPath(); ctx.arc(this.x, this.y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#FFE082";
      ctx.beginPath(); ctx.arc(this.x, this.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
}

window.WeaponSystem = WeaponSystem;
window.Projectile = Projectile;
window.nearestEnemies = nearestEnemies;
