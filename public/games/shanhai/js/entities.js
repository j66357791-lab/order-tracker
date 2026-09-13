// 实体层：英雄/怪物/Boss/拾取/特效（数值全部来自 CONFIG）
"use strict";

// ================= 英雄 =================
class Hero {
  constructor() {
    const C = CONFIG.hero;
    this.x = 0; this.y = 0;
    this.maxHpBase = C.hp;
    this.hp = C.hp;
    this.speed = C.speed;
    this.pickupRadius = C.pickupRadius;
    this.radius = C.radius;
    this.iframe = 0;
    this.animT = 0;
    this.facing = 1;
    this.moving = false;
    this.level = 1;
    this.exp = 0;
    this.expNext = CONFIG.expBase;
    this.kills = 0;
    this.dmgMul = 1;
    this.bodyLv = 0;          // 修身体质等级
    this.timeAlive = 0;
    this.dmgTaken = 0;
  }
  get maxHp() { return Math.round(this.maxHpBase * (1 + this.bodyLv * CONFIG.weapons.body.hpPerLv / 100)); }

  update(dt, input) {
    this.timeAlive += dt;
    this.animT += dt;
    if (this.iframe > 0) this.iframe -= dt;
    let dx = 0, dy = 0;
    if (input.left) dx -= 1;
    if (input.right) dx += 1;
    if (input.up) dy -= 1;
    if (input.down) dy += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      this.x += (dx / len) * this.speed * dt;
      this.y += (dy / len) * this.speed * dt;
      this.moving = true;
      if (dx !== 0) this.facing = dx > 0 ? 1 : -1;
    } else {
      this.moving = false;
    }
  }

  hurt(dmg) {
    if (this.iframe > 0 || this.godMode) return false;
    this.hp = Math.max(0, this.hp - dmg);
    this.dmgTaken += dmg;
    this.iframe = CONFIG.hero.iframe;
    return true;
  }

  gainExp(v) {
    this.exp += v;
    let ups = 0;
    while (this.exp >= this.expNext) {
      this.exp -= this.expNext;
      this.level++;
      this.expNext = CONFIG.expBase + CONFIG.expStep * (this.level - 1);
      ups++;
    }
    return ups;
  }

  draw(ctx) {
    // 无敌闪烁
    if (this.iframe > 0 && Math.floor(this.iframe * 20) % 2 === 0) return;
    const f = Assets.frame("hero", this.animT, this.moving ? 10 : 4);
    Assets.draw(ctx, "hero", f, this.x, this.y - 8, 1, this.facing < 0);
  }
}

// ================= 怪物 =================
class Enemy {
  constructor() { this.alive = false; }
  reset(type, x, y) {
    const d = CONFIG.enemies[type];
    this.type = type; this.def = d;
    this.x = x; this.y = y;
    this.hp = d.hp; this.maxHp = d.hp;
    this.speed = d.speed;
    this.animT = Math.random() * 4;
    this.slow = 0; this.slowT = 0;
    this.shotT = Math.random() * 1.5;
    this.facing = 1;
    this.alive = true;
    this.hitFlash = 0;
  }
  update(dt, hero, spawnBullet) {
    this.animT += dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
    let sp = this.speed;
    if (this.slowT > 0) { this.slowT -= dt; sp *= (1 - this.slow); }
    else this.slow = 0;

    const dx = hero.x - this.x, dy = hero.y - this.y;
    const dist = Math.hypot(dx, dy) || 1;

    if (this.def.behavior === "ranged") {
      // 毕方：保持射程内游走 + 周期投射火弹
      const ideal = 180;
      let mvx = 0, mvy = 0;
      if (dist > ideal + 30) { mvx = dx / dist; mvy = dy / dist; }
      else if (dist < ideal - 30) { mvx = -dx / dist; mvy = -dy / dist; }
      else { mvx = -dy / dist; mvy = dx / dist; }   // 侧向环绕
      this.x += mvx * sp * dt; this.y += mvy * sp * dt;
      this.shotT -= dt;
      if (this.shotT <= 0 && dist < this.def.shotRange) {
        this.shotT = this.def.shotCd;
        spawnBullet(this.x, this.y, dx / dist, dy / dist, this.def.shotDmg, "enemyshot");
      }
    } else {
      this.x += (dx / dist) * sp * dt;
      this.y += (dy / dist) * sp * dt;
    }
    if (Math.abs(dx) > 4) this.facing = dx > 0 ? 1 : -1;
  }
  hurt(dmg, slow) {
    this.hp -= dmg;
    this.hitFlash = 0.12;
    if (slow) { this.slow = slow.pct; this.slowT = slow.dur; }
    if (this.hp <= 0) { this.alive = false; return true; }
    return false;
  }
  draw(ctx) {
    const f = Assets.frame(this.def.anim, this.animT, 7);
    if (this.hitFlash > 0) {
      // 受击白闪：临时 canvas 滤镜太贵，用 globalAlpha 叠画一帧白色矩形近似
      ctx.save();
      ctx.globalAlpha = 0.85;
      Assets.draw(ctx, this.def.anim, f, this.x, this.y - 6, 1, this.facing < 0);
      ctx.globalCompositeOperation = "source-atop";
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.5;
      Assets.draw(ctx, this.def.anim, f, this.x, this.y - 6, 1, this.facing < 0);
      ctx.restore();
    } else {
      Assets.draw(ctx, this.def.anim, f, this.x, this.y - 6, 1, this.facing < 0);
    }
    // 血条（受伤才显示）
    if (this.hp < this.maxHp) {
      const w = 20, h = 3;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(this.x - w / 2, this.y + 10, w, h);
      ctx.fillStyle = "#E8503C";
      ctx.fillRect(this.x - w / 2, this.y + 10, w * Math.max(0, this.hp / this.maxHp), h);
    }
    // 冰减速标识
    if (this.slowT > 0) {
      ctx.fillStyle = "rgba(120,200,230,0.7)";
      ctx.fillRect(this.x - 2, this.y - 22, 4, 2);
    }
  }
}

