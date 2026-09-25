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
  // 造一件装备（指定槽位与品质）——寻宝/福袋/合成共用同一套数值口径
  const makeItem = (slot, q) => {
    const a = AFFIX[slot];
    const val = Math.round(a.base * q.mul * (0.9 + Math.random() * 0.25) * 10) / 10;
    // 【v24.6】玄机宝阁九阶：一阶寻宝产出「一阶」装备；老装备无 tier 字段，前端按一阶显示
    return { id: 'eq' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), slot, tier: 1, quality: q.id, qualityName: q.name, color: q.color, name: randName(slot, q.id), affix: a.name, val };
  };
  const rollItem = () => {
    const totalW = QUALITY.reduce((s, q) => s + q.w, 0);
    let r = Math.random() * totalW, q = QUALITY[0];
    for (const qq of QUALITY) { if ((r -= qq.w) <= 0) { q = qq; break; } }
    return makeItem(SLOTS[Math.floor(Math.random() * SLOTS.length)], q);
  };

  // ==================== 【v26.8】装备升级 / 合成 / 灵石 ====================
  // 升级：消耗若干件「同品质」装备，掷骰成功则目标装备获得额外攻击力（upAtk）。
  //       无论成败，材料都销毁（用户定稿）。灵石可叠加成功率，单次最多 5 块。
  const UPGRADE_CFG = {
    white:  { cost: 5, rate: 60, min: 0.5, max: 3,   name: '凡品' },
    green:  { cost: 5, rate: 50, min: 1,   max: 6,   name: '良品' },
    blue:   { cost: 4, rate: 30, min: 3,   max: 15,  name: '上品' },
    purple: { cost: 3, rate: 20, min: 15,  max: 50,  name: '仙品' },
    gold:   { cost: 2, rate: 10, min: 30,  max: 100, name: '神品' },
  };
  const STONE_RATE = 5;     // 每块灵石 +5% 成功率
  const STONE_MAX = 5;      // 单次升级最多用 5 块
  const COMPOSE_RATE = 20;  // 合成基础成功率 20%
  const Q_ORDER = ['white', 'green', 'blue', 'purple', 'gold'];   // 品质档位序（合成取下一档）

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

  // ==================== 【v26.6】灵宝商城（用灵气买东西） ====================
  // 第一个商品：随机一阶装备福袋
  //   品质概率：上品 70% / 仙品 20% / 神品 10%（不含凡品、良品——福袋的价值感必须高于普通寻宝）
  //   定价：常规 600 灵气；每位玩家「首单」188 灵气（每人只享受一次，之后按原价）
  const BAG_QUALITIES = [
    { id: 'blue',   name: '上品', color: '#8ecff0', mul: 2.4, p: 70 },
    { id: 'purple', name: '仙品', color: '#c9a0ff', mul: 3.6, p: 20 },
    { id: 'gold',   name: '神品', color: '#ffd76a', mul: 5.5, p: 10 },
  ];
  // 开福袋：一阶装备 + 指定概率的品质（与寻宝共用槽位/词条池，数值口径一致）
  const rollBagItem = () => {
    let r = Math.random() * 100, q = BAG_QUALITIES[0];
    for (const qq of BAG_QUALITIES) { if ((r -= qq.p) <= 0) { q = qq; break; } }
    const slot = SLOTS[Math.floor(Math.random() * SLOTS.length)];
    const a = AFFIX[slot];
    const val = Math.round(a.base * q.mul * (0.9 + Math.random() * 0.25) * 10) / 10;
    return {
      id: 'eq' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      slot, tier: 1, quality: q.id, qualityName: q.name, color: q.color,
      name: randName(slot, q.id), affix: a.name, val, from: 'bag',
    };
  };
  const SHOP_ITEMS = [
    {
      id: 'tier1_bag',
      name: '随机一阶装备福袋',
      // 【v26.10】不用 emoji：🎁💎 这类贴图像素风在游戏里显得廉价（用户原话"人机图标"）。
      // 改用古风篆字，前端给它套一个金色圆底，像印章，题材也更搭。
      icon: '福',
      desc: '必出一件一阶装备，品质随机',
      rates: '上品 70%　仙品 20%　神品 10%',
      price: 600,          // 单价（灵气）
      firstPrice: 188,     // 首单特惠（每人一次）
      currency: 'lingqi',
      currencyName: '灵气',
    },
    {
      id: 'upgrade_bag',
      name: '升级福袋',
      icon: '宝',
      desc: '随机获得仙玉与一阶灵石，强化装备的硬通货',
      rates: '仙玉 100~1000　一阶灵石 1~5 块',
      price: 600,          // 单价（灵气）——如需调整改这里
      currency: 'lingqi',
      currencyName: '灵气',
    },
  ];

  app.get('/api/shanhai/shop', auth, async (req, res) => {
    try {
      const db = await getDb();
      const me = req.user.id;
      const p = await ensureProfile(db, me, req.user.displayName || req.user.username);
      const orders = await db.collection('shanhai_shop_orders')
        .find({ userId: me }).sort({ createdAt: -1 }).limit(10).toArray();
      const boughtCount = await db.collection('shanhai_shop_orders').countDocuments({ userId: me });
      res.json({
        ok: true,
        lingqi: p.lingqi || 0,
        bagCount: (p.bag || []).length,
        bagMax: META_CFG.bagMax,
        firstUsed: boughtCount > 0,          // 首单特惠是否已用掉
        items: SHOP_ITEMS,
        history: orders.map(o => ({
          at: o.createdAt, itemId: o.itemId, cost: o.cost, first: !!o.first,
          qualityName: (o.loot || {}).qualityName, name: (o.loot || {}).name,
        })),
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/shanhai/shop/buy', auth, limit({ name: 'sh-shop', max: 20, windowMs: 60 * 1000, msg: '买太快了，歇一下' }), async (req, res) => {
    let db = null;
    try {
      db = await getDb();
      const me = req.user.id;
      const { itemId } = req.body || {};
      const item = SHOP_ITEMS.find(x => x.id === itemId);
      if (!item) return res.status(400).json({ ok: false, error: '商品不存在' });
      const p = await ensureProfile(db, me, req.user.displayName || req.user.username);
      // 背包满了就别扣钱（先拦，避免"钱扣了货装不下"）
      if ((p.bag || []).length >= META_CFG.bagMax)
        return res.status(400).json({ ok: false, error: `背包已满（${META_CFG.bagMax} 件），先清理再买` });
      // 首单特惠：没买过就是首单
      const boughtCount = await db.collection('shanhai_shop_orders').countDocuments({ userId: me, itemId: item.id });
      const useFirst = !!(item.firstPrice && boughtCount === 0);
      const cost = useFirst ? item.firstPrice : item.price;
      if ((p.lingqi || 0) < cost)
        return res.status(400).json({ ok: false, error: `灵气不足（需 ${cost}，可用 ${p.lingqi || 0}）`, code: 'NO_LINGQI' });
      // 扣灵气：原子条件更新，避免并发重复扣
      const pay = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: me, lingqi: { $gte: cost } },
        { $inc: { lingqi: -cost }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after' });
      const np = pay && (pay.value || pay);
      if (!np) return res.status(409).json({ ok: false, error: '灵气不足或操作冲突，请刷新后重试' });
      // 开福袋：按商品类型分别处理
      let loot, gained = {};
      if (item.id === 'upgrade_bag') {
        // 升级福袋：仙玉 100~1000 + 一阶灵石 1~5
        const xianyu = 100 + Math.floor(Math.random() * 901);
        const stones = 1 + Math.floor(Math.random() * 5);
        await db.collection('shanhai_profiles').updateOne(
          { userId: me }, { $inc: { xianyu, 'stones.1': stones } });
        loot = { kind: 'upgrade', icon: '💎', xianyu, stones };
        gained = { xianyu, stones };
      } else {
        // 装备福袋（默认）
        loot = rollBagItem();
        await db.collection('shanhai_profiles').updateOne({ userId: me }, { $push: { bag: loot } });
      }
      await db.collection('shanhai_shop_orders').insertOne({
        userId: me, itemId: item.id, cost, first: useFirst, loot, createdAt: new Date(),
      }).catch(() => { });
      await db.collection('shanhai_logs').insertOne({
        userId: me, action: 'shop_buy', detail: Object.assign({ itemId: item.id, cost, first: useFirst }, gained, loot.quality ? { quality: loot.quality, name: loot.name } : {}),
        createdAt: new Date(),
      }).catch(() => { });
      // 重读一次最新状态（扣款后 bag/stones/xianyu 都变了）
      const nf = await db.collection('shanhai_profiles').findOne({ userId: me });
      res.json({
        ok: true, cost, first: useFirst, loot,
        lingqi: nf ? (nf.lingqi || 0) : 0,
        xianyu: nf ? (nf.xianyu || 0) : 0,
        stones1: nf ? ((nf.stones || {})['1'] || 0) : 0,
        bagCount: nf ? (nf.bag || []).length : 0,
        firstUsed: item.id === 'tier1_bag' ? boughtCount > 0 : true,
      });
    } catch (e) {
      console.error('[api] shop/buy', e);
      if (db) db.collection('shanhai_logs').insertOne({
        userId: req.user && req.user.id, action: 'exchange_error',
        detail: { where: 'shop/buy', msg: String((e && e.message) || e).slice(0, 200) }, createdAt: new Date(),
      }).catch(() => { });
      res.status(500).json({ ok: false, error: '购买失败，请稍后再试', debug: String((e && e.message) || e).slice(0, 90) });
    }
  });

  // ---------- 【v26.8】装备升级：消耗同品质装备，成功得额外攻击力，失败材料销毁 ----------
  app.post('/api/shanhai/equip/upgrade', auth, limit({ name: 'sh-upg', max: 40, windowMs: 60 * 1000, msg: '升级太频繁，歇一下' }), async (req, res) => {
    let step = 'load';
    try {
      const db = await getDb();
      const me = req.user.id;
      const { itemId, stones: useStonesRaw } = req.body || {};
      step = 'profile';
      const p = await ensureProfile(db, me, req.user.displayName || req.user.username);
      const bag = p.bag || [];
      const it = bag.find(x => x.id === itemId);
      if (!it) return res.status(400).json({ ok: false, error: '装备不在背包里' });
      const cfg = UPGRADE_CFG[it.quality];
      if (!cfg) return res.status(400).json({ ok: false, error: '该品质不支持升级' });
      const tier = it.tier || 1;
      // 材料：同品质的其他装备（不含被升级的这件）
      const mats = bag.filter(x => x.id !== itemId && x.quality === it.quality);
      if (mats.length < cfg.cost)
        return res.status(400).json({ ok: false, error: `需要 ${cfg.cost} 件${cfg.name}装备作为材料（现有 ${mats.length} 件）` });
      // 灵石：对应品阶，单次最多 5 块，每块 +5%
      const useStones = Math.max(0, Math.min(STONE_MAX, Math.floor(Number(useStonesRaw) || 0)));
      const haveStones = (p.stones || {})[tier] || 0;
      if (useStones > haveStones)
        return res.status(400).json({ ok: false, error: `${tier} 阶灵石不足（有 ${haveStones} 块）` });
      const rate = Math.min(95, cfg.rate + useStones * STONE_RATE);   // 封顶 95%，永远保留失败可能
      step = 'consume';
      // 无论成败，材料与灵石都消耗（用户定稿：失败则消耗的装备消失销毁）
      const matIds = mats.slice(0, cfg.cost).map(x => x.id);
      await db.collection('shanhai_profiles').updateOne(
        { userId: me }, { $pull: { bag: { id: { $in: matIds } } } });
      if (useStones > 0) {
        await db.collection('shanhai_profiles').updateOne(
          { userId: me }, { $inc: { ['stones.' + tier]: -useStones } });
      }
      step = 'roll';
      const success = Math.random() * 100 < rate;
      const gain = success ? Math.round((cfg.min + Math.random() * (cfg.max - cfg.min)) * 10) / 10 : 0;
      if (success) {
        // $inc 对不存在的字段会从 0 开始累加，无需预置 upAtk
        await db.collection('shanhai_profiles').updateOne(
          { userId: me, 'bag.id': itemId },
          { $inc: { 'bag.$.upAtk': gain }, $set: { updatedAt: new Date() } });
      }
      const np = await db.collection('shanhai_profiles').findOne({ userId: me });
      const nit = np ? (np.bag || []).find(x => x.id === itemId) : null;
      await db.collection('shanhai_logs').insertOne({
        userId: me, action: 'equip_upgrade',
        detail: { itemId, quality: it.quality, cost: cfg.cost, useStones, rate, success, gain },
        createdAt: new Date(),
      }).catch(() => { });
      res.json({
        ok: true, success, gain, rate,
        upAtk: nit ? (nit.upAtk || 0) : 0,
        matLeft: np ? (np.bag || []).filter(x => x.quality === it.quality && x.id !== itemId).length : 0,
        stonesLeft: np ? ((np.stones || {})[tier] || 0) : 0,
        bagCount: np ? (np.bag || []).length : 0,
      });
    } catch (e) {
      console.error('[api] equip/upgrade step=' + step, e);
      if (db) db.collection('shanhai_logs').insertOne({
        userId: req.user && req.user.id, action: 'exchange_error',
        detail: { where: 'equip/upgrade', step, msg: String((e && e.message) || e).slice(0, 200) }, createdAt: new Date(),
      }).catch(() => { });
      res.status(500).json({ ok: false, error: '升级失败，请稍后再试', debug: 'step=' + step + ' ' + String((e && e.message) || e).slice(0, 80) });
    }
  });

  // ---------- 【v26.8】装备合成：5 件同品阶同品质 → 1 件高一档品质，成功率 20%，失败全毁 ----------
  app.post('/api/shanhai/equip/compose', auth, limit({ name: 'sh-compose', max: 30, windowMs: 60 * 1000, msg: '合成太频繁，歇一下' }), async (req, res) => {
    let step = 'load';
    try {
      const db = await getDb();
      const me = req.user.id;
      const itemIds = (req.body || {}).itemIds || [];
      if (!Array.isArray(itemIds) || itemIds.length !== 5)
        return res.status(400).json({ ok: false, error: '需要恰好 5 件装备参与合成' });
      step = 'profile';
      const p = await ensureProfile(db, me, req.user.displayName || req.user.username);
      const bag = p.bag || [];
      const picked = itemIds.map(id => bag.find(x => x.id === id));
      if (picked.some(x => !x))
        return res.status(400).json({ ok: false, error: '有装备已不在背包里，请刷新后重选' });
      const tier = picked[0].tier || 1;
      const qid = picked[0].quality;
      if (!picked.every(x => (x.tier || 1) === tier && x.quality === qid))
        return res.status(400).json({ ok: false, error: '5 件装备必须同品阶、同品质' });
      const qi = Q_ORDER.indexOf(qid);
      if (qi < 0) return res.status(400).json({ ok: false, error: '未知品质' });
      if (qi >= Q_ORDER.length - 1)
        return res.status(400).json({ ok: false, error: '神品已是最高品质，无法再合成' });
      const nextQ = QUALITY.find(x => x.id === Q_ORDER[qi + 1]);
      step = 'consume';
      // 无论成败，5 件材料都消耗
      await db.collection('shanhai_profiles').updateOne(
        { userId: me }, { $pull: { bag: { id: { $in: itemIds } } } });
      step = 'roll';
      const success = Math.random() * 100 < COMPOSE_RATE;
      let loot = null;
      if (success) {
        // 槽位取第一件（玩家的选择意图），品质升一档
        loot = makeItem(picked[0].slot, nextQ);
        await db.collection('shanhai_profiles').updateOne({ userId: me }, { $push: { bag: loot } });
      }
      const np = await db.collection('shanhai_profiles').findOne({ userId: me });
      await db.collection('shanhai_logs').insertOne({
        userId: me, action: 'equip_compose',
        detail: { count: itemIds.length, quality: qid, slot: picked[0].slot, success, loot: loot ? loot.name : null },
        createdAt: new Date(),
      }).catch(() => { });
      res.json({
        ok: true, success, loot: loot || null,
        nextQualityName: nextQ.name, nextColor: nextQ.color,
        bagCount: np ? (np.bag || []).length : 0,
      });
    } catch (e) {
      console.error('[api] equip/compose step=' + step, e);
      if (db) db.collection('shanhai_logs').insertOne({
        userId: req.user && req.user.id, action: 'exchange_error',
        detail: { where: 'equip/compose', step, msg: String((e && e.message) || e).slice(0, 200) }, createdAt: new Date(),
      }).catch(() => { });
      res.status(500).json({ ok: false, error: '合成失败，请稍后再试', debug: 'step=' + step + ' ' + String((e && e.message) || e).slice(0, 80) });
    }
  });

  // ==================== 【v26.11】流派 + 天赋树 ====================
  // 默认配置：万剑是新手流派（starter），五个发展方向按用户定稿给全；
  // 其余三个流派只给骨架，具体节点由管理员在后台「游戏控制器 → 流派天赋」里改。
  // 节点四类：minor 小属性 / special 特殊加成 / play 特殊玩法 / ultimate 大技能。
  // eff 里的字段由对局读取（前端按 key 生效），后台可自由增删。
  const DEFAULT_FACTIONS = [
    {
      id: 'wanjian', name: '万剑流派', icon: '⚔', starter: true,
      desc: '新手流派 · 飞剑齐发，攻守兼备',
      branches: [
        { id: 'gz', name: '万剑归宗', role: '群体攻击', nodes: [
          { id: 'gz1', name: '剑意', type: 'minor', cost: 1, max: 5, eff: { atk: 1 }, desc: '攻击力 +1' },
          { id: 'gz2', name: '剑芒', type: 'special', cost: 2, max: 3, eff: { crit: 2 }, desc: '暴击率 +2%' },
          { id: 'gz3', name: '剑雨', type: 'play', cost: 3, max: 3, eff: { multiChance: 15, multiCnt: 2 }, desc: '射出飞剑时 15% 概率额外射出 2 把' },
          { id: 'gz4', name: '万剑归宗', type: 'ultimate', cost: 5, max: 1, eff: { summon: 12 }, desc: '主动：蓄力召唤 12 把飞剑横扫' },
        ] },
        { id: 'cx', name: '一箭穿心', role: '单体攻击', nodes: [
          { id: 'cx1', name: '锐锋', type: 'minor', cost: 1, max: 5, eff: { atk: 2 }, desc: '攻击力 +2' },
          { id: 'cx2', name: '破甲', type: 'special', cost: 2, max: 3, eff: { pierce: 3 }, desc: '无视护甲 +3%' },
          { id: 'cx3', name: '穿心', type: 'play', cost: 3, max: 3, eff: { executeChance: 10 }, desc: '对残血敌人 10% 概率必杀' },
          { id: 'cx4', name: '一箭穿心', type: 'ultimate', cost: 5, max: 1, eff: { burst: 300 }, desc: '主动：下一击造成 300% 伤害' },
        ] },
        { id: 'ws', name: '无声之剑', role: '刺客玩法', nodes: [
          { id: 'ws1', name: '潜行', type: 'minor', cost: 1, max: 5, eff: { moveSpd: 2 }, desc: '移速 +2%' },
          { id: 'ws2', name: '影袭', type: 'special', cost: 2, max: 3, eff: { crit: 3 }, desc: '暴击率 +3%' },
          { id: 'ws3', name: '背刺', type: 'play', cost: 3, max: 3, eff: { backstab: 50 }, desc: '背后攻击伤害 +50%' },
          { id: 'ws4', name: '无声之剑', type: 'ultimate', cost: 5, max: 1, eff: { invis: 3 }, desc: '主动：隐身 3 秒并强化首击' },
        ] },
        { id: 'ct', name: '淬体之剑', role: '炼体玩法', nodes: [
          { id: 'ct1', name: '强躯', type: 'minor', cost: 1, max: 5, eff: { hp: 3 }, desc: '生命值 +3%' },
          { id: 'ct2', name: '护盾', type: 'special', cost: 2, max: 3, eff: { shield: 20 }, desc: '护盾血量 +20' },
          { id: 'ct3', name: '反震', type: 'play', cost: 3, max: 3, eff: { thorns: 15 }, desc: '受击反弹 15% 伤害' },
          { id: 'ct4', name: '淬体之剑', type: 'ultimate', cost: 5, max: 1, eff: { ironBody: 5 }, desc: '主动：5 秒减伤 60%' },
        ] },
        { id: 'lm', name: '灵敏之剑', role: '敏捷玩法', nodes: [
          { id: 'lm1', name: '疾步', type: 'minor', cost: 1, max: 5, eff: { moveSpd: 3 }, desc: '移速 +3%' },
          { id: 'lm2', name: '灵巧', type: 'special', cost: 2, max: 3, eff: { dodge: 3 }, desc: '闪避率 +3%' },
          { id: 'lm3', name: '连刺', type: 'play', cost: 3, max: 3, eff: { atkSpd: 8 }, desc: '攻击速度 +8%' },
          { id: 'lm4', name: '灵敏之剑', type: 'ultimate', cost: 5, max: 1, eff: { haste: 6 }, desc: '主动：6 秒内攻速翻倍' },
        ] },
      ],
    },
    { id: 'huohuo', name: '御火流派', icon: '🔥', desc: '焚天煮海 · 持续灼烧', branches: [
      { id: 'hh_main', name: '御火诀', role: '火焰玩法', nodes: [
        { id: 'hh1', name: '火种', type: 'minor', cost: 1, max: 5, eff: { atk: 2 }, desc: '攻击力 +2' },
        { id: 'hh2', name: '灼烧', type: 'play', cost: 3, max: 3, eff: { burn: 5 }, desc: '攻击附加灼烧伤害' },
        { id: 'hh3', name: '焚天', type: 'ultimate', cost: 5, max: 1, eff: { meteor: 1 }, desc: '主动：天降陨火' },
      ] },
    ] },
    { id: 'hanbing', name: '寒冰流派', icon: '❄', desc: '冰封千里 · 控场减速', branches: [
      { id: 'hb_main', name: '寒冰诀', role: '冰霜玩法', nodes: [
        { id: 'hb1', name: '冰心', type: 'minor', cost: 1, max: 5, eff: { hp: 2 }, desc: '生命值 +2%' },
        { id: 'hb2', name: '冻结', type: 'play', cost: 3, max: 3, eff: { slow: 20 }, desc: '攻击使敌人减速 20%' },
        { id: 'hb3', name: '冰封千里', type: 'ultimate', cost: 5, max: 1, eff: { freeze: 2 }, desc: '主动：冻结全场 2 秒' },
      ] },
    ] },
    { id: 'leifa', name: '雷法流派', icon: '⚡', desc: '雷霆万钧 · 连锁爆发', branches: [
      { id: 'lf_main', name: '雷法诀', role: '雷电玩法', nodes: [
        { id: 'lf1', name: '引雷', type: 'minor', cost: 1, max: 5, eff: { atk: 2 }, desc: '攻击力 +2' },
        { id: 'lf2', name: '连锁', type: 'play', cost: 3, max: 3, eff: { chain: 2 }, desc: '攻击连锁 2 个目标' },
        { id: 'lf3', name: '雷霆万钧', type: 'ultimate', cost: 5, max: 1, eff: { thunder: 8 }, desc: '主动：召唤 8 道雷霆' },
      ] },
    ] },
  ];

  // 局内基础能力池（用户定稿：局内不再选技能，只选这些基础加成）
  const INBORN_POOL = {
    white: { w: 50, name: '白色', color: '#cfd8dc', mods: [
      { k: 'atk', v: 5, t: '攻击力 +5%' }, { k: 'moveSpd', v: 10, t: '移动速度 +10%' },
      { k: 'hp', v: 5, t: '生命值 +5%' }, { k: 'atkSpd', v: 10, t: '攻击速度 +10%' },
      { k: 'crit', v: 5, t: '暴击率 +5%' }, { k: 'dodge', v: 5, t: '闪避率 +5%' },
      { k: 'shield', v: 20, t: '护盾血量 +20' }, { k: 'pickRange', v: 10, t: '经验拾取范围 +10%' },
      { k: 'expRate', v: 10, t: '经验加成 +10%' }] },
    blue: { w: 25, name: '蓝色', color: '#8ecff0', mods: [
      { k: 'atk', v: 10, t: '攻击力 +10%' }, { k: 'moveSpd', v: 15, t: '移动速度 +15%' },
      { k: 'hp', v: 10, t: '生命值 +10%' }, { k: 'atkSpd', v: 20, t: '攻击速度 +20%' },
      { k: 'crit', v: 8, t: '暴击率 +8%' }, { k: 'dodge', v: 8, t: '闪避率 +8%' },
      { k: 'shield', v: 40, t: '护盾血量 +40' }, { k: 'pickRange', v: 20, t: '经验拾取范围 +20%' },
      { k: 'expRate', v: 15, t: '经验加成 +15%' }] },
    purple: { w: 15, name: '紫色', color: '#c9a0ff', mods: [
      { k: 'atk', v: 20, t: '攻击力 +20%' }, { k: 'moveSpd', v: 30, t: '移动速度 +30%' },
      { k: 'hp', v: 20, t: '生命值 +20%' }, { k: 'atkSpd', v: 30, t: '攻击速度 +30%' },
      { k: 'crit', v: 15, t: '暴击率 +15%' }, { k: 'dodge', v: 15, t: '闪避率 +15%' },
      { k: 'shield', v: 80, t: '护盾血量 +80' }, { k: 'pickRange', v: 30, t: '经验拾取范围 +30%' },
      { k: 'expRate', v: 20, t: '经验加成 +20%' }] },
    gold: { w: 8, name: '金色', color: '#ffd76a', mods: [
      { k: 'atk', v: 40, t: '攻击力 +40%' }, { k: 'moveSpd', v: 40, t: '移动速度 +40%' },
      { k: 'hp', v: 40, t: '生命值 +40%' }, { k: 'atkSpd', v: 40, t: '攻击速度 +40%' },
      { k: 'crit', v: 20, t: '暴击率 +20%' }, { k: 'dodge', v: 20, t: '闪避率 +20%' },
      { k: 'shield', v: 180, t: '护盾血量 +180' }, { k: 'pickRange', v: 40, t: '经验拾取范围 +40%' },
      { k: 'expRate', v: 30, t: '经验加成 +30%' }] },
    myth: { w: 2, name: '神话', color: '#ff7a5c', mods: [
      { k: 'atk', v: 60, t: '攻击力 +60%' }, { k: 'moveSpd', v: 60, t: '移动速度 +60%' },
      { k: 'hp', v: 60, t: '生命值 +60%' }, { k: 'atkSpd', v: 60, t: '攻击速度 +60%' }] },
  };

  async function loadFactions(db) {
    try {
      const doc = await db.collection('shanhai_config').findOne({ _id: 'factions' });
      if (doc && Array.isArray(doc.value) && doc.value.length) return doc.value;
    } catch (e) { }
    return DEFAULT_FACTIONS;
  }
  // 天赋点：三星通关每关 1 点（含补发老玩家已三星的关卡）
  async function syncTalent(db, p) {
    const stars = p.stageStars || {};
    const three = Object.keys(stars).filter(k => (+stars[k] || 0) >= 3).length;
    const spent = Object.values(p.talents || {}).reduce((s, f) =>
      s + Object.values(f || {}).reduce((a, lv) => a + (+lv || 0), 0), 0);
    const cur = p.talentPoints || 0;
    const total = three + (p.talentBonus || 0);
    const want = Math.max(0, total - spent - (p.talentUsed || 0));
    // 【补发】老玩家已有三星关卡但点数没给够 → 一次性补齐（幂等：只写差额）
    if (want !== cur) {
      await db.collection('shanhai_profiles').updateOne(
        { userId: p.userId }, { $set: { talentPoints: want } });
      p.talentPoints = want;
    }
    return { points: want, earned: total, spent };
  }

  app.get('/api/shanhai/faction', auth, async (req, res) => {
    try {
      const db = await getDb();
      const me = req.user.id;
      const p = await ensureProfile(db, me, req.user.displayName || req.user.username);
      const tp = await syncTalent(db, p);
      const factions = await loadFactions(db);
      res.json({
        ok: true,
        current: p.faction || 'wanjian',
        points: tp.points, earned: tp.earned,
        talents: p.talents || {},
        factions: factions.map(f => ({
          id: f.id, name: f.name, icon: f.icon, desc: f.desc, starter: !!f.starter,
          branches: (f.branches || []).map(b => ({
            id: b.id, name: b.name, role: b.role || '',
            nodes: (b.nodes || []).map(n => ({
              id: n.id, name: n.name, type: n.type, cost: n.cost, max: n.max,
              desc: n.desc || '', eff: n.eff || {},
              // 【v26.17】前置技能解锁条件：req = { node, lv } —— 前置节点达到 lv 级才可学
              req: n.req ? { node: String(n.req.node), lv: Math.max(1, Math.round(Number(n.req.lv) || 1)) } : null,
            })),
          })),
        })),
        // 局内加成池（概率与条目都给前端，对局按这个抽）
        inborn: INBORN_POOL,
      });
    } catch (e) { console.error('[api] faction', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/shanhai/faction/select', auth, async (req, res) => {
    try {
      const db = await getDb();
      const me = req.user.id;
      const { id } = req.body || {};
      const factions = await loadFactions(db);
      if (!factions.some(f => f.id === id)) return res.status(400).json({ ok: false, error: '流派不存在' });
      const p = await ensureProfile(db, me, req.user.displayName || req.user.username);
      if (p.faction === id) return res.json({ ok: true, current: id, changed: false });
      await db.collection('shanhai_profiles').updateOne(
        { userId: me }, { $set: { faction: id, updatedAt: new Date() } });
      await db.collection('shanhai_logs').insertOne({
        userId: me, action: 'faction_select', detail: { from: p.faction || 'wanjian', to: id }, createdAt: new Date(),
      }).catch(() => { });
      res.json({ ok: true, current: id, changed: true });
    } catch (e) { console.error('[api] faction/select', e); res.status(500).json({ ok: false, error: '切换失败，请稍后再试' }); }
  });

  app.post('/api/shanhai/talent/learn', auth, limit({ name: 'sh-talent', max: 60, windowMs: 60 * 1000, msg: '点得太快了' }), async (req, res) => {
    try {
      const db = await getDb();
      const me = req.user.id;
      const { factionId, nodeId } = req.body || {};
      const p = await ensureProfile(db, me, req.user.displayName || req.user.username);
      const factions = await loadFactions(db);
      const f = factions.find(x => x.id === factionId);
      if (!f) return res.status(400).json({ ok: false, error: '流派不存在' });
      let node = null;
      for (const b of (f.branches || [])) { const n = (b.nodes || []).find(x => x.id === nodeId); if (n) { node = n; break; } }
      if (!node) return res.status(400).json({ ok: false, error: '天赋节点不存在' });
      const talents = p.talents || {};
      const ft = Object.assign({}, talents[factionId] || {});
      const lv = +ft[nodeId] || 0;
      const max = Math.max(1, +node.max || 1);
      if (lv >= max) return res.status(400).json({ ok: false, error: '该天赋已满级' });
      // 【v26.17】前置技能等级限制：req = { node, lv }——前置节点达到 lv 级才能学本节点
      if (node.req && node.req.node) {
        const reqLv = Math.max(1, Math.round(Number(node.req.lv) || 1));
        const cur = +ft[node.req.node] || 0;
        if (cur < reqLv) {
          let rn = null;
          for (const b of (f.branches || [])) { const x = (b.nodes || []).find(y => y.id === node.req.node); if (x) { rn = x; break; } }
          return res.status(400).json({ ok: false, error: `前置技能「${rn ? rn.name : node.req.node}」需先达到 Lv.${reqLv}（当前 Lv.${cur}）`, code: 'REQ_LOCKED' });
        }
      }
      const cost = Math.max(0, +node.cost || 1);
      const tp = await syncTalent(db, p);
      if (tp.points < cost) return res.status(400).json({ ok: false, error: `天赋点不足（需 ${cost}，剩 ${tp.points}）`, code: 'NO_POINT' });
      ft[nodeId] = lv + 1;
      const nt = Object.assign({}, talents, { [factionId]: ft });
      // 原子：点数够才扣，避免连点超扣
      const r = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: me, talentPoints: { $gte: cost } },
        { $inc: { talentPoints: -cost }, $set: { talents: nt, updatedAt: new Date() } },
        { returnDocument: 'after' });
      const np = r && (r.value || r);
      if (!np) return res.status(409).json({ ok: false, error: '天赋点不足或操作冲突，请刷新' });
      await db.collection('shanhai_logs').insertOne({
        userId: me, action: 'talent_learn', detail: { factionId, nodeId, lv: lv + 1, cost }, createdAt: new Date(),
      }).catch(() => { });
      res.json({ ok: true, points: np.talentPoints || 0, talents: np.talents || {}, level: lv + 1 });
    } catch (e) { console.error('[api] talent/learn', e); res.status(500).json({ ok: false, error: '学习失败，请稍后再试' }); }
  });

  // ==================== 【v26.17】后台：流派技能树配置 ====================
  // 管理员可视化配置技能树结构：层级（分支/节点）、前置解锁条件（前置节点+所需等级）、
  // 每节点最高等级。保存到 shanhai_config(_id:'factions')，玩家端 /faction 即时生效。
  function validateFactions(list) {
    if (!Array.isArray(list) || list.length < 1 || list.length > 10) return '流派数量需为 1~10 个';
    const fids = new Set();
    for (const f of list) {
      if (!f || typeof f !== 'object') return '流派数据格式错误';
      if (!/^[a-zA-Z0-9_-]{2,20}$/.test(String(f.id || ''))) return `流派 id 不合法（${f.id || '空'}）：需 2~20 位字母数字_-`;
      if (!String(f.name || '').trim() || String(f.name).length > 20) return `流派 ${f.id} 的名称需 1~20 字`;
      if (fids.has(f.id)) return `流派 id 重复：${f.id}`;
      fids.add(f.id);
      if (!Array.isArray(f.branches) || f.branches.length < 1 || f.branches.length > 10) return `流派 ${f.name} 需有 1~10 个分支`;
      const nodeMap = new Map();   // id -> {max}
      for (const b of f.branches) {
        if (!b || typeof b !== 'object') return `流派 ${f.name} 的分支数据格式错误`;
        if (!/^[a-zA-Z0-9_-]{2,20}$/.test(String(b.id || ''))) return `流派 ${f.name} 的分支 id 不合法`;
        if (!String(b.name || '').trim() || String(b.name).length > 20) return `流派 ${f.name} 的分支名称需 1~20 字`;
        if (!Array.isArray(b.nodes) || b.nodes.length < 1 || b.nodes.length > 20) return `分支「${b.name}」需有 1~20 个节点`;
        for (const n of b.nodes) {
          if (!n || typeof n !== 'object') return `分支「${b.name}」的节点数据格式错误`;
          if (!/^[a-zA-Z0-9_-]{2,20}$/.test(String(n.id || ''))) return `分支「${b.name}」的节点 id 不合法（${n.id || '空'}）`;
          if (nodeMap.has(n.id)) return `分支「${b.name}」存在重复的节点 id：${n.id}（${n.name || '未命名'}），请删掉多余的一张卡`;
          const max = Math.round(Number(n.max));
          if (!(max >= 1 && max <= 50)) return `分支「${b.name}」的「${n.name || n.id}」最高等级需为 1~50`;
          const cost = Math.round(Number(n.cost));
          if (!(cost >= 0 && cost <= 20)) return `分支「${b.name}」的「${n.name || n.id}」每次消耗需为 0~20 天赋点`;
          const eff = (n.eff && typeof n.eff === 'object' && !Array.isArray(n.eff)) ? n.eff : {};
          const effKeys = Object.keys(eff);
          if (effKeys.length > 6) return `分支「${b.name}」的「${n.name || n.id}」加成字段最多 6 个`;
          for (const k of effKeys) {
            if (!/^[a-zA-Z]{2,20}$/.test(k)) return `分支「${b.name}」的「${n.name || n.id}」加成字段名不合法：${k}`;
            if (!Number.isFinite(+eff[k]) || Math.abs(+eff[k]) > 100000) return `分支「${b.name}」的「${n.name || n.id}」加成数值不合法：${k}`;
          }
          nodeMap.set(n.id, { max, name: n.name });
        }
      }
      // 第二遍：校验前置引用（可跨分支引用同流派节点）+ 前置等级 <= 前置节点最高级
      const edges = new Map();   // nodeId -> prereq nodeId
      for (const b of f.branches) {
        for (const n of b.nodes) {
          if (n.req == null || n.req.node == null || n.req.node === '') continue;
          const rn = String(n.req.node);
          if (rn === String(n.id)) return `分支「${b.name}」的「${n.name || n.id}」不能以自己为前置`;
          const pr = nodeMap.get(rn);
          if (!pr) return `分支「${b.name}」的「${n.name || n.id}」前置节点 ${rn} 不存在（可能已被删除或改名，请重新选择前置）`;
          const rl = Math.round(Number(n.req.lv));
          if (!(rl >= 1 && rl <= pr.max)) return `分支「${b.name}」的「${n.name || n.id}」前置等级需为 1~${pr.max}（前置「${pr.name}」最高 ${pr.max} 级）`;
          edges.set(n.id, rn);
        }
      }
      // 防环：前置链必须是有向无环图（否则出现"互为前置"永远学不了的死节点）
      const color = new Map();   // 0=未访 1=在栈 2=完成
      const hasCycle = (id) => {
        color.set(id, 1);
        const nxt = edges.get(id);
        if (nxt) {
          const c = color.get(nxt);
          if (c === 1) return true;
          if (!c && hasCycle(nxt)) return true;
        }
        color.set(id, 2);
        return false;
      };
      for (const id of edges.keys()) {
        if (!color.get(id) && hasCycle(id)) return `流派 ${f.name} 的前置关系存在循环依赖（如 A 前置 B、B 又前置 A），请调整`;
      }
    }
    return null;
  }

  app.get('/api/shanhai/admin/factions', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const doc = await db.collection('shanhai_config').findOne({ _id: 'factions' });
      const custom = !!(doc && Array.isArray(doc.value) && doc.value.length);
      res.json({ ok: true, factions: custom ? doc.value : DEFAULT_FACTIONS, custom });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });
  app.put('/api/shanhai/admin/factions', auth, adminOnly, async (req, res) => {
    try {
      const list = (req.body || {}).factions;
      const err = validateFactions(list);
      if (err) return res.status(400).json({ ok: false, error: err });
      await db.collection('shanhai_config').updateOne(
        { _id: 'factions' },
        { $set: { value: list, updatedAt: new Date() } },
        { upsert: true });
      await db.collection('shanhai_logs').insertOne({
        userId: req.user.id, action: 'admin_factions_save', detail: { factions: list.length }, createdAt: new Date(),
      }).catch(() => { });
      res.json({ ok: true });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '保存失败，请稍后再试' }); }
  });
  app.post('/api/shanhai/admin/factions/reset', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      await db.collection('shanhai_config').deleteOne({ _id: 'factions' });
      await db.collection('shanhai_logs').insertOne({
        userId: req.user.id, action: 'admin_factions_reset', detail: {}, createdAt: new Date(),
      }).catch(() => { });
      res.json({ ok: true, factions: DEFAULT_FACTIONS, custom: false });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ==================== 【v26.25】活动系统（活动中心 + 维护锁 + 测试账号） ====================
  async function loadActSys(db) {
    const d = await db.collection('shanhai_config').findOne({ _id: 'activity_sys' });
    const v = Object.assign({ locked: false, testAccounts: [], duiduileBeta: false }, (d && d.value) || {});
    if (!Array.isArray(v.testAccounts)) v.testAccounts = String(v.testAccounts || '').split(/[,，\s]+/).filter(Boolean);
    return v;
  }
  const actPub = a => ({
    id: String(a._id), title: a.title, tag: a.tag || '', content: a.content || '',
    img: a.img || '', start: a.start || null, end: a.end || null, type: a.type || '',
  });

  // 玩家端：活动列表 + 维护锁状态（测试账号不受锁限制；名单不下发）
  app.get('/api/shanhai/activities', auth, limit({ name: 'sh-act', max: 30, windowMs: 60 * 1000, msg: '太快了' }), async (req, res) => {
    try {
      const db = await getDb();
      const sys = await loadActSys(db);
      const me = req.user;
      const isTester = sys.testAccounts.includes(me.username) || (me.uid && sys.testAccounts.includes(String(me.uid)));
      const now = new Date();
      const all = await db.collection('shanhai_activities').find({}).sort({ sort: 1, createdAt: 1 }).limit(50).toArray();
      // 【v26.32 修复】内测/管理员忽略时间窗（未开始的也要能看到并测试）；
      // 普通玩家维持原过滤（未开始/已结束不出现）
      const staff = isTester || me.role === 'admin';
      const list = all
        .filter(a => a.enabled !== false && (staff || ((!a.start || new Date(a.start) <= now) && (!a.end || new Date(a.end) >= now))))
        .map(actPub);
      // 自检数据（仅测试员/管理员可见）：列表为空时一眼看出是哪层过滤掉的
      const debug = (isTester || me.role === 'admin') ? {
        now: now.toISOString(),
        total: all.length,
        enabledCount: all.filter(a => a.enabled !== false).length,
        shown: list.length,
        rows: all.slice(0, 5).map(a => ({ title: a.title, type: a.type || '', enabled: a.enabled !== false, start: a.start || null, end: a.end || null })),
      } : undefined;
      res.json({ ok: true, locked: !!sys.locked && !isTester, tester: isTester, activities: list, debug });
    } catch (e) { console.error('[api] activities', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 管理端：列表（含禁用与未生效的，便于编辑）
  app.get('/api/shanhai/admin/activities', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const sys = await loadActSys(db);
      const list = await db.collection('shanhai_activities').find({}).sort({ sort: 1, createdAt: 1 }).limit(100).toArray();
      res.json({ ok: true, sys, list: list.map(a => Object.assign(actPub(a), { enabled: a.enabled !== false })) });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });
  app.post('/api/shanhai/admin/activities/save', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const b = req.body || {};
      // 【v26.29 修复】datetime-local 的时间字符串不带时区，服务器在国外会按当地时区解析——
      // 填"10:00"实际变成北京时间 22:00，活动被"未开始"过滤掉。统一按北京时间(+08:00)解析
      const parseCn = s => {
        if (!s) return null;
        const str = String(s);
        return new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(str) ? str : str + ':00+08:00');
      };
      const doc = {
        title: String(b.title || '').trim().slice(0, 40),
        tag: String(b.tag || '').trim().slice(0, 10),
        img: String(b.img || '').trim().slice(0, 200),
        content: String(b.content || '').slice(0, 5000),
        start: parseCn(b.start),
        end: parseCn(b.end),
        type: String(b.type || '').trim().slice(0, 20),
        enabled: b.enabled !== false,
        updatedAt: new Date(),
      };
      if (!doc.title) return res.status(400).json({ ok: false, error: '请填写活动标题' });
      let _id = null;
      if (b.id && ObjectId.isValid(String(b.id))) _id = new ObjectId(String(b.id));
      if (_id) await db.collection('shanhai_activities').updateOne({ _id }, { $set: doc });
      else {
        const cnt = await db.collection('shanhai_activities').countDocuments({});
        await db.collection('shanhai_activities').insertOne(Object.assign(doc, { sort: cnt, createdAt: new Date() }));
      }
      await db.collection('shanhai_logs').insertOne({ userId: req.user.id, action: 'admin_activity_save', detail: { title: doc.title }, createdAt: new Date() }).catch(() => { });
      res.json({ ok: true });
    } catch (e) { console.error('[api] activity/save', e); res.status(500).json({ ok: false, error: '保存失败：' + String((e && e.message) || e).slice(0, 100) }); }
  });
  app.post('/api/shanhai/admin/activities/del', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const id = String((req.body || {}).id || '');
      if (!ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: '参数无效' });
      await db.collection('shanhai_activities').deleteOne({ _id: new ObjectId(id) });
      res.json({ ok: true });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '删除失败，请稍后再试' }); }
  });
  app.post('/api/shanhai/admin/activities/reorder', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const ids = (req.body || {}).ids || [];
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ ok: false, error: '参数无效' });
      for (let i = 0; i < ids.length; i++) {
        if (!ObjectId.isValid(String(ids[i]))) continue;
        await db.collection('shanhai_activities').updateOne({ _id: new ObjectId(String(ids[i])) }, { $set: { sort: i } });
      }
      res.json({ ok: true });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '排序失败，请稍后再试' }); }
  });
  // 维护锁 + 测试账号（锁打开时普通玩家入口显示上锁样式，名单内账号不受限）
  app.post('/api/shanhai/admin/activity-sys', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const b = req.body || {};
      let accounts = b.testAccounts || [];
      if (typeof accounts === 'string') accounts = accounts.split(/[,，\s]+/).filter(Boolean);
      accounts = accounts.map(s => String(s).trim().slice(0, 30)).filter(Boolean).slice(0, 50);
      const value = { locked: !!b.locked, testAccounts: accounts, duiduileBeta: !!b.duiduileBeta, updatedAt: new Date() };
      await db.collection('shanhai_config').updateOne({ _id: 'activity_sys' }, { $set: { value } }, { upsert: true });
      await db.collection('shanhai_logs').insertOne({ userId: req.user.id, action: 'admin_activity_sys', detail: { locked: value.locked, testers: accounts.length, duiduileBeta: value.duiduileBeta }, createdAt: new Date() }).catch(() => { });
      res.json({ ok: true, sys: value });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '保存失败，请稍后再试' }); }
  });

  // ==================== 【v26.26】灵气堆堆乐（中秋活动玩法） ====================
  // 投入 100 灵气 → 按概率翻倍（90% 1~2倍 / 8% 2~3倍 / 1.9% 3~5倍 / 0.1% 5~10倍）→
  // 奖励在活动结束次日起分 100 天每日发放（每天 reward/100，最后一天发尾差）。
  // 次数：每人 1 次免费 → 每通关 10 关 +1 次 → 之后每次投入 100 灵气。
  const DD_COL = 'shanhai_duiduile';
  const DD_COST = 100;
  const DD_DAYS = 100;
  function rollDuiduileMult() {
    const r = Math.random();
    let mult;
    if (r < 0.9) mult = 1 + Math.random();
    else if (r < 0.98) mult = 2 + Math.random();
    else if (r < 0.999) mult = 3 + Math.random() * 2;
    else mult = 5 + Math.random() * 5;
    return Math.round(mult * 100) / 100;
  }
  const ddTester = (sys, me) => sys.testAccounts.includes(me.username) || (me.uid && sys.testAccounts.includes(String(me.uid)));

  async function ddInfo(db, sys, me) {
    const act = await db.collection('shanhai_activities').findOne({ type: 'duiduile', enabled: { $ne: false } });
    if (!act) return { open: false, reason: '活动未配置' };
    const now = new Date();
    const inWindow = (!act.start || new Date(act.start) <= now) && (!act.end || new Date(act.end) >= now);
    const beta = !!sys.duiduileBeta && ddTester(sys, me);
    const played = await db.collection(DD_COL).countDocuments({ userId: me.id, activityId: String(act._id) });
    const prof = await ensureProfile(db, me.id, me.displayName || me.username);
    const bonusTotal = Math.floor((prof.clearedStages || []).length / 10);
    const bonusUsed = played > 0 ? played - 1 : 0;
    const last = await db.collection(DD_COL).findOne({ userId: me.id, activityId: String(act._id) }, { sort: { createdAt: -1 } });
    return {
      open: true, inWindow, beta, title: act.title, start: act.start, end: act.end,
      plays: played, cleared: (prof.clearedStages || []).length,
      freeLeft: played > 0 ? 0 : 1,
      bonusLeft: Math.max(0, bonusTotal - bonusUsed),
      cost: DD_COST, days: DD_DAYS,
      last: last ? { mult: last.mult, reward: last.reward, releasedDays: last.releasedDays, perDay: last.perDay } : null,
    };
  }
  app.get('/api/shanhai/duiduile/info', auth, limit({ name: 'sh-dd-info', max: 60, windowMs: 60 * 1000, msg: '太快了' }), async (req, res) => {
    try {
      const db = await getDb();
      const sys = await loadActSys(db);
      res.json({ ok: true, info: await ddInfo(db, sys, req.user) });
    } catch (e) { console.error('[api] duiduile/info', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });
  app.post('/api/shanhai/duiduile/play', auth, limit({ name: 'sh-dd-play', max: 15, windowMs: 60 * 1000, msg: '操作太频繁' }), async (req, res) => {
    try {
      const db = await getDb();
      const sys = await loadActSys(db);
      const me = req.user;
      const act = await db.collection('shanhai_activities').findOne({ type: 'duiduile', enabled: { $ne: false } });
      if (!act) return res.status(400).json({ ok: false, error: '活动未开启' });
      const now = new Date();
      const inWindow = (!act.start || new Date(act.start) <= now) && (!act.end || new Date(act.end) >= now);
      const beta = !!sys.duiduileBeta && ddTester(sys, me);
      if (!inWindow && !beta) return res.status(400).json({ ok: false, error: '不在活动参与时间内' });
      const played = await db.collection(DD_COL).countDocuments({ userId: me.id, activityId: String(act._id) });
      await ensureProfile(db, me.id, me.displayName || me.username);
      const bonusTotal = Math.floor((await db.collection('shanhai_profiles').findOne({ userId: me.id }, { projection: { clearedStages: 1 } }) || { clearedStages: [] }).clearedStages?.length / 10 || 0);
      const bonusUsed = played > 0 ? played - 1 : 0;
      let costType = 'free';   // 消耗顺序：免费 1 次 → 通关加成次数 → 投入 100 灵气
      if (played > 0) costType = bonusUsed < bonusTotal ? 'bonus' : 'lingqi';
      if (costType === 'lingqi') {
        const r = await db.collection('shanhai_profiles').findOneAndUpdate(
          { userId: me.id, lingqi: { $gte: DD_COST } },
          { $inc: { lingqi: -DD_COST }, $set: { updatedAt: new Date() } });
        if (!r || !(r.value || r)) return res.status(400).json({ ok: false, error: `灵气不足（参与需投入 ${DD_COST} 灵气）`, code: 'NO_LINGQI' });
      }
      const mult = rollDuiduileMult();
      const reward = Math.round(DD_COST * mult * 10) / 10;
      const perDay = Math.round(reward / DD_DAYS * 100) / 100;
      const releaseStart = act.end ? new Date(new Date(act.end).getTime() + 86400e3) : new Date(now.getTime() + 86400e3);
      const r2 = await db.collection(DD_COL).insertOne({
        userId: me.id, activityId: String(act._id), costType,
        base: DD_COST, mult, reward, totalDays: DD_DAYS,
        perDay, releasedDays: 0, releasedAmount: 0, releaseStart, lastDay: null,
        createdAt: new Date(),
      });
      await db.collection('shanhai_logs').insertOne({ userId: me.id, action: 'duiduile_play', detail: { costType, mult, reward }, createdAt: new Date() }).catch(() => { });
      res.json({ ok: true, costType, mult, reward, perDay, days: DD_DAYS, releaseStart: releaseStart.toISOString(), recordId: String(r2.insertedId) });
    } catch (e) { console.error('[api] duiduile/play', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });
  // 每日释放任务：活动结束次日起每天发 reward/100（最后一天发尾差）；幂等（按天标记 + 条件更新）
  async function processDuiduileRelease() {
    const db = await getDb();
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const docs = await db.collection(DD_COL).find({
      releasedDays: { $lt: DD_DAYS }, releaseStart: { $lte: new Date() }, lastDay: { $ne: today },
    }).limit(300).toArray();
    for (const d0 of docs) {
      const isLast = d0.releasedDays + 1 >= DD_DAYS;
      const amt = isLast
        ? Math.max(0, Math.round((d0.reward - d0.perDay * (DD_DAYS - 1)) * 100) / 100)
        : d0.perDay;
      const r = await db.collection(DD_COL).updateOne(
        { _id: d0._id, lastDay: { $ne: today }, releasedDays: d0.releasedDays },
        { $inc: { releasedDays: 1, releasedAmount: amt }, $set: { lastDay: today } });
      if (r.modifiedCount && amt > 0) {
        await db.collection('shanhai_profiles').updateOne({ userId: d0.userId }, { $inc: { lingqi: amt } });
        await db.collection('shanhai_logs').insertOne({ userId: d0.userId, action: 'duiduile_release', detail: { day: d0.releasedDays + 1, amt }, createdAt: new Date() }).catch(() => { });
      }
    }
    return docs.length;
  }
  setInterval(() => { processDuiduileRelease().catch(e => console.error('[duiduile] 释放任务', e.message)); }, 30 * 60 * 1000);
  setTimeout(() => { processDuiduileRelease().catch(() => { }); }, 90 * 1000);
  // 管理端：清理参与记录（全部 / 指定用户名或工号）——内测数据重置用
  app.post('/api/shanhai/admin/activities/finduser', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const q = String((req.body || {}).q || '').trim();
      if (!q) return res.status(400).json({ ok: false, error: '请输入用户名或工号' });
      const u = await db.collection('users').findOne(/^\d{7}$/.test(q) ? { uid: q } : { username: q })
        || await db.collection('users').findOne({ username: q.toLowerCase() });
      if (!u) return res.json({ ok: true, found: false, q });
      const sys = await loadActSys(db);
      const inList = sys.testAccounts.includes(u.username) || (u.uid && sys.testAccounts.includes(String(u.uid)));
      res.json({
        ok: true, found: true,
        user: { username: u.username, uid: u.uid || null, displayName: u.displayName || u.username, role: u.role || '' },
        inList,
      });
    } catch (e) { console.error('[api] finduser', e); res.status(500).json({ ok: false, error: '查询失败，请稍后再试' }); }
  });
  app.post('/api/shanhai/admin/duiduile/cleanup', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const b = req.body || {};
      const q = {};
      const who = String(b.username || '').trim();
      if (who) {
        const u = await db.collection('users').findOne(/^\d{7}$/.test(who) ? { uid: who } : { username: who });
        if (!u) return res.status(400).json({ ok: false, error: '未找到该用户' });
        q.userId = u._id.toString();
      }
      const r = await db.collection(DD_COL).deleteMany(q);
      await db.collection('shanhai_logs').insertOne({ userId: req.user.id, action: 'admin_dd_cleanup', detail: { deleted: r.deletedCount, who: who || 'ALL' }, createdAt: new Date() }).catch(() => { });
      res.json({ ok: true, deleted: r.deletedCount });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '清理失败，请稍后再试' }); }
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

      // —— 战绩 + 养成奖励原子入账 ——
      // 【v24.4】首通奖励随关卡递增：150 + 30×(st-1)，上限 720
      const firstClearGain = Math.min(720, META_CFG.firstClearXianyu + (st - 1) * 30);
      // 【v24.5】星级改按剩余血量：满血 3 星 / ≥60% 2 星 / <60% 1 星
      // （原来按用时算，玩家反馈"满血通关只给一星"）
      // 【2026-09-24 加固】hpPct 截断到 [0,1]，防上报 1.5 之类越界值干扰星级
      const hp = Math.max(0, Math.min(1, Number(hpPct) || 0));
      // 【v26.10】与客户端 ui.js 保持同一套标准：≥95% 血 3 星 / ≥60% 2 星 / 通关 1 星。
      const stars = isWin
        ? (Number(hpPct) != null && Number.isFinite(Number(hpPct)) ? (hp >= 0.95 ? 3 : hp >= 0.6 ? 2 : 1) : (t < 180 ? 3 : t < 360 ? 2 : 1))
        : 0;
      // 【二次复核修正】bestTimeSec 原来用对象展开生成第二个 $set，首通那一局会把
      // 前面 $set 里的 username/updatedAt 整体覆盖丢掉——改为预先组装同一个 $set
      const setResult = { username: req.user.displayName || req.user.username, updatedAt: new Date() };
      if (isWin && t > 0 && before.bestTimeSec == null) setResult.bestTimeSec = t;
      // 【2026-09-24 安全修复】首通奖励改为原子抢占：条件更新 clearedStages $ne st，
      // 命中（确实把 st 加进已通关列表）才发首通奖——原先读-判-写在并发双报同一关时首通奖（最高 720 仙玉）可发两次
      const mkUpd = (fc) => {
        const gainXianyu = k * META_CFG.killXianyu + (isWin ? META_CFG.winXianyu : 0) + (fc ? firstClearGain : 0);
        const gainLingqi = isWin ? META_CFG.winLingqi : 0;
        const upd = {
          $inc: { plays: 1, wins: isWin ? 1 : 0, totalKills: k, xianyu: gainXianyu, lingqi: gainLingqi },
          // 【v24.5】星级写入档案（$max 保证只升不降）
          $max: isWin ? { bestKills: k, maxLevel: lv, ["stageStars." + st]: stars } : { bestKills: k, maxLevel: lv },
          $set: setResult,
        };
        if (fc) upd.$addToSet = { clearedStages: st };
        if (isWin && t > 0 && before.bestTimeSec != null) upd.$min = { bestTimeSec: t };
        return { upd, gainXianyu, gainLingqi };
      };
      let firstClear = isWin;
      let { upd, gainXianyu, gainLingqi } = mkUpd(firstClear);
      const profCol = db.collection('shanhai_profiles');
      let r = firstClear
        ? await profCol.findOneAndUpdate(
          { userId: req.user.id, clearedStages: { $ne: st } }, upd, { returnDocument: 'after' })
        : await profCol.findOneAndUpdate({ userId: req.user.id }, upd, { returnDocument: 'after', upsert: true });
      if (!r && firstClear) {
        // 并发抢先（另一请求已把该关记为首通）：本局降级为普通通关重写一次
        firstClear = false;
        ({ upd, gainXianyu, gainLingqi } = mkUpd(false));
        r = await profCol.findOneAndUpdate({ userId: req.user.id }, upd, { returnDocument: 'after' });
      }
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
    } catch (e) {
      // 【2026-09-24 安全修复】fail-closed：DB 异常时维护总闸失效是"最需要止血时开关失灵"，
      // 改为拒绝请求（503），宁可误报维护也不能在异常态放行资金操作
      console.error('[exchange] 总闸检查失败，按维护处理:', e.message);
      res.status(503).json({ ok: false, error: '交易所暂时不可用，请稍后再来', code: 'EX_CLOSED' });
    }
  };

  // 【2026-09-24 安全修复】进程内用户级互斥锁：把同一用户的资金操作（转入/挂单/吃单/撤单）
  // 串行化，根治"读-判-写"竞态（并发双花、冻结超发、撤单与成交双退）。
  // 本系统为单实例部署（限流/缓存同为进程内存），进程内锁即全局锁；多实例部署需换 Redis。
  const _userLocks = new Map();
  async function withUserLock(key, fn) {
    while (_userLocks.has(key)) { await _userLocks.get(key).catch(() => { }); }
    let release;
    const gate = new Promise(r => { release = r; });
    _userLocks.set(key, gate);
    try { return await fn(); }
    finally { release(); if (_userLocks.get(key) === gate) _userLocks.delete(key); }
  }

  async function exWalletOf(db, userId) {
    let w = await db.collection(EXW_COL).findOne({ userId });
    if (!w) {
      // 并发时两个请求可能同时 upsert 同一 userId → Mongo 抛 E11000；这里忽略即可，
      // 因为不管谁先创建，结果都是"钱包存在且余额 0"，重读一次就对。
      await db.collection(EXW_COL).updateOne({ userId },
        { $setOnInsert: { userId, balance: 0, frozen: 0, createdAt: new Date() } }, { upsert: true }).catch(() => { });
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
    // 【2026-09-24 性能优化】服务端 $group 求和：原先把该用户全部流水拉进 Node 内存再 reduce，
    // 流水涨到几千条后交易所每次 board/deposit/withdraw 都拖全量文档（传输+内存+CPU 线性涨）。
    // 改为库端聚合，走 wallet_log.userId 索引，只回一个数字
    const r = await db.collection('wallet_log').aggregate([
      { $match: { userId } },
      { $group: { _id: null, sum: { $sum: { $cond: [{ $isNumber: '$amount' }, '$amount', 0] } } } },
    ]).toArray();
    return money2((r[0] && r[0].sum) || 0);
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
  // 【v26.9】灵气价格走势（股票式 K 线简版：只要折线 + 高低点）
  // 数据来自统一成交台账 shanhai_ex_deals，按时间桶做**按成交量加权**的均价
  // （算术均价会让一手小单把曲线拽歪，加权均价才是真实成交重心）
  app.get('/api/shanhai/exchange/chart', auth, exGuard, async (req, res) => {
    try {
      const db = await getDb();
      const range = String((req.query || {}).range || '1d');
      const HOUR = 3600000, DAY = 86400000;
      const now = Date.now();
      let since, bucketMs, label;
      if (range === '1d') { since = now - DAY; bucketMs = HOUR; label = '近 24 小时'; }
      else if (range === '7d') { since = now - 7 * DAY; bucketMs = DAY; label = '近 7 天'; }
      else if (range === '30d') { since = now - 30 * DAY; bucketMs = DAY; label = '近 30 天'; }
      else { since = 0; bucketMs = 30 * DAY; label = '全部（按月）'; }

      // 【2026-09-24 性能优化】原先拉 2 万条成交进 Node 内存做两轮分桶（range=all 时几乎全表），
      // 改为 $facet 在库端同时完成粗/细两套分桶，只把聚合结果（几十个桶）传回来
      const coarseId = { $multiply: [{ $floor: { $divide: [{ $toLong: '$createdAt' }, bucketMs] } }, bucketMs] };
      const fineId = { $multiply: [{ $floor: { $divide: [{ $toLong: '$createdAt' }, range === '1d' || range === '7d' ? 60000 : range === '30d' ? 3600000 : DAY] } }, range === '1d' || range === '7d' ? 60000 : range === '30d' ? 3600000 : DAY] };
      const facet = await db.collection('shanhai_ex_deals').aggregate([
        { $match: since ? { createdAt: { $gte: new Date(since) } } : {} },
        { $facet: {
          coarse: [
            { $group: {
              _id: coarseId,
              q: { $sum: '$amount' }, v: { $sum: '$total' }, n: { $sum: 1 },
              hi: { $max: '$price' }, lo: { $min: '$price' },
            } },
            { $sort: { _id: 1 } },
          ],
          fine: [
            { $sort: { createdAt: 1 } },
            { $group: {
              _id: fineId,
              q: { $sum: '$amount' }, v: { $sum: '$total' },
              hi: { $max: '$price' }, lo: { $min: '$price' },
              first: { $first: '$price' }, last: { $last: '$price' },
            } },
            { $sort: { _id: 1 } },
          ],
          firstDoc: [{ $sort: { createdAt: 1 } }, { $limit: 1 }, { $project: { price: 1, createdAt: 1 } }],
          lastDoc: [{ $sort: { createdAt: -1 } }, { $limit: 1 }, { $project: { price: 1, createdAt: 1 } }],
        } },
      ], { allowDiskUse: true }).toArray();
      const F = facet[0] || {};
      const coarseRows = F.coarse || [], fineRows = F.fine || [];
      const firstDoc = (F.firstDoc || [])[0] || null, lastDoc = (F.lastDoc || [])[0] || null;

      const buckets = new Map();
      for (const r of coarseRows) {
        const b = Math.floor(Number(r._id) || 0);
        buckets.set(b, { q: Number(r.q) || 0, v: Number(r.v) || 0, n: r.n, hi: Number(r.hi) || 0, lo: Number(r.lo) || 0 });
      }
      // 【v26.11 修 24 小时画不出来】原来 startB 从"第一条成交"开始：
      // 若近 1 小时才有成交，24 小时视图就只有 1 个点（甚至点太少画不成线）。
      // 现在固定区间时从 since 起算，保证 24 小时就是 24 个点。
      // 起始价取区间内第一笔成交价，前面没成交的时段沿用它（画成平线，而不是空白）。
      let last = 0;
      const sortedB = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
      for (const [, c] of sortedB) { if (c.q > 0) { last = money4(c.v / c.q); break; } }
      if (!last && lastDoc) last = money4(Number(lastDoc.price) || 0);
      const pts = [];
      const startB = (range === 'all')
        ? (firstDoc ? Math.floor(new Date(firstDoc.createdAt).getTime() / bucketMs) * bucketMs : now)
        : Math.floor(since / bucketMs) * bucketMs;
      for (let b = startB; b <= now; b += bucketMs) {
        const c = buckets.get(b);
        if (c && c.q > 0) {
          const avg = money4(c.v / c.q);
          last = avg;
          pts.push({ t: b, price: avg, vol: c.q, cnt: c.n, hi: money4(c.hi), lo: c.lo === Infinity ? avg : money4(c.lo) });
        } else if (last > 0) {
          pts.push({ t: b, price: last, vol: 0, cnt: 0, hi: last, lo: last });
        }
      }
      const prices = pts.map(p => p.price);
      const first = prices.length ? prices[0] : 0;
      const cur = prices.length ? prices[prices.length - 1] : 0;

      // 【v26.12】K 线：先用**更细的桶**（1d/7d→分钟，30d→小时，all→天）做加权均价，
      // 再把细桶聚合成蜡烛：开盘=桶内第一笔，收盘=最后一笔，高低=区间极值。
      // 这样才能画出股票那种带上下影线的柱子，而不只是一条折线。
      const groupMs = range === '1d' ? 3600000 : range === '7d' ? 4 * 3600000 : range === '30d' ? DAY : 30 * DAY;
      // 细桶已在 $facet 里由库端算好（fineRows 已按时间升序、含 first/last 收开盘价）
      const hourMap = new Map();
      for (const c of fineRows) {
        if (!(c.q > 0)) continue;
        const t = Math.floor(Number(c._id) || 0);
        const p = money4(c.v / c.q);
        const g = Math.floor(t / groupMs) * groupMs;
        const cur = hourMap.get(g) || { t: g, o: c.first, c: p, hi: 0, lo: Infinity, v: 0 };
        cur.c = p;                                                          // 收盘 = 组内最后一笔
        cur.hi = Math.max(cur.hi, c.hi === 0 ? p : c.hi, p);
        cur.lo = Math.min(cur.lo, c.lo === Infinity ? p : c.lo, p);
        cur.v += c.v;
        hourMap.set(g, cur);
      }
      const candleList = [...hourMap.values()].sort((a, b) => a.t - b.t)
        .map(c => ({ t: c.t, o: money4(c.o), c: money4(c.c), hi: money4(c.hi), lo: money4(c.lo), v: money4(c.v) }));
      // 【v26.21 修复】补齐无成交时段的空档蜡烛（开=收=高=低=上一根收盘价，量 0）——
      // 原先 K 线只由"有成交的时段"聚合，稀疏交易时 24h 视图只有零星几根（"看不完整"），
      // 且根数少于缩放下限时 ＋/－ 按钮被钳住"没反应"
      let candles = [];
      if (candleList.length) {
        // 【v26.22 修复】7 天正常、24 小时仍缺根的原因：补根起点用的是"第一根蜡烛"，
        // 而 1d 的第一根从首笔成交算起——首笔在 3 小时前就只补出 4 根。
        // 改为：固定区间（1d/7d/30d）一律从区间起点（since 取整到 group）开始补；"全部"视图仍从首根开始。
        const startT = (range !== 'all' && since) ? Math.floor(since / groupMs) * groupMs : candleList[0].t;
        let prevClose = candleList[0].o;
        for (const c of candleList) { if (c.t < startT) prevClose = c.c; else break; }
        let idx = candleList.findIndex(c => c.t >= startT);
        if (idx < 0) idx = candleList.length;
        for (let t = startT; t <= now && candles.length < 400; t += groupMs) {
          const c = (candleList[idx] && candleList[idx].t === t) ? candleList[idx++] : null;
          if (c) prevClose = c.c;
          candles.push(c || { t, o: prevClose, c: prevClose, hi: prevClose, lo: prevClose, v: 0 });
        }
        candles = candles.slice(-60);
      }

      res.json({
        ok: true, range, label, bucketMs,
        points: pts.slice(-120),                       // 最多留 120 个点，前端画得动
        candles,
        first, cur,
        hi: prices.length ? Math.max(...prices) : 0,
        lo: prices.length ? Math.min(...prices) : 0,
        vol: pts.reduce((s, p) => s + p.vol, 0),
        change: first > 0 ? money4((cur - first) / first * 100) : 0,   // 涨跌幅 %
      });
    } catch (e) {
      console.error('[api] exchange/chart', e);
      res.status(500).json({ ok: false, error: '走势加载失败，请稍后再试' });
    }
  });

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
      // 【2026-09-24 安全修复】整个"读余额→判够→写流水→加交易所余额"放进用户锁：
      // 原先是读-判-写三步裸奔，并发两次转入会把主站余额打成负数（双花真实充值余额）
      await withUserLock('exw:' + me, async () => {
        const bal = await walletBalanceOf(db, me);
        if (bal < amt) throw Object.assign(new Error(`主站余额不足（可用 ¥${bal.toFixed(2)}）`), { statusCode: 400, code: 'NO_BALANCE' });
        await walletLog(db, me, -amt, 'ex_deposit', `转入交易所 ¥${amt.toFixed(2)}`);
        await db.collection(EXW_COL).updateOne(
          { userId: me }, { $inc: { balance: amt }, $set: { updatedAt: new Date() } }, { upsert: true });
        await db.collection('shanhai_logs').insertOne({ userId: me, action: 'ex_deposit', detail: { amount: amt }, createdAt: new Date() }).catch(() => { });
      });
      const w = await exWalletOf(db, me);
      res.json({ ok: true, amount: amt, exBalance: money4(w.balance || 0), exFrozen: money4(w.frozen || 0), balance: await walletBalanceOf(db, me) });
    } catch (e) {
      if (e.statusCode) return res.status(e.statusCode).json({ ok: false, error: e.message, code: e.code });
      console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' });
    }
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
      if (avail < amt) return res.status(400).json({ ok: false, error: `交易所可用余额不足（可用 ¥${avail.toFixed(4)}，挂单冻结中的部分不能转出）`, code: 'NO_EX_BALANCE' });
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
        // 【v26.4】求购单冻结的是「交易所钱包」里的钱（不是主站余额）
        // 【2026-09-24 安全修复】冻结改为 $expr 条件原子更新（可用 = balance - frozen >= orderTotal），
        // 并改为"先冻结、后落单"——原先先插单再无条件 $inc frozen，
        // 并发挂多张买单各自通过陈旧可用额检查，frozen 可累计超发（产生无资金背书的冻结）
        await exWalletOf(db, me);   // 确保钱包文档存在（下面条件更新不带 upsert，避免 $expr 建出不合法文档）
        const fz = await db.collection(EXW_COL).findOneAndUpdate(
          { userId: me, $expr: { $gte: [{ $subtract: [{ $ifNull: ['$balance', 0] }, { $ifNull: ['$frozen', 0] }] }, orderTotal] } },
          { $inc: { frozen: orderTotal }, $set: { updatedAt: new Date() } },
          { returnDocument: 'after' }
        );
        if (!fz || !(fz.value || fz))
          return res.status(400).json({ ok: false, error: `交易所余额不足（需冻结 ¥${orderTotal.toFixed(4)}），请先把主站余额转入交易所`, code: 'NO_EX_BALANCE' });
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
      // 【2026-09-24 修复】冻结已在前一步原子完成；这里落单失败要解冻，
      // 不能让冻结的钱悬空（订单没建出来，钱却冻着）
      try {
        await db.collection('shanhai_exchange').insertOne(doc);
      } catch (e) {
        if (side === 'buy' && orderTotal > 0) {
          await db.collection(EXW_COL).updateOne(
            { userId: me }, { $inc: { frozen: -orderTotal }, $set: { updatedAt: new Date() } }).catch(() => { });
        }
        if (side === 'sell') {
          await db.collection('shanhai_profiles').updateOne(
            { userId: me }, { $inc: { lingqi: n, lingqiFrozen: -n }, $set: { updatedAt: new Date() } }).catch(() => { });
        }
        throw e;
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
    } catch (e) {
      console.error('[api] exchange/publish', e);
      db.collection('shanhai_logs').insertOne({
        userId: req.user && req.user.id, action: 'exchange_error',
        detail: { where: 'publish', msg: String((e && e.message) || e).slice(0, 200) }, createdAt: new Date(),
      }).catch(() => { });
      res.status(500).json({ ok: false, error: '挂单失败，请稍后再试', debug: String((e && e.message) || e).slice(0, 90) });
    }
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
        if (avail < total) return res.status(400).json({ ok: false, error: `交易所余额不足（需 ¥${total.toFixed(4)}，可用 ¥${avail.toFixed(4)}）`, code: 'NO_EX_BALANCE' });
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
      // 【2026-09-24 安全修复】吃单资金流转重写：
      // ① 买家扣款改为 $expr 条件原子更新（可用余额 >= total），根治"预检查与扣款之间"的
      //    TOCTOU——原先无条件 $inc balance:-total，并发吃多张卖单可把钱包扣成负数（等于印钱）；
      // ② 卖家灵气解冻/扣减检查更新结果（原先匹配 0 行也继续走）；
      // ③ 失败回滚不再只还原订单余量——已发生的资金/灵气划转全部逆向回滚，不再账实错乱。
      const sellerId = iAmBuyer ? ord.userId : me;      // 出灵气的一方
      const buyerId = iAmBuyer ? me : ord.userId;       // 出钱的一方
      let step = 'init';
      const undo = [];   // 已完成的划转，按逆序回滚
      const rollback = async () => {
        await col.updateOne({ _id: oid }, { $inc: { left: n }, $set: { updatedAt: new Date() } }).catch(() => { });
        for (const u of undo.reverse()) { try { await u(); } catch (e2) { } }
      };
      try {
        const exw = db.collection(EXW_COL);
        // 1) 资金流转：先扣钱（条件更新，失败即中止，不产生任何副作用）
        step = 'cash';
        if (buyerId === BOT_ID) {
          // 【v26.18】玩家把灵气卖给机器人的求购单：货款从机器人钱包冻结里划走
          // （挂单时已冻结），灵气进做市额度。原先钱只冲减订单 locked、冻结永不释放、
          // 玩家交出的灵气也无处落地 → 双向漏账
          const FUND = 'shanhai_market_fund';
          const r = await exw.findOneAndUpdate(
            { userId: BOT_ID, frozen: { $gte: total } },
            { $inc: { frozen: -total, balance: -total }, $set: { updatedAt: new Date() } });
          if (!r || !(r.value || r)) throw new Error('机器人冻结资金不足');
          undo.push(() => exw.updateOne({ userId: BOT_ID }, { $inc: { frozen: total, balance: total }, $set: { updatedAt: new Date() } }));
          const rl = await col.updateOne({ _id: oid }, { $inc: { locked: -total } });
          if (rl.modifiedCount) undo.push(() => col.updateOne({ _id: oid }, { $inc: { locked: total } }));
          const rf = await db.collection(FUND).updateOne({ _id: 'market' }, { $inc: { lingqi: n }, $set: { updatedAt: new Date() } });
          if (rf.modifiedCount || rf.upsertedCount) {
            undo.push(() => db.collection(FUND).updateOne({ _id: 'market' }, { $inc: { lingqi: -n } }));
          }
        } else if (payerNeedsCash) {
          // 主动买家 / 从未冻结过的老买单：从交易所余额实时扣（可用 = balance - frozen >= total）
          const r = await exw.findOneAndUpdate(
            { userId: buyerId, $expr: { $gte: [{ $subtract: [{ $ifNull: ['$balance', 0] }, { $ifNull: ['$frozen', 0] }] }, total] } },
            { $inc: { balance: -total }, $set: { updatedAt: new Date() } }
          );
          if (!r || !(r.value || r)) throw Object.assign(new Error('买家可用余额不足'), { userCode: 'NO_EX_BALANCE' });
          undo.push(() => exw.updateOne({ userId: buyerId }, { $inc: { balance: total }, $set: { updatedAt: new Date() } }));
        } else if (ord.exLocked) {
          // 新买单（v26.4 起）：钱冻在交易所钱包里 → 同一笔里「解冻」+「扣掉」
          const r = await exw.findOneAndUpdate(
            { userId: buyerId, frozen: { $gte: total } },
            { $inc: { frozen: -total, balance: -total }, $set: { updatedAt: new Date() } }
          );
          if (!r || !(r.value || r)) throw new Error('买单冻结资金不足');
          undo.push(() => exw.updateOne({ userId: buyerId }, { $inc: { frozen: total, balance: total }, $set: { updatedAt: new Date() } }));
          const rl = await col.updateOne({ _id: oid }, { $inc: { locked: -total } });
          if (rl.modifiedCount) undo.push(() => col.updateOne({ _id: oid }, { $inc: { locked: total } }));
        } else {
          // 【v26.4 兼容】v26.4 之前挂的买单：钱当时就从「主站余额」扣走了（在 wallet_log 里），
          // 交易所钱包里根本没有这笔钱。这里只冲减订单冻结额，绝不能再动任何钱包。
          const rl = await col.updateOne({ _id: oid }, { $inc: { locked: -total } });
          if (rl.modifiedCount) undo.push(() => col.updateOne({ _id: oid }, { $inc: { locked: total } }));
        }
        // 2) 灵气流转：卖家 -n（或解冻 -n），条件更新并检查结果
        step = 'lingqi-seller';
        if (sellerId === BOT_ID) {
          // 【v26.18】机器人卖单被玩家吃：灵气在机器人挂单时已从做市额度冻结，
          // 这里只解冻额度（原先去机器人不存在的 shanhai_profiles 扣冻结 → 必然失败，
          // 玩家永远买不了机器人的卖单）
          const FUND = 'shanhai_market_fund';
          const r = await db.collection(FUND).findOneAndUpdate(
            { _id: 'market', lingqiFrozen: { $gte: n } },
            { $inc: { lingqiFrozen: -n }, $set: { updatedAt: new Date() } });
          if (!r || !(r.value || r)) throw new Error('机器人冻结灵气不足');
          undo.push(() => db.collection(FUND).updateOne({ _id: 'market' }, { $inc: { lingqiFrozen: n } }));
        } else if (iAmBuyer) {
          const r = await prof.findOneAndUpdate(
            { userId: sellerId, lingqiFrozen: { $gte: n } },
            { $inc: { lingqiFrozen: -n }, $set: { updatedAt: new Date() } });
          if (!r || !(r.value || r)) throw new Error('卖家冻结灵气不足（可能与撤单并发冲突）');
          undo.push(() => prof.updateOne({ userId: sellerId }, { $inc: { lingqiFrozen: n }, $set: { updatedAt: new Date() } }));
        } else {
          const r = await prof.findOneAndUpdate(
            { userId: sellerId, lingqi: { $gte: n } },
            { $inc: { lingqi: -n }, $set: { updatedAt: new Date() } });
          if (!r || !(r.value || r)) throw new Error('卖家灵气不足');
          undo.push(() => prof.updateOne({ userId: sellerId }, { $inc: { lingqi: n }, $set: { updatedAt: new Date() } }));
        }
        step = 'lingqi-buyer';
        // 买家加灵气。注意：对手是机器人时它没有 shanhai_profiles 档案（额度存在 shanhai_fund），
        // 匹配不到文档属于正常情况，不能因此报错。
        const rb = await prof.updateOne({ userId: buyerId }, { $inc: { lingqi: n }, $set: { updatedAt: new Date() } });
        if (rb && rb.modifiedCount) {
          undo.push(() => prof.updateOne({ userId: buyerId }, { $inc: { lingqi: -n }, $set: { updatedAt: new Date() } }));
        }
        // 3) 卖家收款：货款（已扣手续费）进他的交易所余额（upsert：卖家可能第一次用交易所）
        step = 'pay-seller';
        const rp = await exw.updateOne(
          { userId: sellerId }, { $inc: { balance: sellerGet }, $set: { updatedAt: new Date() } }, { upsert: true });
        if (!(rp && (rp.upsertedCount || rp.modifiedCount || rp.matchedCount))) throw new Error('卖家入账失败');
        undo.push(() => exw.updateOne({ userId: sellerId }, { $inc: { balance: -sellerGet }, $set: { updatedAt: new Date() } }));
        // 【v26.4】手续费只在台账里记一笔（shanghai_ex_deals.fee），不再往主站 wallet_log 塞流水
      } catch (e) {
        await rollback().catch(() => { });
        console.error('[exchange deal] 失败 step=%s', step, e);
        // 把失败步骤一起写进日志表，后台能直接看到（生产不暴露堆栈，只留一句摘要）
        db.collection('shanhai_logs').insertOne({
          userId: me, action: 'exchange_error', detail: { where: 'deal', step, msg: String((e && e.message) || e).slice(0, 200), orderId: String(oid) },
          createdAt: new Date(),
        }).catch(() => { });
        if (e.userCode === 'NO_EX_BALANCE') {
          return res.status(400).json({ ok: false, error: `交易所余额不足（需 ¥${total.toFixed(4)}）`, code: 'NO_EX_BALANCE' });
        }
        return res.status(500).json({ ok: false, error: '交易未完成，已还原，请重试' });
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
      // 【v26.5.2 提速】两条日志并行写（原来串行，白等一个往返）
      await Promise.all([
        db.collection('shanhai_logs').insertOne({
          userId: me, action: 'exchange_deal',
          detail: { orderId: String(oid), side: ord.side, amount: n, price: ord.price, total, with: ord.username },
          createdAt: new Date(),
        }).catch(() => { }),
        // 【v26.2】统一台账：玩家成交与机器人成交都写 shanhai_ex_deals（后台一个面板查全，
        // bot 字段一眼分清是人还是机器人）。名字这里存匿名代号，真实身份后台按 userId 关联查。
        db.collection('shanhai_ex_deals').insertOne({
          orderId: String(oid), side: ord.side, amount: n, price: ord.price, total, fee,
          buyerId, sellerId, bot: false, mode: 'player',
          buyerName: anonName(buyerId), sellerName: anonName(sellerId),
          createdAt: new Date(),
        }).catch(() => { }),
      ]);
      // 【v26.5.1】把成交后的**全部**最新数值一并返回：
      // 前端拿到就能立刻把界面改对，不必等下一次轮询 —— 之前要等 6 秒才刷，
      // 用户会以为"没反应/交易没成功"，甚至关掉页面后才发现钱变了。
      // 【v26.5.2 提速】两个读操作并行；并且**不再返回主站余额** —— 成交不影响它，
      // 而算它要聚合整张 wallet_log 表，是整个接口里最慢的一步。
      const [np, nw] = await Promise.all([
        prof.findOne({ userId: me }),
        exWalletOf(db, me),
      ]);
      res.json({
        ok: true, amount: n, total, fee, side: ord.side, price: ord.price,
        got: iAmBuyer ? total : sellerGet,          // 买入=实付金额；卖出=实收金额（已扣手续费）
        role: iAmBuyer ? 'buy' : 'sell',
        lingqi: np ? (np.lingqi || 0) : 0,
        frozen: np ? (np.lingqiFrozen || 0) : 0,
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
      // 【2026-09-24 安全修复】先原子翻状态（open→cancel）、再按翻状态前返回的文档退款。
      // 原先"先按读到的 left/locked 退款、后置状态"，与吃单并发时按旧余量全额退款，
      // 可造成双重退款（灵气/资金凭空多出来）或冻结额被打负。
      const o = await col.findOneAndUpdate(
        { _id: oid, userId: me, status: 'open' },
        { $set: { status: 'cancel', updatedAt: new Date() } },
        { returnDocument: 'before' }
      );
      const od = o && (o.value || o);
      if (!od) return res.status(404).json({ ok: false, error: '挂单不存在或已结束' });
      // 卖单把未成交部分的冻结灵气退回
      if (od.side === 'sell' && od.left > 0) {
        await db.collection('shanhai_profiles').updateOne(
          { userId: me },
          { $inc: { lingqi: od.left, lingqiFrozen: -od.left }, $set: { updatedAt: new Date() } });
      } else if (od.side === 'buy' && (od.locked || 0) > 0) {
        if (od.exLocked) {
          // 新单：解冻交易所钱包里被冻住的那部分（钱仍留在交易所，不回主站）
          await db.collection(EXW_COL).updateOne(
            { userId: me }, { $inc: { frozen: -od.locked }, $set: { updatedAt: new Date() } });
        } else {
          // 【v26.4 兼容】老单：钱当初是从主站余额扣的 → 退回主站，否则玩家的钱就凭空没了
          await walletLog(db, me, od.locked, 'exchange_unlock', `求购单撤单退回 ¥${od.locked.toFixed(2)}`, String(oid));
        }
      }
      await col.updateOne({ _id: oid }, { $set: { left: 0, locked: 0, updatedAt: new Date() } });
      const np = await db.collection('shanhai_profiles').findOne({ userId: me });
      await db.collection('shanhai_logs').insertOne({ userId: me, action: 'exchange_cancel', detail: { orderId: String(oid), side: od.side, left: od.left }, createdAt: new Date() }).catch(() => {});
      // 【v26.5.1】撤单后的最新数值一起回，前端立刻更新冻结与余额
      const nwc = await exWalletOf(db, me);
      res.json({
        ok: true, side: od.side, backAmount: od.side === 'sell' ? od.left : (od.locked || 0),
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
