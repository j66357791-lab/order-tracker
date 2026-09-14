// lib/db.js — Mongo 连接与索引初始化
import { MongoClient, ObjectId } from 'mongodb';
import { CONFIG } from '../config.js';

export let indexReady = false;
let dbPromise = null;

async function getDb() {
  if (!dbPromise) {
    dbPromise = new MongoClient(CONFIG.mongoUri, { serverSelectionTimeoutMS: 15000 })
      .connect()
      .then((c) => c.db(CONFIG.dbName));
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
    ]).catch(() => {});
    // 派单模块索引
    db.collection('users').createIndexes([{ key: { username: 1 }, unique: true }]).catch(() => {});
    db.collection('invites').createIndexes([{ key: { code: 1 }, unique: true }]).catch(() => {});
    db.collection('messages').createIndexes([
      { key: { conversation: 1, createdAt: -1 } },
      // 聊天信息云端只保留3天，到期自动删除（客户端本地localStorage兜底留存）
      { key: { createdAt: 1 }, expireAfterSeconds: 3 * 24 * 3600 },
    ]).catch(() => {});
    db.collection('cards').createIndexes([{ key: { to: 1, createdAt: -1 } }, { key: { orderId: 1 } }, { key: { createdAt: -1 } }, { key: { to: 1, status: 1 } }]).catch(() => {});
    // 【2026-09-14 需求修正】单单拆红包：一个订单终身一次 → 迁移旧索引(userId+cardId+date)到 (userId+cardId)

  }
  return db;
}

export { getDb };