// ================= Boss：山臊王 =================
class Boss {
  constructor() { this.alive = false; }
  reset(x, y) {
    const B = CONFIG.boss;
    this.x = x; this.y = y;
    this.hp = B.hp; this.maxHp = B.hp;
    this.animT = 0; this.phase = 0;   // 0-1 idle 2-3 蓄力 4 砸地 5 吼
    this.facing = 1;
    this.alive = true;
    this.rockT = B.rockCd; this.summonT = B.summonCd; this.smashT = B.smashCd;
    this.stateT = 0;
    this.state = "chase";   // chase / rock / summon / smash
    this.hitFlash = 0;
    this.telegraph = null;  // {x,y,r,t} 砸地预警圈
    this.smashDone = false;
    this.intro = 1.6;       // 登场无敌+展示
  }
  update(dt, hero, api) {
    this.animT += dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
    if (this.intro > 0) { this.intro -= dt; return; }
    this.stateT -= dt;

    const dx = hero.x - this.x, dy = hero.y - this.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (Math.abs(dx) > 6) this.facing = dx > 0 ? 1 : -1;

    const B = CONFIG.boss;
    // 计时器
    this.rockT -= dt; this.summonT -= dt; this.smashT -= dt;

    if (this.state === "chase") {
      const sp = B.speed * 0.8;
      this.x += (dx / dist) * sp * dt;
      this.y += (dy / dist) * sp * dt;
      this.phase = Math.floor(this.animT * 3) % 2;   // idle 呼吸
      // 触发技能（优先级：砸地>召唤>投石）
      if (this.smashT <= 0 && dist < 300) { this.enterState("smash", hero); }
      else if (this.summonT <= 0) { this.enterState("summon", hero); }
      else if (this.rockT <= 0) { this.enterState("rock", hero); }
    } else if (this.state === "rock") {
      // 蓄力 0.6s 后投掷 3 块石头
      if (this.stateT <= 0) {
        for (let i = 0; i < 3; i++) {
          const ang = Math.atan2(dy, dx) + (i - 1) * 0.35;
          api.spawnBullet(this.x, this.y - 20, Math.cos(ang), Math.sin(ang), B.rockDmg, "bossrock");
        }
        this.rockT = B.rockCd;
        this.exitState();
      }
    } else if (this.state === "summon") {
      if (this.stateT <= 0) {
        api.summonMinions(B.summonCount);
        this.summonT = B.summonCd;
        this.exitState();
      }
    } else if (this.state === "smash") {
      // 预警 0.8s → 砸地：圈内伤害 + 冲击波特效
      if (this.stateT <= 0 && !this.smashDone) {
        this.smashDone = true;
        const r = B.smashRadius;
        const d2 = Math.hypot(hero.x - this.x, hero.y - this.y);
        if (d2 < r) hero.hurt(B.smashDmg);
        api.smashFx(this.x, this.y);
        this.phase = 4;
        this.stateT = 0.5;   // 砸地硬直
      } else if (this.stateT <= 0 && this.smashDone) {
        this.smashT = B.smashCd;
        this.smashDone = false;
        this.telegraph = null;
        this.exitState();
      }
    }
  }
  enterState(s, hero) {
    this.state = s;
    if (s === "rock") { this.stateT = 0.6; this.phase = 5; }
    if (s === "summon") { this.stateT = 0.8; this.phase = 5; }
    if (s === "smash") { this.stateT = 0.8; this.phase = 2; this.telegraph = { x: this.x, y: this.y, r: CONFIG.boss.smashRadius }; this.smashDone = false; }
  }
  exitState() { this.state = "chase"; this.phase = 0; }
  hurt(dmg) {
    if (this.intro > 0) return false;
    this.hp -= dmg;
    this.hitFlash = 0.1;
    if (this.hp <= 0) { this.alive = false; return true; }
    return false;
  }
  draw(ctx) {
    if (this.intro > 0) {
      // 登场：闪红光圈
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(this.intro * 10);
      ctx.strokeStyle = "#FF7A50"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(this.x, this.y, 40 + this.intro * 20, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    // 砸地预警圈
    if (this.telegraph) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = "#E8503C";
      ctx.beginPath(); ctx.arc(this.telegraph.x, this.telegraph.y, this.telegraph.r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.8; ctx.strokeStyle = "#FF7A50"; ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
    Assets.draw(ctx, "boss", this.phase, this.x, this.y - 14, 1.4, this.facing < 0);
  }
}

window.Hero = Hero;
window.Enemy = Enemy;
window.Boss = Boss;
