/**
 * StarHeart Dashboard · 原生 SVG 图表工具箱（零依赖 ES module）
 * =============================================================================
 * 用途：给 AstrBot 插件面板（受限 sandbox iframe：allow-scripts allow-forms
 *       allow-downloads）提供离线可用的可视化组件。全部基于原生 DOM + SVG，
 *       不引任何第三方库、不联网、不用 eval/new Function。
 *
 * 用法：
 *   import * as charts from "./charts.js";
 *   charts.donut("#host", { items: [{ label: "factual", value: 3 }], legend: true });
 *
 * 导出清单：
 *   selfTest,
 *   sparkline, donut, ring, radar, bars, waterfall,
 *   heatstrip, steer(=heatstrip), heatgrid, stageBars, area,
 *   timeline, miniNetwork, sankey, avatar, legend,
 *   themeColors, onThemeChange, palette, isDark,
 *   esc, svgEl, fmtNum, fmtPct, fmtTs
 *
 * 全组件统一约定（改代码前先读这 8 条）：
 *   1) 第一个参数可以是 DOM 元素或选择器字符串；解析不到 → 直接 return null，
 *      绝不抛错（面板是「一个组件崩掉不能拖垮整页」的语境）。
 *   2) 每次调用先清空容器再渲染，所以同一容器可以反复调用（刷新数据/切主题）。
 *   3) 颜色默认走 CSS 变量并带 fallback，如 stroke="var(--primary,#3c96ca)"；
 *      宿主切 data-theme 时不用重画也能跟着变。
 *   4) 宽度不写死：ResizeObserver 监听容器宽度变化后静默重绘；
 *      固定尺寸组件（donut/ring/radar/avatar/network）用 max-width:100% 防溢出。
 *   5) 空数据（空数组 / 全 0 / null）渲染「暂无数据」占位，不留白、不报错。
 *   6) 动画 = requestAnimationFrame 属性插值；prefers-reduced-motion:reduce
 *      或 animate:false 时直接落终态。
 *   7) 所有文本用 textContent 写入（不拼 innerHTML），天然免疫 XSS。
 *   8) 不做 px 宽度的写死；几何量全部由「测量宽度」推导。
 *
 * 设计取舍：不使用 CSS transition 动画几何属性（x/width/r/cx 在部分浏览器不可
 *   过渡），统一用 rAF 插值属性值 —— 行为可控、跨浏览器一致、便于按帧打断。
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const DASH = "—";
const EMPTY_TEXT = "暂无数据";
const GRAY = "var(--tx3,#8e8e93)";

/** 版本号：集成方可以据此做兼容判断。 */

/* ------------------------------------------------------------------ *
 * 主题：读 data-theme + CSS 变量
 * ------------------------------------------------------------------ */

/** 亮/暗两套内置 fallback（宿主变量取不到时用）。 */
const FALLBACK = {
  light: {
    primary: "#3c96ca", info: "#03c9d7", success: "#00c853", warning: "#ffc107", error: "#f44336",
    text: "#1b1c1d", text2: "rgba(0,0,0,.66)", text3: "#8e8e93", surface: "#ffffff",
    line: "rgba(0,0,0,.09)", track: "rgba(0,0,0,.08)",
  },
  dark: {
    primary: "#5ba4d4", info: "#03c9d7", success: "#00c853", warning: "#ffc107", error: "#f44336",
    text: "#e8eaed", text2: "rgba(255,255,255,.66)", text3: "rgba(255,255,255,.45)", surface: "#242424",
    line: "rgba(255,255,255,.09)", track: "rgba(255,255,255,.10)",
  },
};

function docEl() {
  return typeof document !== "undefined" ? document.documentElement : null;
}

/** 当前是否暗色主题：优先 data-theme，其次系统偏好。 */
export function isDark() {
  const el = docEl();
  const attr = el && el.getAttribute ? String(el.getAttribute("data-theme") || "") : "";
  if (attr === "dark") return true;
  if (attr === "light") return false;
  try {
    if (typeof window !== "undefined" && window.matchMedia) {
      return !!window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
  } catch (e) { /* 沙箱里可能被拦，忽略 */ }
  return false;
}

/** 读一个 CSS 变量的计算值；取不到（或空串）返回 fallback。 */
function cssVar(name, fallback) {
  const el = docEl();
  if (!el) return fallback;
  try {
    const v = getComputedStyle(el).getPropertyValue(name);
    const s = v ? v.trim() : "";
    return s || fallback;
  } catch (e) {
    return fallback;
  }
}

/**
 * 返回当前主题下的推荐色板。
 * 语义色（记忆类型 / 关系类型）是设计令牌，直接给固定值，不跟主题走。
 */
export function themeColors() {
  const dark = isDark();
  const f = dark ? FALLBACK.dark : FALLBACK.light;
  return {
    dark,
    primary: cssVar("--primary", f.primary),
    info: cssVar("--info", f.info),
    success: cssVar("--success", f.success),
    warning: cssVar("--warning", f.warning),
    error: cssVar("--error", f.error),
    text: cssVar("--tx1", f.text),
    text2: cssVar("--tx2", f.text2),
    text3: cssVar("--tx3", f.text3),
    surface: cssVar("--surface", f.surface),
    line: cssVar("--bd", f.line),
    track: cssVar("--bd", f.track),
    // 记忆类型色（与面板设计令牌一致）
    factual: "#4a90d9", episodic: "#00a3a3", relational: "#e0559a", preference: "#8b5cf6",
    planned: "#f59e0b", routine: "#64748b", opinion: "#ef6c5a",
    // 关系类型色
    edgeSemantic: "#0074d9", edgeTemporal: "#009296", edgeEntity: "#f59e0b",
    // 通用系列色（都带 CSS 变量 fallback，宿主换肤自动跟随）
    series: [
      "var(--primary,#3c96ca)",
      "var(--info,#03c9d7)",
      "var(--success,#00c853)",
      "var(--warning,#ffc107)",
      "var(--mem-relational,#e0559a)",
      "var(--edge-entity,#f59e0b)",
      "var(--tx3,#8e8e93)",
    ],
  };
}

/** 内部别名：组件里统一用 palette() 拿当前色板。 */
export function palette() {
  return themeColors();
}

/**
 * 监听 data-theme 变化。返回取消函数（组件卸载时调用）。
 * 只观察 documentElement 的属性，不碰 window.top/parent。
 */
export function onThemeChange(cb) {
  if (typeof cb !== "function") return function off() {};
  let obs = null;
  try {
    const el = docEl();
    if (el && typeof MutationObserver !== "undefined") {
      obs = new MutationObserver(function () {
        try {
          cb(themeColors());
        } catch (err) {
          console.warn("[charts] onThemeChange 回调异常", err);
        }
      });
      obs.observe(el, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    }
  } catch (e) {
    obs = null;
  }
  return function off() {
    if (obs) {
      try { obs.disconnect(); } catch (e) { /* ignore */ }
      obs = null;
    }
  };
}

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}
function clamp01(v) {
  return clamp(v, 0, 1);
}
function r2(n) {
  return Math.round(n * 100) / 100;
}
function num(v, dflt) {
  const n = Number(v);
  return isFinite(n) ? n : dflt;
}
function clampNum(v, dflt, lo, hi) {
  const n = Number(v);
  return isFinite(n) ? clamp(n, lo, hi) : dflt;
}

/** HTML 文本转义（组件内部用 textContent，这里给外部拼 HTML 时用）。 */
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/** 创建 SVG 元素并批量设属性（值为 null/undefined 的属性跳过）。 */
export function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      const v = attrs[k];
      if (v == null) continue;
      node.setAttribute(k, String(v));
    }
  }
  return node;
}

/** 创建 HTML 元素（style 用 cssText 直接给，text 走 textContent 天然转义）。 */
function hEl(tag, style, text) {
  const d = document.createElement(tag);
  if (style) d.style.cssText = style;
  if (text != null) d.textContent = String(text);
  return d;
}

/** SVG 文本节点：content 一律走 textContent，禁用 innerHTML。 */
function svgText(attrs, str) {
  const t = svgEl("text", attrs);
  t.textContent = str == null ? "" : String(str);
  return t;
}

/** 给元素加原生 tooltip（hover 悬浮显示）。 */
function tip(node, str) {
  if (!node || str == null) return node;
  const t = svgEl("title");
  t.textContent = String(str);
  node.appendChild(t);
  return node;
}

/** 数字格式化：大数走「万 / 亿」，小数保留 2 位，非数字给 —。 */
export function fmtNum(n, digits) {
  const v = Number(n);
  if (!isFinite(v)) return DASH;
  const a = Math.abs(v);
  const trim = function (s) {
    return s.indexOf(".") >= 0 ? s.replace(/\.?0+$/, "") : s;
  };
  if (a >= 1e8) return trim((v / 1e8).toFixed(2)) + "亿";
  if (a >= 1e4) return trim((v / 1e4).toFixed(2)) + "万";
  if (a >= 1000) return Math.round(v).toLocaleString("en-US");
  if (!Number.isInteger(v)) return v.toFixed(digits == null ? 2 : digits);
  return String(v);
}

/** 比例（0..1）→ 百分比字符串。注意入参是比例不是百分数。 */
export function fmtPct(ratio, digits) {
  const v = Number(ratio);
  if (!isFinite(v)) return DASH;
  return (v * 100).toFixed(digits == null ? 0 : digits) + "%";
}

/** 时间戳格式化：>=1e12 当毫秒，否则当秒；withTime=false 只给 MM-DD。 */
export function fmtTs(ts, withTime) {
  const n = Number(ts);
  if (!n || !isFinite(n)) return DASH;
  const ms = n >= 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return DASH;
  const p = function (x) { return String(x).padStart(2, "0"); };
  const base = p(d.getMonth() + 1) + "-" + p(d.getDate());
  return withTime === false ? base : base + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/** 包装外部给的格式化回调：崩了就退回内置 fmtNum，绝不因为格式化抛错而空图。 */
function useFmt(fn) {
  if (typeof fn !== "function") return fmtNum;
  return function (v) {
    try {
      const s = fn(v);
      return s == null ? "" : String(s);
    } catch (e) {
      return fmtNum(v);
    }
  };
}

/** 按容器宽度截断文本（SVG 没有 text-overflow，只能自己算）。 */
function clipText(s, maxChars) {
  const t = String(s == null ? "" : s);
  const n = Math.max(1, Math.floor(maxChars));
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function truncatePx(s, px, perChar) {
  const size = Math.max(1, Math.floor(px / (perChar || 6.2)));
  return clipText(s, size);
}

/** 确定性字符串哈希（FNV-1a 变体）—— 布局播种用，不用随机数。 */
function hashStr(s) {
  const str = String(s == null ? "" : s);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul ? Math.imul(h, 16777619) : (h * 16777619) | 0;
  }
  return h >>> 0;
}

/** 从色板按序号取系列色。 */
function seriesColor(i) {
  const s = palette().series;
  return s[((i % s.length) + s.length) % s.length];
}

/** 单调坐标轴上限（1/2/2.5/5/10 阶梯）。 */
function niceMax(v) {
  const n = Number(v) || 0;
  if (n <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log(n) / Math.LN10));
  const m = n / e;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return step * e;
}

/* --- 动画调度：统一 rAF 插值，尊重 prefers-reduced-motion ------------------ */

