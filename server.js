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

import { CONFIG, CHANGELOG } from './config.js';
import { getDb } from './lib/db.js';
import {
  JWT_SECRET, signToken, publicUser, auth, adminOnly,
  cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr,
  sha256hex, captchaStore, verifyCaptcha, rnd, ymOf, toMin, cnTimeStr,
  cleanReplyTo, nextUid, assignUid, pairKey, makeNotify,
} from './lib/core.js';
import { STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_LIMIT = 100 * 1024 * 1024;
const app = express();
app.use(express.json({ limit: '120mb' }));
app.use(express.urlencoded({ extended: true }));
// 【2026-09-16】根路径直达用户端落地页
app.get('/', (req, res) => res.redirect('/portal.html'));

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '30d',   // 图片等长期缓存（引用带 ?v= 版本化，换图换URL）
  setHeaders: (res, p) => {
    // 【2026-09-15c 缓存根治】html/json/js/css 一律 no-cache（ETag 秒级再验证）
    // ——此前 js/css 30d 缓存 + URL 不变，导致部署新版本后老客户端一直用旧逻辑
    if (/\.(html|json|js|css|webmanifest)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
  },
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

// ---- 部署自检（关键前端文件指纹：部署后一查便知是否传全） ----
app.get('/api/deploy-check', async (req, res) => {
  try {
    const { createHash } = await import('crypto');
    const { readFile } = await import('fs/promises');
    const files = [
      'public/writer.html', 'public/game.html', 'public/index.html', 'public/portal.html',
      'public/member.html', 'public/admin_packages.html', 'public/login.html',
      'public/games/shanhai/index.html', 'public/games/shanhai/css/style.css',
      'public/games/shanhai/js/weapons.js', 'public/games/shanhai/js/game.js',
      'public/games/shanhai/js/config.js', 'public/games/shanhai/js/meta.js',
      'public/games/shanhai/js/ui.js', 'public/games/shanhai/js/assets.js',
    ];
    const out = {};
    for (const f of files) {
      try {
        const buf = await readFile(path.join(__dirname, f));
        out[f.split('/').pop()] = { kb: Math.round(buf.length / 1024), sha8: createHash('sha256').update(buf).digest('hex').slice(0, 8) };
      } catch (e) { out[f] = { MISSING: true }; }
    }
    res.json({ ok: true, version: CONFIG.appVersion, files: out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- 版本信息（前端进入时自动检查更新） ----
app.get('/api/version', (req, res) => res.json({ ok: true, version: CONFIG.appVersion, changelog: CHANGELOG }));

// ---- PWA / 深链 ----
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'public/manifest.json')));
app.get('/.well-known/assetlinks.json', (req, res) => res.sendFile(path.join(__dirname, 'public/.well-known/assetlinks.json')));

// ---- 业务模块（activity 先挂：其导出的 unfreezeRedpackets 供 user/cards 打款链路使用） ----
const activityMod = await import('./routes/activity.js');
const unfreezeRedpackets = activityMod.unfreezeRedpackets;
const contract = await import('./routes/misc.js');
const bcrypt = (await import('bcryptjs')).default;
const jwt = (await import('jsonwebtoken')).default;
const ctx = { app, auth, adminOnly, getDb, notify, upload, CONFIG, signToken, publicUser, ObjectId, cacheGet, cacheSet, cacheClear, cnDayStr, cnMonthStr, cnNow, cnDateStr, sha256hex, captchaStore, verifyCaptcha, nextUid, assignUid, pairKey, cleanReplyTo, io, bcrypt, gridBucket, makeBucket,
  rnd, ymOf, toMin, cnTimeStr, JWT_SECRET, jwt, STATUSES, DONE_STATUSES, CARD_STATUSES, normalizeStatus, normCard, localToday,
  CONTRACT_VERSION: contract.CONTRACT_VERSION, CONTRACT_TITLE: contract.CONTRACT_TITLE, CONTRACT_TEXT: contract.CONTRACT_TEXT,
  unfreezeRedpackets };
try {
  activityMod.default(app, { auth, getDb, cnDayStr, cnMonthStr, notify, ObjectId, CONFIG, normalizeStatus });
  console.log('[活动] 签到/红包/月度路由已挂载（routes/activity.js）');
} catch (e) { console.error('[活动] 模块加载失败:', e.message); }
(await import('./routes/orders.js')).default(ctx);
(await import('./routes/user.js')).default(ctx);
(await import('./routes/ads.js')).default(ctx);
(await import('./routes/misc.js')).default(ctx);
(await import('./routes/authx.js')).default(ctx);
(await import('./routes/cards.js')).default(ctx);
(await import('./routes/worktime.js')).default(ctx);
(await import('./routes/gameadmin.js')).default(ctx);
(await import('./routes/portal.js')).default(app, ctx);
// ---- 游戏模块 ----
try {
  (await import('./games.js')).default(app, { auth, getDb, cnDayStr });
  console.log('[游戏] 魔法翻翻乐模块已挂载');
} catch (e) { console.error('[游戏] 翻翻乐加载失败:', e.message); }
try {
  (await import('./shanhai_game.js')).default(app, { auth, getDb });
  console.log('[游戏] 山海斩妖录模块已挂载');
} catch (e) { console.error('[游戏] 山海加载失败:', e.message); }


// —— uid 补齐迁移（旧账号无 uid 时分配）——
(async () => {
  try {
    const db = await getDb();
    const miss = await db.collection('users').find({ uid: null }).limit(50).toArray();
    for (const u of miss) await assignUid(db, u._id);
  } catch (e) { console.error('uid补齐失败:', e.message); }
})();

// ---- 兜底与启动 ----
app.use((req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));
server.listen(CONFIG.port, () => {
  console.log(`订单统计系统V10（ES6模块化）已启动: http://localhost:${CONFIG.port}`);
  console.log(`架构: server.js 入口 + config.js + lib/{db,core}.js + routes/ 8 个业务模块 + 2 个游戏模块`);
});
