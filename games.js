// games.js — 魔法翻翻乐限时活动模块
// 挂载方式（server.js 末尾）：require('./games')(app, { auth, getDb, cnDayStr });
// 设计原则：
//   1) 所有概率/结算全部在服务端完成，前端只做展示——抓包改请求拿不到任何好处
//   2) 所有资产变动（钥匙/球/碎片/复活石/福袋）均走原子操作（findOneAndUpdate + 条件过滤），
//      并发请求刷不掉道具
//   3) 每个用户同时只能有一局进行中（partial unique index 强制）
//   4) 关键动作写 game_logs 审计流水
// 【2026-09-17 安全修复】翻牌/抉择结算加乐观锁（条件更新），并发重复请求不再重复入账
import { limit } from './lib/ratelimit.js';

export default function mountGames(app, { auth, getDb, cnDayStr }) {

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
  // 【v22.0】改为 let：管理后台可整体覆盖（config.game_config.prob），代码内这份只是默认值
  let PROB = {
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

  // 商铺：enabled=false 的为"可填充兑换商品位"
  // 【v22.0】改为 let：管理后台可增删改（config.game_config.shop），代码内这份只是默认值
  let SHOP = [
    { id: 'frag10',   name: '魔法球碎片×10',  icon: 'frag',   cost: 3,  give: { frags: 10 },   limit: 0, enabled: true },
    { id: 'key1',     name: '魔法钥匙×1',     icon: 'key',    cost: 5,  give: { keys: 1 },     limit: 0, enabled: true },
    { id: 'keys5',    name: '魔法钥匙×5',     icon: 'key',    cost: 20, give: { keys: 5 },      limit: 0, enabled: true },
    { id: 'revive1',  name: '复活石×1',       icon: 'revive', cost: 15, give: { revives: 1 },   limit: 0, enabled: true },
    { id: 'bagM',     name: '现金福袋（中）', icon: 'bagM',   cost: 25, give: { bagM: 1 },      limit: 0, enabled: true },
    { id: 'slot5',    name: '敬请期待',       icon: 'ball',   cost: 0,  give: {},               limit: 0, enabled: false },
    { id: 'slot6',    name: '敬请期待',       icon: 'ball',   cost: 0,  give: {},               limit: 0, enabled: false },
  ];

  // 【v22.0】任务专区：原先是前端写死的，现在后台可增删改排序（config.game_config.tasks）
  // action: daily=每日领取(走 /api/game/daily) | link=跳转 | play=去翻牌 | info=纯展示
  let TASKS = [
    { id: 'daily',  title: '每日登录',       desc: '每天可免费领取 1 把魔法钥匙',      reward: '钥匙×1',   action: 'daily', link: '', enabled: true },
    { id: 'play',   title: '完成一局翻牌',   desc: '消耗 1 把钥匙开一局，三波翻完',     reward: '碎片若干', action: 'play',  link: '', enabled: true },
    { id: 'invite', title: '邀请好友注册',   desc: '邀请好友注册写手端并完成首单',      reward: '魔法球×1', action: 'link',  link: '/writer.html?tab=invite', enabled: true },
    { id: 'bag',    title: '拆开一个福袋',   desc: '翻牌赢取福袋后到「拆福袋」开启',     reward: '现金红包', action: 'bags',  link: '', enabled: true },
  ];

  const ITEM_NAMES = { frag: '魔法球碎片', key: '魔法钥匙', ball: '魔法球', bagS: '现金福袋(小)', bagM: '现金福袋(中)', bagL: '现金福袋(大)' };

  // ==================== 【v22.0】覆盖项校验/归一化 ====================
  const ITEM_KEYS = Object.keys(ITEM_NAMES);   // frag/key/ball/bagS/bagM/bagL
  const INV_KEYS = ['frags', 'keys', 'balls', 'revives', 'bagS', 'bagM', 'bagL'];

  function normShop(list) {
    const out = [];
    for (const s of (Array.isArray(list) ? list : [])) {
      if (!s || !String(s.name || '').trim()) continue;
      const give = {};
      for (const k of INV_KEYS) if (Number(s.give?.[k]) > 0) give[k] = Number(s.give[k]);
      // 【v23.1】图标改为人工选择：既可以是内置图标名，也可以直接贴图片地址（http(s):// 或 /assets/ 开头）
      const rawIcon = String(s.icon || '').trim();
      const isUrl = /^(https?:\/\/|\/assets\/|\/games\/)/.test(rawIcon);
      out.push({
        id: String(s.id || ('item' + (out.length + 1))).slice(0, 32),
        name: String(s.name).trim().slice(0, 24),
        icon: isUrl ? rawIcon.slice(0, 300) : (ITEM_KEYS.includes(rawIcon) ? rawIcon : 'ball'),
        cost: Math.max(0, Number(s.cost) || 0),
        give, limit: Math.max(0, Number(s.limit) || 0),
        desc: String(s.desc || '').slice(0, 60),
        enabled: s.enabled !== false,
      });
    }
    return out;
  }
  function normTasks(list) {
    const out = [];
    for (const t of (Array.isArray(list) ? list : [])) {
      if (!t || !String(t.title || '').trim()) continue;
      const action = ['daily', 'link', 'play', 'bags', 'info'].includes(t.action) ? t.action : 'info';
      out.push({
        id: String(t.id || ('task' + (out.length + 1))).slice(0, 32),
        title: String(t.title).trim().slice(0, 24),
        desc: String(t.desc || '').slice(0, 80),
        reward: String(t.reward || '').slice(0, 24),
        action, link: String(t.link || '').slice(0, 200),
        enabled: t.enabled !== false,
      });
    }
    return out;
  }
  function normProbTable(t) {
    if (!t || !(t.escape >= 0 && t.escape <= 100)) return null;
    if (!Array.isArray(t.reward) || !t.reward.length) return null;
    let sum = t.escape;
    const reward = [];
    for (const r of t.reward) {
      if (!Array.isArray(r) || r.length < 3) return null;
      const [type, n, p] = r;
      if (!ITEM_KEYS.includes(type)) return null;
      if (!(Number(n) >= 1) || !(Number(p) >= 0)) return null;
      sum += Number(p);
      reward.push([type, Math.floor(Number(n)), Number(p)]);
    }
    if (sum > 100.5) return null;   // 允许 ≤0.5% 浮点误差，rollOnce 已有兜底
    return { escape: Number(t.escape), reward };
  }
  function normProb(p) {
    if (!p) return null;
    const w1 = normProbTable(p.wave1), w2 = normProbTable(p.wave2);
    if (!w1 || !w2) return null;
    if (!Array.isArray(p.wave3) || p.wave3.length !== 5) return null;
    const w3 = p.wave3.map(normProbTable);
    if (w3.some(x => !x)) return null;
    return { wave1: w1, wave2: w2, wave3: w3 };
  }

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
    // 【2026-09-13 修复】自愈历史残局：卡在"逃跑待处理"且已无复活可能的，直接了结
    if (s.status === 'playing' && s.pendingEscape) {
      const p = await getProfile(db, userId);
      if (!(p.revives > 0 && s.revivesUsed < ACTIVITY.maxRevivesPerGame)) {
        await db.collection('game_sessions').updateOne({ _id: s._id }, { $set: { status: 'lost', endedAt: new Date(), updatedAt: new Date() } });
        await log(db, userId, 'lost', { wave: s.wave, round: s.round, lostPot: s.pot, heal: true });
        return null;
      }
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
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); } };

  // ==================== 配置热调 + 管理员管控（2026-09-13 新增） ====================
  // 注意：必须先于游戏路由注册（Express 按注册顺序匹配）
  // 所有 /api/game/* 请求前，先从数据库 config 读取运营覆盖项（无需重启）
  app.use('/api/game', async (req, res, next) => {
    try {
      const db = await getDb();
      const doc = await db.collection('config').findOne({ key: 'game_config' });
      const v = (doc && doc.value) || {};
      if (v.start) ACTIVITY.start = v.start;
      if (v.end) ACTIVITY.end = v.end;
      // 【2026-09-24 修复】dailyFreeKey 允许设 0（后台 0~10 可配，设 0 = 关闭每日免费钥匙；
      // 原先 >0 判断导致设 0 永远不生效）
      if (v.dailyFreeKey >= 0) ACTIVITY.dailyFreeKey = v.dailyFreeKey;
      if (v.maxRevivesPerGame >= 0) ACTIVITY.maxRevivesPerGame = v.maxRevivesPerGame;
      if (v.composeFragCost > 0) ACTIVITY.composeFragCost = v.composeFragCost;
      // 【2026-09-24 修复】BAG_RANGE 校验数值型——原先只校验数组长度，
      // 后台存入非数后 rnd2(lo + Math.random()*(hi-lo)) 产出 NaN 直接写进 wallet_log，污染主站余额账本
      for (const k of ['bagS', 'bagM', 'bagL']) {
        if (Array.isArray(v[k]) && v[k].length === 2
          && v[k].every(x => Number.isFinite(x))) BAG_RANGE[k] = v[k];
      }
      // 【v22.0】商铺 / 任务专区 / 掉落概率：后台可整体覆盖，读库失败用代码内默认值
      if (Array.isArray(v.shop) && v.shop.length) { const s = normShop(v.shop); if (s.length) SHOP = s; }
      if (Array.isArray(v.tasks)) { const t = normTasks(v.tasks); if (t.length) TASKS = t; }
      if (v.prob) { const p = normProb(v.prob); if (p) PROB = p; }
      next();
    } catch (e) { next(); } // 配置读取失败不阻塞游戏，用代码内默认值
  });

  const adminGate = (req, res) => { if (req.user.role !== 'admin') { bad(res, 403, '需要管理员权限'); return false; } return true; };

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
      // 【2026-09-14 修复】补 pendingEscape / status / reviveQuotaLeft：
      // 刷新页面后前端才能重建"逃跑待处理"弹窗，否则对局永久卡死（无法继续翻）
      session: session ? {
        wave: session.wave, round: session.round, pot: session.pot, revivesUsed: session.revivesUsed,
        waveDone: session.status === 'wave_done', pendingEscape: !!session.pendingEscape, status: session.status,
        reviveQuotaLeft: Math.max(0, ACTIVITY.maxRevivesPerGame - session.revivesUsed),
        table: tablePublic(session.wave, session.round),
      } : null,
      shop: SHOP.filter(s => s.enabled).map(s => ({ id: s.id, name: s.name, icon: s.icon, cost: s.cost, desc: s.desc || '', enabled: s.enabled })),
      // 【v22.0】任务专区改为后台可配置，前端按 action 渲染按钮
      tasks: TASKS.filter(t => t.enabled).map(t => ({ id: t.id, title: t.title, desc: t.desc, reward: t.reward, action: t.action, link: t.link })),
      bagRange: BAG_RANGE,
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
    const active = await getActiveSession(db, req.user.id); // 顺手清理超时弃局
    // 【2026-09-14 修复】开局前显式拦截：进行中/待抉择/逃跑待处理都不允许再开新局
    if (active) return bad(res, 400, active.pendingEscape ? '上一局有逃跑待处理，请先复活或放弃' : (active.status === 'wave_done' ? '上一波还没抉择，请先落袋或继续' : '你有一局还在进行中，先完成它吧'));
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
      log(db, req.user.id, 'start', { sessionId: s.insertedId }).catch(() => {});
      res.json({ ok: true, session: { wave: 1, round: 1, pot, revivesUsed: 0, waveDone: false, table: tablePublic(1, 1) }, keys: p.keys });
    } catch (e) {
      // 并发开局撞唯一索引 → 退回钥匙
      await db.collection('game_profiles').updateOne({ userId: req.user.id }, { $inc: { keys: 1, totalGames: -1 } });
      if (e.code === 11000) return bad(res, 400, '你有一局还在进行中');
      throw e;
    }
  }));

  // 翻牌：服务端掷骰结算
  // 【2026-09-17 安全加固】限流：正常玩家每分钟翻牌次数有限，脚本高频刷波次会被挡下
  app.post('/api/game/flip', auth, limit({ name: 'game-flip', max: 60, windowMs: 60 * 1000, msg: '操作太频繁，请稍候再试' }), wrap(async (req, res) => {
    const db = await getDb();
    const s = await getActiveSession(db, req.user.id);
    if (!s) return bad(res, 400, '没有进行中的对局');
    if (s.status === 'wave_done') return bad(res, 400, '本波已完成，请先选择：落袋或继续');
    if (s.pendingEscape) return bad(res, 400, '请先处理奖励逃跑（复活或放弃）');

    const { escaped, reward } = rollOnce(s.wave, s.round);

    if (escaped) {
      const pro = await getProfile(db, req.user.id);
      const canRevive = pro.revives > 0 && s.revivesUsed < ACTIVITY.maxRevivesPerGame;
      await log(db, req.user.id, 'escape', { wave: s.wave, round: s.round });
      // 【二次复核修正】逃逸分支原本是无条件更新——并发一个请求掷中逃逸、一个掷中奖励时，
      // 奖励分支的条件更新仍会成功，逃逸惩罚被绕过。改为同样的条件更新（乐观锁）。
      const escClaim = await db.collection('game_sessions').updateOne(
        { _id: s._id, status: 'playing', wave: s.wave, round: s.round },
        { $set: canRevive ? { pendingEscape: true, updatedAt: new Date() } : { status: 'lost', endedAt: new Date(), updatedAt: new Date() } });
      if (!escClaim.modifiedCount) return bad(res, 400, '本局状态已变化，请刷新');
      if (!canRevive) {
        // 无复活可用 → 对局立即结束（不再留"待处理"残局）
        await log(db, req.user.id, 'lost', { wave: s.wave, round: s.round, lostPot: s.pot });
        return res.json({ ok: true, escaped: true, canRevive: false, revivesLeft: 0, reviveQuotaLeft: 0, lostPot: s.pot, session: null });
      }
      return res.json({ ok: true, escaped: true, canRevive: true, revivesLeft: pro.revives, reviveQuotaLeft: ACTIVITY.maxRevivesPerGame - s.revivesUsed, lostPot: null });
    }

    // 命中奖励 → 计入暂存
    // 【2026-09-17 安全修复】三处状态推进全部改为条件更新（乐观锁）：
    // 只有会话仍处于"playing + 当前波 + 当前轮"时才推进，并发同时打 N 个 flip 只有第一个生效，
    // 其余全部被拒——彻底堵住同一局奖励被重复入账 N 倍的口子
    const pot = Object.assign({}, s.pot); pot[reward.type] += reward.n;
    let waveDone = false, finished = false, settled = null;
    let claim;
    if (s.round >= 5 && s.wave >= 3) {
      // 第三波第5轮 → 自动结算（全游戏终局）
      claim = await db.collection('game_sessions').updateOne(
        { _id: s._id, status: 'playing', wave: s.wave, round: s.round },
        { $set: { pot, status: 'done', endedAt: new Date(), updatedAt: new Date() } });
      if (!claim.modifiedCount) return bad(res, 400, '本局已结算');
      settled = await settlePot(db, req.user.id, pot);
      finished = true;
    } else if (s.round >= 5) {
      claim = await db.collection('game_sessions').updateOne(
        { _id: s._id, status: 'playing', wave: s.wave, round: s.round },
        { $set: { pot, status: 'wave_done', updatedAt: new Date() } });
      if (!claim.modifiedCount) return bad(res, 400, '本波已完成，请先选择：落袋或继续');
      waveDone = true;
    } else {
      claim = await db.collection('game_sessions').updateOne(
        { _id: s._id, status: 'playing', wave: s.wave, round: s.round },
        { $set: { pot, round: s.round + 1, updatedAt: new Date() } });
      if (!claim.modifiedCount) return bad(res, 400, '操作太快了，请稍候重试');
    }
    log(db, req.user.id, 'reward', { wave: s.wave, round: s.round, got: reward }).catch(() => {});   // 【v3】日志异步化，响应不再等 Atlas 写日志
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
    // 【二次复核修正】条件更新：只有"逃跑待处理"状态的会话能被放弃
    const claim = await db.collection('game_sessions').updateOne(
      { _id: s._id, status: 'playing', pendingEscape: true },
      { $set: { status: 'forfeit', endedAt: new Date(), updatedAt: new Date() } });
    if (!claim.modifiedCount) return bad(res, 400, '当前没有可放弃的对局');
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
      // 【2026-09-17 安全修复】先原子占用会话（wave_done→done 只允许成功一次），
      // 再入账背包——原来的"先入账再改状态"在并发下可重复结算
      const claim = await db.collection('game_sessions').updateOne(
        { _id: s._id, status: 'wave_done' },
        { $set: { status: 'done', endedAt: new Date(), updatedAt: new Date() } });
      if (!claim.modifiedCount) return bad(res, 400, '本局已结算过了');
      const settled = await settlePot(db, req.user.id, s.pot);
      await log(db, req.user.id, 'cashout', { wave: s.wave, got: s.pot });
      return res.json({ ok: true, action, settled });
    }
    if (action === 'continue') {
      // 同上：条件更新防并发双推进
      const claim = await db.collection('game_sessions').updateOne(
        { _id: s._id, status: 'wave_done' },
        { $set: { status: 'playing', wave: s.wave + 1, round: 1, updatedAt: new Date() } });
      if (!claim.modifiedCount) return bad(res, 400, '当前没有可抉择的对局');
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

  // 管理员：读取游戏配置（含数据库覆盖值）
  app.get('/api/game/admin/config', auth, wrap(async (req, res) => {
    if (!adminGate(req, res)) return;
    const db = await getDb();
    const doc = await db.collection('config').findOne({ key: 'game_config' });
    res.json({ ok: true, effective: { start: ACTIVITY.start, end: ACTIVITY.end, dailyFreeKey: ACTIVITY.dailyFreeKey, maxRevivesPerGame: ACTIVITY.maxRevivesPerGame, composeFragCost: ACTIVITY.composeFragCost, bagS: BAG_RANGE.bagS, bagM: BAG_RANGE.bagM, bagL: BAG_RANGE.bagL }, overrides: (doc && doc.value) || {}, prob: PROB, shop: SHOP, tasks: TASKS, itemNames: ITEM_NAMES, invKeys: INV_KEYS });
  }));

  // 管理员：修改游戏配置（热调，立即生效）
  app.post('/api/game/admin/config', auth, wrap(async (req, res) => {
    if (!adminGate(req, res)) return;
    const db = await getDb();
    const b = req.body || {};
    const v = (await db.collection('config').findOne({ key: 'game_config' }))?.value || {};
    if (b.start && !/^\d{4}-\d{2}-\d{2}$/.test(b.start)) return bad(res, 400, 'start 日期格式应为 YYYY-MM-DD');
    if (b.end && !/^\d{4}-\d{2}-\d{2}$/.test(b.end)) return bad(res, 400, 'end 日期格式应为 YYYY-MM-DD');
    if (b.start) v.start = b.start;
    if (b.end) v.end = b.end;
    if (b.dailyFreeKey !== undefined) { if (!(b.dailyFreeKey >= 0 && b.dailyFreeKey <= 10)) return bad(res, 400, '每日免费钥匙应在 0~10'); v.dailyFreeKey = b.dailyFreeKey; }
    if (b.maxRevivesPerGame !== undefined) { if (!(b.maxRevivesPerGame >= 0 && b.maxRevivesPerGame <= 5)) return bad(res, 400, '每局复活上限应在 0~5'); v.maxRevivesPerGame = b.maxRevivesPerGame; }
    if (b.composeFragCost !== undefined) { if (!(b.composeFragCost >= 1 && b.composeFragCost <= 100)) return bad(res, 400, '合成碎片数应在 1~100'); v.composeFragCost = b.composeFragCost; }
    for (const k of ['bagS', 'bagM', 'bagL']) {
      if (b[k] !== undefined) {
        if (!Array.isArray(b[k]) || b[k].length !== 2 || !(b[k][0] >= 0 && b[k][1] > b[k][0])) return bad(res, 400, k + ' 应为 [最小值, 最大值] 且最大>最小');
        v[k] = [b[k][0], b[k][1]];
      }
    }
    // 【v22.0】商铺 / 任务专区 / 掉落概率：整体提交、服务端校验后落库
    if (b.shop !== undefined) {
      const s = normShop(b.shop);
      if (!s.length) return bad(res, 400, '商铺至少要有一个商品（名称不能为空）');
      const ids = new Set(s.map(x => x.id));
      if (ids.size !== s.length) return bad(res, 400, '商铺商品 id 不能重复');
      v.shop = s;
    }
    if (b.tasks !== undefined) {
      const t = normTasks(b.tasks);
      if (!t.length) return bad(res, 400, '任务专区至少要有一个任务');
      const ids = new Set(t.map(x => x.id));
      if (ids.size !== t.length) return bad(res, 400, '任务 id 不能重复');
      v.tasks = t;
    }
    if (b.prob !== undefined) {
      if (b.prob === null) { delete v.prob; }   // 还原为代码默认值
      else {
        const p = normProb(b.prob);
        if (!p) return bad(res, 400, '概率表格式不对：每张表 escape 0~100，奖励项 [类型,数量,概率%]，类型必须是 ' + ITEM_KEYS.join('/'));
        v.prob = p;
      }
    }
    if (b.maintenance !== undefined) await db.collection('config').updateOne({ key: 'game_maintenance' }, { $set: { value: !!b.maintenance } }, { upsert: true });
    await db.collection('config').updateOne({ key: 'game_config' }, { $set: { value: v } }, { upsert: true });
    await log(db, req.user.id, 'admin_config', { by: req.user.id, changes: b });
    res.json({ ok: true, saved: v });
  }));

  // 管理员：审计日志查询（可按用户/动作筛选）
  app.get('/api/game/admin/logs', auth, wrap(async (req, res) => {
    if (!adminGate(req, res)) return;
    const db = await getDb();
    const q = {};
    // 【2026-09-17 安全修复】query 用 qs 扩展解析，?userId[$ne]=x 可注入操作符对象，强转字符串
    if (req.query.userId) q.userId = String(req.query.userId);
    if (req.query.action) q.action = String(req.query.action);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const logs = await db.collection('game_logs').find(q).sort({ createdAt: -1 }).limit(limit).toArray();
    res.json({ ok: true, logs });
  }));

  // 管理员：兑换记录（含成本合计）
  app.get('/api/game/admin/redeems', auth, wrap(async (req, res) => {
    if (!adminGate(req, res)) return;
    const db = await getDb();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const redeems = await db.collection('game_redeems').find({}).sort({ createdAt: -1 }).limit(limit).toArray();
    const totalCost = redeems.reduce((s, r) => s + (r.cost || 0), 0);
    res.json({ ok: true, redeems, totalCost });
  }));

  console.log('[游戏] 魔法翻翻乐接口注册完成：/api/game/*（含管理员管控接口）');

  // ==================== 索引（2026-09-14 数据库优化） ====================
  // 旧版只在注释里"声称"有唯一索引，实际从未创建 → 并发开局可产生双会话
  (async () => {
    try {
      const db = await getDb();
      // 会话查询索引（getActiveSession 高频调用）
      await db.collection('game_sessions').createIndex({ userId: 1, status: 1 }).catch(() => {});
      // 每用户同时最多一局 playing / 一局 wave_done（partial unique，防并发双开局）
      await db.collection('game_sessions').createIndex({ userId: 1 }, { name: 'uniq_playing_per_user', unique: true, partialFilterExpression: { status: 'playing' } }).catch(e => console.warn('[游戏索引] playing 唯一:', e.message));
      await db.collection('game_sessions').createIndex({ userId: 1 }, { name: 'uniq_wavedone_per_user', unique: true, partialFilterExpression: { status: 'wave_done' } }).catch(e => console.warn('[游戏索引] wave_done 唯一:', e.message));
      // 档案：userId 唯一（每次游戏请求都 findOne，原来全表扫描）
      await db.collection('game_profiles').createIndex({ userId: 1 }, { unique: true }).catch(e => console.warn('[游戏索引] profiles:', e.message));
      // 审计日志：管理端按用户/时间查询排序
      await db.collection('game_logs').createIndexes([{ key: { userId: 1, createdAt: -1 } }, { key: { createdAt: -1 } }]).catch(() => {});
      // 兑换记录
      await db.collection('game_redeems').createIndexes([{ key: { createdAt: -1 } }, { key: { userId: 1 } }]).catch(() => {});
      console.log('[游戏索引] game_sessions/profiles/logs/redeems 索引就绪');
    } catch (e) { console.warn('[游戏索引] 初始化:', e.message); }
  })();
};
