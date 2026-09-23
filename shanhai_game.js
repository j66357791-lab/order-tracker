// shanhai_game.js — 山海斩妖录（割草 + 养成）游戏模块
// 挂载方式（server.js 末尾）：require('./shanhai_game')(app, { auth, getDb, cnDayStr });
// 设计原则（与 games.js 一致）：
//   1) 战绩合理性校验在服务端完成，客户端上报的数值不可信
//   2) 档案更新走 findOneAndUpdate + $inc/$max 原子操作，并发刷不掉
//   3) 独立集合 shanhai_profiles，不污染其他游戏数据
// 【2026-09-14】养成层（斩妖录·贰）：仙玉/灵气双货币 + 6槽装备 + 背包 + 抽卡 + 技能强化
// 【2026-09-17 安全修复】补战绩上限/关卡上限/接口限流，堵住脚本刷仙玉的口子
import { limit } from './lib/ratelimit.js';
import { ObjectId } from 'mongodb';
import { createHash } from 'crypto';

export default function mountShanhaiGame(app, { auth, getDb, adminOnly }) {

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
      stamina: STAMINA_CFG.init, // 【v24.9】体力（上限 10）
      staminaAt: new Date(),     // 【v24.9】体力上次结算时间（每 2 小时 +1）
      lingqiAt: new Date(),      // 【v26.4】灵气矿脉计时起点（第 5 关解锁，1/天起）
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
      res.json({ ok: true, profile: p, stamina: staminaCalc(p, Date.now()) });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // ==================== 体力：查询 / 挑战扣 1（v24.9） ====================
  app.get('/api/shanhai/stamina', auth, async (req, res) => {
    try {
      const db = await getDb();
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const s = staminaCalc(p, Date.now());
      // 顺手把恢复量落库（幂等：只写"应该有的值"）
      if (s.cur !== p.stamina) await db.collection('shanhai_profiles').updateOne({ userId: req.user.id }, { $set: staminaSet(s.cur, Date.now()) });
      res.json({ ok: true, stamina: s });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 挑战一局扣 1 点：前端点"出战"时调用，成功才进战斗（体力不足则前端引导等待恢复）
  app.post('/api/shanhai/stamina/consume', auth, limit({ name: 'shanhai-stamina', max: 20, windowMs: 60 * 1000, msg: '操作太频繁，稍等片刻' }), async (req, res) => {
    try {
      const db = await getDb();
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const now = Date.now();
      const s = staminaCalc(p, now);
      if (s.cur < STAMINA_CFG.cost) return res.status(400).json({ ok: false, error: '体力不足（每 2 小时恢复 1 点）', stamina: s, code: 'NO_STAMINA' });
      const left = s.cur - STAMINA_CFG.cost;
      // 注意：把"已恢复的量"和"本次消耗"一起落库，起点重置为现在
      await db.collection('shanhai_profiles').updateOne({ userId: req.user.id }, { $set: staminaSet(left, now) });
      const ns = staminaCalc({ stamina: left, staminaAt: new Date(now) }, now);
      res.json({ ok: true, stamina: ns });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ==================== 装备分解（v24.9） ====================
  // 只能分解背包里的装备（已穿戴的必须先卸下），收益 = 品质基础值（一阶 5/10/20/50/100 仙玉）
  app.post('/api/shanhai/dismantle', auth, limit({ name: 'shanhai-dismantle', max: 30, windowMs: 60 * 1000, msg: '分解太频繁，稍等片刻' }), async (req, res) => {
    try {
      const db = await getDb();
      const { itemId } = req.body || {};
      if (!itemId) return res.status(400).json({ ok: false, error: '缺少装备参数' });
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const eq = p.equip || {};
      if (Object.keys(eq).some(k => eq[k] && eq[k].id === itemId)) return res.status(400).json({ ok: false, error: '该装备正穿戴中，请先卸下再分解' });
      const it = (p.bag || []).find(b => b.id === itemId);
      if (!it) return res.status(404).json({ ok: false, error: '背包里没找到这件装备' });
      const gain = dismantlePrice(it);
      const out = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: req.user.id, 'bag.id': itemId },
        { $pull: { bag: { id: itemId } }, $inc: { xianyu: gain }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      const np = out && (out.value || out);
      if (!np) return res.status(409).json({ ok: false, error: '操作冲突，请刷新后重试' });
      await db.collection('shanhai_logs').insertOne({ userId: req.user.id, action: 'dismantle', detail: { itemId, name: it.name, quality: it.quality, tier: it.tier || 1, gain }, createdAt: new Date() }).catch(() => {});
      res.json({ ok: true, gain, balance: { xianyu: np.xianyu, lingqi: np.lingqi } });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ==================== 挂机收益配置（v24.7 按定稿口径） ====================
  // 产出：① 仙玉 0.1/分钟 + 0.05/分钟×已通关最高关  ② 钥匙 0.0001/分钟 + 0.0001/分钟×已通关最高关
  // 钥匙为小数进度累积，凑齐整把后在「道具合成」里兑换才进翻翻乐背包（避免小数道具流进翻翻乐）
  const IDLE_CFG = {
    unlockStage: 2,      // 【v24.8】解锁线下调到第 2 关（原来第 5 关）——第 1 关练手，第 2 关起即可挂机
    maxHours: 8,         // 累计上限 8 小时
    xianyuBase: 0.1,
    xianyuPerStage: 0.05,
    keyBase: 0.0001,
    keyPerStage: 0.0001,
  };

  // 【v24.8】符合挂机条件的档案（已通关 ≥ unlockStage 关）
  function eligibleIdleQuery(unlockStage = IDLE_CFG.unlockStage) {
    return { clearedStages: { $elemMatch: { $gte: unlockStage } } };
  }
  // 老玩家一次性激活：只给「还没有计时起点」的档案把起点设为现在（幂等，重复跑不会重复发奖，
  // 也不会给任何人补发历史时长——一切从激活这一刻开始计时）
  async function activateIdle(db, opt = {}) {
    const col = db.collection('shanhai_profiles');
    const stage = opt.unlockStage || IDLE_CFG.unlockStage;
    const eligible = await col.find(eligibleIdleQuery(stage), { projection: { userId: 1, username: 1, clearedStages: 1, idleAt: 1 } }).toArray();
    const pending = eligible.filter(p => !p.idleAt);
    if (pending.length) {
      await col.updateMany(
        { _id: { $in: pending.map(p => p._id) }, $or: [{ idleAt: null }, { idleAt: { $exists: false } }] },
        { $set: { idleAt: new Date(), idleActivatedAt: new Date(), updatedAt: new Date() } }
      );
    }
    return {
      unlockStage: stage,
      eligible: eligible.length,
      activated: pending.length,
      already: eligible.length - pending.length,
      list: eligible.map(p => ({
        userId: String(p.userId || ''),
        username: p.username || '',
        top: Array.isArray(p.clearedStages) && p.clearedStages.length ? Math.max(...p.clearedStages) : 0,
        active: !!p.idleAt,
      })).sort((a, b) => b.top - a.top),
    };
  }
  mountShanhaiGame.activateIdle = activateIdle;   // 供 server.js 启动时调用

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

  // ==================== 【v26.4】灵气矿脉（每日产出） ====================
  // 规则（按用户定稿）：通关第 5 关解锁，基础 1 点/天；
  //   此后每再多通关 10 关，日产 +2 点（第 5 关 1/天 → 第 15 关 3/天 → 第 25 关 5/天 …）
  // 最多累计 30 天不领——避免长期不上线的玩家一次冒出几百点砸盘。
  // 与挂机收益同一个思路：服务端计时、玩家打开时结算、领取后重置起点。
  const LINGQI_MINE = { unlockStage: 5, base: 1, per10: 2, maxDays: 30 };
  function lingqiRate(top) {
    if (top < LINGQI_MINE.unlockStage) return 0;
    return LINGQI_MINE.base + Math.floor((top - LINGQI_MINE.unlockStage) / 10) * LINGQI_MINE.per10;
  }
  function lingqiCalc(p, nowMs) {
    const top = clearedTop(p);
    const rate = lingqiRate(top);
    const unlocked = rate > 0;
    const last = p && p.lingqiAt ? new Date(p.lingqiAt).getTime() : nowMs;
    const rawSec = Math.max(0, Math.floor((nowMs - last) / 1000));
    const capped = Math.min(rawSec, LINGQI_MINE.maxDays * 86400);
    // 按整天结算：满 24 小时才产 rate 点，不足一天的部分留着继续攒
    const days = Math.floor(capped / 86400);
    const gain = unlocked ? days * rate : 0;
    const nextInSec = unlocked ? Math.max(0, 86400 - (capped % 86400)) : 0;
    return {
      unlocked, top, rate, gain, days,
      maxDays: LINGQI_MINE.maxDays,
      unlockStage: LINGQI_MINE.unlockStage,
      elapsedSec: capped, capped: rawSec > capped,
      nextInSec,
      nextRate: lingqiRate(top + 10),          // 再多通关 10 关后的日产（给玩家一个目标）
      nextRingAt: top < LINGQI_MINE.unlockStage ? LINGQI_MINE.unlockStage : (Math.floor((top - LINGQI_MINE.unlockStage) / 10) + 1) * 10 + LINGQI_MINE.unlockStage,
    };
  }

  app.get('/api/shanhai/lingqi', auth, async (req, res) => {
    try {
      const db = await getDb();
      let p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      if (!p.lingqiAt) {
        await db.collection('shanhai_profiles').updateOne({ userId: req.user.id }, { $set: { lingqiAt: new Date() } });
        p = await db.collection('shanhai_profiles').findOne({ userId: req.user.id });
      }
      res.json(Object.assign({ ok: true }, lingqiCalc(p, Date.now())));
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/shanhai/lingqi/claim', auth, limit({ name: 'sh-lingqi', max: 15, windowMs: 60 * 1000, msg: '领取太频繁，稍等片刻' }), async (req, res) => {
    try {
      const db = await getDb();
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const r = lingqiCalc(p, Date.now());
      if (!r.unlocked) return res.status(400).json({ ok: false, error: `通关第 ${LINGQI_MINE.unlockStage} 关后解锁灵气矿脉` });
      if (r.gain < 1) return res.status(400).json({ ok: false, error: `还没攒够 1 点（当前 ${r.days} 天 / 日产量 ${r.rate} 点），再等等` });
      // 起点推进「已领取的天数」而不是直接设为现在，避免把不足一天的零头抹掉
      const elapsedMs = Date.now() - new Date(p.lingqiAt || Date.now()).getTime();
      const newStart = new Date(new Date(p.lingqiAt || Date.now()).getTime() + r.days * 86400000);
      await db.collection('shanhai_profiles').updateOne(
        { userId: req.user.id },
        { $inc: { lingqi: r.gain }, $set: { lingqiAt: newStart, updatedAt: new Date() } }
      );
      await db.collection('shanhai_logs').insertOne({ userId: req.user.id, action: 'lingqi_mine', detail: { gain: r.gain, days: r.days, rate: r.rate }, createdAt: new Date() }).catch(() => { });
      const np = await db.collection('shanhai_profiles').findOne({ userId: req.user.id });
      res.json({ ok: true, gain: r.gain, days: r.days, rate: r.rate, lingqi: np ? (np.lingqi || 0) : 0, elapsedMs });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ==================== 体力（v24.9） ====================
  // 上限 10 点，挑战一局消耗 1 点，每 2 小时恢复 1 点（服务端计时，客户端改不了）
  const STAMINA_CFG = { cap: 10, cost: 1, recoverSec: 7200, init: 10 };
  function staminaCalc(p, nowMs) {
    const last = p && p.staminaAt ? new Date(p.staminaAt).getTime() : nowMs;
    const cur0 = (p && typeof p.stamina === 'number') ? p.stamina : STAMINA_CFG.init;
    const elapsed = Math.max(0, Math.floor((nowMs - last) / 1000));
    const regen = Math.floor(elapsed / STAMINA_CFG.recoverSec);
    const cur = Math.min(STAMINA_CFG.cap, cur0 + regen);
    // 下一恢复时间：满体力则不倒计时；否则 = 距上次结算的余数时间
    const usedSec = regen * STAMINA_CFG.recoverSec;
    const nextInSec = cur >= STAMINA_CFG.cap ? 0 : Math.max(0, STAMINA_CFG.recoverSec - (elapsed - usedSec));
    return { cur, cap: STAMINA_CFG.cap, cost: STAMINA_CFG.cost, nextInSec, atCap: cur >= STAMINA_CFG.cap };
  }
  const staminaSet = (cur, nowMs, extra = {}) => Object.assign({ stamina: cur, staminaAt: new Date(nowMs), updatedAt: new Date() }, extra);

  // ==================== 装备分解（v24.9） ====================
  // 一阶装备基础分解价：凡 5 / 良 10 / 上 20 / 仙 50 / 神 100 仙玉
  // 高阶预留倍率（tier 每 +1 增加 50%），当前产出一阶，即基础值
  const DISMANTLE_BASE = { white: 5, green: 10, blue: 20, purple: 50, gold: 100 };
  function dismantlePrice(it) {
    const base = DISMANTLE_BASE[it && it.quality] || 5;
    const tier = Math.max(1, Math.min(9, (it && it.tier) | 0 || 1));
    return Math.round(base * (1 + 0.5 * (tier - 1)));
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

  // ==================== 灵气交易所（v26.0） ====================
  // 玩家之间用「账户余额（元）」买卖「灵气」的挂单市场。五条硬规则：
  //   1) 卖单必须冻结灵气（lingqiFrozen）——不冻结就会把同一批灵气同时挂给十个人，必然超卖
  //   2) 买单成交时才实时扣余额——不预冻结，用户的钱不会被无意义地锁住（吃单前 UI 会先算够不够）
  //   3) 每人每侧最多 MAX_OPEN 条未成交单
  //   4) 成交先抢余量再动资金，资金流全部写 wallet_log（余额 = sum(wallet_log.amount)，与充值/激励同一口径）
  //   5) 任何一步失败都要把抢到的余量退回去
  const EX_CFG = {
    maxOpenPerSide: 10,     // 单用户一侧最多 10 条
    minAmount: 1,
    maxAmount: 999999,
    minPrice: 0.0001,       // 【v26.4.1】价格支持到 0.0001（交易所内部定价，与主站人民币无关）
    maxPrice: 9999,
    feeRate: 0.005,         // 【v26.1】手续费 0.5%：买家付全额，卖家实收 total×(1-0.5%)
  };
  const PLATFORM_ID = '__platform__';   // 手续费归集账户（不参与任何玩家余额，只用于统计平台收入）
  const BOT_ID = '__market__';          // 【v26.2】做市机器人账户：手续费照收，台账里用 bot 标记区分
  const money2 = n => Math.round(Number(n) * 100) / 100;      // 主站余额口径：2 位小数（元）
  const money4 = n => Math.round(Number(n) * 10000) / 10000;  // 【v26.4.1】交易所内部口径：4 位小数，支持 0.0001 级定价
  const EX_PROJ = { _id: 1, userId: 1, username: 1, side: 1, amount: 1, left: 1, price: 1, status: 1, createdAt: 1 };

  // ==================== 【v26.4】交易所独立钱包 ====================
  // 为什么要把交易所的钱和主站钱包分开：
  //   ① 玩家在交易所挂单 → 冻结的是「他愿意投进去的钱」，不该把主站可提现余额一起冻住
  //   ② 主站余额承载充值/激励/提现，口径必须干净；交易所再怎么折腾都不影响它
  //   ③ 交易所内部允许 0.001 精度定价，主站余额仍是 2 位小数，两套口径互不污染
  // 资金流：主站 --转入--> 交易所钱包（balance）--挂买单--> 冻结（frozen）--成交--> 花掉
  //         卖出所得进交易所钱包，想拿回主站要显式「转出」
  const EXW_COL = 'shanhai_ex_wallet';
  const EX_MIN_TRANSFER = 0.01;   // 转入/转出最低 0.01 元

  // ==================== 【v26.4.1】交易所总闸 ====================
  // 后台一键停用：所有交易所接口返回"维护中"。真出事时能立刻止血，不用等重新部署。
  // ⚠️ 这两个必须定义在**所有使用点之前**：它们是 const/箭头函数，在模块加载阶段就被引用，
  //    放到后面会命中 TDZ（Cannot access before initialization），
  //    而抛错发生在路由注册过程中 —— 结果是"前半截路由注册成功、后半截全部 404"。
  async function exEnabled(db) {
    try {
      const c = await db.collection('shanhai_config').findOne({ _id: 'exchange' });
      return !c || c.enabled !== false;   // 配置不存在视为开启
    } catch (e) { return true; }
  }
  const exGuard = async (req, res, next) => {
    try {
      const db = await getDb();
      if (!(await exEnabled(db))) {
        return res.status(503).json({ ok: false, error: '交易所正在维护，请稍后再来', code: 'EX_CLOSED' });
      }
      next();
    } catch (e) { next(); }
  };

  async function exWalletOf(db, userId) {
    let w = await db.collection(EXW_COL).findOne({ userId });
    if (!w) {
      await db.collection(EXW_COL).updateOne({ userId },
        { $setOnInsert: { userId, balance: 0, frozen: 0, createdAt: new Date() } }, { upsert: true });
      w = await db.collection(EXW_COL).findOne({ userId });
    }
    return w || { userId, balance: 0, frozen: 0 };
  }
  // 交易所可用余额（扣除挂单冻结）
  async function exAvailable(db, userId) {
    const w = await db.collection(EXW_COL).findOne({ userId });
    return money4(((w || {}).balance || 0) - ((w || {}).frozen || 0));
  }
  // 【v26.2】交易所匿名制：玩家之间只看得到匿名代号，真实用户名只留在库里给后台查。
  // 代号由 userId 哈希固定生成——同一个人每次都是同一个代号，便于"认得出是同一家"但认不出是谁。
  const _anonCache = new Map();
  function anonName(userId) {
    const s = String(userId || '');
    if (s === BOT_ID) return '做市灵傀';
    if (!_anonCache.has(s)) {
      if (_anonCache.size > 5000) _anonCache.clear();
      _anonCache.set(s, '道友·' + createHash('sha1').update('sh:' + s).digest('hex').slice(0, 4).toUpperCase());
    }
    return _anonCache.get(s);
  }

  async function walletBalanceOf(db, userId) {
    const rows = await db.collection('wallet_log').find({ userId }, { projection: { amount: 1 } }).toArray();
    return money2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0));
  }
  // 每侧未成交单数
  async function openSides(db, userId) {
    const a = await db.collection('shanhai_exchange').aggregate([
      { $match: { userId, status: 'open' } },
      { $group: { _id: '$side', n: { $sum: 1 } } },
    ]).toArray();
    const o = { sell: 0, buy: 0 };
    a.forEach(x => { o[x._id] = x.n; });
    return o;
  }
  // 资金流水（正=进账，负=支出）
  async function walletLog(db, userId, amount, kind, note, orderId) {
    await db.collection('wallet_log').insertOne({
      userId, amount: money2(amount), kind, note: note || '', orderId: orderId || null, createdAt: new Date(),
    });
  }

  // ---------- 行情看板 ----------
  app.get('/api/shanhai/exchange/board', auth, exGuard, async (req, res) => {
    try {
      const db = await getDb();
      const me = req.user.id;
      const p = await ensureProfile(db, me, req.user.displayName || req.user.username);
      const col = db.collection('shanhai_exchange');
      // 注意：解构必须与下面的查询一一对应——v26.3 曾漏写 frozenAgg，
      // 导致 board 直接 ReferenceError 500（表现就是"一进交易所就报服务器开小差"）
      const [sells, buys, mine, balance, exw, myDeals] = await Promise.all([
        // 卖单按单价升序（最便宜的先给买家看）
        // 【v26.2】不再排除自己——自己的挂单也要出现在列表里（前端加「我」标记区分）
        col.find({ side: 'sell', status: 'open', left: { $gt: 0 } })
          .sort({ price: 1, createdAt: 1 }).limit(50).project(EX_PROJ).toArray(),
        // 买单按单价降序（出价最高的先给卖家看）
        col.find({ side: 'buy', status: 'open', left: { $gt: 0 } })
          .sort({ price: -1, createdAt: 1 }).limit(50).project(EX_PROJ).toArray(),
        col.find({ userId: me, status: 'open' }).sort({ createdAt: -1 }).limit(40).project(EX_PROJ).toArray(),
        walletBalanceOf(db, me),                    // 主站余额（只用于「转入」时判断够不够）
        exWalletOf(db, me),                         // 【v26.4】交易所独立钱包
        // 【v26.4】我的成交记录（交易记录页签）——【v26.5.1】只取最近 10 条
        db.collection('shanhai_ex_deals').find({ $or: [{ buyerId: me }, { sellerId: me }] })
          .sort({ createdAt: -1 }).limit(10).toArray(),
      ]);
      // 【v26.4】列表不再暴露任何身份信息——不显示「做市灵傀」，也不显示「玩家/道友xxx」，
      // 交易所只呈现「有这么一个买卖需求」。userId/username 一律不返回给前端。
      const mask = arr => arr.map(o => Object.assign({}, {
        id: String(o._id), side: o.side, amount: o.amount, left: o.left,
        price: o.price, status: o.status, createdAt: o.createdAt,
        mine: o.userId === me,
      }));
      const myDealList = myDeals.map(d => Object.assign({}, {
        at: d.createdAt, side: d.side, amount: d.amount, price: d.price, total: d.total, fee: d.fee,
        role: d.buyerId === me ? 'buy' : 'sell',             // 我在这一笔里是买方还是卖方
        lingqi: d.side === 'sell' ? d.amount : d.amount,     // 成交灵气数
      }));
      res.json({
        ok: true,
        cfg: {
          maxOpenPerSide: EX_CFG.maxOpenPerSide, minPrice: EX_CFG.minPrice, maxPrice: EX_CFG.maxPrice,
          minAmount: EX_CFG.minAmount, maxAmount: EX_CFG.maxAmount, feeRate: EX_CFG.feeRate,
          minTransfer: EX_MIN_TRANSFER, priceStep: 0.0001,
        },
        me: {
          id: me,
          lingqi: p.lingqi || 0, frozen: p.lingqiFrozen || 0,
          balance,                                                   // 主站余额
          exBalance: money4(exw.balance || 0),                       // 交易所余额
          exFrozen: money4(exw.frozen || 0),                         // 交易所冻结（挂买单）
          exAvailable: money4((exw.balance || 0) - (exw.frozen || 0)),
        },
        sells: mask(sells), buys: mask(buys), mine: mask(mine),
        deals: myDealList,
        lingqiMine: lingqiCalc(p, Date.now()),   // 【v26.4】灵气矿脉待领
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ==================== 【v26.4.1】交易所总闸 · 管理接口 ====================
  // （exEnabled / exGuard 的定义在文件前部——它们必须早于所有使用点，否则命中 TDZ）
  app.get('/api/shanhai/admin/exchange/switch', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      res.json({ ok: true, enabled: await exEnabled(db) });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/shanhai/admin/exchange/switch', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const enabled = !!(req.body || {}).enabled;
      await db.collection('shanhai_config').updateOne(
        { _id: 'exchange' },
        { $set: { enabled, updatedAt: new Date(), by: req.user.id } },
        { upsert: true });
      await db.collection('shanhai_logs').insertOne({
        action: 'exchange_switch', detail: { enabled, by: req.user.id }, createdAt: new Date(),
      }).catch(() => { });
      res.json({ ok: true, enabled });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ==================== 【v26.4】主站余额 ⇄ 交易所钱包 ====================
  // 转入：主站余额 -X（主站记一条 ex_deposit 流水），交易所余额 +X
  // 转出：交易所可用余额 -X（冻结中的转不走），主站余额 +X
  // 两侧各记各的账，主站余额永远只反映充值/激励/提现/转入转出，不受交易波动影响。
  app.post('/api/shanhai/exchange/deposit', auth, exGuard, limit({ name: 'ex-deposit', max: 20, windowMs: 60 * 1000, msg: '操作太频繁，稍等片刻' }), async (req, res) => {
    try {
      const db = await getDb();
      const me = req.user.id;
      const amt = money2((req.body || {}).amount);
      if (!(amt >= EX_MIN_TRANSFER)) return res.status(400).json({ ok: false, error: `最低转入 ¥${EX_MIN_TRANSFER}` });
      const bal = await walletBalanceOf(db, me);
      if (bal < amt) return res.status(400).json({ ok: false, error: `主站余额不足（可用 ¥${bal.toFixed(2)}）`, code: 'NO_BALANCE' });
      await walletLog(db, me, -amt, 'ex_deposit', `转入交易所 ¥${amt.toFixed(2)}`);
      await db.collection(EXW_COL).updateOne(
        { userId: me }, { $inc: { balance: amt }, $set: { updatedAt: new Date() } }, { upsert: true });
      await db.collection('shanhai_logs').insertOne({ userId: me, action: 'ex_deposit', detail: { amount: amt }, createdAt: new Date() }).catch(() => { });
      const w = await exWalletOf(db, me);
      res.json({ ok: true, amount: amt, exBalance: money4(w.balance || 0), exFrozen: money4(w.frozen || 0), balance: await walletBalanceOf(db, me) });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/shanhai/exchange/withdraw', auth, exGuard, limit({ name: 'ex-withdraw', max: 20, windowMs: 60 * 1000, msg: '操作太频繁，稍等片刻' }), async (req, res) => {
    try {
      const db = await getDb();
      const me = req.user.id;
      const body = req.body || {};
      // 【v26.4.1】「全部转出」：交易所余额是 4 位小数，主站只认分（2 位），
      // 所以按分向下取整 —— 不足 0.01 的零头留在交易所继续使用，不会凭空消失。
      const amt = body.all
        ? Math.floor((await exAvailable(db, me)) * 100) / 100
        : money2(body.amount);
      if (body.all && !(amt >= EX_MIN_TRANSFER))
        return res.status(400).json({ ok: false, error: `可转出金额不足 ¥${EX_MIN_TRANSFER}（零头留在交易所，攒够 0.01 再转）` });
      if (!(amt >= EX_MIN_TRANSFER)) return res.status(400).json({ ok: false, error: `最低转出 ¥${EX_MIN_TRANSFER}` });
      const avail = await exAvailable(db, me);
      if (avail < amt) return res.status(400).json({ ok: false, error: `交易所可用余额不足（可用 ¥${avail.toFixed(3)}，挂单冻结中的部分不能转出）`, code: 'NO_EX_BALANCE' });
      // 条件更新保证「冻结中的钱转不走」（可用 = balance - frozen >= amt）
      const r = await db.collection(EXW_COL).findOneAndUpdate(
        { userId: me, $expr: { $gte: [{ $subtract: [{ $ifNull: ['$balance', 0] }, { $ifNull: ['$frozen', 0] }] }, amt] } },
        { $inc: { balance: -amt }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      const nw = r && (r.value || r);
      if (!nw) return res.status(409).json({ ok: false, error: '可用余额不足或操作冲突，请刷新后重试' });
      await walletLog(db, me, amt, 'ex_withdraw', `从交易所转出 ¥${amt.toFixed(2)}`);
      await db.collection('shanhai_logs').insertOne({ userId: me, action: 'ex_withdraw', detail: { amount: amt }, createdAt: new Date() }).catch(() => { });
      res.json({ ok: true, amount: amt, exBalance: money4(nw.balance || 0), exFrozen: money4(nw.frozen || 0), balance: await walletBalanceOf(db, me) });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ---------- 发布挂单 ----------
  app.post('/api/shanhai/exchange/publish', auth, exGuard, limit({ name: 'ex-publish', max: 20, windowMs: 60 * 1000, msg: '挂单太频繁，歇一下' }), async (req, res) => {
    try {
      const db = await getDb();
      const { side, amount, price } = req.body || {};
      if (!['sell', 'buy'].includes(side)) return res.status(400).json({ ok: false, error: '挂单方向不对' });
      const n = Math.floor(Number(amount));
      const pr = money4(price);   // 【v26.4】3 位小数，支持 0.001 级定价
      if (!Number.isFinite(n) || n < EX_CFG.minAmount || n > EX_CFG.maxAmount)
        return res.status(400).json({ ok: false, error: `数量需为 ${EX_CFG.minAmount} ~ ${EX_CFG.maxAmount} 之间的整数` });
      if (!(pr >= EX_CFG.minPrice && pr <= EX_CFG.maxPrice))
        return res.status(400).json({ ok: false, error: `单价需在 ¥${EX_CFG.minPrice} ~ ¥${EX_CFG.maxPrice} 之间（可精确到 0.0001）` });
      const me = req.user.id;
      const open = await openSides(db, me);
      if ((open[side] || 0) >= EX_CFG.maxOpenPerSide)
        return res.status(400).json({ ok: false, error: `${side === 'sell' ? '出售' : '求购'}单最多同时挂 ${EX_CFG.maxOpenPerSide} 条，先撤销几张旧的` });
      const p = await ensureProfile(db, me, req.user.displayName || req.user.username);
      const orderTotal = money4(n * pr);
      // 卖单：冻结灵气（原子条件更新，不足就不会冻结）
      if (side === 'sell') {
        if ((p.lingqi || 0) < n) return res.status(400).json({ ok: false, error: `灵气不足（可用 ${p.lingqi || 0}，本次需冻结 ${n}）` });
        const fz = await db.collection('shanhai_profiles').findOneAndUpdate(
          { userId: me, lingqi: { $gte: n } },
          { $inc: { lingqi: -n, lingqiFrozen: n }, $set: { updatedAt: new Date() } },
          { returnDocument: 'after' }
        );
        if (!fz || !(fz.value || fz)) return res.status(409).json({ ok: false, error: '灵气不足或操作冲突，请刷新重试' });
      } else {
        // 【v26.4】求购单冻结的是「交易所钱包」里的钱（不是主站余额）：
        // 主站余额负责充值/提现，交易所折腾不到它；玩家要先转入才挂得了单。
        const avail = await exAvailable(db, me);
        if (avail < orderTotal)
          return res.status(400).json({ ok: false, error: `交易所余额不足（需冻结 ¥${orderTotal.toFixed(3)}，可用 ¥${avail.toFixed(3)}），请先把主站余额转入交易所`, code: 'NO_EX_BALANCE' });
      }
      const doc = {
        userId: me, username: req.user.displayName || req.user.username || '佚名',
        side, amount: n, left: n, price: pr, status: 'open',
        locked: side === 'buy' ? orderTotal : 0,   // 买单已冻结的金额
        // 【v26.4】标记「冻结在交易所钱包里」。老单没这个字段，说明钱当初是从主站扣的——
        // 撤销/成交时必须退回主站而不是交易所，否则玩家的钱会凭空消失。
        exLocked: side === 'buy' ? true : undefined,
        createdAt: new Date(), updatedAt: new Date(),
      };
      await db.collection('shanhai_exchange').insertOne(doc);
      // 买单：订单落库后冻结交易所钱包（冻结失败就把订单撤掉，不留无冻结的空单）
      if (side === 'buy' && orderTotal > 0) {
        try {
          await db.collection(EXW_COL).updateOne(
            { userId: me },
            { $inc: { frozen: orderTotal }, $set: { updatedAt: new Date() } },
            { upsert: true }
          );
        } catch (e) {
          await db.collection('shanhai_exchange').deleteOne({ _id: doc._id }).catch(() => { });
          throw e;
        }
      }
      await db.collection('shanhai_logs').insertOne({ userId: me, action: 'exchange_publish', detail: { side, amount: n, price: pr }, createdAt: new Date() }).catch(() => {});
      // 【v26.5.1】同样返回最新数值，前端挂单成功后立刻更新（冻结额 / 灵气都会变）
      const np2 = await db.collection('shanhai_profiles').findOne({ userId: me });
      const nw2 = await exWalletOf(db, me);
      res.json({
        ok: true, order: { id: String(doc._id), side, amount: n, left: n, price: pr },
        lingqi: np2 ? (np2.lingqi || 0) : 0,
        frozen: np2 ? (np2.lingqiFrozen || 0) : 0,
        exBalance: money4(nw2.balance || 0),
        exFrozen: money4(nw2.frozen || 0),
        exAvailable: money4((nw2.balance || 0) - (nw2.frozen || 0)),
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ---------- 成交（吃单） ----------
  app.post('/api/shanhai/exchange/deal', auth, exGuard, limit({ name: 'ex-deal', max: 30, windowMs: 60 * 1000, msg: '交易太频繁，歇一下' }), async (req, res) => {
    try {
      const db = await getDb();
      const me = req.user.id;
      const { orderId, amount } = req.body || {};
      let oid;
      try { oid = new ObjectId(String(orderId)); } catch (e) { return res.status(400).json({ ok: false, error: '挂单不存在' }); }
      const n = Math.floor(Number(amount));
      if (!Number.isFinite(n) || n < 1) return res.status(400).json({ ok: false, error: '成交数量至少 1' });
      const col = db.collection('shanhai_exchange');
      const ord = await col.findOne({ _id: oid, status: 'open' });
      if (!ord) return res.status(404).json({ ok: false, error: '该挂单已成交或已撤销' });
      if (ord.userId === me) return res.status(400).json({ ok: false, error: '不能和自己交易' });
      if (n > ord.left) return res.status(400).json({ ok: false, error: `挂单剩余 ${ord.left}，无法成交 ${n}` });
      const total = money4(n * ord.price);   // 【v26.4】3 位小数口径
      if (total <= 0) return res.status(400).json({ ok: false, error: '金额异常' });

      const prof = db.collection('shanhai_profiles');
      // 【卖家视角】ord.side==='sell' 时：对方卖我买（我付钱收灵气）；否则对方买我卖（我出灵气收钱）
      const iAmBuyer = ord.side === 'sell';
      const p0 = await ensureProfile(db, me, req.user.displayName || req.user.username);
      // 【v26.3.1 兼容】v26.3 之前挂出的求购单没有 locked 字段（当时不冻结余额），
      // 这种「老单」成交时必须走实时扣款，否则买家白拿灵气不付钱。
      const legacyBuyOrder = !iAmBuyer && !(ord.locked > 0);
      const payerNeedsCash = iAmBuyer || legacyBuyOrder;
      // —— 成交前置校验（放在抢余量之前，失败不产生副作用）——
      if (payerNeedsCash) {
        // 【v26.4】付款方看的是「交易所钱包」可用余额，不是主站余额
        const payerId = iAmBuyer ? me : ord.userId;
        const avail = await exAvailable(db, payerId);
        if (avail < total) return res.status(400).json({ ok: false, error: `交易所余额不足（需 ¥${total.toFixed(3)}，可用 ¥${avail.toFixed(3)}）`, code: 'NO_EX_BALANCE' });
      } else {
        if ((p0.lingqi || 0) < n) return res.status(400).json({ ok: false, error: `灵气不足（需 ${n}，可用 ${p0.lingqi || 0}）` });
      }

      // —— 抢余量：条件更新保证并发不会超卖 ——
      const taken = await col.findOneAndUpdate(
        { _id: oid, status: 'open', left: { $gte: n } },
        { $inc: { left: -n }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      const after = taken && (taken.value || taken);
      if (!after) return res.status(409).json({ ok: false, error: '刚被人抢走了，刷新看看' });

      // 手续费：买家付 total，卖家实收 total×(1-feeRate)，差额进平台账户
      const fee = money4(total * EX_CFG.feeRate);
      const sellerGet = money4(total - fee);
      const rollback = async () => { await col.updateOne({ _id: oid }, { $inc: { left: n }, $set: { updatedAt: new Date() } }).catch(() => {}); };
      try {
        const sellerId = iAmBuyer ? ord.userId : me;      // 出灵气的一方
        const buyerId = iAmBuyer ? me : ord.userId;       // 出钱的一方
        // 1) 灵气流转：卖家 -n（或解冻 -n），买家 +n
        if (iAmBuyer) {
          await prof.updateOne({ userId: sellerId }, { $inc: { lingqiFrozen: -n }, $set: { updatedAt: new Date() } });
        } else {
          await prof.updateOne({ userId: sellerId, lingqi: { $gte: n } }, { $inc: { lingqi: -n }, $set: { updatedAt: new Date() } });
        }
        await prof.updateOne({ userId: buyerId }, { $inc: { lingqi: n }, $set: { updatedAt: new Date() } });
        // 2) 资金流转：买家付全额，平台抽 0.5%，卖家收剩下的
        //    手续费记到 PLATFORM_ID 名下——它不参与任何玩家余额计算（余额 = sum(自己 userId 的流水)）
        if (payerNeedsCash) {
          // 主动买家 / 从未冻结过的老买单：从交易所余额实时扣
          await db.collection(EXW_COL).updateOne(
            { userId: buyerId }, { $inc: { balance: -total }, $set: { updatedAt: new Date() } }, { upsert: true });
        } else if (ord.exLocked) {
          // 新买单（v26.4 起）：钱冻在交易所钱包里 → 同一笔里「解冻」+「扣掉」
          await db.collection(EXW_COL).updateOne(
            { userId: buyerId },
            { $inc: { frozen: -total, balance: -total }, $set: { updatedAt: new Date() } }, { upsert: true });
          await col.updateOne({ _id: oid }, { $inc: { locked: -total } });
        } else {
          // 【v26.4 兼容】v26.4 之前挂的买单：钱当时就从「主站余额」扣走了（在 wallet_log 里），
          // 交易所钱包里根本没有这笔钱。这里只冲减订单冻结额，绝不能再动任何钱包。
          await col.updateOne({ _id: oid }, { $inc: { locked: -total } });
        }
        // 卖家：货款（已扣手续费）进他的交易所余额
        await db.collection(EXW_COL).updateOne(
          { userId: sellerId }, { $inc: { balance: sellerGet }, $set: { updatedAt: new Date() } }, { upsert: true });
        // 【v26.4】手续费只在台账里记一笔（shanghai_ex_deals.fee），不再往主站 wallet_log 塞流水，
        // 这样主站余额永远只反映充值/激励/提现/转入转出，口径干净
      } catch (e) {
        await rollback();
        console.error('[exchange deal]', e);
        return res.status(500).json({ ok: false, error: '交易未完成，挂单已还原，请重试' });
      }
      // 3) 余量清零则结单；求购单把可能剩下的零头退回，不让几分钱永远冻着
      if (after.left <= 0) {
        const fresh = await col.findOne({ _id: oid });
        const residual = ord.side === 'buy' ? money2((fresh || {}).locked || 0) : 0;
        await col.updateOne({ _id: oid }, { $set: { status: 'done', locked: 0, updatedAt: new Date() } });
        if (residual > 0) {
          if (ord.exLocked) {
            await db.collection(EXW_COL).updateOne(
              { userId: ord.userId }, { $inc: { frozen: -residual }, $set: { updatedAt: new Date() } });
          } else {
            // 老单的零头原本从主站扣，退回主站
            await walletLog(db, ord.userId, residual, 'exchange_unlock', `求购单结清退回 ¥${residual.toFixed(2)}`, String(oid));
          }
        }
      }
      await db.collection('shanhai_logs').insertOne({
        userId: me, action: 'exchange_deal',
        detail: { orderId: String(oid), side: ord.side, amount: n, price: ord.price, total, with: ord.username },
        createdAt: new Date(),
      }).catch(() => {});
      // 【v26.2】统一台账：玩家成交与机器人成交都写 shanhai_ex_deals（后台一个面板查全，
      // bot 字段一眼分清是人还是机器人）。名字这里存匿名代号，真实身份后台按 userId 关联查。
      await db.collection('shanhai_ex_deals').insertOne({
        orderId: String(oid), side: ord.side, amount: n, price: ord.price, total, fee,
        buyerId, sellerId, bot: false, mode: 'player',
        buyerName: anonName(buyerId), sellerName: anonName(sellerId),
        createdAt: new Date(),
      }).catch(() => {});
      // 【v26.5.1】把成交后的**全部**最新数值一并返回：
      // 前端拿到就能立刻把界面改对，不必等下一次轮询 —— 之前要等 6 秒才刷，
      // 用户会以为"没反应/交易没成功"，甚至关掉页面后才发现钱变了。
      const np = await prof.findOne({ userId: me });
      const nw = await exWalletOf(db, me);
      res.json({
        ok: true, amount: n, total, fee, side: ord.side, price: ord.price,
        got: iAmBuyer ? total : sellerGet,          // 买入=实付金额；卖出=实收金额（已扣手续费）
        role: iAmBuyer ? 'buy' : 'sell',
        lingqi: np ? (np.lingqi || 0) : 0,
        frozen: np ? (np.lingqiFrozen || 0) : 0,
        balance: await walletBalanceOf(db, me),
        exBalance: money4(nw.balance || 0),
        exFrozen: money4(nw.frozen || 0),
        exAvailable: money4((nw.balance || 0) - (nw.frozen || 0)),
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ---------- 撤单 ----------
  app.post('/api/shanhai/exchange/cancel', auth, exGuard, limit({ name: 'ex-cancel', max: 30, windowMs: 60 * 1000, msg: '操作太频繁，歇一下' }), async (req, res) => {
    try {
      const db = await getDb();
      const me = req.user.id;
      let oid;
      try { oid = new ObjectId(String((req.body || {}).orderId)); } catch (e) { return res.status(400).json({ ok: false, error: '挂单不存在' }); }
      const col = db.collection('shanhai_exchange');
      const o = await col.findOne({ _id: oid, userId: me, status: 'open' });
      if (!o) return res.status(404).json({ ok: false, error: '挂单不存在或已结束' });
      // 卖单把未成交部分的冻结灵气退回
      if (o.side === 'sell' && o.left > 0) {
        await db.collection('shanhai_profiles').updateOne(
          { userId: me },
          { $inc: { lingqi: o.left, lingqiFrozen: -o.left }, $set: { updatedAt: new Date() } });
      } else if (o.side === 'buy' && (o.locked || 0) > 0) {
        if (o.exLocked) {
          // 新单：解冻交易所钱包里被冻住的那部分（钱仍留在交易所，不回主站）
          await db.collection(EXW_COL).updateOne(
            { userId: me }, { $inc: { frozen: -o.locked }, $set: { updatedAt: new Date() } });
        } else {
          // 【v26.4 兼容】老单：钱当初是从主站余额扣的 → 退回主站，否则玩家的钱就凭空没了
          await walletLog(db, me, o.locked, 'exchange_unlock', `求购单撤单退回 ¥${o.locked.toFixed(2)}`, String(oid));
        }
      }
      await col.updateOne({ _id: oid }, { $set: { status: 'cancel', left: 0, locked: 0, updatedAt: new Date() } });
      const np = await db.collection('shanhai_profiles').findOne({ userId: me });
      await db.collection('shanhai_logs').insertOne({ userId: me, action: 'exchange_cancel', detail: { orderId: String(oid), side: o.side, left: o.left }, createdAt: new Date() }).catch(() => {});
      // 【v26.5.1】撤单后的最新数值一起回，前端立刻更新冻结与余额
      const nwc = await exWalletOf(db, me);
      res.json({
        ok: true, side: o.side, backAmount: o.side === 'sell' ? o.left : (o.locked || 0),
        lingqi: np ? (np.lingqi || 0) : 0, frozen: np ? (np.lingqiFrozen || 0) : 0,
        exBalance: money4(nwc.balance || 0),
        exFrozen: money4(nwc.frozen || 0),
        exAvailable: money4((nwc.balance || 0) - (nwc.frozen || 0)),
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
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
        // 【v24.8】挂机符合条件/已激活人数
        idle: {
          unlockStage: IDLE_CFG.unlockStage,
          eligible: await db.collection('shanhai_profiles').countDocuments(eligibleIdleQuery()),
          activated: await db.collection('shanhai_profiles').countDocuments({ ...eligibleIdleQuery(), idleAt: { $ne: null } }),
        },
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
  });

  // 【v24.8】挂机激活：查看符合条件的玩家名单
  app.get('/api/shanhai/admin/idle-eligible', auth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      const db = await getDb();
      const r = await activateIdle(db, { unlockStage: IDLE_CFG.unlockStage });
      // 注意：activateIdle 会顺手激活未激活的档案（首次查看即完成激活）
      res.json({ ok: true, ...r });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 【v24.8】挂机激活：手动对符合条件的老玩家激活计时（幂等，可从"现在"开始重新计时）
  app.post('/api/shanhai/admin/idle-activate', auth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '需要管理员权限' });
    try {
      const db = await getDb();
      const reset = req.body && req.body.reset === true;   // reset=true 时把所有人的起点设为现在
      if (reset) await db.collection('shanhai_profiles').updateMany(eligibleIdleQuery(), { $set: { idleAt: new Date(), idleActivatedAt: new Date() } });
      const r = await activateIdle(db, { unlockStage: IDLE_CFG.unlockStage });
      await db.collection('shanhai_logs').insertOne({ action: 'idle_activate', detail: { reset, eligible: r.eligible, activated: r.activated }, createdAt: new Date() }).catch(() => {});
      res.json({ ok: true, ...r });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
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
