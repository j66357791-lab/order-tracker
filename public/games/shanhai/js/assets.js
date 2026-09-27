// 精灵加载器 — manifest.json 驱动，帧动画解析
// 【v26.0 加载提速】① 封面/主页两张大背景由串行改并行 ② 所有 URL 带版本号（换图即失效）
//                  ③ 空闲时后台预载交易所美术，点开弹窗不再现加载
"use strict";
const Assets = (() => {
  const VER = "26";   // 资源版本号：改了任何美术素材就把这个数 +1，否则老用户会被 30 天缓存挡住看不到新图
  const sheets = {};   // name -> {img, fw, fh, frames}
  const anims = {};    // animName -> sheet

  // 【2026-09-27 审查修复 P2-23】加载兜底：弱网下图片请求可能既不 onload 也不 onerror（挂起），
  // Promise.all 永远不 resolve，进度条卡死在"山河入梦…"且无任何提示。
  // 每个资源 8 秒超时；失败的自动重试一次；仍失败记入 missing（页面会明确提示），绝不再无限等待。
  const LOAD_TIMEOUT = 8000;
  let missing = [];
  function loadImage(url) {
    return new Promise(res => {
      const im = new Image();
      let settled = false;
      const done = ok => { if (!settled) { settled = true; res(ok ? im : null); } };
      im.onload = () => done(true);
      im.onerror = () => done(false);
      setTimeout(() => done(false), LOAD_TIMEOUT);
      im.src = url;
    });
  }

  async function load(base = "assets/sprites", onProgress = null) {
    missing = [];
    const animMap = {
      hero: "hero", zheng: "zheng", shanhaogt: "shanhaogt",
      bifang: "bifang", xuangui: "xuangui", boss: "boss_shanhaoking",
      fireball: "proj_fire", icepick: "proj_ice", sword: "sword", swordspin: "sword_spin", rock: "proj_rock",
      orb: "orb", meat: "meat", hit: "fx_hit", die: "fx_die",
      levelup: "fx_levelup", smash: "fx_smash",
      tile: "tile_grass", tree1: "deco_tree1", tree2: "deco_tree2",
      stone: "deco_stone", stele: "deco_stele",
    };
    // 【P2-23】进度总数按 animMap 实际条目数算（原先硬编码 2+21，删图后进度算不准）
    const spriteJobs = [];
    for (const [anim, key] of Object.entries(animMap)) {
      spriteJobs.push({ anim, key });
    }
    const extra = (onProgress ? [`assets/bg/cover_bg.png?v=${VER}`, `assets/bg/home_bg.png?v=${VER}`] : []);
    const total = extra.length + spriteJobs.length;
    if (onProgress) { onProgress(0, total, "云游四海…"); }
    // 资源清单同样要超时：它挂起会让整个 load() 卡死；失败则抛错走页面的 catch 显示"加载失败"
    const mf = await Promise.race([
      fetch(`${base}/manifest.json`).then(r => r.json()),
      new Promise((_, rej) => setTimeout(() => rej(new Error("资源清单加载超时")), LOAD_TIMEOUT)),
    ]);
    let done = 0;
    const tick = name => { done++; onProgress && onProgress(done, total, name); };
    // 【v26.0】并行加载而不是逐张 await（原来串行，多花一张图的等待时间）
    await Promise.all(extra.map(url => loadImage(url).then(im => {
      if (!im) missing.push(url);
      tick("山河入梦…");
    })));
    const jobs = spriteJobs.map(j => ({ anim: j.anim, m: mf[j.key], url: `${base}/${(mf[j.key] || {}).file}?v=${VER}` }))
      .filter(j => j.m);
    await Promise.all(jobs.map(job => loadImage(job.url).then(im => {
      if (im) sheets[job.anim] = { img: im, fw: job.m.fw, fh: job.m.fh, frames: job.m.frames };
      else { missing.push(job.url); console.error("sprite fail:", job.anim); }
      tick(job.anim);
    })));
    // 【P2-23】失败的自动重试一次（弱网抖动多数能救回）；仍失败的留在 missing 里交给页面提示
    if (missing.length) {
      const firstPass = missing.slice();
      missing = [];
      await new Promise(r => setTimeout(r, 800));
      const again = await Promise.all(firstPass.map(url => loadImage(url)));
      again.forEach((im, i) => {
        if (im) {
          const job = jobs.find(j => j.url === firstPass[i]);
          if (job) sheets[job.anim] = { img: im, fw: job.m.fw, fh: job.m.fh, frames: job.m.frames };
        } else {
          missing.push(firstPass[i]);
        }
      });
    }
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
  // 【2026-09-24 性能优化】不翻转时省掉 save/translate/restore 三次状态机操作——
  // 每帧几十上百个实体的绘制调用，这是占比最高的纯开销
  function draw(ctx, anim, f, cx, cy, scale = 1, flip = false) {
    const s = sheets[anim];
    if (!s) return;
    const w = s.fw * scale, h = s.fh * scale;
    if (flip) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(-1, 1);
      ctx.drawImage(s.img, f * s.fw, 0, s.fw, s.fh, -w / 2, -h / 2, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(s.img, f * s.fw, 0, s.fw, s.fh, cx - w / 2, cy - h / 2, w, h);
    }
  }

  return { load, get, frame, draw, sheets, missing: () => missing };
})();
window.Assets = Assets;
