// config.js — 全局配置与状态常量
// 【V17 安全改动】数据库连接串不再硬编码，一律从环境变量读取（服务器后台或 .env 文件）。
//   必填：MONGO_URI   —— 数据库连接串
//   建议：JWT_SECRET  —— 登录令牌密钥（见 lib/core.js）
export const CONFIG = {
  appVersion: '1.4.0',
  mongoUri: process.env.MONGO_URI || '',
  dbName: process.env.MONGO_DB || 'invest-jiedanyuan',
  collection: 'orders',
  port: process.env.PORT || 3000,
};

// 启动自检：数据库连接串没配就直接停下，避免服务起来了却连不上库、报一堆看不懂的错
export function assertConfig() {
  if (!String(process.env.MONGO_URI || '').trim()) {
    console.error('============================================================');
    console.error('[配置] 没有检测到环境变量 MONGO_URI，无法连接数据库，服务已停止。');
    console.error('');
    console.error('  怎么配（任选一种）：');
    console.error('  1) 在服务器环境变量里加一条：');
    console.error('       MONGO_URI = mongodb+srv://用户名:密码@集群地址/数据库名?retryWrites=true&w=majority');
    console.error('     Render：控制台 → 选中你的服务 → Environment → Add Environment Variable');
    console.error('     宝塔：Node 项目 → 环境变量');
    console.error('  2) 在项目根目录新建 .env 文件，写一行：MONGO_URI=上面那串');
    console.error('');
    console.error('  提示：这串地址原来写在 config.js 里，需要你从旧文件或 MongoDB Atlas');
    console.error('       后台重新拿一次（建议顺便更换数据库密码）。');
    console.error('============================================================');
    process.exit(1);
  }
}

// 状态定义：「已交付」=「待结算」（旧数据自动归一化）
export const STATUSES = ['待开始', '进行中', '待结算', '已结算'];
export const DONE_STATUSES = ['待结算', '已结算'];   // 完单口径
export const CARD_STATUSES = ['待接单', '已接单', '待审核', '待打款', '已完成', '已拒绝', '已驳回'];
export const normalizeStatus = (s) => (s === '已交付' ? '待结算' : (STATUSES.includes(s) ? s : null));
export const normCard = (c) => ({ ...c, status: c.status === '已交付' ? '待打款' : c.status });
export const localToday = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// 【2026-09-15】版本与更新日志（/api/version 供前端检查更新）
export const CHANGELOG = [
  { ver: '1.4.0', date: '2026-09-16', notes: ['用户端宣传页交互改版：进站丝滑入场动画、登录注册口袋式开合弹窗、作品×能做什么合并成一块（分类切换 + 案例左右滑动）、小沐AI 改为右下角悬浮窗', '案例新增分类字段，后台「作品管理」可选择分类', '部署自检升级：覆盖 37 个文件，接口直接列出缺失的文件', '【安全】数据库连接串改为环境变量读取，不再硬编码在代码里'] },
  { ver: '1.2.2', date: '2026-09-16', notes: ['【重要修复】登录失败：新登录口漏了主体系的密码SHA-256预哈希约定，导致老账号全部对不上——已修并双兼容', '统一登录回到原登录页（保留人机验证），登录后按身份自动分流', '注册邀请码改为选填：不填=用户端，填写=写手（带人机验证）', 'portal 顶栏登录/注册按钮直接跳转，不再用弹窗'] },
  { ver: '1.2.1', date: '2026-09-16', notes: ['统一登录：网站宣传端一个入口，管理员/写手/用户登录自动分流', '统一注册：选填邀请码——填了进写手端，不填进用户端', '管理功能归位：dispatch.html 为管理员后台（+套餐/台账入口），index.html 纯台账', '山海：技能条中文修复（御剑术+剑诀层数）、原版横幅恢复、飞剑加剑光拖尾、卸武器保留基础攻击5'] },
  { ver: '1.2.0', date: '2026-09-16', notes: ['全新用户端上线：文案馆/接单介绍卡组/套餐方案/小沐AI/个人中心', '网站首页直达用户端，用户可开放注册', '写手注册仅限邀请码，旧账号登录自动分流到对应端', '管理员端新增：用户端套餐配置+用户咨询跟进', '新增部署自检接口 /api/deploy-check（治上传不完整）', '山海：飞剑玩法与美术复验通过'] },
  { ver: '1.1.1', date: '2026-09-15', notes: ['【重要】修复缓存根疾：此前 js/css/图片被浏览器缓存30天且地址不变，导致部署新版后手机一直用旧资源', '山海：星星/横幅/头像框全部重绘（完美透明）', '御剑五诀技能卡置顶展示', '山海：空装备槽显示半透明装备剪影', '装备页/关卡页实拍验收通过'] },
  { ver: '1.1.0', date: '2026-09-15', notes: ['聊天图片自动压缩（30MB上限）', '红包领取免手动刷新', '顶部邮箱改为广告入口', '游戏资源强制预下载+秒开缓存', '山海：新首页美术+装备图标+寻宝挪山海录', '御剑术玩法：初始飞剑+剑诀五技能', '新增：更新检查/缓存清理/资源包下载'] },
];
