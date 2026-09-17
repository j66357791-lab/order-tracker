import { ObjectId as _ObjectId } from 'mongodb';
// routes/activity.js — 活动模块（签到 / 单单拆红包 / 月度活动）
// 【2026-09-14v2 架构瘦身】从 server.js 抽出，行为不变
// 挂载：require('./routes/activity')(app, { auth, getDb, cnDayStr, cnMonthStr, notify });
import { ObjectId } from 'mongodb';

export default function mountActivity(app, deps) {
  const { auth, getDb, cnDayStr, cnMonthStr, notify } = deps;
  D = Object.assign({}, deps);   // ObjectId/CONFIG/normalizeStatus 由 server.js 装配时一并传入 deps


// ---- 每日签到 ----
// GET /api/activity/checkin - 获取签到状态
app.get('/api/activity/checkin', auth, async (req, res) => {
  try {
    const db = await getDb();
    const today = cnDayStr(new Date());
    const month = today.slice(0, 7);
    const userId = req.user.id;
    // 今日是否已签
    const todayRec = await db.collection('checkin_records').findOne({ userId, date: today });
    // 【2026-09-14 需求】返回签到资格（当天接过单）
    const dayStart2 = new Date(today + 'T00:00:00+08:00');
    const takenCnt = await db.collection('cards').countDocuments({
      to: userId,
      $or: [ { acceptedAt: { $gte: dayStart2 } }, { createdAt: { $gte: dayStart2 }, status: { $in: ['已接单', '待审核', '待打款', '已完成'] } } ]
    });
    // 月历
    const monthRecs = await db.collection('checkin_records').find({ userId, date: { $regex: '^' + month } }).toArray();
    const signedDays = monthRecs.map(r => r.date);
    // 连续签到天数
    let streak = 0;
    let d = new Date();
    while (true) {
      const ds = cnDayStr(d);
      const rec = await db.collection('checkin_records').findOne({ userId, date: ds });
      if (rec) { streak++; d.setDate(d.getDate() - 1); }
      else break;
    }
    res.json({ ok: true, today: today, signedToday: !!todayRec, todayAmount: todayRec ? todayRec.amount : 0, streak, signedDays, month, eligible: takenCnt > 0 });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// POST /api/activity/checkin - 签到
app.post('/api/activity/checkin', auth, async (req, res) => {
  try {
    const db = await getDb();
    const today = cnDayStr(new Date());
    const userId = req.user.id;
    const existing = await db.collection('checkin_records').findOne({ userId, date: today });
    if (existing) return res.status(400).json({ ok: false, error: '今日已签到' });
    // 【2026-09-14 需求】现金签到资格：当天接过单的写手（当天新建派单 或 手上有进行中订单）
    const dayStart = new Date(today + 'T00:00:00+08:00');
    const taken = await db.collection('cards').countDocuments({
      to: userId,
      $or: [ { acceptedAt: { $gte: dayStart } }, { createdAt: { $gte: dayStart }, status: { $in: ['已接单', '待审核', '待打款', '已完成'] } } ]
    });
    if (!taken) return res.status(400).json({ ok: false, error: '今日接单后才能参与现金签到' });
    // 概率：99.99% 得 0.01~0.1，0.01% 得 1~5
    let amount;
    if (Math.random() < 0.0001) {
      amount = Math.round((1 + Math.random() * 4) * 100) / 100; // 1~5
    } else {
      amount = Math.round((0.01 + Math.random() * 0.09) * 100) / 100; // 0.01~0.10
    }
    // 连续天数
    let streak = 1;
    let yd = new Date(); yd.setDate(yd.getDate() - 1);
    const ydStr = cnDayStr(yd);
    const ydRec = await db.collection('checkin_records').findOne({ userId, date: ydStr });
    if (ydRec) {
      // 计算连续天数
      let d = new Date(); let s = 1;
      while (true) { d.setDate(d.getDate() - 1); const rec = await db.collection('checkin_records').findOne({ userId, date: cnDayStr(d) }); if (rec) s++; else break; }
      streak = s;
    }
    // 【2026-09-17 修复】并发双击兜底：唯一索引(userId+date)拦截同一秒内的重复签到
    try {
      await db.collection('checkin_records').insertOne({ userId, date: today, amount, streak, createdAt: new Date() });
    } catch (e) {
      if (e.code === 11000) return res.status(400).json({ ok: false, error: '今日已签到' });
      throw e;
    }
    // 入账 wallet_log
    await db.collection('wallet_log').insertOne({ userId, month: cnMonthStr(new Date()), amount, note: '每日签到', createdAt: new Date() });
    res.json({ ok: true, amount, streak });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// ---- 单单拆红包 ----
// 【2026-09-14 需求修正】一个订单终身只能拆一次现金红包（不再按天刷新）；
// 拆得金额进入冻结余额，等关联订单完结（派单卡打款完成 或 台账订单已结算）后解冻入账
// GET /api/activity/redpacket - 获取可拆红包的订单
app.get('/api/activity/redpacket', auth, async (req, res) => {
  try {
    const db = await getDb();
    const userId = req.user.id;
    // 审核通过（待打款）的订单
    const cards = await db.collection('cards').find({
      to: userId, status: '待打款',
      approvedAt: { $exists: true }
    }).toArray();
    // 历史已拆记录（终身维度，不看日期）
    const opened = await db.collection('redpacket_records').find({ userId }).toArray();
    const openedCardIds = opened.map(r => String(r.cardId));
    // 未拆过的订单 = 可拆（一个订单终身一次）
    const available = cards.filter(c => !openedCardIds.includes(String(c._id))).map(c => ({
      cardId: c._id, title: c.title, reward: c.reward, approvedAt: c.approvedAt
    }));
    // 已拆但冻结中（等待订单完结解冻）
    const frozen = opened.filter(r => r.status === '冻结').map(r => ({
      cardId: String(r.cardId), amount: r.amount, title: r.title
    }));
    res.json({ ok: true, available, frozen });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// POST /api/activity/redpacket/:cardId - 拆红包
// 【2026-09-14 终修】解冻路由必须先于 :cardId 注册——否则 'unfreeze' 被当作 cardId 解析直接500
// 手动检查解冻入口（写手端拆红包后顺带调用）
app.post('/api/activity/redpacket/unfreeze', auth, async (req, res) => {
  try {
    const db = await getDb();
    const unlocked = await unfreezeRedpackets(db, req.user.id);
    res.json({ ok: true, unlocked });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});
app.post('/api/activity/redpacket/:cardId', auth, async (req, res) => {
  try {
    const db = await getDb();
    const userId = req.user.id;
    const cardId = req.params.cardId;
    const today = cnDayStr(new Date());
    // 检查是否已拆（终身一次：不限日期）
    // 【2026-09-14 修复】cardId 类型对齐（库里存 ObjectId，字符串查永远落空）+ 查重
    const existing = await db.collection('redpacket_records').findOne({ userId, cardId: new ObjectId(String(cardId)) });
    if (existing) return res.status(400).json({ ok: false, error: '该订单已拆过红包，一个订单仅可拆一次' });
    // 检查订单状态
    const card = await db.collection('cards').findOne({ _id: new ObjectId(cardId), to: userId });
    if (!card) return res.status(404).json({ ok: false, error: '订单不存在' });
    if (card.status !== '待打款') return res.status(400).json({ ok: false, error: '只有待打款状态的订单可拆红包' });
    // 【2026-09-14v2 修复】金额分层幸运档：用户反馈"金额异常/都一样"
    // 旧算法 reward×1%~10% 均匀随机 → 小订单全是 0.5~2 元的相近小数，观感差
    // 新算法：保底 0.30 元起，幸运档位差异化（运营可控成本上限）
    const luck = Math.random();
    let rate, luckTag;
    if (luck < 0.55)      { rate = 0.02 + Math.random() * 0.03; luckTag = '普通'; }   // 55%  2%~5%
    else if (luck < 0.85) { rate = 0.05 + Math.random() * 0.05; luckTag = '小吉'; }   // 30%  5%~10%
    else if (luck < 0.97) { rate = 0.10 + Math.random() * 0.08; luckTag = '中吉'; }   // 12%  10%~18%
    else                  { rate = 0.18 + Math.random() * 0.12; luckTag = '大吉'; }   // 3%   18%~30%
    const reward = card.reward || 0;
    let amount = Math.round(Math.max(0.30, reward * rate) * 100) / 100;
    const cap = Math.round(Math.max(1.00, reward * 0.5) * 100) / 100;   // 单包上限：订单额一半（至少1元）
    if (amount > cap) amount = cap;
    try {
      await db.collection('redpacket_records').insertOne({
        userId, cardId: card._id, title: card.title, orderReward: card.reward,
        amount, rate: Math.round(rate * 10000) / 100, status: '冻结',
        date: today, createdAt: new Date()
      });
    } catch (e) {
      if (e.code === 11000) return res.status(400).json({ ok: false, error: '该订单已拆过红包（并发拦截）' }); // 并发双击兜底
      throw e;
    }
    res.json({ ok: true, amount, rate: Math.round(rate * 100) / 100, luckTag, title: card.title, orderReward: reward });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// 【2026-09-14 需求修正】红包解冻统一入口：
// 解冻条件 = 派单卡已完成（打款）或 关联台账订单已结算（订单完结）；
// 供「打款接口」自动触发 + 写手端手动检查入口调用；幂等（历史重复拆的脏记录只按最早一笔入账）

// ---- 月度活动 ----
// GET /api/activity/monthly - 获取月度活动进度
app.get('/api/activity/monthly', auth, async (req, res) => {
  try {
    const db = await getDb();
    const userId = req.user.id;
    const month = cnMonthStr(new Date());
    const monthStart = month + '-01';
    // 本月已完成订单金额
    const cards = await db.collection('cards').find({
      to: userId, status: '已完成',
      paidAt: { $gte: new Date(monthStart + 'T00:00:00+08:00') }
    }).toArray();
    const earned = Math.round(cards.reduce((s, c) => s + (c.reward || 0), 0) * 100) / 100;
    const target = 500;
    const reward = 8.88;
    // 是否已领
    const claimed = await db.collection('monthly_claims').findOne({ userId, month });
    res.json({ ok: true, month, earned, target, reward, claimed: !!claimed, claimable: earned >= target && !claimed });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

// POST /api/activity/monthly/claim - 领取月度奖励
app.post('/api/activity/monthly/claim', auth, async (req, res) => {
  try {
    const db = await getDb();
    const userId = req.user.id;
    const month = cnMonthStr(new Date());
    const monthStart = month + '-01';
    const existing = await db.collection('monthly_claims').findOne({ userId, month });
    if (existing) return res.status(400).json({ ok: false, error: '本月奖励已领取' });
    const cards = await db.collection('cards').find({
      to: userId, status: '已完成',
      paidAt: { $gte: new Date(monthStart + 'T00:00:00+08:00') }
    }).toArray();
    const earned = cards.reduce((s, c) => s + (c.reward || 0), 0);
    if (earned < 500) return res.status(400).json({ ok: false, error: '本月接单金额未满500元' });
    const reward = 8.88;
    // 【2026-09-17 修复】并发双击兜底：唯一索引(userId+month)拦截重复领取
    try {
      await db.collection('monthly_claims').insertOne({ userId, month, reward, claimedAt: new Date() });
    } catch (e) {
      if (e.code === 11000) return res.status(400).json({ ok: false, error: '本月奖励已领取' });
      throw e;
    }
    await db.collection('wallet_log').insertOne({ userId, month, amount: reward, note: '月度活动奖励', createdAt: new Date() });
    res.json({ ok: true, reward });
  } catch (e) { console.error('[api]', e); res.status(500).json({ ok: false, error: e.userFacing ? e.message : '服务器开小差，请稍后再试' }); }
});

}

// 打款链路共用：订单完结后自动解冻该写手冻结红包
// 模块级依赖注入（mount 时填充；打款链路 user/cards 模块共用本函数）
let D = { ObjectId: null, CONFIG: null, normalizeStatus: null, cnMonthStr: null, notify: null };

export async function unfreezeRedpackets(db, userId) {
  const { ObjectId, CONFIG, normalizeStatus, cnMonthStr, notify } = D;
  const frozen = await db.collection('redpacket_records').find({ userId, status: '冻结' }).sort({ createdAt: 1 }).toArray();
  let unlocked = 0;
  const paidCardIds = new Set();   // 本轮已入账订单（重复拆的历史脏数据只按最早一笔算）
  for (const r of frozen) {
    const cid = String(r.cardId);
    const card = await db.collection('cards').findOne({ _id: r.cardId });
    let done = false;
    if (card) {
      if (card.status === '已完成') done = true;
      else if (card.orderId) {
        try {
          if (ObjectId.isValid(String(card.orderId))) {
            const o = await db.collection(CONFIG.collection).findOne({ _id: new ObjectId(String(card.orderId)) });
            if (o && normalizeStatus(o.status) === '已结算') done = true;   // 关联订单完结
          }
        } catch (e3) { /* orderId 非法格式：跳过订单关联检查 */ }
      }
    }
    if (done) {
      // 【2026-09-14 修复】幂等：同订单已入过账（本轮或历史）的重复记录作废，不再入账
      const paid = paidCardIds.has(cid) || await db.collection('wallet_log').findOne({ userId, note: '红包奖励-' + (r.title || ''), cardId: cid });
      if (paid) {
        await db.collection('redpacket_records').updateOne({ _id: r._id }, { $set: { status: '已作废', note: '重复拆包记录' } });
        continue;
      }
      // 【二次复核修正】原"查重→无条件改状态→入账"三步非原子，打款自动触发与手动解冻并发时
      // 同一红包会重复入账两次（真金流水）——改为条件更新抢占，只有改成功的那个请求入账
      const claim = await db.collection('redpacket_records').updateOne(
        { _id: r._id, status: '冻结' },
        { $set: { status: '已解冻', unlockedAt: new Date() } });
      if (!claim.modifiedCount) { paidCardIds.add(cid); continue; }
      await db.collection('wallet_log').insertOne({ userId, month: cnMonthStr(new Date()), amount: r.amount, note: '红包奖励-' + r.title, cardId: cid, createdAt: new Date() });
      paidCardIds.add(cid);
      try { notify(r.userId, 'msg', { title: '红包到账', content: '「' + (r.title || '') + '」订单完结，现金红包 ¥' + r.amount + ' 已解冻入账，可在钱包中查看。' }); } catch (e2) {}
      unlocked++;
    }
  }
  return unlocked;
}
