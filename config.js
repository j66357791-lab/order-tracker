// config.js — 全局配置与状态常量
export const CONFIG = {
  appVersion: '1.1.1',
  mongoUri: process.env.MONGO_URI ||
    'mongodb+srv://j66357791_db_user:hjh628727@cluster0.oiwbvje.mongodb.net/invest-jiedanyuan?retryWrites=true&w=majority',
  dbName: process.env.MONGO_DB || 'invest-jiedanyuan',
  collection: 'orders',
  port: process.env.PORT || 3000,
};

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
  { ver: '1.1.1', date: '2026-09-15', notes: ['【重要】修复缓存根疾：此前 js/css/图片被浏览器缓存30天且地址不变，导致部署新版后手机一直用旧资源', '山海：星星/横幅/头像框全部重绘（完美透明）', '山海：御剑五诀技能卡置顶展示', '山海：空装备槽显示半透明装备剪影', '装备页/关卡页实拍验收通过'] },
  { ver: '1.1.0', date: '2026-09-15', notes: ['聊天图片自动压缩（30MB上限）', '红包领取免手动刷新', '顶部邮箱改为广告入口', '游戏资源强制预下载+秒开缓存', '山海：新首页美术+装备图标+寻宝挪山海录', '御剑术玩法：初始飞剑+剑诀五技能', '新增：更新检查/缓存清理/资源包下载'] },
];
