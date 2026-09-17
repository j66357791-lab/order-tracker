// lib/db.js — Mongo 连接与索引初始化
import { MongoClient, ObjectId } from 'mongodb';
import { CONFIG } from '../config.js';

export let indexReady = false;
let dbPromise = null;

async function getDb() {
  if (!dbPromise) {
    // 【2026-09-17 修复】连接失败时把 dbPromise 置回 null——
    // 原实现会把失败的 Promise 永久缓存，之后所有请求永远 500，只能重启进程恢复
    dbPromise = new MongoClient(CONFIG.mongoUri, { serverSelectionTimeoutMS: 15000 })
      .connect()
      .then((c) => c.db(CONFIG.dbName))
      .catch((e) => { dbPromise = null; throw e; });
  }
  const db = await dbPromise;
  // 首次访问时建索引：按日期查/排序、按状态筛、按完单日查、按编号搜索，各走各的索引
  if (!indexReady) {
    indexReady = true;
    db.collection(CONFIG.collection).createIndexes([
      { key: { date: -1 } },
      { key: { status: 1 } },
      { key: { doneDate: 1 } },
      { key: { orderNo: 1 } },
      { key: { date: -1, _id: -1 } },
    ]).catch((e) => console.warn('[db] 建索引失败(orders)', e?.message || e));
    // 派单模块索引
    db.collection('users').createIndexes([{ key: { username: 1 }, unique: true }])
      .catch((e) => console.warn('[db] 建索引失败(users.username 唯一索引，重复用户名将失去兜底)', e?.message || e));
    db.collection('invites').createIndexes([{ key: { code: 1 }, unique: true }])
      .catch((e) => console.warn('[db] 建索引失败(invites)', e?.message || e));
    db.collection('messages').createIndexes([
      { key: { conversation: 1, createdAt: -1 } },
      // 聊天信息云端只保留3天，到期自动删除（客户端本地localStorage兜底留存）
      { key: { createdAt: 1 }, expireAfterSeconds: 3 * 24 * 3600 },
    ]).catch((e) => console.warn('[db] 建索引失败(messages)', e?.message || e));
    db.collection('cards').createIndexes([{ key: { to: 1, createdAt: -1 } }, { key: { orderId: 1 } }, { key: { createdAt: -1 } }, { key: { to: 1, status: 1 } }])
      .catch((e) => console.warn('[db] 建索引失败(cards)', e?.message || e));
    // 【2026-09-17 补充】防重复领取类唯一索引：签到每天一次、月度奖励每月一次、提现同一用户同一时刻仅一笔待审
    db.collection('checkin_records').createIndexes([{ key: { userId: 1, date: 1 }, unique: true }])
      .catch((e) => console.warn('[db] 建索引失败(checkin_records)', e?.message || e));
    db.collection('monthly_claims').createIndexes([{ key: { userId: 1, month: 1 }, unique: true }])
      .catch((e) => console.warn('[db] 建索引失败(monthly_claims)', e?.message || e));
    // 【2026-09-17 补充】提现申请原子性兜底：一个用户最多一笔"待处理"申请，并发重复提交会被唯一索引挡下
    db.collection('withdrawals').createIndexes(
      [{ key: { userId: 1, status: 1 }, unique: true, partialFilterExpression: { status: '待处理' } }]
    ).catch((e) => console.warn('[db] 建索引失败(withdrawals)', e?.message || e));
    // 【2026-09-17 补充】LV1 月度奖励一个用户一月只发一次（partial：只约束带 kind 标记的新记录，不影响历史数据）
    db.collection('wallet_log').createIndexes(
      [{ key: { userId: 1, month: 1 }, unique: true, partialFilterExpression: { kind: 'lv1_bonus' } }]
    ).catch((e) => console.warn('[db] 建索引失败(wallet_log)', e?.message || e));
    // 【二次复核补充】工号唯一（partial：只约束已有工号的文档）——防并发注册发到同一个号
    db.collection('users').createIndexes(
      [{ key: { uid: 1 }, unique: true, partialFilterExpression: { uid: { $gt: null } } }]
    ).catch((e) => console.warn('[db] 建索引失败(users.uid，历史重复工号需先清洗)', e?.message || e));
    // 【二次复核补充】一个订单终身只拆一次红包的唯一兜底（原 11000 捕获是死代码）
    db.collection('redpacket_records').createIndexes(
      [{ key: { userId: 1, cardId: 1 }, unique: true }]
    ).catch((e) => console.warn('[db] 建索引失败(redpacket_records，历史重复需先清洗)', e?.message || e));
    // 【二次复核补充】一个身份证只能绑定一个账号（partial：只约束已实名的文档）
    db.collection('users').createIndexes(
      [{ key: { 'realname.idHash': 1 }, unique: true, partialFilterExpression: { 'realname.idHash': { $gt: null } } }]
    ).catch((e) => console.warn('[db] 建索引失败(realname.idHash，历史重复需先清洗)', e?.message || e));
    // 【2026-09-14 需求修正】单单拆红包：一个订单终身一次 → 迁移旧索引(userId+cardId+date)到 (userId+cardId)

  }
  return db;
}

export { getDb };
