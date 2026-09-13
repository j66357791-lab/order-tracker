// 对象池 + 空间网格（性能三板斧前两斧）
"use strict";

// —— 通用对象池 ——
class Pool {
  constructor(factory, reset, prealloc = 0) {
    this.factory = factory;
    this.reset = reset;
    this.free = [];
    this.active = [];
    for (let i = 0; i < prealloc; i++) this.free.push(factory());
  }
  spawn(...args) {
    const o = this.free.pop() || this.factory();
    this.reset(o, ...args);
    this.active.push(o);
    return o;
  }
  despawn(o) {
    const i = this.active.indexOf(o);
    if (i >= 0) this.active.splice(i, 1);
    this.free.push(o);
  }
  despawnAll() {
    while (this.active.length) this.free.push(this.active.pop());
  }
  forEach(fn) { for (let i = this.active.length - 1; i >= 0; i--) fn(this.active[i], i); }
}

// —— 空间哈希网格（怪-弹-玩家碰撞查询）——
class SpatialGrid {
  constructor(cell = 64) {
    this.cell = cell;
    this.map = new Map();
  }
  clear() { this.map.clear(); }
  _key(cx, cy) { return cx * 100000 + cy; }
  insert(o) {
    const cx = Math.floor(o.x / this.cell), cy = Math.floor(o.y / this.cell);
    const k = this._key(cx, cy);
    let arr = this.map.get(k);
    if (!arr) { arr = []; this.map.set(k, arr); }
    arr.push(o);
  }
  // 查询圆覆盖范围内的对象（对遍历去重用 Set）
  query(x, y, r, out = []) {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const arr = this.map.get(this._key(cx, cy));
        if (arr) for (const o of arr) out.push(o);
      }
    }
    return out;
  }
}

window.Pool = Pool;
window.SpatialGrid = SpatialGrid;
