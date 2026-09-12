// games.js — 魔法翻翻乐限时活动模块
// 挂载方式（server.js 末尾）：require('./games')(app, { auth, getDb, cnDayStr });
// 设计原则：
//   1) 所有概率/结算全部在服务端完成，前端只做展示——抓包改请求拿不到任何好处
//   2) 所有资产变动（钥匙/球/碎片/复活石/福袋）均走原子操作（findOneAndUpdate + 条件过滤），
//      并发请求刷不掉道具
//   3) 每个用户同时只能有一局进行中（partial unique index 强制）
//   4) 关键动作写 game_logs 审计流水

module.exports = function mountGames(app, { auth, getDb, cnDayStr }) {

  // ==================== 活动配置（运营改这里即可） ====================
  const ACTIVITY = {
    name: '魔法翻翻乐',
    start: '2026-09-12', end: '2026-10-31',
    maxRevivesPerGame: 2,          // 每局复活上限
    sessionTimeoutMs: 2 * 3600 * 1000, // 对局超时自动弃局（防占位）
    dailyFreeKey: 1,               // 每日免费钥匙数量
    composeFragCost: 30,           // 合成1个魔法球所需碎片
  };

  // 概率表：escape=逃跑率；reward=[类型, 数量, 概率%]（每张表合计恒等于100%）
  // 类型：frag=魔法球碎片 key=魔法钥匙 ball=魔法球 bagS/M/L=福袋小/中/大
  const PROB = {
    wave1: { escape: 30, reward: [['frag', 1, 50], ['key', 1, 5], ['ball', 1, 0.5], ['bagS', 1, 14.5]] },
    wave2: { escape: 30, reward: [['frag', 5, 50], ['key', 3, 10], ['ball', 1, 1], ['bagM', 1, 9]] },
    wave3: [ // 第三波逐轮递增（第1~5轮）
      { escape: 10, reward: [['ball', 2, 50], ['key', 10, 20], ['bagL', 1, 15], ['ball', 4, 5]] },
      { escape: 20, reward: [['ball', 2, 40], ['key', 10, 20], ['bagL', 1, 15], ['ball', 4, 5]] },
      { escape: 30, reward: [['ball', 4, 40], ['key', 10, 15], ['bagL', 1, 10], ['ball', 8, 5]] },
      { escape: 40, reward: [['ball', 6, 35], ['key', 15, 12], ['bagL', 1, 8], ['ball', 10, 5]] },
      { escape: 50, reward: [['ball', 8, 30], ['key', 20, 10], ['bagL', 1, 8], ['ball', 15, 2]] },
    ],
  };

  // 福袋现金区间（元），运营可调整
  const BAG_RANGE = { bagS: [0.30, 0.88], bagM: [1.68, 8.88], bagL: [18.88, 88.88] };

  // 商铺：enabled=false 的为"可填充兑换商品位"，运营在数据库/此处补充
  const SHOP = [
    { id: 'frag10',   name: '魔法球碎片×10',  icon: 'frag',   cost: 3,  give: { frags: 10 },   limit: 0, enabled: true },
    { id: 'key1',     name: '魔法钥匙×1',     icon: 'key',    cost: 5,  give: { keys: 1 },     limit: 0, enabled: true },
    { id: 'keys5',    name: '魔法钥匙×5',     icon: 'key',    cost: 20, give: { keys: 5 },      limit: 0, enabled: true },
    { id: 'revive1',  name: '复活石×1',       icon: 'revive', cost: 15, give: { revives: 1 },   limit: 0, enabled: true },
    { id: 'bagM',     name: '现金福袋（中）', icon: 'bagM',   cost: 25, give: { bagM: 1 },      limit: 0, enabled: true },
    { id: 'slot5',    name: '敬请期待',       icon: 'ball',   cost: 0,  give: {},               limit: 0, enabled: false },
    { id: 'slot6',    name: '敬请期待',       icon: 'ball',   cost: 0,  give: {},               limit: 0, enabled: false },
  ];

  const ITEM_NAMES = { frag: '魔法球碎片', key: '魔法钥匙', ball: '魔法球', bagS: '现金福袋(小)', bagM: '现金福袋(中)', bagL: '现金福袋(大)' };

  // ==================== 工具 ====================
  const rnd2 = (n) => Math.round(n * 100) / 100;
  const nowDay = () => cnDayStr(new Date());
  const inActivity = () => { const t = nowDay(); return t >= ACTIVITY.start && t <= ACTIVITY.end; };
  const r2 = (s) => (s || '').toString();

  async function getProfile(db, userId) {
    let p = await db.collection('game_profiles').findOne({ userId });
    if (!p) {
      p = { userId, keys: 0, balls: 0, frags: 0, revives: 0, bagS: 0, bagM: 0, bagL: 0, lastDailyKey: '', totalGames: 0, createdAt: new Date(), updatedAt: new Date() };
      try { await db.collection('game_profiles').insertOne(p); }
      catch (e) { if (e.code !== 11000) throw e; p = await db.collection('game_profiles').findOne({ userId }); }
    }
    return p;
  }

  async function getActiveSession(db, userId) {
    // playing=进行中，wave_done=波次完成待抉择（关闭页面后回来要能续上）
    const s = await db.collection('game_sessions').findOne({ userId, status: { $in: ['playing', 'wave_done'] } });
    if (!s) return null;
    // 弃局判定：超时未操作的进行中对局自动作废（奖励没收，符合活动规则）
    if (Date.now() - new Date(s.updatedAt).getTime() > ACTIVITY.sessionTimeoutMs) {
      await db.collection('game_sessions').updateOne({ _id: s._id }, { $set: { status: 'timeout', endedAt: new Date() } });
      await log(db, userId, 'timeout', { wave: s.wave, round: s.round });
      return null;
    }
    return s;
  }

  async function log(db, userId, action, detail) {
    try { await db.collection('game_logs').insertOne({ userId, action, detail: detail || {}, createdAt: new Date() }); } catch (e) {}
  }

  // 掷一次当前轮：返回 {escaped, reward, table}
  function rollOnce(wave, round) {
    const table = wave === 3 ? PROB.wave3[round - 1] : (wave === 1 ? PROB.wave1 : PROB.wave2);
    const x = Math.random() * 100;
    if (x < table.escape) return { escaped: true, table };
    let acc = table.escape, rest = x - table.escape;
    for (const [type, n, p] of table.reward) {
      acc += p;
      if (rest < acc) return { escaped: false, reward: { type, n }, table };
    }
    // 浮点兜底：理论上到不了这里
    const last = table.reward[table.reward.length - 1];
    return { escaped: false, reward: { type: last[0], n: last[1] }, table };
  }

  function tablePublic(wave, round) {
    const t = wave === 3 ? PROB.wave3[round - 1] : (wave === 1 ? PROB.wave1 : PROB.wave2);
    return { escape: t.escape, reward: t.reward.map(([type, n, p]) => ({ type, n, p })) };
  }

  // 结算：把暂存奖励写入背包（原子 $inc）
  async function settlePot(db, userId, pot) {
    const inc = {};
    // 背包字段是复数（frags/keys/balls），暂存 pot 字段是单数（frag/key/ball）
    for (const [potKey, invKey] of [['frag', 'frags'], ['key', 'keys'], ['ball', 'balls'], ['bagS', 'bagS'], ['bagM', 'bagM'], ['bagL', 'bagL']]) {
      const v = pot[potKey] || 0;
      if (v > 0) inc[invKey] = v;
    }
    if (Object.keys(inc).length) {
      await db.collection('game_profiles').updateOne({ userId }, { $inc: inc, $set: { updatedAt: new Date() } });
    }
    return inc;
  }

  const bad = (res, code, msg) => res.status(code).json({ ok: false, error: msg });
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } };

  // ==================== 接口 ====================

  // 综合状态：背包 + 每日钥匙 + 进行中对局 + 商铺
  app.get('/api/game/state', auth, wrap(async (req, res) => {
    const db = await getDb();
    // 检查维护状态
    const cfg = await db.collection('config').findOne({ key: 'game_maintenance' });
    const maintenance = cfg ? cfg.value : false;
    if (maintenance) return res.json({ ok: true, maintenance: true, activity: { name: ACTIVITY.name } });
    const p = await getProfile(db, req.user.id);
    const session = await getActiveSession(db, req.user.id);
    const today = nowDay();
    res.json({
      ok: true, maintenance: false,
      activity: { name: ACTIVITY.name, start: ACTIVITY.start, end: ACTIVITY.end, active: inActivity(), composeFragCost: ACTIVITY.composeFragCost },
      bag: { keys: p.keys, balls: p.balls, frags: p.frags, revives: p.revives, bagS: p.bagS, bagM: p.bagM, bagL: p.bagL },
      dailyClaimed: p.lastDailyKey === today,
      session: session ? { wave: session.wave, round: session.round, pot: session.pot, revivesUsed: session.revivesUsed, waveDone: session.status === 'wave_done', table: tablePublic(session.wave, session.round) } : null,
      shop: SHOP.map(s => ({ id: s.id, name: s.name, icon: s.icon, cost: s.cost, desc: s.desc || '', enabled: s.enabled })),
    });
  }));

  // 每日免费钥匙（原子：lastDailyKey 条件更新）
  app.post('/api/game/daily', auth, wrap(async (req, res) => {
    const db = await getDb();
    if (!inActivity()) return bad(res, 400, '活动未开始或已结束');
    await getProfile(db, req.user.id);
    const today = nowDay();
    const r = await db.collection('game_profiles').findOneAndUpdate(
      { userId: req.user.id, lastDailyKey: { $ne: today } },
      { $set: { lastDailyKey: today, updatedAt: new Date() }, $inc: { keys: ACTIVITY.dailyFreeKey } },
      { returnDocument: 'after' }
    );
    if (!r) return bad(res, 400, '今天已经领过免费钥匙啦');
    await log(db, req.user.id, 'daily_key', { date: today });
    res.json({ ok: true, keys: r.keys });
  }));

  // 开局：扣1把钥匙，创建对局（每局限一局由 partial unique index 强制）
  app.post('/api/game/start', auth, wrap(async (req, res) => {
    const db = await getDb();
    if (!inActivity()) return bad(res, 400, '活动未开始或已结束');
    await getActiveSession(db, req.user.id); // 顺手清理超时弃局
    // 原子扣钥匙
    const p = await db.collection('game_profiles').findOneAndUpdate(
      { userId: req.user.id, keys: { $gt: 0 } },
      { $inc: { keys: -1, totalGames: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!p) return bad(res, 400, '魔法钥匙不足，去任务区领取每日免费钥匙吧');
    const pot = { frag: 0, key: 0, ball: 0, bagS: 0, bagM: 0, bagL: 0 };
    const doc = { userId: req.user.id, status: 'playing', wave: 1, round: 1, pot, revivesUsed: 0, pendingEscape: false, createdAt: new Date(), updatedAt: new Date() };
    try {
      const s = await db.collection('game_sessions').insertOne(doc);
      await log(db, req.user.id, 'start', { sessionId: s.insertedId });
      res.json({ ok: true, session: { wave: 1, round: 1, pot, revivesUsed: 0, waveDone: false, table: tablePublic(1, 1) }, keys: p.keys });
    } catch (e) {
      // 并发开局撞唯一索引 → 退回钥匙
      await db.collection('game_profiles').updateOne({ userId: req.user.id }, { $inc: { keys: 1, totalGames: -1 } });
      if (e.code === 11000) return bad(res, 400, '你有一局还在进行中');
      throw e;
    }
  }));

  // 翻牌：服务端掷骰结算
  app.post('/api/game/flip', auth, wrap(async (req, res) => {
    const db = await getDb();
    const s = await getActiveSession(db, req.user.id);
    if (!s) return bad(res, 400, '没有进行中的对局');
    if (s.status === 'wave_done') return bad(res, 400, '本波已完成，请先选择：落袋或继续');
    if (s.pendingEscape) return bad(res, 400, '请先处理奖励逃跑（复活或放弃）');

    const { escaped, reward } = rollOnce(s.wave, s.round);

    if (escaped) {
      const pro = await getProfile(db, req.user.id);
      const canRevive = pro.revives > 0 && s.revivesUsed < ACTIVITY.maxRevivesPerGame;
      await db.collection('game_sessions').updateOne({ _id: s._id }, { $set: { pendingEscape: true, updatedAt: new Date() } });
      await log(db, req.user.id, 'escape', { wave: s.wave, round: s.round });
      return res.json({ ok: true, escaped: true, canRevive, revivesLeft: pro.revives, reviveQuotaLeft: ACTIVITY.maxRevivesPerGame - s.revivesUsed, lostPot: canRevive ? null : s.pot });
    }

    // 命中奖励 → 计入暂存
    const pot = Object.assign({}, s.pot); pot[reward.type] += reward.n;
    let waveDone = false, finished = false, settled = null;
    let upd;
    if (s.round >= 5) {
      if (s.wave >= 3) {
        // 第三波第5轮 → 自动结算（全游戏终局）
        settled = await settlePot(db, req.user.id, pot);
        upd = { $set: { pot, status: 'done', endedAt: new Date(), updatedAt: new Date() } };
        finished = true;
      } else {
        upd = { $set: { pot, status: 'wave_done', updatedAt: new Date() } };
        waveDone = true;
      }
    } else {
      upd = { $set: { pot, round: s.round + 1, updatedAt: new Date() } };
    }
    await db.collection('game_sessions').updateOne({ _id: s._id }, upd);
    await log(db, req.user.id, 'reward', { wave: s.wave, round: s.round, got: reward });
    const nextRound = waveDone ? s.round : s.round + 1;
    res.json({
      ok: true, escaped: false, got: reward, pot, waveDone, finished,
      session: { wave: s.wave, round: nextRound, pot, status: finished ? 'done' : (waveDone ? 'wave_done' : 'playing'), revivesUsed: s.revivesUsed },
      settled: settled || null,
      nextTable: finished ? null : (waveDone ? null : tablePublic(s.wave, nextRound)),
    });
  }));

  // 复活：消耗1颗复活石，本轮重翻
  app.post('/api/game/revive', auth, wrap(async (req, res) => {
    const db = await getDb();
    const s = await getActiveSession(db, req.user.id);
    if (!s || !s.pendingEscape) return bad(res, 400, '当前不需要复活');
    if (s.revivesUsed >= ACTIVITY.maxRevivesPerGame) return bad(res, 400, '本局复活次数已用完');
    // 原子扣复活石
    const p = await db.collection('game_profiles').findOneAndUpdate(
      { userId: req.user.id, revives: { $gt: 0 } },
      { $inc: { revives: -1 }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!p) return bad(res, 400, '复活石不足');
    const u = await db.collection('game_sessions').findOneAndUpdate(
      { _id: s._id, status: 'playing', pendingEscape: true },
      { $set: { pendingEscape: false, updatedAt: new Date() }, $inc: { revivesUsed: 1 } },
      { returnDocument: 'after' }
    );
    if (!u) { // 极端并发：对局已变 → 退还复活石
      await db.collection('game_profiles').updateOne({ userId: req.user.id }, { $inc: { revives: 1 } });
      return bad(res, 400, '复活失败，请重试');
    }
    await log(db, req.user.id, 'revive', { wave: s.wave, round: s.round });
    res.json({ ok: true, revives: p.revives, revivesUsed: u.revivesUsed });
  }));

  // 放弃（逃跑后不用复活）：本局奖励全部没收
  app.post('/api/game/giveup', auth, wrap(async (req, res) => {
    const db = await getDb();
    const s = await getActiveSession(db, req.user.id);
    if (!s) return bad(res, 400, '没有进行中的对局');
    await db.collection('game_sessions').updateOne({ _id: s._id }, { $set: { status: 'forfeit', endedAt: new Date(), updatedAt: new Date() } });
    await log(db, req.user.id, 'forfeit', { wave: s.wave, round: s.round, lost: s.pot });
    res.json({ ok: true, lostPot: s.pot });
  }));

  // 波间抉择：cashout=落袋为安（结算背包，本局结束）；continue=携带进入下一波
  app.post('/api/game/decide', auth, wrap(async (req, res) => {
    const db = await getDb();
    const action = req.body && req.body.action;
    const s = await getActiveSession(db, req.user.id);
    if (!s || s.status !== 'wave_done') return bad(res, 400, '当前没有可抉择的对局');
    if (action === 'cashout') {
      const settled = await settlePot(db, req.user.id, s.pot);
      await db.collection('game_sessions').updateOne({ _id: s._id }, { $set: { status: 'done', endedAt: new Date(), updatedAt: new Date() } });
      await log(db, req.user.id, 'cashout', { wave: s.wave, got: s.pot });
      return res.json({ ok: true, action, settled });
    }
    if (action === 'continue') {
      await db.collection('game_sessions').updateOne({ _id: s._id }, { $set: { status: 'playing', wave: s.wave + 1, round: 1, updatedAt: new Date() } });
      await log(db, req.user.id, 'carry', { fromWave: s.wave });
      return res.json({ ok: true, action, wave: s.wave + 1, round: 1, pot: s.pot, table: tablePublic(s.wave + 1, 1) });
    }
    bad(res, 400, '无效操作');
  }));

  // 碎片合成：30碎片 → 1魔法球（原子）
  app.post('/api/game/compose', auth, wrap(async (req, res) => {
    const db = await getDb();
    const p = await db.collection('game_profiles').findOneAndUpdate(
      { userId: req.user.id, frags: { $gte: ACTIVITY.composeFragCost } },
      { $inc: { frags: -ACTIVITY.composeFragCost, balls: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!p) return bad(res, 400, `碎片不足，合成1个魔法球需要${ACTIVITY.composeFragCost}个碎片`);
    await log(db, req.user.id, 'compose', {});
    res.json({ ok: true, balls: p.balls, frags: p.frags });
  }));

  // 拆福袋：随机现金入钱包流水
  app.post('/api/game/bag/open', auth, wrap(async (req, res) => {
    const db = await getDb();
    const size = r2(req.body && req.body.size);
    if (!BAG_RANGE[size]) return bad(res, 400, '无效的福袋类型');
    const field = { bagS: 'bagS', bagM: 'bagM', bagL: 'bagL' }[size];
    const p = await db.collection('game_profiles').findOneAndUpdate(
      { userId: req.user.id, [field]: { $gt: 0 } },
      { $inc: { [field]: -1 }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!p) return bad(res, 400, '没有可拆的该档福袋');
    const [lo, hi] = BAG_RANGE[size];
    const amount = rnd2(lo + Math.random() * (hi - lo));
    await db.collection('wallet_log').insertOne({ userId: req.user.id, month: cnDayStr(new Date()).slice(0, 7), amount, note: '魔法翻翻乐-福袋奖励(' + ITEM_NAMES[size] + ')', createdAt: new Date() });
    await log(db, req.user.id, 'bag_open', { size, amount });
    res.json({ ok: true, size, amount, left: p[field] });
  }));

  // 商铺兑换（原子扣球 + 发货）
  app.post('/api/game/shop/buy', auth, wrap(async (req, res) => {
    const db = await getDb();
    const id = r2(req.body && req.body.id);
    const item = SHOP.find(s => s.id === id);
    if (!item || !item.enabled) return bad(res, 400, '商品不存在或未开放');
    const giveInc = {};
    for (const [k, v] of Object.entries(item.give || {})) if (v > 0) giveInc[k] = v;
    if (!Object.keys(giveInc).length) return bad(res, 400, '该商品位暂未配置奖励');
    const giveStr = Object.keys(giveInc).join(',');
    const p = await db.collection('game_profiles').findOneAndUpdate(
      { userId: req.user.id, balls: { $gte: item.cost } },
      { $inc: Object.assign({ balls: -item.cost }, giveInc), $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!p) return bad(res, 400, '魔法球不足');
    await db.collection('game_redeems').insertOne({ userId: req.user.id, itemId: item.id, name: item.name, cost: item.cost, give: giveInc, createdAt: new Date() });
    await log(db, req.user.id, 'shop_buy', { itemId: item.id, cost: item.cost });
    res.json({ ok: true, name: item.name, balls: p.balls });
  }));

  console.log('[游戏] 魔法翻翻乐接口注册完成：/api/game/*');
};
