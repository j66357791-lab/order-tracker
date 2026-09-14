// server.js — 入口（ES6 模块化架构 v4 · 2026-09-14）
// 职责只剩：装配中间件 → 挂载各业务模块 → 启动 HTTP/WebSocket
// 业务代码全部拆分至 routes/ 与 lib/，游戏在 games.js / shanhai_game.js
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { Server } from 'socket.io';
import { ObjectId, GridFSBucket } from 'mongodb';

import { CONFIG, STATUSES } from './config.js';
import { getDb } from './lib/db.js';
import {
  JWT_SECRET, signToken, publicUser, auth, adminOnly,
  cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr,
  sha256hex, captchaStore, verifyCaptcha,
  cleanReplyTo, nextUid, assignUid, pairKey, makeNotify,
} from './lib/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_LIMIT = 100 * 1024 * 1024;
const app = express();
app.use(express.json({ limit: '120mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '30d',
  setHeaders: (res, p) => { if (p.endsWith('.html') || p.endsWith('.json')) res.setHeader('Cache-Control', 'no-cache'); },
}));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: FILE_LIMIT,
  pingInterval: 20000, pingTimeout: 25000,
  transports: ['websocket', 'polling'],
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: FILE_LIMIT } });
const notify = makeNotify(io);
let gridBucket = null;
const makeBucket = async () => { const db = await getDb(); gridBucket = gridBucket || new GridFSBucket(db, { bucketName: 'files' }); return gridBucket; };

// ---- PWA / 深链 ----
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'public/manifest.json')));
app.get('/.well-known/assetlinks.json', (req, res) => res.sendFile(path.join(__dirname, 'public/.well-known/assetlinks.json')));

// ---- 业务模块（顺序保持原版语义：核心表在鉴权后、活动中心在前） ----
const ctx = { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt: (await import('bcryptjs')).default, gridBucket, makeBucket };
(await import('./routes/orders.js')).default(ctx);
(await import('./routes/user.js')).default(ctx);
(await import('./routes/ads.js')).default(ctx);
// 活动中心（签到/红包/月度）
try {
  (await import('./routes/activity.js')).default(app, { auth, getDb, cnDayStr, cnMonthStr, notify });
  console.log('[活动] 签到/红包/月度路由已挂载（routes/activity.js）');
} catch (e) { console.error('[活动] 模块加载失败:', e.message); }
(await import('./routes/misc.js')).default(ctx);
(await import('./routes/authx.js')).default(ctx);
(await import('./routes/cards.js')).default(ctx);
(await import('./routes/worktime.js')).default(ctx);
(await import('./routes/gameadmin.js')).default(ctx);
// ---- 游戏模块 ----
try {
  (await import('./games.js')).default(app, { auth, getDb, cnDayStr });
  console.log('[游戏] 魔法翻翻乐模块已挂载');
} catch (e) { console.error('[游戏] 翻翻乐加载失败:', e.message); }
try {
  (await import('./shanhai_game.js')).default(app, { auth, getDb });
  console.log('[游戏] 山海斩妖录模块已挂载');
} catch (e) { console.error('[游戏] 山海加载失败:', e.message); }

// ---- 兜底与启动 ----
app.use((req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));
server.listen(CONFIG.port, () => {
  console.log(`订单统计系统V10（ES6模块化）已启动: http://localhost:${CONFIG.port}`);
  console.log(`架构: server.js 入口 + config.js + lib/{db,core}.js + routes/ 8 个业务模块 + 2 个游戏模块`);
});
