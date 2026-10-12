/**
 * graph.js — StarHeart「记忆图谱」渲染引擎（原生 ES module，零依赖）
 * ---------------------------------------------------------------------------
 * 用途
 *   把 StarHeart 的记忆（自然语言摘要）与实体（人物/话题/会话）渲染成一张
 *   可交互的知识图谱。纯 canvas 2D 手写，不引用任何外部库，可在 AstrBot
 *   Dashboard 的受限 sandbox iframe（allow-scripts allow-forms allow-downloads）
 *   里离线运行：不碰 window.top / window.parent / localStorage / sessionStorage
 *   / document.cookie，不使用 eval / new Function，不加载任何 CDN 资源。
 *
 * 导出 API 摘要
 *   class MemoryGraph
 *     constructor(container, options)   引擎内部自建 <canvas> 并铺满容器
 *     setData({nodes, links})           全量替换数据（保留同名节点的钉住状态）
 *     setView(name)                     'chain' | 'cluster' | 'timeline' | 'entity'
 *     setSearch(q)                      关键字高亮（标签/摘要/实体/cues）
 *     setFilter({groups, kinds, minStrength})
 *     setPhysics({repulsion, linkForce, centerForce, linkDistance})
 *     setCards(on)                      卡片模式总开关
 *     setMotion(on)                     环境动效开关
 *     fitView() reshuffle() exportPNG() destroy() resize()
 *     on(event, cb)                     'select' | 'hover' | 'viewchange' | 'stats'
 *     getState()                        {view, nodeCount, linkCount, zoom, selected,
 *                                        hover, pinned, cards}
 *   const GRAPH_PALETTE / GRAPH_COLORS / GRAPH_LABELS   供页面图例使用的配色
 *   function selfTest()                离屏合成数据自检，返回 {ok, nodes, links, ms}
 *
 * 性能取舍（为什么这么做）
 *   1) 斥力不做 O(n²)：节点压进均匀空间网格，只和 3×3 邻域互相排斥。
 *      800 节点下每帧工作量从 32 万次降到约 1~2 万次。
 *   2) 不跑物理时立刻停 rAF（脏标记驱动）；只有「物理热、视图过渡中、相机缓动中、
 *      环境动效开、有节点动画/选中波纹」这几种情况才继续排帧。
 *   3) 边按类型一次性 beginPath+stroke 批量绘制，避免 2500 次独立 stroke 的状态切换。
 *   4) 每节点外发光（shadowBlur）非常贵，因此设了「发光预算」：可见节点少时才全量
 *      发光，规模大时只给选中/悬停/高重要度节点加光。
 *   5) 卡片文本排版（逐字 measureText）按 id+宽度+主题+行数缓存，只在签名变化时重算。
 *   6) 标签用屏幕空间占用网格避让，按优先级（选中 > 悬停 > 度数）抢占，缩放时透明度
 *      渐变而不是突然出现/消失。
 *   7) devicePixelRatio 上限 2，避免 4K 屏上 4 倍像素填充把帧率打穿。
 */

/* =========================================================================
 * 一、配色常量（导出，页面图例直接用）
 * ========================================================================= */

/** 分组/关系配色表：memory 按 atom_type，entity 按实体种类，link 按关系类型 */
export const GRAPH_PALETTE = {
  memory: {
    factual: '#4a90d9',
    episodic: '#00a3a3',
    relational: '#e0559a',
    preference: '#8b5cf6',
    planned: '#f59e0b',
    routine: '#64748b',
    opinion: '#ef6c5a'
  },
  entity: {
    person: '#e0559a',
    topic: '#3aa76d',
    session: '#d9a520'
  },
  link: {
    semantic: '#0074d9',
    temporal: '#009296',
    entity: '#f59e0b',
    /* store.graph() 真实会产出的另外三种边 —— 没配色的会走 fallback，图例与画布对不上 */
    about: '#22c55e',
    in_session: '#e11d48',
    member_of: '#14b8a6'
  }
};

/** 扁平配色常量，方便图例/工具栏按 key 直接取色 */
export const GRAPH_COLORS = {
  /* 记忆类型 */
  factual: '#4a90d9',
  episodic: '#00a3a3',
  relational: '#e0559a',
  preference: '#8b5cf6',
  planned: '#f59e0b',
  routine: '#64748b',
  opinion: '#ef6c5a',
  /* 实体类型 */
  person: '#e0559a',
  topic: '#3aa76d',
  session: '#d9a520',
  /* 关系类型 */
  semantic: '#0074d9',
  temporal: '#009296',
  entity: '#f59e0b',
  /* 别名 */
  memory: '#4a90d9',
  accent: '#4a90d9',
  muted: '#8e8e93'
};

/** 中文名（图例/卡片头部用）；kind 缺失时回退到 group 的名字 */
export const GRAPH_LABELS = {
  memory: { factual: '事实', episodic: '经历', relational: '关系', preference: '偏好', planned: '待办', routine: '惯例', opinion: '看法' },
  entity: { person: '人物', topic: '话题', session: '会话' },
  link: { semantic: '语义', temporal: '时序', entity: '实体',
    // store.graph() 真实还会产出这三种边；不登记的话图例会显示生 key、2D 引擎会把它们当成「实体」
    about: '关于某人', in_session: '发生在该会话', member_of: '成员关系' }
};

/* =========================================================================
 * 二、主题（跟随 documentElement 的 data-theme，MutationObserver 即时重绘）
 * ========================================================================= */

const THEMES = {
  light: {
    bg: '#ffffff',
    text: '#1d1d1f',
    sub: '#8e8e93',
    grid: 'rgba(0,0,0,.05)',
    card: '#ffffff',
    cardBorder: 'rgba(0,0,0,.09)',
    cardShadow: 'rgba(0,0,0,.13)',
    track: 'rgba(0,0,0,.07)',
    ripple: 'rgba(0,0,0,.32)',
    dim: 0.16
  },
  dark: {
    bg: '#141414',
    text: '#e8eaed',
    sub: '#71717a',
    grid: 'rgba(255,255,255,.06)',
    card: '#1e1e21',
    cardBorder: 'rgba(255,255,255,.11)',
    cardShadow: 'rgba(0,0,0,.55)',
    track: 'rgba(255,255,255,.10)',
    ripple: 'rgba(255,255,255,.42)',
    dim: 0.22
  }
};

/* =========================================================================
 * 三、工具函数
 * ========================================================================= */

const FONT_UI = '-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif';
const FONT_CARD = '12px ' + FONT_UI;
const FONT_CARD_B = '650 12.5px ' + FONT_UI;
const FONT_TINY = '10.5px ' + FONT_UI;
const FONT_LABEL = '12px ' + FONT_UI;
const FONT_LABEL_B = '650 12.5px ' + FONT_UI;
const FONT_CLUSTER = '650 13px ' + FONT_UI;

const KIND_LABELS = GRAPH_LABELS.memory;
const GROUP_LABELS = GRAPH_LABELS.entity;
const LINK_LABELS = GRAPH_LABELS.link;

/** 关系类型固定索引：给分桶 key 用数字而不是字符串，省掉每帧的类型查表。
 *  ⚠️ 下标会被 `(ti << 3) | bucket` 编码、`key >> 3` 还原，两边都取自这张表，所以一致即可；
 *     这里删掉过 'causal'（因果）—— 全仓没有任何写边路径会产出它（真机 hf_edges 里 0 条），
 *     留着只会让图例/体检显示一个永远为 0 的分类。分桶 key 是**每帧重建、不落盘**的，
 *     因此删中间项不会影响已保存的数据；新增类型请**往后追加**。
 *  store.graph() 会产出 about / in_session / member_of，不加进来它们会被当成「实体」，分类就错了。 */
const LINK_TYPES = ['semantic', 'temporal', 'entity', 'about', 'in_session', 'member_of'];
const LINK_TYPE_INDEX = { semantic: 0, temporal: 1, entity: 2, about: 3, in_session: 4, member_of: 5 };

/** 视图集合；physics 标记该视图是否跑力导向 */
const VIEWS = {
  chain: { physics: true, hint: '关系链 · 力导向 · 点拖单点 · 双击解钉' },
  cluster: { physics: false, hint: '按类型分组 · 确定性簇心' },
  timeline: { physics: false, hint: '按 occurred 时间从旧到新 · 弧线连接' },
  entity: { physics: false, hint: '实体为核 · 记忆环绕卫星轨道' }
};

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 确定性字符串哈希（32 位有符号，djb2 变体）：同一 id 永远得到同一位置，刷新不跳动 */
function hashStr(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return h;
}

/** 把 hash 折叠成 [0,1) 的无符号小数 */
function hashUnit(s, salt) {
  const h = hashStr(s + '|' + (salt || 0));
  return ((h >>> 0) % 100000) / 100000;
}

function rgba(hex, a) {
  if (typeof hex !== 'string' || hex.charAt(0) !== '#') {
    return 'rgba(142,142,147,' + a + ')';
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * 贝塞尔缓动工厂：把 CSS 的 cubic-bezier(x1,y1,x2,y2) 实现成 JS 函数。
 * 用牛顿迭代反解 x→t，再取 y。卡片展开用的正是 cubic-bezier(.22,1,.36,1)。
 */
function cubicBezierEasing(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const C = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);
  return function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 5; i++) {
      const s = slope(t, x1, x2);
      if (s === 0) break;
      t -= (calc(t, x1, x2) - x) / s;
      t = clamp(t, 0, 1);
    }
    return calc(t, y1, y2);
  };
}
const EASE_CARD = cubicBezierEasing(0.22, 1, 0.36, 1);

/** 手写圆角矩形（不依赖 ctx.roundRect，兼容性更稳） */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/**
 * 按像素宽度把文本折行（中文没有空格，所以逐字测量），最多 maxLines 行，
 * 超出在末行补省略号。measureText 是这里的唯一开销，调用方必须缓存结果。
 */
function layoutText(ctx, text, maxW, maxLines) {
  const raw = [];
  let cur = '';
  const src = String(text == null ? '' : text);
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (ch === '\n') {
      raw.push(cur);
      cur = '';
      continue;
    }
    if (cur !== '' && ctx.measureText(cur + ch).width > maxW) {
      raw.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur !== '') raw.push(cur);
  if (!raw.length) raw.push('');
  const out = raw.slice(0, maxLines);
  if (raw.length > maxLines) {
    let last = out[maxLines - 1];
    while (last.length > 1 && ctx.measureText(last + '…').width > maxW) {
      last = last.slice(0, -1);
    }
    out[maxLines - 1] = last + '…';
  }
  return out;
}

/** 时间字符串保险处理：只取「MM-DD HH:mm」这类短片段展示 */
function shortTime(v) {
  if (!v) return '';
  const s = String(v);
  if (s.length <= 16) return s;
  return s.slice(0, 16);
}

/* =========================================================================
 * 四、空间网格：斥力/碰撞的近似加速结构
 * ========================================================================= */

class SpatialGrid {
  constructor(cell) {
    this.cell = cell > 0 ? cell : 60;
    this.map = new Map();
  }

  /** 数值化 key，比字符串拼接快很多（Map 上千万次查找也扛得住） */
  static key(cx, cy) {
    return (cx + 8192) * 65536 + (cy + 8192);
  }

  clear() {
    this.map.clear();
  }

  insert(n, r) {
    const c = this.cell;
    // 卡片/大节点要落进它覆盖的每一个格子，否则会漏掉邻域碰撞
    const span = Math.max(0, Math.ceil((r || 0) / c));
    const cx = Math.floor(n.x / c);
    const cy = Math.floor(n.y / c);
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const k = SpatialGrid.key(cx + i, cy + j);
        let b = this.map.get(k);
        if (!b) {
          b = [];
          this.map.set(k, b);
        }
        b.push(n);
      }
    }
  }

  bucket(cx, cy) {
    return this.map.get(SpatialGrid.key(cx, cy));
  }

  cellOf(x, y) {
    return [Math.floor(x / this.cell), Math.floor(y / this.cell)];
  }
}

/* =========================================================================
 * 五、屏幕空间标签占位网格（LOD 标签避让）
 * ========================================================================= */

class LabelGrid {
  constructor(cell) {
    this.cell = cell || 9;
    this.occ = new Set();
  }

  clear() {
    this.occ.clear();
  }

  /** 尝试占据一块矩形；成功返回 true，被占返回 false（不写入） */
  claim(x, y, w, h) {
    const c = this.cell;
    const x0 = Math.floor(x / c);
    const x1 = Math.floor((x + w) / c);
    const y0 = Math.floor(y / c);
    const y1 = Math.floor((y + h) / c);
    for (let i = x0; i <= x1; i++) {
      for (let j = y0; j <= y1; j++) {
        if (this.occ.has(i * 100003 + j)) return false;
      }
    }
    for (let i = x0; i <= x1; i++) {
      for (let j = y0; j <= y1; j++) {
        this.occ.add(i * 100003 + j);
      }
    }
    return true;
  }
}

