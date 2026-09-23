// shanhai_market.js — 山海斩妖录 · 灵气交易所做市机器人与后台管控
// 挂载方式（server.js）：(await import('./shanhai_market.js')).default(app, { auth, adminOnly, getDb });
//
// 【为什么要做市机器人】
// 玩家挂单最怕"挂上去没人接"——流动性为零的交易所等于摆设。机器人按管理员设定的
// 价格区间与节奏持续买卖，保证任何时刻都有人接盘，给玩家一个兜底。
//
// 【设计要点】
//   1) 机器人用独立账户 __market__：不进 shanhai_profiles，因此不计入玩家数、不上榜、不污染统计
//   2) 机器人额度存在独立集合 shanhai_market_fund，管理员可随时充值/查看
//   3) 机器人成交与玩家成交走同一套资金规则：买家付全额、卖家收 99.5%、平台抽 0.5%
//   4) 每笔成交都写 shanhai_ex_deals，带 bot 标记 —— 后台台账一眼分得清哪些是玩家的、哪些是机器人的
//   5) 优先吃玩家的挂单（给真实挂单兜底），市场上没单时才自己挂单补流动性
import { ObjectId } from 'mongodb';

const PLATFORM_ID = '__platform__';
const BOT_ID = '__market__';
const FUND_COL = 'shanhai_market_fund';
const CFG_COL = 'shanhai_config';
const DEAL_COL = 'shanhai_ex_deals';
const ORD_COL = 'shanhai_exchange';

const DEFAULT_CFG = {
  _id: 'market',
  enabled: true,          // 做市开关
  intervalSec: 60,        // 每轮间隔（秒）
  tradesMin: 1,           // 每轮最少成交笔数
  tradesMax: 5,           // 每轮最多成交笔数
  priceMin: 0.06,         // 价格波动下限（元/灵气）
  priceMax: 0.18,         // 价格波动上限
  amountMin: 20,          // 每笔数量下限
  amountMax: 500,         // 每笔数量上限
  fundLingqi: 200000,     // 初始灵气额度（首次建档时发放）
  fundCash: 5000,         // 初始余额额度（首次建档时发放）
  updatedAt: new Date(),
};

const money2 = n => Math.round(Number(n) * 100) / 100;
const rndInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

// 【v26.3.2】机器人挂单的两个自愈参数。
// 原来每侧上限只有 8 张，且不回收——挂出去没人吃就一直堆着，很快撞上限，
// 于是每轮都返回 bot_orders_full（看起来像"机器人坏了"，其实是被自己的旧单堵住了）。
const BOT_MAX_OPEN_PER_SIDE = 20;              // 单侧最多同时挂 20 张
const BOT_ORDER_TTL_MS = 30 * 60 * 1000;       // 挂满 30 分钟还没成交 → 撤掉重挂（价格可能已过时）

