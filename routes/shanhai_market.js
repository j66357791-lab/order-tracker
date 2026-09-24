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
const EX_FEE = 0.005;    // 手续费率（与 shanhai_game.js 的 EX_CFG.feeRate 一致）
const ORD_COL = 'shanhai_exchange';

const DEFAULT_CFG = {
  _id: 'market',
  enabled: true,          // 做市开关
  intervalSec: 60,        // 每轮间隔（秒）
  tradesMin: 1,           // 每轮最少成交笔数
  tradesMax: 5,           // 每轮最多成交笔数
  priceMin: 0.06,         // 价格波动下限（元/灵气）——后台最低可设到 0.0001，与交易所同口径
  priceMax: 0.18,         // 价格波动上限（同样支持 4 位小数）
  // 【v26.9】价格波动率：每轮价格中枢随机游走的幅度（%），越大行情起伏越明显。
  // 太小 → 走势是条直线（一眼假）；太大 → 价格乱跳。3% 是比较自然的日间波动。
  volatility: 3,
  // 【v26.5】买卖最小价差：卖单最低价 − 买单最高价。
  // 这是防套利的核心参数 —— 价差必须盖住「双向手续费」，否则玩家能低买高卖刷钱。
  spreadMin: 0.001,
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

const money4 = n => Math.round(Number(n) * 10000) / 10000;   // 交易所内部 4 位小数

// ==================== 【v26.5】做市定价模型：中间价 + 买卖价差 ====================
// 【为什么必须改】原来机器人的卖价和买价各自独立随机、取值范围完全重叠 → 玩家可以
//   「从机器人低价买进 → 转手稍高价卖回给机器人」反复套利，等于印钱。
// 现在用中间价 mid 把买卖盘劈开：
//     机器人卖单价 ≥ mid + half          机器人买单价 ≤ mid - half
//     买卖价差 ≥ spreadMin（默认 0.001，且不小于双向手续费 + 缓冲）
// 玩家套利一轮的收益 = 买价×(1−手续费) − 卖价，在价差覆盖手续费后必然为负 —— 必亏。
function marketPrices(cfg, center) {
  const min = Number(cfg.priceMin) || 0.0001;
  const max = Number(cfg.priceMax) || 0.18;
  // 【v26.9】中枢由调用方传入（每轮做一次随机游走），不再固定取区间中点——
  // 固定中枢会导致行情是一条毫无起伏的直线，一眼假。
  const mid = money4(center || ((min + max) / 2));
  const feeBuffer = money4(mid * 0.015);                      // 双向手续费约 1% + 缓冲
  const spread = Math.max(Number(cfg.spreadMin) || 0.001, feeBuffer, 0.0002);
  const half = money4(spread / 2);
  let askMin = money4(mid + half);                            // 机器人卖：不得低于此价
  let bidMax = money4(mid - half);                            // 机器人买：不得高于此价
  if (bidMax < 0.0001) bidMax = 0.0001;                       // 兜到交易所允许的最低价
  if (askMin <= bidMax) askMin = money4(bidMax + Math.max(0.0001, half));
  return { mid, askMin, bidMax, spread: money4(askMin - bidMax) };
}

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
  const EXW_COL = 'shanhai_ex_wallet';
  // money4 已提到模块级（做市定价模型 marketPrices 也要用）  // 交易所内部 4 位小数（0.0001 精度）

  async function ensureFund(db, cfg) {
    let f = await db.collection(FUND_COL).findOne({ _id: 'market' });
    if (!f) {
      await db.collection(FUND_COL).updateOne({ _id: 'market' },
        { $setOnInsert: { _id: 'market', lingqi: cfg.fundLingqi, lingqiFrozen: 0, createdAt: new Date() } }, { upsert: true });
      f = await db.collection(FUND_COL).findOne({ _id: 'market' });
    }
    // 【v26.4】机器人的现金额度一次性注入「交易所钱包」（幂等）
    // 【2026-09-24 修复】标记改为 FUND_COL 里 _id 唯一的占位文档，原子抢占——
    // 原先"查 shanhai_logs 标记再注入"是读-判-写，冷启动并发（定时器+管理页同时触发）会双倍注资
    const seeded = await db.collection(FUND_COL).findOneAndUpdate(
      { _id: 'market_seed_ex' },
      { $setOnInsert: { _id: 'market_seed_ex', cash: cfg.fundCash, at: new Date() } },
      { upsert: true, returnDocument: 'before' }
    );
    if (!seeded || !(seeded.value || seeded)) {
      // 抢到占位文档（此前无标记）→ 本次由我注入
      if (cfg.fundCash > 0) {
        await db.collection(EXW_COL).updateOne({ userId: BOT_ID },
          { $inc: { balance: cfg.fundCash }, $set: { updatedAt: new Date() } }, { upsert: true });
      }
      await db.collection('shanhai_logs').insertOne({ action: 'market_seed_ex', detail: { cash: cfg.fundCash }, createdAt: new Date() }).catch(() => { });
    }
    return f;
  }
  // 机器人交易所钱包（余额 / 冻结 / 可用）
  async function botWallet(db) {
    const w = await db.collection(EXW_COL).findOne({ userId: BOT_ID });
    const balance = money4((w || {}).balance || 0);
    const frozen = money4((w || {}).frozen || 0);
    return { balance, frozen, available: money4(balance - frozen) };
  }
  const botBalance = async db => (await botWallet(db)).balance;

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
  // 【v26.15】区间变更自愈：价格跑出 [min,max] 的自家旧单立即撤掉退冻结。
  // 用户改了价格区间后，旧区间时代挂的单还挂在市场上（比如 0.0005 < 新下限 0.001），
  // 行情/列表看起来就像"价格没夹住"。逐张退冻结，不吃资产。
  async function cancelOutOfRange(db, cfg) {
    const min = Number(cfg.priceMin) || 0.0001;
    const max = Number(cfg.priceMax) || 0.18;
    const stale = await db.collection(ORD_COL)
      .find({ userId: BOT_ID, status: 'open',
        $or: [{ price: { $lt: min } }, { price: { $gt: max } }] })
      .limit(50).toArray();
    if (!stale.length) return { cancelled: 0 };
    let backLingqi = 0;
    for (const o of stale) {
      if (o.side === 'sell' && o.left > 0) backLingqi += o.left;
      else if (o.side === 'buy' && (o.locked || 0) > 0) {
        await db.collection(EXW_COL).updateOne({ userId: BOT_ID },
          { $inc: { frozen: -o.locked }, $set: { updatedAt: new Date() } });
      }
    }
    if (backLingqi) {
      await db.collection(FUND_COL).updateOne({ _id: 'market' }, { $inc: { lingqi: backLingqi, lingqiFrozen: -backLingqi } });
    }
    await db.collection(ORD_COL).updateMany(
      { _id: { $in: stale.map(o => o._id) } },
      { $set: { status: 'cancel', left: 0, locked: 0, updatedAt: new Date() } });
    console.log('[market] 区间变更：回收越界挂单 %d 张，退回灵气 %d', stale.length, backLingqi);
    return { cancelled: stale.length };
  }

  async function recycleStaleBotOrders(db) {
    const deadline = new Date(Date.now() - BOT_ORDER_TTL_MS);
    const stale = await db.collection(ORD_COL)
      .find({ userId: BOT_ID, status: 'open', createdAt: { $lt: deadline } }).limit(30).toArray();
    if (!stale.length) return { recycled: 0 };
    let backLingqi = 0;
    for (const o of stale) {
      if (o.side === 'sell' && o.left > 0) backLingqi += o.left;
      else if (o.side === 'buy' && (o.locked || 0) > 0) {
        // 【v26.4】退的是交易所钱包的冻结（钱仍在交易所，不回主站）
        await db.collection(EXW_COL).updateOne({ userId: BOT_ID },
          { $inc: { frozen: -o.locked }, $set: { updatedAt: new Date() } });
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
  async function oneTrade(db, cfg, center) {
    const side = Math.random() < 0.5 ? 'sell' : 'buy';       // 机器人这一笔想「卖灵气」还是「买灵气」
    // 【v26.5】价格不再在整段区间里乱撒，而是按「中间价 ± 半个价差」分别生成：
    //   机器人卖 → [askMin, askMin×1.35]      机器人买 → [bidMax×0.65, bidMax]
    // 这样无论随机到多少，卖价永远高于买价，玩家无法低买高卖套利。
    const pr = marketPrices(cfg, center);
    // 【v26.17 修复·机器人不挂单根因】报价必须落在配置区间 [priceMin, priceMax] 内：
    // 中枢游走到区间边缘（或管理员设的区间很窄）时，卖价 askMin×1.35 会越过 priceMax、
    // 买价 bidMax×0.65 会跌破 priceMin —— 挂出去的单每轮都被末尾的 cancelOutOfRange
    // 立刻撤掉，表现就是"启动机器人后既没有卖单也没有买单"（行情却还在动，因为 simMatch 只写台账）。
    // 处理：卖价夹到 [askMin, max]（区间窄到 askMin>max 时取 max）；买价夹到 [min, bidMax]
    // （bidMax<min 时取 min）。夹紧后卖价 > 买价仍然成立（askMin ≥ bidMax 恒成立，见 marketPrices）。
    const rangeMin = Number(cfg.priceMin) || 0.0001;
    const rangeMax = Number(cfg.priceMax) || 0.18;
    let price = side === 'sell'
      ? money4(Math.min(rangeMax, Math.max(pr.askMin, pr.askMin * (1 + Math.random() * 0.35))))
      : money4(Math.max(rangeMin, Math.min(pr.bidMax, pr.bidMax * (1 - Math.random() * 0.35))));
    const amount = rndInt(cfg.amountMin, cfg.amountMax);
    const fund = await ensureFund(db, cfg);
    // 【v26.4】机器人花的钱来自它的「交易所钱包」可用余额（余额 − 挂单冻结）
    const bw = await botWallet(db);
    const bal = bw.available;
    const col = db.collection(ORD_COL);

    // 找对手方：机器人卖 → 吃买单；机器人买 → 吃卖单。玩家优先，没有再考虑自己
    const oppSide = side === 'sell' ? 'buy' : 'sell';
    const oppSort = { price: side === 'sell' ? -1 : 1, createdAt: 1 };
    let target = await col.findOne(
      { side: oppSide, status: 'open', left: { $gt: 0 }, userId: { $nin: [BOT_ID, null] } },
      { sort: oppSort });
    let selfDeal = false;
    // 【v26.11】官方护盘：没人来玩时机器人可以自己吃自己的挂单。
    // 这样成交量、挂单深度都是真的（走势图与流动性都靠它），资产在自己账上转一圈，
    // 净损耗只有手续费。玩家挂单一进来仍然优先成交。
    if (!target && cfg.selfDeal !== false) {
      target = await col.findOne(
        { userId: BOT_ID, side: oppSide, status: 'open', left: { $gt: 0 } },
        { sort: oppSort });
      selfDeal = !!target;
    }
    // 【v26.14】玩家挂价不在机器人模型区间 → 不吃这一口，但**不放弃本轮**：
    // 清掉 target 让流程自然落到挂单分支，正常补自己的单。原来直接 skipped 一轮白跑，
    // 玩家挂得高机器人就傻等——市场流通不起来（用户原话"让机器人灵活一点"）。
    if (target && !selfDeal) {
      const b = side === 'buy';
      if (b && target.price > pr.bidMax) target = null;
      else if (!b && target.price < pr.askMin) target = null;
    }

    if (target) {
      const n = Math.min(amount, target.left);
      const total = money4(n * target.price);   // 【v26.4.4】成交额同样按 4 位结算
      const fee = money4(total * 0.005);
      const botIsBuyer = side === 'buy';        // 机器人买 → 机器人付钱
      // 【v26.5 关键保护】成交价用的是「玩家的挂单价」，所以必须先用机器人自己的定价模型
      // 校验这张单值不值得吃：
      //   机器人买 → 只吃单价 ≤ bidMax 的卖单；机器人卖 → 只吃单价 ≥ askMin 的买单。
      // 没有这道校验，玩家只要挂一张离谱高价（比如 0.99）的卖单、而市场上恰好只有他这一张，
      // 机器人就会真的按 0.99 买走 —— 等于把定价权交给挂单人。
      // 【v26.11】护盘自成交不受"买价上限/卖价下限"约束——那是防玩家套利的护栏，
      // 机器人吃自己的单不存在套利问题（钱和灵气都在自己账上转一圈）。
      // （价格校验已在查询后提前做过，不合适的单走不到这里）
      if (selfDeal) return await selfDealTrade(db, cfg, target, amount, side);
      // 机器人能力校验
      if (botIsBuyer && bal < total) return { skipped: 'bot_no_cash' };
      if (!botIsBuyer && (fund.lingqi || 0) < n) return { skipped: 'bot_no_lingqi' };
      // 【v26.3.1 兼容】v26.3 之前挂出的求购单没冻结余额，机器人吃这种老单时要走实时扣款——
      // 但得先确认那个玩家真有钱，否则扣出一笔负数余额
      const targetLegacyBuy = !botIsBuyer && !(target.locked > 0);
      if (targetLegacyBuy) {
        const pw = await db.collection(EXW_COL).findOne({ userId: target.userId });
        const pAvail = money4(((pw || {}).balance || 0) - ((pw || {}).frozen || 0));
        if (pAvail < total) return { skipped: 'buyer_no_cash' };
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
        const sellerGet = money4(total - fee);
        if (botIsBuyer) {
          // 机器人是主动买家：从它的交易所余额扣钱；玩家的卖单是冻结状态，解冻后转出
          await db.collection(EXW_COL).updateOne({ userId: BOT_ID },
            { $inc: { balance: -total }, $set: { updatedAt: new Date() } }, { upsert: true });
          await prof.updateOne({ userId: playerId }, { $inc: { lingqiFrozen: -n }, $set: { updatedAt: new Date() } });
        } else {
          // 机器人是卖家：收钱进交易所钱包；对手方是玩家挂的求购单，由他付钱
          await db.collection(EXW_COL).updateOne({ userId: BOT_ID },
            { $inc: { balance: sellerGet }, $set: { updatedAt: new Date() } }, { upsert: true });
          await prof.updateOne({ userId: playerId }, { $inc: { lingqi: n }, $set: { updatedAt: new Date() } });
          if (targetLegacyBuy) {
            // 从未冻结过的老求购单：从玩家的交易所余额实时扣
            await db.collection(EXW_COL).updateOne({ userId: playerId },
              { $inc: { balance: -total }, $set: { updatedAt: new Date() } }, { upsert: true });
          } else if (target.exLocked) {
            // 新求购单（v26.4 起）：解冻 + 扣款，同一笔里完成
            await db.collection(EXW_COL).updateOne({ userId: playerId },
              { $inc: { frozen: -total, balance: -total }, $set: { updatedAt: new Date() } }, { upsert: true });
            await col.updateOne({ _id: target._id }, { $inc: { locked: -total } });
          } else {
            // 【v26.4 兼容】v26.4 之前挂的求购单：钱已在主站扣过，只冲减订单冻结额
            await col.updateOne({ _id: target._id }, { $inc: { locked: -total } });
          }
        }
        if (botIsBuyer) {
          await db.collection(EXW_COL).updateOne({ userId: playerId },
            { $inc: { balance: sellerGet }, $set: { updatedAt: new Date() } }, { upsert: true });
        }
        // 手续费只落在台账（deals.fee），不进主站 wallet_log
      } catch (e) {
        await col.updateOne({ _id: target._id }, { $inc: { left: n } }).catch(() => { });
        return { skipped: 'settle_error' };
      }
      // 结单：求购单把残余零头退回（买家已冻结的钱按实际成交冲减，剩下的不该一直冻着）
      if (after.left <= 0) {
        const fresh = await col.findOne({ _id: target._id });
        const residual = target.side === 'buy' ? money2((fresh || {}).locked || 0) : 0;
        await col.updateOne({ _id: target._id }, { $set: { status: 'done', locked: 0, updatedAt: new Date() } });
        // 【2026-09-24 修复】残余退款按订单冻结位置退——
        // v26.4+ 的求购单（exLocked）钱冻在交易所钱包 frozen 里，应解冻退回交易所；
        // 原先一律 writeLog 写进主站 wallet_log：既没解冻（玩家的钱永远冻死）又给主站余额凭空加钱
        if (residual > 0) {
          if (target.exLocked) {
            await db.collection(EXW_COL).updateOne(
              { userId: target.userId }, { $inc: { frozen: -residual }, $set: { updatedAt: new Date() } });
          } else {
            await writeLog(db, target.userId, residual, 'exchange_unlock', `求购单结清退回 ¥${residual}`, String(target._id), {});
          }
        }
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
    // 【v26.10 修】原来"同价位已有单"直接放弃这一笔。价格区间一窄（4 位小数下可选价位
    // 可能只有几十个），机器人很快就把价位占满 → 每笔都撞车 → 全场零成交、走势图空白。
    // 现在：先按最小步长微调重试几次，实在撞就允许同价位并存（但最多 2 张，不至于挂成一排）。
    // 【v26.15】步长按区间跨度自适应：0.001-0.002 用 0.0001，更窄的区间（如 0.0001-0.0002）
    // 用 0.00001——支持更细的小数，不设上限
    // 【v26.17 修复】微调步进同样夹回区间内：原来步进方向朝区间外走（卖价向上/买价向下），
    // 走出 [min,max] 的单又会被 cancelOutOfRange 撤掉，越调越少
    const STEP = Math.max(0.00001, money4((rangeMax - rangeMin) / 500));
    let finalPrice = price;
    for (let k = 0; k < 6; k++) {
      const cnt = await col.countDocuments({ userId: BOT_ID, side, status: 'open', price: finalPrice });
      if (cnt < 2) break;
      const nx = money4(finalPrice + (side === 'sell' ? STEP : -STEP) * (k + 1));
      if (nx <= 0) break;
      finalPrice = Math.max(rangeMin, Math.min(rangeMax, nx));
    }
    if (finalPrice !== price) price = finalPrice;   // 用微调后的价挂出
    const totalNew = money4(amount * price);
    if (side === 'sell') {
      if ((fund.lingqi || 0) < amount) return { skipped: 'bot_no_lingqi' };
      await db.collection(FUND_COL).updateOne({ _id: 'market' }, { $inc: { lingqi: -amount, lingqiFrozen: amount } });
    } else {
      // 【v26.4】机器人挂求购单冻结的是它自己的交易所钱包（与玩家同一口径）
      if (bal < totalNew) return { skipped: 'bot_no_cash' };
      await db.collection(EXW_COL).updateOne({ userId: BOT_ID },
        { $inc: { frozen: totalNew }, $set: { updatedAt: new Date() } }, { upsert: true });
    }
    await col.insertOne({
      userId: BOT_ID, username: '做市灵傀', side, amount, left: amount, price,
      locked: side === 'buy' ? totalNew : 0,
      status: 'open', bot: true, createdAt: new Date(), updatedAt: new Date(),
    });
    return { posted: { side, amount, price } };
  }

  // ==================== 【v26.5.1】数据自动清理 ====================
  // 交易所是持续产数据的（机器人每分钟 1~5 笔），免费 MongoDB 容量有限，必须定期收口。
  //   ① 机器人**已结束**的订单（成交完/已撤销）只留最近 50 条
  //   ② 玩家已结束的订单留最近 200 条（在挂的 open 单一条都不动）
  //   ③ 成交台账留最近 3000 条（后台对账够用），另外把 90 天前的彻底清掉
  // 注意：只删「已结束」的订单，open 状态的挂单永远不碰。
  let lastCleanupAt = 0;   // 上次清理时间戳（每小时最多清一次）
  async function trimCollection(db, colName, filter, keepCount, sortField) {
    const col = db.collection(colName);
    const total = await col.countDocuments(filter);
    if (total <= keepCount) return 0;
    const keep = await col.find(filter, { projection: { _id: 1 } })
      .sort({ [sortField]: -1 }).limit(keepCount).toArray();
    const keepIds = keep.map(x => x._id);
    const r = await col.deleteMany(Object.assign({}, filter, { _id: { $nin: keepIds } }));
    return r.deletedCount || 0;
  }
  async function cleanupOldData(db) {
    const report = {};
    report.botOrders = await trimCollection(db, ORD_COL, { userId: BOT_ID, status: { $ne: 'open' } }, 50, 'createdAt');
    report.playerOrders = await trimCollection(db, ORD_COL, { userId: { $ne: BOT_ID }, status: { $ne: 'open' } }, 200, 'createdAt');
    report.deals = await trimCollection(db, DEAL_COL, {}, 3000, 'createdAt');
    const cutoff = new Date(Date.now() - 90 * 86400000);
    const rd = await db.collection(DEAL_COL).deleteMany({ createdAt: { $lt: cutoff } }).catch(() => ({ deletedCount: 0 }));
    report.dealsOlderThan90d = rd.deletedCount || 0;
    return report;
  }
  mountShanhaiMarket.cleanupOldData = cleanupOldData;

  // ==================== 【v26.9】价格中枢：随机游走 + 均值回归 ====================
  // 之前中枢固定 = 区间中点，行情永远是一条平线，玩家一眼看出是假的。
  // 现在每轮推进一次中枢：
  //   ① 随机游走：±volatility%（默认 3%）
  //   ② 均值回归：向基准价拉回 8%，防止无限漂走
  //   ③ 5% 概率的"行情脉冲"：3 倍幅度波动，制造趋势段
  //   ④ 夹在 [priceMin, priceMax] 内，永不越界
  async function nextCenter(db, cfg) {
    const min = Number(cfg.priceMin) || 0.0001;
    const max = Number(cfg.priceMax) || 0.18;
    const base = money4((min + max) / 2);
    const vol = Math.max(0.1, Math.min(30, Number(cfg.volatility) || 3));
    let c = base;
    const doc = await db.collection(CFG_COL).findOne({ _id: 'market' }).catch(() => null);
    const saved = Number(doc && doc.priceCenter);
    if (saved && Number.isFinite(saved) && saved > 0) c = money4(saved);
    const patch = { priceCenter: c, centerAt: new Date() };

    // 【v26.10】插针：管理员设了 spikePct/spikeRounds 时，中枢直接钉死在
    // base×(1+spikePct%)，持续 spikeRounds 轮后自动恢复常规逻辑（用于"砸盘/拉盘"演示）
    const spikePct = Number(cfg.spikePct) || 0;
    const spikeRounds = Math.max(0, Math.floor(Number(cfg.spikeRounds) || 0));
    let spikeLeft = Number(doc && doc.spikeLeft);
    if (!Number.isFinite(spikeLeft)) spikeLeft = spikeRounds;
    if (spikePct !== 0 && spikeLeft > 0) {
      c = money4(base * (1 + spikePct / 100));
      patch.priceCenter = money4(Math.max(min, Math.min(max, c)));
      patch.spikeLeft = spikeLeft - 1;
      await db.collection(CFG_COL).updateOne({ _id: 'market' }, { $set: patch }, { upsert: true }).catch(() => { });
      return patch.priceCenter;
    }

    // 【v26.10】剧本：[{pct:20,rounds:10},{pct:-15,rounds:10}] —— "先涨 20%，再跌 15%"
    const script = Array.isArray(cfg.script) ? cfg.script.filter(s => s && Number(s.pct) !== undefined) : [];
    if (script.length) {
      let idx = Math.max(0, Math.min(script.length - 1, Number(doc && doc.scriptIdx) || 0));
      let left = Number(doc && doc.scriptLeft);
      if (!Number.isFinite(left) || left <= 0) left = Math.max(1, Math.floor(Number(script[idx].rounds) || 10));
      const seg = script[idx];
      const target = money4(base * (1 + (Number(seg.pct) || 0) / 100));
      c = money4(c + (target - c) * 0.3);                                        // 向本段目标推进 30%
      c = money4(c * (1 + (Math.random() * 2 - 1) * (vol / 100) * 0.5));         // 叠加小幅噪声，别太机械
      left -= 1;
      if (left <= 0) {
        idx = (idx + 1) % script.length;
        left = Math.max(1, Math.floor(Number(script[idx].rounds) || 10));
      }
      patch.scriptIdx = idx;
      patch.scriptLeft = left;
    } else {
      c = money4(c * (1 + (Math.random() * 2 - 1) * (vol / 100)));          // ① 游走
      c = money4(c + (base - c) * 0.08);                                     // ② 回归
      if (Math.random() < 0.05) {                                            // ③ 脉冲
        c = money4(c * (1 + (Math.random() * 2 - 1) * (vol / 100) * 3));
      }
      // 【v26.14】买卖压力驱动：最近 10 分钟买单量 > 卖单量 → 中枢被顶着微涨，反之微跌。
      // 你说的"涨跌幅根据买卖单进行"——走势不只靠随机，也真实反映市场买卖力量。
      try {
        const since = new Date(Date.now() - 600000);
        const agg = await db.collection(DEAL_COL).aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: '$side', q: { $sum: '$amount' } } }
        ]).toArray();
        const buy = (agg.find(x => x._id === 'buy') || {}).q || 0;
        const sell = (agg.find(x => x._id === 'sell') || {}).q || 0;
        if (buy + sell > 0) {
          const pressure = (buy - sell) / (buy + sell);                      // -1 ~ 1
          c = money4(c * (1 + pressure * 0.02));                             // 最大 ±2% 偏移
        }
      } catch (e) { }
    }
    c = money4(Math.max(min, Math.min(max, c)));                           // ④ 夹逼
    patch.priceCenter = c;
    await db.collection(CFG_COL).updateOne(
      { _id: 'market' }, { $set: patch }, { upsert: true }).catch(() => { });
    return c;
  }

  // ==================== 【v26.10】做市撮合（保证行情曲线不空白） ====================
  // 机器人不能和自己成交（卖价永远高于买价，且 ord.userId===me 会被拦），
  // 所以只要没人来玩，成交量就永远是 0，走势图一片空白。
  // 这里让机器人做一笔"演习撮合"：**只写台账、资产净变化≈0**，
  // 目的是让价格曲线有真实的数据点。后台台账用 sim:true 标记，与真实成交区分。
  async function simMatch(db, cfg, center) {
    const pr = marketPrices(cfg, center);
    const n = rndInt(cfg.amountMin, cfg.amountMax);
    // 演习价取买卖中值的邻域：略偏一侧，让曲线有起伏而不是一条平线
    const mid = money4((pr.askMin + pr.bidMax) / 2);
    const jitter = (Math.random() * 2 - 1) * (pr.spread || 0.001) * 0.4;
    const price = money4(Math.max(0.0001, mid + jitter));
    const total = money4(n * price);
    const fee = money4(total * EX_FEE);
    await db.collection(DEAL_COL).insertOne({
      orderId: null, side: Math.random() < 0.5 ? 'sell' : 'buy',
      amount: n, price, total, fee,
      buyerId: BOT_ID, sellerId: BOT_ID,
      bot: true, mode: 'player', sim: true,
      buyerName: '做市', sellerName: '做市',
      createdAt: new Date(),
    });
    // 资产净变化≈0：灵气与钱各在自己账上走一圈（卖出所得与买入付出同为机器人）
    return { dealt: true, sim: true, amount: n, price };
  }

  // ==================== 【v26.11】官方护盘：机器人吃自己的挂单 ====================
  // 目的：没人来玩时也要有真实成交量与挂单深度（走势图、流动性都靠它）。
  // 资产在机器人自己的两个账本之间转，净损耗只有手续费：
  //   吃自己的卖单 → 灵气出库、钱入库
  //   吃自己的买单 → 钱出库、灵气入库
  async function selfDealTrade(db, cfg, ord, amount, side) {
    const col = db.collection(ORD_COL);
    const n = Math.min(amount, ord.left);
    const total = money4(n * ord.price);
    const fee = money4(total * EX_FEE);
    const tk = await col.findOneAndUpdate(
      { _id: ord._id, status: 'open', left: { $gte: n } },
      { $inc: { left: -n }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' });
    const after = tk && (tk.value || tk);
    if (!after) return { skipped: 'self_race' };
    const botIsBuyer = side === 'buy';
    try {
      if (botIsBuyer) {
        // 自己的卖单被买走：冻结的灵气出库，货款（扣手续费）进交易所钱包
        await db.collection(FUND_COL).updateOne(
          { _id: 'market' }, { $inc: { lingqiFrozen: -n }, $set: { updatedAt: new Date() } }, { upsert: true });
        await db.collection(EXW_COL).updateOne(
          { userId: BOT_ID }, { $inc: { balance: money4(total - fee) }, $set: { updatedAt: new Date() } }, { upsert: true });
      } else {
        // 自己的买单被卖：冻结的钱付出去，灵气进机器人额度
        await db.collection(EXW_COL).updateOne(
          { userId: BOT_ID }, { $inc: { frozen: -total, balance: -total }, $set: { updatedAt: new Date() } }, { upsert: true });
        await db.collection(FUND_COL).updateOne(
          { _id: 'market' }, { $inc: { lingqi: n }, $set: { updatedAt: new Date() } }, { upsert: true });
      }
      if (after.left <= 0) await col.updateOne({ _id: ord._id }, { $set: { status: 'done', updatedAt: new Date() } });
      await db.collection(DEAL_COL).insertOne({
        orderId: String(ord._id), side: ord.side, amount: n, price: ord.price, total, fee,
        buyerId: BOT_ID, sellerId: BOT_ID, bot: true, mode: 'player', self: true,
        buyerName: '护盘', sellerName: '护盘', createdAt: new Date(),
      }).catch(() => { });
      return { dealt: true, self: true, amount: n, price: ord.price, total };
    } catch (e) {
      console.error('[market] 护盘自成交失败', e);
      await col.updateOne({ _id: ord._id }, { $inc: { left: n } }).catch(() => { });   // 还原余量
      return { skipped: 'self_fail' };
    }
  }

  async function runRound() {
    try {
      const db = await getDb();
      // 【v26.4.1】总闸关闭时机器人也停：维护中不该继续产生成交
      const sw = await db.collection(CFG_COL).findOne({ _id: 'exchange' });
      if (sw && sw.enabled === false) return { skipped: 'exchange_closed' };
      const cfg = await loadCfg(db);
      if (!cfg.enabled) return { skipped: 'disabled' };
      await ensureFund(db, cfg);
      const n = rndInt(Math.min(cfg.tradesMin, cfg.tradesMax), Math.max(cfg.tradesMin, cfg.tradesMax));
      const res = [];
      // 【v26.9】本轮先推进一次价格中枢，这一轮所有笔共用同一个中枢（同轮内价格连贯）
      const center = await nextCenter(db, cfg);
      for (let i = 0; i < n; i++) {
        res.push(await oneTrade(db, cfg, center));
        await new Promise(r => setTimeout(r, 300));   // 稍微错开，避免同一秒挤在一起
      }
      // 【v26.10】真实成交为 0 时补一笔"做市撮合"：否则没人来玩的那几个小时
      // 行情曲线会整段空白，走势图等于白做。
      if (res.filter(r => r.dealt).length === 0 && cfg.simMatch !== false) {
        const s = await simMatch(db, cfg, center).catch(() => null);
        if (s) res.push(s);
      }
      // 【v26.15】每轮顺手撤掉价格越出当前区间的自家旧单（改了区间立刻统一口径）
      await cancelOutOfRange(db, cfg).catch(() => { });
      const deals = res.filter(r => r.dealt).length;
      const posts = res.filter(r => r.posted).length;
      await db.collection(CFG_COL).updateOne({ _id: 'market' }, { $set: { lastRunAt: new Date(), lastSummary: { tried: n, deals, posts, skips: res.filter(r => r.skipped).map(r => r.skipped) } } }, { upsert: true }).catch(() => { });
      // 【v26.5.1】每小时顺手清一次历史数据（只清已结束的订单与过老的台账）
      if (Date.now() - lastCleanupAt > 3600000) {
        lastCleanupAt = Date.now();
        const cp = await cleanupOldData(db).catch(() => null);
        if (cp && (cp.botOrders || cp.playerOrders || cp.deals || cp.dealsOlderThan90d)) {
          console.log('[market] 数据清理：机器人订单 -%d / 玩家订单 -%d / 台账 -%d（90天前 -%d）',
            cp.botOrders, cp.playerOrders, cp.deals, cp.dealsOlderThan90d);
        }
      }
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
    // 【v26.5】启动时把报价模型打出来：线上日志能直接确认「卖价 > 买价」的护栏生效
    try {
      const db0 = await getDb();
      const c0 = await loadCfg(db0);
      const p0 = marketPrices(c0);
      console.log('[shanhai_market] 报价模型：卖单 ≥ ¥%s ｜ 买单 ≤ ¥%s ｜ 价差 ¥%s（防套利）',
        p0.askMin, p0.bidMax, p0.spread);
    } catch (e) { }
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
      const [humanAgg, botAgg, feeAgg, openCnt, botFund, botOpenOrders, humanOpenOrders] = await Promise.all([
        db.collection(DEAL_COL).aggregate([{ $match: { bot: { $ne: true } } }, { $group: { _id: null, cnt: { $sum: 1 }, total: { $sum: '$total' }, fee: { $sum: '$fee' } } }]).toArray(),
        db.collection(DEAL_COL).aggregate([{ $match: { bot: true } }, { $group: { _id: null, cnt: { $sum: 1 }, total: { $sum: '$total' }, fee: { $sum: '$fee' } } }]).toArray(),
        // 【v26.4】手续费不再写主站 wallet_log（保持主站口径干净），直接从成交台账聚合
        db.collection(DEAL_COL).aggregate([{ $group: { _id: null, fee: { $sum: '$fee' }, cnt: { $sum: 1 } } }]).toArray(),
        db.collection(ORD_COL).countDocuments({ status: 'open', left: { $gt: 0 } }),
        db.collection(FUND_COL).findOne({ _id: 'market' }),
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
          platformFeeTotal: money4((feeAgg[0] || {}).fee || 0),
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
      res.json({
        ok: true, cfg,
        prices: marketPrices(cfg),   // 【v26.5】机器人当前实际的「卖单最低价 / 买单最高价 / 价差」
        fund: { lingqi: fund.lingqi || 0, lingqiFrozen: fund.lingqiFrozen || 0 },
        balance: await botBalance(db), defaults: DEFAULT_CFG,
      });
    } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: '服务器开小差，请稍后再试' }); }
  });

  app.post('/api/shanhai/admin/market/config', auth, adminOnly, async (req, res) => {
    try {
      const db = await getDb();
      const b = req.body || {};
      // 【v26.4.4】num 支持指定小数位：原来硬编码 2 位，会把 0.0815 直接舍成 0.08。
      // 价格必须按 4 位收，才能和交易所的 0.0001 口径对齐。
      const num = (v, d, lo, hi, dp) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return d;
        const f = Math.pow(10, dp === undefined ? 2 : dp);
        return Math.round(Math.max(lo, Math.min(hi, n)) * f) / f;
      };
      // 【2026-09-24 修复】只处理请求里显式出现的字段——
      // 原先每个字段都用 num(v, 默认值) 生成，只传 volatility 一个字段时
      // 其余字段会被全部冲回默认值（管理员改一个参数、其他配置全丢）
      const patch = {};
      if (b.enabled !== undefined) patch.enabled = !!b.enabled;
      if (b.intervalSec !== undefined) patch.intervalSec = Math.round(num(b.intervalSec, 60, 15, 3600, 0));
      if (b.tradesMin !== undefined) patch.tradesMin = Math.round(num(b.tradesMin, 1, 1, 50, 0));
      if (b.tradesMax !== undefined) patch.tradesMax = Math.round(num(b.tradesMax, 5, 1, 50, 0));
      // 价格下限与交易所同口径：0.0001（不再是 0.01）
      if (b.priceMin !== undefined) patch.priceMin = num(b.priceMin, 0.06, 0.0001, 9999, 4);
      if (b.priceMax !== undefined) patch.priceMax = num(b.priceMax, 0.18, 0.0001, 9999, 4);
      if (b.spreadMin !== undefined) patch.spreadMin = num(b.spreadMin, 0.001, 0.0001, 9999, 4);
      if (b.volatility !== undefined) patch.volatility = num(b.volatility, 3, 0.1, 30, 1);
      if (b.amountMin !== undefined) patch.amountMin = Math.round(num(b.amountMin, 20, 1, 999999, 0));
      if (b.amountMax !== undefined) patch.amountMax = Math.round(num(b.amountMax, 500, 1, 999999, 0));
      if (patch.tradesMin && patch.tradesMax && patch.tradesMin > patch.tradesMax) {
        return res.status(400).json({ ok: false, error: '每轮最少笔数不能大于最多笔数' });
      }
      if (patch.priceMin && patch.priceMax && patch.priceMin >= patch.priceMax) {
        return res.status(400).json({ ok: false, error: '价格下限必须小于上限（否则算不出中间价，买卖盘会重叠）' });
      }
      // 区间太窄时中间价 ± 半个价差会越界，实际价差达不到要求 —— 提前拦下来
      if (patch.priceMin && patch.priceMax && patch.spreadMin) {
        const span = money4(patch.priceMax - patch.priceMin);
        if (span < money4(patch.spreadMin * 2)) {
          return res.status(400).json({
            ok: false,
            error: `价格区间太窄（跨度 ${span}）无法容纳价差 ${patch.spreadMin}，请把上下限拉开到至少 ${money4(patch.spreadMin * 2)} 的跨度`,
          });
        }
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
      // 【v26.4】补现金是往机器人的「交易所钱包」里补
      if (cash) await db.collection(EXW_COL).updateOne({ userId: BOT_ID },
        { $inc: { balance: cash }, $set: { updatedAt: new Date() } }, { upsert: true });
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
      let back = 0, backCash = 0;
      for (const o of bots) {
        if (o.side === 'sell' && o.left > 0) back += o.left;
        else if (o.side === 'buy' && (o.locked || 0) > 0) backCash += o.locked;
      }
      if (back) await db.collection(FUND_COL).updateOne({ _id: 'market' }, { $inc: { lingqi: back, lingqiFrozen: -back } });
      if (backCash) await db.collection(EXW_COL).updateOne({ userId: BOT_ID },
        { $inc: { frozen: -backCash }, $set: { updatedAt: new Date() } });
      await db.collection(ORD_COL).updateMany({ userId: BOT_ID, status: 'open' },
        { $set: { status: 'cancel', left: 0, locked: 0, updatedAt: new Date() } });
      res.json({ ok: true, cleared: bots.length, lingqiBack: back, cashBack: money4(backCash) });
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
