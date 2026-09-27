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
      // 【2026-09-26 修复】顺序问题：原来是「先剥行内注释、再判引号」，
      // 于是 JWT_SECRET="ab # cd" 会先被 ' #' 截成 "ab，再判引号时已不成对（结尾是 b 不是 "），
      // 最终密钥变成带一个前引号的 "ab —— 静默改变配置值，表现为"能登录但说不清为什么"。
      // 现在：带引号先按引号取内容（引号之后的内容视为注释丢弃），不带引号才剥 ' #' 注释。
      const quote = v[0];
      if (quote === '"' || quote === "'") {
        const end = v.indexOf(quote, 1);
        v = end > 0 ? v.slice(1, end) : v.slice(1);   // 只有前引号（写漏了结尾）→ 去掉引号字符，值保留
      } else {
        const h = v.indexOf(' #');
        if (h !== -1) v = v.slice(0, h).trim();
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      if (process.env[k] === undefined) process.env[k] = v;   // 系统环境变量优先
    }
    console.log('[env] 已加载 ' + envPath);
  }
} catch (e) {
  console.warn('[env] .env 读取失败（忽略）:', e.message);
}

// 启动自检用：只报告是否配置，绝不打印值（这些都会进部署日志）
export const envReport = () => ({
  JWT_SECRET: !!process.env.JWT_SECRET,
  MONGO_URI: !!process.env.MONGO_URI,
  TRUST_PROXY: process.env.TRUST_PROXY === '1',
  // 下面几项代码里都会读，但历史上没写进 .env.example —— 一并纳入自检，
  // 避免"我以为关了/配了，实际根本没配"这类排查半天才发现的口径错位
  REALNAME_HASH_KEY: String(process.env.REALNAME_HASH_KEY || '').trim().length >= 16,
  OCR_ENABLED: process.env.OCR_ENABLED === undefined ? '(默认开)' : (process.env.OCR_ENABLED === '0' ? '0（已全部转人工）' : '1'),
  OCR_HEAVY: process.env.OCR_HEAVY === '1',
  OCR_WARMUP: process.env.OCR_WARMUP === '1',
});
