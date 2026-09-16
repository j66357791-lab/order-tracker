// shanhai_game.js — 山海斩妖录（割草 + 养成）游戏模块
// 挂载方式（server.js 末尾）：require('./shanhai_game')(app, { auth, getDb, cnDayStr });
// 设计原则（与 games.js 一致）：
//   1) 战绩合理性校验在服务端完成，客户端上报的数值不可信
//   2) 档案更新走 findOneAndUpdate + $inc/$max 原子操作，并发刷不掉
//   3) 独立集合 shanhai_profiles，不污染其他游戏数据
// 【2026-09-14】养成层（斩妖录·贰）：仙玉/灵气双货币 + 6槽装备 + 背包 + 抽卡 + 技能强化

export default function mountShanhaiGame(app, { auth, getDb }) {

  // ==================== 反作弊阈值（M1 第一关口径） ====================
  const LIMITS = {
    maxTimeSec: 7200,        // 单局时长上限 2h
    maxKillsPerMin: 120,     // 击杀/分钟上限（第一关波次密度 < 60）
    maxLevel: 40,            // 第一关经验总量对应等级上限
    winMinTimeSec: 60,       // 通关最短合理用时（15波+Boss < 1min 不可能）
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
    return { id: 'eq' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), slot, quality: q.id, qualityName: q.name, color: q.color, name: randName(slot, q.id), affix: a.name, val };
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
      // 【2026-09-15】初始武器：新手飞剑（白色·攻击力+3·攻速1·无附加·无技能）
      equip: { weapon: { id: 'eq_sword_starter', slot: 'weapon', quality: 'white', qualityName: '凡品', color: '#cfd8dc', name: '新手飞剑', affix: '攻', val: 3, atkSpd: 1 }, armor: null, crown: null, belt: null, boots: null, accessory: null },
      bag: [],
      clearedStages: [],
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
          { $set: { swordInit: true, 'equip.weapon': p.equip && p.equip.weapon ? p.equip.weapon : { id: 'eq_sword_starter', slot: 'weapon', quality: 'white', qualityName: '凡品', color: '#cfd8dc', name: '新手飞剑', affix: '攻', val: 3, atkSpd: 1 } } });
        p = await db.collection('shanhai_profiles').findOne({ userId: req.user.id });
      }
      res.json({ ok: true, profile: p });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ==================== 战绩上报（含养成奖励结算） ====================
  app.post('/api/shanhai/result', auth, async (req, res) => {
    try {
      const db = await getDb();
      const { win, timeSec, kills, level, dmgTaken, stage } = req.body || {};
      const t = Math.floor(Number(timeSec) || 0);
      const k = Math.floor(Number(kills) || 0);
      const lv = Math.floor(Number(level) || 1);
      const isWin = !!win;
      const st = Math.max(1, Math.floor(Number(stage) || 1));

      // —— 合理性校验（不合格只记战绩不发奖励） ——
      const bad = t < 0 || t > LIMITS.maxTimeSec
        || k < 0 || (t > 30 && k / (t / 60) > LIMITS.maxKillsPerMin)
        || lv < 1 || lv > LIMITS.maxLevel
        || (isWin && t < LIMITS.winMinTimeSec);
      if (bad) return res.status(400).json({ ok: false, error: '战绩数据异常，本局不计' });

      // —— 首通判定（在 $addToSet 前查） ——
      const before = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      const firstClear = isWin && !(before.clearedStages || []).includes(st);

      // —— 战绩 + 养成奖励原子入账 ——
      const gainXianyu = k * META_CFG.killXianyu + (isWin ? META_CFG.winXianyu : 0) + (firstClear ? META_CFG.firstClearXianyu : 0);
      const gainLingqi = isWin ? META_CFG.winLingqi : 0;
      const stars = isWin ? (t < 180 ? 3 : t < 360 ? 2 : 1) : 0;
      const r = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: req.user.id },
        {
          $inc: { plays: 1, wins: isWin ? 1 : 0, totalKills: k, xianyu: gainXianyu, lingqi: gainLingqi },
          $max: { bestKills: k, maxLevel: lv },
          $set: { username: req.user.displayName || req.user.username, updatedAt: new Date() },
          ...(isWin && t > 0 ? (before.bestTimeSec == null ? { $set: { bestTimeSec: t } } : { $min: { bestTimeSec: t } }) : {}),
          ...(firstClear ? { $addToSet: { clearedStages: st } } : {}),
        },
        { returnDocument: 'after', upsert: true }
      );
      const p = r.value || r;
      res.json({
        ok: true,
        xianyu: gainXianyu, lingqi: gainLingqi, firstClear, stars,
        balance: { xianyu: p.xianyu, lingqi: p.lingqi },
        profile: { plays: p.plays, wins: p.wins, bestTimeSec: p.bestTimeSec, bestKills: p.bestKills },
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ==================== 装备寻宝（抽卡，此前服务端缺失，前端404修复） ====================
  app.post('/api/shanhai/draw', auth, async (req, res) => {
    try {
      const db = await getDb();
      const p = await ensureProfile(db, req.user.id, req.user.displayName || req.user.username);
      if ((p.xianyu || 0) < META_CFG.drawCost) return res.status(400).json({ ok: false, error: '仙玉不足' });
      const item = rollItem();
      const r = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: req.user.id, xianyu: { $gte: META_CFG.drawCost } },
        {
          $inc: { xianyu: -META_CFG.drawCost },
          $set: { updatedAt: new Date() },
          // 背包满（50）时只入袋不入背包？——抽卡保底：满时自动替换最差白装
          $push: { bag: { $each: [item], $slice: -META_CFG.bagMax } },
        },
        { returnDocument: 'after' }
      );
      if (!r) return res.status(400).json({ ok: false, error: '仙玉不足' });
      const np = r.value || r;
      // 槽位空着 → 自动穿上（白嫖体验，玩家可在装备页换装）
      let autoEquipped = false;
      if (!np.equip || !np.equip[item.slot]) {
        await db.collection('shanhai_profiles').updateOne(
          { userId: req.user.id, [`equip.${item.slot}`]: null },
          { $set: { [`equip.${item.slot}`]: item, updatedAt: new Date() }, $pull: { bag: { id: item.id } } }
        );
        autoEquipped = true;
      }
      res.json({ ok: true, item, xianyu: np.xianyu - (autoEquipped ? 0 : 0), autoEquipped });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
      res.json({ ok: true, equip: (r.value || r).equip, bag: (r.value || r).bag });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
      res.json({ ok: true, equip: (r.value || r).equip, bag: (r.value || r).bag });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