function _raf(fn) {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(fn);
  return setTimeout(fn, 16);
}
function _caf(id) {
  if (typeof cancelAnimationFrame === "function") return cancelAnimationFrame(id);
  return clearTimeout(id);
}
function nowMs() {
  try {
    if (typeof performance !== "undefined" && performance.now) return performance.now();
  } catch (e) { /* ignore */ }
  return Date.now();
}
let REDUCED = null;
function reducedMotion() {
  if (REDUCED != null) return REDUCED;
  REDUCED = false;
  try {
    if (typeof window !== "undefined" && window.matchMedia) {
      REDUCED = !!window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
  } catch (e) { /* 读不到就当没有动画偏好 */ }
  return REDUCED;
}
function easeOut(p) {
  return 1 - Math.pow(1 - p, 3);
}
/**
 * 属性插值动画。
 *   opts.el     —— 用于「节点已从 DOM 摘掉就停帧」的判断（节省无谓计算）
 *   opts.onDone —— 终帧回调
 * 返回 cancel 函数。
 */
function tween(ms, onFrame, opts) {
  const o = opts || {};
  if (!(ms > 0) || o.animate === false || reducedMotion()) {
    onFrame(1);
    if (o.onDone) o.onDone();
    return function () {};
  }
  let dead = false;
  let id = 0;
  const el = o.el;
  const t0 = nowMs();
  const step = function () {
    if (dead) return;
    if (el && typeof el.isConnected === "boolean" && !el.isConnected) {
      dead = true; // 容器被清空/卸载：停帧，别做无用功
      return;
    }
    const raw = (nowMs() - t0) / ms;
    const p = raw >= 1 ? 1 : raw;
    onFrame(easeOut(p));
    if (p < 1) id = _raf(step);
    else if (o.onDone) o.onDone();
  };
  id = _raf(step);
  return function () {
    dead = true;
    _caf(id);
  };
}
/** 分批入场：第 i 项的局部进度（用于 bars/stageBars/waterfall/timeline 的错位动画）。 */
function stagger(p, i, n) {
  if (n <= 1) return clamp01(p);
  const s = 0.55 / n;
  const seg = 1 - s * (n - 1);
  return clamp01((p - i * s) / (seg > 0 ? seg : 1));
}

/* --- 容器解析 / 挂载 / 尺寸自适配 ------------------------------------------ */

/** 解析第一个参数：元素直接用，字符串走 querySelector；拿不到返回 null。 */
function resolveHost(el) {
  try {
    if (!el) return null;
    if (typeof el === "string") {
      const d = typeof document !== "undefined" ? document : null;
      return d ? d.querySelector(el) : null;
    }
    if (el.nodeType === 1) return el;
  } catch (e) {
    return null;
  }
  return null;
}

/** 量容器宽度；测不到（隐藏 tab / 离屏 0 宽）时用 fallback。 */
function measure(host, fallback) {
  let w = 0;
  try {
    w = host.clientWidth || 0;
    if (!w && host.getBoundingClientRect) w = Math.round(host.getBoundingClientRect().width) || 0;
  } catch (e) {
    w = 0;
  }
  if (!w || !isFinite(w) || w < 40) w = fallback || 320;
  return Math.round(w);
}

/** 每个容器的挂载状态（观察器 + 待执行帧），WeakMap 保证宿主被回收时不泄漏。 */
const MOUNTS = new WeakMap();

function unmount(host) {
  const st = MOUNTS.get(host);
  if (!st) return;
  try { if (st.ro) st.ro.disconnect(); } catch (e) { /* ignore */ }
  if (st.raf) _caf(st.raf);
  if (typeof st.cancel === "function") st.cancel();
  MOUNTS.delete(host);
}

/**
 * 统一挂载流程：清空容器 → 首帧构建（带入场动画）→ ResizeObserver 监听宽度，
 * 宽度真变了才重建（重建不播动画，避免拖窗口时闪）。
 * build(width, first) 必须返回一个节点；返回 null 则容器保持清空。
 */
function mount(host, build) {
  unmount(host);
  const st = { ro: null, raf: 0, cancel: null };
  MOUNTS.set(host, st);
  let lastW = measure(host);
  const node = build(lastW, true);
  host.textContent = "";
  if (node) host.appendChild(node);
  if (typeof ResizeObserver !== "undefined") {
    try {
      st.ro = new ResizeObserver(function () {
        if (st.raf) return; // 合并同帧内的多次回调
        st.raf = _raf(function () {
          st.raf = 0;
          const w = measure(host, lastW);
          if (Math.abs(w - lastW) < 2) return;
          lastW = w;
          const next = build(w, false);
          if (!next) return;
          host.textContent = "";
          host.appendChild(next);
        });
      });
      st.ro.observe(host);
    } catch (e) {
      st.ro = null; // 观察不到就退化成「一次性渲染」，不能因此崩掉
    }
  }
  return node;
}

/** 把某次构建的动画 cancel 句柄登记进当前挂载状态，便于重复调用时打断。 */
function trackCancel(host, fn) {
  const st = MOUNTS.get(host);
  if (st) st.cancel = typeof fn === "function" ? fn : null;
}

/** SVG 空数据占位：居中 11px 灰字。 */
function emptySvg(width, height, text) {
  const w = Math.max(40, Math.round(width || 320));
  const h = Math.max(16, Math.round(height || 60));
  const svg = svgEl("svg", {
    viewBox: "0 0 " + w + " " + h, width: "100%", height: h,
    preserveAspectRatio: "xMidYMid meet", role: "img",
  });
  svg.style.cssText = "display:block;width:100%;max-width:100%";
  svg.appendChild(svgText({
    x: r2(w / 2), y: r2(h / 2), "text-anchor": "middle", "dominant-baseline": "middle",
    "font-size": 11, fill: GRAY,
  }, text || EMPTY_TEXT));
  return svg;
}

/** HTML 空数据占位（timeline / legend 这类 HTML 组件用）。 */
function emptyBox(text, minH) {
  const d = hEl("div",
    "display:flex;align-items:center;justify-content:center;" +
    "min-height:" + Math.max(24, minH || 34) + "px;font-size:11px;color:var(--tx3,#8e8e93);" +
    "border:1px dashed var(--bd,rgba(0,0,0,.09));border-radius:8px;padding:6px 8px",
    text || EMPTY_TEXT);
  return d;
}

/** 固定尺寸 SVG 的外壳样式：max-width 防溢出，height 交给宽高比。 */
function fixedSvg(svg, size) {
  svg.style.cssText = "display:block;width:100%;max-width:" + Math.round(size) +
    "px;height:auto;aspect-ratio:1/1;margin:0 auto";
  return svg;
}

/** 增量计数器：给 <defs> 里的 gradient / clipPath 生成唯一 id（同一页多处共存不串）。 */
let UID = 0;
function nextId(prefix) {
  UID += 1;
  return "hf" + (prefix || "x") + "-" + UID.toString(36);
}

/* --- 几何小工具 ------------------------------------------------------------ */

/** 极坐标 → 直角坐标（角度以 12 点方向为 0，顺时针为正）。 */
function polar(cx, cy, r, a) {
  return { x: cx + r * Math.cos(a - Math.PI / 2), y: cy + r * Math.sin(a - Math.PI / 2) };
}
/** 弧线路径（角度制，12 点起顺时针）。 */
function arcPathD(cx, cy, r, a0, a1) {
  const s = polar(cx, cy, r, a0);
  const e = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return "M" + r2(s.x) + " " + r2(s.y) + "A" + r2(r) + " " + r2(r) + " 0 " + large + " 1 " + r2(e.x) + " " + r2(e.y);
}
function hexToRgb(h) {
  const s = String(h).trim();
  const m = /^#([0-9a-f]{6})$/i.exec(s);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function lerpColor(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if (!A || !B) return b;
  const f = clamp01(t);
  const c = function (x, y) { return Math.round(x + (y - x) * f); };
  return "rgb(" + c(A.r, B.r) + "," + c(A.g, B.g) + "," + c(A.b, B.b) + ")";
}
/** 连续色阶：0 = 差（红）→ 0.5（黄）→ 1 = 好（绿）。用于色带 / 热力格。 */
const HEAT_STOPS = ["#f44336", "#ffc107", "#00c853"];
function heatColor(t) {
  const x = clamp01(t);
  const seg = Math.min(HEAT_STOPS.length - 2, Math.floor(x * (HEAT_STOPS.length - 1)));
  const local = x * (HEAT_STOPS.length - 1) - seg;
  return lerpColor(HEAT_STOPS[seg], HEAT_STOPS[seg + 1], local);
}

/* ==================================================================== *
 * 1. sparkline —— 折线 + 渐变面积
 * ==================================================================== */
/**
 * 迷你趋势线。points 少于 2 个视为空数据。
 * 描线动画用 pathLength=1 归一化（不依赖 getTotalLength，隐藏容器里也算得对）。
 */
export function sparkline(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const H = clampNum(o.height, 36, 12, 240);
  const src = Array.isArray(o.points) ? o.points : [];
  const pts = [];
  for (let i = 0; i < src.length; i++) {
    const v = Number(src[i]);
    if (isFinite(v)) pts.push(v);
  }
  if (pts.length < 2) return mount(host, function (w) { return emptySvg(w, H); });

  const stroke = o.stroke || "var(--primary,#3c96ca)";
  const fill = o.fill || stroke;
  const anim = o.animate !== false;

  return mount(host, function (W, first) {
    const pad = 3;
    const min = Math.min.apply(null, pts);
    const max = Math.max.apply(null, pts);
    const span = max - min || 1;
    const n = pts.length;
    const xAt = function (i) { return n > 1 ? (i / (n - 1)) * (W - pad * 2) + pad : W / 2; };
    const yAt = function (v) { return H - pad - ((v - min) / span) * (H - pad * 2); };

    let d = "";
    for (let i = 0; i < n; i++) d += (i ? "L" : "M") + r2(xAt(i)) + " " + r2(yAt(i));
    const areaD = d + "L" + r2(xAt(n - 1)) + " " + H + "L" + r2(xAt(0)) + " " + H + "Z";

    const svg = svgEl("svg", {
      viewBox: "0 0 " + W + " " + H, width: "100%", height: H,
      preserveAspectRatio: "xMidYMid meet", role: "img",
    });
    svg.style.cssText = "display:block;width:100%;max-width:100%";

    const gid = nextId("spark");
    const defs = svgEl("defs");
    const grad = svgEl("linearGradient", { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(svgEl("stop", { offset: "0%", "stop-color": fill, "stop-opacity": 0.34 }));
    grad.appendChild(svgEl("stop", { offset: "100%", "stop-color": fill, "stop-opacity": 0 }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    const areaG = svgEl("g", { opacity: anim ? 0 : 1 });
    areaG.appendChild(svgEl("path", { d: areaD, fill: "url(#" + gid + ")", stroke: "none" }));
    svg.appendChild(areaG);

    const line = svgEl("path", {
      d: d, fill: "none", stroke: stroke, "stroke-width": 1.8,
      "stroke-linecap": "round", "stroke-linejoin": "round",
      pathLength: 1, "stroke-dasharray": "1", "stroke-dashoffset": anim ? 1 : 0,
    });
    svg.appendChild(line);

    const dot = svgEl("circle", {
      cx: r2(xAt(n - 1)), cy: r2(yAt(pts[n - 1])), r: 2.6, fill: stroke, opacity: anim ? 0 : 1,
    });
    svg.appendChild(dot);
    tip(svg, "趋势 · 末值 " + fmtNum(pts[n - 1]));

    // 描线 + 面积淡入 + 末点出现，三段共用一条时间线（错位感更强）
    const cancel = tween(620, function (p) {
      line.setAttribute("stroke-dashoffset", String(1 - p));
      areaG.setAttribute("opacity", String(clamp01((p - 0.25) / 0.75)));
      dot.setAttribute("opacity", String(clamp01((p - 0.8) / 0.2)));
    }, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);
    return svg;
  });
}

/* ==================================================================== *
 * 2. donut —— 环形占比图
 * ==================================================================== */
/**
 * 环形图。用「描边圆弧 + linecap=round」实现圆角端头，扇区间按 2px 弧长留缝。
 * 首帧按角度扫入（每帧重算各扇区 path，切片少、开销可忽略）。
 */
export function donut(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const size = clampNum(o.size, 160, 80, 640);
  const thickness = clampNum(o.thickness, 18, 4, size / 3);
  const anim = o.animate !== false;

  const raw = Array.isArray(o.items) ? o.items : [];
  const items = [];
  let total = 0;
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i];
    if (!it) continue;
    const v = Number(it.value);
    if (!isFinite(v) || v <= 0) continue;
    items.push({ label: it.label == null ? "" : String(it.label), value: v, color: it.color || seriesColor(items.length) });
    total += v;
  }
  if (!items.length || total <= 0) return mount(host, function (w) { return emptySvg(w, size); });

  const legendOn = !!o.legend;
  const centerText = o.centerText == null ? null : String(o.centerText);

  return mount(host, function (W, first) {
    const svg = svgEl("svg", {
      viewBox: "0 0 " + size + " " + size, width: "100%", height: size,
      preserveAspectRatio: "xMidYMid meet", role: "img",
    });
    fixedSvg(svg, size);

    const cx = size / 2;
    const cy = size / 2;
    const r = (size - thickness) / 2;
    // 2px 间隙换算成角度：弧长 / 半径
    const gapDeg = (1 / r) * (180 / Math.PI); // 只留 1px 发丝缝：2px 缝会把薄段推成孤立色斑

    /* 占比极小的段不能被画成「一粒圆点」：
       圆头线帽（round）的直径等于环宽，若某段的弧长比环宽还短，它渲染出来就是一个
       直径 = thickness 的圆点，而且两侧还留着 gap —— 看起来就是一颗和环脱离的色斑
       （真机上是「记忆构成」左下角那个孤立橙点）。
       处理：① 给非零小段补到「至少能看出一段弧」的角度，缺口从最大段里扣，总和仍是 360°；
             ② 弧长不足 1.4 倍环宽的段用 butt 线帽、且不留缝，让它老老实实贴在环上。 */
    const minDeg = Math.max(1.6, ((thickness * 1.4) / r) * (180 / Math.PI));
    const sweeps = items.map(function (it) { return (it.value / total) * 360; });
    let bigIdx = 0;
    for (let i = 1; i < sweeps.length; i++) if (sweeps[i] > sweeps[bigIdx]) bigIdx = i;
    let deficit = 0;
    for (let i = 0; i < sweeps.length; i++) {
      if (i === bigIdx || sweeps[i] <= 0 || sweeps[i] >= minDeg) continue;
      deficit += minDeg - sweeps[i];
      sweeps[i] = minDeg;
    }
    if (deficit > 0) sweeps[bigIdx] = Math.max(minDeg, sweeps[bigIdx] - deficit);

    /* 逐条判断「薄段」，并按边界决定留缝：
       缝是画在段与段之间的；只要某一侧是薄段，那一侧就不留缝 ——
       否则薄段会被左右两条缝各推一下，看起来就是一颗脱离圆环的孤立色点
       （真机「记忆构成」右侧那个灰点就是这么来的）。 */
    const arcOf = function (sw) { return (sw / 360) * 2 * Math.PI * r; };
    // 弧长不足 2.6×环宽：视觉上就是「一小块」，两侧都不留缝，避免被推离圆环
    const thinFlags = sweeps.map(function (sw) { return arcOf(sw) < thickness * 2.6; });
    const capFlags = sweeps.map(function (sw) { return arcOf(sw) < thickness * 1.35; }); // 只给极短段换平头
    const gapAtBoundary = function (i) {
      const n = sweeps.length;
      return thinFlags[(i - 1 + n) % n] || thinFlags[i % n] ? 0 : gapDeg;
    };

    const slices = [];
    let cursor = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const sweep = sweeps[i];
      const gapIn = gapAtBoundary(i) / 2;
      const gapOut = gapAtBoundary(i + 1) / 2;
      const a0 = cursor + gapIn;
      const a1 = cursor + sweep - gapOut;
      slices.push({ a0: a0, a1: Math.max(a0, a1), item: it, pct: it.value / total, thin: capFlags[i] });
      cursor += sweep;
    }

    const paths = [];
    for (let i = 0; i < slices.length; i++) {
      const s = slices[i];
      const p = svgEl("path", {
        fill: "none", stroke: s.item.color, "stroke-width": thickness,
        "stroke-linecap": s.thin ? "butt" : "round", opacity: 0,
      });
      tip(p, s.item.label + " · " + fmtNum(s.item.value) + "（" + fmtPct(s.pct, 1) + "）");
      svg.appendChild(p);
      paths.push(p);
    }

    // 中心：给了 centerText 用它，否则自动显示总值 + 小字说明
    const mainTxt = centerText != null ? centerText : fmtNum(total);
    const centerG = svgEl("g", { opacity: 1 });
    centerG.appendChild(svgText({
      x: cx, y: centerText != null ? cy : cy - size * 0.045,
      "text-anchor": "middle", "dominant-baseline": "middle",
      "font-size": r2(size * 0.19), "font-weight": 700, fill: "var(--tx1,#1b1c1d)",
    }, mainTxt));
    if (centerText == null) {
      centerG.appendChild(svgText({
        x: cx, y: cy + size * 0.115, "text-anchor": "middle", "dominant-baseline": "middle",
        "font-size": r2(size * 0.085), fill: "var(--tx3,#8e8e93)",
      }, "总计"));
    }
    svg.appendChild(centerG);

    const render = function (p) {
      const drawn = 360 * p;
      for (let i = 0; i < slices.length; i++) {
        const s = slices[i];
        const a0 = s.a0;
        const a1 = Math.min(s.a1, drawn);
        if (a1 <= a0 + 0.6) {
          paths[i].setAttribute("opacity", "0");
          continue;
        }
        paths[i].setAttribute("opacity", "1");
        paths[i].setAttribute("d", arcPathD(cx, cy, r, a0, a1));
      }
    };
    const cancel = tween(720, render, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);

    if (!legendOn) return svg;

    // 图例在右侧，窄容器里自动换行到图下方（flex-wrap）
    const wrap = hEl("div", "display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:center");
    wrap.appendChild(svg);
    const lgHost = hEl("div", "flex:1 1 130px;min-width:120px");
    wrap.appendChild(lgHost);
    legend(lgHost, {
      items: items.map(function (it) {
        return { label: it.label + " " + fmtPct(it.value / total, 0), color: it.color };
      }),
      shape: "dot",
    });
    return wrap;
  });
}

/* ==================================================================== *
 * 3. ring —— 单值圆环进度
 * ==================================================================== */
/**
 * 单值进度环。用 pathLength=1 的 dasharray/dashoffset 表达进度：
 * 从 12 点方向顺时针，用 transform rotate(-90) 把 3 点起点掰回 12 点。
 * value==null 才当空数据（0 是合法值，要有 0% 的环）。
 */
export function ring(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const size = clampNum(o.size, 84, 32, 480);
  const thickness = clampNum(o.thickness, 9, 2, size / 4);
  const anim = o.animate !== false;
  const rawV = o.value == null ? NaN : Number(o.value);
  if (!isFinite(rawV)) return mount(host, function (w) { return emptySvg(w, size + 16); });
  const v = clamp01(rawV);
  const color = o.color || "var(--primary,#3c96ca)";
  const label = o.label == null ? "" : String(o.label);
  const sub = o.sub == null ? "" : String(o.sub);

  return mount(host, function (W, first) {
    const cx = size / 2;
    const cy = size / 2;
    const r = (size - thickness) / 2;
    const svg = svgEl("svg", {
      viewBox: "0 0 " + size + " " + size, width: "100%", height: size,
      preserveAspectRatio: "xMidYMid meet", role: "img",
    });
    fixedSvg(svg, size);

    svg.appendChild(svgEl("circle", {
      cx: cx, cy: cy, r: r, fill: "none", stroke: "var(--bd,rgba(0,0,0,.09))", "stroke-width": thickness,
    }));
    const arc = svgEl("circle", {
      cx: cx, cy: cy, r: r, fill: "none", stroke: color, "stroke-width": thickness,
      "stroke-linecap": "round", pathLength: 1, "stroke-dasharray": "1 1",
      "stroke-dashoffset": anim ? 1 : 1 - v,
      transform: "rotate(-90 " + cx + " " + cy + ")",
    });
    svg.appendChild(arc);

    const txtG = svgEl("g", { opacity: anim ? 0 : 1 });
    txtG.appendChild(svgText({
      x: cx, y: label ? cy - size * 0.05 : cy, "text-anchor": "middle", "dominant-baseline": "middle",
      "font-size": r2(size * 0.23), "font-weight": 700, fill: "var(--tx1,#1b1c1d)",
    }, anim ? "0%" : fmtPct(v)));
    if (label) {
      txtG.appendChild(svgText({
        x: cx, y: cy + size * 0.17, "text-anchor": "middle", "dominant-baseline": "middle",
        "font-size": r2(Math.max(9, size * 0.105)), fill: "var(--tx3,#8e8e93)",
      }, label));
    }
    svg.appendChild(txtG);
    const numNode = txtG.firstChild;
    tip(svg, label ? label + " · " + fmtPct(v, 1) : fmtPct(v, 1));

    const cancel = tween(700, function (p) {
      arc.setAttribute("stroke-dashoffset", String(1 - v * p));
      txtG.setAttribute("opacity", String(clamp01(p / 0.4)));       // 文本淡入
      numNode.textContent = fmtPct(v * p);                            // 数字跟着涨
    }, { el: svg, animate: first ? anim : false, onDone: function () { numNode.textContent = fmtPct(v); } });
    trackCancel(host, cancel);

    if (!sub) return svg;
    const wrap = hEl("div", "display:flex;flex-direction:column;align-items:center;gap:2px");
    wrap.appendChild(svg);
    wrap.appendChild(hEl("div", "font-size:11px;color:var(--tx3,#8e8e93);text-align:center", sub));
    return wrap;
  });
}

/* ==================================================================== *
 * 4. radar —— 多边形雷达图
 * ==================================================================== */
/**
 * 雷达图。网格 4 圈（正多边形），轴标签按 cos/sin 做 8 向对齐，并夹在 viewBox 内不溢出。
 * 首帧只对「网格 + 系列」这个 g 做从中心缩放展开，标签保持静止（缩放文字很难看）。
 */
export function radar(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const size = clampNum(o.size, 230, 120, 640);
  const axes = (Array.isArray(o.axes) ? o.axes : []).filter(function (a) { return a; });
  const series = (Array.isArray(o.series) ? o.series : []).filter(function (s) { return s && Array.isArray(s.values); });
  if (axes.length < 3 || !series.length) return mount(host, function (w) { return emptySvg(w, size); });

  // 全 0 视为空数据（退化成一个点，画出来只会让人以为坏图）
  let anyValue = false;
  for (let i = 0; i < series.length; i++) {
    for (let j = 0; j < series[i].values.length; j++) {
      if (Number(series[i].values[j]) > 0) { anyValue = true; break; }
    }
    if (anyValue) break;
  }
  if (!anyValue) return mount(host, function (w) { return emptySvg(w, size); });

  const anim = o.animate !== false;

  return mount(host, function (W, first) {
    const n = axes.length;
    const pad = Math.max(26, Math.round(size * 0.15)); // 轴标签留白
    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - pad;
    const angleOf = function (i) { return (i * 360) / n; };
    const svg = svgEl("svg", {
      viewBox: "0 0 " + size + " " + size, width: "100%", height: size,
      preserveAspectRatio: "xMidYMid meet", role: "img",
    });
    fixedSvg(svg, size);

    const inner = svgEl("g"); // 参与缩放展开的部分
    // 网格：4 圈多边形 + 轴辐条
    for (let ring = 1; ring <= 4; ring++) {
      const rr = (R * ring) / 4;
      let pts = "";
      for (let i = 0; i < n; i++) {
        const p = polar(cx, cy, rr, angleOf(i));
        pts += r2(p.x) + "," + r2(p.y) + " ";
      }
      inner.appendChild(svgEl("polygon", {
        points: pts.trim(), fill: ring === 4 ? "var(--primary-soft,rgba(60,150,202,.06))" : "none",
        stroke: "var(--bd,rgba(0,0,0,.09))", "stroke-width": 1,
      }));
    }
    for (let i = 0; i < n; i++) {
      const p = polar(cx, cy, R, angleOf(i));
      inner.appendChild(svgEl("line", {
        x1: cx, y1: cy, x2: r2(p.x), y2: r2(p.y),
        stroke: "var(--bd,rgba(0,0,0,.09))", "stroke-width": 1,
      }));
    }

    // 系列多边形
    for (let s = 0; s < series.length; s++) {
      const se = series[s];
      const color = se.color || seriesColor(s);
      let pts = "";
      for (let i = 0; i < n; i++) {
        const ax = axes[i] || {};
        const mx = num(ax.max, 1) || 1;
        const val = clamp(num(se.values[i], 0) / mx, 0, 1);
        const p = polar(cx, cy, R * val, angleOf(i));
        pts += r2(p.x) + "," + r2(p.y) + " ";
      }
      inner.appendChild(svgEl("polygon", {
        points: pts.trim(), fill: color, "fill-opacity": series.length > 1 ? 0.16 : 0.22,
        stroke: color, "stroke-width": 2, "stroke-linejoin": "round",
      }));
      // 顶点小圆点：多系列交叠时更容易看出各自形状
      for (let i = 0; i < n; i++) {
        const ax = axes[i] || {};
        const mx = num(ax.max, 1) || 1;
        const val = clamp(num(se.values[i], 0) / mx, 0, 1);
        const p = polar(cx, cy, R * val, angleOf(i));
        inner.appendChild(svgEl("circle", { cx: r2(p.x), cy: r2(p.y), r: 2.2, fill: color }));
      }
    }
    svg.appendChild(inner);

    // 轴标签：8 向对齐 + 夹进画布
    for (let i = 0; i < n; i++) {
      const a = angleOf(i);
      const rad = (a * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const p = polar(cx, cy, R + 9, a);
      const anchor = cos > 0.25 ? "start" : cos < -0.25 ? "end" : "middle";
      const baseline = sin > 0.25 ? "hanging" : sin < -0.25 ? "auto" : "middle";
      const ax = axes[i] || {};
      const maxTxt = num(ax.max, 1) === 1 ? "" : " /" + fmtNum(num(ax.max, 1));
      const node = svgText({
        x: r2(clamp(p.x, 3, size - 3)), y: r2(clamp(p.y, 10, size - 3)),
        "text-anchor": anchor, "dominant-baseline": baseline,
        "font-size": 10, fill: "var(--tx2,rgba(0,0,0,.66))",
      }, clipText(ax.label, 8) + maxTxt);
      tip(node, String(ax.label == null ? "" : ax.label) + maxTxt);
      svg.appendChild(node);
    }

    const cancel = tween(560, function (p) {
      const k = 0.05 + 0.95 * p;
      inner.setAttribute("transform",
        "translate(" + cx + " " + cy + ") scale(" + r2(k) + ") translate(" + -cx + " " + -cy + ")");
    }, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);
    return svg;
  });
}

/* ==================================================================== *
 * 5. bars —— 横向 / 纵向条形图
 * ==================================================================== */
/**
 * 条形图。条长按 max（默认取数据最大值）归一；横向更适合「标签是中文长词」的场景，
 * 所以默认 horizontal=true。每条都带 <title> 原生 tooltip。
 */
export function bars(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const horizontal = o.horizontal !== false;
  const anim = o.animate !== false;
  const fmt = useFmt(o.valueFmt);
  const src = Array.isArray(o.items) ? o.items : [];
  const items = [];
  for (let i = 0; i < src.length; i++) {
    const it = src[i];
    if (!it) continue;
    items.push({
      label: it.label == null ? "" : String(it.label),
      value: num(it.value, 0),
      color: it.color || seriesColor(i),
      sub: it.sub == null ? "" : String(it.sub),
    });
  }
  const maxVal = Math.max.apply(null, [num(o.max, 0)].concat(items.map(function (x) { return x.value; })));
  const vmax = maxVal > 0 ? maxVal : 0;
  if (!items.length || vmax <= 0) return mount(host, function (w) { return emptySvg(w, o.height || 70); });

  return mount(host, function (W, first) {
    const svg = svgEl("svg", { width: "100%", preserveAspectRatio: "xMidYMid meet", role: "img" });
    svg.style.cssText = "display:block;width:100%;max-width:100%";
    const rects = [];
    const labels = [];

    if (horizontal) {
      /* 显式给了 height 就按它排版：把行高/条高按可用高度等比缩放（下限保证还能点得中）。
         旧实现直接忽略 height —— KPI 迷你槽里要 34px 的图会被撑成 items.length*22+2
         （4 条 = 90px），于是小卡片里冒出一大块色条，既不精致也把卡片顶高。 */
      const wantH = num(o.height, 0);
      let rowH = 22;
      let gap = 6;
      let barH = 12;
      let H = items.length * rowH + 2;
      if (wantH > 0 && wantH < H) {
        const k = Math.max(0.34, wantH / H);
        rowH = Math.max(9, Math.round(rowH * k));
        gap = Math.max(2, Math.round(gap * k));
        barH = Math.max(5, Math.min(12, Math.round(barH * k)));
        H = wantH;
      }
      const labelW = Math.min(140, Math.max(48, Math.round(W * 0.3)));
      const padR = 56; // 右侧给数值留固定位置，数值列才对齐
      const trackW = Math.max(20, W - labelW - padR);
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.setAttribute("height", H);

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const y = i * rowH + gap / 2;
        const ratio = clamp01(it.value / vmax);
        const full = trackW * ratio;
        svg.appendChild(svgEl("rect", {
          x: labelW, y: y, width: trackW, height: barH, rx: barH / 2,
          fill: "var(--primary-soft,rgba(60,150,202,.10))",
        }));
        const bar = svgEl("rect", {
          x: labelW, y: y, width: first && anim ? 0 : full, height: barH, rx: barH / 2, fill: it.color,
        });
        const tnode = svgText({
          x: labelW - 8, y: y + barH / 2 + 0.5, "text-anchor": "end", "dominant-baseline": "middle",
          "font-size": 11, fill: "var(--tx2,rgba(0,0,0,.66))",
        }, truncatePx(it.label, labelW - 10, 6.4));
        tip(bar, it.label + (it.sub ? " · " + it.sub : "") + "：" + fmt(it.value));
        tip(tnode, it.label);
        svg.appendChild(bar);
        svg.appendChild(tnode);
        const val = svgText({
          x: W - 4, y: y + barH / 2 + 0.5, "text-anchor": "end", "dominant-baseline": "middle",
          "font-size": 11.5, "font-weight": 600, fill: "var(--tx1,#1b1c1d)", opacity: first && anim ? 0 : 1,
        }, fmt(it.value));
        svg.appendChild(val);
        rects.push({ node: bar, full: full });
        labels.push(val);
      }
    } else {
      const H = clampNum(o.height, 140, 60, 520);
      const padT = 18;
      const padB = 20;
      const plotH = Math.max(20, H - padT - padB);
      const slot = W / items.length;
      const barW = Math.max(4, Math.min(46, slot * 0.62));
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.setAttribute("height", H);
      // 基线
      svg.appendChild(svgEl("line", {
        x1: 0, y1: H - padB + 0.5, x2: W, y2: H - padB + 0.5,
        stroke: "var(--bd,rgba(0,0,0,.09))", "stroke-width": 1,
      }));
      const labelStep = Math.max(1, Math.ceil(30 / slot)); // 太窄就抽稀，避免标签互相压
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const ratio = clamp01(it.value / vmax);
        const h = first && anim ? 0 : plotH * ratio;
        const x = i * slot + (slot - barW) / 2;
        const bar = svgEl("rect", {
          x: r2(x), y: r2(H - padB - h), width: r2(barW), height: r2(h),
          rx: Math.min(5, barW / 3), fill: it.color,
        });
        tip(bar, it.label + (it.sub ? " · " + it.sub : "") + "：" + fmt(it.value));
        svg.appendChild(bar);
        rects.push({ node: bar, full: plotH * ratio });
        if (i % labelStep === 0) {
          svg.appendChild(svgText({
            x: r2(i * slot + slot / 2), y: H - 6, "text-anchor": "middle", "dominant-baseline": "middle",
            "font-size": 10, fill: "var(--tx3,#8e8e93)",
          }, truncatePx(it.label, slot * labelStep, 6)));
        }
        if (slot >= 26) {
          const val = svgText({
            x: r2(i * slot + slot / 2), y: r2(H - padB - h - 5), "text-anchor": "middle",
            "dominant-baseline": "auto", "font-size": 10.5, fill: "var(--tx1,#1b1c1d)",
            opacity: first && anim ? 0 : 1,
          }, fmt(it.value));
          svg.appendChild(val);
          labels.push(val);
        }
      }
    }

    // 宽度/高度从 0 增长 + 数值淡入，按行错位
    const n = rects.length;
    const cancel = tween(520, function (p) {
      for (let i = 0; i < n; i++) {
        const local = stagger(p, i, n);
        const full = rects[i].full;
        if (horizontal) {
          rects[i].node.setAttribute("width", String(r2(full * local)));
        } else {
          const h = full * local;
          const y = Number(rects[i].node.getAttribute("y")) || 0;
          const baseY = y + (Number(rects[i].node.getAttribute("height")) || 0);
          rects[i].node.setAttribute("height", String(r2(h)));
          rects[i].node.setAttribute("y", String(r2(baseY - h)));
        }
        if (labels[i]) labels[i].setAttribute("opacity", String(clamp01((local - 0.5) * 2)));
      }
    }, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);
    return svg;
  });
}

/* ==================================================================== *
 * 6. waterfall —— 因子分解瀑布图
 * ==================================================================== */
/**
 * 瀑布图：从 base 起逐项加/减，末尾一根「总计」。
 * 正项绿/蓝、负项红/橙；段与段之间用细虚线连出「接力」关系，阈值画水平虚线 + 标注。
 * 动画按段错位：每段从自己的起点值长到终点值（不是从 0，读起来才是「累加」）。
 */
export function scatter(el, opts) {
  // 交互式散点/气泡：把「一张流水表」压成一张可点的图。
  // points: [{ x, y, r, color, label, sub, extra }]；hover 出提示，点击回调 onPick(point)。
  // 关键：**按容器实测像素 1:1 绘制**（不靠 viewBox 缩放）——文字与线宽才不会被拉变形，
  // 并由基座 mount() 的 ResizeObserver 在容器宽度变化时自动重画，所以「能自适配」。
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const H = clampNum(o.height, 250, 130, 660);
  const src = (Array.isArray(o.points) ? o.points : []).filter(
    (q) => q && isFinite(Number(q.x)) && isFinite(Number(q.y))
  );
  const P = palette();
  if (!src.length) {
    return mount(host, function (W) {
      return emptySvg(W, H, o.emptyText);
    });
  }
  const xFmt = typeof o.xFmt === "function" ? o.xFmt : (v) => fmtNum(v);
  const yFmt = typeof o.yFmt === "function" ? o.yFmt : (v) => fmtNum(v);
  const xs = src.map((q) => Number(q.x));
  const ys = src.map((q) => Number(q.y));
  const x0 = Math.min.apply(null, xs);
  const x1 = Math.max.apply(null, xs);
  let y0 = o.yMin != null ? Number(o.yMin) : Math.min.apply(null, ys);
  let y1 = o.yMax != null ? Number(o.yMax) : Math.max.apply(null, ys);
  if (!(y1 > y0)) {
    y0 -= 1;
    y1 += 1;
  }
  return mount(host, function (W, first) {
    const pad = { l: 42, r: 14, t: 12, b: 22 };
    const px = (v) => pad.l + ((v - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
    const py = (v) => H - pad.b - ((v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;width:100%";
    const svg = svgEl("svg", { width: Math.round(W), height: H, role: "img" });
    svg.style.cssText = "display:block;width:100%;height:" + H + "px;overflow:visible";
    const tip = document.createElement("div");
    tip.style.cssText =
      "position:absolute;z-index:6;pointer-events:none;display:none;background:" + P.surface +
      ";border:1px solid " + P.line + ";border-radius:9px;padding:6px 9px;font-size:11.5px;line-height:1.5;max-width:260px;color:" + P.text +
      ";box-shadow:0 8px 24px rgba(0,0,0,.28)";
    // 网格：刻意压弱，不与数据抢注意力（深色面板尤其重要）
    for (let i = 0; i <= 4; i++) {
      const v = y0 + ((y1 - y0) * i) / 4;
      const y = py(v);
      svg.appendChild(svgEl("line", { x1: pad.l, y1: y, x2: W - pad.r, y2: y, stroke: P.line, "stroke-width": 1 }));
      const t = svgText({ x: pad.l - 6, y: y + 3.5, "text-anchor": "end", "font-size": 11, fill: P.text3 }, yFmt(v));
      svg.appendChild(t);
    }
    for (let i = 0; i <= 3; i++) {
      const v = x0 + ((x1 - x0) * i) / 3;
      const t = svgText({ x: px(v), y: H - 6, "text-anchor": i === 0 ? "start" : i === 3 ? "end" : "middle", "font-size": 11, fill: P.text3 }, xFmt(v));
      svg.appendChild(t);
    }
    if (o.threshold != null && isFinite(Number(o.threshold))) {
      const ty = py(Number(o.threshold));
      svg.appendChild(svgEl("line", { x1: pad.l, y1: ty, x2: W - pad.r, y2: ty, stroke: P.warning, "stroke-width": 1.2, "stroke-dasharray": "6 4", "stroke-opacity": 0.75 }));
      svg.appendChild(svgText({ x: W - pad.r, y: ty - 5, "text-anchor": "end", "font-size": 10.5, fill: P.warning }, (o.thresholdLabel || "阈值") + " " + yFmt(Number(o.threshold))));
    }
    const show = (q, ev) => {
      tip.innerHTML = "<b>" + esc(String(q.label == null ? "" : q.label)) + "</b>" + (q.sub ? '<div style="opacity:.72;margin-top:2px">' + esc(String(q.sub)) + "</div>" : "");
      const r = wrap.getBoundingClientRect();
      tip.style.display = "block";
      tip.style.left = Math.max(0, Math.min(W - 150, ev.clientX - r.left + 12)) + "px";
      tip.style.top = Math.max(0, ev.clientY - r.top - 10) + "px";
    };
    src.forEach((q) => {
      const cx = px(Number(q.x));
      const cy = py(Number(q.y));
      const r = clampNum(q.r, 4, 2.5, 18);
      const hit = svgEl("circle", { cx: cx, cy: cy, r: Math.max(10, r + 5), fill: "transparent" });
      hit.style.cursor = typeof o.onPick === "function" ? "pointer" : "default";
      const dot = svgEl("circle", { cx: cx, cy: cy, r: r, fill: q.color || seriesColor(0), "fill-opacity": 0.82, stroke: "rgba(0,0,0,.25)", "stroke-width": 0.6 });
      hit.addEventListener("mouseenter", (ev) => show(q, ev));
      hit.addEventListener("mousemove", (ev) => show(q, ev));
      hit.addEventListener("mouseleave", () => {
        tip.style.display = "none";
      });
      if (typeof o.onPick === "function")
        hit.addEventListener("click", () => {
          tip.style.display = "none";
          o.onPick(q);
        });
      svg.appendChild(dot);
      svg.appendChild(hit);
    });
    wrap.appendChild(svg);
    wrap.appendChild(tip);
    return wrap;
  });
}

export function waterfall(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const H = clampNum(o.height, 180, 100, 560);
  const anim = o.animate !== false;
  const fmt = useFmt(o.valueFmt);
  const raw = Array.isArray(o.items) ? o.items : [];
  const base = num(o.base, 0);
  const threshold = o.threshold == null ? null : Number(o.threshold);
  const hasThreshold = threshold != null && isFinite(threshold);
  if (!raw.length) return mount(host, function (w) { return emptySvg(w, H); });

  const segs = [];
  let cur = base;
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i];
    if (!it) continue;
    const v = num(it.value, 0);
    const positive = it.positive == null ? v >= 0 : !!it.positive;
    const mag = Math.abs(v);
    const from = cur;
    const to = positive ? cur + mag : cur - mag;
    cur = to;
    segs.push({
      label: it.label == null ? "" : String(it.label),
      delta: positive ? mag : -mag,
      from: from, to: to, positive: positive, color: it.color || null,
    });
  }
  if (!segs.length) return mount(host, function (w) { return emptySvg(w, H); });
  const total = cur;

  return mount(host, function (W, first) {
    const padL = 8;
    const padR = 8;
    const padT = 22;
    const padB = 26;
    const all = [base, total];
    for (let i = 0; i < segs.length; i++) { all.push(segs[i].from, segs[i].to); }
    if (hasThreshold) all.push(threshold);
    let lo = Math.min.apply(null, all);
    let hi = Math.max.apply(null, all);
    if (hi - lo < 1e-6) { hi = lo + 1; }
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
    const plotH = Math.max(30, H - padT - padB);
    const yOf = function (v) { return padT + ((hi - v) / (hi - lo)) * plotH; };

    const svg = svgEl("svg", {
      viewBox: "0 0 " + W + " " + H, width: "100%", height: H,
      preserveAspectRatio: "xMidYMid meet", role: "img",
    });
    svg.style.cssText = "display:block;width:100%;max-width:100%";

    const n = segs.length + 1; // 末尾总计占一列
    const colW = (W - padL - padR) / n;
    const barW = Math.max(6, Math.min(40, colW * 0.62));
    const xOf = function (i) { return padL + colW * (i + 0.5); };

    // base 基线（base=0 就是零轴，不必额外画）
    if (Math.abs(base) > 1e-9) {
      svg.appendChild(svgEl("line", {
        x1: padL, y1: r2(yOf(base)), x2: W - padR, y2: r2(yOf(base)),
        stroke: "var(--bd,rgba(0,0,0,.09))", "stroke-width": 1, "stroke-dasharray": "3 3",
      }));
    }
    // 阈值线 + 标注
    if (hasThreshold) {
      const ty = yOf(threshold);
      svg.appendChild(svgEl("line", {
        x1: padL, y1: r2(ty), x2: W - padR, y2: r2(ty),
        stroke: "var(--warning,#ffc107)", "stroke-width": 1.6, "stroke-dasharray": "5 4",
      }));
      svg.appendChild(svgText({
        x: padL + 2, y: r2(clamp(ty - 4, 9, H - 2)), "font-size": 9.5,
        fill: "var(--warning,#ffc107)", "dominant-baseline": "auto",
      }, "阈值"));
    }

    const bars = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const y0 = yOf(s.from);
      const y1 = yOf(s.to);
      const top = Math.min(y0, y1);
      const full = Math.max(1.5, Math.abs(y1 - y0));
      const color = s.color || (s.positive ? "var(--success,#00c853)" : "var(--error,#f44336)");
      const rect = svgEl("rect", {
        x: r2(xOf(i) - barW / 2), y: r2(first && anim ? y0 : top),
        width: r2(barW), height: first && anim ? 1.5 : r2(full), rx: 3, fill: color,
      });
      tip(rect, s.label + "：" + (s.delta >= 0 ? "+" : "") + fmt(s.delta));
      svg.appendChild(rect);
      bars.push({ node: rect, from: y0, dir: y1 >= y0 ? 1 : -1, full: full, idx: i });

      // 接力虚线：上一段终点 → 这一段起点
      if (i > 0) {
        svg.appendChild(svgEl("line", {
          x1: r2(xOf(i - 1) + barW / 2), y1: r2(yOf(segs[i - 1].to)),
          x2: r2(xOf(i) - barW / 2), y2: r2(y0),
          stroke: "var(--tx2,rgba(0,0,0,.66))", "stroke-width": 1.4, "stroke-dasharray": "3 3", opacity: 0.85,
        }));
      }

      const dv = svgText({
        x: r2(xOf(i)), y: r2(clamp(top - 4, 10, H)), "text-anchor": "middle",
        "font-size": 10, "font-weight": 600,
        fill: s.positive ? "var(--success,#00c853)" : "var(--error,#f44336)",
        opacity: first && anim ? 0 : 1,
      }, (s.delta >= 0 ? "+" : "") + fmt(s.delta));
      svg.appendChild(dv);
      bars[bars.length - 1].valNode = dv;

      const lb = svgText({
        x: r2(xOf(i)), y: H - 8, "text-anchor": "middle", "dominant-baseline": "middle",
        "font-size": 10, fill: "var(--tx3,#8e8e93)",
      }, truncatePx(s.label, colW - 2, 5.6));
      tip(lb, s.label);
      svg.appendChild(lb);
    }

    // 总计柱
    const yb = yOf(base);
    const yt = yOf(total);
    // 最后一根到总计柱之间也要有接力线，否则图像上「合计」是悬空的
    if (segs.length) {
      svg.appendChild(svgEl("line", {
        x1: r2(xOf(segs.length - 1) + barW / 2), y1: r2(yOf(segs[segs.length - 1].to)),
        x2: r2(xOf(segs.length) - barW / 2), y2: r2(yOf(total)),
        stroke: "var(--tx2,rgba(0,0,0,.66))", "stroke-width": 1.4, "stroke-dasharray": "3 3", opacity: 0.85,
      }));
    }
    const tTop = Math.min(yb, yt);
    const tFull = Math.max(1.5, Math.abs(yt - yb));
    const tRect = svgEl("rect", {
      x: r2(xOf(n - 1) - barW / 2), y: r2(first && anim ? yb : tTop),
      width: r2(barW), height: first && anim ? 1.5 : r2(tFull), rx: 3,
      fill: "var(--primary,#3c96ca)",
    });
    tip(tRect, "总计：" + fmt(total));
    svg.appendChild(tRect);
    const tVal = svgText({
      x: r2(xOf(n - 1)), y: r2(clamp(tTop - 4, 10, H)), "text-anchor": "middle",
      "font-size": 10.5, "font-weight": 700, fill: "var(--tx1,#1b1c1d)", opacity: first && anim ? 0 : 1,
    }, fmt(total));
    svg.appendChild(tVal);
    svg.appendChild(svgText({
      x: r2(xOf(n - 1)), y: H - 8, "text-anchor": "middle", "dominant-baseline": "middle",
      "font-size": 10, fill: "var(--tx3,#8e8e93)",
    }, "总计"));

    const cancel = tween(680, function (p) {
      const nn = segs.length;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const local = stagger(p, i, nn);
        const h = Math.max(0.6, b.full * local);
        b.node.setAttribute("height", String(r2(h)));
        b.node.setAttribute("y", String(r2(b.dir > 0 ? b.from - h : b.from)));
        if (b.valNode) b.valNode.setAttribute("opacity", String(clamp01((local - 0.5) * 2)));
      }
      const localT = clamp01((p - 0.85) / 0.15);
      const hT = Math.max(0.6, tFull * localT);
      tRect.setAttribute("height", String(r2(hT)));
      tRect.setAttribute("y", String(r2(yt >= yb ? yb - hT : yb)));
      tVal.setAttribute("opacity", String(localT));
    }, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);
    return svg;
  });
}

/* ==================================================================== *
 * 7. heatstrip / steer —— 横向色带
 * ==================================================================== */
/**
 * 横向色带（好感区间带 / 新鲜度带）。段宽默认等分，可给 weight 调比例；
 * 没给 color 的段按 value 在全集里的位置取连续色阶（差→红，好→绿）。
 * 下方可选刻度（段边界小刻度 + 段名，太窄就不画字）。
 */
export function heatstrip(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const height = clampNum(o.height, 10, 4, 80);
  const anim = o.animate !== false;
  const ticks = o.ticks !== false;
  const src = Array.isArray(o.items) ? o.items : [];
  const items = [];
  for (let i = 0; i < src.length; i++) {
    const it = src[i];
    if (!it) continue;
    items.push({
      label: it.label == null ? "" : String(it.label),
      value: num(it.value, i),
      weight: Math.max(0.0001, num(it.weight, 1)),
      color: it.color || null,
    });
  }
  const TH = height + (ticks ? 20 : 2);
  if (!items.length) return mount(host, function (w) { return emptySvg(w, TH); });

  const vals = items.map(function (x) { return x.value; });
  const vmin = Math.min.apply(null, vals);
  const vmax = Math.max.apply(null, vals);
  const vspan = vmax - vmin || 1;
  const wsum = items.reduce(function (a, b) { return a + b.weight; }, 0) || 1;

  return mount(host, function (W, first) {
    const svg = svgEl("svg", {
      viewBox: "0 0 " + W + " " + TH, width: "100%", height: TH,
      preserveAspectRatio: "xMidYMid meet", role: "img",
    });
    svg.style.cssText = "display:block;width:100%;max-width:100%";

    const gid = nextId("stripclip");
    const defs = svgEl("defs");
    const clip = svgEl("clipPath", { id: gid });
    const clipRect = svgEl("rect", {
      x: 0, y: 0, width: first && anim ? 0 : W, height: height, rx: height / 2,
    });
    clip.appendChild(clipRect);
    defs.appendChild(clip);
    svg.appendChild(defs);

    const g = svgEl("g", { "clip-path": "url(#" + gid + ")" });
    let x = 0;
    const bounds = [0];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const w = (it.weight / wsum) * W;
      const t = (it.value - vmin) / vspan;
      const color = it.color || heatColor(t);
      const rect = svgEl("rect", { x: r2(x), y: 0, width: r2(w), height: height, fill: color });
      tip(rect, it.label + "：" + fmtNum(it.value));
      g.appendChild(rect);
      x += w;
      bounds.push(x);
    }
    svg.appendChild(g);

    if (ticks) {
      for (let i = 0; i < bounds.length; i++) {
        const bx = r2(bounds[i]);
        svg.appendChild(svgEl("line", {
          x1: bx, y1: height, x2: bx, y2: height + 4,
          stroke: "var(--bd,rgba(0,0,0,.09))", "stroke-width": 1,
        }));
      }
      for (let i = 0; i < items.length; i++) {
        const seg = bounds[i + 1] - bounds[i];
        if (seg < 34) continue; // 放不下就不画字，只留刻度
        svg.appendChild(svgText({
          x: r2((bounds[i] + bounds[i + 1]) / 2), y: height + 15,
          "text-anchor": "middle", "dominant-baseline": "middle",
          "font-size": 9.5, fill: "var(--tx3,#8e8e93)",
        }, truncatePx(items[i].label, seg - 4, 5.6)));
      }
    }

    const cancel = tween(520, function (p) {
      clipRect.setAttribute("width", String(r2(W * p)));
    }, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);
    return svg;
  });
}
/** 别名：steer（面板里叫「好感区间带」时的旧名字）。 */
export const steer = heatstrip;

