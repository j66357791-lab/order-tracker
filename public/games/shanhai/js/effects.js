// 拾取物 + 特效 + 伤害数字
"use strict";

// —— 经验珠 / 回血肉 ——
class Pickup {
  constructor() { this.alive = false; }
  reset(kind, x, y) {
    this.kind = kind;      // orb / meat
    this.x = x; this.y = y;
    this.vx = (Math.random() - 0.5) * 60;
    this.vy = (Math.random() - 0.5) * 60;
    this.animT = Math.random() * 4;
    this.alive = true;
    this.mag = false;      // 被磁吸
  }
  update(dt, hero) {
    this.animT += dt;
    const dx = hero.x - this.x, dy = hero.y - this.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < hero.pickupRadius) this.mag = true;
    if (this.mag) {
      const pull = 220;
      this.x += (dx / d) * pull * dt;
      this.y += (dy / d) * pull * dt;
    } else {
      this.x += this.vx * dt; this.y += this.vy * dt;
      this.vx *= 0.9; this.vy *= 0.9;
    }
    if (d < 14) {
      this.alive = false;
      if (this.kind === "orb") return "exp";
      return "heal";
    }
    return null;
  }
  draw(ctx) {
    if (this.kind === "orb") {
      const f = Assets.frame("orb", this.animT, 6);
      Assets.draw(ctx, "orb", f, this.x, this.y, 0.8);
    } else {
      Assets.draw(ctx, "meat", 0, this.x, this.y, 0.9);
    }
  }
}

// —— 通用序列帧特效 ——
class Fx {
  constructor() { this.alive = false; }
  reset(kind, x, y, scale = 1) {
    this.kind = kind;      // hit / die / levelup / smash
    this.x = x; this.y = y;
    this.scale = scale;
    this.t = 0;
    this.alive = true;
    this.fps = { hit: 16, die: 14, levelup: 12, smash: 12 }[kind] || 12;
  }
  update(dt) {
    this.t += dt;
    const frames = { hit: 4, die: 6, levelup: 6, smash: 4 }[this.kind];
    if (this.t * this.fps >= frames) this.alive = false;
  }
  draw(ctx) {
    const frames = { hit: 4, die: 6, levelup: 6, smash: 4 }[this.kind];
    const f = Math.min(frames - 1, Math.floor(this.t * this.fps));
    Assets.draw(ctx, this.kind, f, this.x, this.y, this.scale);
  }
}

// —— 伤害数字（程序渲染）——
class DamageText {
  constructor() { this.alive = false; }
  reset(x, y, text, color = "#FFE082", big = false) {
    this.x = x + (Math.random() - 0.5) * 12;
    this.y = y - 10;
    this.text = String(text);
    this.color = color;
    this.big = big;
    this.t = 0;
    this.alive = true;
  }
  update(dt) {
    this.t += dt;
    this.y -= 34 * dt;
    if (this.t > 0.7) this.alive = false;
  }
  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - this.t / 0.7);
    ctx.font = (this.big ? "bold 15px" : "bold 12px") + " 'SimHei', sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(20,20,20,0.8)";
    ctx.strokeText(this.text, this.x, this.y);
    ctx.fillStyle = this.color;
    ctx.fillText(this.text, this.x, this.y);
    ctx.restore();
  }
}

window.Pickup = Pickup;
window.Fx = Fx;
window.DamageText = DamageText;
