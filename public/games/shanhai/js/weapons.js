// 技能系统：凤凰火线 / 寒冰锥 / 敌方弹幕（策划案第五章数值）
"use strict";

// —— 玩家武器总控 ——
class WeaponSystem {
  constructor(hero) {
    this.hero = hero;
    this.slots = {};          // key -> {lv, t}
    this.addWeapon("fireline");
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
    // 凤凰火线：射最近敌人
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
  }
  update(dt) {
    this.animT += dt;
    this.life -= dt;
    if (this.life <= 0) { this.alive = false; return; }
    this.x += this.dx * this.speed * dt;
    this.y += this.dy * this.speed * dt;
  }
  draw(ctx) {
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
