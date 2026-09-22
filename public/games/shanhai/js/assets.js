// 精灵加载器 — manifest.json 驱动，帧动画解析
// 【v26.0 加载提速】① 封面/主页两张大背景由串行改并行 ② 所有 URL 带版本号（换图即失效）
//                  ③ 空闲时后台预载交易所美术，点开弹窗不再现加载
"use strict";
const Assets = (() => {
  const VER = "26";   // 资源版本号：改了任何美术素材就把这个数 +1，否则老用户会被 30 天缓存挡住看不到新图
  const sheets = {};   // name -> {img, fw, fh, frames}
  const anims = {};    // animName -> sheet

  async function load(base = "assets/sprites", onProgress = null) {
    const extra = (onProgress ? [`assets/bg/cover_bg.png?v=${VER}`, `assets/bg/home_bg.png?v=${VER}`] : []);
    const mf = await (await fetch(`${base}/manifest.json`)).json();
    if (onProgress) { onProgress(0, 2 + 21, "云游四海…"); }
    const animMap = {
      hero: "hero", zheng: "zheng", shanhaogt: "shanhaogt",
      bifang: "bifang", xuangui: "xuangui", boss: "boss_shanhaoking",
      fireball: "proj_fire", icepick: "proj_ice", sword: "sword", swordspin: "sword_spin", rock: "proj_rock",
      orb: "orb", meat: "meat", hit: "fx_hit", die: "fx_die",
      levelup: "fx_levelup", smash: "fx_smash",
      tile: "tile_grass", tree1: "deco_tree1", tree2: "deco_tree2",
      stone: "deco_stone", stele: "deco_stele",
    };
    // 预载大图（封面/主页背景）
    let done = 0; const total = 2 + Object.keys(animMap).length;
    // 【v26.0】并行加载而不是逐张 await（原来串行，多花一张图的等待时间）
    await Promise.all(extra.map(url => new Promise(res => {
      const im = new Image();
      im.onload = () => { done++; onProgress && onProgress(done, total, "山河入梦…"); res(); };
      im.onerror = () => { done++; onProgress && onProgress(done, total, ""); res(); };
      im.src = url;
    })));
    const loads = [];
    for (const [anim, key] of Object.entries(animMap)) {
      const m = mf[key];
      if (!m) continue;
      loads.push(new Promise(res => {
        const img = new Image();
        img.onload = () => {
          sheets[anim] = { img, fw: m.fw, fh: m.fh, frames: m.frames };
          done++; onProgress && onProgress(done, total, anim);
          res();
        };
        img.onerror = () => { console.error("sprite fail:", key); res(); };
        img.src = `${base}/${m.file}?v=${VER}`;
      }));
    }
    await Promise.all(loads);
    // 【v26.0】交易所美术留到空闲再取，不抢首屏带宽
    // 【v26.1】买卖图标已取消（按钮改文字），这里只预载背景板 + 交易横条 + 资产条框
    prefetchIdle([
      `assets/exchange/ex-board.png?v=${VER}`, `assets/exchange/ex-bar.png?v=${VER}`, `assets/exchange/ex-frame.png?v=${VER}`,
    ]);
    return sheets;
  }

  // 空闲预载（不支持 requestIdleCallback 的环境降级为延时触发）
  function prefetchIdle(urls) {
    const go = () => urls.forEach(u => { const i = new Image(); i.src = u; });
    if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 3000 });
    else setTimeout(go, 1500);
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