/* ==================================================================== *
 * 8. heatgrid —— 热力网格（日历 / 贡献图）
 * ==================================================================== */
/**
 * rows 在 Y 轴、cols 在 X 轴；cellSize 是「上限」，容器太窄时自动缩小以免溢出。
 * 空值格子画灰色以示「无数据」，有值格子按全集归一取色阶。列标签会自动抽稀。
 */
export function heatgrid(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const rows = (Array.isArray(o.rows) ? o.rows : []).map(function (x) { return x == null ? "" : String(x); });
  const cols = (Array.isArray(o.cols) ? o.cols : []).map(function (x) { return x == null ? "" : String(x); });
  const cell0 = clampNum(o.cellSize, 18, 6, 44);
  const anim = o.animate !== false;
  if (!rows.length || !cols.length) return mount(host, function (w) { return emptySvg(w, 60); });

  const fmt = useFmt(o.valueFmt);
  // cells 摊平成 r,c → 值 的查找表（比每次遍历数组快，也更好容错）
  const cellMap = {};
  const cells = Array.isArray(o.cells) ? o.cells : [];
  let vmin = Infinity;
  let vmax = -Infinity;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!c || c.v == null) continue;
    const v = Number(c.v);
    if (!isFinite(v)) continue;
    cellMap[c.r + ":" + c.c] = { v: v, color: c.color || null };
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
  }
  const hasValue = vmax >= vmin && isFinite(vmin);
  const vspan = hasValue ? (vmax - vmin || 1) : 1;

  return mount(host, function (W, first) {
    const labelW = Math.min(96, Math.max(0, Math.round(W * 0.26)));
    const avail = Math.max(40, W - labelW - 2);
    const gap = cell0 >= 12 ? 2 : 1;
    const cell = clamp(Math.floor(avail / cols.length) - gap, 3, cell0);
    const step = cell + gap;
    const labelH = 14;
    const H = labelH + rows.length * step + 1;

    const svg = svgEl("svg", {
      viewBox: "0 0 " + W + " " + H, width: "100%", height: H,
      preserveAspectRatio: "xMidYMid meet", role: "img",
    });
    svg.style.cssText = "display:block;width:100%;max-width:100%";

    // 列标签抽稀：每 colStep 个显示一个
    const perChar = 5.4;
    const colStep = Math.max(1, Math.ceil(cols.length / Math.max(1, Math.floor(avail / (24 + gap)))));
    // 行标签抽稀同理（行太薄时）
    const rowStep = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor((H - labelH) / (step * 1.6)))));

    for (let c = 0; c < cols.length; c++) {
      if (c % colStep !== 0) continue;
      svg.appendChild(svgText({
        x: r2(labelW + c * step), y: labelH - 5, "text-anchor": "middle",
        "dominant-baseline": "middle", "font-size": 9.5, fill: "var(--tx3,#8e8e93)",
      }, truncatePx(cols[c], step * colStep, perChar)));
    }
    const rowGs = [];
    for (let r = 0; r < rows.length; r++) {
      const y = labelH + r * step;
      if (r % rowStep === 0 && labelW > 30) {
        svg.appendChild(svgText({
          x: labelW - 6, y: r2(y + cell / 2), "text-anchor": "end", "dominant-baseline": "middle",
          "font-size": 9.5, fill: "var(--tx3,#8e8e93)",
        }, truncatePx(rows[r], labelW - 8, 5.6)));
      }
      const rowG = svgEl("g", { opacity: first && anim ? 0 : 1 });
      for (let c = 0; c < cols.length; c++) {
        const hit = cellMap[r + ":" + c];
        const t = hit ? (hit.v - vmin) / vspan : 0;
        const fill = hit ? (hit.color || heatColor(t)) : "var(--bd,rgba(0,0,0,.09))";
        const rect = svgEl("rect", {
          x: r2(labelW + c * step), y: r2(y), width: cell, height: cell, rx: Math.min(3, cell / 3), fill: fill,
        });
        tip(rect, (rows[r] ? rows[r] + " · " : "") + (cols[c] ? cols[c] + "：" : "") + (hit ? fmt(hit.v) : EMPTY_TEXT));
        rowG.appendChild(rect);
      }
      svg.appendChild(rowG);
      rowGs.push(rowG);
    }

    if (first && anim) {
      const cancel = tween(560, function (p) {
        for (let i = 0; i < rowGs.length; i++) {
          rowGs[i].setAttribute("opacity", String(stagger(p, i, rowGs.length)));
        }
      }, { el: svg });
      trackCancel(host, cancel);
    }
    return svg;
  });
}


