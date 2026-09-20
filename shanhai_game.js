// shanhai_game.js — 山海斩妖录（割草 + 养成）游戏模块
// 挂载方式（server.js 末尾）：require('./shanhai_game')(app, { auth, getDb, cnDayStr });
// 设计原则（与 games.js 一致）：
//   1) 战绩合理性校验在服务端完成，客户端上报的数值不可信
//   2) 档案更新走 findOneAndUpdate + $inc/$max 原子操作，并发刷不掉
//   3) 独立集合 shanhai_profiles，不污染其他游戏数据
// 【2026-09-14】养成层（斩妖录·贰）：仙玉/灵气双货币 + 6槽装备 + 背包 + 抽卡 + 技能强化
// 【2026-09-17 安全修复】补战绩上限/关卡上限/接口限流，堵住脚本刷仙玉的口子
import { limit } from './lib/ratelimit.js';

export default function mountShanhaiGame(app, { auth, getDb }) {

  // ==================== 反作弊阈值 ====================
  // 【v24.4】第一章 · 南山草泽扩为普通 20 关：上限与击杀密度随关卡放大
  const LIMITS = {
    maxTimeSec: 7200,        // 单局时长上限 2h
    maxKillsPerMin: 120,     // 击杀/分钟基准（L1 波次密度 < 60；高关卡密度更高，按关卡放大）
    maxLevel: 60,            // 等级上限（20 关经验总量提升）
    winMinTimeSec: 60,       // 通关最短合理用时（15波+Boss < 1min 不可能）
    maxStage: 20,            // 关卡数上限——第一章普通 20 关
    killHardCap: 20000,      // 单局击杀硬上限（防超长挂机脚本刷仙玉）
  };

  // ==================== 养成层配置 ====================
  const META_CFG = {
    initXianyu: 300,             // 新档案赠送仙玉
    killXianyu: 1,               // 每斩一只妖得仙玉
    winXianyu: 50,               // 通关额外
    firstClearXianyu: 150,       // 每关首通额外
    winLingqi: 5,                // 通关得灵气（占位货币，后续版本开放用途）
    drawCost: 120,               // 抽一件装备
    bagMax: 50,                  // 背包上限
    upgradeCost: lv => 80 + lv * 60,   // 技能强化费用（lv为当前等级）
    maxSkillLv: 5,
  };

  // 装备槽位定义（客户端与这里必须一致）
  const SLOTS = ['weapon', 'armor', 'crown', 'belt', 'boots', 'accessory'];
  const SLOT_NAME = { weapon: '武器', armor: '衣服', crown: '发冠', belt: '腰带', boots: '鞋子', accessory: '配饰' };
  // 品质：白/绿/蓝/紫/金（权重与数值倍率）
  const QUALITY = [
    { id: 'white', name: '凡品', w: 52, mul: 1.0, color: '#cfd8dc' },
    { id: 'green', name: '良品', w: 28, mul: 1.6, color: '#8ef0a0' },
    { id: 'blue',  name: '上品', w: 14, mul: 2.4, color: '#8ecff0' },
    { id: 'purple',name: '仙品', w: 5,  mul: 3.6, color: '#c9a0ff' },
    { id: 'gold',  name: '神品', w: 1,  mul: 5.5, color: '#ffd76a' },
  ];
  // 各槽位词条池（base = 该品质基准数值）
  const AFFIX = {
    weapon:   { name: '攻', base: 6 },    // 攻击 +%
    armor:    { name: '御', base: 8 },    // 生命 +%
    crown:    { name: '慧', base: 5 },    // 经验获取 +%
    belt:     { name: '纳', base: 6 },    // 拾取范围 +%
    boots:    { name: '迅', base: 4 },    // 移速 +%
    accessory:{ name: '炁', base: 5 },    // 全伤害 +%
  };
  const randName = (slot, q) => {
    const pre = { white: '粗', green: '精', blue: '玄', purple: '灵', gold: '神' }[q];
    const body = { weapon: '铁剑', armor: '布袍', crown: '木簪', belt: '麻绦', boots: '草履', accessory: '石珮' }[slot];
    const suf = { white: '', green: '', blue: '', purple: '·淬', gold: '·炼' }[q];
    return pre + body + suf;
  };
  const rollItem = () => {
    const totalW = QUALITY.reduce((s, q) => s + q.w, 0);
    let r = Math.random() * totalW, q = QUALITY[0];
    for (const qq of QUALITY) { if ((r -= qq.w) <= 0) { q = qq; break; } }
    const slot = SLOTS[Math.floor(Math.random() * SLOTS.length)];
    const a = AFFIX[slot];
    const val = Math.round(a.base * q.mul * (0.9 + Math.random() * 0.25) * 10) / 10;
    // 【v24.6】玄机宝阁九阶：一阶寻宝产出「一阶」装备；老装备无 tier 字段，前端按一阶显示
    return { id: 'eq' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), slot, tier: 1, quality: q.id, qualityName: q.name, color: q.color, name: randName(slot, q.id), affix: a.name, val };
  };

  async function ensureProfile(db, userId, username) {
    const doc = {
      userId,
      username: username || userId,
      plays: 0, wins: 0, bestKills: 0,   // bestTimeSec 不预置：$min 对已存在的 null 不生效（Mongo 语义），缺失时 $min 正常写入
      totalKills: 0, maxLevel: 0, updatedAt: new Date(),
      // 【2026-09-14】养成层字段
      xianyu: META_CFG.initXianyu,     // 仙玉（通关斩妖产出，抽卡/强化消耗）
      lingqi: 0,                        // 灵气（占位积累，后续版本开放用途）
      skillLv: { fireline: 0, icepick: 0, body: 0 },
      // 【2026-09-15】初始武器：新手飞剑（白色·攻击力+3·攻速1·无附加·无技能）【v24.6 标为一阶】
      equip: { weapon: { id: 'eq_sword_starter', slot: 'weapon', tier: 1, quality: 'white', qualityName: '凡品', color: '#cfd8dc', name: '新手飞剑', affix: '攻', val: 3, atkSpd: 1 }, armor: null, crown: null, belt: null, boots: null, accessory: null },
      bag: [],
      clearedStages: [],
      stageStars: {},   // 【v24.5】每关最高星级（跨设备保留，前端解锁与展示都用它）
      idleAt: new Date(),        // 【v24.7】挂机计时起点（服务端时间，不信客户端）
      idleKeyProgress: 0,        // 【v24.7】挂机累计的钥匙进度（小数；凑整后在道具合成里兑换）
    };
    await db.collection('shanhai_profiles').updateOne(
      { userId }, { $setOnInsert: doc }, { upsert: true });
    return await db.collection('shanhai_profiles').findOne({ userId });
  }

  // ==================== 档案 ====================
  app.get('/api/shanhai/profile', auth, async (req, res) => {
    try {
      const db = await getDb();
      let p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      // 【2026-09-16】新手飞剑一次性发放（swordInit 标记）：第一次进入必得；
      // 之后允许自由卸下/更换（卸下=裸手，角色自带基础攻击 5，游戏逻辑不断）
      if (!p.swordInit) {
        await db.collection('shanhai_profiles').updateOne(
          { userId: req.user.id },
          { $set: { swordInit: true, 'equip.weapon': p.equip && p.equip.weapon ? p.equip.weapon : { id: 'eq_sword_starter', slot: 'weapon', tier: 1, quality: 'white', qualityName: '凡品', color: '#cfd8dc', name: '新手飞剑', affix: '攻', val: 3, atkSpd: 1 } } });
        p = await db.collection('shanhai_profiles').findOne({ userId: req.user.id });
      }
      res.json({ ok: true, profile: p });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ==================== 挂机收益配置（v24.7 按定稿口径） ====================
  // 产出：① 仙玉 0.1/分钟 + 0.05/分钟×已通关最高关  ② 钥匙 0.0001/分钟 + 0.0001/分钟×已通关最高关
  // 钥匙为小数进度累积，凑齐整把后在「道具合成」里兑换才进翻翻乐背包（避免小数道具流进翻翻乐）
  const IDLE_CFG = {
    unlockStage: 5,      // 通关第 5 关解锁
    maxHours: 8,         // 累计上限 8 小时
    xianyuBase: 0.1,
    xianyuPerStage: 0.05,
    keyBase: 0.0001,
    keyPerStage: 0.0001,
  };
  const clearedTop = p => (p && Array.isArray(p.clearedStages) && p.clearedStages.length) ? Math.max(...p.clearedStages) : 0;
  function idleCalc(p, nowMs) {
    const top = clearedTop(p);
    const unlocked = top >= IDLE_CFG.unlockStage;
    const last = p && p.idleAt ? new Date(p.idleAt).getTime() : nowMs;
    const raw = Math.max(0, Math.floor((nowMs - last) / 1000));
    const capped = Math.min(raw, IDLE_CFG.maxHours * 3600);
    const mins = capped / 60;
    const xRate = IDLE_CFG.xianyuBase + IDLE_CFG.xianyuPerStage * top;
    const kRate = IDLE_CFG.keyBase + IDLE_CFG.keyPerStage * top;
    const xianyuGain = Math.floor(mins * xRate);
    const keyGain = +(mins * kRate).toFixed(6);
    const keyProgress = +(((p && p.idleKeyProgress) || 0) + (unlocked ? keyGain : 0)).toFixed(6);
    return {
      unlocked, top, elapsedSec: capped, rawSec: raw, capped: raw > capped,
      xianyuGain: unlocked ? xianyuGain : 0,
      xianyuRate: +xRate.toFixed(3),
      keyRate: +kRate.toFixed(5),
      keyProgress,
      claimableKeys: Math.floor(keyProgress),
    };
  }

  // ==================== 战绩上报（含养成奖励结算） ====================
  // 【2026-09-17 安全加固】限流：一局至少一分钟，10次/分钟足够正常上报，脚本高频刷分会被挡下
  app.post('/api/shanhai/result', auth, limit({ name: 'shanhai-result', max: 10, windowMs: 60 * 1000, msg: '战绩上报太频繁，请稍后再试' }), async (req, res) => {
    try {
      const db = await getDb();
      const { win, timeSec, kills, level, dmgTaken, stage, hpPct } = req.body || {};
      const t = Math.floor(Number(timeSec) || 0);
      const k = Math.floor(Number(kills) || 0);
      const lv = Math.floor(Number(level) || 1);
      const isWin = !!win;
      const st = Math.floor(Number(stage) || 1);

      // —— 合理性校验（不合格只记战绩不发奖励） ——
      // 【2026-09-17 安全修复】原校验在 t≤30 秒时不检查击杀上限（上报 timeSec=30,
      // kills=100万 可白拿百万仙玉），且 stage 无上限可无限刷首通奖励——补上绝对上限
      // 【v24.4】击杀密度上限随关卡放大（高关卡波次密度更高，1 + 0.16×(st-1)）
      const densityCap = Math.ceil(LIMITS.maxKillsPerMin * (1 + 0.16 * (st - 1)));
      const kCap = Math.min(LIMITS.killHardCap, Math.ceil(Math.max(t, 60) / 60) * densityCap + 50);
      const bad = t < 0 || t > LIMITS.maxTimeSec
        || k < 0 || k > kCap
        || lv < 1 || lv > LIMITS.maxLevel
        || st < 1 || st > LIMITS.maxStage
        || (isWin && t < LIMITS.winMinTimeSec);
      if (bad) return res.status(400).json({ ok: false, error: '战绩数据异常，本局不计' });

      // —— 首通判定（在 $addToSet 前查） ——
      const before = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const firstClear = isWin && !(before.clearedStages || []).includes(st);

      // —— 战绩 + 养成奖励原子入账 ——
      // 【v24.4】首通奖励随关卡递增：150 + 30×(st-1)，上限 720
      const firstClearGain = Math.min(720, META_CFG.firstClearXianyu + (st - 1) * 30);
      const gainXianyu = k * META_CFG.killXianyu + (isWin ? META_CFG.winXianyu : 0) + (firstClear ? firstClearGain : 0);
      const gainLingqi = isWin ? META_CFG.winLingqi : 0;
      // 【v24.5】星级改按剩余血量：满血 3 星 / ≥60% 2 星 / <60% 1 星
      // （原来按用时算，玩家反馈"满血通关只给一星"）
      const hp = Number(hpPct);
      const stars = isWin
        ? (Number.isFinite(hp) ? (hp >= 0.999 ? 3 : hp >= 0.6 ? 2 : 1) : (t < 180 ? 3 : t < 360 ? 2 : 1))
        : 0;
      // 【二次复核修正】bestTimeSec 原来用对象展开生成第二个 $set，首通那一局会把
      // 前面 $set 里的 username/updatedAt 整体覆盖丢掉——改为预先组装同一个 $set
      const setResult = { username: req.user.displayName || req.user.username, updatedAt: new Date() };
      if (isWin && t > 0 && before.bestTimeSec == null) setResult.bestTimeSec = t;
      const upd = {
        $inc: { plays: 1, wins: isWin ? 1 : 0, totalKills: k, xianyu: gainXianyu, lingqi: gainLingqi },
        // 【v24.5】星级写入档案（$max 保证只升不降）
        $max: isWin ? { bestKills: k, maxLevel: lv, ["stageStars." + st]: stars } : { bestKills: k, maxLevel: lv },
        $set: setResult,
        ...(firstClear ? { $addToSet: { clearedStages: st } } : {}),
      };
      if (isWin && t > 0 && before.bestTimeSec != null) upd.$min = { bestTimeSec: t };
      const r = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: req.user.id },
        upd,
        { returnDocument: 'after', upsert: true }
      );
      const p = r.value || r;
      res.json({
        ok: true,
        xianyu: gainXianyu, lingqi: gainLingqi, firstClear, stars,
        balance: { xianyu: p.xianyu, lingqi: p.lingqi },
        stageStars: p.stageStars || {},
        profile: { plays: p.plays, wins: p.wins, bestTimeSec: p.bestTimeSec, bestKills: p.bestKills },
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ==================== 挂机收益（v24.7） ====================
  // 预览：随时可查，不写入
  app.get('/api/shanhai/idle', auth, async (req, res) => {
    try {
      const db = await getDb();
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const r = idleCalc(p, Date.now());
      res.json({
        ok: true,
        unlocked: r.unlocked, unlockStage: IDLE_CFG.unlockStage, top: r.top,
        elapsedSec: r.elapsedSec, capped: r.capped, maxHours: IDLE_CFG.maxHours,
        xianyuGain: r.xianyuGain, xianyuRate: r.xianyuRate,
        keyRate: r.keyRate, keyProgress: r.keyProgress, claimableKeys: r.claimableKeys,
        totalKeys: p.keysFromIdle || 0,
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 领取：服务端按 idleAt 计时结算（客户端时间不可信）；仙玉直接入账，钥匙进合成进度
  app.post('/api/shanhai/idle/claim', auth, limit({ name: 'shanhai-idle', max: 12, windowMs: 60 * 1000, msg: '领取太频繁，稍等片刻' }), async (req, res) => {
    try {
      const db = await getDb();
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const r = idleCalc(p, Date.now());
      if (!r.unlocked) return res.status(400).json({ ok: false, error: '通关第 ' + IDLE_CFG.unlockStage + ' 关后解锁挂机收益' });
      if (r.xianyuGain <= 0 && r.elapsedSec < 60) return res.status(400).json({ ok: false, error: '挂机不足 1 分钟，再等等' });
      const upd = {
        $inc: { xianyu: r.xianyuGain },
        $set: { idleAt: new Date(), idleKeyProgress: r.keyProgress, updatedAt: new Date() },
      };
      const out = await db.collection('shanhai_profiles').findOneAndUpdate({ userId: req.user.id }, upd, { returnDocument: 'after' });
      const np = out && (out.value || out);
      await db.collection('shanhai_logs').insertOne({
        userId: req.user.id, action: 'idle_claim', detail: { sec: r.elapsedSec, xianyu: r.xianyuGain, keyGain: +(r.keyProgress - ((p.idleKeyProgress) || 0)).toFixed(6), keyRate: r.keyRate }, createdAt: new Date(),
      }).catch(() => {});
      res.json({ ok: true, xianyuGain: r.xianyuGain, elapsedSec: r.elapsedSec, capped: r.capped, keyProgress: r.keyProgress, claimableKeys: r.claimableKeys, balance: { xianyu: np.xianyu, lingqi: np.lingqi } });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 兑换：把凑齐的整把钥匙送进翻翻乐背包（小数进度留在这里，避免脏数据进翻翻乐）
  app.post('/api/shanhai/idle/craft', auth, limit({ name: 'shanhai-craft', max: 20, windowMs: 60 * 1000, msg: '兑换太频繁，稍等片刻' }), async (req, res) => {
    try {
      const db = await getDb();
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const prog = +((p.idleKeyProgress || 0)).toFixed(6);
      const n = Math.floor(prog);
      if (n < 1) return res.status(400).json({ ok: false, error: '钥匙还没凑齐（当前进度 ' + prog.toFixed(4) + ' / 1）' });
      // 1) 扣进度
      const out = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: req.user.id, idleKeyProgress: { $gte: n } },
        { $inc: { idleKeyProgress: -n, keysFromIdle: n }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      const np = out && (out.value || out);
      if (!np) return res.status(409).json({ ok: false, error: '请刷新后再试' });
      // 2) 进翻翻乐背包（同一数据库，直接原子加钥匙）
      await db.collection('game_profiles').updateOne(
        { userId: req.user.id },
        { $inc: { keys: n }, $set: { updatedAt: new Date() }, $setOnInsert: { balls: 0, frags: 0, revives: 0, bagS: 0, bagM: 0, bagL: 0, createdAt: new Date() } },
        { upsert: true }
      );
      await db.collection('shanhai_logs').insertOne({
        userId: req.user.id, action: 'idle_craft', detail: { keys: n, left: +((np.idleKeyProgress) || 0).toFixed(6) }, createdAt: new Date(),
      }).catch(() => {});
      res.json({ ok: true, keys: n, keyProgress: +((np.idleKeyProgress) || 0).toFixed(6), keysFromIdle: np.keysFromIdle || 0 });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ==================== 技能强化（此前服务端缺失，前端404修复） ====================
  app.post('/api/shanhai/upgrade', auth, async (req, res) => {
    try {
      const db = await getDb();
      const { key } = req.body || {};
      if (!['fireline', 'icepick', 'body'].includes(key)) return res.status(400).json({ ok: false, error: '未知技能' });
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const lv = (p.skillLv || {})[key] || 0;
      if (lv >= META_CFG.maxSkillLv) return res.status(400).json({ ok: false, error: '该技能已满级' });
      const cost = META_CFG.upgradeCost(lv);
      if ((p.xianyu || 0) < cost) return res.status(400).json({ ok: false, error: '仙玉不足' });
      const r = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: req.user.id, [`skillLv.${key}`]: lv, xianyu: { $gte: cost } },
        { $inc: { xianyu: -cost, [`skillLv.${key}`]: 1 }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      if (!r || (!r.value && !r)) return res.status(400).json({ ok: false, error: '仙玉不足' });
      const np = r.value || r;
      res.json({ ok: true, skillLv: np.skillLv, xianyu: np.xianyu });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ==================== 装备寻宝（抽卡，此前服务端缺失，前端404修复） ====================
  // 品质序：数值越小越差（用于满包替换）
  const QUALITY_ORDER = { white: 0, green: 1, blue: 2, purple: 3, gold: 4 };
  app.post('/api/shanhai/draw', auth, limit({ name: 'shanhai-draw', max: 30, windowMs: 60 * 1000, msg: '抽太快了，歇一下再抽～' }), async (req, res) => {
    try {
      const db = await getDb();
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      if ((p.xianyu || 0) < META_CFG.drawCost) return res.status(400).json({ ok: false, error: '仙玉不足' });
      const item = rollItem();
      // 【2026-09-17 修复】满包替换逻辑：原 $slice: -50 丢的是"最早抽到的"，
      // 早期抽到的金装会被静默销毁；现在改为替换品质最低的一件（同品质替换最早抽到的）
      // 【2026-09-17 二次复核修正】背包未满时改回原子 $push（并发双击不再互相覆盖丢装备）；
      // 仅满包替换时才走读-改-写路径（该路径并发下仍可能丢一件，概率极低且满包本身就是极端场景）
      const bagLen = (p.bag || []).length;
      let upd;
      let replaced = null;
      if (bagLen < META_CFG.bagMax) {
        upd = { $inc: { xianyu: -META_CFG.drawCost }, $push: { bag: item }, $set: { updatedAt: new Date() } };
      } else {
        const bag = [...(p.bag || [])];
        let wi = 0;
        for (let i = 1; i < bag.length; i++) {
          const a = QUALITY_ORDER[bag[i]?.quality] ?? 0, b = QUALITY_ORDER[bag[wi]?.quality] ?? 0;
          if (a <= b) wi = i;
        }
        replaced = bag[wi];
        bag.splice(wi, 1);
        bag.push(item);
        upd = { $inc: { xianyu: -META_CFG.drawCost }, $set: { bag, updatedAt: new Date() } };
      }
      const r = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: req.user.id, xianyu: { $gte: META_CFG.drawCost } },
        upd,
        { returnDocument: 'after' }
      );
      if (!r || (!r.value && !r)) return res.status(400).json({ ok: false, error: '仙玉不足' });
      const np = r.value || r;
      // 【二次复核补充】49/50 满包临界时并发 $push 可能超额，超限则裁掉最早抽到的（回到旧口径兜底）
      if (np.bag && np.bag.length > META_CFG.bagMax) {
        const trimmed = np.bag.slice(np.bag.length - META_CFG.bagMax);
        await db.collection('shanhai_profiles').updateOne(
          { userId: req.user.id }, { $set: { bag: trimmed } });
        np.bag = trimmed;
      }
      // 槽位空着 → 自动穿上（白嫖体验，玩家可在装备页换装）
      let autoEquipped = false;
      if (!np.equip || !np.equip[item.slot]) {
        const ae = await db.collection('shanhai_profiles').updateOne(
          { userId: req.user.id, [`equip.${item.slot}`]: null },
          { $set: { [`equip.${item.slot}`]: item, updatedAt: new Date() }, $pull: { bag: { id: item.id } } }
        );
        // 【2026-09-17 修复】只有真的穿上才报 autoEquipped（原来条件不满足也报 true）
        autoEquipped = ae.modifiedCount > 0;
      }
      res.json({ ok: true, item, xianyu: np.xianyu, autoEquipped, replaced });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ==================== 穿装备 / 脱装备 ====================
  app.post('/api/shanhai/equip', auth, async (req, res) => {
    try {
      const db = await getDb();
      const { itemId } = req.body || {};
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const item = (p.bag || []).find(i => i.id === itemId);
      if (!item) return res.status(400).json({ ok: false, error: '背包中没有该装备' });
      const cur = (p.equip || {})[item.slot];
      const r = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: req.user.id, 'bag.id': itemId },
        {
          $pull: { bag: { id: itemId } },
          $set: { [`equip.${item.slot}`]: item, updatedAt: new Date() },
          ...(cur ? { $push: { bag: cur } } : {}),
        },
        { returnDocument: 'after' }
      );
      // 【二次复核补充】并发同装备双穿时匹配落空会返回 null，直接取 .equip 会 500
      if (!r) return res.status(400).json({ ok: false, error: '该装备已被操作，请刷新' });
      res.json({ ok: true, equip: r.equip, bag: r.bag });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/shanhai/unequip', auth, async (req, res) => {
    try {
      const db = await getDb();
      const { slot } = req.body || {};
      if (!SLOTS.includes(slot)) return res.status(400).json({ ok: false, error: '未知槽位' });
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const item = (p.equip || {})[slot];
      if (!item) return res.status(400).json({ ok: false, error: '该槽位没有装备' });
      if ((p.bag || []).length >= META_CFG.bagMax) return res.status(400).json({ ok: false, error: '背包已满，先清理再卸下' });
      const r = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: req.user.id },
        { $set: { [`equip.${slot}`]: null, updatedAt: new Date() }, $push: { bag: item } },
        { returnDocument: 'after' }
      );
      if (!r) return res.status(400).json({ ok: false, error: '操作失败，请刷新' });
      res.json({ ok: true, equip: r.equip, bag: r.bag });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ==================== 排行榜（通关最快/击杀最多 各前20） ====================
  app.get('/api/shanhai/leaderboard', auth, async (req, res) => {
    try {
      const db = await getDb();
      const timeBoard = await db.collection('shanhai_profiles')
        .find({ bestTimeSec: { $ne: null } })
        .sort({ bestTimeSec: 1 }).limit(20)
        .project({ username: 1, bestTimeSec: 1, bestKills: 1, wins: 1 }).toArray();
      const killBoard = await db.collection('shanhai_profiles')
        .find({})
        .sort({ bestKills: -1 }).limit(20)
        .project({ username: 1, bestKills: 1, bestTimeSec: 1, wins: 1 }).toArray();
      res.json({ ok: true, timeBoard, killBoard });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ==================== 管理端：山海数据面板（游戏工作台用） ====================
  app.get('/api/shanhai/admin/stats', auth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      const db = await getDb();
      const [players, agg, top] = await Promise.all([
        db.collection('shanhai_profiles').countDocuments(),
        db.collection('shanhai_profiles').aggregate([
          { $group: { _id: null, plays: { $sum: '$plays' }, wins: { $sum: '$wins' }, totalKills: { $sum: '$totalKills' }, xianyu: { $sum: '$xianyu' }, lingqi: { $sum: '$lingqi' } } }
        ]).toArray(),
        db.collection('shanhai_profiles').find({ wins: { $gt: 0 } })
          .sort({ wins: -1, bestTimeSec: 1 }).limit(10)
          .project({ username: 1, wins: 1, plays: 1, bestKills: 1, bestTimeSec: 1, maxLevel: 1 }).toArray(),
      ]);
      res.json({
        ok: true,
        players,
        totals: agg[0] || { plays: 0, wins: 0, totalKills: 0, xianyu: 0, lingqi: 0 },
        top,
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ==================== 索引 ====================
  (async () => {
    try {
      const db = await getDb();
      db.collection('shanhai_profiles').createIndexes([
        { key: { bestTimeSec: 1 } },
        { key: { bestKills: -1 } },
      ]).catch(() => {});
    } catch (e) {}
  })();

  console.log('[shanhai_game] 山海斩妖录模块已挂载：/api/shanhai/*（含养成层）');
};
