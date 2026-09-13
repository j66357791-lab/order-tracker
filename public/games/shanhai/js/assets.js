// 精灵加载器 — manifest.json 驱动，帧动画解析
"use strict";
const Assets = (() => {
  const sheets = {};   // name -> {img, fw, fh, frames}
  const anims = {};    // animName -> sheet

  async function load(base = "assets/sprites") {
    const mf = await (await fetch(`${base}/manifest.json`)).json();
    const animMap = {
      hero: "hero", zheng: "zheng", shanhaogt: "shanhaogt",
      bifang: "bifang", xuangui: "xuangui", boss: "boss_shanhaoking",
      fireball: "proj_fire", icepick: "proj_ice", rock: "proj_rock",
      orb: "orb", meat: "meat", hit: "fx_hit", die: "fx_die",
      levelup: "fx_levelup", smash: "fx_smash",
      tile: "tile_grass", tree1: "deco_tree1", tree2: "deco_tree2",
      stone: "deco_stone", stele: "deco_stele",
    };
    const loads = [];
    for (const [anim, key] of Object.entries(animMap)) {
      const m = mf[key];
      if (!m) continue;
      loads.push(new Promise(res => {
        const img = new Image();
        img.onload = () => {
          sheets[anim] = { img, fw: m.fw, fh: m.fh, frames: m.frames };
          res();
        };
        img.onerror = () => { console.error("sprite fail:", key); res(); };
        img.src = `${base}/${m.file}`;
      }));
    }
    await Promise.all(loads);
    return sheets;
  }

  function get(anim) { return sheets[anim]; }

  // 帧号取整（动画循环）
  function frame(anim, t, fps = 8) {
    const s = sheets[anim];
    if (!s) return 0;
    return Math.floor(t * fps) % s.frames;
  }

  // 绘制：ctx, anim, 序号, 目标中心 x,y, 尺寸缩放, 水平翻转
  function draw(ctx, anim, f, cx, cy, scale = 1, flip = false) {
    const s = sheets[anim];
    if (!s) return;
    const w = s.fw * scale, h = s.fh * scale;
    ctx.save();
    ctx.translate(cx, cy);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(s.img, f * s.fw, 0, s.fw, s.fh, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  return { load, get, frame, draw, sheets };
})();
window.Assets = Assets;