/* ==================================================================== *
 * 10. area —— 多系列面积 / 折线图
 * ==================================================================== */
/**
 * 面积图。4 条横向网格 + y 轴刻度；x 轴标签按可用宽度自动抽稀（首尾必显）。
 * hover 用覆盖矩形 + mousemove 找最近点，画竖线 + 各系列圆点 + 数值气泡。
 * 坐标换算走 getBoundingClientRect 的比例，容器被 CSS 缩放也能对齐。
 */
export function area(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const H = clampNum(o.height, 140, 80, 480);
  const anim = o.animate !== false;
  const stacked = !!o.stacked;
  const fmt = useFmt(o.valueFmt);
  const xLabels = Array.isArray(o.xLabels) ? o.xLabels.map(function (x) { return x == null ? "" : String(x); }) : [];
  const src = Array.isArray(o.series) ? o.series : [];
  const series = [];
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    if (!s || !Array.isArray(s.points)) continue;
    series.push({
      name: s.name == null ? "系列 " + (i + 1) : String(s.name),
      color: s.color || seriesColor(i),
      points: s.points.map(function (v) { return num(v, 0); }),
    });
  }
  const n = series.length ? Math.max.apply(null, series.map(function (s) { return s.points.length; })) : 0;
  let anyValue = false;
  for (let i = 0; i < series.length; i++) {
    for (let j = 0; j < series[i].points.length; j++) {
      if (series[i].points[j] > 0) { anyValue = true; break; }
    }
    if (anyValue) break;
  }
  if (!series.length || n < 2 || !anyValue) return mount(host, function (w) { return emptySvg(w, H); });

  return mount(host, function (W, first) {
    const padL = 36;
    const padR = 10;
    const padT = 12;
    const padB = 22;
    const plotW = Math.max(20, W - padL - padR);
    const plotH = Math.max(20, H - padT - padB);

    // 依次求每个 x 上的值（堆叠时是前缀和）
    const values = [];
    for (let j = 0; j < n; j++) {
      const col = [];
      let acc = 0;
      for (let i = 0; i < series.length; i++) {
        const v = num(series[i].points[j], 0);
        if (stacked) { acc += v; col.push(acc); } else col.push(v);
      }
      values.push(col);
    }
    let peak = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < values[j].length; i++) peak = Math.max(peak, values[j][i]);
    }
    const top = niceMax(peak);
    const xAt = function (j) { return padL + (n > 1 ? (j / (n - 1)) * plotW : plotW / 2); };
    const yAt = function (v) { return padT + plotH - (clamp(v, 0, top) / top) * plotH; };

    const svg = svgEl("svg", {
      viewBox: "0 0 " + W + " " + H, width: "100%", height: H,
      preserveAspectRatio: "xMidYMid meet", role: "img",
    });
    svg.style.cssText = "display:block;width:100%;max-width:100%";

    // 横向网格 4 条 + y 轴刻度
    for (let k = 0; k <= 4; k++) {
      const y = r2(padT + (plotH * k) / 4);
      svg.appendChild(svgEl("line", {
        x1: padL, y1: y, x2: W - padR, y2: y,
        stroke: "var(--bd,rgba(0,0,0,.09))", "stroke-width": 1,
        "stroke-dasharray": k === 4 ? "none" : "3 3",
      }));
      svg.appendChild(svgText({
        x: padL - 6, y: y, "text-anchor": "end", "dominant-baseline": "middle",
        "font-size": 9.5, fill: "var(--tx3,#8e8e93)",
      }, fmt((top * (4 - k)) / 4)));
    }

    // x 轴标签抽稀：首尾必显
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 56))));
    for (let j = 0; j < n; j += step) {
      if (!xLabels.length) break;
      const isLast = j + step >= n;
      const idx = isLast ? n - 1 : j;
      svg.appendChild(svgText({
        x: r2(xAt(idx)), y: H - 7, "text-anchor": idx === 0 ? "start" : idx === n - 1 ? "end" : "middle",
        "dominant-baseline": "middle", "font-size": 9.5, fill: "var(--tx3,#8e8e93)",
      }, truncatePx(xLabels[idx] == null ? "" : xLabels[idx], 64, 5.6)));
      if (isLast) break;
    }

    const defs = svgEl("defs");
    const lines = [];
    for (let i = 0; i < series.length; i++) {
      const se = series[i];
      let d = "";
      for (let j = 0; j < n; j++) {
        const v = values[j][i];
        const base = stacked && i > 0 ? values[j][i - 1] : 0;
        d += (j ? "L" : "M") + r2(xAt(j)) + " " + r2(yAt(v));
        if (j === 0) se.__baseD = "M" + r2(xAt(0)) + " " + r2(yAt(base));
        else se.__baseD += "L" + r2(xAt(j)) + " " + r2(yAt(base));
      }
      se.__lineD = d;
      const gid = nextId("area");
      const grad = svgEl("linearGradient", { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" });
      grad.appendChild(svgEl("stop", { offset: "0%", "stop-color": se.color, "stop-opacity": 0.3 }));
      grad.appendChild(svgEl("stop", { offset: "100%", "stop-color": se.color, "stop-opacity": 0 }));
      defs.appendChild(grad);
      se.__gid = gid;
    }
    svg.appendChild(defs);

    // 面积先画（互相叠加），线后画（保证轮廓清楚）
    for (let i = 0; i < series.length; i++) {
      const se = series[i];
      const ap = svgEl("path", {
        d: se.__lineD + "L" + r2(xAt(n - 1)) + " " + r2(yAt(0)) + "L" + r2(xAt(0)) + " " + r2(yAt(0)) + "Z",
        fill: "url(#" + se.__gid + ")", stroke: "none", opacity: first && anim ? 0 : 1,
      });
      svg.appendChild(ap);
      lines.push({ node: null, area: ap, se: se });
    }
    for (let i = 0; i < series.length; i++) {
      const ln = svgEl("path", {
        d: series[i].__lineD, fill: "none", stroke: series[i].color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round",
        pathLength: 1, "stroke-dasharray": "1", "stroke-dashoffset": first && anim ? 1 : 0,
      });
      svg.appendChild(ln);
      lines[i].node = ln;
    }

    // hover 层：竖线 + 圆点 + 气泡
    const hover = svgEl("g", { opacity: 0, "pointer-events": "none" });
    const vline = svgEl("line", {
      y1: padT, y2: padT + plotH, stroke: "var(--bd2,rgba(0,0,0,.15))", "stroke-width": 1,
    });
    hover.appendChild(vline);
    const dots = [];
    for (let i = 0; i < series.length; i++) {
      const c = svgEl("circle", { r: 3, fill: series[i].color, stroke: "var(--surface,#fff)", "stroke-width": 1.5 });
      hover.appendChild(c);
      dots.push(c);
    }
    const boxW = 118;
    const boxH = 16 + series.length * 12;
    const bubble = svgEl("g");
    const brect = svgEl("rect", {
      width: boxW, height: boxH, rx: 7,
      fill: "var(--surface,#fff)", stroke: "var(--bd2,rgba(0,0,0,.15))", "stroke-width": 1,
    });
    bubble.appendChild(brect);
    const bTitle = svgText({ x: 8, y: 12, "font-size": 10, "font-weight": 600, fill: "var(--tx1,#1b1c1d)" }, "");
    bubble.appendChild(bTitle);
    const bRows = [];
    for (let i = 0; i < series.length; i++) {
      bubble.appendChild(svgEl("circle", { cx: 12, cy: 24 + i * 12, r: 3, fill: series[i].color }));
      const t = svgText({ x: 20, y: 24 + i * 12, "font-size": 10, "dominant-baseline": "middle", fill: "var(--tx2,rgba(0,0,0,.66))" }, "");
      bubble.appendChild(t);
      bRows.push(t);
    }
    hover.appendChild(bubble);
    svg.appendChild(hover);

    const overlay = svgEl("rect", {
      x: padL, y: padT, width: plotW, height: plotH, fill: "transparent", "pointer-events": "all",
    });
    svg.appendChild(overlay);

    const onMove = function (ev) {
      let idx = 0;
      try {
        const rect = svg.getBoundingClientRect();
        const scale = rect.width ? W / rect.width : 1;
        const ux = (ev.clientX - rect.left) * scale;
        idx = Math.round(((ux - padL) / plotW) * (n - 1));
        idx = clamp(idx, 0, n - 1);
      } catch (e) {
        return;
      }
      const px = xAt(idx);
      vline.setAttribute("x1", r2(px));
      vline.setAttribute("x2", r2(px));
      for (let i = 0; i < series.length; i++) {
        const v = values[idx][i];
        dots[i].setAttribute("cx", r2(px));
        dots[i].setAttribute("cy", r2(yAt(v)));
      }
      bTitle.textContent = xLabels[idx] != null && xLabels[idx] !== "" ? xLabels[idx] : "#" + (idx + 1);
      for (let i = 0; i < series.length; i++) {
        const raw = num(series[i].points[idx], 0);
        bRows[i].textContent = clipText(series[i].name, 12) + " " + fmt(stacked ? values[idx][i] : raw);
      }
      const bx = clamp(px + 12, padL, W - boxW - 4);
      bubble.setAttribute("transform", "translate(" + r2(bx) + " " + r2(padT + 2) + ")");
      hover.setAttribute("opacity", 1);
    };
    const onLeave = function () { hover.setAttribute("opacity", 0); };
    overlay.addEventListener("mousemove", onMove);
    overlay.addEventListener("mouseleave", onLeave);

    const cancel = tween(760, function (p) {
      for (let i = 0; i < lines.length; i++) {
        const li = lines[i];
        if (li.node) {
          const local = stagger(p, i, lines.length);
          li.node.setAttribute("stroke-dashoffset", String(1 - local));
        }
        if (li.area) {
          const local = stagger(p, i, lines.length);
          li.area.setAttribute("opacity", String(clamp01((local - 0.3) / 0.7)));
        }
      }
    }, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);
    tip(svg, series.map(function (s) { return s.name; }).join(" / "));
    return svg;
  });
}