/* =========================================================================
 * 六、主类
 * ========================================================================= */

export class MemoryGraph {
  /**
   * @param {HTMLElement} container 承载画布的容器（引擎会自建 canvas 铺满它）
   * @param {object} [options]
   *   @param {string}  [options.view='chain']     初始视图
   *   @param {boolean} [options.cards=true]       卡片模式总开关
   *   @param {boolean} [options.motion=true]      环境动效（呼吸/漂浮）
   *   @param {object}  [options.physics]          {repulsion, linkForce, centerForce, linkDistance}
   *   @param {boolean} [options.clusterLabels=true] 是否画纯文字簇标签（绝不画包裹形状）
   *   @param {number}  [options.labelMax=90]      同屏最多标签数（性能上限）
   */
  constructor(container, options = {}) {
    if (typeof document === 'undefined') {
      throw new Error('MemoryGraph 需要 DOM 环境');
    }
    if (!container || !container.appendChild) {
      throw new Error('MemoryGraph: container 必须是 HTMLElement');
    }

    this.container = container;
    this.opts = Object.assign({
      view: 'chain',
      cards: true,
      motion: true,
      clusterLabels: true,
      labelMax: 90,
      physics: {}
    }, options || {});

    /* ---- 物理参数（默认值按 100~800 节点的观感调过，可用 setPhysics 实时覆盖）---- */
    this.physics = Object.assign({
      repulsion: 1400,    // 斥力强度（1/d² 衰减）
      linkForce: 0.055,   // 边弹簧刚度
      centerForce: 0.008, // 向心力（防止整体飘出屏幕）
      linkDistance: 92    // 弹簧自然长度（世界单位）
    }, this.opts.physics || {});

    /* ---- DOM ---- */
    if (typeof getComputedStyle === 'function') {
      const pos = getComputedStyle(container).position;
      if (!pos || pos === 'static') container.style.position = 'relative';
    }
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none'; // 触屏拖动不要触发页面滚动
    canvas.style.cursor = 'default';
    canvas.setAttribute('tabindex', '0');
    container.appendChild(canvas);

    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    /* ---- 状态 ---- */
    this.W = 800;
    this.H = 600;
    this.dpr = 1;
    this.zoom = 1;
    this.cam = { x: 0, y: 0 };          // 屏幕中心对应的世界坐标
    this.camT = { x: 0, y: 0 };         // 相机缓动目标
    this.zoomT = 1;
    this.nodes = [];
    this.links = [];
    this.byId = new Map();
    this.view = VIEWS[this.opts.view] ? this.opts.view : 'chain';
    this.cards = !!this.opts.cards;
    this.motion = !!this.opts.motion;
    this.search = '';
    this.filter = { groups: [], kinds: [], minStrength: 0 };
    this.selected = null;
    this.hover = null;
    this.seed = 1;
    this.alpha = 0;
    this.alphaTarget = 0;
    this.alphaDecay = 0.018;
    this.velocityDecay = 0.86;
    this.trans = null;
    this.drag = null;
    this.pan = null;
    this.dirty = true;
    this.destroyed = false;
    this.hidden = false;
    this.raf = 0;
    this.selT0 = 0;
    this.listeners = new Map();
    this.grid = new SpatialGrid(72);
    this.labelGrid = new LabelGrid(9);
    this._lastStats = 0;
    this._labelBuf = [];
    this._themeKey = '';
    /* 边层缓存 & 脏标记：_moved 表示「这一帧有节点动过/显隐动过」，
       动过就不允许走静态边层缓存（宁可多画一帧，也不能让边滞后于节点）。 */
    this._layer = null;
    this._layerCtx = null;
    this._layerKey = '';
    this._moved = true;
    this.filterRev = 0;
    this._last = this._now();

    /* ---- 主题 ---- */
    this.theme = this._readTheme();

    /* ---- 观察器 & 事件 ---- */
    const RO = typeof ResizeObserver !== 'undefined' ? ResizeObserver : null;
    if (RO) {
      this.ro = new RO(() => this.resize());
      this.ro.observe(container);
    }
    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      this.mo = new MutationObserver(() => {
        const t = this._readTheme();
        if (t !== this.theme) {
          this.theme = t;
          this._themeKey = '';
          // 主题变了要清掉卡片排版缓存（配色影响文本签名）
          for (const n of this.nodes) n._cardCache = null;
          this._kick(true);
        }
      });
      this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    }
    this._onVis = () => {
      this.hidden = !!(document.hidden);
      if (this.hidden) {
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
      } else {
        this._kick(true);
      }
    };
    document.addEventListener('visibilitychange', this._onVis);

    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = (e) => this._pointerUp(e);
    this._onPointerLeave = () => this._setHover(null);
    this._onWheel = (e) => this._wheel(e);
    this._onDblClick = (e) => this._dblClick(e);
    this._onKey = (e) => this._key(e);
    this._onContext = (e) => e.preventDefault();

    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('pointerleave', this._onPointerLeave);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('dblclick', this._onDblClick);
    canvas.addEventListener('contextmenu', this._onContext);
    document.addEventListener('keydown', this._onKey);

