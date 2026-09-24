// meta.js — 养成状态管理（服务端档案 + 本地缓存 + 加成计算）
// 【2026-09-14】斩妖录·贰：仙玉/灵气双货币 + 6槽装备 + 背包
"use strict";
const META = (() => {
  let profile = null;
  let stageStars = {};
  let stamina = { cur: 10, cap: 10, cost: 1, nextInSec: 0, atCap: true };   // 【v24.9】体力
  // 装备分解价（一阶基础：凡 5 / 良 10 / 上 20 / 仙 50 / 神 100 仙玉；高阶按 tier 递增）
  const DISMANTLE_BASE = { white: 5, green: 10, blue: 20, purple: 50, gold: 100 };
  function dismantlePrice(it) {
    const base = DISMANTLE_BASE[(it && it.quality) || "white"] || 5;
    const tier = Math.max(1, Math.min(9, (it && it.tier) | 0 || 1));
    return Math.round(base * (1 + 0.5 * (tier - 1)));
  }

  // —— 加成计算（战斗读这里） ——
  // 装备词条：武器=攻击% 衣服=生命% 发冠=经验% 腰带=拾取范围% 鞋子=移速% 配饰=全伤害%
  function bonus() {
    const p = profile || {};
    const sl = p.skillLv || { fireline: 0, icepick: 0, body: 0 };
    const eq = p.equip || {};
    const V = k => (eq[k] ? (eq[k].val || 0) / 100 : 0);
    const atkMul = 1 + V("weapon");
    const out = {
      atkMul,
      hpMul: 1 + V("armor"),
      fireMul: atkMul + sl.fireline * 0.06,
      iceMul: atkMul + sl.icepick * 0.06,
      bodyHpMul: 1 + sl.body * 0.08 + V("armor"),
      fireScale: 1 + (sl.fireline * 0.12),                // 火羽视觉大小
      iceCount: 1 + (sl.icepick >= 3 ? 1 : 0),            // 3层冰锥+1枚
      expMul: 1 + V("crown"),                             // 发冠：经验获取
      pickupMul: 1 + V("belt"),                           // 腰带：拾取范围
      moveMul: 1 + V("boots"),                            // 鞋子：移速
      dmgMul: 1 + V("accessory"),                         // 配饰：全伤害
    };
    // 【v26.11】流派天赋叠加：把已学节点的 eff 汇总进加成。
    // 有现成通道的直接生效（攻击/移速/血量/拾取/经验）；暴击/闪避/护盾/攻速/玩法类
    // 塞进 facRaw，由战斗引擎按需读取（crit 判定已接 hero.critBonus）。
    try {
      const fc = factionCache;
      if (fc && fc.current) {
        const f = (fc.factions || []).find(x => x.id === fc.current);
        const my = (fc.talents || {})[fc.current] || {};
        if (f) {
          const acc = {};
          for (const b of (f.branches || [])) {
            for (const n of (b.nodes || [])) {
              const lv = +my[n.id] || 0;
              if (!lv) continue;
              for (const [k, v] of Object.entries(n.eff || {})) acc[k] = (acc[k] || 0) + (+v) * lv;
            }
          }
          out.dmgMul += (acc.atk || 0) / 100;
          out.moveMul += (acc.moveSpd || 0) / 100;
          out.hpMul += (acc.hp || 0) / 100;
          out.pickupMul += (acc.pickRange || 0) / 100;
          out.expMul += (acc.expRate || 0) / 100;
          out.facRaw = acc;      // crit/dodge/shield/atkSpd/summon/… 交给对局按需消费
        }
      }
    } catch (e) { }
    return out;
  }

  async function shApi(url, body) {
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + localStorage.getItem("jdy_token") },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { location.href = "/login.html"; throw { error: "未登录" }; }
    const d = await r.json();
    if (!d.ok) throw d;
    return d;
  }

  async function load() {
    const d = await shApi("/api/shanhai/profile");
    profile = d.profile;
    // 【v26.11】流派数据预取：startRun() 里 bonus() 要叠加天赋加成，开局就得有
    shApi("/api/shanhai/faction").then(x => { if (x && x.ok) factionCache = x; }).catch(() => { });
    if (d.stamina) stamina = d.stamina;   // 【v24.9】
    return profile;
  }
  async function report(win, stage) {
    const h = Game.hero;
    if (!h) return null;
    try {
      const d = await shApi("/api/shanhai/result", {
        win, stage,
        timeSec: Math.floor(h.timeAlive || 0),
        kills: h.kills || 0,
        level: h.level || 1,
        dmgTaken: Math.round(h.dmgTaken || 0),
        // 【v24.5】星级按剩余血量：满血 3 星 / ≥60% 2 星 / <60% 1 星
        hpPct: +Math.max(0, Math.min(1, (h.hp || 0) / (h.maxHp || 1))).toFixed(3),
      });
      profile = Object.assign({}, profile, d.balance ? { xianyu: d.balance.xianyu, lingqi: d.balance.lingqi } : {});
      if (d.stars) stageStars[stage] = d.stars;
      // 【v24.5】档案里的星级图（跨设备）合并进本地
      if (d.stageStars) stageStars = Object.assign({}, d.stageStars, stageStars);
      return d;
    } catch (e) { return null; }
  }
  async function upgradeSkill(key) { return shApi("/api/shanhai/upgrade", { key }); }
  async function draw() { return shApi("/api/shanhai/draw", {}); }
  async function equip(itemId) { return shApi("/api/shanhai/equip", { itemId }); }
  async function unequip(slot) { return shApi("/api/shanhai/unequip", { slot }); }
  // 【v24.7】挂机收益：预览 / 领取 / 凑齐整把钥匙兑换进翻翻乐
  async function idleInfo() { return shApi("/api/shanhai/idle"); }
  async function idleClaim() { return shApi("/api/shanhai/idle/claim", {}); }
  async function idleCraft() { return shApi("/api/shanhai/idle/craft", {}); }
  // 【v24.9】体力（挑战扣 1）与装备分解
  async function staminaInfo() { const d = await shApi("/api/shanhai/stamina"); if (d.stamina) stamina = d.stamina; return stamina; }
  async function consumeStamina() { const d = await shApi("/api/shanhai/stamina/consume", {}); if (d.stamina) stamina = d.stamina; return d; }
  async function dismantle(itemId) { return shApi("/api/shanhai/dismantle", { itemId }); }
  // 【v26.0】灵气交易所：行情 / 挂单 / 成交 / 撤单
  async function exBoard() { return shApi("/api/shanhai/exchange/board"); }
  async function exPublish(side, amount, price) { return shApi("/api/shanhai/exchange/publish", { side, amount, price }); }
  async function exDeal(orderId, amount) { return shApi("/api/shanhai/exchange/deal", { orderId, amount }); }
  async function exCancel(orderId) { return shApi("/api/shanhai/exchange/cancel", { orderId }); }
  // 【v26.11】流派与天赋树
  let factionCache = null;
  async function factionInfo() {
    const d = await shApi("/api/shanhai/faction");
    if (d && d.ok) factionCache = d;               // 缓存给 bonus() 叠天赋用
    return d;
  }
  async function factionSelect(id) { return shApi("/api/shanhai/faction/select", { id }); }
  async function talentLearn(factionId, nodeId) { return shApi("/api/shanhai/talent/learn", { factionId, nodeId }); }
  // 【v26.9】价格走势（range: 1d / 7d / 30d / all）
  async function exChart(range) { return shApi("/api/shanhai/exchange/chart?range=" + encodeURIComponent(range || "1d")); }
  // 【v26.4】交易所独立钱包：主站余额 ⇄ 交易所余额
  async function exDeposit(amount) { return shApi("/api/shanhai/exchange/deposit", { amount }); }
  // all=true：全部转出（后端按分取整，不足 0.01 的零头留在交易所）
  async function exWithdraw(amount, all) { return shApi("/api/shanhai/exchange/withdraw", { amount, all: !!all }); }
  // 【v26.4】灵气矿脉（每日产出）
  async function lingqiInfo() { return shApi("/api/shanhai/lingqi"); }
  async function lingqiClaim() { return shApi("/api/shanhai/lingqi/claim", {}); }
  // 【v26.6】灵宝商城（用灵气买道具）
  async function shopInfo() { return shApi("/api/shanhai/shop"); }
  async function shopBuy(itemId) { return shApi("/api/shanhai/shop/buy", { itemId }); }
  // 【v26.8】装备升级 / 合成
  async function equipUpgrade(itemId, stones) { return shApi("/api/shanhai/equip/upgrade", { itemId, stones }); }
  async function equipCompose(itemIds) { return shApi("/api/shanhai/equip/compose", { itemIds }); }

  return { load, report, upgradeSkill, draw, equip, unequip, idleInfo, idleClaim, idleCraft, staminaInfo, consumeStamina, dismantle, dismantlePrice, bonus, exBoard, exPublish, exDeal, exCancel,
    exDeposit, exWithdraw, lingqiInfo, lingqiClaim, shopInfo, shopBuy, equipUpgrade, equipCompose, exChart, factionInfo, factionSelect, talentLearn,
    get factionCache() { return factionCache; },
    get profile() { return profile; }, get stamina() { return stamina; }, set stamina(v) { stamina = v; },
    set stageStars(v) { stageStars = v; }, get stageStars() { return stageStars; } };
})();
window.META = META;