/* ==================================================================== *
 * 11. timeline —— 时间轴
 * ==================================================================== */
/**
 * 时间轴用 HTML 而不是 SVG：卡片是长文本 + 可换行，HTML 的自然流更省事，也天生响应式。
 * 默认单侧（竖线靠左）；只要任一项给了 side，就切换成左右交替布局。
 * 首帧逐条上浮淡入。
 */
export function timeline(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const anim = o.animate !== false;
  const timeFmt = typeof o.timeFmt === "function" ? o.timeFmt : function (ts) { return fmtTs(ts); };
  const src = Array.isArray(o.items) ? o.items : [];
  const items = [];
  for (let i = 0; i < src.length; i++) {
    const it = src[i];
    if (!it) continue;
    items.push({
      ts: it.ts,
      title: it.title == null ? "" : String(it.title),
      desc: it.desc == null ? "" : String(it.desc),
      color: it.color || seriesColor(i),
      tag: it.tag == null ? "" : String(it.tag),
      side: it.side === "left" || it.side === "right" ? it.side : "",
    });
  }
  if (!items.length) return mount(host, function () { return emptyBox(EMPTY_TEXT, 44); });
  const two = items.some(function (x) { return !!x.side; });

  return mount(host, function (W, first) {
    const root = hEl("div", "position:relative;padding:2px 0");
    const spineX = two ? "50%" : "16px";
    root.appendChild(hEl("div",
      "position:absolute;top:6px;bottom:6px;left:" + spineX + ";width:1px;" +
      "background:var(--bd,rgba(0,0,0,.09));transform:translateX(-0.5px)"));
    const rows = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const right = two ? it.side !== "left" : true;
      const row = hEl("div",
        "position:relative;margin-bottom:10px;display:flex;" +
        (two ? "justify-content:" + (right ? "flex-end" : "flex-start") + ";padding:0 0 0 " : "padding-left:") +
        (two ? "0" : "36px") + ";width:" + (two ? "50%" : "100%") + ";" +
        (two && !right ? "margin-left:0" : "") +
        (two && right ? "margin-left:50%" : ""));
      const dot = hEl("div",
        "position:absolute;top:8px;width:9px;height:9px;border-radius:50%;" +
        "background:" + it.color + ";border:2px solid var(--surface,#fff);box-sizing:content-box;" +
        (two ? (right ? "left:-5px" : "right:-5px") : "left:12px"));
      row.appendChild(dot);

      const card = hEl("div",
        "background:var(--surface,#fff);border:1px solid var(--bd,rgba(0,0,0,.09));" +
        "border-radius:10px;padding:8px 11px;font-size:12px;min-width:0;flex:1 1 auto" +
        (two ? ";max-width:calc(100% - 14px);margin:0 14px" : ""));
      const head = hEl("div", "display:flex;align-items:center;gap:6px;flex-wrap:wrap");
      head.appendChild(hEl("span", "font-weight:650;font-size:12.5px;color:var(--tx1,#1b1c1d)", it.title));
      if (it.tag) {
        head.appendChild(hEl("span",
          "font-size:10px;padding:1px 6px;border-radius:20px;border:1px solid " + it.color +
          ";color:" + it.color + ";white-space:nowrap", it.tag));
      }
      card.appendChild(head);
      const when = timeFmt(it.ts);
      if (when) card.appendChild(hEl("div", "font-size:10.5px;color:var(--tx3,#8e8e93);margin-top:2px", when));
      if (it.desc) card.appendChild(hEl("div", "font-size:11.5px;color:var(--tx2,rgba(0,0,0,.66));margin-top:4px;line-height:1.5;word-break:break-word", it.desc));
      row.appendChild(card);
      root.appendChild(row);
      rows.push(row);
    }

    if (first && anim) {
      for (let i = 0; i < rows.length; i++) {
        rows[i].style.opacity = "0";
        rows[i].style.transform = "translateY(6px)";
      }
      const cancel = tween(560, function (p) {
        for (let i = 0; i < rows.length; i++) {
          const local = stagger(p, i, rows.length);
          rows[i].style.opacity = String(local);
          rows[i].style.transform = "translateY(" + r2(6 * (1 - local)) + "px)";
        }
      }, { el: root, onDone: function () {
        for (let i = 0; i < rows.length; i++) {
          rows[i].style.opacity = "";
          rows[i].style.transform = "";
        }
      } });
      trackCancel(host, cancel);
    }
    return root;
  });
}

/* ==================================================================== *
 * 12. miniNetwork —— 迷你网络缩略图
 * ==================================================================== */
/**
 * 布局是「确定性」的：初值按 group 分扇区 + id 哈希排序铺在圆周上，再跑固定轮数的
 * 力导向松弛（斥力 + 弹簧 + 向心），全程不取随机数 —— 刷新页面位置不跳动。
 * interactive=true 时 hover 一个节点会高亮它和邻居、压暗其余。
 */
export function miniNetwork(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const size = clampNum(o.size, 210, 120, 640);
  const interactive = !!o.interactive;
  const anim = o.animate !== false;
  const nodes = (Array.isArray(o.nodes) ? o.nodes : []).filter(function (x) { return x && x.id != null; });
  const links = (Array.isArray(o.links) ? o.links : []).filter(function (x) { return x && x.s != null && x.t != null; });
  if (!nodes.length) return mount(host, function (w) { return emptySvg(w, size); });

  return mount(host, function (W, first) {
    const pad = 16;
    const idx = {};
    for (let i = 0; i < nodes.length; i++) idx[String(nodes[i].id)] = i;
    const edges = [];
    for (let i = 0; i < links.length; i++) {
      const a = idx[String(links[i].s)];
      const b = idx[String(links[i].t)];
      if (a == null || b == null || a === b) continue;
      edges.push([a, b, clamp(num(links[i].w, 1), 0.2, 4)]);
    }

    // 度数 → 半径（度数高的更大，视觉上像枢纽）
    const deg = new Array(nodes.length).fill(0);
    for (let i = 0; i < edges.length; i++) { deg[edges[i][0]] += 1; deg[edges[i][1]] += 1; }
    const maxDeg = Math.max.apply(null, [1].concat(deg));

    // 分组扇区 + 组内哈希排序 → 圆周四散（确定性）
    const groups = {};
    for (let i = 0; i < nodes.length; i++) {
      const g = String(nodes[i].group == null ? "" : nodes[i].group);
      (groups[g] || (groups[g] = [])).push(i);
    }
    const gks = Object.keys(groups).sort();
    const pos = new Array(nodes.length);
    let acc = 0;
    for (let gi = 0; gi < gks.length; gi++) {
      const arr = groups[gks[gi]].slice().sort(function (a, b) {
        return hashStr(nodes[a].id) - hashStr(nodes[b].id);
      });
      const share = arr.length / nodes.length;
      for (let k = 0; k < arr.length; k++) {
        const i = arr[k];
        const ang = (acc + (share * (k + 0.5)) / arr.length) * TAU;
        const rr = (size / 2 - pad) * (0.55 + 0.4 * ((hashStr(nodes[i].id + "|r") % 1000) / 1000));
        pos[i] = { x: size / 2 + Math.cos(ang) * rr, y: size / 2 + Math.sin(ang) * rr };
      }
      acc += share;
    }

    // 力导向松弛（无随机数 → 结果稳定）
    const area = size - pad * 2;
    for (let it = 0; it < 90; it++) {
      const fx = new Array(nodes.length).fill(0);
      const fy = new Array(nodes.length).fill(0);
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = pos[i].x - pos[j].x;
          let dy = pos[i].y - pos[j].y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            // 完全重合时给一个「确定性」的小扰动，别让两点永远粘在一起
            dx = ((i - j) % 3) + 0.5;
            dy = ((j - i) % 3) - 0.5;
            d2 = dx * dx + dy * dy;
          }
          const d = Math.sqrt(d2);
          const f = 900 / d2;
          fx[i] += (dx / d) * f; fy[i] += (dy / d) * f;
          fx[j] -= (dx / d) * f; fy[j] -= (dy / d) * f;
        }
      }
      for (let e = 0; e < edges.length; e++) {
        const a = edges[e][0];
        const b = edges[e][1];
        const dx = pos[b].x - pos[a].x;
        const dy = pos[b].y - pos[a].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const want = area * 0.42;
        const f = (d - want) * 0.06 * edges[e][2];
        fx[a] += (dx / d) * f; fy[a] += (dy / d) * f;
        fx[b] -= (dx / d) * f; fy[b] -= (dy / d) * f;
      }
      for (let i = 0; i < nodes.length; i++) {
        fx[i] += (size / 2 - pos[i].x) * 0.02;
        fy[i] += (size / 2 - pos[i].y) * 0.02;
        pos[i].x = clamp(pos[i].x + clamp(fx[i], -6, 6) * 0.5, pad, size - pad);
        pos[i].y = clamp(pos[i].y + clamp(fy[i], -6, 6) * 0.5, pad, size - pad);
      }
    }

    const radiusOf = function (i) {
      const base = nodes[i].r != null ? num(nodes[i].r, 6) : 5 + 9 * (deg[i] / maxDeg);
      return clamp(base, 3.5, 18);
    };
    const colorOf = function (i) {
      if (nodes[i].color) return nodes[i].color;
      const g = String(nodes[i].group == null ? "" : nodes[i].group);
      const gi = gks.indexOf(g);
      return seriesColor(gi < 0 ? i : gi);
    };

    const svg = svgEl("svg", {
      viewBox: "0 0 " + size + " " + size, width: "100%", height: size,
      preserveAspectRatio: "xMidYMid meet", role: "img",
    });
    fixedSvg(svg, size);

    // 邻接表（interactive 高亮用）
    const nb = [];
    for (let i = 0; i < nodes.length; i++) nb.push({});
    for (let e = 0; e < edges.length; e++) {
      nb[edges[e][0]][edges[e][1]] = true;
      nb[edges[e][1]][edges[e][0]] = true;
    }

    const linkNodes = [];
    for (let e = 0; e < edges.length; e++) {
      const a = edges[e][0];
      const b = edges[e][1];
      const ln = svgEl("line", {
        x1: r2(pos[a].x), y1: r2(pos[a].y), x2: r2(pos[b].x), y2: r2(pos[b].y),
        stroke: "var(--bd2,rgba(0,0,0,.15))",
        "stroke-width": r2(0.8 + edges[e][2] * 0.6), "stroke-linecap": "round",
      });
      svg.appendChild(ln);
      linkNodes.push(ln);
    }

    const nodeGs = [];
    const showLabels = nodes.length <= 26;
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const r = radiusOf(i);
      const g = svgEl("g");
      const c = svgEl("circle", {
        cx: r2(pos[i].x), cy: r2(pos[i].y), r: r, fill: colorOf(i),
        "fill-opacity": 0.92, stroke: "var(--surface,#fff)", "stroke-width": 1.2,
      });
      tip(c, (nd.label == null ? nd.id : nd.label) + (nd.group != null ? " · " + nd.group : ""));
      g.appendChild(c);
      if (showLabels) {
        const ly = clamp(pos[i].y + r + 8, 9, size - 2);
        g.appendChild(svgText({
          x: r2(clamp(pos[i].x, 16, size - 16)), y: r2(ly), "text-anchor": "middle",
          "dominant-baseline": "middle", "font-size": 9, fill: "var(--tx2,rgba(0,0,0,.66))",
        }, clipText(nd.label == null ? nd.id : nd.label, 7)));
      }
      if (nd.label != null) tip(g, nd.label);
      if (interactive) {
        g.style.cursor = "pointer";
        g.addEventListener("mouseenter", function () {
          for (let k = 0; k < linkNodes.length; k++) {
            const on = edges[k][0] === i || edges[k][1] === i;
            linkNodes[k].setAttribute("opacity", on ? "1" : "0.12");
          }
          for (let k = 0; k < nodeGs.length; k++) {
            const on = k === i || !!nb[i][k];
            nodeGs[k].setAttribute("opacity", on ? "1" : "0.16");
          }
        });
        g.addEventListener("mouseleave", function () {
          for (let k = 0; k < linkNodes.length; k++) linkNodes[k].setAttribute("opacity", "1");
          for (let k = 0; k < nodeGs.length; k++) nodeGs[k].setAttribute("opacity", "1");
        });
      }
      svg.appendChild(g);
      nodeGs.push(g);
    }

    const cancel = tween(540, function (p) {
      for (let i = 0; i < nodeGs.length; i++) nodeGs[i].setAttribute("opacity", String(stagger(p, i, nodeGs.length)));
    }, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);
    return svg;
  });
}

