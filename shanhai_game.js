// shanhai_game.js — 山海斩妖录（割草）游戏模块
// 挂载方式（server.js 末尾）：require('./shanhai_game')(app, { auth, getDb });
// 设计原则（与 games.js 一致）：
//   1) 战绩合理性校验在服务端完成，客户端上报的数值不可信
//   2) 档案更新走 findOneAndUpdate + $inc/$max 原子操作，并发刷不掉
//   3) 独立集合 shanhai_profiles，不污染其他游戏数据

module.exports = function mountShanhaiGame(app, { auth, getDb }) {

  // ==================== 反作弊阈值（M1 第一关口径） ====================
  const LIMITS = {
    maxTimeSec: 7200,        // 单局时长上限 2h
    maxKillsPerMin: 120,     // 击杀/分钟上限（第一关波次密度 < 60）
    maxLevel: 40,            // 第一关经验总量对应等级上限
    winMinTimeSec: 60,       // 通关最短合理用时（15波+Boss < 1min 不可能）
  };

  // ==================== 档案 ====================
  app.get('/api/shanhai/profile', auth, async (req, res) => {
    try {
      const db = await getDb();
      let p = await db.collection('shanhai_profiles').findOne({ userId: req.user.id });
      if (!p) {
        const doc = {
          userId: req.user.id,
          username: req.user.displayName || req.user.username,
          plays: 0, wins: 0, bestTimeSec: null, bestKills: 0,
          totalKills: 0, maxLevel: 0, updatedAt: new Date(),
        };
        await db.collection('shanhai_profiles').updateOne(
          { userId: req.user.id }, { $setOnInsert: doc }, { upsert: true });
        p = doc;
      }
      res.json({ ok: true, profile: p });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ==================== 战绩上报 ====================
  app.post('/api/shanhai/result', auth, async (req, res) => {
    try {
      const { win, timeSec, kills, level, dmgTaken } = req.body || {};
      const t = Math.floor(Number(timeSec) || 0);
      const k = Math.floor(Number(kills) || 0);
      const lv = Math.floor(Number(level) || 1);
      const isWin = !!win;
      if (t < 0 || t > LIMITS.maxTimeSec) return res.status(400).json({ ok: false, error: '时长异常' });
      if (k < 0 || lv < 1 || lv > LIMITS.maxLevel) return res.status(400).json({ ok: false, error: '数值异常' });
      const minutes = Math.max(1, t / 60);
      if (k / minutes > LIMITS.maxKillsPerMin) return res.status(400).json({ ok: false, error: '击杀密度异常' });
      if (isWin && t < LIMITS.winMinTimeSec) return res.status(400).json({ ok: false, error: '通关用时异常' });

      const db = await getDb();
      const uname = req.user.displayName || req.user.username;
      const update = {
        $set: { username: uname, updatedAt: new Date() },
        $inc: { plays: 1, totalKills: k },
        $max: { bestKills: k, maxLevel: lv },
      };
      if (isWin) {
        update.$inc.wins = 1;
        const cur = await db.collection('shanhai_profiles').findOne({ userId: req.user.id });
        if (!cur || cur.bestTimeSec == null || t < cur.bestTimeSec) update.$set.bestTimeSec = t;
      }

      const r = await db.collection('shanhai_profiles').findOneAndUpdate(
        { userId: req.user.id }, update,
        { upsert: true, returnDocument: 'after' });
      res.json({ ok: true, profile: r.value || r });
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

  console.log('[shanhai_game] 山海斩妖录模块已挂载：/api/shanhai/*');
};