export default function mountShanhaiMarket(app, { auth, adminOnly, getDb }) {

  // ==================== 配置 / 额度 ====================
  async function loadCfg(db) {
    const doc = await db.collection(CFG_COL).findOne({ _id: 'market' });
    return Object.assign({}, DEFAULT_CFG, doc || {});
  }
  async function saveCfg(db, patch) {
    await db.collection(CFG_COL).updateOne(
      { _id: 'market' },
      { $set: Object.assign({}, patch, { updatedAt: new Date() }) },
      { upsert: true }
    );
    return loadCfg(db);
  }
  async function ensureFund(db, cfg) {
    const f = await db.collection(FUND_COL).findOne({ _id: 'market' });
    if (f) return f;
    const doc = { _id: 'market', lingqi: cfg.fundLingqi, lingqiFrozen: 0, createdAt: new Date() };
    await db.collection(FUND_COL).updateOne({ _id: 'market' }, { $setOnInsert: doc }, { upsert: true });
    // 初始余额走 wallet_log，与玩家同一口径
    const exists = await db.collection('wallet_log').findOne({ userId: BOT_ID, kind: 'market_seed' });
    if (!exists && cfg.fundCash > 0) {
      await db.collection('wallet_log').insertOne({
        userId: BOT_ID, amount: cfg.fundCash, kind: 'market_seed',
        note: '做市机器人初始额度', createdAt: new Date(),
      });
    }
    return db.collection(FUND_COL).findOne({ _id: 'market' });
  }
  const botBalance = async db => {
    const rows = await db.collection('wallet_log').find({ userId: BOT_ID }, { projection: { amount: 1 } }).toArray();
    return money2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0));
  };

  // ==================== 台账写入 ====================
  async function writeDeal(db, d) {
    await db.collection(DEAL_COL).insertOne(Object.assign({ createdAt: new Date() }, d)).catch(() => { });
  }
  async function writeLog(db, userId, amount, kind, note, orderId, extra) {
    await db.collection('wallet_log').insertOne(Object.assign({
      userId, amount: money2(amount), kind, note: note || '', orderId: orderId || null, createdAt: new Date(),
    }, extra || {}));
  }

  // 【v26.3.2】回收机器人自己挂了太久没成交的单：卖单退冻结灵气、买单退冻结余额，
  // 撤掉后腾出的价格档位与额度可以重新挂，避免"被自己的旧单堵死"。
  async function recycleStaleBotOrders(db) {
    const deadline = new Date(Date.now() - BOT_ORDER_TTL_MS);
    const stale = await db.collection(ORD_COL)
      .find({ userId: BOT_ID, status: 'open', createdAt: { $lt: deadline } }).limit(30).toArray();
    if (!stale.length) return { recycled: 0 };
    let backLingqi = 0;
    for (const o of stale) {
      if (o.side === 'sell' && o.left > 0) backLingqi += o.left;
      else if (o.side === 'buy' && (o.locked || 0) > 0) {
        await writeLog(db, BOT_ID, o.locked, 'exchange_unlock', `做市老单回收退回 ¥${o.locked}`, String(o._id), { bot: true });
      }
    }
    if (backLingqi) {
      await db.collection(FUND_COL).updateOne({ _id: 'market' }, { $inc: { lingqi: backLingqi, lingqiFrozen: -backLingqi } });
    }
    await db.collection(ORD_COL).updateMany(
      { _id: { $in: stale.map(o => o._id) } },
      { $set: { status: 'cancel', left: 0, locked: 0, updatedAt: new Date() } }
    );
    console.log('[market] 回收老挂单 %d 张，退回灵气 %d', stale.length, backLingqi);
    return { recycled: stale.length, lingqiBack: backLingqi };
  }
  mountShanhaiMarket.recycleStaleBotOrders = recycleStaleBotOrders;

  // ==================== 一轮做市 ====================
  // 单笔：优先吃玩家挂单；没有可吃的就自己挂一单补流动性
  async function oneTrade(db, cfg) {
    const side = Math.random() < 0.5 ? 'sell' : 'buy';       // 机器人这一笔想「卖灵气」还是「买灵气」
    const price = money2(cfg.priceMin + Math.random() * (cfg.priceMax - cfg.priceMin));
    const amount = rndInt(cfg.amountMin, cfg.amountMax);
    const fund = await ensureFund(db, cfg);
    const bal = await botBalance(db);
    const col = db.collection(ORD_COL);

    // 找对手方：机器人卖 → 吃玩家的买单；机器人买 → 吃玩家的卖单
    const target = await col.findOne(
      { side: side === 'sell' ? 'buy' : 'sell', status: 'open', left: { $gt: 0 }, userId: { $nin: [BOT_ID, null] } },
      { sort: { price: side === 'sell' ? -1 : 1, createdAt: 1 } }
    );

    if (target) {
      const n = Math.min(amount, target.left);
      const total = money2(n * target.price);
      const fee = money2(total * 0.005);
      const botIsBuyer = side === 'buy';        // 机器人买 → 机器人付钱
      // 机器人能力校验
      if (botIsBuyer && bal < total) return { skipped: 'bot_no_cash' };
      if (!botIsBuyer && (fund.lingqi || 0) < n) return { skipped: 'bot_no_lingqi' };
      // 【v26.3.1 兼容】v26.3 之前挂出的求购单没冻结余额，机器人吃这种老单时要走实时扣款——
      // 但得先确认那个玩家真有钱，否则扣出一笔负数余额
      const targetLegacyBuy = !botIsBuyer && !(target.locked > 0);
      if (targetLegacyBuy) {
        const rows = await db.collection('wallet_log').find({ userId: target.userId }, { projection: { amount: 1 } }).toArray();
        const pBal = money2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0));
        if (pBal < total) return { skipped: 'buyer_no_cash' };
      }

      // 抢余量
      const taken = await col.findOneAndUpdate(
        { _id: target._id, status: 'open', left: { $gte: n } },
        { $inc: { left: -n }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      const after = taken && (taken.value || taken);
      if (!after) return { skipped: 'race' };

      const playerId = target.userId;
      const prof = db.collection('shanhai_profiles');
      const sellerId = botIsBuyer ? BOT_ID : playerId;
      const buyerId = botIsBuyer ? playerId : BOT_ID;
      try {
        // 灵气流转
        if (botIsBuyer) {
          // 机器人是主动买家：实时付钱；玩家的卖单是冻结状态，解冻后转出
          await db.collection(FUND_COL).updateOne({ _id: 'market' }, { $inc: { lingqi: n } });
          await prof.updateOne({ userId: playerId }, { $inc: { lingqiFrozen: -n }, $set: { updatedAt: new Date() } });
          await writeLog(db, buyerId, -total, 'exchange_buy', `交易所买入灵气 ${n}（做市）`, String(target._id), { bot: true });
        } else {
          // 机器人是卖家，对手方是玩家挂的求购单
          await db.collection(FUND_COL).updateOne({ _id: 'market' }, { $inc: { lingqi: -n } });
          await prof.updateOne({ userId: playerId }, { $inc: { lingqi: n }, $set: { updatedAt: new Date() } });
          if (targetLegacyBuy) {
            // 老求购单（未冻结）：从玩家余额实时扣
            await writeLog(db, playerId, -total, 'exchange_buy', `交易所买入灵气 ${n}`, String(target._id), {});
          } else {
            // 新求购单：用挂单时冻结的余额，只冲减订单 locked，不重复扣款
            await col.updateOne({ _id: target._id }, { $inc: { locked: -total } });
          }
        }
        await writeLog(db, sellerId, money2(total - fee), 'exchange_sell', `交易所卖出灵气 ${n}（已扣手续费 ¥${fee}）`, String(target._id), { bot: !botIsBuyer });
        if (fee > 0) await writeLog(db, PLATFORM_ID, fee, 'exchange_fee', `订单 ${String(target._id)} 手续费 0.5%`, String(target._id), { bot: true });
      } catch (e) {
        await col.updateOne({ _id: target._id }, { $inc: { left: n } }).catch(() => { });
        return { skipped: 'settle_error' };
      }
      // 结单：求购单把残余零头退回（买家已冻结的钱按实际成交冲减，剩下的不该一直冻着）
      if (after.left <= 0) {
        const fresh = await col.findOne({ _id: target._id });
        const residual = target.side === 'buy' ? money2((fresh || {}).locked || 0) : 0;
        await col.updateOne({ _id: target._id }, { $set: { status: 'done', locked: 0, updatedAt: new Date() } });
        if (residual > 0) await writeLog(db, target.userId, residual, 'exchange_unlock', `求购单结清退回 ¥${residual}`, String(target._id), {});
      }
      const deal = {
        orderId: String(target._id), side: target.side, amount: n, price: target.price, total, fee,
        buyerId, sellerId, buyerName: botIsBuyer ? '做市灵傀' : (target.username || ''), sellerName: botIsBuyer ? (target.username || '') : '做市灵傀',
        bot: true, botSide: botIsBuyer ? 'buy' : 'sell', mode: 'bot_take',
      };
      await writeDeal(db, deal);
      return { dealt: deal };
    }

    // 挂单前先自愈：把挂了太久没成交的老单收回来（释放资金与价格档位）
    await recycleStaleBotOrders(db);

    // 市场上没有可吃的单 → 机器人自己挂一单（提供流动性）
    const openSame = await col.countDocuments({ userId: BOT_ID, side, status: 'open' });
    if (openSame >= BOT_MAX_OPEN_PER_SIDE) return { skipped: 'bot_orders_full' };
    // 同一价格已经有单就不再堆一张（否则同一价位挂成一排，玩家看着很假）
    const samePrice = await col.findOne({ userId: BOT_ID, side, status: 'open', price });
    if (samePrice) return { skipped: 'bot_same_price' };
    const totalNew = money2(amount * price);
    if (side === 'sell') {
      if ((fund.lingqi || 0) < amount) return { skipped: 'bot_no_lingqi' };
      await db.collection(FUND_COL).updateOne({ _id: 'market' }, { $inc: { lingqi: -amount, lingqiFrozen: amount } });
    } else {
      // 【v26.3】机器人挂求购单同样冻结余额，与玩家口径一致
      if (bal < totalNew) return { skipped: 'bot_no_cash' };
      await writeLog(db, BOT_ID, -totalNew, 'exchange_lock', `做市求购单冻结 ¥${totalNew}`, null, { bot: true });
    }
    await col.insertOne({
      userId: BOT_ID, username: '做市灵傀', side, amount, left: amount, price,
      locked: side === 'buy' ? totalNew : 0,
      status: 'open', bot: true, createdAt: new Date(), updatedAt: new Date(),
    });
    return { posted: { side, amount, price } };
  }

  async function runRound() {
    try {
      const db = await getDb();
      const cfg = await loadCfg(db);
      if (!cfg.enabled) return { skipped: 'disabled' };
      await ensureFund(db, cfg);
      const n = rndInt(Math.min(cfg.tradesMin, cfg.tradesMax), Math.max(cfg.tradesMin, cfg.tradesMax));
      const res = [];
      for (let i = 0; i < n; i++) {
        res.push(await oneTrade(db, cfg));
        await new Promise(r => setTimeout(r, 300));   // 稍微错开，避免同一秒挤在一起
      }
      const deals = res.filter(r => r.dealt).length;
      const posts = res.filter(r => r.posted).length;
      await db.collection(CFG_COL).updateOne({ _id: 'market' }, { $set: { lastRunAt: new Date(), lastSummary: { tried: n, deals, posts, skips: res.filter(r => r.skipped).map(r => r.skipped) } } }, { upsert: true }).catch(() => { });
      return { ok: true, tried: n, deals, posts, detail: res };
    } catch (e) {
      console.error('[market] round error', e);
      return { ok: false, error: String(e.message || e) };
    }
  }
  mountShanhaiMarket.runRound = runRound;

  // 定时器：用 unref 保证它不会阻止进程退出（Render 上重启时干净退出）
  let timer = null;
  async function startTimer() {
    const tick = async () => {
      await runRound();
      let sec = DEFAULT_CFG.intervalSec;
      try { const db = await getDb(); sec = (await loadCfg(db)).intervalSec || 60; } catch (e) { }
      timer = setTimeout(tick, Math.max(15, sec) * 1000);
      if (timer.unref) timer.unref();
    };
    // 启动后先等 20 秒再跑第一轮（别和冷启动抢资源）
    timer = setTimeout(tick, 20000);
    if (timer.unref) timer.unref();
    console.log('[shanhai_market] 做市机器人已启动（默认 60 秒一轮，可在后台配置）');
  }
  try { startTimer(); } catch (e) { console.error('[shanhai_market] 定时器启动失败', e); }

  // ==================== 后台：交易所台账 ====================
  app.get('/api/shanhai/admin/exchange/ledger', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const limitN = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
      const page = Math.max(0, Number(req.query.page) || 0);
      const onlyBot = req.query.only === 'bot';
      const onlyHuman = req.query.only === 'human';
      const q = { };
      if (onlyBot) q.bot = true;
      if (onlyHuman) q.bot = { $ne: true };
      const [rows, total, agg] = await Promise.all([
        db.collection(DEAL_COL).find(q).sort({ createdAt: -1 }).skip(page * limitN).limit(limitN).toArray(),
        db.collection(DEAL_COL).countDocuments(q),
        db.collection(DEAL_COL).aggregate([
          { $group: { _id: null, total: { $sum: '$total' }, fee: { $sum: '$fee' }, cnt: { $sum: 1 }, lingqi: { $sum: '$amount' } } }
        ]).toArray(),
      ]);
      // 解构顺序必须与下面数组一一对应（少写一个变量就会 ReferenceError，board 那次就是这么炸的）
      const [humanAgg, botAgg, feeAgg, openCnt, botFund, platformFee, botOpenOrders, humanOpenOrders] = await Promise.all([
        db.collection(DEAL_COL).aggregate([{ $match: { bot: { $ne: true } } }, { $group: { _id: null, cnt: { $sum: 1 }, total: { $sum: '$total' }, fee: { $sum: '$fee' } } }]).toArray(),
        db.collection(DEAL_COL).aggregate([{ $match: { bot: true } }, { $group: { _id: null, cnt: { $sum: 1 }, total: { $sum: '$total' }, fee: { $sum: '$fee' } } }]).toArray(),
        db.collection('wallet_log').aggregate([{ $match: { userId: PLATFORM_ID } }, { $group: { _id: null, fee: { $sum: '$amount' }, cnt: { $sum: 1 } } }]).toArray(),
        db.collection(ORD_COL).countDocuments({ status: 'open', left: { $gt: 0 } }),
        db.collection(FUND_COL).findOne({ _id: 'market' }),
        db.collection('wallet_log').aggregate([{ $match: { userId: PLATFORM_ID } }, { $group: { _id: null, s: { $sum: '$amount' } } }]).toArray(),
        // 【v26.3.2】机器人自己挂了多少张（看它有没有被自己的旧单堵住）
        db.collection(ORD_COL).countDocuments({ userId: BOT_ID, status: 'open', left: { $gt: 0 } }),
        db.collection(ORD_COL).countDocuments({ userId: { $nin: [BOT_ID] }, status: 'open', left: { $gt: 0 } }),
      ]);
      // 补真实身份：后台台账要能认人（玩家侧永远只看得到匿名代号）。
      // 真实名从 users（写手账号）优先取，取不到再退回 shanhai_profiles.username。
      const ids = [...new Set(rows.flatMap(r => [r.buyerId, r.sellerId]))]
        .filter(x => x && x !== BOT_ID && x !== PLATFORM_ID);
      const nameMap = {};
      if (ids.length) {
        const oids = ids.filter(x => ObjectId.isValid(x)).map(x => new ObjectId(x));
        const [us, sp] = await Promise.all([
          oids.length ? db.collection('users').find({ _id: { $in: oids } },
            { projection: { username: 1, displayName: 1, uid: 1 } }).toArray() : [],
          db.collection('shanhai_profiles').find({ userId: { $in: ids } }, { projection: { userId: 1, username: 1 } }).toArray(),
        ]);
        us.forEach(u => {
          const label = [u.displayName || u.username, u.uid ? '工号' + u.uid : ''].filter(Boolean).join(' · ');
          nameMap[String(u._id)] = label || String(u._id);
        });
        sp.forEach(p => { if (!nameMap[p.userId]) nameMap[p.userId] = p.username || p.userId; });
      }
      const rowsOut = rows.map(r => Object.assign({}, r, {
        buyerReal: r.buyerId === BOT_ID ? '做市灵傀' : (nameMap[r.buyerId] || r.buyerId || '-'),
        sellerReal: r.sellerId === BOT_ID ? '做市灵傀' : (nameMap[r.sellerId] || r.sellerId || '-'),
      }));
      res.json({
        ok: true,
        rows: rowsOut, total, page, limit: limitN,
        stats: {
          all: agg[0] || { cnt: 0, total: 0, fee: 0, lingqi: 0 },
          human: (humanAgg[0] || { cnt: 0, total: 0, fee: 0 }),
          bot: (botAgg[0] || { cnt: 0, total: 0, fee: 0 }),
          feeLog: (feeAgg[0] || { cnt: 0, fee: 0 }),
          platformFeeTotal: money2((platformFee[0] || {}).s || 0),
          openOrders: openCnt,
          botOpenOrders, humanOpenOrders,
          botMaxPerSide: BOT_MAX_OPEN_PER_SIDE,
          botFund: { lingqi: botFund ? botFund.lingqi : 0, lingqiFrozen: botFund ? botFund.lingqiFrozen : 0, balance: await botBalance(db) },
        },
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ==================== 后台：做市配置 ====================
  app.get('/api/shanhai/admin/market/config', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const cfg = await loadCfg(db);
      const fund = await ensureFund(db, cfg);
      res.json({ ok: true, cfg, fund: { lingqi: fund.lingqi || 0, lingqiFrozen: fund.lingqiFrozen || 0 }, balance: await botBalance(db), defaults: DEFAULT_CFG });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/shanhai/admin/market/config', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const b = req.body || {};
      const num = (v, d, lo, hi) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return d;
        return Math.round(Math.max(lo, Math.min(hi, n)) * 100) / 100;
      };
      const patch = {
        enabled: b.enabled === undefined ? undefined : !!b.enabled,
        intervalSec: num(b.intervalSec, 60, 15, 3600),
        tradesMin: Math.round(num(b.tradesMin, 1, 1, 50)),
        tradesMax: Math.round(num(b.tradesMax, 5, 1, 50)),
        priceMin: num(b.priceMin, 0.06, 0.01, 9999),
        priceMax: num(b.priceMax, 0.18, 0.01, 9999),
        amountMin: Math.round(num(b.amountMin, 20, 1, 999999)),
        amountMax: Math.round(num(b.amountMax, 500, 1, 999999)),
      };
      Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);
      if (patch.tradesMin && patch.tradesMax && patch.tradesMin > patch.tradesMax) {
        return res.status(400).json({ ok: false, error: '每轮最少笔数不能大于最多笔数' });
      }
      if (patch.priceMin && patch.priceMax && patch.priceMin > patch.priceMax) {
        return res.status(400).json({ ok: false, error: '价格下限不能大于上限' });
      }
      if (patch.amountMin && patch.amountMax && patch.amountMin > patch.amountMax) {
        return res.status(400).json({ ok: false, error: '数量下限不能大于上限' });
      }
      const cfg = await saveCfg(db, patch);
      await db.collection('shanhai_logs').insertOne({ action: 'market_config', detail: patch, createdAt: new Date() }).catch(() => { });
      res.json({ ok: true, cfg });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 手动补额度（灵气 / 余额）
  app.post('/api/shanhai/admin/market/fund', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const lingqi = Math.round(Number((req.body || {}).lingqi) || 0);
      const cash = money2(Number((req.body || {}).cash) || 0);
      if (!lingqi && !cash) return res.status(400).json({ ok: false, error: '请填写要补充的灵气或余额' });
      if (lingqi) await db.collection(FUND_COL).updateOne({ _id: 'market' }, { $inc: { lingqi } }, { upsert: true });
      if (cash) await writeLog(db, BOT_ID, cash, 'market_fund', '后台补充做市额度', null, {});
      const fund = await db.collection(FUND_COL).findOne({ _id: 'market' });
      res.json({ ok: true, fund: { lingqi: (fund || {}).lingqi || 0, lingqiFrozen: (fund || {}).lingqiFrozen || 0 }, balance: await botBalance(db) });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 手动跑一轮（调试 / 急需活跃度时）
  app.post('/api/shanhai/admin/market/run', auth, adminOnly, async (req, res) => {
    try {
      const r = await runRound();
      res.json(Object.assign({ ok: true }, r));
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 清空机器人挂单（把流动资金收回来）
  app.post('/api/shanhai/admin/market/clear-orders', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const bots = await db.collection(ORD_COL).find({ userId: BOT_ID, status: 'open' }).toArray();
      let back = 0;
      for (const o of bots) if (o.side === 'sell' && o.left > 0) back += o.left;
      if (back) await db.collection(FUND_COL).updateOne({ _id: 'market' }, { $inc: { lingqi: back, lingqiFrozen: -back } });
      await db.collection(ORD_COL).updateMany({ userId: BOT_ID, status: 'open' }, { $set: { status: 'cancel', left: 0, updatedAt: new Date() } });
      res.json({ ok: true, cleared: bots.length, lingqiBack: back });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // ==================== 后台：山海玩家道具查询 / 管控 ====================
  const VALID_ITEM = ['xianyu', 'lingqi', 'lingqiFrozen', 'stamina', 'keysFromIdle'];

  app.get('/api/shanhai/admin/players', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const q = String(req.query.q || '').trim();
      const limitN = Math.min(100, Math.max(5, Number(req.query.limit) || 30));
      let filter = {};
      if (q) {
        // 支持：用户名模糊 / 用户ID / 手机号(用户名) / 工号(uid)
        const ors = [{ username: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
        if (ObjectId.isValid(q)) ors.push({ userId: q });
        ors.push({ userId: q });
        const users = await db.collection('users').find({
          $or: [{ username: q }, { uid: q }, { phone: q }, { displayName: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }],
        }, { projection: { _id: 1 } }).limit(20).toArray();
        users.forEach(u => ors.push({ userId: String(u._id) }));
        filter = { $or: ors };
      }
      const rows = await db.collection('shanhai_profiles').find(filter)
        .sort({ updatedAt: -1 }).limit(limitN)
        .project({ userId: 1, username: 1, xianyu: 1, lingqi: 1, lingqiFrozen: 1, stamina: 1, plays: 1, wins: 1, clearedStages: 1, updatedAt: 1 })
        .toArray();
      // 补一次余额（钱包余额 = sum(wallet_log)）
      const ids = rows.map(r => r.userId);
      const wl = ids.length ? await db.collection('wallet_log').aggregate([
        { $match: { userId: { $in: ids } } }, { $group: { _id: '$userId', s: { $sum: '$amount' } } }
      ]).toArray() : [];
      const balMap = {};
      wl.forEach(x => { balMap[x._id] = money2(x.s); });
      res.json({
        ok: true,
        rows: rows.map(r => Object.assign({}, r, {
          balance: balMap[r.userId] || 0,
          topStage: Array.isArray(r.clearedStages) && r.clearedStages.length ? Math.max(...r.clearedStages) : 0,
        })),
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.get('/api/shanhai/admin/player/:userId', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const uid = String(req.params.userId);
      const p = await db.collection('shanhai_profiles').findOne({ userId: uid });
      if (!p) return res.status(404).json({ ok: false, error: '该玩家还没有山海档案' });
      const [logs, deals, exchangeOrders] = await Promise.all([
        db.collection('shanhai_logs').find({ userId: uid }).sort({ createdAt: -1 }).limit(20).toArray(),
        db.collection(DEAL_COL).find({ $or: [{ buyerId: uid }, { sellerId: uid }] }).sort({ createdAt: -1 }).limit(15).toArray(),
        db.collection(ORD_COL).find({ userId: uid }).sort({ createdAt: -1 }).limit(15).toArray(),
      ]);
      res.json({ ok: true, profile: p, logs, deals, orders: exchangeOrders });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 发放 / 扣除道具（正数=发放，负数=扣除）
  app.post('/api/shanhai/admin/grant', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const b = req.body || {};
      const uid = String(b.userId || '');
      if (!uid) return res.status(400).json({ ok: false, error: '缺少玩家 ID' });
      if (uid === BOT_ID || uid === PLATFORM_ID) return res.status(400).json({ ok: false, error: '不能对系统账户操作' });
      const deltas = {};
      for (const k of VALID_ITEM) {
        const v = Math.round(Number(b[k]) || 0);
        if (v) deltas[k] = v;
      }
      if (!Object.keys(deltas).length) return res.status(400).json({ ok: false, error: '请至少填写一项要增减的数值' });

      // 先保证有档案（同 ensureProfile 的最小字段集）
      const exists = await db.collection('shanhai_profiles').findOne({ userId: uid });
      if (!exists) {
        await db.collection('shanhai_profiles').updateOne({ userId: uid }, {
          $setOnInsert: {
            userId: uid, username: b.username || uid, plays: 0, wins: 0, totalKills: 0, maxLevel: 0,
            xianyu: 0, lingqi: 0, lingqiFrozen: 0, skillLv: { fireline: 0, icepick: 0, body: 0 },
            equip: {}, bag: [], clearedStages: [], stageStars: {},
            stamina: 10, staminaAt: new Date(), createdAt: new Date(),
          }
        }, { upsert: true });
      }
      // 扣除时用条件更新防止扣成负数（-1 表示不限制扣到多少，这里统一不接受负值结果）
      const cond = {};
      const inc = {};
      for (const [k, v] of Object.entries(deltas)) {
        inc[k] = v;
        if (v < 0) cond[k] = { $gte: Math.abs(v) };
      }
      const r = await db.collection('shanhai_profiles').findOneAndUpdate(
        Object.assign({ userId: uid }, cond),
        { $inc: Object.assign({}, inc, {}), $set: { updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      const np = r && (r.value || r);
      if (!np) return res.status(400).json({ ok: false, error: '扣除失败：该玩家对应道具不足（不允许扣成负数）' });
      // 体力改动用「现在」重新起算恢复计时，避免出现负计时
      if (deltas.stamina) {
        await db.collection('shanhai_profiles').updateOne({ userId: uid }, { $set: { staminaAt: new Date() } });
      }
      await db.collection('shanhai_logs').insertOne({
        userId: uid, action: 'admin_grant',
        detail: { by: req.user.displayName || req.user.username || req.user.id, deltas },
        createdAt: new Date(),
      }).catch(() => { });
      res.json({ ok: true, profile: { userId: np.userId, xianyu: np.xianyu, lingqi: np.lingqi, lingqiFrozen: np.lingqiFrozen, stamina: np.stamina } });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  // 装备级操作：清空背包 / 卸下全部 / 删除某件
  app.post('/api/shanhai/admin/equip-action', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const { userId, action, itemId } = req.body || {};
      if (!userId) return res.status(400).json({ ok: false, error: '缺少玩家 ID' });
      const col = db.collection('shanhai_profiles');
      if (action === 'clear-bag') {
        await col.updateOne({ userId: String(userId) }, { $set: { bag: [], updatedAt: new Date() } });
      } else if (action === 'unequip-all') {
        await col.updateOne({ userId: String(userId) }, {
          $set: { equip: { weapon: null, armor: null, crown: null, belt: null, boots: null, accessory: null }, updatedAt: new Date() }
        });
      } else if (action === 'del-item' && itemId) {
        await col.updateOne({ userId: String(userId) }, { $pull: { bag: { id: String(itemId) } } });
      } else {
        return res.status(400).json({ ok: false, error: '未知操作' });
      }
      const p = await col.findOne({ userId: String(userId) });
      await db.collection('shanhai_logs').insertOne({ userId: String(userId), action: 'admin_equip_' + action, detail: { itemId: itemId || null, by: req.user.id }, createdAt: new Date() }).catch(() => { });
      res.json({ ok: true, profile: p });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  console.log('[shanhai_market] 做市机器人 + 交易所后台管控已挂载：/api/shanhai/admin/*');
}