/* ==================================================================== *
 * 13. sankey —— 轻量桑基 / 二分图
 * ==================================================================== */
/**
 * 左右两列节点方块 + 三次贝塞尔连接带。带宽按 value 归一（两列共用同一比例尺，
 * 视觉上带宽才可比）。hover 高亮整条链路，其余链路压到 12%。
 */
export function sankey(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const H = clampNum(o.height, 260, 120, 720);
  const anim = o.animate !== false;
  const interactive = o.interactive !== false;
  const fmt = useFmt(o.valueFmt);
  const nodes = (Array.isArray(o.nodes) ? o.nodes : []).filter(function (n) { return n && n.id != null; });
  if (!nodes.length) return mount(host, function (w) { return emptySvg(w, H); });
  const links = [];
  for (let i = 0; i < (Array.isArray(o.links) ? o.links : []).length; i++) {
    const l = o.links[i];
    if (!l || l.s == null || l.t == null) continue;
    const v = Number(l.value);
    if (!isFinite(v) || v <= 0) continue;
    links.push({ s: String(l.s), t: String(l.t), value: v });
  }

  return mount(host, function (W, first) {
    const padT = 10;
    const padB = 10;
    const gap = 8;
    const nodeW = 11;
    const labelW = Math.min(90, Math.max(40, Math.round(W * 0.18)));
    const xL = labelW + 4;
    const xR = W - labelW - 4 - nodeW;
    const availH = Math.max(40, H - padT - padB);

    const left = nodes.filter(function (n) { return (n.side || "left") !== "right"; });
    const right = nodes.filter(function (n) { return (n.side || "left") === "right"; });

    // 每个节点的流量（左列出、右列入）+ 每条链路的堆叠游标
    const totalOf = {};
    for (let i = 0; i < links.length; i++) {
      totalOf[links[i].s] = (totalOf[links[i].s] || 0) + links[i].value;
      totalOf[links[i].t] = (totalOf[links[i].t] || 0) + links[i].value;
    }
    const unitOf = function (n) { return Math.max(1e-6, totalOf[String(n.id)] || 0); };
    const colWeight = function (arr) {
      let s = 0;
      for (let i = 0; i < arr.length; i++) s += unitOf(arr[i]);
      return s || 1;
    };
    const maxW = Math.max(colWeight(left), colWeight(right));
    const maxCount = Math.max(left.length, right.length);
    const pxPerUnit = Math.max(0.01, (availH - (maxCount - 1) * gap) / maxW);

    const place = function (arr) {
      let y = padT;
      const out = {};
      for (let i = 0; i < arr.length; i++) {
        const h = Math.max(4, unitOf(arr[i]) * pxPerUnit);
        out[String(arr[i].id)] = { node: arr[i], y: y, h: h, cursor: 0 };
        y += h + gap;
      }
      return out;
    };
    let slotL = place(left);
    let slotR = place(right);
    // 小节点有 4px 高度下限，排完可能超出一屏：按超出比例等比压一次就够
    const bottomOf = function (slots) {
      let bottom = 0;
      for (const k in slots) bottom = Math.max(bottom, slots[k].y + slots[k].h);
      return bottom - (padT + availH);
    };
    const over = Math.max(bottomOf(slotL), bottomOf(slotR));
    if (over > 0) {
      const s = clamp(1 - over / Math.max(1, availH), 0.35, 1);
      const reposition = function (arr, slots) {
        let y = padT;
        for (let i = 0; i < arr.length; i++) {
          const h = Math.max(3, slots[String(arr[i].id)].h * s);
          slots[String(arr[i].id)].y = y;
          slots[String(arr[i].id)].h = h;
          y += h + gap;
        }
      };
      reposition(left, slotL);
      reposition(right, slotR);
    }

    const svg = svgEl("svg", {
      viewBox: "0 0 " + W + " " + H, width: "100%", height: H,
      preserveAspectRatio: "xMidYMid meet", role: "img",
    });
    svg.style.cssText = "display:block;width:100%;max-width:100%";

    const linkLayer = svgEl("g");
    svg.appendChild(linkLayer);
    const linkNodes = [];
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      const a = slotL[l.s];
      const b = slotR[l.t];
      if (!a || !b) continue;
      const h0 = Math.max(1, (l.value / unitOf(a.node)) * a.h);
      const h1 = Math.max(1, (l.value / unitOf(b.node)) * b.h);
      const y0 = a.y + a.cursor;
      const y1 = b.y + b.cursor;
      a.cursor += h0;
      b.cursor += h1;
      const x0 = xL + nodeW;
      const x1 = xR;
      const mid = (x0 + x1) / 2;
      const d = "M" + r2(x0) + " " + r2(y0) +
        "C" + r2(mid) + " " + r2(y0) + " " + r2(mid) + " " + r2(y1) + " " + r2(x1) + " " + r2(y1) +
        "L" + r2(x1) + " " + r2(y1 + h1) +
        "C" + r2(mid) + " " + r2(y1 + h1) + " " + r2(mid) + " " + r2(y0 + h0) + " " + r2(x0) + " " + r2(y0 + h0) + "Z";
      const color = (a.node.color || seriesColor(nodes.indexOf(a.node)));
      const path = svgEl("path", { d: d, fill: color, "fill-opacity": 0.42, stroke: "none" });
      tip(path, l.s + " → " + l.t + "：" + fmt(l.value));
      linkLayer.appendChild(path);
      linkNodes.push({ node: path, s: l.s, t: l.t, a: a.node, b: b.node });
      if (interactive) {
        const link = linkNodes[linkNodes.length - 1];
        path.addEventListener("mouseenter", function () {
          for (let k = 0; k < linkNodes.length; k++) {
            const on = linkNodes[k] === link;
            linkNodes[k].node.setAttribute("opacity", on ? "1" : "0.12");
          }
          for (let k = 0; k < nodeRects.length; k++) {
            const id = nodeRects[k].id;
            nodeRects[k].node.setAttribute("opacity", id === link.s || id === link.t ? "1" : "0.25");
          }
        });
        path.addEventListener("mouseleave", function () {
          for (let k = 0; k < linkNodes.length; k++) linkNodes[k].node.setAttribute("opacity", "1");
          for (let k = 0; k < nodeRects.length; k++) nodeRects[k].node.setAttribute("opacity", "1");
        });
      }
    }

    const nodeRects = [];
    const drawCol = function (arr, slots, x, sideRight) {
      for (let i = 0; i < arr.length; i++) {
        const nd = arr[i];
        const sl = slots[String(nd.id)];
        if (!sl) continue;
        const color = nd.color || seriesColor(i);
        const rect = svgEl("rect", {
          x: r2(x), y: r2(sl.y), width: nodeW, height: r2(sl.h), rx: 2.5, fill: color,
        });
        tip(rect, (nd.label == null ? nd.id : nd.label) + "：" + fmt(totalOf[String(nd.id)] || 0));
        svg.appendChild(rect);
        const tx = sideRight ? x + nodeW + 5 : x - 5;
        const label = svgText({
          x: r2(clamp(tx, 2, W - 2)), y: r2(sl.y + Math.min(sl.h / 2, 8)), "text-anchor": sideRight ? "start" : "end",
          "dominant-baseline": "middle", "font-size": 10.5, fill: "var(--tx2,rgba(0,0,0,.66))",
        }, truncatePx(nd.label == null ? nd.id : nd.label, labelW, 6));
        tip(label, String(nd.label == null ? nd.id : nd.label));
        svg.appendChild(label);
        nodeRects.push({ node: rect, id: String(nd.id) });
      }
    };
    drawCol(left, slotL, xL, false);
    drawCol(right, slotR, xR, true);

    const cancel = tween(620, function (p) {
      for (let i = 0; i < linkNodes.length; i++) {
        linkNodes[i].node.setAttribute("fill-opacity", String(0.42 * stagger(p, i, linkNodes.length)));
      }
    }, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);
    return svg;
  });
}

/* ==================================================================== *
 * 14. avatar —— 圆形头像
 * ==================================================================== */
/**
 * 头像：取名字首字符（CJK 直接取第一个汉字，拉丁字母大写），按 name 哈希选一组
 * 固定渐变（不跟主题走，避免暗色下同一人变色）。ring=0..1 时外圈画进度环。
 */
const AVATAR_PAIRS = [
  ["#3c96ca", "#03c9d7"], ["#00a3a3", "#00c853"], ["#e0559a", "#8b5cf6"],
  ["#f59e0b", "#ef6c5a"], ["#4a90d9", "#0074d9"], ["#64748b", "#8e8e93"],
  ["#009296", "#3c96ca"], ["#8b5cf6", "#e0559a"],
];
export function avatar(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const size = clampNum(o.size, 36, 16, 200);
  const name = o.name == null ? "" : String(o.name).trim();
  const hasRing = o.ring != null && isFinite(Number(o.ring));
  const rv = hasRing ? clamp01(Number(o.ring)) : 0;
  const anim = o.animate !== false;

  let pair;
  if (o.color) pair = [o.color, o.color];
  else if (!name) pair = ["#9aa0a6", "#6b7280"];
  else pair = AVATAR_PAIRS[hashStr(name) % AVATAR_PAIRS.length];

  const first = Array.from(name)[0] || "?";
  const initial = /^[a-z]$/.test(first) ? first.toUpperCase() : first;

  return mount(host, function (W, firstRender) {
    const ringW = hasRing ? Math.max(2.5, size * 0.075) : 0;
    const r = (size - ringW * 2) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const svg = svgEl("svg", {
      viewBox: "0 0 " + size + " " + size, width: "100%", height: size,
      preserveAspectRatio: "xMidYMid meet", role: "img",
    });
    fixedSvg(svg, size);

    const gid = nextId("av");
    const defs = svgEl("defs");
    const grad = svgEl("linearGradient", { id: gid, x1: "0", y1: "0", x2: "1", y2: "1" });
    grad.appendChild(svgEl("stop", { offset: "0%", "stop-color": pair[0] }));
    grad.appendChild(svgEl("stop", { offset: "100%", "stop-color": pair[1] }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    let ringArc = null;
    if (hasRing) {
      svg.appendChild(svgEl("circle", {
        cx: cx, cy: cy, r: r + ringW / 2, fill: "none",
        stroke: "var(--bd,rgba(0,0,0,.09))", "stroke-width": ringW,
      }));
      ringArc = svgEl("circle", {
        cx: cx, cy: cy, r: r + ringW / 2, fill: "none", stroke: "var(--primary,#3c96ca)",
        "stroke-width": ringW, "stroke-linecap": "round", pathLength: 1, "stroke-dasharray": "1 1",
        "stroke-dashoffset": firstRender && anim ? 1 : 1 - rv,
        transform: "rotate(-90 " + cx + " " + cy + ")",
      });
      svg.appendChild(ringArc);
    }
    svg.appendChild(svgEl("circle", { cx: cx, cy: cy, r: r, fill: "url(#" + gid + ")" }));
    svg.appendChild(svgText({
      x: cx, y: cy, "text-anchor": "middle", "dominant-baseline": "central",
      "font-size": r2(size * 0.42), "font-weight": 600, fill: "#fff",
    }, initial));
    tip(svg, name || "匿名");

    // 进度环扫入：用 dashoffset 从 1 收到 1-rv，跟 ring() 同一套手法
    if (ringArc && firstRender && anim) {
      const arc = ringArc;
      const cancel = tween(600, function (p) {
        arc.setAttribute("stroke-dashoffset", String(1 - rv * p));
      }, { el: svg });
      trackCancel(host, cancel);
    }
    return svg;
  });
}

/* ==================================================================== *
 * 15. legend —— 统一图例
 * ==================================================================== */
/**
 * 图例：dot（默认）适合环形/散点，line 适合折线，square 适合热力/分类块。
 * 用 HTML flex 排布，窄容器自动换行。
 */
export function legend(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const shape = o.shape === "line" || o.shape === "square" ? o.shape : "dot";
  const src = Array.isArray(o.items) ? o.items : [];
  const items = [];
  for (let i = 0; i < src.length; i++) {
    const it = src[i];
    if (!it || it.label == null) continue;
    items.push({ label: String(it.label), color: it.color || seriesColor(i) });
  }
  if (!items.length) return mount(host, function () { return emptyBox(EMPTY_TEXT, 24); });

  return mount(host, function () {
    const wrap = hEl("div", "display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;font-size:11px");
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const row = hEl("div", "display:inline-flex;align-items:center;gap:5px;min-width:0");
      let sw;
      if (shape === "line") {
        sw = hEl("span", "display:inline-block;width:14px;height:4px;border-radius:2px;background:" + it.color + ";flex:0 0 auto");
      } else if (shape === "square") {
        sw = hEl("span", "display:inline-block;width:10px;height:10px;border-radius:3px;background:" + it.color + ";flex:0 0 auto");
      } else {
        sw = hEl("span", "display:inline-block;width:8px;height:8px;border-radius:50%;background:" + it.color + ";flex:0 0 auto");
      }
      row.appendChild(sw);
      row.appendChild(hEl("span", "color:var(--tx2,rgba(0,0,0,.66));white-space:nowrap", clipText(it.label, 26)));
      wrap.appendChild(row);
    }
    return wrap;
  });
}

/* ==================================================================== *
 * 16. barSplit —— 百分比分段条（取代环形/甜甜圈的构成类图表）
 * ==================================================================== */
/**
 * 为什么用它取代 donut：
 * 环形图要用圆弧 + 线帽表达占比，占比极小的段会渲染成「一粒脱离圆环的圆点」，
 * 环本身还容易被卡片边缘裁切 —— 观感上就是「坏掉的图」。分段条只用矩形，
 * 每个色段有最小可见宽度，永远不会出现孤点；「每种颜色代表什么」由下方图例逐条写清楚
 * （用户明确要求：上面出条，下面写说明）。
 */
export function barSplit(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const height = clampNum(o.height, 16, 8, 40);
  const anim = o.animate !== false;
  const fmt = useFmt(o.valueFmt);
  const showLegend = o.legend !== false;
  const raw = Array.isArray(o.items) ? o.items : [];

  const items = [];
  let total = 0;
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i];
    if (!it) continue;
    const v = Number(it.value);
    if (!isFinite(v) || v <= 0) continue;
    items.push({
      label: it.label == null ? "" : String(it.label),
      value: v,
      color: it.color || seriesColor(items.length),
      pct: 0,
    });
    total += v;
  }
  for (let i = 0; i < items.length; i++) items[i].pct = items[i].value / total;

  if (!items.length || total <= 0) {
    return mount(host, function (w) {
      const wrap = hEl("div", "display:flex;flex-direction:column;gap:6px;width:100%");
      wrap.appendChild(emptySvg(w, height, "暂无数据"));
      return wrap;
    });
  }

  return mount(host, function (W, first) {
    const wrap = hEl("div", "display:flex;flex-direction:column;gap:7px;width:100%;min-width:0");
    const clipId = "hfbarsplit" + Math.random().toString(36).slice(2, 9);
    const svg = svgEl("svg", {
      viewBox: "0 0 " + W + " " + height,
      width: "100%",
      height: height,
      role: "img",
      preserveAspectRatio: "none",
    });
    svg.style.cssText = "display:block;width:100%;max-width:100%;height:" + height + "px";
    const defs = svgEl("defs");
    const clip = svgEl("clipPath", { id: clipId });
    clip.appendChild(svgEl("rect", { x: 0, y: 0, width: W, height: height, rx: height / 2, ry: height / 2 }));
    defs.appendChild(clip);
    svg.appendChild(defs);
    svg.appendChild(svgEl("rect", {
      x: 0,
      y: 0,
      width: W,
      height: height,
      rx: height / 2,
      ry: height / 2,
      fill: "var(--primary-soft,rgba(60,150,202,.10))",
    }));

    /* 最小可见宽度：占比极小的段也保证 3px（颜色对得上图例就行），
       缺口从最大的那一段扣，总宽不超容器。 */
    const minPx = Math.min(3, W * 0.02);
    const widths = items.map(function (it) {
      return (it.value / total) * W;
    });
    let big = 0;
    for (let i = 1; i < widths.length; i++) if (widths[i] > widths[big]) big = i;
    let deficit = 0;
    for (let i = 0; i < widths.length; i++) {
      if (i === big || widths[i] >= minPx) continue;
      deficit += minPx - widths[i];
      widths[i] = minPx;
    }
    if (deficit > 0) widths[big] = Math.max(minPx, widths[big] - deficit);

    const group = svgEl("g", { "clip-path": "url(#" + clipId + ")" });
    const rects = [];
    let x = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const w = widths[i];
      const segW = Math.max(0.5, w - (i < items.length - 1 ? 1 : 0));
      const rect = svgEl("rect", {
        x: r2(anim && first ? 0 : x),
        y: 0,
        width: r2(anim && first ? 0 : segW),
        height: height,
        fill: it.color,
      });
      tip(rect, it.label + " · " + fmt(it.value) + "（" + fmtPct(it.pct, 1) + "）");
      group.appendChild(rect);
      rects.push({ node: rect, x: x, w: segW });
      x += w;
    }
    svg.appendChild(group);
    wrap.appendChild(svg);

    if (showLegend) {
      const lg = hEl("div", "display:flex;flex-wrap:wrap;gap:5px 14px;font-size:11px;color:var(--tx2);line-height:1.5");
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const row = hEl("div", "display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%");
        row.appendChild(hEl("i", "width:10px;height:10px;border-radius:3px;flex-shrink:0;background:" + it.color));
        row.appendChild(hEl("span", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap", it.label));
        row.appendChild(hEl("b", "color:var(--tx1);font-weight:650;font-variant-numeric:tabular-nums", fmt(it.value)));
        row.appendChild(hEl("span", "color:var(--tx3);font-variant-numeric:tabular-nums", fmtPct(it.pct, 1)));
        lg.appendChild(row);
      }
      wrap.appendChild(lg);
    }

    const cancel = tween(560, function (p) {
      for (let i = 0; i < rects.length; i++) {
        const k = Math.max(0.001, stagger(p, i, rects.length));
        rects[i].node.setAttribute("x", r2(rects[i].x));
        rects[i].node.setAttribute("width", r2(Math.max(0.5, rects[i].w * k)));
      }
    }, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);
    return wrap;
  });
}

