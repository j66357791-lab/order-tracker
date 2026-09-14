// config.js — 全局配置与状态常量
export const CONFIG = {
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
