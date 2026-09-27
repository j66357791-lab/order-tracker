"use strict";
// ===== 后端对接层 =====
const SH_TOKEN = LS.get("jdy_token", "");
if (!SH_TOKEN) location.href = "/login.html";
// 【v24.0】从写手端点进来的走 history.back()：写手端走 bfcache 恢复，不整页重载不闪白屏
// 【v24.1】sessionStorage 留标记 → 写手端恢复/加载后直接落在「活动」页签
function exitToWriter(){
  try { sessionStorage.setItem("writer_return_tab", "atGame"); } catch (e) {}
  try {
    if (document.referrer && document.referrer.indexOf("/writer.html") !== -1 && history.length > 1) { history.back(); return; }
  } catch (e) {}
  location.href = "/writer.html?tab=game";
}
async function shApi(path, opt = {}) {
  const r = await fetch(path, { ...opt, headers: { "Content-Type": "application/json", Authorization: "Bearer " + SH_TOKEN, ...(opt.headers || {}) } });
  if (r.status === 401) { LS.remove("jdy_token"); LS.remove("jdy_user"); location.href = "/login.html"; throw new Error("未登录"); }
  // 【v26.34】404/5xx 带上失败的接口路径——报错即定位，不用再猜是哪个请求出的问题
  if (r.status === 404 || r.status >= 500) {
    const d = await r.json().catch(() => ({}));
    throw new Error((d.error || "请求失败") + " [" + r.status + " " + path + "]");
  }
  return r.json();
}
function fmtT(s) { s = Math.round(s); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
