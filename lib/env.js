// lib/env.js — 极简 .env 加载（不引第三方依赖）
// 必须在 server.js 的最前面 import，这样 config.js / core.js 读 process.env 时已经就绪。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dir, '..', '.env');

try {
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 1) continue;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      if (process.env[k] === undefined) process.env[k] = v;   // 系统环境变量优先
    }
    console.log('[env] 已加载 ' + envPath);
  }
} catch (e) {
  console.warn('[env] .env 读取失败（忽略）:', e.message);
}

// 启动自检用：只报告是否配置，不打印值
export const envReport = () => ({
  JWT_SECRET: !!process.env.JWT_SECRET,
  MONGO_URI: !!process.env.MONGO_URI,
  TRUST_PROXY: process.env.TRUST_PROXY === '1',
});