/* ==================================================================== *
 * 17. barGauge —— 单值进度条（取代 ring）
 * ==================================================================== */
/**
 * 单值进度用横条表达：上面一条（轨道 + 填充），下面一行写「这是什么 + 数值 / 百分比」。
 * 相比环形：不会被卡片裁切、凹槽与填充一眼可比、数字也不必挤在圆心。
 */
export function barGauge(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const height = clampNum(o.height, 12, 6, 26);
  const anim = o.animate !== false;
  const fmt = useFmt(o.valueFmt);
  const rawV = o.value == null ? NaN : Number(o.value);
  if (!isFinite(rawV)) return mount(host, function (w) { return emptySvg(w, height, "暂无数据"); });
  const max = Number(o.max) > 0 ? Number(o.max) : 1;
  const v = clamp01(rawV / max);
  const color = o.color || "var(--primary,#3c96ca)";
  const label = o.label == null ? "" : String(o.label);
  const sub = o.sub == null ? "" : String(o.sub);

  return mount(host, function (W, first) {
    const wrap = hEl("div", "display:flex;flex-direction:column;gap:5px;width:100%;min-width:0");
    const clipId = "hfbar" + Math.random().toString(36).slice(2, 9);
    const svg = svgEl("svg", {
      viewBox: "0 0 " + W + " " + height,
      width: "100%",
      height: height,
      role: "img",
      preserveAspectRatio: "none",
    });
    svg.style.cssText = "display:block;width:100%;max-width:100%;height:" + height + "px";
    const defs = svgEl("defs");
    const clip = svgEl("clipPath", { id: clipId });
    clip.appendChild(svgEl("rect", { x: 0, y: 0, width: W, height: height, rx: height / 2, ry: height / 2 }));
    defs.appendChild(clip);
    svg.appendChild(defs);
    svg.appendChild(svgEl("rect", {
      x: 0,
      y: 0,
      width: W,
      height: height,
      rx: height / 2,
      ry: height / 2,
      fill: "var(--primary-soft,rgba(60,150,202,.10))",
    }));
    const fillW = Math.max(v > 0 ? 2 : 0, W * v);
    const fill = svgEl("rect", {
      x: 0,
      y: 0,
      width: r2(anim && first ? 0 : fillW),
      height: height,
      fill: color,
      "clip-path": "url(#" + clipId + ")",
    });
    tip(fill, (label ? label + " · " : "") + fmtPct(v, 1));
    svg.appendChild(fill);
    wrap.appendChild(svg);

    const cap = hEl("div", "display:flex;align-items:baseline;gap:6px;font-size:11px;flex-wrap:wrap");
    if (label) cap.appendChild(hEl("span", "color:var(--tx3);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", label));
    cap.appendChild(hEl("b", "color:var(--tx1);font-weight:650;font-variant-numeric:tabular-nums", fmtPct(v, 1)));
    if (sub) cap.appendChild(hEl("span", "color:var(--tx3)", sub));
    wrap.appendChild(cap);

    const cancel = tween(620, function (p) {
      fill.setAttribute("width", r2(Math.max(v > 0 ? 2 : 0, fillW * p)));
    }, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);
    return wrap;
  });
}

/* ==================================================================== *
 * 18. stageBars —— 分级条形（取代漏斗图）
 * ==================================================================== */
/**
 * 为什么不再用漏斗：
 * 漏斗靠「上宽下窄的梯形」表达递减 —— 形状本身就是信息，所以形状一坏信息就没了。
 * 真机上只要某一层为 0（门控「触发开口 0」很常见），脖子就收成 0 宽，整张图变成蝴蝶结；
 * 层数一变梯形斜率也乱跳，同一批数字换个统计窗口看就是另一种形状。
 * 分级条形把每层画成一条独立横条（长度只由本层值决定，与层数无关），
 * 层间单独标出「少了多少、占首层几成」—— 形状永远稳定，任何数值都读得懂。
 */
export function stageBars(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const anim = o.animate !== false;
  const fmt = useFmt(o.valueFmt);
  const src = Array.isArray(o.stages) ? o.stages : [];
  const stages = [];
  for (let i = 0; i < src.length; i++) {
    const it = src[i];
    if (!it) continue;
    const v = Number(it.value);
    if (!isFinite(v) || v < 0) continue;
    stages.push({
      label: it.label == null ? "" : String(it.label),
      value: v,
      color: it.color || seriesColor(i),
      // noDrop：这层跟前一层是「并列结果」而不是「下游」，别硬标落差
      // （门控里「保持沉默」是「触发开口」的兄弟，写成「少了 93%」会彻底误导）。
      noDrop: !!it.noDrop,
      note: it.note == null ? "" : String(it.note),
    });
  }
  const maxV = stages.reduce(function (m, x) { return Math.max(m, x.value); }, 0);
  if (!stages.length || maxV <= 0) {
    return mount(host, function (w) { return emptySvg(w, 56, o.emptyText || "暂无数据"); });
  }

  const rowH = 44;
  const dropH = 20;
  const barH = 14;

  return mount(host, function (W, first) {
    const H = stages.length * rowH + (stages.length - 1) * dropH + 4;
    const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", height: H, role: "img" });
    svg.style.cssText = "display:block;width:100%;max-width:100%;height:" + H + "px";
    const fills = [];
    const base = stages[0].value;

    for (let i = 0; i < stages.length; i++) {
      const st = stages[i];
      const y = i * (rowH + dropH);
      const ratio = clamp01(st.value / maxV);
      const full = W * ratio;
      const pctFirst = base > 0 ? st.value / base : 0;

      // 标签行：左「这层是什么」、右「数值 + 占首层几成」
      svg.appendChild(svgText({ x: 0, y: y + 9, "font-size": 11.5, fill: "var(--tx2)" }, st.label));
      // 右侧只留「数值 · 占比」，措辞太长在窄卡片里会被挤掉
      const valTxt = pctFirst < 0.9995 ? fmt(st.value) + " · " + fmtPct(pctFirst, 1) : fmt(st.value);
      svg.appendChild(
        svgText({ x: W, y: y + 9, "font-size": 11.5, "font-weight": 650, fill: "var(--tx1)", "text-anchor": "end" }, valTxt)
      );

      // 横条：轨道 + 填充
      const by = y + 15;
      svg.appendChild(svgEl("rect", {
        x: 0, y: by, width: W, height: barH, rx: 4, ry: 4,
        fill: "var(--primary-soft,rgba(60,150,202,.10))",
      }));
      const fill = svgEl("rect", {
        x: 0, y: by, width: r2(anim && first ? 0 : Math.max(2, full)), height: barH, rx: 4, ry: 4,
        fill: st.color,
      });
      tip(fill, st.label + " · " + fmt(st.value) + (i > 0 ? "（占首层 " + fmtPct(pctFirst, 1) + "）" : "（基准层）"));
      svg.appendChild(fill);
      fills.push({ node: fill, w: Math.max(2, full) });

      /* 层间说明：
         下一层若是并列结果（noDrop），只写它自己的说明，不写「少了多少」；
         真下游才写落差 —— 这是原漏斗图唯一真正有用的信息。 */
      if (i < stages.length - 1) {
        const nxt = stages[i + 1];
        const dy = by + barH + 13;
        let txt = "";
        let fill = "var(--tx3)";
        if (nxt.noDrop) {
          txt = nxt.note || "并列结果（不是「" + st.label + "」的下游）";
        } else {
          const diff = st.value - nxt.value;
          txt = diff >= 0
            ? "↓ 少了 " + fmt(diff) + "（" + fmtPct(st.value > 0 ? diff / st.value : 0, 1) + "）"
            : "↑ 多了 " + fmt(-diff);
          if (diff < 0) fill = "var(--success,#00c853)";
        }
        if (txt) svg.appendChild(svgText({ x: 0, y: dy, "font-size": 10.5, fill }, txt));
      }
    }

    const cancel = tween(620, function (p) {
      for (let i = 0; i < fills.length; i++) {
        const k = Math.max(0.02, stagger(p, i, fills.length));
        fills[i].node.setAttribute("width", r2(fills[i].w * k));
      }
    }, { el: svg, animate: first ? anim : false });
    trackCancel(host, cancel);
    return svg;
  });
}

/* ==================================================================== *
 * 19. flowGraph —— 运作流程图（分阶段 + 流动光点 + 可点可悬停）
 * ==================================================================== */
/**
 * 为什么不用现成的小网络图（miniNetwork）：
 * 它表达的是「谁连谁」，适合关系链；但「系统怎么跑」重要的是**顺序、因果、量级**——
 * 圆周四散的布局看不出先后，也塞不下每步的读数。
 * 这里按阶段分列（左→右就是数据流方向），每个节点是一张可读的小卡片：
 * 图标 + 名称 + 大数字 + 单位说明；连线带**流动光点**表示「正在往下一步走」，
 * 光点多快跟这条边的量级挂钩；悬停高亮该节点的上下游，点击直接跳到对应页面。
 * 这样一屏能同时表达「结构 / 量级 / 方向 / 入口」，比一排 KPI 卡片省地方也更好读。
 *
 * @param {HTMLElement|string} el
 * @param {{nodes:Array<{id:string,stage:number,label:string,icon?:string,value:number|string,unit?:string,sub?:string,color?:string,to?:string}>,
 *          links:Array<{from:string,to:string,label?:string,value?:number}>,
 *          height?:number, onPick?:Function, animate?:boolean}} opts
 */
