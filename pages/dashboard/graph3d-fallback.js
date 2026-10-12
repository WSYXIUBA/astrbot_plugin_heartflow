/**
 * StarHeart 面板 · 3D 图谱引擎（零依赖，纯 canvas 2D 手写透视）
 *
 * 为什么要自己写：
 * 面板跑在 AstrBot 的受限 iframe 里，不能引 CDN、不能加依赖；Obsidian 那种观感
 * （深色底、发光节点、随深度衰减的连线、自由旋转）用 canvas 2D + 手写透视投影就够，
 * 不需要 WebGL 那套 shader 工程，也不吃显卡兼容性。
 *
 * 与 2D 引擎（graph.js）的关系：
 * - 物理与渲染思路同源（骨架边 + 网格斥力 + 冷却到平衡再冻结），但维度升到 3D；
 * - 3D 里「邻居数量爆炸」更厉害，所以斥力用**均匀网格邻域**近似，不做 O(n²)。
 *
 * 能力：
 * - 轨道旋转（拖空白）/ 缩放（滚轮）/ 平移（右键拖）/ 双击聚焦；
 * - 拖单个节点（沿相机平面移动，拖动时钉住）；
 * - 悬停高亮邻居、点击选中并回调面板；
 * - 四种「维度布局」：关系链 / 类型聚类 / 时间脉络 / 实体星系（z 轴承载不同含义）；
 * - 自转开关；深度雾 + 光晕 + 重要节点标签（LOD）。
 */

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** 确定性哈希：同一个 id 每次跑都得到同一套初始位置，避免每次进页面图都「变个样」 */
function hash01(str) {
  let h = 2166136261;
  const s = String(str == null ? "" : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export class Graph3D {
  /**
   * @param {HTMLElement} host 容器（会被塞进一个 canvas + 覆盖层）
   * @param {{nodes:Array, links:Array, mode?:string, onSelect?:Function, motion?:boolean}} opts
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts || {};
    this.nodes = [];
    this.links = [];
    this.mode = opts.mode || "chain";
    this.colorMode = opts.colorMode || "type";
    this.motion = opts.motion !== false;

    // 相机（球坐标：yaw/pitch/dist）
    this.yaw = -0.6;
    this.pitch = 0.42;
    this.dist = 900;
    this.distT = 900;
    this.target = { x: 0, y: 0, z: 0 };
    this.targetT = { x: 0, y: 0, z: 0 };
    this.fov = 780; // 焦距（像素）

    this.selected = null;
    this.hover = null;
    this.drag = null;
    this.pin = new Set();
    this._alpha = 1;
    this._maxDisp = 0;
    this._cooling = true;
    this._raf = 0;
    this._running = false;
    this._last = 0;
    this._fps = 0;
    this._frames = 0;
    this._fpsT = 0;
    this._spriteCache = new Map();
    this._labels = [];
    this._search = "";
    this._visible = 0;
    // 画质档：auto（按实测帧率自动降）/ high / low。headless 无 GPU 的软件光栅化下
    // 1676 节点只能跑到 15fps，降一档（DPR 1.25 + 关光晕 + 减连线）能救回一倍帧率。
    this.quality = opts.quality || "auto";
    this._degrade = this.quality === "low";
    // 物理参数（面板滑条可调）：与 2D 引擎同名同量级
    this.P = { repulsion: 1400, linkForce: 0.055, centerForce: 0.008, linkDistance: 46 };

    this._build();
    this._bind();
    this._kick();
  }

  /* ---------------- 结构 ---------------- */

  _build() {
    const h = this.host;
    h.textContent = "";
    // 只在宿主是 static 时才补 relative：**不能无条件覆盖**——
    // 面板里 #gMount 本来就是 position:absolute;inset:0（靠它撑满外层），
    // 覆盖成 relative 会让高度塌成 2px，画布变成 0 高（实测踩过）。
    try {
      if (getComputedStyle(h).position === "static") h.style.position = "relative";
    } catch (err) {
      h.style.position = "relative";
    }
    h.style.overflow = "hidden";
    const cv = document.createElement("canvas");
    cv.setAttribute("tabindex", "0");
    cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;touch-action:none";
    h.appendChild(cv);
    this.canvas = cv;
    this.ctx = cv.getContext("2d", { alpha: false });
    this.resize();
  }

  /** 换容器（切页复用画布时调用）：host 必须跟着换，否则量到的是已分离旧容器的 0 尺寸 */
  setHost(el) {
    if (!el) return this;
    this.host = el;
    this.resize();
    this.reheat(0.3);
    return this;
  }

  resize() {
    const h = this.host;
    const w = Math.max(120, h.clientWidth || 600);
    const ht = Math.max(120, h.clientHeight || 400);
    // 大图把 DPR 压到 1.5：3D 每帧要重绘整块画布，DPR 2 的填充率在真机上直接砍掉一半帧率
    const dprCap = this._degrade ? 1.25 : this._heavy ? 1.5 : 2;
    const dpr = Math.min(dprCap, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
    this.W = w;
    this.H = ht;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(ht * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------------- 数据 ---------------- */

  setData(payload) {
    const p = payload || {};
    const rawNodes = Array.isArray(p.nodes) ? p.nodes : [];
    const rawLinks = Array.isArray(p.links) ? p.links : [];
    // 上限保护：3D 每帧要投影+排序，节点上万会掉帧；超出按「重要度」截断
    const capN = clamp(Number(p.limit) || 2600, 200, 6000);
    const kept = rawNodes.slice(0, capN);
    const idSet = new Set(kept.map((n) => String(n.id)));
    this.nodes = kept.map((n, i) => {
      const importance = Number(n.importance != null ? n.importance : (Number(n.degree) || 0) * 3 + (Number(n.strength) || 0) * 10);
      // 后端的 graph 节点里：kind 放的是「记忆原子类型」（factual/episodic…），group 才是节点类别（memory/topic）。
      // 之前把 kind 当类别用，结果所有记忆节点都掉进兜底色 —— 整张图一片蓝（实测）。
      const cls = String(n.group || n.klass || n.class || "");
      const rawKind = String(n.kind || "");
      const ENT_KINDS = { entity: 1, topic: 1, person: 1, org: 1, place: 1, thing: 1, other: 1 };
      const ATOM_KINDS = { factual: 1, episodic: 1, preference: 1, planned: 1, routine: 1, relational: 1, opinion: 1, event: 1, emotion: 1, fact: 1, summary: 1 };
      const isEntity = cls === "topic" || cls === "entity" || cls === "person" || cls === "session"
        || (!cls && (ENT_KINDS[rawKind] || rawKind === "person" || rawKind === "session"));
      const atom = String(n.atom_type || n.atomType || (ATOM_KINDS[rawKind] ? rawKind : ""));
      return {
        raw: n,
        id: String(n.id),
        idx: i,
        label: String(n.label || n.summary || n.name || n.id || ""),
        kind: isEntity ? "entity" : "memory",
        atom,
        etype: isEntity ? rawKind || cls : "",
        strength: Number(n.strength) || 0,
        degreeRaw: Number(n.degree) || 0,
        ts: Number(n.ts || n.occurred_at || 0) || 0,
        group: String(n.group || n.entity || ""),
        val: importance,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        r: 2.6 + Math.min(9, Math.sqrt(Math.max(0, importance)) * 0.6),
        deg: 0,
        dim: 1,
        vis: 1,
      };
    });
    const idxOf = new Map();
    this.nodes.forEach((n, i) => idxOf.set(n.id, i));
    const capL = clamp(Number(p.linkLimit) || 20000, 200, 40000);
    this.links = [];
    for (let i = 0; i < rawLinks.length && this.links.length < capL; i++) {
      const l = rawLinks[i];
      if (!l) continue;
      const a = idxOf.get(String(l.source != null ? l.source : l.s));
      const b = idxOf.get(String(l.target != null ? l.target : l.t));
      if (a == null || b == null || a === b) continue;
      const w = clamp(Number(l.weight != null ? l.weight : l.w != null ? l.w : 1) || 1, 0.05, 5);
      this.links.push({ a, b, w, type: String(l.type || l.etype || "") });
      this.nodes[a].deg++;
      this.nodes[b].deg++;
    }
    this._heavy = this.nodes.length > 900;
    this._assignColors();
    if (this.colorMode && this.colorMode !== "type") this.setColorMode(this.colorMode);
    this._seed();
    this.reheat(1);
    // 标签预算：按重要度取前 N 个候选（渲染时再看屏幕位置/缩放决定画不画）
    this._labels = this.nodes
      .slice()
      .sort((p1, p2) => p2.val + p2.deg * 4 - (p1.val + p1.deg * 4))
      .slice(0, 60)
      .map((n) => n.idx);
    this._fit();
    this.emit("stats");
    return this;
  }

  /** 按类型上色（与面板其它图同一套色板） */
  _paintByType(n) {
    const MEM = { factual: "#4a90d9", episodic: "#00a3a3", preference: "#8b5cf6", planned: "#f59e0b", routine: "#9aa4b2", relational: "#e0559a", opinion: "#03c9d7", event: "#e0559a", emotion: "#e0559a", fact: "#4a90d9", summary: "#00a3a3" };
    const ENT = { person: "#e0559a", topic: "#8b5cf6", place: "#00c853", thing: "#03c9d7", org: "#f59e0b", other: "#9aa4b2" };
    n.color = n.kind === "entity" ? ENT[n.etype] || "#8b5cf6" : MEM[n.atom] || "#4a90d9";
  }

  /** 颜色：按节点类型 / 记忆原子类型分配（和面板其它图保持一致） */
  _assignColors() {
    this.nodes.forEach((n) => {
      n.isMem = n.kind === "memory";
      this._paintByType(n);
    });
    // 骨架边：每个节点只保留最重的 K 条参与物理（渲染另有预算）。
    // K 必须随规模下降：1676 个节点固定 K=8 会得到 8000+ 条「骨架」，等于没稀疏。
    const K = clamp(Math.round(56 / Math.sqrt(Math.max(1, this.nodes.length) / 120)), 3, 8);
    const bucket = new Map();
    this.links.forEach((l) => {
      if (!bucket.has(l.a)) bucket.set(l.a, []);
      if (!bucket.has(l.b)) bucket.set(l.b, []);
      bucket.get(l.a).push(l);
      bucket.get(l.b).push(l);
    });
    const keep = new Set();
    bucket.forEach((arr) => {
      arr.sort((x, y) => y.w - x.w);
      arr.slice(0, K).forEach((l) => keep.add(l));
    });
    this._physLinks = Array.from(keep);
    // 颜色索引：连线批处理要用（同一颜色的边可以一次 stroke）
    const pal = [];
    const ci = new Map();
    this.nodes.forEach((n) => {
      const c = n.color || "#4a90d9";
      if (!ci.has(c)) {
        ci.set(c, pal.length);
        pal.push(c);
      }
      n.ci = ci.get(c);
    });
    this._palette = pal.length ? pal : ["#4a90d9"];
  }

  /** 初始播种：球壳 + 确定性抖动；不同「维度布局」给 z 不同的含义 */
  _seed() {
    const n = this.nodes.length;
    if (!n) return;
    const R = Math.max(120, Math.sqrt(n) * 16);
    const byAtom = new Map();
    this.nodes.forEach((nd, i) => {
      const key = nd.atom || nd.kind;
      if (!byAtom.has(key)) byAtom.set(key, byAtom.size);
      nd._slot = byAtom.get(key);
    });
    const nSlots = Math.max(1, byAtom.size);
    const tsAll = this.nodes.map((x) => x.ts).filter((x) => x > 0);
    const tMin = tsAll.length ? Math.min.apply(null, tsAll) : 0;
    const tMax = tsAll.length ? Math.max.apply(null, tsAll) : 1;
    this.nodes.forEach((nd, i) => {
      const a = hash01(nd.id + "#a") * TAU;
      const b = Math.acos(2 * hash01(nd.id + "#b") - 1);
      let z = null;
      if (this.mode === "cluster") z = (nd._slot / nSlots - 0.5) * R * 1.5;
      else if (this.mode === "timeline" && nd.ts) z = ((nd.ts - tMin) / Math.max(1, tMax - tMin) - 0.5) * R * 1.7;
      else if (this.mode === "entity") z = nd.isMem ? R * 0.42 : 0;
      const rr = z == null ? R * (0.55 + 0.45 * hash01(nd.id + "#r")) : R * 0.55;
      nd.x = Math.sin(b) * Math.cos(a) * rr;
      nd.y = Math.sin(b) * Math.sin(a) * rr;
      nd.z = z == null ? Math.cos(b) * rr : z + (hash01(nd.id + "#z") - 0.5) * R * 0.25;
      nd.vx = nd.vy = nd.vz = 0;
    });
  }

  /** 把图中心对齐到原点、并给出合适相机距离 */
  _fit(snug) {
    const n = this.nodes.length;
    if (!n) return;
    let cx = 0, cy = 0, cz = 0;
    this.nodes.forEach((x) => { cx += x.x; cy += x.y; cz += x.z; });
    cx /= n; cy /= n; cz /= n;
    // 用「90 分位距离」而不是最大距离取景：个别孤立节点会被斥力推到很远，
    // 按最大值算会把整张图缩成一小团（实测就是这样）
    const d = this.nodes.map((x) => Math.hypot(x.x - cx, x.y - cy, x.z - cz)).sort((a, b) => a - b);
    const k = Math.max(0, Math.min(d.length - 1, Math.floor(d.length * 0.9)));
    const mx = d.length ? Math.max(24, d[k]) : 120;
    if (this._dragged) return;
    this.target = { x: cx, y: cy, z: cz };
    this.targetT = { ...this.target };
    // snug：收敛之后再算一次时用更紧的取景（播种时包围盒偏大，按它取景会显得很小）
    const want = snug ? clamp(mx * 2.5 + 90, 150, 6000) : clamp(mx * 3.0 + 160, 260, 6000);
    this.distT = want;
  }

  fit() {
    this._fit();
  }

  setMode(mode) {
    this.mode = mode || "chain";
    this._seed();
    this.reheat(1);
    this._fit();
  }

  /**
   * 着色维度：颜色代表什么由用户选（「更大的维度」——同一张图换个看问题的角度）
   * type 类型 / strength 强度 / time 时间 / degree 关系数
   */
  setColorMode(mode) {
    this.colorMode = mode || "type";
    const ns = this.nodes;
    if (this.colorMode === "strength") {
      const ramp = (v) => this._ramp("#2b6cb0", "#ffc107", "#f44336", clamp(v, 0, 1));
      ns.forEach((n) => { n.color = n.isMem ? ramp(n.strength) : "#8b5cf6"; });
    } else if (this.colorMode === "time") {
      const ts = ns.map((n) => n.ts).filter((x) => x > 0);
      const lo = ts.length ? Math.min.apply(null, ts) : 0;
      const hi = ts.length ? Math.max.apply(null, ts) : 1;
      ns.forEach((n) => {
        n.color = n.ts > 0 ? this._ramp("#475569", "#03c9d7", "#00c853", (n.ts - lo) / Math.max(1, hi - lo)) : "#8b5cf6";
      });
    } else if (this.colorMode === "degree") {
      const ds = ns.map((n) => n.deg || 0);
      const hi = Math.max(1, Math.max.apply(null, ds));
      ns.forEach((n) => { n.color = this._ramp("#475569", "#03c9d7", "#ffc107", Math.sqrt((n.deg || 0) / hi)); });
    } else {
      ns.forEach((n) => this._paintByType(n));
    }
    // 颜色变了 → 重建调色板索引（连线批处理按颜色分组）
    const pal = [];
    const ci = new Map();
    ns.forEach((n) => {
      const c = n.color || "#4a90d9";
      if (!ci.has(c)) { ci.set(c, pal.length); pal.push(c); }
      n.ci = ci.get(c);
    });
    this._palette = pal.length ? pal : ["#4a90d9"];
    this._spriteCache.clear();
    this._kick();
    return this;
  }

  /** 两端点之间的线性色带 */
  _ramp(c0, c1, c2, t) {
    const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    const a = hex(c0), b = hex(c1), c = hex(c2);
    const mix = (p, q, k) => Math.round(p + (q - p) * k);
    let out;
    if (t < 0.5) {
      const k = t / 0.5;
      out = [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
    } else {
      const k = (t - 0.5) / 0.5;
      out = [mix(b[0], c[0], k), mix(b[1], c[1], k), mix(b[2], c[2], k)];
    }
    return "#" + out.map((x) => clamp(x, 0, 255).toString(16).padStart(2, "0")).join("");
  }

  /** 面板滑条 → 物理参数（即时生效） */
  setPhysics(P) {
    this._settled = false;
    this._simT = 0;
    const p = P || {};
    if (p.repulsion != null) this.P.repulsion = clamp(Number(p.repulsion) || 1400, 50, 8000);
    if (p.linkForce != null) this.P.linkForce = clamp(Number(p.linkForce) || 0.055, 0.002, 0.5);
    if (p.centerForce != null) this.P.centerForce = clamp(Number(p.centerForce) || 0.008, 0.0005, 0.2);
    if (p.linkDistance != null) this.P.linkDistance = clamp(Number(p.linkDistance) || 46, 10, 400);
    this.reheat(0.5);
    return this;
  }

  /** 导出当前画面（PNG dataURL） */
  snapshot() {
    try {
      return this.canvas.toDataURL("image/png");
    } catch (err) {
      return "";
    }
  }

  /** 手动切画质档：high（清晰）/ low（流畅）/ auto */
  setQuality(q) {
    this.quality = q || "auto";
    this._degrade = this.quality === "low";
    this._lowCount = 0;
    this.resize();
    this.reheat(0.35);
    this.emit("quality", this.quality);
    return this;
  }

  setMotion(on) {
    this.motion = !!on;
    this._kick();
  }

  setSearch(q) {
    this._search = String(q || "").trim().toLowerCase();
    const on = this._search;
    this.nodes.forEach((n) => {
      n.matchT = !on || n.label.toLowerCase().includes(on) || n.id.toLowerCase().includes(on) ? 1 : 0.12;
    });
    this._kick();
  }

  focusNode(id) {
    const n = this.nodes.find((x) => x.id === String(id));
    if (!n) return;
    this.targetT = { x: n.x, y: n.y, z: n.z };
    this.distT = clamp(this.distT * 0.7, 220, 3000);
    this.select(n);
    this._kick();
  }

  select(n) {
    this.selected = n || null;
    this.emit("select", n && n.raw ? n.raw : null);
    this._kick();
  }

  /** 局部重加热（拖拽/换布局/换数据后） */
  reheat(a = 1) {
    this._settled = false;
    this._simT = 0;
    this._alpha = Math.max(this._alpha, a);
    this._cooling = true;
    this._kick();
  }

  /* ---------------- 事件 ---------------- */

  on(ev, fn) {
    const subs = this._subs || (this._subs = {});
    if (!subs[ev]) subs[ev] = [];
    subs[ev].push(fn);
    return this;
  }

  emit(ev, payload) {
    const arr = (this._subs || {})[ev];
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      try {
        arr[i](payload);
      } catch (err) {
        console.warn("[hf3d] 回调异常", err);
      }
    }
  }

  _bind() {
    const cv = this.canvas;
    let lastX = 0, lastY = 0, dragging = false, orbiting = false, panning = false, moved = 0;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      const hit = this._pick(pos(e));
      if (e.button === 2) panning = true;
      else if (hit) {
        this.drag = hit;
        this.pin.add(hit.id);
        this.select(hit);
        this.reheat(0.6);
      } else orbiting = true;
      cv.style.cursor = "grabbing";
    });
    cv.addEventListener("pointermove", (e) => {
      const p = pos(e);
      if (!dragging) {
        const hit = this._pick(p);
        if (hit !== this.hover) {
          this.hover = hit;
          cv.style.cursor = hit ? "pointer" : "grab";
          this._kick();
        }
        return;
      }
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX;
      lastY = e.clientY;
      if (this.drag) {
        // 把屏幕位移换算成相机平面上的世界位移
        const k = this.dist / this.fov;
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
        const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        // 相机右向量 / 上向量
        const rx = cy, ry = 0, rz = -sy;
        const ux = -sy * sp, uy = cp, uz = -cy * sp;
        const n = this.drag;
        n.x += (rx * dx + ux * -dy) * k;
        n.y += (ry * dx + uy * -dy) * k;
        n.z += (rz * dx + uz * -dy) * k;
      } else if (panning) {
        const k = this.dist / this.fov;
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
        this.targetT.x += (cy * -dx) * k;
        this.targetT.z += (-sy * -dx) * k;
        this.targetT.y += -dy * k * Math.cos(this.pitch);
      } else if (orbiting) {
        this.yaw -= dx * 0.007;
        this.pitch = clamp(this.pitch + dy * 0.006, -1.45, 1.45);
      }
      this._kick();
    });
    const up = (e) => {
      dragging = false;
      orbiting = false;
      panning = false;
      if (this.drag) {
        this.pin.delete(this.drag.id);
        // 松手后短暂「按住」它：否则弹簧/向心力会立刻把它拽回原位，
        // 用户会觉得「拖了等于没拖」（自动化测试也抓到了这个回弹）
        this._hold = { node: this.drag, until: (typeof performance !== "undefined" ? performance.now() : Date.now()) + 900 };
        this.drag = null;
      }
      cv.style.cursor = "grab";
      if (moved < 4) {
        const hit = this._pick(pos(e));
        this.select(hit);
      }
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointerenter", () => { this._hovering = true; });
    cv.addEventListener("pointerleave", (e) => { if (dragging) up(e); this.hover = null; this._hovering = false; });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0012);
      this.distT = clamp(this.distT * f, 140, 8000);
      this._kick();
    }, { passive: false });
    cv.addEventListener("dblclick", (e) => {
      const hit = this._pick(pos(e));
      if (hit) this.focusNode(hit.id);
      else {
        this.yaw = -0.6;
        this.pitch = 0.42;
        this.fit();
      }
      this._kick();
    });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    this._onResize = () => {
      this.resize();
      this._kick();
    };
    window.addEventListener("resize", this._onResize);
    // 容器尺寸变化（首帧布局未定时、切页回来、全屏）都要重新测量，否则画布高度是 0
    if (typeof ResizeObserver !== "undefined") {
      try {
        this._ro = new ResizeObserver(() => this._onResize());
        this._ro.observe(this.host);
      } catch (err) {
        this._ro = null;
      }
    }
  }

  /* ---------------- 拾取 ---------------- */

  _pick(p) {
    let best = null;
    let bestD = 22;
    const pts = this._screen || [];
    for (let i = 0; i < this.nodes.length; i++) {
      const s = pts[i];
      if (!s || s.z <= 0.01) continue;
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      // 屏幕上的点越近越容易命中（深度大的点更小，容差也小一点）
      const tol = Math.max(6, Math.min(22, bestD - 1, 8 + s.r * 0.9));
      if (d < tol && (best == null || s.z < best.z)) {
        best = { node: this.nodes[i], z: s.z };
      }
    }
    return best ? best.node : null;
  }

  /* ---------------- 物理（3D） ---------------- */

  _physics(dt) {
    const n = this.nodes.length;
    if (!n) return false;
    const a = this._alpha;
    if (a <= 0.004) return false;
    const R = Math.max(120, Math.sqrt(n) * 16);
    const sc = Math.max(0.62, R / 260); // 量纲归一：大图放大受力、小图别缩成一团
    const P = this.P || {};
    const rep = (Number(P.repulsion) || 1400) * sc * sc;
    const springK = Number(P.linkForce) || 0.055;
    const springLen = (Number(P.linkDistance) || 46) * sc;
    const centerK = Number(P.centerForce) || 0.008;

    // 1) 网格斥力（3x3x3 邻域近似）：把节点分到格子里
    const cell = Math.max(18 * sc, springLen * 1.6);
    const grid = new Map();
    const key = (i, j, k) => i * 73856093 ^ j * 19349663 ^ k * 83492791;
    for (let i = 0; i < n; i++) {
      const nd = this.nodes[i];
      const gi = Math.floor(nd.x / cell), gj = Math.floor(nd.y / cell), gk = Math.floor(nd.z / cell);
      const kk = key(gi, gj, gk);
      let arr = grid.get(kk);
      if (!arr) { arr = []; grid.set(kk, arr); }
      arr.push(i);
    }
    let maxDisp = 0;
    // 每个节点最多参与 26 次两两斥力：密集图里 27 格全扫是百万级计算（真机 1676 节点只有 12fps），
    // 视觉上少算一些邻居几乎看不出差别
    const NEIGH_CAP = n > 600 ? 26 : 96;
    for (let i = 0; i < n; i++) {
      const nd = this.nodes[i];
      const gi = Math.floor(nd.x / cell), gj = Math.floor(nd.y / cell), gk = Math.floor(nd.z / cell);
      let fx = 0, fy = 0, fz = 0;
      let seen = 0;
      for (let di = -1; di <= 1 && seen < NEIGH_CAP; di++) {
        for (let dj = -1; dj <= 1 && seen < NEIGH_CAP; dj++) {
          for (let dk = -1; dk <= 1 && seen < NEIGH_CAP; dk++) {
            const arr = grid.get(key(gi + di, gj + dj, gk + dk));
            if (!arr) continue;
            for (let m = 0; m < arr.length && seen < NEIGH_CAP; m++) {
              const j = arr[m];
              if (j === i) continue;
              seen++;
              const o = this.nodes[j];
              let dx = nd.x - o.x, dy = nd.y - o.y, dz = nd.z - o.z;
              let d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > cell * cell * 9) continue;
              if (d2 < 0.01) { dx = (hash01(nd.id + j) - 0.5) * 2; dy = 0.5 - hash01(o.id + i); dz = 1; d2 = 3; }
              const d = Math.sqrt(d2);
              const f = rep / (d2 + 40 * sc * sc);
              fx += (dx / d) * f;
              fy += (dy / d) * f;
              fz += (dz / d) * f;
            }
          }
        }
      }
      // 2) 向心
      fx += (this.target.x - nd.x) * centerK * 60;
      fy += (this.target.y - nd.y) * centerK * 60;
      fz += (this.target.z - nd.z) * centerK * 60;
      // 3) 弹簧（骨架边）
      nd._fx = fx; nd._fy = fy; nd._fz = fz;
    }
    const links = this._physLinks || [];
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      const A = this.nodes[l.a], B = this.nodes[l.b];
      let dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
      let d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const want = springLen * (1 + (1 / l.w) * 0.6);
      const f = (d - want) * springK;
      const ux = dx / d, uy = dy / d, uz = dz / d;
      A._fx += ux * f; A._fy += uy * f; A._fz += uz * f;
      B._fx -= ux * f; B._fy -= uy * f; B._fz -= uz * f;
    }
    // 4) 积分（步长封顶，避免大图炸开）
    const step = clamp(dt / 16.7, 0.4, 2.2);
    const maxStep = 12 * sc;
    for (let i = 0; i < n; i++) {
      const nd = this.nodes[i];
      const held = this._hold && this._hold.node === nd
        && (typeof performance !== "undefined" ? performance.now() : Date.now()) < this._hold.until;
      if ((this.drag && this.drag === nd) || held) { nd.vx = nd.vy = nd.vz = 0; continue; }
      nd.vx = (nd.vx + nd._fx * 0.0022 * a) * 0.86;
      nd.vy = (nd.vy + nd._fy * 0.0022 * a) * 0.86;
      nd.vz = (nd.vz + nd._fz * 0.0022 * a) * 0.86;
      nd.vx = clamp(nd.vx, -maxStep, maxStep);
      nd.vy = clamp(nd.vy, -maxStep, maxStep);
      nd.vz = clamp(nd.vz, -maxStep, maxStep);
      nd.x += nd.vx * step;
      nd.y += nd.vy * step;
      nd.z += nd.vz * step;
      const disp = Math.abs(nd.vx) + Math.abs(nd.vy) + Math.abs(nd.vz);
      if (disp > maxDisp) maxDisp = disp;
    }
    this._maxDisp = maxDisp;
    // 冷却：位移够小就快速降温 → 冻结（拖拽时会重新加热）
    if (maxDisp < 0.9 * sc) {
      this._alpha = Math.max(0, this._alpha - 0.06);
      if (!this._settled && this._simT > 900) {
        this._settled = true;
        try { this._fit(true); } catch (err) { /* ignore */ }
      }
    }
    else this._alpha = Math.max(0, this._alpha - 0.006);
    return this._alpha > 0.004;
  }

  /* ---------------- 渲染 ---------------- */

  _project() {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cx = this.target.x, cyy = this.target.y, cz = this.target.z;
    const f = this.fov;
    const cx2 = this.W / 2, cy2 = this.H / 2;
    const out = this._screen || (this._screen = new Array(this.nodes.length));
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      let x = n.x - cx, y = n.y - cyy, z = n.z - cz;
      // yaw 绕 Y 轴
      let x1 = x * cy - z * sy;
      let z1 = x * sy + z * cy;
      // pitch 绕 X 轴
      let y1 = y * cp - z1 * sp;
      let z2 = y * sp + z1 * cp;
      const camZ = z2 + this.dist;
      if (camZ < 12) { out[i] = { x: -9999, y: -9999, z: 0, s: 0, r: 0 }; continue; }
      const s = f / camZ;
      out[i] = { x: cx2 + x1 * s, y: cy2 + y1 * s, z: camZ, s: s, r: n.r * s * 2.3 };
    }
    return out;
  }

  _sprite(color, sizeBucket) {
    const k = color + "|" + sizeBucket;
    const hit = this._spriteCache.get(k);
    if (hit) return hit;
    const d = sizeBucket * 2;
    const c = document.createElement("canvas");
    c.width = d; c.height = d;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(sizeBucket, sizeBucket, 0, sizeBucket, sizeBucket, sizeBucket);
    grd.addColorStop(0, color);
    grd.addColorStop(0.5, color);
    grd.addColorStop(0.72, color);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.beginPath();
    g.arc(sizeBucket, sizeBucket, sizeBucket, 0, TAU);
    g.fill();
    this._spriteCache.set(k, c);
    return c;
  }

  /** 连线预算：节点越多越只画骨架（缩得很远时满屏线反而看不清） */
  _linkBudget() {
    const n = this.nodes.length;
    if (n <= 200) return this.links.length;
    const skel = Math.max(200, (this._physLinks || []).length);
    const k = this._degrade ? 0.55 : 1;
    // 视距越远画越少：远看满屏线本来也看不清，还吃掉一大半帧率（真机实测）
    if (this.dist > 1500) return Math.min(skel, Math.round(2000 * k));
    if (this.dist > 900) return Math.min(Math.max(skel, 3000), Math.round(3600 * k));
    if (n <= 800) return Math.min(this.links.length, Math.round(6000 * k));
    return Math.min(this.links.length, Math.round(5200 * k));
  }

  _draw(now) {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    // 背景：深色径向渐变（Obsidian 那种暗底）
    const bg = ctx.createRadialGradient(W / 2, H / 2, 20, W / 2, H / 2, Math.max(W, H) * 0.72);
    bg.addColorStop(0, "#141a26");
    bg.addColorStop(1, "#0b0e15");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const pts = this._project();
    const n = this.nodes.length;
    const hover = this.hover;
    const sel = this.selected;
    const near = this._near || (this._near = new Set());
    near.clear();
    if (hover || sel) {
      const target = hover || sel;
      near.add(target.idx);
      for (let i = 0; i < this.links.length; i++) {
        const l = this.links[i];
        if (l.a === target.idx) near.add(l.b);
        else if (l.b === target.idx) near.add(l.a);
      }
    }

    // 连线：按「颜色 + 透明度档」合并成 Path2D 再一次性 stroke。
    // 逐条设 strokeStyle 会每帧产生上万次字符串/状态切换（真机 8552 条边直接掉到 20fps），
    // 分档批量后状态切换只剩几十次。
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1;
    const focusIdx = (hover || sel) ? (hover || sel).idx : -1;
    const buckets = this._buckets || (this._buckets = new Map());
    buckets.clear();
    const ALPHA_STEPS = this._alphaSteps || (this._alphaSteps = [0.04, 0.1, 0.18, 0.3, 0.46, 0.62]);
    const linkCap = focusIdx >= 0 ? this.links.length : this._linkBudget();
    for (let i = 0; i < this.links.length; i++) {
      const l = this.links[i];
      if (i >= linkCap && l.a !== focusIdx && l.b !== focusIdx) continue;
      const A = pts[l.a], B = pts[l.b];
      if (!A || !B || A.z <= 12 || B.z <= 12) continue;
      const isFocus = focusIdx >= 0 && (l.a === focusIdx || l.b === focusIdx);
      const zAvg = (A.z + B.z) / 2;
      const fog = clamp(1 - (zAvg - this.dist * 0.35) / (this.dist * 2.2), 0.05, 1);
      let alpha = isFocus ? 0.62 : 0.09 + fog * 0.2;
      if (alpha < 0.03) continue;
      const ab = clamp(Math.round((alpha / 0.62) * (ALPHA_STEPS.length - 1)), 0, ALPHA_STEPS.length - 1);
      const ci = this.nodes[l.a].ci || 0;
      const key = ci * 16 + ab;
      let path = buckets.get(key);
      if (!path) {
        path = new Path2D();
        buckets.set(key, path);
      }
      path.moveTo(A.x, A.y);
      path.lineTo(B.x, B.y);
    }
    const pal = this._palette || (this._palette = ["#4a90d9"]);
    buckets.forEach((path, key) => {
      const ci = Math.floor(key / 16);
      const ab = key % 16;
      ctx.strokeStyle = this._rgba(pal[ci] || "#4a90d9", ALPHA_STEPS[Math.min(ab, ALPHA_STEPS.length - 1)]);
      ctx.stroke(path);
    });
    ctx.globalCompositeOperation = "source-over";

    // 节点：按深度从远到近画（画家算法）
    const order = this._order || (this._order = new Array(n));
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((p1, p2) => pts[p2].z - pts[p1].z);
    const zoomK = clamp(600 / this.dist, 0.5, 3.2);
    for (let oi = 0; oi < n; oi++) {
      const i = order[oi];
      const nd = this.nodes[i];
      const s = pts[i];
      if (!s || s.z <= 12 || s.x < -60 || s.x > W + 60 || s.y < -60 || s.y > H + 60) continue;
      const fog = clamp(1 - (s.z - this.dist * 0.35) / (this.dist * 2.4), 0.15, 1);
      const focused = nd === hover || nd === sel;
      let alpha = (nd.match != null ? nd.match : 1) * (0.35 + fog * 0.75);
      if ((hover || sel) && !near.has(i)) alpha *= 0.28;
      if (focused) alpha = 1;
      const r = clamp(s.r * (focused ? 1.35 : 1), 1.0, 26);
      if (alpha < 0.03) continue;
      const bucket = clamp(Math.round(r * 2) / 2, 1.2, 10);
      ctx.globalAlpha = clamp(alpha, 0, 1);
      // 大图拉远时省掉光晕层（1676 个发光精灵的填充率很贵），只画实心点
      const glowOk = !this._degrade && (!(this._heavy && this.dist > 1100 && bucket < 6.5) || focused);
      if (glowOk) {
        // 绘制尺寸 = 精灵的自然尺寸（sb*4），否则渐变的四角会被方形边缘切掉
        const sb = Math.ceil(bucket);
        const spr = this._sprite(nd.color || "#4a90d9", sb * 2);
        const box = sb * 4;
        ctx.drawImage(spr, s.x - box / 2, s.y - box / 2, box, box);
      }
      // 芯：每个点都画实心圆，外层光晕只是氛围 —— 这样才像 Obsidian 的点，而不是一团星云
      ctx.fillStyle = nd.color || "#4a90d9";
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(0.7, bucket * 0.46), 0, TAU);
      ctx.fill();
      if (focused) {
        ctx.strokeStyle = "rgba(255,255,255,.85)";
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(s.x, s.y, bucket * 1.5 + 2, 0, TAU);
        ctx.stroke();
      }
      this._visible++;
    }
    ctx.globalAlpha = 1;

    // 标签：只给重要 / 悬停 / 选中画（LOD），并做简单避让
    const n0 = this.nodes.length;
    const dense = n0 > 500 ? 0.55 : n0 > 200 ? 0.8 : 1; // 大图标签少画，否则中间糊成一列
    const labelBudget = Math.max(4, Math.round((this.dist < 700 ? 24 : this.dist < 1400 ? 13 : 6) * dense));
    const drawn = [];
    const wantLabel = (idx) => idx === (hover && hover.idx) || idx === (sel && sel.idx) || this._labels.slice(0, labelBudget).includes(idx);
    ctx.font = "11px system-ui,-apple-system,Segoe UI,sans-serif";
    ctx.textBaseline = "middle";
    for (let oi = n - 1; oi >= 0; oi--) {
      const i = order[oi];
      if (!wantLabel(i)) continue;
      const nd = this.nodes[i];
      const s = pts[i];
      if (!s || s.z <= 12 || s.x < 0 || s.x > W || s.y < 0 || s.y > H) continue;
      const focused = nd === hover || nd === sel;
      const text = nd.label.length > 22 ? nd.label.slice(0, 21) + "…" : nd.label;
      const w = ctx.measureText(text).width;
      const bx = s.x + 8;
      const by = s.y - 8;
      let clash = false;
      for (let k = 0; k < drawn.length; k++) {
        const d = drawn[k];
        if (Math.abs(d.x - bx) < (d.w + w) / 2 + 10 && Math.abs(d.y - by) < 17) { clash = true; break; }
      }
      if (clash && !focused) continue;
      drawn.push({ x: bx, y: by, w: w });
      ctx.globalAlpha = focused ? 1 : 0.82;
      ctx.fillStyle = "rgba(8,11,17,.72)";
      ctx.fillRect(bx - 4, by - 8, w + 8, 16);
      ctx.fillStyle = focused ? "#ffffff" : "rgba(226,232,240,.92)";
      ctx.fillText(text, bx, by);
      if (focused) {
        ctx.strokeStyle = "rgba(255,255,255,.5)";
        ctx.strokeRect(bx - 4, by - 8, w + 8, 16);
      }
    }
    ctx.globalAlpha = 1;
  }

  _rgba(hex, a) {
    if (!hex) return "rgba(120,140,170," + a + ")";
    if (hex[0] === "#" && (hex.length === 7 || hex.length === 4)) {
      let r, g, b;
      if (hex.length === 4) {
        r = parseInt(hex[1] + hex[1], 16); g = parseInt(hex[2] + hex[2], 16); b = parseInt(hex[3] + hex[3], 16);
      } else {
        r = parseInt(hex.slice(1, 3), 16); g = parseInt(hex.slice(3, 5), 16); b = parseInt(hex.slice(5, 7), 16);
      }
      return "rgba(" + r + "," + g + "," + b + "," + a + ")";
    }
    return hex;
  }

  /* ---------------- 主循环 ---------------- */

  _kick() {
    // 与 Graph3D._kick 同理：循环「自以为在跑」但没排帧时（_raf=0）也要能拉起来
    if (this._running && this._raf) return;
    this._running = true;
    this._last = 0;
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  /** 面板侧时钟兜底的「防冻死」健康检查（见 Graph3D.ensureAlive 的说明） */
  ensureAlive() {
    try {
      if (this.canvas && !this.canvas.isConnected) return false;   // 已卸载：不复活
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const stale = !this._beat || (now - this._beat) > 1500;
      if (stale || !this._running || !this._raf) {
        try { if (this._raf) cancelAnimationFrame(this._raf); } catch (err) { /* 忽略 */ }
        this._raf = 0;
        this._running = false;
        this._kick();
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  _tick(t) {
    // 心跳 + 异常绝不断链（与 Graph3D._tick 同理：rAF 回调一抛异常、浏览器就不再排下一帧）
    this._beat = t || (typeof performance !== "undefined" ? performance.now() : Date.now());
    this._raf = 0;
    try {
      this._tickInner(t);
    } catch (err) {
      this._errCount = (this._errCount || 0) + 1;
      if (this._errCount <= 3) console.warn("[hf3d2d] 渲染帧异常（循环保活）", err);
    } finally {
      if (this._running && !this._raf) this._raf = requestAnimationFrame((tt) => this._tick(tt));
    }
  }

  _tickInner(t) {
    // 画布被移出文档（切页/换容器）就停循环：面板里有三个 3D 外壳，不能让它们在后台空转烧 CPU
    if (this.canvas && !this.canvas.isConnected) {
      this._running = false;
      return;
    }
    const now = t || (typeof performance !== "undefined" ? performance.now() : Date.now());
    const dt = this._last ? clamp(now - this._last, 1, 60) : 16.7;
    this._last = now;

    // 相机缓动
    this.yaw += this.motion && !this.drag && !this._hovering ? 0.00018 * dt : 0;
    this.dist = lerp(this.dist, this.distT, 1 - Math.exp(-dt / 120));
    this.target.x = lerp(this.target.x, this.targetT.x, 1 - Math.exp(-dt / 140));
    this.target.y = lerp(this.target.y, this.targetT.y, 1 - Math.exp(-dt / 140));
    this.target.z = lerp(this.target.z, this.targetT.z, 1 - Math.exp(-dt / 140));

    const busy = this._physics(dt);
    if (busy) this._simT = (this._simT || 0) + dt;
    this._visible = 0;
    this._draw(now);

    this._frames++;
    if (now - this._fpsT > 500) {
      this._fps = Math.round((this._frames * 1000) / (now - this._fpsT));
      this._frames = 0;
      this._fpsT = now;
      // 自动降档：只在「有大量节点」且持续低帧时触发，避免小图误降
      if (this.quality === "auto") {
        if (this._fps && this._fps < 26 && this.nodes.length > 260) {
          this._lowCount = (this._lowCount || 0) + 1;
          if (this._lowCount >= 4 && !this._degrade) {
            this._degrade = true;
            this.resize();
            this._lowCount = 0;
            this.emit("quality", "low");
          }
        } else {
          this._lowCount = 0;
        }
      }
      this.emit("stats", this.stats());
    }

    const stillMoving =
      Math.abs(this.distT - this.dist) > 0.5 ||
      Math.abs(this.targetT.x - this.target.x) > 0.5 ||
      Math.abs(this.targetT.y - this.target.y) > 0.5 ||
      Math.abs(this.targetT.z - this.target.z) > 0.5 ||
      this.motion ||
      this.selected ||
      this.hover;

    if (busy || stillMoving) {
      this._raf = requestAnimationFrame((tt) => this._tick(tt));
    } else {
      this._running = false;
    }
  }

  stats() {
    return {
      nodes: this.nodes.length,
      links: this.links.length,
      visible: this._visible,
      fps: this._fps,
      alpha: Math.round(this._alpha * 100) / 100,
      dist: Math.round(this.dist),
      mode: this.mode,
      quality: this._degrade ? "low" : "high",
      selected: this.selected ? this.selected.id : null,
      hover: this.hover ? this.hover.id : null,
      pinned: Array.from(this.pin),
    };
  }

  destroy() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._onResize) window.removeEventListener("resize", this._onResize);
    if (this._ro) {
      try { this._ro.disconnect(); } catch (err) { /* ignore */ }
    }
    try { this.host.textContent = ""; } catch (err) { /* 容器没了就算了 */ }
  }
}

export default Graph3D;