    this.resize();
    this._kick(true);
  }

  /* ---------------- 基础工具 ---------------- */

  _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  _readTheme() {
    let t = '';
    if (document.documentElement && document.documentElement.getAttribute) {
      t = document.documentElement.getAttribute('data-theme') || '';
    }
    if (t !== 'light' && t !== 'dark') {
      t = (document.body && document.body.classList && document.body.classList.contains('dark')) ? 'dark' : 'light';
    }
    return t === 'dark' ? 'dark' : 'light';
  }

  get pal() {
    return THEMES[this.theme] || THEMES.light;
  }

  /** 调度下一帧；force=true 时即使没有动画也强制重绘一次 */
  _kick(force) {
    if (this.destroyed) return;
    if (force) this.dirty = true;
    if (this.hidden) return;
    if (this.raf) return;
    this._last = this._now();
    this.raf = requestAnimationFrame((ts) => this._loop(ts));
  }

  /** 重新加热物理（拖拽/改参数/重排后调用） */
  _reheat(a) {
    this.alpha = Math.max(this.alpha, a == null ? 0.7 : a);
    this._kick(true);
  }

  /* ---------------- 尺寸 & 主题 ---------------- */

  resize() {
    if (this.destroyed) return;
    const c = this.container;
    const w = Math.max(80, c.clientWidth || c.offsetWidth || 800);
    const h = Math.max(80, c.clientHeight || c.offsetHeight || 600);
    // dpr 上限 2：4K 屏上再高就是纯浪费填充率
    const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    if (w === this.W && h === this.H && dpr === this.dpr && this.canvas.width === Math.round(w * dpr)) {
      return;
    }
    this.W = w;
    this.H = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this._kick(true);
  }

  /* ---------------- 数据 ---------------- */

  /**
   * 全量替换数据。同名节点继承旧的钉住坐标（避免面板轮询刷新时把用户拖好的
   * 位置打散），新节点位置由 id 哈希确定性播种。
   */
  /**
   * 播种半径：按「节点数 × 平衡间距」估算半径，让初始布局就接近平衡状态。
   *
   * 为什么必须这么做：早期版本把节点全播在半径 140~460 的圆盘里（600 世界单位宽），
   * 真库 1676 节点时间距只有 ~13 单位，而卡片模式的碰撞间距是 78 —— 面积差 36 倍。
   * 于是布局开跑就疯狂外扩，alpha 又会在半路衰减到 0 把它冻住；之后任何一次重新加热
   * （拖动/换视图）都会接着外扩，用户看到的就是「拖一个点，全图在漂」。
   * 按面积算好半径后，初始即近似平衡，重置也只需轻微调整。
   */
  _seedRadius(count) {
    const spacing = this.cards ? 34 : 22; // 与碰撞半径同量级：卡片模式 ≈2×16，圆点模式更紧
    const area = Math.max(1, count) * spacing * spacing;
    return Math.max(220, Math.sqrt(area / Math.PI));
  }

  setData(data) {
    const src = data || {};
    const rawNodes = Array.isArray(src.nodes) ? src.nodes : [];
    const rawLinks = Array.isArray(src.links) ? src.links : [];
    const seedR = this._seedRadius((rawNodes || []).length);
    this._physScale = clamp(seedR / 500, 0.6, 6); // 物理量纲归一因子（见 _tickPhysics 注释）
    const prev = new Map();
    for (const n of this.nodes) prev.set(n.id, n);

    const nodes = [];
    const byId = new Map();
    const order = { memory: 0, person: 1, topic: 2, session: 3 };

    for (let i = 0; i < rawNodes.length; i++) {
      const r = rawNodes[i];
      if (!r || r.id == null) continue;
      const id = String(r.id);
      const group = r.group === 'person' || r.group === 'topic' || r.group === 'session' ? r.group : 'memory';
      const seed = hashUnit(id, this.seed);
      const ang = seed * Math.PI * 2;
      // 半径随总数缩放：先算好平衡半径，再用哈希做 0.55~1.0 的抖动，避免出现完美圆环
      const rad = seedR * (0.55 + hashUnit(id, this.seed + 7) * 0.45);
      const n = {
        id,
        label: String(r.label == null ? '' : r.label),
        group,
        kind: r.kind ? String(r.kind) : (group === 'memory' ? 'factual' : group),
        strength: numOr(r.strength, 0.5, 0, 1),
        poignancy: numOr(r.poignancy, 0, 0, 10),
        occurred: r.occurred || '',
        session: r.session || '',
        source: r.source || '',
        degree: numOr(r.degree, 0, 0, 1e6),
        entities: Array.isArray(r.entities) ? r.entities : [],
        cues: Array.isArray(r.cues) ? r.cues : [],
        evidence: r.evidence == null ? '' : r.evidence,
        recalls: numOr(r.recalls, 0, 0, 1e6),
        weight: numOr(r.weight, 0, 0, 1e6),
        last: r.last || '',
        raw: r,
        isMem: group === 'memory',
        /* 内部渲染/物理字段 */
        x: Math.cos(ang) * rad * 1.3,
        y: Math.sin(ang) * rad,
        tx: 0,
        ty: 0,
        fx: 0,
        fy: 0,
        vx: 0,
        vy: 0,
        pinned: false,
        noTrans: false,
        vis: 1,
        visT: 1,
        match: 1,
        matchT: 1,
        cardP: 0,
        cardL: 0,
        r: 4,
        deg: 0,
        dim: 0,
        order: order[group] == null ? 0 : order[group],
        phase: hashUnit(id, 3) * Math.PI * 2,
        bobA: hashUnit(id, 11) * Math.PI * 2,
        bobR: 0.6 + hashUnit(id, 13) * 1.8,
        _cardCache: null,
        _cw: 0,
        _ch: 0
      };
      const old = prev.get(id);
      if (old && old.pinned) {
        n.x = old.x;
        n.y = old.y;
        n.pinned = true;
      } else if (old) {
        n.x = old.x;
        n.y = old.y;
      }
      nodes.push(n);
      byId.set(id, n);
    }

    const links = [];
    for (let i = 0; i < rawLinks.length; i++) {
      const l = rawLinks[i];
      if (!l) continue;
      const a = byId.get(String(l.s));
      const b = byId.get(String(l.t));
      if (!a || !b || a === b) continue;
      // 认得的类型原样保留（8 种），真正不认识的才退回 'entity' —— 原来是个只有 4 种的白名单，
      // 于是 about / in_session / member_of 全被强行归成「实体共指」，图例与配色一起错。
      const type = LINK_TYPE_INDEX[l.type] !== undefined ? l.type : 'entity';
      links.push({
        s: String(l.s),
        t: String(l.t),
        type,
        ti: LINK_TYPE_INDEX[type],
        w: numOr(l.w, 1, 0.01, 99),
        a,
        b,
        bundle: 0,
        curve: 0
      });
    }

    /* 度数 + 同源边分扇（bundle），避免多条边完全重叠 */
    const bundleMap = new Map();
    for (const l of links) {
      l.a.deg++;
      l.b.deg++;
      const k = l.a.id < l.b.id ? l.a.id + '|' + l.b.id : l.b.id + '|' + l.a.id;
      const arr = bundleMap.get(k) || [];
      arr.push(l);
      bundleMap.set(k, arr);
    }
    for (const arr of bundleMap.values()) {
      const n = arr.length;
      for (let i = 0; i < n; i++) {
        const bi = i - (n - 1) / 2;
        arr[i].bundle = bi;
        // 同一对节点的多条边：中间那条走直线，其余往两侧散开
        arr[i].curve = n > 1 ? bi * 22 : (hashUnit(arr[i].s + arr[i].t, 5) > 0.5 ? 14 : -14);
      }
    }

    /* 边的优先级排序（一次算好，之后每帧只做一次比较）。
       实测：2500 条抗锯齿曲线在软件光栅化下约 53ms —— 是整张图最贵的一项，
       所以低缩放时按优先级截断（实体骨架边加权，保证「关系链」的主干永远在）。 */
    const ranked = links.slice().sort((x, y) => {
      const px = x.w + (x.type === 'entity' ? 0.6 : 0);
      const py = y.w + (y.type === 'entity' ? 0.6 : 0);
      return py - px;
    });
    for (let i = 0; i < ranked.length; i++) ranked[i].pri = i;

    this.nodes = nodes;
    /* 物理骨架边：每个节点只让最重的 K 条边参与弹簧计算（渲染仍画全部边）。
       为什么要这么做：真库里有度数 522 的实体枢纽（一个话题连着 522 条记忆），
       若它们全部参与弹簧，该节点每帧被拽 500+ 次，冲量远超速度上限 ——
       整片图被持续往中心拖，布局永远收敛不了，用户看到的就是「一直在漂 / 拖一个点全图动」。
       只留骨架边后，布局在几秒内就能稳定，观感也更像「主干 + 细节」。 */
    {
      const K = 8;
      const perNode = new Map();
      for (const l of links) {
        for (const end of [l.a, l.b]) {
          let arr = perNode.get(end);
          if (!arr) perNode.set(end, (arr = []));
          arr.push(l);
        }
      }
      const keep = new Set();
      for (const arr of perNode.values()) {
        if (arr.length <= K) {
          for (const l of arr) keep.add(l);
          continue;
        }
        arr.sort((x, y) => (y.w || 1) - (x.w || 1));
        for (let i = 0; i < K; i++) keep.add(arr[i]);
      }
      this._physLinks = Array.from(keep);
    }

    this.links = links;
    this.byId = byId;
    this.selected = null;
    this.hover = null;

    /* 发光预算（静态阈值，一次算好）。
       shadowBlur 是 canvas 2D 里最贵的东西之一：如果规则写成「度数 >= 6 就发光」，
       在 2500 条边 / 800 节点的密集图里会有大半节点同时发光，软件光栅化下实测能到
       每帧 80ms+。所以这里只让度数排名前 GLOW_MAX 的节点带光晕，其余靠纯色 + 高光点
       表现（视觉上几乎看不出差别，帧时间差一个数量级）。 */
    const GLOW_MAX = 110;
    const degs = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) degs[i] = nodes[i].deg;
    degs.sort((a, b) => a - b);
    const pick = Math.max(0, degs.length - GLOW_MAX);
    this._glowDeg = degs.length ? Math.max(8, degs[pick]) : 8;

    this._recomputeVisibility();
    this._applyLayout(this.view, false);
    if (VIEWS[this.view].physics) this._reheat(1);
    this.dirty = true;
    this._emitStats(true);
    this._kick(true);
  }

  /* ---------------- 过滤 / 搜索 ---------------- */

  /** 过滤/搜索变化后重算可见性（filterRev 用于让边层缓存失效） */
  _recomputeVisibility() {
    this.filterRev = (this.filterRev + 1) % 100000;
    const f = this.filter;
    const gset = f.groups && f.groups.length ? new Set(f.groups) : null;
    const kset = f.kinds && f.kinds.length ? new Set(f.kinds) : null;
    const minS = numOr(f.minStrength, 0, 0, 1);
    for (const n of this.nodes) {
      let ok = true;
      if (gset && !gset.has(n.group)) ok = false;
      if (ok && kset && !kset.has(n.kind)) ok = false;
      // 只有记忆有强度概念，实体不参与 minStrength 过滤
      if (ok && n.isMem && n.strength < minS) ok = false;
      n.visT = ok ? 1 : 0;
    }
    const q = String(this.search || '').trim().toLowerCase();
    for (const n of this.nodes) {
      if (!q) {
        n.matchT = 1;
        continue;
      }
      const hay = (n.label + ' ' + n.entities.join(' ') + ' ' + n.cues.join(' ') + ' ' + (n.evidence || '')).toLowerCase();
      n.matchT = hay.indexOf(q) >= 0 ? 1 : 0;
    }
  }

  setSearch(q) {
    this.search = q == null ? '' : String(q);
    this._recomputeVisibility();
    this._kick(true);
    this._emitStats(true);
  }

  setFilter(filter) {
    const f = filter || {};
    this.filter = {
      groups: Array.isArray(f.groups) ? f.groups.slice() : [],
      kinds: Array.isArray(f.kinds) ? f.kinds.slice() : [],
      minStrength: numOr(f.minStrength, 0, 0, 1)
    };
    this._recomputeVisibility();
    this._emitStats(true);
    this._kick(true);
  }

  /* ---------------- 参数开关 ---------------- */

  setPhysics(p) {
    if (!p) return;
    if (p.repulsion != null) this.physics.repulsion = clamp(Number(p.repulsion) || 0, 10, 20000);
    if (p.linkForce != null) this.physics.linkForce = clamp(Number(p.linkForce) || 0, 0, 1);
    if (p.centerForce != null) this.physics.centerForce = clamp(Number(p.centerForce) || 0, 0, 0.5);
    if (p.linkDistance != null) this.physics.linkDistance = clamp(Number(p.linkDistance) || 0, 10, 400);
    this._reheat(0.55);
  }

  /** 边优先级预算（低缩放时最多画多少条边）；调大可看更多细节，调小更省 GPU */
  setLinkBudget(max) {
    const n = Number(max);
    if (isFinite(n) && n > 0) {
      this.opts.linkMax = clamp(n, 100, 20000);
      this._kick(true);
    }
  }

  setCards(on) {
    this.cards = !!on;
    // 卡片碰撞半径和圆点不同，开关后需要重新松弛一下，否则会瞬间重叠
    if (this.cards && VIEWS[this.view].physics) this._reheat(0.5);
    this._kick(true);
  }

  setMotion(on) {
    this.motion = !!on;
    this._kick(true);
  }

  /* ---------------- 视图 ---------------- */

  setView(name) {
    if (!VIEWS[name] || name === this.view) return;
    this.view = name;
    this._applyLayout(name, true);
    if (VIEWS[name].physics) this._reheat(0.9);
    this.emit('viewchange', name);
    this._kick(true);
  }

  /** 换个种子重新播种（链视图会重新跑物理） */
  reshuffle() {
    this.seed = (this.seed * 1103515245 + 12345) % 2147483647;
    if (this.view === 'chain') {
      const now = this._now();
      for (const n of this.nodes) {
        const ang = hashUnit(n.id, this.seed) * Math.PI * 2;
        const rad = this._seedRadius(this.nodes.length) * (0.55 + hashUnit(n.id, this.seed + 7) * 0.45);
        n.fx = n.x;
        n.fy = n.y;
        n.tx = Math.cos(ang) * rad * 1.3;
        n.ty = Math.sin(ang) * rad;
        n.noTrans = false;
      }
      this._startTransition();
      this._reheat(1);
    } else {
      this._applyLayout(this.view, true);
    }
    this._kick(true);
  }

  /**
   * 计算目标布局。所有视图都产出「确定性的目标坐标」，由 500ms 缓动插值过去，
   * 而不是硬切；chain 视图插值结束后交给力导向继续收拢。
   */
  _applyLayout(name, animate) {
    const nodes = this.nodes;
    if (!nodes.length) {
      this.trans = null;
      return;
    }
    // 布局尺度跟着视口走：宽画布上簇/时间轴铺得更开，不会挤在中间一小块
    const span = Math.max(320, Math.min(this.W, this.H) * 1.4);

    if (name === 'chain') {
      this._layoutChain();
    } else if (name === 'cluster') {
      this._layoutCluster(span);
    } else if (name === 'timeline') {
      this._layoutTimeline(span);
    } else {
      this._layoutEntity(span);
    }

    if (animate) {
      for (const n of nodes) {
        n.fx = n.x;
        n.fy = n.y;
        n.noTrans = false;
      }
      this._startTransition();
    } else {
      for (const n of nodes) {
        n.x = n.tx;
        n.y = n.ty;
        n.fx = n.tx;
        n.fy = n.ty;
      }
      this._moved = true;
      this.trans = null;
    }
  }

  _startTransition() {
    this.trans = { t0: this._now(), dur: 500 };
  }

  /** chain：确定性播种（刷新不跳动），交给物理自己收拢 */
  _layoutChain() {
    for (const n of this.nodes) {
      const ang = hashUnit(n.id, this.seed) * Math.PI * 2;
      const rad = 140 + hashUnit(n.id, this.seed + 7) * 320;
      n.tx = Math.cos(ang) * rad * 1.3;
      n.ty = Math.sin(ang) * rad;
    }
  }

  /** cluster：按 kind 分组，簇心用确定性环形排布，簇内向日葵散点 */
  _layoutCluster(span) {
    const groups = new Map();
    for (const n of this.nodes) {
      const key = n.isMem ? 'm:' + n.kind : 'e:' + n.kind;
      const arr = groups.get(key) || [];
      arr.push(n);
      groups.set(key, arr);
    }
    const keys = Array.from(groups.keys()).sort();
    const K = Math.max(1, keys.length);
    // 簇心半径随簇数量增长，避免簇太多时挤成一坨
    const ringR = Math.min(span, 90 + Math.sqrt(this.nodes.length) * 34 * (K > 4 ? 1.15 : 0.8));
    const GOLD = 2.399963229728653;
    keys.forEach((key, ki) => {
      const members = groups.get(key);
      const ang0 = (ki / K) * Math.PI * 2 - Math.PI / 2;
      const cx = Math.cos(ang0) * ringR * 1.25;
      const cy = Math.sin(ang0) * ringR;
      const blob = 34 + Math.sqrt(members.length) * 30;
      members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      members.forEach((n, i) => {
        const h = hashUnit(n.id, 31);
        const ang = ang0 + i * GOLD + (h - 0.5) * 0.34;
        const rr = blob * Math.sqrt((i + 0.7) / members.length) * (0.86 + 0.26 * hashUnit(n.id, 37));
        n.tx = cx + Math.cos(ang) * rr;
        n.ty = cy + Math.sin(ang) * rr;
      });
    });
  }

  /** timeline：记忆按 occurred 从旧到新横向铺开，实体挂在它第一条记忆的上方 */
  _layoutTimeline(span) {
    const mems = this.nodes.filter((n) => n.isMem);
    const ents = this.nodes.filter((n) => !n.isMem);
    mems.sort((a, b) => {
      const ka = String(a.occurred || a.last || '');
      const kb = String(b.occurred || b.last || '');
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    const n = Math.max(1, mems.length);
    const step = clamp(span / n, 42, 120);
    const x0 = -((n - 1) * step) / 2;
    mems.forEach((m, i) => {
      m.tx = x0 + i * step;
      m.ty = 0;
    });
    const idx = new Map();
    mems.forEach((m, i) => idx.set(m.id, i));
    /* 实体锚点：扫一遍边算出「实体 → 时间轴上最靠前的那条记忆」。
       只扫一次 O(links)，否则每个实体都要遍历全部边（800 实体 × 2500 边会明显卡顿）。 */
    const anchorOf = new Map();
    for (let i = 0; i < this.links.length; i++) {
      const l = this.links[i];
      let e = null;
      let mi = -1;
      if (!l.a.isMem && idx.has(l.b.id)) {
        e = l.a;
        mi = idx.get(l.b.id);
      } else if (!l.b.isMem && idx.has(l.a.id)) {
        e = l.b;
        mi = idx.get(l.a.id);
      }
      if (!e) continue;
      const cur = anchorOf.get(e.id);
      if (cur == null || mi < cur) anchorOf.set(e.id, mi);
    }
    /* 实体挂在上/下两条带上交替，避免压在一起 */
    const placed = new Map();
    for (const e of ents) {
      const a0 = anchorOf.get(e.id);
      const anchor = a0 == null ? null : a0;
      const gi = anchor == null ? hashUnit(e.id, 41) : anchor;
      const lane = e.kind === 'person' ? 1 : e.kind === 'topic' ? 1 : e.kind === 'session' ? -1 : (hashUnit(e.id, 43) > 0.5 ? 1 : -1);
      const used = placed.get(lane + '|' + Math.round(gi)) || 0;
      placed.set(lane + '|' + Math.round(gi), used + 1);
      e.tx = (anchor == null ? x0 + hashUnit(e.id, 47) * n * step : x0 + anchor * step) + used * 26 - 13;
      e.ty = lane * (74 + used * 22);
    }
  }

  /** entity：实体在中心环，它关联的记忆围绕成卫星轨道；无归属记忆丢到外圈 */
  _layoutEntity(span) {
    const ents = this.nodes.filter((n) => !n.isMem).sort((a, b) => (a.id < b.id ? -1 : 1));
    const mems = this.nodes.filter((n) => n.isMem);
    const ringR = Math.max(120, Math.min(span * 0.42, 70 + ents.length * 22));
    const linksOf = new Map();
    for (const l of this.links) {
      if (l.a.isMem && !l.b.isMem) {
        const arr = linksOf.get(l.b.id) || [];
        arr.push(l.a);
        linksOf.set(l.b.id, arr);
      } else if (l.b.isMem && !l.a.isMem) {
        const arr = linksOf.get(l.a.id) || [];
        arr.push(l.b);
        linksOf.set(l.a.id, arr);
      }
    }
    const assigned = new Set();
    ents.forEach((e, i) => {
      const ang = (i / Math.max(1, ents.length)) * Math.PI * 2 - Math.PI / 2;
      e.tx = Math.cos(ang) * ringR * 1.3;
      e.ty = Math.sin(ang) * ringR;
      const satellites = (linksOf.get(e.id) || []).filter((m) => !assigned.has(m.id));
      satellites.forEach((m) => assigned.add(m.id));
      const r0 = 46 + Math.sqrt(Math.max(1, satellites.length)) * 17;
      satellites.forEach((m, j) => {
        const a = ang + (j / Math.max(1, satellites.length)) * Math.PI * 2 + (hashUnit(m.id, 53) - 0.5) * 0.5;
        const rr = r0 * (0.72 + 0.5 * hashUnit(m.id, 59));
        m.tx = e.tx + Math.cos(a) * rr;
        m.ty = e.ty + Math.sin(a) * rr;
      });
    });
    /* 没有实体锚点的记忆：均匀铺在外圈，保证不会全部堆在原点 */
    const orphans = mems.filter((m) => !assigned.has(m.id));
    const outerR = ringR + 150 + Math.sqrt(Math.max(1, orphans.length)) * 12;
    orphans.forEach((m, i) => {
      const a = (i / Math.max(1, orphans.length)) * Math.PI * 2 - Math.PI / 2;
      m.tx = Math.cos(a) * outerR * 1.28;
      m.ty = Math.sin(a) * outerR;
    });
  }

  /* ---------------- 相机 ---------------- */

  worldToScreen(x, y) {
    return {
      x: (x - this.cam.x) * this.zoom + this.W / 2,
      y: (y - this.cam.y) * this.zoom + this.H / 2
    };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.W / 2) / this.zoom + this.cam.x,
      y: (sy - this.H / 2) / this.zoom + this.cam.y
    };
  }

  /** 自动取景：把可见节点的包围盒塞进视口（带缓动，由相机插值完成） */
  fitView() {
    const act = this.nodes.filter((n) => n.vis > 0.35);
    if (!act.length) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of act) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const pad = 90;
    const spanX = Math.max(1, maxX - minX) + pad;
    const spanY = Math.max(1, maxY - minY) + pad;
    this.zoomT = clamp(Math.min(this.W / spanX, this.H / spanY), 0.25, 4);
    this.camT.x = (minX + maxX) / 2;
    this.camT.y = (minY + maxY) / 2;
    this._kick(true);
  }

  /* ---------------- 交互 ---------------- */

  _localPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /**
   * 命中测试：卡片模式下用卡片矩形，否则用半径（最小 9px，保证小圆点也好点中）。
   * 从后往前遍历（后画的在上层），取距离最近的那个。
   */
  _hitTest(sx, sy) {
    const nodes = this.nodes;
    const cardMode = this.cards && this.zoom >= 1.15;
    let best = null;
    let bestD = Infinity;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.vis < 0.35) continue;
      const s = this.worldToScreen(n.x, n.y);
      if (n.isMem && cardMode && n._cw > 1) {
        const hw = n._cw / 2;
        const hh = n._ch / 2;
        if (sx >= s.x - hw && sx <= s.x + hw && sy >= s.y - hh && sy <= s.y + hh) {
          const d = (sx - s.x) * (sx - s.x) + (sy - s.y) * (sy - s.y);
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
        continue;
      }
      const r = Math.max(9, n.r * this.zoom + 5);
      const d = (sx - s.x) * (sx - s.x) + (sy - s.y) * (sy - s.y);
      if (d < r * r && d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  _pointerDown(e) {
    const p = this._localPos(e);
    this.canvas.focus && this.canvas.focus({ preventScroll: true });
    const hit = this._hitTest(p.x, p.y);
    if (hit && e.button === 0) {
      // 按住节点 = 只拖它，绝不触发平移
      this.drag = { node: hit, moved: false, wasPinned: hit.pinned, sx: p.x, sy: p.y };
      hit.pinned = true;
      hit.noTrans = true;
      hit.vx = 0;
      hit.vy = 0;
      this._setHover(hit);
      this._reheat(0.18); // 稠密图下 0.35 会把整片重新推一轮，拖动只需要「邻居跟得上」
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch (err) { /* 某些引擎不支持 pointer capture，忽略即可 */ }
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      this.pan = { sx: p.x, sy: p.y, cx: this.cam.x, cy: this.cam.y, moved: false };
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch (err) { /* 同上 */ }
      e.preventDefault();
    }
  }

  _pointerMove(e) {
    const p = this._localPos(e);
    if (this.drag) {
      const w = this.screenToWorld(p.x, p.y);
      const n = this.drag.node;
      n.x = w.x;
      n.y = w.y;
      n.vx = 0;
      n.vy = 0;
      this._moved = true;
      if (Math.abs(p.x - this.drag.sx) > 3 || Math.abs(p.y - this.drag.sy) > 3) this.drag.moved = true;
      this.dirty = true;
      this._kick(false);
      return;
    }
    if (this.pan) {
      const dx = (p.x - this.pan.sx) / this.zoom;
      const dy = (p.y - this.pan.sy) / this.zoom;
      if (Math.abs(p.x - this.pan.sx) > 3 || Math.abs(p.y - this.pan.sy) > 3) this.pan.moved = true;
      // 平移直接跟手，不走缓动（缓动会让人感觉「粘」）
      this.cam.x = this.pan.cx - dx;
      this.cam.y = this.pan.cy - dy;
      this.camT.x = this.cam.x;
      this.camT.y = this.cam.y;
      this.dirty = true;
      this._kick(false);
      return;
    }
    const hit = this._hitTest(p.x, p.y);
    this._setHover(hit);
    this.canvas.style.cursor = hit ? 'grab' : 'default';
  }

  _pointerUp(e) {
    if (this.drag) {
      const n = this.drag.node;
      if (!this.drag.moved) {
        n.pinned = this.drag.wasPinned; // 只是点了一下，不该把它钉住
        this._select(n);
      } else {
        this._select(n);
        // 松手后的余热要小：热得久了远处节点会被「二次调整」带着漂，
        // 观感上又变成「拖完还整片在动」。钉住的那颗不动，其余冷下来即可。
        this.alpha = Math.min(this.alpha, 0.12);
        this._reheat(0.12);
      }
      n.noTrans = false;
      this.drag = null;
    } else if (this.pan) {
      if (!this.pan.moved) this._select(null); // 点空白 = 取消选中
      this.pan = null;
    }
    try {
      if (this.canvas.releasePointerCapture && e && e.pointerId != null) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    } catch (err) { /* ignore */ }
  }

  /** 双击节点 = 解除钉住并回落到物理/布局里 */
  _dblClick(e) {
    const p = this._localPos(e);
    const hit = this._hitTest(p.x, p.y);
    if (hit && hit.pinned) {
      hit.pinned = false;
      this._reheat(0.5);
    }
  }

  /**
   * 滚轮以鼠标为锚点缩放：锚点下的世界坐标在缩放前后保持不动。
   * 锚点用「目标相机」而不是当前相机来算 —— 连续滚动时缓动还在半路，
   * 用当前值会在动画结束的瞬间出现小幅位移（俗称「漂」）。
   */
  _wheel(e) {
    e.preventDefault();
    const p = this._localPos(e);
    const bx = (p.x - this.W / 2) / this.zoomT + this.camT.x;
    const by = (p.y - this.H / 2) / this.zoomT + this.camT.y;
    const factor = Math.exp(-e.deltaY * 0.0016);
    this.zoomT = clamp(this.zoomT * factor, 0.25, 4);
    this.camT.x = bx - (p.x - this.W / 2) / this.zoomT;
    this.camT.y = by - (p.y - this.H / 2) / this.zoomT;
    this._kick(true);
  }

  _key(e) {
    if (this.destroyed || !this.container.isConnected) return;
    if (e.key === ' ' || e.code === 'Space') {
      const t = e.target;
      const tag = t && t.tagName ? t.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
      e.preventDefault();
      this.fitView();
    } else if (e.key === 'Escape') {
      this._select(null);
    }
  }

  _setHover(n) {
    if (this.hover === n) return;
    this.hover = n || null;
    this._cardTarget(this.hover);
    this.emit('hover', this.hover);
    this._kick(true);
  }

  _select(n) {
    if (this.selected === n) return;
    this.selected = n || null;
    this.selT0 = this._now();
    this._cardTarget(this.selected);
    this.emit('select', this.selected);
    this._kick(true);
  }

  /** 目标卡片展开状态（悬停或选中时展开） */
  _cardTarget(n) {
    for (const x of this.nodes) {
      const want = x === this.hover || x === this.selected ? 1 : 0;
      if (want !== x.cardL) {
        x.cardL = want;
        x.cardT0 = this._now();
        x.cardFrom = x.cardP;
      }
    }
    if (n) this._kick(true);
  }

  /* ---------------- 事件 ---------------- */

  /**
   * 程序化选中：面板从记忆库/详情抽屉「在图谱里看」时用。
   * 引擎内部只有指针驱动选中，缺这一条就没法从外部把某个节点点亮。
   */
  selectNode(id) {
    let n = null;
    if (id) n = this.byId.get(id) || this.nodes.find((x) => x.id === id) || null;
    this._select(n);
    return n ? n.id : null;
  }

  /** 选中并把相机缓动到该节点（顺带放大到卡片可见的层级） */
  focusNode(id, zoom = 1.4) {
    const found = this.selectNode(id);
    if (!found) return null;
    const node = this.byId.get(found) || this.nodes.find((x) => x.id === found);
    if (node) {
      this.camT.x = node.x;
      this.camT.y = node.y;
      this.zoomT = Math.max(this.zoomT || 1, zoom);
      this._kick(true);
    }
    return found;
  }

  on(event, cb) {
    if (typeof cb !== 'function') return () => {};
    const arr = this.listeners.get(event) || [];
    arr.push(cb);
    this.listeners.set(event, arr);
    return () => {
      const cur = this.listeners.get(event) || [];
      const i = cur.indexOf(cb);
      if (i >= 0) cur.splice(i, 1);
    };
  }

  emit(event, payload) {
    const arr = this.listeners.get(event);
    if (!arr || !arr.length) return;
    for (let i = 0; i < arr.length; i++) {
      try {
        arr[i](payload);
      } catch (err) {
        // 监听器自身的异常不该拖垮渲染循环，报到控制台即可
        if (typeof console !== 'undefined') console.error('[MemoryGraph] listener error', event, err);
      }
    }
  }

  _emitStats(force) {
    const now = this._now();
    if (!force && now - this._lastStats < 200) return;
    this._lastStats = now;
    let visible = 0;
    for (const n of this.nodes) if (n.vis > 0.5) visible++;
    this.emit('stats', { nodes: this.nodes.length, links: this.links.length, visible, zoomed: this.zoom });
  }

  getState() {
    const pinned = [];
    for (const n of this.nodes) if (n.pinned) pinned.push(n.id);
    return {
      view: this.view,
      nodeCount: this.nodes.length,
      linkCount: this.links.length,
      zoom: this.zoom,
      selected: this.selected,
      hover: this.hover,
      pinned,
      cards: this.cards
    };
  }

  /* =======================================================================
   * 七、每帧推进：物理 / 过渡 / 缓动（返回是否还需要下一帧）
   * ======================================================================= */

  _loop(ts) {
    this.raf = 0;
    if (this.destroyed || this.hidden) return;
    const now = typeof ts === 'number' ? ts : this._now();
    const dt = clamp(now - this._last, 0, 48);
    this._last = now;
    const busy = this._step(dt, now);
    this._draw(now);
    if (busy) {
      this.raf = requestAnimationFrame((t) => this._loop(t));
    }
  }

  _step(dt, now) {
    let busy = false;
    const f = dt / 16.667; // 帧率无关因子

    /* 1) 视图过渡：位置插值 500ms */
    if (this.trans) {
      const p = clamp((now - this.trans.t0) / this.trans.dur, 0, 1);
      const e = easeInOutCubic(p);
      for (const n of this.nodes) {
        if (n.noTrans) continue;
        n.x = lerp(n.fx, n.tx, e);
        n.y = lerp(n.fy, n.ty, e);
        n.vx = 0;
        n.vy = 0;
      }
      if (p >= 1) {
        for (const n of this.nodes) {
          if (n.noTrans) continue;
          n.x = n.tx;
          n.y = n.ty;
        }
        this.trans = null;
      }
      this._moved = true;
      busy = true;
    }

    /* 2) 力导向（只在 chain 视图、过渡结束后跑） */
    if (!this.trans && VIEWS[this.view].physics) {
      if (this._tickPhysics(f)) busy = true;
    }

    /* 3) 相机缓动：指数趋近，天然帧率无关且不会有回弹 */
    const k = 1 - Math.exp(-dt / 78);
    const dz = this.zoomT - this.zoom;
    const dxc = this.camT.x - this.cam.x;
    const dyc = this.camT.y - this.cam.y;
    if (Math.abs(dz) > 1e-4 || Math.abs(dxc) > 0.05 || Math.abs(dyc) > 0.05) {
      this.zoom = lerp(this.zoom, this.zoomT, k);
      this.cam.x = lerp(this.cam.x, this.camT.x, k);
      this.cam.y = lerp(this.cam.y, this.camT.y, k);
      busy = true;
    } else {
      this.zoom = this.zoomT;
      this.cam.x = this.camT.x;
      this.cam.y = this.camT.y;
    }

    /* 4) 节点级缓动：显隐、搜索降透明、卡片展开 */
    for (const n of this.nodes) {
      if (n.vis !== n.visT) {
        n.vis = approach(n.vis, n.visT, dt / 260);
        // 显隐会改变「哪些边要画」，所以也必须让边层缓存失效
        this._moved = true;
        busy = true;
      }
      if (n.match !== n.matchT) {
        n.match = approach(n.match, n.matchT, dt / 220);
        busy = true;
      }
      const target = n.cardL;
      if (n.cardP !== target) {
        const p = clamp((now - (n.cardT0 || now)) / 220, 0, 1);
        const v = lerp(n.cardFrom == null ? n.cardP : n.cardFrom, target, EASE_CARD(p));
        n.cardP = p >= 1 ? target : v;
        if (p < 1) busy = true;
      }
      n.r = nodeRadius(n);
    }

    /* 5) 环境动效：呼吸脉冲 + 轻微漂浮（有动画就必须继续排帧） */
    if (this.motion) busy = true;
    /* 6) 选中节点有扩散波纹动画 */
    if (this.selected) busy = true;
    /* 7) 脏标记 */
    if (this.dirty) busy = true;

    return busy;
  }

  /**
   * 力导向积分。
   * 斥力用空间网格做 3×3 邻域近似（不建 Barnes-Hut，因为固定半径截断在
   * 这个规模上更省且更稳定）；弹簧按节点度数衰减权重，避免枢纽节点被拉飞。
   */
  _tickPhysics(f) {
    if (this.alpha < 0.004 && !this.drag) {
      /* 不要「半路冻结」：alpha 衰减到 0 就停，会把还没收敛的布局冻住；
         之后任何一次重新加热（拖动/换视图/改参数）都会让整片重新铺开 ——
         用户看到的就是「拖一个点，全图跟着漂」。所以还有明显位移时保持一个低而稳的
         alpha 继续跑到平衡；同时设帧数上限，避免稠密图永远抖着烧电。 */
      const disp = this._maxDisp || 0;
      if (disp > 0.08 && (this._settleFrames || 0) < 1400) {
        this._settleFrames = (this._settleFrames || 0) + 1;
        this.alpha = Math.max(this.alpha, 0.02);
      } else {
        this._settleFrames = 0;
        this.alpha = 0;
        return false;
      }
    } else {
      this._settleFrames = 0;
    }
    const P = this.physics;
    /* 物理量纲归一：布局半径随节点数增长（真库 1676 节点需要 ~1700 的世界半径，
       小图只有几百），但滑条给的是「绝对值」。若不折算，大图上会出现
       「向心力按 1700 的半径拽 + 斥力按 50 的间距推 + 弹簧只想 92 的边」三股力互相顶，
       布局永远收敛不了 —— 表现就是图一直在漂、拖一个点整片跟着动。
       以 R0=500 为基准折算成与规模无关的量，小图行为与以前完全一致。 */
    const sc = this._physScale || 1;
    const rep = P.repulsion * sc * sc;        // 平衡间距 ∝ sc ⇒ 斥力 ∝ sc²
    const dist = P.linkDistance * sc;         // 弹簧自然长度 ∝ sc
    const cforce = P.centerForce / (sc * sc); // 向心力要按 sc² 反比，才不会被大半径放大
    const a = this.alpha;
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay * f;
    if (this.alpha < 0) this.alpha = 0;

    const act = [];
    for (const n of this.nodes) if (n.vis > 0.5) act.push(n);
    if (act.length < 2) return false;

    /* 拖动时的「局部加热」：只有被拖的节点与它的一跳邻居按全强度跑物理，
       其余节点只保留 12% 的力 —— 用户明确讨厌「拖一个点，整片都跟着动」，
       这样拖动时远处的图基本是静止的，只有被拖的那条关系链会松散地跟过来。 */
    const dragFocus = this.drag && this.drag.node ? this.drag.node : null;
    let dragNear = null;
    if (dragFocus) {
      dragNear = new Set([dragFocus]);
      for (let i = 0; i < this.links.length; i++) {
        const l = this.links[i];
        if (l.a === dragFocus) dragNear.add(l.b);
        else if (l.b === dragFocus) dragNear.add(l.a);
      }
    }
    // 12% 在 800 节点以下够用；生产库实测 1676 节点 / 平均度数 19.8 时远处仍会漂，
    // 所以再压一档到 5%，配合拖动时更小的余热，拖一个点才是「只有它和邻居在动」。
    const heat = (n) => (dragNear ? (dragNear.has(n) ? 1 : 0.05) : 1);

    /* 碰撞半径：卡片模式用卡片尺寸，圆点模式用点半径 + 呼吸余量。
       第三参数是「参考缩放偏移」，卡片尺寸按屏幕像素定义而碰撞发生在世界坐标，
       所以固定用卡片刚出现的阈值（zoom=1.15 → 偏移 0）换算，避免缩放反过来搅动物理。 */
    const cardK = 0;
    const grid = this.grid;
    grid.clear();
    for (const n of act) {
      n._col = collideRadius(n, this.cards, cardK);
      grid.insert(n, n._col);
    }

    const maxD = dist * 3.2; // 截断半径：更远的斥力忽略（视觉上无差别）
    const maxD2 = maxD * maxD;
    const cell = grid.cell;

    /* --- 斥力（3×3 邻域） --- */
    for (let i = 0; i < act.length; i++) {
      const n = act[i];
      if (n.pinned) continue;
      const cx = Math.floor(n.x / cell);
      const cy = Math.floor(n.y / cell);
      let fx = 0;
      let fy = 0;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = grid.bucket(gx, gy);
          if (!bucket) continue;
          for (let bi = 0; bi < bucket.length; bi++) {
            const o = bucket[bi];
            if (o === n) continue;
            let dx = n.x - o.x;
            let dy = n.y - o.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) {
              // 完全重合：用哈希给一个确定性的微小偏移，避免除零和抖动
              dx = (hashUnit(n.id + o.id, 71) - 0.5) * 0.6;
              dy = (hashUnit(o.id + n.id, 73) - 0.5) * 0.6;
              d2 = dx * dx + dy * dy + 0.01;
            }
            if (d2 > maxD2) continue;
            const d = Math.sqrt(d2);
            // 软芯斥力：贴得比两者碰撞半径还近时不再按 1/d² 放大。
            // 少了这一步，把节点拖到别人身上时 d→0，斥力瞬间上千，整片图会被炸飞
            // （用户看到的就是「拖一个点，全都散开了」）。
            const soft = (n._col || 6) + (o._col || 6);
            const dEff = d < soft ? soft : d;
            const fq = rep / (dEff * dEff);
            fx += (dx / d) * fq;
            fy += (dy / d) * fq;
          }
        }
      }
      const an = a * heat(n); // 拖动时远处节点只吃 12% 的力
      n.vx += fx * an;
      n.vy += fy * an;
    }

    /* --- 边弹簧 --- */
    // 单帧弹簧位移上限：拖走一个节点时，它连着的邻居会被拉着走，这是对的；
    // 但不设上限的话，长边会一次性把邻居弹飞（用户感受就是「整片都跟着动」）。
    const springMax = 2.6 * f;
    const physLinks = this._physLinks || this.links;
    for (let i = 0; i < physLinks.length; i++) {
      const l = physLinks[i];
      const A = l.a;
      const B = l.b;
      if (A.vis < 0.5 || B.vis < 0.5) continue;
      let dx = B.x - A.x;
      let dy = B.y - A.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const diff = (d - dist) / d;
      const mag = diff * P.linkForce * (l.w > 1 ? 1 + Math.log(l.w) * 0.35 : 1) * a;
      dx *= mag;
      dy *= mag;
      const slen = Math.sqrt(dx * dx + dy * dy);
      if (slen > springMax) {
        dx = (dx / slen) * springMax;
        dy = (dy / slen) * springMax;
      }
      if (!A.pinned && !B.pinned) {
        const ha = heat(A) * 0.5;
        const hb = heat(B) * 0.5;
        A.vx += dx * ha;
        A.vy += dy * ha;
        B.vx -= dx * hb;
        B.vy -= dy * hb;
      } else if (!A.pinned) {
        const ha = heat(A);
        A.vx += dx * ha;
        A.vy += dy * ha;
      } else if (!B.pinned) {
        const hb = heat(B);
        B.vx -= dx * hb;
        B.vy -= dy * hb;
      }
    }

    /* --- 向心力 + 积分 --- */
    const vd = Math.pow(this.velocityDecay, f);
    let maxDisp = 0; // 本帧最大位移：判断「布局到底收敛了没」

    for (let i = 0; i < act.length; i++) {
      const n = act[i];
      if (n.pinned) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      const hn = heat(n);
      n.vx += -n.x * cforce * a * hn;
      n.vy += -n.y * cforce * a * hn;
      n.vx *= vd;
      n.vy *= vd;
      const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (sp > 11) { // 速度上限：改参数或拖动时都不许炸开（11 px/帧 ≈ 660 px/s 已足够快）
        n.vx = (n.vx / sp) * 11;
        n.vy = (n.vy / sp) * 11;
      }
      n.x += n.vx * f;
      n.y += n.vy * f;
      const dp = Math.abs(n.vx) + Math.abs(n.vy);
      if (dp > maxDisp) maxDisp = dp;
    }
    this._maxDisp = maxDisp * f;
    // 有节点真的动过 → 本帧的边层缓存不可复用
    this._moved = true;

    /* --- 碰撞：位置修正（复用同一张网格，一帧内位置漂移很小，够用） --- */
    const maxPush = 1.8 * f; // 单帧最大修正步长（世界单位）
    for (let i = 0; i < act.length; i++) {
      const n = act[i];
      const cx = Math.floor(n.x / cell);
      const cy = Math.floor(n.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = grid.bucket(gx, gy);
          if (!bucket) continue;
          for (let bi = 0; bi < bucket.length; bi++) {
            const o = bucket[bi];
            if (o === n || o.id <= n.id) continue; // 每对只处理一次
            let dx = o.x - n.x;
            let dy = o.y - n.y;
            const minD = n._col + o._col;
            let d2 = dx * dx + dy * dy;
            if (d2 >= minD * minD) continue;
            if (d2 < 1e-4) {
              dx = 0.5;
              dy = 0.5;
              d2 = 0.5;
            }
            const d = Math.sqrt(d2);
            // 单帧修正步长封顶：卡片模式的碰撞半径很大（≈50 世界单位），一帧就按
            // (minD-d)/2 推开的话，级联几次整片图会被「撑爆」——拖动节点时最明显。
            // 封顶后重叠仍是慢慢化开，观感反而是「被挤开」而不是「炸开」。
            const push = Math.min(((minD - d) / d) * 0.5, maxPush / d);
            const pxn = dx * push;
            const pyn = dy * push;
            if (!n.pinned && !o.pinned) {
              n.x -= pxn;
              n.y -= pyn;
              o.x += pxn;
              o.y += pyn;
            } else if (!n.pinned) {
              // 对方被钉住（正在被拖）时，只按 1× 推开：原实现的 2× 会让邻居被弹飞
              n.x -= pxn;
              n.y -= pyn;
            } else if (!o.pinned) {
              o.x += pxn;
              o.y += pyn;
            }
          }
        }
      }
    }

    return this.alpha > 0.004 || !!this.drag;
  }

  /* =======================================================================
   * 八、渲染
   * ======================================================================= */

  _draw(now) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._render(ctx, this.W, this.H, now, false);
    this.dirty = false;
    this._emitStats(false);
  }

  /**
   * 真正的内容绘制。exportPNG 也复用它（同一条代码路径，导出画面 = 当前画面）。
   * @param {CanvasRenderingContext2D} ctx 已经 scale(dpr) 过的上下文
   */
  _render(ctx, W, H, now, forExport) {
    const pal = this.pal;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (!this.nodes.length) {
      ctx.fillStyle = pal.sub;
      ctx.font = '13px ' + FONT_UI;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('暂无记忆数据', W / 2, H / 2);
      return;
    }

    this._drawDotGrid(ctx, W, H);
    if (this.opts.clusterLabels) this._drawClusterLabels(ctx);

    /* ---- 边：能缓存就缓存 ----
       实测 2500 条边的光栅化占了整帧 ~90% 的时间。而最常见的稳态（物理已冷却 +
       呼吸动效在跑）里节点坐标其实是不动的 —— 呼吸只改半径、不改坐标 ——
       所以把「非焦点边」整层渲到离屏画布，稳态每帧只做一次 drawImage。
       判定条件刻意保守：任何节点移动 / 视图过渡 / 拖拽 / 相机缓动 / 显隐动画期间
       都直接画到主画布，绝不让缓存引入一帧延迟。 */
    const camStill = Math.abs(this.zoom - this.zoomT) < 1e-3 &&
      Math.abs(this.cam.x - this.camT.x) < 0.05 && Math.abs(this.cam.y - this.camT.y) < 0.05;
    const cacheable = camStill && !this._moved && !this.trans && !this.drag && this.alpha === 0;
    const focusId = (this.hover && this.hover.id) || (this.selected && this.selected.id) || '';
    const layerKey = cacheable
      ? [this.view, this.theme, W, H, this.dpr, Math.round(this.zoom * 1000),
        Math.round(this.cam.x * 10), Math.round(this.cam.y * 10), focusId, this.links.length,
        this.filterRev | 0].join('|')
      : '';
    if (layerKey && this._layerKey === layerKey) {
      ctx.drawImage(this._layer, 0, 0, W, H);
    } else if (layerKey) {
      const lc = this._ensureLayer(W, H);
      lc.clearRect(0, 0, W, H);
      this._drawLinkBase(lc);
      this._layerKey = layerKey;
      ctx.drawImage(this._layer, 0, 0, W, H);
    } else {
      this._layerKey = '';
      this._drawLinkBase(ctx);
    }
    this._drawLinkHot(ctx, now);

    this._drawNodes(ctx, now);
    this._drawLabels(ctx, now);
    this._drawSelection(ctx, now);
    if (!forExport) this._drawHoverTip(ctx);
    this._moved = false;
  }

  /** 离屏的「静态边层」画布（按需创建 / 尺寸变化时重建） */
  _ensureLayer(W, H) {
    const w = Math.max(1, Math.round(W * this.dpr));
    const h = Math.max(1, Math.round(H * this.dpr));
    if (!this._layer) {
      this._layer = document.createElement('canvas');
      this._layerCtx = this._layer.getContext('2d');
    }
    if (this._layer.width !== w || this._layer.height !== h) {
      this._layer.width = w;
      this._layer.height = h;
    }
    this._layerCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return this._layerCtx;
  }

  /** 极淡点阵网格：缩小时自动稀疏，避免糊成一片噪点 */
  _drawDotGrid(ctx, W, H) {
    let step = 26;
    const z = Math.max(this.zoom, 0.01);
    while (step * z < 17) step *= 2;
    while (step * z > 54) step /= 2;
    const s = step * z;
    if (!(s > 4)) return;
    const ox = ((W / 2 - this.cam.x * z) % s + s) % s;
    const oy = ((H / 2 - this.cam.y * z) % s + s) % s;
    ctx.fillStyle = this.pal.grid;
    ctx.beginPath();
    for (let x = ox; x < W; x += s) {
      for (let y = oy; y < H; y += s) {
        ctx.rect(x, y, 1.7, 1.7);
      }
    }
    ctx.fill();
  }

  /** 纯文字簇标签（带淡阴影）。这里刻意不画任何凸包/虚线框——用户明确讨厌包裹形状 */
  _drawClusterLabels(ctx) {
    const buckets = new Map();
    for (const n of this.nodes) {
      if (n.vis < 0.5) continue;
      const key = n.isMem ? n.kind : n.kind;
      const b = buckets.get(key) || { sx: 0, sy: 0, c: 0, isMem: n.isMem };
      const s = this.worldToScreen(n.x, n.y);
      b.sx += s.x;
      b.sy += s.y;
      b.c += 1;
      buckets.set(key, b);
    }
    const pal = this.pal;
    ctx.font = FONT_CLUSTER;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.shadowColor = pal.cardShadow;
    ctx.shadowBlur = 8;
    for (const [key, b] of buckets) {
      if (b.c < 3) continue;
      const x = b.sx / b.c;
      const y = b.sy / b.c;
      if (x < 20 || x > this.W - 20 || y < 16 || y > this.H - 16) continue;
      const name = (b.isMem ? KIND_LABELS[key] : GROUP_LABELS[key]) || key;
      ctx.fillStyle = this.theme === 'dark' ? 'rgba(232,234,237,.62)' : 'rgba(29,29,31,.5)';
      ctx.fillText(name + ' · ' + b.c, x, y);
    }
    ctx.restore();
  }

  /* ---------------- 边 ---------------- */

  /**
   * 边绘制：按类型批量描边 + 二次贝塞尔曲率 + 同源边扇形散开。
   * 悬停时：与悬停节点相连的边满血 + 发光 + 流动粒子，其余降到 8%。
   */
  /**
   * 边的静态部分（非焦点边）。
   * 这部分是整张图最贵的绘制：实测 2500 条抗锯齿曲线在软件光栅化下约 53ms/帧，
   * 而节点 + 标签 + 网格加起来只有 1ms 左右。所以做两件事：
   *   ① 缩放越小越按优先级截断（低缩放下 2500 条线本来就是一团糊）；
   *   ② 这一层会被缓存成离屏画布（见 _render 的 link layer），
   *      场景静止时每帧只需一次 drawImage。
   */
  _drawLinkBase(ctx) {
    const links = this.links;
    const focus = this.hover || this.selected || null;
    const curved = this.view === 'timeline';
    const zoom = this.zoom;

    /* 分档预算：只画 pri 排在前面的边。放大后屏幕上本来就没几条边，等于不截断。 */
    const total = links.length;
    const cap = this.opts.linkMax || 1400;
    let budget;
    if (zoom >= 1) budget = total;
    else if (zoom >= 0.6) budget = Math.min(total, cap);
    else if (zoom >= 0.35) budget = Math.min(total, Math.round(cap * 0.6));
    else budget = Math.min(total, Math.round(cap * 0.3));

    /* 帧内缓存复用：边记录和分桶数组都持久化，避免每帧给上千条边造上千个对象
       （那是每秒十几万次分配，GC 会以抖动形式吃掉帧时间）。 */
    const pool = this._recPool || (this._recPool = []);
    let pc = 0;
    const buckets = this._linkBuckets || (this._linkBuckets = new Map());
    for (const arr of buckets.values()) arr.length = 0;

    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      const A = l.a;
      const B = l.b;
      if (A.vis < 0.35 || B.vis < 0.35) continue;
      // 焦点边由 _drawLinkHot 单独画（永远满血，不受预算截断影响）
      if (focus && (A === focus || B === focus)) continue;
      if (budget < total && l.pri >= budget) continue;

      const sa = this.worldToScreen(A.x, A.y);
      const sb = this.worldToScreen(B.x, B.y);
      // 视口裁剪：两端连成的包围盒都在视野外就跳过
      if (Math.max(sa.x, sb.x) < -60 || Math.min(sa.x, sb.x) > this.W + 60 ||
          Math.max(sa.y, sb.y) < -60 || Math.min(sa.y, sb.y) > this.H + 60) continue;

      const dx = sb.x - sa.x;
      const dy = sb.y - sa.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 0.01;
      // 屏幕上短到看不见的边直接丢（1px 都画不出的东西不该占光栅化预算）
      if (len < 4) continue;
      const nx = -dy / len;
      const ny = dx / len;
      // 曲率：基础微弧 + 同源边扇形偏移；timeline 视图用大弧（用户要的「弧线」）
      const base = curved ? len * 0.26 : Math.min(len * 0.08, 26);
      const off = l.curve * zoom * (curved ? 0.7 : 0.55);

      let rec = pool[pc];
      if (!rec) {
        rec = {};
        pool[pc] = rec;
      }
      pc++;
      rec.l = l;
      rec.ax = sa.x;
      rec.ay = sa.y;
      rec.bx = sb.x;
      rec.by = sb.y;
      rec.cx = (sa.x + sb.x) / 2 + nx * (base + off);
      rec.cy = (sa.y + sb.y) / 2 + ny * (base + off);

      /* 按「类型 + 透明度分档」分桶：过滤淡出期间每档一次 stroke，
         常态下所有边的档位都是 4，于是退化成「每类型一次 stroke」。 */
      const v = A.vis * B.vis;
      const bucket = v >= 0.999 ? 4 : Math.max(1, Math.round(v * 4));
      const key = (l.ti << 3) | bucket;
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push(rec);
    }

    /* 批量描边：悬停时整体降到 8% 透明度，突出焦点。
       线宽按规模分档 —— 上千条线时细一点，既好看又省一半光栅化时间。 */
    const dimAll = !!focus;
    const thin = total > 1200;
    for (const [key, arr] of buckets) {
      if (!arr.length) continue;
      const t = LINK_TYPES[key >> 3] || 'entity';
      const color = GRAPH_PALETTE.link[t] || '#8e8e93';
      const frac = (key & 7) / 4;
      const a = (dimAll ? 0.08 : 0.46) * frac;
      ctx.strokeStyle = rgba(color, a);
      ctx.lineWidth = dimAll ? (thin ? 0.9 : 1.05) : (thin ? 1 : 1.5);
      ctx.beginPath();
      for (let i = 0; i < arr.length; i++) {
        const r = arr[i];
        ctx.moveTo(r.ax, r.ay);
        ctx.quadraticCurveTo(r.cx, r.cy, r.bx, r.by);
      }
      ctx.stroke();
    }
    return pc;
  }

  /**
   * 焦点边：与悬停/选中节点相连的边满透明度 + 发光 + 沿曲线流动的粒子光点。
   * 单独一层是因为它每帧都要动（粒子在跑），不能进静态缓存层。
   */
  _drawLinkHot(ctx, now) {
    const focus = this.hover || this.selected;
    if (!focus) return;
    const links = this.links;
    const curved = this.view === 'timeline';
    const zoom = this.zoom;

    /* 焦点边分两档画：少数「最重的几条」给模糊发光 + 流动粒子，其余只给一次描边。
       为什么必须分档：Canvas 的 shadowBlur 是逐条模糊 pass，实测真库里度数为 522 的
       枢纽节点会让 522 条边各做一次模糊 —— 光栅化 74ms/帧（软件渲染下 13fps），
       而 JS 只花了 3ms。分档后视觉几乎无差（人眼只跟得住最粗的几条），性能回到 60fps。 */
    const pool = this._hotPool || (this._hotPool = []);
    let n = 0;
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      if ((l.a !== focus && l.b !== focus) || l.a.vis < 0.2 || l.b.vis < 0.2) continue;
      pool[n++] = l;
      if (n >= 420) break; // 上限：再多也看不清，避免大枢纽把帧预算吃光
    }
    if (!n) return;
    pool.length = n;
    if (n > 1) pool.sort((x, y) => (y.w || 1) - (x.w || 1));
    // 度数越大，给发光的条数越少；拖动期间完全不上模糊（跟手优先）
    const glowMax = this.drag ? 0 : n > 160 ? 8 : n > 48 ? 18 : 32;
    const partMax = this.drag ? 0 : n > 160 ? 6 : n > 48 ? 14 : 24;

    for (let i = 0; i < n; i++) {
      const l = pool[i];
      const A = l.a;
      const B = l.b;
      const sa = this.worldToScreen(A.x, A.y);
      const sb = this.worldToScreen(B.x, B.y);
      const dx = sb.x - sa.x;
      const dy = sb.y - sa.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const nx = -dy / len;
      const ny = dx / len;
      const base = curved ? len * 0.26 : Math.min(len * 0.08, 26);
      const off = l.curve * zoom * (curved ? 0.7 : 0.55);
      const cx = (sa.x + sb.x) / 2 + nx * (base + off);
      const cy = (sa.y + sb.y) / 2 + ny * (base + off);
      const color = GRAPH_PALETTE.link[l.type] || '#8e8e93';
      const alpha = Math.min(A.vis, B.vis);
      const lw = 1.1 + Math.min(l.w, 3) * 0.7;
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.quadraticCurveTo(cx, cy, sb.x, sb.y);
      if (i < glowMax) {
        // 真发光：模糊 pass，只给最重的几条
        ctx.strokeStyle = rgba(color, alpha);
        ctx.lineWidth = lw;
        ctx.shadowColor = rgba(color, 0.85 * alpha);
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else {
        // 廉价「伪发光」：先描一条粗的半透明底，再描细亮线 —— 不用模糊也像发光
        ctx.strokeStyle = rgba(color, alpha * 0.22);
        ctx.lineWidth = lw * 3.4;
        ctx.stroke();
        ctx.strokeStyle = rgba(color, alpha * 0.9);
        ctx.lineWidth = lw;
        ctx.stroke();
      }
      if (i < partMax) {
        drawFlowParticles(ctx, { l, ax: sa.x, ay: sa.y, bx: sb.x, by: sb.y, cx, cy }, color, now, this.motion);
      }
    }
  }

  /* ---------------- 节点 ---------------- */

  _drawNodes(ctx, now) {
    const nodes = this.nodes;
    const pal = this.pal;
    const zoom = this.zoom;
    const cardMode = this.cards && zoom >= 1.15;
    const hi = this.hover;
    const sel = this.selected;
    const focusNode = hi || sel;
    /* 发光预算：节点太多时全量 shadowBlur 会直接掉到 20fps，只给重点节点发光 */
    let visibleCount = 0;
    for (const n of nodes) if (n.vis > 0.5) visibleCount++;
    const glowAll = visibleCount <= 260;

    /* 焦点邻居集合：只能在这里一次性算（O(links)）。
       如果放进节点循环里逐点扫边，复杂度会退化成 O(nodes×links)
       —— 800 节点 × 2500 边 = 每帧 200 万次比较，必然掉帧。 */
    const near = focusNode ? new Set() : null;
    if (focusNode) {
      for (let i = 0; i < this.links.length; i++) {
        const l = this.links[i];
        if (l.a === focusNode) near.add(l.b);
        else if (l.b === focusNode) near.add(l.a);
      }
    }

    const cards = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.vis < 0.02) continue;
      const s = this.worldToScreen(n.x, n.y);
      const pad = n.isMem && cardMode ? Math.max(n._cw, n._ch) : 60;
      if (s.x < -pad || s.x > this.W + pad || s.y < -pad || s.y > this.H + pad) continue;
      const color = nodeColor(n);
      const focused = n === hi || n === sel;
      // 搜索/过滤降透明：非命中节点压到很低但保留轮廓
      let alpha = n.vis * (n.match < 1 ? lerp(pal.dim, 1, n.match) : 1);
      if (focusNode && !focused && !near.has(n)) alpha *= 0.4;
      if (alpha < 0.02) continue;

      const breathe = this.motion ? 1 + Math.sin(now / 1400 + n.phase) * 0.05 : 1;
      const r = Math.max(1.2, n.r * zoom * breathe);

      if (n.isMem && cardMode) {
        cards.push({ n, s, color, alpha });
        continue;
      }

      /* 圆点模式：<0.5 只画点；0.5~1.15 画点 + 重要节点标签。
         发光只给「度数排名靠前」的节点（阈值在 setData 里算好），见 _glowDeg 的注释。 */
      const glowThreshold = this._glowDeg || 8;
      const glow = (glowAll || focused || n.deg >= glowThreshold) ? (focused ? 16 : 8 + Math.min(n.deg, 10) * 0.9) : 0;
      ctx.globalAlpha = alpha;
      if (glow > 0) {
        ctx.shadowColor = rgba(color, 0.55);
        ctx.shadowBlur = glow * Math.max(0.6, Math.min(zoom, 1.4));
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // 大图里省掉高光点（每个节点多一次 arc+fill，800 节点就是 800 次），小图才画
      if (zoom > 0.45 && r > 1.6 && visibleCount <= 400) {
        ctx.fillStyle = rgba('#ffffff', this.theme === 'dark' ? 0.22 : 0.35);
        ctx.beginPath();
        ctx.arc(s.x - r * 0.3, s.y - r * 0.32, Math.max(0.5, r * 0.34), 0, Math.PI * 2);
        ctx.fill();
      }
      if (focused) {
        ctx.strokeStyle = this.theme === 'dark' ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.55)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 3.4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      n.dim = alpha;
      n._rScreen = r;
    }

    /* 卡片最后画，保证压在其他节点上面。
       （缩放 <0.5 时 cardMode 为 false，上面根本不会往 cards 里塞东西，
        所以这里不需要「极小缩放降级成圆点」的分支。）

       卡片防重叠（绘制期占位）：
       卡片是按屏幕像素画的（约 170×56），而物理里的碰撞半径是点级的（约 16 世界单位），
       所以放大后密集区域的卡片会互相压住、糊成一团（真机 30 节点放大到 1.64× 就是这样）。
       这里按「悬停/选中 → 度数 → 强度」的优先级抢位置：
       抢不到的节点退回画一个圆点 —— 它依然可点、可悬停，悬停时会立刻换成卡片。 */
    const cardGrid = this._cardGrid || (this._cardGrid = new LabelGrid(12));
    cardGrid.clear();
    if (cards.length > 1) {
      const score = (n) => (n === hi || n === sel ? 1e9 : 0) + (n.deg || 0) * 100 + (n.strength || 0) * 10;
      cards.sort((a, b) => score(b.n) - score(a.n));
    }
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const grow = 1 + 0.08 * (c.n.cardP || 0);        // 悬停展开时卡片更大，占位一起算
      const w = (c.n._cw ? c.n._cw * grow : 172) + 4;
      const h = (c.n._ch ? c.n._ch * grow : 58) + 4;
      if (cardGrid.claim(c.s.x - w / 2, c.s.y - h / 2, w, h)) {
        this._drawCard(ctx, c.n, c.s, c.color, c.alpha, now);
        continue;
      }
      // 抢不到位置：画个小点表示「这里还有一条记忆」，不遮挡别人的卡片
      const r = Math.max(2, c.n.r * zoom);
      ctx.globalAlpha = c.alpha;
      ctx.fillStyle = c.color;
      ctx.beginPath();
      ctx.arc(c.s.x, c.s.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      c.n._rScreen = r;
      /* 降级成点时必须把卡片尺寸清掉：
         否则 _cw/_ch 会留着「上一次当卡片时」的值，点击命中判定（_hitTest 用 _cw/_ch 算半径）
         就会在这个点周围留一块看不见的卡片大小热区，点空白也会选中它。 */
      c.n._cw = 0;
      c.n._ch = 0;
    }
  }

  /**
   * 记忆节点卡片。
   * 缩放 ≥1.15 时出现；悬停/选中时「展开」——放大 1.08、显示 poignancy/时间/召回，
   * 过渡用 220ms cubic-bezier(.22,1,.36,1)（cardP 由 _step 逐帧算好）。
   * 排版结果按签名缓存，避免每帧对上百张卡片逐字 measureText。
   */
  _drawCard(ctx, n, s, color, alpha, now) {
    const p = clamp(n.cardP, 0, 1);
    const zoomK = clamp((this.zoom - 1.15) / 0.85, 0, 1);
    const baseW = 150 + 40 * zoomK;
    const grow = 1 + 0.08 * p;
    const cw = baseW * grow;
    const padX = 11;
    const innerW = cw - padX * 2 - 6;
    const maxLines = p > 0.55 ? 4 : 2;
    const themeKey = this.theme;
    const sig = themeKey + '|' + Math.round(cw) + '|' + maxLines + '|' + n.label.length;
    let cache = n._cardCache;
    if (!cache || cache.sig !== sig) {
      ctx.font = FONT_CARD_B;
      const lines = layoutText(ctx, n.label || '(无摘要)', innerW, maxLines);
      cache = { sig, lines, titleH: lines.length * 15 };
      n._cardCache = cache;
    }
    const lines = cache.lines;
    const headerH = 12;
    const bodyH = p > 0.02 ? (26 * p) : 0;
    const barH = 4;
    const padY = 9;
    const ch = padY * 2 + headerH + 4 + cache.titleH + 7 + barH + bodyH;
    n._cw = cw;
    n._ch = ch;

    const x = s.x - cw / 2;
    const y = s.y - ch / 2;
    const pal = this.pal;
    ctx.globalAlpha = alpha;

    // 悬停/选中的卡片才投影：全局投影在几十上百张卡片上非常贵
    if (p > 0.02) {
      ctx.shadowColor = pal.cardShadow;
      ctx.shadowBlur = 14 * p;
      ctx.shadowOffsetY = 3 * p;
    }
    roundRect(ctx, x, y, cw, ch, 10);
    ctx.fillStyle = pal.card;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = rgba(color, 0.25 + 0.5 * p);
    ctx.lineWidth = 1 + p * 0.4;
    ctx.stroke();

    // 左侧类型色条（卡片的「身份证」）
    ctx.save();
    roundRect(ctx, x, y, cw, ch, 10);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 3.4, ch);
    ctx.restore();

    const tx = x + padX;
    let ty = y + padY;

    // 头部：类型名 + 强度百分比
    ctx.font = FONT_TINY;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = pal.sub;
    const kindName = n.isMem ? (KIND_LABELS[n.kind] || n.kind) : (GROUP_LABELS[n.kind] || n.kind);
    ctx.fillText(kindName, tx, ty);
    ctx.textAlign = 'right';
    ctx.fillStyle = rgba(color, 0.95);
    ctx.fillText(Math.round(n.strength * 100) + '%', x + cw - padX, ty);

    ty += headerH + 4;

    // 摘要正文（最多 2 行，悬停展开到 4 行）
    ctx.textAlign = 'left';
    ctx.font = FONT_CARD_B;
    ctx.fillStyle = pal.text;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], tx, ty + i * 15);
    }
    ty += cache.titleH + 7;

    // 强度进度条
    const barW = cw - padX * 2;
    roundRect(ctx, tx, ty, barW, barH, barH / 2);
    ctx.fillStyle = pal.track;
    ctx.fill();
    const fillW = Math.max(barH, barW * clamp(n.strength, 0, 1));
    roundRect(ctx, tx, ty, fillW, barH, barH / 2);
    ctx.fillStyle = rgba(color, 0.9);
    ctx.fill();

    // 展开态：补上 poignancy / 时间 / 召回
    if (bodyH > 0) {
      const oy = ty + barH + 6;
      ctx.globalAlpha = alpha * p;
      ctx.font = FONT_TINY;
      ctx.fillStyle = pal.sub;
      ctx.fillText('召回 ' + Math.round(n.recalls) + ' 次 · 深刻度 ' + (Math.round(n.poignancy * 100) / 100), tx, oy);
      const meta = shortTime(n.occurred || n.last);
      if (meta) ctx.fillText(meta, tx, oy + 13);
      ctx.globalAlpha = alpha;
    }

    ctx.globalAlpha = 1;
  }

  /* ---------------- 标签（LOD + 占位避让） ---------------- */

  _drawLabels(ctx, now) {
    const zoom = this.zoom;
    if (zoom < 0.34) return; // 太小了，标签只会变成噪点
    const pal = this.pal;
    const grid = this.labelGrid;
    grid.clear();
    const buf = this._labelBuf;
    buf.length = 0;

    const hi = this.hover;
    const sel = this.selected;
    for (const n of this.nodes) {
      if (n.vis < 0.6) continue;
      // 卡片模式下记忆节点自带摘要文字，不再画标签（否则文字打架）
      if (n.isMem && this.cards && zoom >= 1.15) continue;
      // 搜索未命中的节点不画标签：高亮的意义就是「剩下的更清楚」
      if (n.matchT === 0) continue;
      const s = this.worldToScreen(n.x, n.y);
      if (s.x < -80 || s.x > this.W + 80 || s.y < -40 || s.y > this.H + 40) continue;
      const imp = n === sel ? 1000 : n === hi ? 900 : n.isMem ? n.strength * 20 + Math.min(n.recalls, 20) : n.deg * 3 + 10;
      // 重要节点（度数高/强度高）在更小的缩放下就开始显形：LOD 分层
      const imp0 = imp >= 40 ? 0.24 : 0.5;
      buf.push({ n, s, imp, imp0 });
    }
    buf.sort((a, b) => b.imp - a.imp);

    const max = this.opts.labelMax || 90;
    let drawn = 0;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < buf.length && drawn < max; i++) {
      const it = buf[i];
      const n = it.n;
      // 透明度随缩放渐变（不是突然出现/消失），重要节点阈值更低、先露面
      const focus = n === hi || n === sel;
      const fade = focus ? 1 : smoothstep(it.imp0, it.imp0 + 0.42, zoom);
      if (fade <= 0.02) continue;
      ctx.font = focus ? FONT_LABEL_B : FONT_LABEL;
      const text = n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label;
      const w = ctx.measureText(text).width;
      const h = 14;
      const tx = it.s.x + Math.max(7, n.r * zoom + 5);
      const labelY = it.s.y;
      if (!grid.claim(tx - 2, labelY - h / 2, w + 4, h)) continue;
      drawn++;
      const a = fade * (n.match < 1 ? lerp(0.25, 1, n.match) : 1);
      ctx.globalAlpha = a;
      // 文字垫一层描边，压在节点上也能看清（不画框，只是一层描边）
      ctx.lineWidth = 3;
      ctx.strokeStyle = this.theme === 'dark' ? 'rgba(20,20,20,.72)' : 'rgba(255,255,255,.8)';
      ctx.textAlign = 'left';
      ctx.strokeText(text, tx, labelY);
      ctx.fillStyle = focus ? pal.text : (this.theme === 'dark' ? 'rgba(232,234,237,.86)' : 'rgba(29,29,31,.78)');
      ctx.fillText(text, tx, labelY);
      ctx.globalAlpha = 1;
    }
  }

  /* ---------------- 选中波纹 ---------------- */

  _drawSelection(ctx, now) {
    const n = this.selected;
    if (!n || n.vis < 0.5) return;
    const s = this.worldToScreen(n.x, n.y);
    const color = nodeColor(n);
    const base = n._rScreen || Math.max(3, n.r * this.zoom);
    const rr = n.isMem && this.cards && this.zoom >= 1.15 ? Math.max(n._cw, n._ch) / 2 : base;
    // 静态细描边
    ctx.strokeStyle = rgba(color, 0.95);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(s.x, s.y, rr + 4, 0, Math.PI * 2);
    ctx.stroke();
    // 扩散波纹（周期 1.4s）
    const p = ((now - this.selT0) % 1400) / 1400;
    if (p < 0.999) {
      const rp = rr + 4 + p * 30;
      ctx.strokeStyle = rgba(color, (1 - p) * 0.5);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(s.x, s.y, rp, 0, Math.PI * 2);
      ctx.stroke();
      const rp2 = rr + 4 + ((p + 0.5) % 1) * 30;
      ctx.strokeStyle = rgba(color, (1 - ((p + 0.5) % 1)) * 0.3);
      ctx.beginPath();
      ctx.arc(s.x, s.y, rp2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /* ---------------- 悬停浮层（实体/非卡片节点用） ---------------- */

  _drawHoverTip(ctx) {
    const n = this.hover;
    if (!n || n.vis < 0.5) return;
    // 记忆卡片在放大时本身就会展开信息，这里不重复画浮层
    if (n.isMem && this.cards && this.zoom >= 1.15) return;
    const pal = this.pal;
    const s = this.worldToScreen(n.x, n.y);
    const color = nodeColor(n);
    ctx.font = FONT_CARD_B;
    const title = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label;
    const tw = ctx.measureText(title).width;
    ctx.font = FONT_TINY;
    const kindName = n.isMem ? (KIND_LABELS[n.kind] || n.kind) : (GROUP_LABELS[n.kind] || n.kind);
    const l1 = n.isMem
      ? kindName + ' · 强度 ' + Math.round(n.strength * 100) + '% · 召回 ' + Math.round(n.recalls)
      : kindName + ' · 连接 ' + n.deg;
    const l2 = n.isMem ? ('权重 ' + Math.round(n.weight) + (shortTime(n.occurred) ? ' · ' + shortTime(n.occurred) : '')) : '';
    const w1 = ctx.measureText(l1).width;
    const w2 = l2 ? ctx.measureText(l2).width : 0;
    const w = Math.max(tw, w1, w2) + 22;
    const h = l2 ? 56 : 42;
    let x = s.x + 14;
    let y = s.y - h / 2;
    if (x + w > this.W - 8) x = s.x - w - 14;
    y = clamp(y, 8, this.H - h - 8);
    ctx.globalAlpha = 1;
    ctx.shadowColor = pal.cardShadow;
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;
    roundRect(ctx, x, y, w, h, 9);
    ctx.fillStyle = pal.card;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = rgba(color, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.save();
    roundRect(ctx, x, y, w, h, 9);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 3.4, h);
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = FONT_CARD_B;
    ctx.fillStyle = pal.text;
    ctx.fillText(title, x + 11, y + 8);
    ctx.font = FONT_TINY;
    ctx.fillStyle = pal.sub;
    ctx.fillText(l1, x + 11, y + 26);
    if (l2) ctx.fillText(l2, x + 11, y + 40);
  }

  /* =======================================================================
   * 九、导出 / 销毁
   * ======================================================================= */

  /** 把当前画面（含主题背景）画到离屏 canvas，返回 dataURL */
  exportPNG() {
    const w = Math.max(1, this.W);
    const h = Math.max(1, this.H);
    const dpr = this.dpr;
    const off = document.createElement('canvas');
    off.width = Math.round(w * dpr);
    off.height = Math.round(h * dpr);
    const c2 = off.getContext('2d');
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._render(c2, w, h, this._now(), true);
    try {
      return off.toDataURL('image/png');
    } catch (err) {
      if (typeof console !== 'undefined') console.error('[MemoryGraph] exportPNG 失败', err);
      return '';
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.ro && this.ro.disconnect) this.ro.disconnect();
    if (this.mo && this.mo.disconnect) this.mo.disconnect();
    document.removeEventListener('visibilitychange', this._onVis);
    document.removeEventListener('keydown', this._onKey);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onPointerDown);
    c.removeEventListener('pointermove', this._onPointerMove);
    c.removeEventListener('pointerup', this._onPointerUp);
    c.removeEventListener('pointercancel', this._onPointerUp);
    c.removeEventListener('pointerleave', this._onPointerLeave);
    c.removeEventListener('wheel', this._onWheel);
    c.removeEventListener('dblclick', this._onDblClick);
    c.removeEventListener('contextmenu', this._onContext);
    if (c.parentNode) c.parentNode.removeChild(c);
    this.nodes = [];
    this.links = [];
    this.listeners.clear();
  }
}

/* =========================================================================
 * 十、模块级工具（小函数放在类后面，保持类主体可读）
 * ========================================================================= */

function numOr(v, def, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return clamp(n, lo, hi);
}

/** 指数趋近（帧率无关）；比 lerp(a,b,k) 更稳，参数 dt/ms 直接表达「多久走完」 */
function approach(cur, target, rate) {
  const k = 1 - Math.exp(-clamp(rate, 0, 1) * 4.6);
  const v = cur + (target - cur) * k;
  return Math.abs(target - v) < 0.004 ? target : v;
}

/** 节点颜色：记忆按 atom_type，实体按种类 */
function nodeColor(n) {
  if (n.isMem) return GRAPH_PALETTE.memory[n.kind] || GRAPH_PALETTE.memory.factual;
  return GRAPH_PALETTE.entity[n.group] || GRAPH_PALETTE.entity.topic;
}

/** 节点半径：强度 + 度数共同决定（视觉上「大 = 重要」） */
function nodeRadius(n) {
  if (n.isMem) return 3.1 + clamp(n.strength, 0, 1) * 3.1 + Math.min(n.deg, 8) * 0.22;
  return 4.4 + Math.min(n.deg, 14) * 0.62;
}

/**
 * 碰撞半径。
 * 卡片尺寸是「屏幕像素」而碰撞发生在世界坐标，这里用一个固定参考缩放（1.15，
 * 即卡片刚出现的阈值）把卡片换算成世界尺寸，避免缩放变化反过来搅动物理。
 */
function collideRadius(n, cards, czk) {
  const r = nodeRadius(n);
  if (n.isMem && cards) {
    const w = 150 + 40 * czk;
    /* 只取卡片宽度的一小部分当碰撞半径（≈16 世界单位）。
       理由：碰撞半径是按「均衡面积」直接决定布局尺度的量。
       若按卡片真实尺寸（半宽 ~75）算，1676 个节点需要 ~1000 万平方单位，
       布局宽到 3200 —— 既永远收敛不了（真机实测漂移 167px/0.5s），
       缩到能看全时卡片又小到读不出字，两头不讨好。
       改成点级碰撞后布局紧凑稳定（宽 ~1500），卡片在放大到 1.15× 以上时才出现，
       和 Obsidian 等成熟图谱的做法一致：小图看结构，放大看内容。 */
    return Math.max(r + 3, w * 0.105);
  }
  return r + 3.5;
}

/** 沿二次贝塞尔流动的粒子光点（关系「有向流动感」） */
function drawFlowParticles(ctx, rec, color, now, motion) {
  const t0 = motion ? ((now / 1900) % 1) : ((rec.l.bundle * 0.37 + 0.5) % 1);
  const ax = rec.ax;
  const ay = rec.ay;
  const bx = rec.bx;
  const by = rec.by;
  const cx = rec.cx;
  const cy = rec.cy;
  for (let k = 0; k < 3; k++) {
    const t = t0 + k * 0.22;
    const tt = t > 1 ? t - 1 : t;
    const it = 1 - tt;
    const px = it * it * ax + 2 * it * tt * cx + tt * tt * bx;
    const py = it * it * ay + 2 * it * tt * cy + tt * tt * by;
    const a = Math.sin(Math.PI * tt); // 首尾淡出，中间最亮
    ctx.fillStyle = rgba(color, 0.35 + a * 0.6);
    ctx.beginPath();
    ctx.arc(px, py, 1.5 + a * 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* =========================================================================
 * 十一、自检
 * ========================================================================= */

/**
 * 离屏自检：造 120 节点 / 240 边的合成数据，跑一遍 setData + 四种视图 + fitView。
 * 在非浏览器环境（无 document）直接返回 {ok:false, error:'no-dom'}。
 * @returns {{ok:boolean, nodes?:number, links?:number, ms?:number, error?:string}}
 */
export function selfTest() {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { ok: false, error: 'no-dom' };
  }
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.width = '900px';
  host.style.height = '600px';
  host.style.opacity = '0';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);

  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  let g = null;
  try {
    const kinds = Object.keys(GRAPH_PALETTE.memory);
    const egroups = ['person', 'topic', 'session'];
    const nodes = [];
    const links = [];
    const memIds = [];
    const entIds = [];
    for (let i = 0; i < 60; i++) {
      const id = 'm' + i;
      memIds.push(id);
      nodes.push({
        id,
        label: '记忆摘要 ' + i + ' · 这是一条用于自检的合成记忆文本，用来验证卡片折行与省略号',
        group: 'memory',
        kind: kinds[i % kinds.length],
        strength: (i % 10) / 10,
        poignancy: (i % 7) / 7,
        occurred: '2025-0' + (1 + (i % 9)) + '-1' + (i % 9) + ' 1' + (i % 9) + ':00',
        recalls: i % 12,
        weight: i % 5,
        entities: ['e' + (i % 30)],
        cues: ['线索' + i]
      });
    }
    for (let i = 0; i < 60; i++) {
      const id = 'e' + i;
      entIds.push(id);
      nodes.push({
        id,
        label: '实体 ' + i,
        group: egroups[i % 3],
        kind: egroups[i % 3]
      });
    }
    const ltypes = ['semantic', 'temporal', 'entity'];
    for (let i = 0; i < 240; i++) {
      if (i % 3 === 0) {
        links.push({ s: memIds[i % 60], t: entIds[i % 60], type: 'entity', w: 1 + (i % 3) });
      } else {
        const a = memIds[i % 60];
        const b = memIds[(i * 7 + 3) % 60];
        if (a === b) continue;
        links.push({ s: a, t: b, type: ltypes[i % 4], w: 1 + (i % 2) });
      }
    }

    g = new MemoryGraph(host, { cards: true, motion: false });
    g.setData({ nodes, links });
    const views = ['chain', 'cluster', 'timeline', 'entity'];
    for (const v of views) g.setView(v);
    g.setSearch('记忆');
    g.setFilter({ groups: [], kinds: [], minStrength: 0 });
    g.setPhysics({ repulsion: 900, linkForce: 0.06, centerForce: 0.01, linkDistance: 80 });
    g.setCards(true);
    g.setMotion(false);
    g.fitView();
    g.resize();
    const url = g.exportPNG();
    const st = g.getState();
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    g.destroy();
    host.remove();
    return {
      ok: !!st && typeof url === 'string' && st.nodeCount === 120,
      nodes: st.nodeCount,
      links: st.linkCount,
      ms: Math.round((t1 - t0) * 100) / 100
    };
  } catch (err) {
    try {
      if (g) g.destroy();
      host.remove();
    } catch (e2) { /* 清理失败不重要 */ }
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}