export function flowGraph(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const anim = o.animate !== false;
  const nodes = (Array.isArray(o.nodes) ? o.nodes : []).filter(function (n) { return n && n.id != null; });
  const links = (Array.isArray(o.links) ? o.links : []).filter(function (l) { return l && l.from != null && l.to != null; });
  if (!nodes.length) return mount(host, function (w) { return emptySvg(w, 120, "没有数据"); });

  const stages = [];
  nodes.forEach(function (n) {
    const st = Number(n.stage) || 0;
    if (!stages[st]) stages[st] = [];
    stages[st].push(n);
  });
  const maxRow = stages.reduce(function (m, arr) { return Math.max(m, arr ? arr.length : 0); }, 1);
  const nodeW = 148;
  const nodeH = 74;
  const vGap = 16;
  const hGap = 54;
  const wantH = clampNum(o.height, Math.max(180, maxRow * (nodeH + vGap) + 26), 140, 900);

  return mount(host, function (W, first) {
    const nStages = stages.filter(Boolean).length || 1;
    const needW = nStages * nodeW + (nStages - 1) * hGap + 20;
    const colW = Math.max(nodeW + 10, (W - 20 - (nStages - 1) * hGap) / nStages);
    const H = wantH;
    const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", height: H, role: "img" });
    svg.style.cssText = "display:block;width:100%;max-width:100%;height:" + H + "px";

    // 节点坐标：按阶段分列，列内均匀分布
    const pos = {};
    let sx = 10;
    for (let si = 0; si < stages.length; si++) {
      const arr = stages[si];
      if (!arr) continue;
      const cx = sx + colW / 2;
      const n = arr.length;
      const totalH = n * nodeH + (n - 1) * vGap;
      let y = Math.max(14, (H - totalH) / 2);
      for (let i = 0; i < n; i++) {
        pos[arr[i].id] = { x: cx - colW / 2 + 4, y: y, w: colW - 8, h: nodeH, node: arr[i], si: si };
        y += nodeH + vGap;
      }
      sx += colW + hGap;
    }

    const defs = svgEl("defs");
    // 光点用渐变做出「头亮尾淡」的拖尾感
    defs.appendChild(svgEl("radialGradient", { id: "hfFlowDot" })).innerHTML = "";
    svg.appendChild(defs);

    const gLinks = svgEl("g");
    const gNodes = svgEl("g");
    const gDots = svgEl("g");
    svg.appendChild(gLinks);
    svg.appendChild(gNodes);
    svg.appendChild(gDots);

    const palette = ["#3c96ca", "#03c9d7", "#8b5cf6", "#e0559a", "#00c853", "#f59e0b", "#9aa4b2", "#4a90d9"];
    const paths = [];
    const dotNodes = [];

    links.forEach(function (l, li) {
      const a = pos[l.from];
      const b = pos[l.to];
      if (!a || !b) return;
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const mx = (x1 + x2) / 2;
      const color = (b.node.color || a.node.color || palette[b.si % palette.length]);
      const d = "M " + r2(x1) + " " + r2(y1) + " C " + r2(mx) + " " + r2(y1) + ", " + r2(mx) + " " + r2(y2) + ", " + r2(x2) + " " + r2(y2);
      const path = svgEl("path", { d: d, fill: "none", stroke: color, "stroke-width": 1.6, "stroke-opacity": 0.30, "stroke-linecap": "round" });
      gLinks.appendChild(path);
      // 箭头：让方向一眼可见
      gLinks.appendChild(svgEl("path", {
        d: "M " + r2(x2 - 6) + " " + r2(y2 - 4) + " L " + r2(x2) + " " + r2(y2) + " L " + r2(x2 - 6) + " " + r2(y2 + 4),
        fill: "none", stroke: color, "stroke-width": 1.6, "stroke-opacity": 0.45, "stroke-linecap": "round",
      }));
      const len = Math.max(60, Math.abs(x2 - x1));
      const speed = 26 + Math.min(60, Math.log10(Math.max(1, Number(l.value) || 1)) * 22);
      const dot = svgEl("circle", { r: 2.6, fill: color, opacity: 0.85 });
      gDots.appendChild(dot);
      dotNodes.push({ dot: dot, path: path, len: len, x1: x1, y1: y1, x2: x2, y2: y2, speed: speed, phase: (li * 0.37) % 1 });
      paths.push({ path: path, color: color });
    });

    const cards = [];
    nodes.forEach(function (n) {
      const p = pos[n.id];
      if (!p) return;
      const color = n.color || palette[p.si % palette.length];
      const g = svgEl("g", { style: "cursor:" + (n.to ? "pointer" : "default") });
      const rect = svgEl("rect", {
        x: r2(p.x), y: r2(p.y), width: r2(p.w), height: r2(p.h), rx: 9, ry: 9,
        fill: "var(--surface2,#1b2130)", stroke: color, "stroke-opacity": 0.35, "stroke-width": 1.2,
      });
      g.appendChild(rect);
      // 左侧色条：一眼分辨域
      g.appendChild(svgEl("rect", { x: r2(p.x), y: r2(p.y + 8), width: 3, height: r2(p.h - 16), rx: 1.5, fill: color, opacity: 0.9 }));
      if (n.icon) g.appendChild(svgText({ x: r2(p.x + 12), y: r2(p.y + 22), "font-size": 14, fill: color }, String(n.icon)));
      g.appendChild(svgText({ x: r2(p.x + (n.icon ? 32 : 12)), y: r2(p.y + 21), "font-size": 11.5, "font-weight": 650, fill: "var(--tx1,#e8edf7)" }, String(n.label || "")));
      g.appendChild(svgText({ x: r2(p.x + 12), y: r2(p.y + 46), "font-size": 18, "font-weight": 750, fill: color }, String(n.value == null ? "—" : n.value)));
      if (n.unit) g.appendChild(svgText({ x: r2(p.x + 12 + String(n.value == null ? "—" : n.value).length * 11), y: r2(p.y + 46), "font-size": 10.5, fill: "var(--tx3,#8b95a7)" }, String(n.unit)));
      if (n.sub) g.appendChild(svgText({ x: r2(p.x + 12), y: r2(p.y + 62), "font-size": 10, fill: "var(--tx3,#8b95a7)" }, truncatePx(String(n.sub), p.w - 20, 6)));
      tip(rect, String(n.label || "") + (n.sub ? " · " + n.sub : "") + (n.to ? "\n点击进入" : ""));
      gNodes.appendChild(g);
      cards.push({ g: g, rect: rect, node: n, color: color, base: p });
      if (n.to) {
        g.addEventListener("click", function () {
          if (typeof o.onPick === "function") o.onPick(n);
        });
      }
      // 悬停高亮上下游
      g.addEventListener("mouseenter", function () {
        const up = {}, down = {};
        links.forEach(function (l) {
          if (l.from === n.id) down[l.to] = 1;
          if (l.to === n.id) up[l.from] = 1;
        });
        cards.forEach(function (c) {
          const related = c.node.id === n.id || up[c.node.id] || down[c.node.id];
          c.g.style.opacity = related ? "1" : "0.28";
        });
        paths.forEach(function (pp, i) {
          const l = links[i] || {};
          const related = l.from === n.id || l.to === n.id;
          pp.path.setAttribute("stroke-opacity", related ? 0.85 : 0.10);
          pp.path.setAttribute("stroke-width", related ? 2.6 : 1.2);
        });
        rect.setAttribute("stroke-opacity", 0.95);
      });
      g.addEventListener("mouseleave", function () {
        cards.forEach(function (c) { c.g.style.opacity = "1"; });
        paths.forEach(function (pp) { pp.path.setAttribute("stroke-opacity", 0.30); pp.path.setAttribute("stroke-width", 1.6); });
        rect.setAttribute("stroke-opacity", 0.35);
      });
    });

    // 流动光点：沿曲线按长度匀速前进（用 SVG 的 getPointAtLength）
    let raf = 0;
    let stop = false;
    if (anim && dotNodes.length) {
      const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const tick = function () {
        if (stop) return;
        const t = ((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0) / 1000;
        for (let i = 0; i < dotNodes.length; i++) {
          const dn = dotNodes[i];
          let total = 0;
          try { total = dn.path.getTotalLength(); } catch (e) { total = dn.len; }
          const p = ((t * dn.speed) / Math.max(40, total) + dn.phase) % 1;
          let pt = null;
          try { pt = dn.path.getPointAtLength(p * total); } catch (e) { pt = null; }
          if (pt) {
            dn.dot.setAttribute("cx", r2(pt.x));
            dn.dot.setAttribute("cy", r2(pt.y));
            dn.dot.setAttribute("opacity", String(0.25 + 0.7 * Math.sin(Math.PI * p)));
          }
        }
        raf = _raf(tick);
      };
      raf = _raf(tick);
      trackCancel(host, function () { stop = true; if (raf) _rafCancel(raf); });
    }

    return svg;
  });
}

/* ==================================================================== *
 * selfTest —— 集成前的冒烟自检
 * ==================================================================== */
/**
 * 建一个离屏容器，把 15 个组件各渲染一遍。
 * 返回 { ok:true, rendered:[名称] } 或 { ok:false, error }。
 * 只做「不抛错 + 能返回节点」的验证，不校验像素（自检函数在文件末尾 selfTest）。
 */

/**
 * 矩阵密度图（消息事件 D 版的主视觉）。
 * 行 = 实体（会话 / 人 / 模块），列 = 维度（因子 / 闸门 / 日期 / 小时），格 = 信号。
 * 设计约束（与项目一致）：
 *  - 颜色 + 文字双编码：格子里能写数字就写数字，颜色只做"加深印象"，不单独承载语义；
 *  - 不用圆环 / 百分比；空值 = 中性灰格（"无事件"是事实，不是 0）；
 *  - 键盘可达：可点的格子/行都能 Tab 到，回车等同点击；悬停只做增强（title）。
 *
 * opts: {
 *   rows: [{ label, sub, tip, cls }],          行标签（sub 写小字）
 *   cols: [{ label, tip }],                    列标题
 *   cells: [[cell, ...], ...] | (r, c) => cell 二维数组或取格函数
 *   legend: [[tone 或 css 色, '文案'], ...]     图例（可选）
 *   onPick: (r, c, cell) => void               点格子
 *   onRow:  (r) => void                        点行尾/行标签
 *   labelW: 132, gap: 3, emptyText: '...'
 * }
 * cell: { t: tone, lvl: 1|2|3, v: '显示文本', tip: '悬停说明' }
 * tone: zero|mute|pos|neg|acc|pro|rec|fav|num|tag|tagok|tagwarn
 */
export function matrix(el, opts) {
  const host = resolveHost(el);
  if (!host) return null;
  const o = opts || {};
  const rows = (Array.isArray(o.rows) ? o.rows : []).filter(Boolean);
  const cols = (Array.isArray(o.cols) ? o.cols : []).filter(Boolean);
  if (!rows.length || !cols.length) {
    return mount(host, function () { return emptyBox(o.emptyText || "还没有数据", 46); });
  }
  const gap = num(o.gap, 3);
  const labelW = Math.max(64, num(o.labelW, 132));
  const RGB = {
    pos: "34,166,107", neg: "224,87,87", acc: "60,150,202",
    pro: "139,92,246", rec: "224,85,85", fav: "3,201,215",
  };
  const ALPHA = { 1: 0.30, 2: 0.55, 3: 0.85 };
  const cellAt = typeof o.cells === "function" ? o.cells : function (r, c) { return ((o.cells || [])[r] || [])[c] || null; };

  function cellEl(cell, r, c) {
    const c0 = cell || { t: "zero" };
    const e = hEl("div", "min-width:0;height:19px;border-radius:4px;display:flex;align-items:center;justify-content:center;overflow:hidden");
    e.style.background = "rgba(140,148,160,.10)";
    const tone = String(c0.t || "zero");
    e.setAttribute("data-tone", tone);
    if (RGB[tone]) {
      const a = ALPHA[c0.lvl] == null ? 0.55 : ALPHA[c0.lvl];
      e.style.background = "rgba(" + RGB[tone] + "," + a + ")";
    } else if (tone === "mute") {
      e.style.background = "rgba(140,148,160,.26)";
    } else if (tone === "zero") {
      e.style.background = "rgba(140,148,160,.10)";
    } else if (tone === "num") {
      e.style.background = "transparent";
      e.style.justifyContent = "flex-end";
      e.style.paddingRight = "4px";
      e.style.fontFamily = "var(--mono, monospace)";
      e.style.fontSize = "11px";
      e.style.color = c0.dim ? "var(--tx3,#8e8e93)" : "var(--tx1,#e9ebee)";
      const nt = hEl("span", "white-space:nowrap");
      nt.textContent = c0.v == null ? "" : String(c0.v);
      e.appendChild(nt);
    } else if (tone === "tag" || tone === "tagok" || tone === "tagwarn" || tone === "tagerr") {
      e.style.background = "transparent";
      const col = { tag: "var(--tx2,#9aa0a6)", tagok: "var(--success,#22a06b)", tagwarn: "var(--warning,#e0a800)", tagerr: "var(--error,#e05555)" }[tone];
      e.style.justifyContent = "flex-start";
      const pill = hEl("span", "font-size:10.5px;line-height:1.5;padding:1px 7px;border-radius:999px;border:1px solid currentColor;white-space:nowrap");
      pill.style.color = col;
      pill.textContent = c0.v == null ? "" : String(c0.v);
      e.appendChild(pill);
    }
    if (c0.v != null && tone !== "num" && tone !== "tag" && tone !== "tagok" && tone !== "tagwarn" && tone !== "tagerr") {
      const t = hEl("span", "font-size:10.5px;line-height:1;font-family:var(--mono,monospace);color:rgba(255,255,255,.92);text-shadow:0 1px 1px rgba(0,0,0,.25);white-space:nowrap");
      t.textContent = String(c0.v);
      e.appendChild(t);
    }
    if (c0.tip) {
      e.title = String(c0.tip);
      e.setAttribute("aria-label", String(c0.tip));
    }
    if (typeof o.onPick === "function") {
      e.style.cursor = "pointer";
      e.tabIndex = 0;
      e.setAttribute("role", "button");
      const fire = function () { o.onPick(r, c, c0); };
      e.addEventListener("click", fire);
      e.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fire(); } });
    }
    return e;
  }

  return mount(host, function () {
    const wrap = hEl("div", "display:grid;gap:6px;width:100%;min-width:0");
    wrap.setAttribute("data-hf", "matrix");
    const tpl = "grid-template-columns:" + labelW + "px repeat(" + cols.length + ",minmax(0,1fr));gap:" + gap + "px;align-items:center";

    const head = hEl("div", "display:grid;" + tpl);
    head.appendChild(hEl("span", "font-size:10px;color:var(--tx3,#8e8e93)"));
    cols.forEach(function (c, i) {
      const h = hEl("span", "font-size:10px;color:var(--tx3,#8e8e93);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis");
      h.textContent = c.label == null ? "" : String(c.label);
      if (c.tip) h.title = String(c.tip);
      if (i === 0) h.style.textAlign = "left";
      head.appendChild(h);
    });
    wrap.appendChild(head);

    rows.forEach(function (r, ri) {
      const line = hEl("div", "display:grid;" + tpl);
      const lab = hEl("div", "min-width:0;display:flex;align-items:baseline;gap:6px;padding-right:6px");
      const nm = hEl("span", "font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis");
      nm.textContent = r.label == null ? "" : String(r.label);
      if (r.tip) { nm.title = String(r.tip); lab.title = String(r.tip); }
      lab.appendChild(nm);
      if (r.sub) {
        const sb = hEl("span", "font-size:10px;color:var(--tx3,#8e8e93);white-space:nowrap");
        sb.textContent = String(r.sub);
        lab.appendChild(sb);
      }
      if (typeof o.onRow === "function") {
        lab.style.cursor = "pointer";
        lab.tabIndex = 0;
        lab.setAttribute("role", "button");
        const fire = function () { o.onRow(ri); };
        lab.addEventListener("click", fire);
        lab.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fire(); } });
      }
      line.appendChild(lab);
      for (let ci = 0; ci < cols.length; ci++) line.appendChild(cellEl(cellAt(ri, ci), ri, ci));
      wrap.appendChild(line);
    });

    const legend = Array.isArray(o.legend) ? o.legend.filter(Boolean) : [];
    if (legend.length) {
      const lg = hEl("div", "display:flex;flex-wrap:wrap;gap:6px 14px;font-size:10.5px;color:var(--tx3,#8e8e93);margin-top:5px;align-items:center");
      legend.forEach(function (it) {
        const row = hEl("span", "display:inline-flex;align-items:center;gap:5px;min-width:0");
        const sw = hEl("i", "display:inline-block;width:12px;height:10px;border-radius:3px;flex:0 0 auto");
        const tone = String(it[0] || "");
        if (RGB[tone]) sw.style.background = "rgba(" + RGB[tone] + ",.6)";
        else if (tone === "mute") sw.style.background = "rgba(140,148,160,.26)";
        else if (tone === "zero") sw.style.background = "rgba(140,148,160,.10)";
        else sw.style.background = tone;
        const tx = hEl("span", "min-width:0");
        tx.textContent = String(it[1] == null ? "" : it[1]);
        row.appendChild(sw);
        row.appendChild(tx);
        lg.appendChild(row);
      });
      wrap.appendChild(lg);
    }
    if (o.note) {
      const nt = hEl("div", "font-size:10.5px;color:var(--tx3,#8e8e93);line-height:1.7;margin-top:2px");
      nt.innerHTML = String(o.note);
      wrap.appendChild(nt);
    }
    return wrap;
  });
}

export function selfTest() {
  const names = [
    "sparkline", "barSplit", "barGauge", "radar", "bars", "waterfall", "heatstrip", "steer",
    "heatgrid", "stageBars", "area", "timeline", "miniNetwork", "sankey", "avatar", "legend",
  ];
  const rendered = [];
  const d = typeof document !== "undefined" ? document : null;
  if (!d) return { ok: false, error: "no document" };
  const root = d.body || d.documentElement;
  if (!root) return { ok: false, error: "no body" };
  const off = hEl("div", "position:absolute;left:-99999px;top:0;width:360px;height:auto;overflow:hidden");
  off.setAttribute("aria-hidden", "true");
  root.appendChild(off);
  try {
    const host = function () {
      const box = hEl("div", "width:340px");
      off.appendChild(box);
      return box;
    };
    const check = function (name, node) {
      if (node) rendered.push(name);
    };

    check("sparkline", sparkline(host(), { points: [3, 5, 4, 8, 6, 9, 7] }));
    check("barSplit", barSplit(host(), { items: [{ label: "事实", value: 6, color: "#4a90d9" }, { label: "经历", value: 3, color: "#00a3a3" }], height: 18 }));
    check("barGauge", barGauge(host(), { value: 0.62, label: "触发率", sub: "最近 7 天" }));
    check("radar", radar(host(), {
      axes: [{ label: "强度", max: 1 }, { label: "新近", max: 1 }, { label: "召回", max: 1 }, { label: "情感", max: 1 }, { label: "关联", max: 1 }, { label: "稳定", max: 1 }],
      series: [{ name: "A", color: "#3c96ca", values: [0.8, 0.5, 0.9, 0.4, 0.7, 0.6] }, { name: "B", values: [0.4, 0.9, 0.3, 0.8, 0.5, 0.2] }],
    }));
    check("bars", bars(host(), { items: [{ label: "记忆注入", value: 12 }, { label: "门控评估", value: 30 }, { label: "好感结算", value: 8 }] }));
    check("bars-v", bars(host(), { items: [{ label: "A", value: 3 }, { label: "B", value: 9 }], horizontal: false, height: 120 }));
    check("waterfall", waterfall(host(), {
      base: 60, threshold: 50,
      items: [{ label: "共鸣", value: 12 }, { label: "亲近", value: 8 }, { label: "冷场", value: -20 }, { label: "错过", value: -5 }],
    }));
    check("heatstrip", heatstrip(host(), { items: [{ label: "冷淡", value: 0 }, { label: "一般", value: 0.5 }, { label: "亲近", value: 1 }], height: 12 }));
    check("steer", steer(host(), { items: [{ label: "新鲜", value: 1, color: "#00c853" }, { label: "陈旧", value: 0, color: "#f44336" }] }));
    check("heatgrid", heatgrid(host(), {
      rows: ["周一", "周二", "周三"], cols: ["0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20", "22"],
      cells: [{ r: 0, c: 3, v: 2 }, { r: 1, c: 5, v: 7 }, { r: 2, c: 9, v: 4 }],
    }));
    check("stageBars", stageBars(host(), {
      stages: [
        { label: "评估过的消息", value: 220 },
        { label: "触发开口", value: 200, color: "#03c9d7" },
        { label: "保持沉默", value: 20, color: "#9aa4b2" },
      ],
    }));
    check("area", area(host(), {
      xLabels: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
      series: [{ name: "输入", color: "#3c96ca", points: [10, 22, 18, 30, 26, 12, 8] }, { name: "输出", color: "#03c9d7", points: [5, 9, 7, 14, 12, 6, 4] }],
    }));
    check("area-stacked", area(host(), {
      stacked: true,
      xLabels: ["A", "B", "C", "D"],
      series: [{ name: "s1", points: [3, 5, 2, 6] }, { name: "s2", points: [2, 1, 4, 3] }],
    }));
    check("timeline", timeline(host(), {
      items: [
        { ts: 1700000000, title: "开始学习表达", desc: "从群聊语料里提炼说话习惯", tag: "表达", color: "#3c96ca" },
        { ts: 1700100000, title: "好感升到 CLOSE", desc: "日好感 +18", tag: "好感", side: "left" },
      ],
    }));
    check("miniNetwork", miniNetwork(host(), {
      interactive: true,
      nodes: [
        { id: "gate", label: "门控", group: "core" }, { id: "mem", label: "记忆", group: "core" },
        { id: "llm", label: "对话模型", group: "model" }, { id: "emb", label: "嵌入", group: "model" },
        { id: "fav", label: "好感", group: "side" },
      ],
      links: [{ s: "gate", t: "llm", w: 3 }, { s: "mem", t: "llm", w: 2 }, { s: "mem", t: "emb", w: 2 }, { s: "gate", t: "fav", w: 1 }],
    }));
    check("sankey", sankey(host(), {
      nodes: [
        { id: "L1", label: "聊天触发", side: "left", color: "#3c96ca" },
        { id: "L2", label: "后台任务", side: "left", color: "#00a3a3" },
        { id: "R1", label: "对话模型", side: "right", color: "#8b5cf6" },
        { id: "R2", label: "嵌入模型", side: "right", color: "#f59e0b" },
      ],
      links: [{ s: "L1", t: "R1", value: 30 }, { s: "L2", t: "R1", value: 10 }, { s: "L2", t: "R2", value: 20 }],
    }));
    check("avatar", avatar(host(), { name: "林清", size: 40, ring: 0.7 }));
    check("avatar-bare", avatar(host(), { name: "zoe", size: 28 }));
    check("legend", legend(host(), {
      shape: "square",
      items: [{ label: "factual", color: "#4a90d9" }, { label: "episodic", color: "#00a3a3" }],
    }));

    // 空数据必须落到占位而不是留白/抛错（这里再跑一遍，专门验空态）
    const emptyCases = [
      ["sparkline", function (h) { return sparkline(h, { points: [] }); }],
      ["donut", function (h) { return donut(h, { items: [] }); }],
      ["donut-zero", function (h) { return donut(h, { items: [{ label: "x", value: 0 }] }); }],
      ["ring-null", function (h) { return ring(h, { value: null }); }],
      ["radar", function (h) { return radar(h, { axes: [], series: [] }); }],
      ["bars", function (h) { return bars(h, { items: [] }); }],
      ["waterfall", function (h) { return waterfall(h, { items: [] }); }],
      ["heatstrip", function (h) { return heatstrip(h, { items: [] }); }],
      ["heatgrid", function (h) { return heatgrid(h, { rows: [], cols: [] }); }],
      ["stageBars", function (h) { return stageBars(h, { stages: [] }); }],
      ["area", function (h) { return area(h, { series: [] }); }],
      ["timeline", function (h) { return timeline(h, { items: [] }); }],
      ["miniNetwork", function (h) { return miniNetwork(h, { nodes: [] }); }],
      ["sankey", function (h) { return sankey(h, { nodes: [] }); }],
      ["legend", function (h) { return legend(h, { items: [] }); }],
    ];
    for (let i = 0; i < emptyCases.length; i++) {
      check("空态:" + emptyCases[i][0], emptyCases[i][1](host()));
    }

    // 选不到容器必须 return null（不许抛错）
    check("null-host:sparkline", sparkline("#__hf_not_exist__", { points: [1, 2] }) === null ? "nullHostOk" : null);

    off.textContent = "";
    off.remove();
    return { ok: true, rendered: rendered, total: names.length };
  } catch (err) {
    try { off.remove(); } catch (e) { /* ignore */ }
    return { ok: false, error: String((err && err.message) || err) };
  }
}
