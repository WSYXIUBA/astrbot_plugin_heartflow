/**
 * StarHeart 面板 · 总览 / 表达学习 / 人格 / 设置
 *
 * 图形化取舍：
 * - 总览：模块之间是**依赖关系**（门控决定开口、记忆喂门控、好感调语气），用迷你网络图标出来比平铺卡片更能说明结构。
 * - 表达学习：本质是「情景 → 表达」的映射，用二分图（桑基）画。
 * - Token：按任务与模型聚合是后端给的真数据，不做按天趋势（后端没有这个口径，不编）。
 * - 设置：模块开关 + 危险区，模块卡带状态灯。
 */

import * as C from "./charts.js?v=1.0.0";
import {
  $, $$, api, apiSafe, apiPostSafe, esc, fmtNum, fmtPct, fmt1, fmtTime, timeAgo, toast, openDrawer, closeDrawer,
  confirmModal, formModal, pageHead, card, kpiCard, kpis, secTitle, mount, emptyBlock, skelBlock, jsStr, STATE, segmentHtml,
  syncSeg, bridge, EP, refreshCurrent, goPage, countUp,
} from "./store.js?v=1.0.0";
import { renderDomainConf, domainRowsHtml, CONFIG_META } from "./views-conf.js?v=1.0.0";
import { ATOM_LABEL } from "./views-memory.js?v=1.0.0";
import { GRAPH_PALETTE } from "./graph.js?v=1.0.0";

const ATOM_COLOR = GRAPH_PALETTE.memory;
const MODULES = [
  { key: "memory", label: "记忆", icon: "◍", col: "#3c96ca" },
  { key: "gate", label: "门控", icon: "◉", col: "#03c9d7" },
  { key: "expression", label: "表达", icon: "✎", col: "#8b5cf6" },
  { key: "favour", label: "好感", icon: "♥", col: "#e0559a" },
  { key: "proactive", label: "主动", icon: "☎", col: "#f59e0b" },
  { key: "persona", label: "人格", icon: "☺", col: "#3aa76d" },
];

/* ==================================================================
   总览
   ================================================================== */
export async function renderOverview() {
  const [ov, gate, gstats] = await Promise.all([
    api("overview"),
    apiSafe("gate", { limit: 40 }, { items: [], total: 0 }),
    apiSafe("graph/stats", {}, {}),
  ]);
  STATE.overview = ov;
  STATE.graphStats = gstats;
  const c = ov.config || {};
  const lm = ov.livingmemory || {};
  const gateItems = gate.items || [];
  const trigger = gateItems.filter((g) => g.decision === "reply").length;

  // apiSafe 失败回落时返回的对象带 __err/__path。原实现直接读字段 → 接口一挂就显示
  // 「平均度数 0.0 · 孤立 0」，和这一页页头承诺的「拿不到就写「—」，不编造」正好相反
  // —— 用户看到的像是「关系链真的断了」，其实是接口失败了。
  const _failed = (x) => !!(x && typeof x === "object" && x.__err);
  const gstatsErr = _failed(gstats) ? String(gstats.__err).slice(0, 70) : "";
  const gateErr = _failed(gate) ? String(gate.__err).slice(0, 70) : "";
  const chainSub = gstatsErr
    ? `⚠ 读取失败：${gstatsErr}（数字不可用，不当作 0）`
    : `平均度数 ${fmt1(gstats.avg_degree)} · 孤立 ${fmtNum(gstats.isolated || 0)}`;

  const health = [
    { n: "记忆系统", ok: c.master_switch !== false, d: `${fmtNum(ov.memories)} 条 · 平均强度 ${fmt1(ov.memory_avg_strength)}` },
    { n: "门控" + (c.gate_shadow ? "（影子）" : ""), ok: !!c.gate_enabled, d: c.gate_shadow ? "只记录不拦截" : "低于阈值会沉默" },
    { n: "关系链", ok: !gstatsErr && (gstats.avg_degree || 0) > 0.3, d: chainSub },
    { n: "表达学习", ok: !!c.output_enabled, d: `习惯 ${fmtNum(ov.habits)} 条` },
    { n: "主动消息", ok: !!c.proactive_enabled, d: c.proactive_enabled ? "已启用" : "未启用（默认关）" },
    { n: "LivingMemory", ok: !!lm.installed, d: lm.installed ? `可导入 ${fmtNum((lm.documents || 0) + (lm.atoms || 0))} 条 · 已导入 ${fmtNum(lm.imported)}` : "未检测到该插件" },
    { n: "好感结算", ok: !!c.favour_enabled, d: `跟踪 ${fmtNum(ov.favours)} 人` },
    // 门控流水读不到时也显式说出来，别让它静默变成「0 条流水」
    ...(gateErr ? [{ n: "门控流水", ok: false, d: `⚠ 读取失败：${gateErr}` }] : []),
  ];

  const html = `
  ${pageHead(
    "总览",
    "所有数字都来自插件自己的数据库（<span class='mono'>data/…/starheart.db</span>）",
    `<button class="btn s" onclick="hfRefreshOverview(this)">刷新</button>
     <button class="btn s" onclick="goPage('memory','graph')">看记忆图谱 →</button>`,
    "◉"
  )}
  <div class="grid g23 sec">
    ${card(`<div id="ovFlow"></div>`, {
      title: "它是怎么跑起来的",
      sub: "从左到右就是一条消息的旅程 · 数字是实时读数 · 悬停看上下游 · 点节点直接进那一页",
      actions: `<span class="mut" style="font-size:10.5px">光点=数据在往下一步走，越快说明量越大</span>`,
    })}
    ${card(
      `<div class="col" style="gap:7px">
        ${health
          .map(
            (h) => `<div class="row" style="gap:7px;align-items:flex-start">
          <span class="hlamp ${h.ok ? "g" : "y"}" style="margin-top:4px"></span>
          <div style="min-width:0">
            <b style="font-size:12px">${esc(h.n)}</b>
            <div class="mut" style="font-size:10.5px;line-height:1.5">${esc(h.d)}</div>
          </div></div>`
          )
          .join("")}
      </div>`,
      { title: "模块状态", sub: "按当前配置实时判定" }
    )}
  </div>
  <div class="grid g23 sec">
    ${card(`<div id="ovFunnel"></div>`, { title: "开口转化", sub: "评估 → 开口，逐层条形时不裁形状" })}
    ${card(`<div id="ovTypes"></div>`, { title: "记忆构成", sub: "按类型分布（当前查看视角）" })}
  </div>
  <div class="grid g23 sec">
    ${card(`<div id="ovFeed"></div>`, { title: "最近决策", sub: "倒序 · 点「决策流水」看完整因子分解", actions: `<button class="btn xs" onclick="goPage('messages','gate')">全部 →</button>` })}
    ${card(
      `<table><tbody>${
        (ov.recent_batches || [])
          .map(
            (b) =>
              `<tr><td>⬇ 记忆导入</td><td class="mut">${fmtTime(b.started_at)}</td>
               <td><span class="tag ${b.status === "done" ? "ok" : "info"}">+${fmtNum(b.imported)} / 跳过 ${fmtNum(b.skipped)} / 失败 ${fmtNum(b.failed)}</span></td></tr>`
          )
          .join("") || `<tr><td class="mut">还没有导入记录</td><td></td><td><span class="tag gy">空闲</span></td></tr>`
      }</tbody></table>`,
      { title: "后台任务", sub: "最近三次记忆导入" }
    )}
  </div>`;
  return {
    html,
    mount: (host) => {
      const byType = ov.memory_by_type || {};
      const on = (v) => (v ? "已开" : "未开");
      const flowNodes = [
        { id: "msg", stage: 0, label: "消息进来", icon: "✉", value: fmtNum(ov.gate_total), unit: "次评估", sub: "收到并被评估的消息", color: "#3c96ca", to: ["messages", "gate"] },
        { id: "gate", stage: 1, label: "门控决策", icon: "◐", value: fmtPct(ov.gate_rate, 1), unit: "开口率", sub: c.gate_shadow ? "影子模式：只记录不拦" : "低于阈值会沉默", color: "#03c9d7", to: ["messages", "gate"] },
        { id: "mem", stage: 2, label: "记忆库", icon: "◍", value: fmtNum(ov.memories), unit: "条", sub: `实体 ${fmtNum(ov.entities)} · 平均强度 ${fmt1(ov.memory_avg_strength)}`, color: "#4a90d9", to: ["memory", "graph"] },
        { id: "exp", stage: 2, label: "表达学习", icon: "✎", value: fmtNum(ov.habits), unit: "条习惯", sub: c.output_enabled ? "会按习惯说话" : "输出拟人化未开", color: "#8b5cf6", to: ["expression", "lib"] },
        { id: "link", stage: 3, label: "关系链", icon: "⬡", value: fmtNum(ov.edges), unit: "条边", sub: chainSub, color: "#00c853", to: ["memory", "graph"] },
        { id: "fav", stage: 3, label: "好感结算", icon: "♥", value: fmtNum(ov.favours), unit: "人", sub: "区间会变成语气描述", color: "#e0559a", to: ["messages", "favour"] },
        { id: "out", stage: 4, label: "回复输出", icon: "➤", value: on(c.output_enabled), unit: "", sub: "拟人化 / 分条 / 错别字", color: "#f59e0b", to: ["settings", "main"] },
        { id: "pro", stage: 4, label: "主动消息", icon: "☎", value: on(c.proactive_enabled), unit: "", sub: c.proactive_enabled ? "按护栏主动开口" : "默认关", color: "#9aa4b2", to: ["messages", "proactive"] },
      ];
      const flowLinks = [
        { from: "msg", to: "gate", value: ov.gate_total || 1 },
        { from: "gate", to: "mem", value: ov.memories || 1 },
        { from: "gate", to: "exp", value: ov.habits || 1 },
        { from: "gate", to: "fav", value: ov.favours || 1 },
        { from: "mem", to: "link", value: ov.edges || 1 },
        { from: "mem", to: "pro", value: ov.memories || 1 },
        { from: "fav", to: "pro", value: ov.favours || 1 },
        { from: "gate", to: "out", value: ov.gate_total || 1 },
      ];
      mount(host, "#ovFlow", (el) =>
        C.flowGraph(el, {
          nodes: flowNodes,
          links: flowLinks,
          height: 300,
          onPick: (n) => {
            if (Array.isArray(n.to)) goPage(n.to[0], n.to[1]);
          },
        })
      );
      mount(host, "#ovFunnel", (el) =>
        C.stageBars(el, {
          stages: [
            { label: "评估过的消息", value: ov.gate_total || 0, color: "#3c96ca" },
            { label: "触发开口", value: ov.gate_reply || 0, color: "#03c9d7" },
          ],
          valueFmt: (v) => fmtNum(v),
          emptyText: "还没有门控评估记录",
        })
      );
      mount(host, "#ovTypes", (el) =>
        C.barSplit(el, {
          items: Object.keys(byType).map((k) => ({ label: ATOM_LABEL[k] || k, value: byType[k], color: ATOM_COLOR[k] })),
          height: 18,
        })
      );
      mount(host, "#ovFeed", (el) =>
        C.timeline(el, {
          items: gateItems.slice(0, 8).map((g) => ({
            ts: g.ts,
            title: `${g.decision === "reply" ? "开口" : g.decision === "backoff" ? "退避" : "沉默"} · 分数 ${fmt1(g.score)} / 阈值 ${fmt1(g.threshold)}`,
            desc: `${(g.session_id || "未知会话").slice(0, 26)} · ${Object.keys(g.factors || {}).join(" / ") || "无因子"}`,
            color: g.decision === "reply" ? "#00c853" : "#9aa4b2",
          })),
          timeFmt: (ts) => fmtTime(ts),
        })
      );
      // 触发率与记忆数用滚动动画，让「刷新」有可见反馈
      countUp(host.querySelector("#ovGate"), ov.gate_total || 0);
    },
  };
}

export async function hfRefreshOverview(btn) {
  if (btn) btn.classList.add("loading");
  refreshCurrent();
  setTimeout(() => btn && btn.classList.remove("loading"), 400);
  toast("已刷新");
}

/* ==================================================================
   表达学习
   ================================================================== */
let HB_FILTER = { q: "", kind: "all", on: "all", sort: "uses" };
let HB_EDIT = 0;     // 正在就地编辑哪一条（0 = 没有）

export async function renderExpressionLib() {
  const [res, log, dom] = await Promise.all([
    apiSafe("habits", {}, { items: [] }),
    apiSafe("habits/log", {}, { items: [], events: [], corpus: {} }),
    apiSafe("config/domains", {}, { domains: {}, values: {} }),
  ]);
  const items = res.items || [];
  STATE.habits = items;
  const corpus = log.corpus || {};
  const events = log.events || [];
  const values = dom.values || {};
  const maxUses = Math.max(1, ...items.map((h) => h.uses || 0));

  /** 学来的（推断）还是我手加的（声明）—— 必须分开标注 */
  const kindOf = (h) => (/^学习/.test(String(h.scope || "")) ? "learned" : "manual");
  const lastUsed = (h) => Number(h.updated_at || 0);

  const shown = items
    .filter((h) => (HB_FILTER.kind === "all" ? true : kindOf(h) === HB_FILTER.kind))
    .filter((h) => (HB_FILTER.on === "all" ? true : HB_FILTER.on === "on" ? !!h.enabled : !h.enabled))
    .filter((h) => {
      const q = HB_FILTER.q.trim();
      if (!q) return true;
      return (String(h.scene) + String(h.way) + (h.cues || []).join(" ")).includes(q);
    })
    .sort((a, b) => (HB_FILTER.sort === "recent" ? lastUsed(b) - lastUsed(a) : (b.uses || 0) - (a.uses || 0)));

  const chip = (label, active, onclick) => `<button class="hchip${active ? " on" : ""}" onclick="${onclick}">${esc(label)}</button>`;

  const html = `
  ${pageHead(
    "表达学习",
    "机器人从群友/好友的原话里学到的「什么时候说 → 具体怎么说」。每一条都能核对出处、就地改、单独停用或删除",
    `<button class="btn p" onclick="hfExtractHabits(this)">立即学一批</button>
     <button class="btn" onclick="hfHabitAdd()">+ 手加一条</button>`,
    "✎"
  )}
  ${kpis(
    kpiCard("hbAll", fmtNum(items.length), "表达条目")
    + kpiCard("hbOn", fmtNum(items.filter((h) => h.enabled).length), "启用中")
    + kpiCard("hbUses", fmtNum(items.reduce((s, h) => s + (h.uses || 0), 0)), "累计使用")
    + kpiCard("hbPeer", fmtNum(corpus.peer), "可学素材", `<span class="mut">群友/好友原话</span>`)
  )}
  <div class="card sec" style="padding:10px 13px">
    <div class="row bt wrap" style="gap:10px">
      <div class="row wrap" style="gap:6px">
        ${chip("全部", HB_FILTER.kind === "all", "hfHbFilter('kind','all')")}
        ${chip("学来的", HB_FILTER.kind === "learned", "hfHbFilter('kind','learned')")}
        ${chip("我手加", HB_FILTER.kind === "manual", "hfHbFilter('kind','manual')")}
        <span class="mut" style="margin:0 4px">·</span>
        ${chip("不限状态", HB_FILTER.on === "all", "hfHbFilter('on','all')")}
        ${chip("只看启用", HB_FILTER.on === "on", "hfHbFilter('on','on')")}
        ${chip("只看停用", HB_FILTER.on === "off", "hfHbFilter('on','off')")}
        <span class="mut" style="margin:0 4px">·</span>
        ${chip("按使用", HB_FILTER.sort === "uses", "hfHbFilter('sort','uses')")}
        ${chip("按最近", HB_FILTER.sort === "recent", "hfHbFilter('sort','recent')")}
      </div>
      <span class="searchbox" style="width:200px"><i class="ic">⌕</i><input id="hbQ2" placeholder="搜场景 / 说法 / 原话…" value="${esc(HB_FILTER.q)}" oninput="hfHbFilter('q', this.value)"></span>
    </div>
    <div class="mut" style="font-size:11px;margin-top:7px">
      共 ${fmtNum(shown.length)} 条 · 条子的色条长度 = 用过多少次（越常用越长）· 排序里「按最近」= 最近更新优先
      ${items.filter((h) => !(h.cues || []).length).length ? ` · <b>${items.filter((h) => !(h.cues || []).length).length} 条还没记出处</b>（旧数据；点「立即学一批」重新学就有了）` : ""}
    </div>
  </div>
  <div class="hbgrid sec">
    ${
      shown.length
        ? shown
            .map((h) => {
              const cues = Array.isArray(h.cues) ? h.cues : [];
              const learned = kindOf(h) === "learned";
              const heat = Math.max(6, Math.round(((h.uses || 0) / maxUses) * 100));
              const editing = HB_EDIT === h.id;
              return `<div class="hbcard${h.enabled ? "" : " off"}" data-hb="${esc(String(h.scene + h.way + cues.join(" ")))}">
        <div class="hbheat" style="width:${heat}%"></div>
        <div class="row bt" style="gap:8px;position:relative">
          <div class="row" style="gap:6px;flex-wrap:wrap;min-width:0">
            <span class="tag info">${esc(h.scene)}</span>
            <span class="tag ${learned ? "gy" : "ok"}" title="${learned ? "模型从原话里推断出来的" : "你手动加进去的声明式习惯"}">${learned ? "学来的" : "我手加"}</span>
            <span class="chip">用到 ${fmtNum(h.uses)} 次</span>
            <span class="chip">权重 ${fmt1(h.weight)}</span>
            ${h.enabled ? "" : '<span class="tag dg">已停用</span>'}
          </div>
          <div class="row" style="gap:5px;flex-shrink:0">
            <label class="sw" title="${h.enabled ? "停用（保留条目，只是不再参考）" : "启用"}"><input type="checkbox" ${h.enabled ? "checked" : ""} onchange="hfHabitToggle(${h.id}, this)"><span class="tk"></span><span class="kb"></span></label>
            <button class="btn xs" onclick="hfHabitEdit(${h.id})">${editing ? "取消" : "改"}</button>
            <button class="btn xs dg" onclick="hfHabitDelete(${h.id})">删</button>
          </div>
        </div>
        ${
          editing
            ? `<div class="hbedit">
                 <input class="ipt" id="hbScene_${h.id}" value="${esc(h.scene)}" placeholder="什么时候用（社交情境）">
                 <input class="ipt" id="hbWay_${h.id}" value="${esc(h.way)}" placeholder="具体怎么说">
                 <div class="row" style="gap:6px;margin-top:6px"><button class="btn xs p" onclick="hfHabitSaveEdit(${h.id})">保存</button>
                   <span class="mut" style="font-size:10.5px">保存后下一轮对话就用新说法（立即生效）</span></div>
               </div>`
            : `<div class="hway">"${esc(String(h.way))}"</div>`
        }
        <div class="row" style="gap:7px;margin-top:6px;flex-wrap:wrap;align-items:center">
          ${cues.length
            ? `<button class="btn xs" onclick="hfHabitCues(this, ${h.id})">出处（${cues.length}）</button>`
            : `<span class="chip gy" title="这条是旧数据，提取时没记录来源">没记出处</span>`}
          <span class="mut" style="font-size:10.5px">最近更新 ${fmtTime(h.updated_at)}</span>
        </div>
        <div class="hcues" id="hcues_${h.id}" style="display:none">
          <div class="mut" style="font-size:10.5px;margin:7px 0 4px">学自这些原话（真数据，可核对）</div>
          ${cues.map((c) => `<div class="cq">「${esc(String(c))}」</div>`).join("")}
        </div>
      </div>`;
            })
            .join("")
        : emptyBlock(
            items.length
              ? "当前筛选下没有条目 —— 换个筛选条件试试"
              : "还没有学到表达：点右上角「立即学一批」，或先让机器人多和人聊聊（也可以「+ 手加一条」）",
            "✎"
          )
    }
  </div>
  ${foldCard("foldLog", "学习轨迹", `${events.length} 次提取 / 审核事件 · 简洁↔详细可切`, renderLogSection(events, items), HF_LOG_MODE === "full")}
  ${foldCard("foldData", "语料与进度", `可学素材 ${fmtNum(corpus.peer)} 条 · 机器人自身 ${fmtNum(corpus.bot)} 条（自身发言不算素材）`, renderCorpusSection(corpus), false)}
  ${foldCard("foldConf", "学习开关与参数", `${values.expression_enabled ? "表达学习：开" : "表达学习：关"}`, `
    <div class="grid g2" style="gap:9px">
      <div class="prow"><div><div class="pn">表达学习总开关</div>
        <div class="pd">关掉＝不再学、也不再参考已有条目；<b>已学到的条目会原样保留</b>（暂停 ≠ 清空）</div></div>
        <div class="pc"><label class="sw"><input type="checkbox" data-lp="expression_enabled" ${values.expression_enabled ? "checked" : ""} onchange="hfLearnParamSave()"><span class="tk"></span><span class="kb"></span></label></div></div>
      <div class="prow"><div><div class="pn">模型分配</div><div class="pd">提取只走「表达提取」一个模型，没有二次审校</div></div>
        <div class="pc"><button class="btn xs" onclick="goPage('settings','models')">去设置</button></div></div>
    </div>`, false)}`;
  return {
    html,
    mount: (host) => {
      const q = host.querySelector("#hbQ2");
      if (!q) return;
      // 同记忆库搜索框：每次重渲染都是新 input，组字监听在这里重绑。
      // refreshCurrent() 会把整页 DOM 换掉，组字期间触发 = 候选框消失、中文打不出来。
      _hbQcomposing = false;            // 新元素不可能还在组字：上一轮万一没收尾，旗标必须归零
      q.addEventListener("compositionstart", () => {
        _hbQcomposing = true;
        if (_hbQtimer) { clearTimeout(_hbQtimer); _hbQtimer = null; }
      });
      q.addEventListener("compositionend", () => {
        _hbQcomposing = false;
        _hbQcaret = q.selectionStart;
        _hbQSchedule();
      });
      q.addEventListener("blur", () => { _hbQcomposing = false; });     // 兜底，别让旗标卡住
      if (!HB_FILTER.q) return;
      q.focus();
      try {
        const pos = _hbQcaret == null ? q.value.length : Math.min(_hbQcaret, q.value.length);
        q.setSelectionRange(pos, pos);
      } catch (err) { /* 光标定位失败无所谓 */ }
      _hbQcaret = null;
    },
  };
}

/** 折叠卡（默认收起，标题右侧一个按钮） */
function foldCard(id, title, sub, inner, open) {
  return `<div class="card sec" style="padding:0">
    <div class="row bt" style="gap:8px;padding:11px 13px">
      <div style="min-width:0"><div class="pn">${esc(title)}</div><div class="pd">${sub}</div></div>
      <button class="btn xs" onclick="hfFold(this, '${id}')">${open ? "收起" : "展开"}</button>
    </div>
    <div id="${id}" style="display:${open ? "block" : "none"};padding:0 13px 13px">${inner}</div>
  </div>`;
}

function renderLogSection(events, items) {
  const full = HF_LOG_MODE === "full";
  const rows = events.length
    ? events
        .map((e) => {
          const act = String(e.action || "");
          const kind = act.includes("extract") ? "提取" : act.includes("delete") ? "删除" : act.includes("save") ? "修改" : act.replace(/^habit[._]?/, "") || "事件";
          const cls = act.includes("delete") ? "dg" : act.includes("extract") ? "info" : "gy";
          return `<div class="card cp" style="padding:9px 12px">
        <div class="row bt" style="gap:9px">
          <div class="row" style="gap:8px;min-width:0">
            <span class="tag ${cls}">${esc(kind)}</span>
            <span class="mut mono" style="font-size:11px">${fmtTime(e.ts)}</span>
            <span class="mut" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(e.target || "").slice(0, 60))}</span>
          </div>
          ${full ? `<button class="btn xs" onclick="hfLogToggle(${e.id})">展开</button>` : ""}
        </div>
        ${full
          ? `<div id="logd_${e.id}" style="display:none;margin-top:8px">
               <div class="mut" style="font-size:10.5px;margin-bottom:4px">完整记录（审计原文）</div>
               <div class="chip" style="white-space:pre-wrap;line-height:1.7;width:100%;max-height:240px;overflow:auto">${esc(String(e.detail || "—"))}</div>
             </div>`
          : `<div class="mut" style="font-size:11px;margin-top:4px">${esc(String(e.detail || "").slice(0, 90) || "—")}</div>`}
      </div>`;
        })
        .join("")
    : emptyBlock("还没有学习记录 —— 点右上角「立即学一批」跑一次就有了", "☰");
  return `<div class="row bt" style="gap:8px;margin-bottom:8px">
      <div class="mut" style="font-size:11px">${full ? "详细：每批都能展开看模型完整输出" : "简洁：只看每一批发生了什么"}</div>
      <button class="btn xs" onclick="hfLogMode('${full ? "brief" : "full"}')">${full ? "切到简洁" : "切到详细"}</button>
    </div>${rows}`;
}

function renderCorpusSection(corpus) {
  return `<div class="grid g3" style="gap:9px">
      <div class="kpi-mini"><div class="v">${fmtNum(corpus.peer)}</div><div class="l">可学素材（群友/好友原话）</div></div>
      <div class="kpi-mini"><div class="v">${fmtNum(corpus.bot)}</div><div class="l">机器人自己的发言（不计入素材）</div></div>
      <div class="kpi-mini"><div class="v">${fmtNum(corpus.unknown)}</div><div class="l">未判定来源</div></div>
    </div>
    <div class="mut" style="font-size:11px;margin-top:8px">学习链路：抓原话 → 让「表达提取」模型观察说话套路 → 去重后进上面的列表（全程只有这一次模型调用，没有二次审校）。只从别人的原话里学，不从机器人自己身上学。</div>`;
}

/** 筛选 / 排序（就地重渲染，不跳页） */
/** 搜索框重渲染后要恢复的光标位置（null = 没记录，落到末尾） */
let _hbQcaret = null;
let _hbQtimer = null;
/** 输入法正在组字（拼音还没上屏）。组字期间不排去抖，否则重渲染会把输入框换掉。 */
let _hbQcomposing = false;

/** 排一次「去抖 → 重查」。组字中直接跳过，等 compositionend 再排。 */
function _hbQSchedule() {
  if (_hbQtimer) clearTimeout(_hbQtimer);
  if (_hbQcomposing) { _hbQtimer = null; return; }
  _hbQtimer = setTimeout(() => {
    _hbQtimer = null;
    // 上屏与 input 事件的先后各浏览器不一致，落地前拿输入框现值兜一次
    const live = document.getElementById("hbQ2");
    if (live && String(live.value) !== HB_FILTER.q) HB_FILTER.q = String(live.value);
    refreshCurrent();
  }, 300);
}

export function hfHbFilter(key, value) {
  if (key === "q") HB_FILTER.q = String(value || "");
  else HB_FILTER[key] = value;
  if (key !== "q") {
    refreshCurrent();
    return;
  }
  // 同记忆库：搜索框去抖 300ms + 记住光标，别每敲一键就重渲染整页；
  // 中文/日文输入法组字期间连着触发的 input 一律不排去抖（见 _hbQSchedule），
  // 否则组字中途重渲染会把输入框和候选框一起换掉，字打不出来。
  const el = document.getElementById("hbQ2");
  _hbQcaret = el ? el.selectionStart : null;
  _hbQSchedule();
}

/** 折叠区开合 */
export function hfFold(btn, id) {
  const box = document.getElementById(id);
  if (!box) return;
  const open = box.style.display !== "none";
  box.style.display = open ? "none" : "block";
  if (btn) btn.textContent = open ? "展开" : "收起";
}

/** 就地编辑：点「改」进入输入态 */
export function hfHabitEdit(id) {
  HB_EDIT = HB_EDIT === id ? 0 : id;
  refreshCurrent();
}

/** 保存就地编辑（立即生效：下一轮对话就用新说法） */
export async function hfHabitSaveEdit(id) {
  const h = (STATE.habits || []).find((x) => x.id === id);
  if (!h) return;
  const sc = document.getElementById("hbScene_" + id);
  const wy = document.getElementById("hbWay_" + id);
  const scene = String((sc && sc.value) || "").trim();
  const way = String((wy && wy.value) || "").trim();
  if (!scene || !way) {
    toast("场景和说法都要填", "err");
    return;
  }
  const res = await apiPostSafe("habit/save", { ...h, scene, way });
  toast(res.ok ? "已保存，下一轮对话就用新说法" : "保存失败：" + (res.error || ""), res.ok ? "ok" : "err");
  if (res.ok) HB_EDIT = 0;
  refreshCurrent();
}

/** 手加一条（声明式：不会被当成模型推断的）；sandbox iframe 吞原生 prompt，走页面内弹窗 */
export function hfHabitAdd() {
  formModal("手加一条表达", [
    { key: "scene", label: "什么时候用？（社交情境，比如「被夸时」）", ph: "被夸时" },
    { key: "way", label: "具体怎么说？（越具体越好，可以带口头禅）", ph: "嘿嘿，谢谢夸奖～", area: true },
  ], async (v) => {
    const scene = String(v.scene || "").trim();
    const way = String(v.way || "").trim();
    if (!scene || !way) {
      toast("场景和说法都要填", "err");
      return false;
    }
    const res = await apiPostSafe("habit/save", {
      scene: scene.slice(0, 40),
      way: way.slice(0, 120),
      cues: [],
      weight: 0.5,
      scope: "手加",
      enabled: 1,
    });
    toast(res.ok ? "已加入（标为「我手加」）" : "保存失败：" + (res.error || ""), res.ok ? "ok" : "err");
    if (res.ok) refreshCurrent();
    return res.ok;   // 失败时保持弹窗开着，改完可重试
  });
}

/** 学习开关（暂停 ≠ 清空，文案里说清楚）；就地更新副标题，不整页重渲染 */
export async function hfLearnParamSave() {
  const patch = {};
  document.querySelectorAll("[data-lp]").forEach((el) => {
    patch[el.getAttribute("data-lp")] = el.type === "checkbox" ? !!el.checked : el.value;
  });
  const res = await apiPostSafe("config/save", { patch });
  toast(res.ok ? "已保存" : "保存失败：" + (res.error || ""), res.ok ? "ok" : "err");
  if (!res.ok) {
    refreshCurrent();   // 失败时把开关拉回真实状态
    return;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "expression_enabled")) {
    const body = document.getElementById("foldConf");
    const pd = body && body.closest(".card") ? body.closest(".card").querySelector(".row.bt .pd") : null;
    if (pd) pd.textContent = patch.expression_enabled ? "表达学习：开" : "表达学习：关";
  }
}

/** 展开/收起"这条习惯学自哪些原话" */
export function hfHabitCues(btn, id) {
  const box = document.getElementById("hcues_" + id);
  if (!box) return;
  const open = box.style.display !== "none";
  box.style.display = open ? "none" : "block";
  if (btn) {
    const n = (btn.textContent.match(/[0-9]+/) || [""])[0];
    btn.textContent = (open ? "来源（" : "收起来源（") + n + "）";
  }
}

/** 折叠辅助图表 */
export function hfChartToggle(btn, id) {
  const box = document.getElementById(id);
  if (!box) return;
  const open = box.style.display !== "none";
  box.style.display = open ? "none" : "block";
  if (btn) btn.textContent = open ? "图表" : "收起图表";
}

export function hfHabitFilter(v) {
  const q = String(v || "").trim();
  $$("#hbList .card").forEach((c) => {
    const key = c.getAttribute("data-habit") || "";
    c.style.display = !q || key.includes(q) ? "" : "none";
  });
}

export async function hfHabitToggle(id, el) {
  const h = (STATE.habits || []).find((x) => x.id === id);
  if (!h) return;
  const next = h.enabled ? 0 : 1;
  const res = await apiPostSafe("habit/save", { ...h, enabled: next });
  if (!res.ok) {
    if (el) el.checked = !!h.enabled;   // 失败：开关翻回原状
    toast("保存失败：" + (res.error || ""), "err");
    return;
  }
  h.enabled = next;
  // 就地更新这一张卡：不整页重渲染——卡片位置、滚动位置、其它卡片都不动，
  // 列表重排（按使用 / 按最近 / 只看启用…）留给用户自己刷新或切页时再发生。
  const card = (el && el.closest && el.closest(".hbcard")) || $$(".hbcard").find((c) => c.querySelector('input[onchange*="hfHabitToggle(' + id + '"]'));
  if (card) {
    card.classList.toggle("off", !next);
    const tagsRow = card.querySelector(".row.bt .row");
    const tag = card.querySelector(".tag.dg");
    if (!next && !tag && tagsRow) {
      const t = document.createElement("span");
      t.className = "tag dg pop";
      t.textContent = "已停用";
      tagsRow.appendChild(t);
    } else if (next && tag) {
      tag.remove();
    }
    const sw = card.querySelector("label.sw");
    if (sw) sw.title = next ? "停用（保留条目，只是不再参考）" : "启用";
  }
  const kEl = document.getElementById("hbOn");
  if (kEl) kEl.textContent = fmtNum((STATE.habits || []).filter((x) => x.enabled).length);
  toast(next ? "已启用" : "已停用", "ok");
}

export async function hfHabitDelete(id) {
  confirmModal("删除这条习惯", "删掉后模型不会再参考它。", async () => {
    const res = await apiPostSafe("habit/delete", { id });
    toast(res.ok ? "已删除" : "删除失败：" + res.error, res.ok ? "ok" : "err");
    refreshCurrent();
  });
}

export async function hfExtractHabits(btn) {
  if (btn) {
    btn.classList.add("loading");
    btn.disabled = true;
  }
  const res = await apiPostSafe("expression/extract", {});
  if (btn) {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
  const d = res.data || {};
  toast(res.ok && d.ok !== false ? `提取完成：新增 ${d.saved || 0} 条（看了 ${d.scanned || 0} 条语料）` : "提取失败：" + (d.error || res.error || ""), res.ok && d.ok !== false ? "ok" : "err");
  refreshCurrent();
}

/** 学习日志：简洁（只看发生了什么）/ 详细（每条都能展开看全貌） */
let HF_LOG_MODE = "brief";

export async function renderExpressionLog() {
  const log = await apiSafe("habits/log", {}, { items: [], events: [], corpus: {} });
  const corpus = log.corpus || {};
  const events = log.events || [];
  const items = log.items || [];
  const brief = HF_LOG_MODE !== "full";
  const html = `
  ${pageHead(
    "学习日志",
    brief
      ? "简洁：只看每一批学了什么。要核对细节就切「详细」（每条都能展开看全貌）"
      : "详细：每批的完整轨迹 —— 看了哪些原话、抽出哪些条目、模型花了多少 token",
    `<button class="btn ${brief ? "" : "p"}" onclick="hfLogMode('${brief ? "full" : "brief"}')">${brief ? "切到详细" : "切到简洁"}</button>
     <button class="btn p" onclick="hfExtractHabits(this)">立即提取一批</button>`,
    "☰"
  )}
  ${kpis(
    kpiCard("hlEvt", fmtNum(events.length), "学习事件")
    + kpiCard("hlAll", fmtNum(items.length), "习惯条目")
    + kpiCard("hlPeer", fmtNum(corpus.peer), "群友语料", `<span class="mut">可学素材</span>`)
    + kpiCard("hlBot", fmtNum(corpus.bot), "机器人语料", `<span class="mut">自身发言</span>`)
  )}
  <div class="sec-t">学习轨迹（${events.length}）</div>
  <div class="col">
    ${
      events.length
        ? events
            .map((e) => {
              const act = String(e.action || "");
              const kind = act.includes("extract") ? "提取" : act.includes("delete") ? "删除" : act.includes("save") ? "修改" : act.replace(/^habit[._]?/, "") || "事件";
              const cls = act.includes("delete") ? "dg" : act.includes("extract") ? "info" : "gy";
              return `<div class="card cp" style="padding:9px 12px">
        <div class="row bt" style="gap:9px">
          <div class="row" style="gap:8px;min-width:0">
            <span class="tag ${cls}">${esc(kind)}</span>
            <span class="mut mono" style="font-size:11px">${fmtTime(e.ts)}</span>
            <span class="mut" style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(e.target || "").slice(0, 60))}</span>
          </div>
          ${brief ? "" : `<button class="btn xs" onclick="hfLogToggle(${e.id})">展开</button>`}
        </div>
        ${
          brief
            ? `<div class="mut" style="font-size:11px;margin-top:4px">${esc(String(e.detail || "").slice(0, 90) || "—")}</div>`
            : `<div id="logd_${e.id}" style="display:none;margin-top:8px">
                 <div class="mut" style="font-size:10.5px;margin-bottom:4px">完整记录（审计原文）</div>
                 <div class="chip" style="white-space:pre-wrap;line-height:1.7;width:100%;max-height:240px;overflow:auto">${esc(String(e.detail || "—"))}</div>
                 <div class="mut" style="font-size:10.5px;margin:7px 0 4px">当前已入库的习惯（${items.length} 条，按用量）</div>
                 ${items.slice().sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 6).map((h) => `<div class="cq">「${esc(String(h.way))}」<span class="mut"> — ${esc(h.scene)} · 用到 ${fmtNum(h.uses)} 次</span></div>`).join("") || '<div class="mut">还没有条目</div>'}
               </div>`
        }
      </div>`;
            })
            .join("")
        : emptyBlock("还没有学习记录 —— 点右上角「立即提取一批」跑一次就有了", "☰")
    }
  </div>
  ${card(
    `<div class="row bt" style="gap:8px">
       <div><div class="pn">语料构成</div><div class="pd">表达学习只从「群友/好友」的语料里学；机器人自己的发言不算素材</div></div>
       <button class="btn xs" onclick="hfChartToggle(this, 'hlCharts')">图表</button>
     </div>
     <div id="hlCharts" style="display:none;margin-top:9px">
       <div class="grid g2" style="gap:9px"><div id="hlCorpus"></div><div id="hlByPersona"></div></div>
     </div>`,
    { title: "辅助图表（默认收起）", cls: "sec" }
  )}`;
  return {
    html,
    mount: (host) => {
      mount(host, "#hlCorpus", (el) =>
        C.barSplit(el, {
          items: [
            { label: "群友 / 好友", value: corpus.peer || 0, color: "#3aa76d" },
            { label: "机器人自己", value: corpus.bot || 0, color: "#8b5cf6" },
            { label: "未判定", value: corpus.unknown || 0, color: "#94a3b8" },
          ].filter((x) => x.value),
        })
      );
      mount(host, "#hlByPersona", (el) =>
        C.bars(el, {
          items: Object.keys(corpus.by_persona || {}).map((k) => ({ label: k || "（未指定）", value: corpus.by_persona[k], color: "#3c96ca" })),
        })
      );
    },
  };
}

/** 简洁 / 详细 切换（记住选择，刷新后不丢） */
export function hfLogMode(mode) {
  HF_LOG_MODE = mode === "full" ? "full" : "brief";
  refreshCurrent();
}

/** 详细模式下展开某条事件 */
export function hfLogToggle(id) {
  const box = document.getElementById("logd_" + id);
  if (!box) return;
  box.style.display = box.style.display === "none" ? "block" : "none";
}

export async function renderExpressionConf() {
  return renderDomainConf("expression", {
    side: card(
      `<div class="mut" style="font-size:11.5px;line-height:1.8">
        提取流程：取语料 → 让「表达提取」模型写出「情景 | 表达方式」→ 去重后入库（只有这一次模型调用）。<br>
        模型在「设置 → 模型分配 → 表达提取」里指定。</div>
       <div class="row" style="gap:6px;margin-top:10px">
         <button class="btn s" onclick="goPage('settings','models')">去配模型</button>
         <button class="btn s" onclick="goPage('expression','lib')">去习惯库</button>
       </div>`,
      { title: "学习链路" }
    ),
  });
}

/* ==================================================================
   人格
   ================================================================== */
export async function renderPersonaList() {
  const p = await apiSafe("personas", {}, { available: false, items: [], active: "", counts: {} });
  STATE.personas = p;
  const items = p.items || [];
  const counts = p.counts || {};
  const html = `
  ${pageHead(
    "人格列表",
    "读的是 AstrBot 原生人格库（<span class='mono'>/personas</span>），改这里就是改原生人格 · 绿色徽标=当前正在用",
    `<button class="btn s" onclick="renderPersonaRefresh()">刷新</button>`,
    "☺"
  )}
  <div class="grid gauto sec">
    ${
      items.length
        ? items
            .map((x) => {
              const isActive = String(x.persona_id) === String(p.active);
              const memCount = counts[x.persona_id] || counts[""] || 0;
              return `<div class="card cp hov" style="${isActive ? "border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-soft)" : ""}">
          <div class="row" style="gap:11px;margin-bottom:9px">
            <div id="psAv_${esc(x.persona_id)}" style="flex-shrink:0"></div>
            <div style="min-width:0">
              <div style="font-weight:650;font-size:13.5px;display:flex;align-items:center;gap:6px">
                ${esc(x.persona_id)} ${isActive ? `<span class="tag ok">当前</span>` : ""}</div>
              <div class="mut" style="font-size:10.5px">system_prompt ${fmtNum(x.prompt_len)} 字 · 开场白 ${(x.begin_dialogs || []).length} 条</div>
            </div>
          </div>
          <div class="mut" style="font-size:11.5px;line-height:1.6;max-height:56px;overflow:hidden">${esc(String(x.system_prompt || "").slice(0, 160))}…</div>
          <div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">
            <button class="btn s ${isActive ? "" : "p"}" onclick="hfPersonaActive(${jsStr(x.persona_id)})" ${isActive ? "disabled" : ""}>设为当前</button>
            <button class="btn s" onclick="hfPersonaEdit(${jsStr(x.persona_id)})">编辑</button>
            <span class="spacer"></span>
            <span class="chip" title="这条人格下的记忆数">记忆 ${fmtNum(memCount)}</span>
          </div>
        </div>`;
            })
            .join("")
        : emptyBlock(p.available === false ? "读不到 AstrBot 人格库（可能是版本差异），可以只用原生人格" : "还没有人格，先去 AstrBot 里建一个", "☺")
    }
  </div>
  <div class="grid g2 sec">
    ${card(
      `<div class="mut" style="font-size:11.5px;line-height:1.8">
        人格只有一套：AstrBot 原生人格。<br>
        记忆按人格隔离：切换人格后，记忆库与图谱只显示当前人格的数据（顶栏可临时切换查看视角）。</div>
       <div class="row" style="gap:6px;margin-top:10px"><button class="btn s" onclick="goPage('persona','state')">人格状态与进化 →</button></div>`,
      { title: "人格与记忆" }
    )}
    ${card(`<div id="psDist"></div>`, { title: "记忆的人格分布", sub: "各人格下沉淀了多少条记忆（空人格=未归属）" })}
  </div>`;
  return {
    html,
    mount: (host) => {
      items.forEach((x) =>
        C.avatar(host.querySelector(`#psAv_${CSS.escape(String(x.persona_id))}`), {
          name: x.persona_id,
          size: 44,
          color: "#3aa76d",
        })
      );
      mount(host, "#psDist", (el) =>
        C.bars(el, {
          items: Object.keys(counts).map((k) => ({ label: k || "（未归属）", value: counts[k], color: "#3aa76d" })),
        })
      );
    },
  };
}

export function renderPersonaRefresh() {
  refreshCurrent();
}

export async function hfPersonaActive(pid) {
  const res = await apiPostSafe("persona/active", { persona_id: pid });
  const d = res.data || {};
  if (res.ok && d.applied !== false) {
    STATE.personaViewTouched = false;
    toast(`已切到 ${pid}`, "ok");
  } else {
    toast("切换失败：" + (d.error || res.error || "原因未知"), "err");
  }
  refreshCurrent();
  refreshPersonaSwitch();
}

export async function hfPersonaEdit(pid) {
  const x = ((STATE.personas || {}).items || []).find((y) => String(y.persona_id) === String(pid));
  if (!x) return;
  openDrawer(
    "编辑人格 · " + pid,
    `<div class="mut" style="font-size:11.5px;margin-bottom:8px">直接改 AstrBot 原生人格（写回 /personas），不是另存一份</div>
     <div class="mut" style="font-size:11px;margin-bottom:3px">system_prompt（${fmtNum(x.prompt_len)} 字）</div>
     <textarea class="inp" rows="12" id="hfPersonaPrompt">${esc(x.system_prompt)}</textarea>
     <div class="mut" style="font-size:11px;margin:12px 0 3px">开场白（每行一条）</div>
     <textarea class="inp" rows="3" id="hfPersonaDialogs">${esc((x.begin_dialogs || []).join("\n"))}</textarea>
     <div class="row bt" style="margin-top:16px">
       <button class="btn" onclick="closeDrawer()">取消</button>
       <button class="btn p" onclick="hfPersonaSave(${jsStr(pid)})">保存到 AstrBot</button></div>`
  );
}

export async function hfPersonaSave(pid) {
  const prompt = (($("#hfPersonaPrompt") || {}).value || "").trim();
  const dialogs = (($("#hfPersonaDialogs") || {}).value || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const res = await apiPostSafe("persona/save", { persona_id: pid, system_prompt: prompt, begin_dialogs: dialogs });
  toast(res.ok ? "人格已保存" : "保存失败：" + res.error, res.ok ? "ok" : "err");
  if (res.ok) {
    closeDrawer();
    refreshCurrent();
  }
}

export async function renderPersonaState() {
  const [p, prop, ev] = await Promise.all([
    apiSafe("personas", {}, { available: false, items: [], active: "" }),
    apiSafe("persona/proposals", {}, { items: [] }),
    apiSafe("persona/evolve", {}, { ok: false }),
  ]);
  const items = prop.items || [];
  const pend = items.filter((x) => x.status === "pending");                 // 主体只放待审核
  const hist = items.filter((x) => x.status !== "pending");                 // 处理过的进"文件列表"
  /** 提案状态 → 面板文案与颜色（stale/expired 是"自动作废"，不是"被你驳回"，别混成一种） */
  const statusView = (st) =>
    ({
      approved: ["已采纳", "ok"],
      rejected: ["已驳回", "gy"],
      stale: ["已过期（人格被改过）", "warn"],
      expired: ["超时作废", "warn"],
      pending: ["待审核", "warn"],
    }[String(st || "")] || [String(st || "未知"), "gy"]);
  /** 文件名用的日期戳：人格进化-2026-10-07-14-54.md */
  const fileStamp = (ms) => {
    const d = new Date((Number(ms) || 0) * 1000);
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}-${p2(d.getMinutes())}`;
  };
  const E = ev.params || {};
  const scopeCn = { desc_style: "描述 + 说话风格", desc_only: "只改描述", all: "整段重写" }[E.evolve_scope] || String(E.evolve_scope || "—");
  const days = (ms) => (ms ? fmtTime(ms) : "—");
  const html = `
  ${pageHead("人格状态 · 自动进化", "模型可以提案改人格，但必须你点通过才会写入", `<button class="btn p" onclick="hfPersonaPropose(this)">立即生成提案</button>`, "✎")}
  ${kpis(
    kpiCard("pnActive", esc(p.active || "—"), "当前人格")
    + kpiCard("pnPend", fmtNum(pend.length), "待审核提案")
    + kpiCard("pnLast", days(ev.last_evolve_at), "上次进化")
    + kpiCard("pnNext", ev.next_due_at ? days(ev.next_due_at) : "—", `下次最早（间隔 ${E.evolve_min_hours || 24}h）`)
  )}
  ${card(
    `<div class="row bt" style="gap:8px;margin-bottom:0">
       <div style="min-width:0">
         <div class="pn">进化策略</div>
         <div class="pd">${E.evolve_auto ? "自动" : "手动"} · 自刷新（至少新增 <b>${fmtNum(E.evolve_min_memories || 6)}</b> 条记忆才动）·
           当前新增 <b>${fmtNum(ev.new_memories)}</b> 条 · 可改范围 <b>${esc(scopeCn)}</b> ·
           ${E.evolve_require_confirm ? "<b>需要你确认</b>" : "<b>自动写入</b>"}
           ${ev.llm_ready === false ? '<span class="tag dg">模型通道不可用</span>' : ""}</div>
       </div>
       <button class="btn xs" onclick="hfEvolveParams(this)">参数</button>
     </div>
     <div id="evParams" style="display:none;margin-top:9px">
       <div class="grid g2" style="gap:9px">
         <div class="prow"><div><div class="pn">自动进化</div><div class="pd">按周期自己出提案（关掉只能手点）</div></div>
           <div class="pc"><label class="sw"><input type="checkbox" id="evAuto" ${E.evolve_auto ? "checked" : ""} onchange="hfEvolveSave(this)"><span class="tk"></span><span class="kb"></span></label></div></div>
         <div class="prow"><div><div class="pn">最短间隔（小时）</div><div class="pd">自刷新：期间没有新记忆就不动</div></div>
           <div class="pc"><input class="ipt mono" id="evHours" style="width:90px" value="${esc(String(E.evolve_min_hours || 24))}" onchange="hfEvolveSave(this)"></div></div>
         <div class="prow"><div><div class="pn">至少新增记忆数</div><div class="pd">太少容易让人格漂移</div></div>
           <div class="pc"><input class="ipt mono" id="evMems" style="width:90px" value="${esc(String(E.evolve_min_memories || 6))}" onchange="hfEvolveSave(this)"></div></div>
         <div class="prow"><div><div class="pn">可改范围</div><div class="pd">建议只放开描述与说话风格</div></div>
           <div class="pc"><select class="ipt" id="evScope" onchange="hfEvolveSave(this)">
             <option value="desc_style" ${E.evolve_scope === "desc_style" ? "selected" : ""}>描述 + 说话风格</option>
             <option value="desc_only" ${E.evolve_scope === "desc_only" ? "selected" : ""}>只改描述</option>
             <option value="all" ${E.evolve_scope === "all" ? "selected" : ""}>整段重写</option></select></div></div>
         <div class="prow"><div><div class="pn">需要人工确认</div><div class="pd">关掉＝自动写回 AstrBot 原生人格</div></div>
           <div class="pc"><label class="sw"><input type="checkbox" id="evConfirm" ${E.evolve_require_confirm ? "checked" : ""} onchange="hfEvolveSave(this)"><span class="tk"></span><span class="kb"></span></label></div></div>
         <div class="prow"><div><div class="pn">人格上次保存</div><div class="pd">面板里改人格 / 通过提案都会刷新</div></div>
           <div class="pc mono" style="font-size:11.5px">${days(ev.last_save_at)}</div></div>
       </div>
     </div>`,
    { title: "参数（点右侧展开）", sub: "和插件配置 _conf_schema.json 同名同义，改哪边都行", cls: "sec" }
  )}
  ${card(
    `<div class="mut" style="font-size:11.5px;line-height:1.7;margin-bottom:9px">当前人格、system prompt、切换都在 AstrBot 原生人格库里（本页只读不改；「进化提案」经你审核后写回原生人格）。</div>
     <div class="prow"><div><div class="pn">记忆人格隔离</div><div class="pd">开启后记忆按人格隔离，切换人格只看到自己那份</div></div>
      <div class="pc"><label class="sw"><input type="checkbox" ${p.isolated ? "checked" : ""} onchange="hfIsolatedToggle(this.checked)"><span class="tk"></span><span class="kb"></span></label></div></div>`,
    { title: "人格来源：AstrBot 原生", cls: "sec" }
  )}
  <div class="sec-t">待审核提案</div>
  <div class="col">
    ${
      pend.length
        ? pend
            .map(
              (x) => `<div class="card cp">
        <div class="row bt" style="margin-bottom:8px">
          <div class="row" style="gap:7px">
            <span class="tag warn">待审核</span>
            <span class="chip">${esc(x.persona_id || "—")}</span>
            <span class="mut" style="font-size:10.5px">生成于 ${fmtTime(x.ts)} · token ${fmtNum((x.in_tokens || 0) + (x.out_tokens || 0))}</span>
          </div>
          <div class="row" style="gap:6px">
            <button class="btn xs p" onclick="hfPersonaDecide(${x.id}, true)">通过并写入</button>
            <button class="btn xs dg" onclick="hfPersonaDecide(${x.id}, false)">驳回</button>
          </div>
        </div>
        <div class="mut" style="font-size:11px;margin-bottom:5px">改动理由：${esc(x.rationale || "—")}</div>
        <div class="grid g2" style="gap:9px">
          <div><div class="mut" style="font-size:10.5px;margin-bottom:3px">当前人格片段 · 上次保存 ${days(ev.last_save_at)}</div>
            <div class="chip" style="white-space:pre-wrap;line-height:1.6;max-height:180px;overflow:auto;width:100%">${esc(String(x.base || ""))}</div></div>
          <div><div class="mut" style="font-size:10.5px;margin-bottom:3px">进化体（提案）· 生成于 ${fmtTime(x.ts)}${x.status === "approved" && x.decided_at ? " · 已采纳于 " + fmtTime(x.decided_at) : ""}</div>
            <div class="noteblock scroll" style="border-left-color:var(--primary)">${esc(String(x.proposal || ""))}</div></div>
        </div>
      </div>`
            )
            .join("")
        : emptyBlock("现在没有待审核的提案。点右上角「立即生成提案」让模型读语料写一版新人格给你对比", "✎")
    }
  </div>
  <div class="sec-t">历史记录</div>
  ${
    hist.length
      ? `<div class="col" style="gap:0">${hist.map((x) => {
          const stamp = fileStamp(x.decided_at || x.ts);
          const ok = x.status === "approved";
          return `<div class="fitem">
            <div class="frow-line" onclick="hfHistToggle(${x.id})">
              <span class="fic">📄</span>
              <span class="fname mono">人格进化-${esc(stamp)}.md</span>
              <span class="tag ${statusView(x.status)[1]}">${statusView(x.status)[0]}</span>
              <span class="mut" style="font-size:10.5px">${fmtTime(x.decided_at || x.ts)}</span>
              ${ok ? `<button class="btn xs" onclick="event.stopPropagation();hfPersonaRollback(${x.id})">回滚到此版本</button>` : ""}
              <button class="btn xs" onclick="event.stopPropagation();hfHistToggle(${x.id})">展开</button>
            </div>
            <div class="fbody" id="hist_${x.id}" style="display:none">
              <div class="mut" style="font-size:11px;margin:6px 0 4px">改动理由：${esc(x.rationale || "—")}</div>
              <div class="grid g2" style="gap:9px">
                <div><div class="mut" style="font-size:10.5px;margin-bottom:3px">当时的人格（base）</div>
                  <div class="chip" style="white-space:pre-wrap;line-height:1.6;max-height:260px;overflow:auto;width:100%">${esc(String(x.base || "—"))}</div></div>
                <div><div class="mut" style="font-size:10.5px;margin-bottom:3px">进化体（提案全文）</div>
                  <div class="noteblock scroll" style="border-left-color:var(--primary);max-height:260px">${esc(String(x.proposal || "—"))}</div></div>
              </div>
            </div>
          </div>`;
        }).join("")}</div>`
      : emptyBlock("还没有历史记录 —— 通过或驳回一次提案后，这里会出现带日期戳的文件", "🗂")
  }`;
  return { html };
}

/** 展开/收起进化参数（不再单独占一块） */
export function hfEvolveParams(btn) {
  const box = document.getElementById("evParams");
  if (!box) return;
  const open = box.style.display !== "none";
  box.style.display = open ? "none" : "block";
  if (btn) btn.textContent = open ? "参数" : "收起参数";
}

/** 历史记录：点文件名原地展开详细人格 */
export function hfHistToggle(id) {
  const box = document.getElementById("hist_" + id);
  if (!box) return;
  box.style.display = box.style.display === "none" ? "block" : "none";
}

/** 保存进化参数（和 _conf_schema.json 同名同义，改哪边都行） */
export async function hfEvolveSave() {
  const num = (id, d) => {
    const el = document.getElementById(id);
    const v = parseInt(String((el && el.value) || "").trim(), 10);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const on = (id, d) => {
    const el = document.getElementById(id);
    return el ? !!el.checked : d;
  };
  const scopeEl = document.getElementById("evScope");
  const res = await apiPostSafe("config/save", {
    patch: {
      evolve_auto: on("evAuto", true),
      evolve_min_hours: num("evHours", 24),
      evolve_min_memories: num("evMems", 6),
      evolve_scope: scopeEl ? String(scopeEl.value) : "desc_style",
      evolve_require_confirm: on("evConfirm", true),
    },
  });
  toast(res.ok ? "进化参数已保存" : "保存失败：" + (res.error || ""), res.ok ? "ok" : "err");
  if (res.ok) refreshCurrent();
}

export async function hfIsolatedToggle(on) {
  const res = await apiPostSafe("config/save", { patch: { memory_persona_isolated: !!on } });
  toast(res.ok ? (on ? "记忆已按人格隔离" : "已改为全人格共享记忆") : "保存失败：" + res.error, res.ok ? "ok" : "err");
  refreshCurrent();
}

export async function hfPersonaPropose(btn) {
  if (btn) {
    btn.classList.add("loading");
    btn.disabled = true;
  }
  const res = await apiPostSafe("persona/propose", {});
  if (btn) {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
  const d = res.data || {};
  toast(res.ok && d.ok !== false ? `已生成提案 #${d.id}，请对比后决定` : "生成失败：" + (d.error || res.error || ""), res.ok && d.ok !== false ? "ok" : "err");
  refreshCurrent();
}

export async function hfPersonaRollback(id) {
  confirmModal(
    "回滚人格？",
    "会把这条提案记录里保存的「旧版本人格」写回 AstrBot 原生人格 —— 当前人格会被覆盖（之后想再改回来也可以）。",
    async () => {
      const r = await apiPostSafe("persona/rollback", { id });
      if (r && r.ok) {
        toast("已回滚到该版本（人格已更新）");
        refreshCurrent();
      } else {
        toast("回滚失败：" + ((r && r.error) || "未知错误"));
      }
    }
  );
}

export async function hfPersonaDecide(id, approve) {
  const res = await apiPostSafe("persona/decide", { id, approve: !!approve });
  const d = res.data || {};
  toast(res.ok && d.ok !== false ? (approve ? "已写入人格" : "已驳回") : "失败：" + (d.error || res.error || ""), res.ok && d.ok !== false ? "ok" : "err");
  refreshCurrent();
}

/* ==================================================================
   设置：模块与参数 / 用户与群聊 / 模型分配 / Token
   ================================================================== */
export async function renderSettingsMain() {
  const [cfg, detect, stats, dom] = await Promise.all([
    apiSafe("config", {}, {}),
    apiSafe("import/detect", {}, {}),
    apiSafe("stats", { persona_id: "" }, {}),
    apiSafe("config/domains", {}, { domains: {} }),
  ]);
  // 「输出拟人」域（分段 / 打字延迟 / 表情包 / 语音）此前在面板里没有任何卡片 ——
  // 只有 AstrBot 原生配置弹窗能看到，等于"控件有、面板点不到"。这里给它一张真卡片（能保存）。
  const outKeys = ((dom || {}).domains || {}).output || [];
  STATE.config = cfg;
  STATE.stats = stats;
  const rows = [
    ["master_switch", "总开关", "关掉后StarHeart整体不介入，适合排查问题"],
    ["session_context_enabled", "会话上下文", "把同会话最近消息一起给模型"],
    ["memory_persona_isolated", "记忆人格隔离", "记忆按人格分开存放"],
  ];
  const lm = detect || {};
  const html = `
  ${pageHead("设置", "模块开关、输出拟人参数、记忆导入与危险操作都在这一页；其余参数按域分散在各功能页里", "", "⚙")}
  ${card(
    rows
      .map(([key, name, desc]) => {
        const v = cfg[key];
        const isBool = key !== "output_typo_mode";
        return `<div class="prow"><div><div class="pn">${esc(name)}</div><div class="pd">${esc(desc)} · <span class="mono">${key}</span></div></div>
          <div class="pc">${
            isBool
              ? `<label class="sw"><input type="checkbox" data-hf-cfg="${key}" ${v ? "checked" : ""}><span class="tk"></span><span class="kb"></span></label>`
              : `<select class="inp" data-hf-cfg="${key}">${["off", "light", "medium"].map((o) => `<option ${String(v) === o ? "selected" : ""}>${o}</option>`).join("")}</select>`
          }</div></div>`;
      })
      .join("") + `<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn p" onclick="hfSaveConfig(this)">保存</button></div>`,
    { title: "核心开关", cls: "sec" }
  )}
  ${outKeys.length
    ? card(
        domainRowsHtml("output", cfg, outKeys) +
          `<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn p" onclick="hfSaveDomain('output',this)">保存输出参数</button></div>`,
        {
          title: "输出拟人 · 分段 / 打字延迟 / 表情包 / 语音",
          sub: "对应后端 CONFIG_DOMAINS['output']：这些是「发出去之前」的拟人处理（改完点保存）",
          cls: "sec",
        }
      )
    : ""}
  <div class="grid g2 sec">
    ${card(
      `<div class="grid g2" style="gap:9px">
        <div style="background:var(--surface2);border:1px solid var(--bd);border-radius:11px;padding:10px 12px">
          <div class="row" style="gap:6px"><span class="hlamp ${lm.plugin_dir_exists ? "g" : "y"}"></span><b style="font-size:12px">LivingMemory 插件</b></div>
          <div class="mut" style="font-size:10.5px;margin-top:3px">${lm.plugin_dir_exists ? "已检测到源库" : "未检测到（导入功能不可用）"}</div></div>
        <div style="background:var(--surface2);border:1px solid var(--bd);border-radius:11px;padding:10px 12px">
          <div class="row" style="gap:6px"><span class="hlamp ${lm.db_exists ? "g" : "y"}"></span><b style="font-size:12px">源数据库</b></div>
          <div class="mut" style="font-size:10.5px;margin-top:3px">文档 ${fmtNum(lm.documents)} · 原子 ${fmtNum(lm.atoms)} · 已导入 ${fmtNum(lm.already_imported)}</div></div>
      </div>
      <div class="row wrap" style="gap:8px;margin-top:12px">
        <label class="row" style="gap:6px;font-size:11.5px"><input type="checkbox" id="hfLayerDoc" checked> 文档层</label>
        <label class="row" style="gap:6px;font-size:11.5px"><input type="checkbox" id="hfLayerAtom" checked> 原子层</label>
        <button class="btn s" onclick="hfImportDetect()">重新检测</button>
        <button class="btn p" onclick="hfImportStart(false)">导入 5 条试跑</button>
        <button class="btn" onclick="hfImportStart(true)">全量导入</button>
      </div>
      <div style="margin-top:11px"><div class="bar"><span class="bf" id="hfImportBar" style="display:block;width:0%"></span></div>
        <div class="row bt" style="margin-top:5px"><span class="mut" style="font-size:11px" id="hfImportPhase">未开始</span><span class="mono" style="font-size:11px" id="hfImportCount"></span></div></div>`,
      { title: "记忆导入", sub: "从 astrbot_plugin_livingmemory 的源库导入历史记忆（导入会一并重建关系链）" }
    )}
    ${card(
      `<table><thead><tr><th>开始时间</th><th>来源</th><th>导入</th><th>跳过</th><th>失败</th><th>状态</th></tr></thead>
        <tbody id="hfImportHistory">${
          ((detect || {}).batches || [])
            .map(
              (b) => `<tr><td class="mono">${fmtTime(b.started_at)}</td><td>${esc(b.source)}</td><td class="mono">${fmtNum(b.imported)}</td>
              <td class="mono">${fmtNum(b.skipped)}</td><td class="mono">${fmtNum(b.failed)}</td>
              <td><span class="tag ${b.status === "done" ? "ok" : "info"}">${esc(b.status)}</span></td></tr>`
            )
            .join("") || `<tr><td colspan="6" class="mut">还没有导入记录</td></tr>`
        }</tbody></table>`,
      { title: "导入历史", sub: "每一批的去重结果" }
    )}
  </div>
  ${card(
    `<div class="danger-zone">
      <div class="prow"><div><div class="pn">清空门控流水</div><div class="pd" id="hfDangerGateText">读取中…</div></div>
        <div class="pc"><button class="btn s dg" onclick="hfPurge('gate')">清空</button></div></div>
      <div class="prow"><div><div class="pn">重置学习数据</div><div class="pd" id="hfDangerLearnText">读取中…</div></div>
        <div class="pc"><button class="btn s dg" onclick="hfPurge('learning')">重置</button></div></div>
      <div class="prow"><div><div class="pn">按会话删除记忆</div><div class="pd">填会话 id（如 aiocqhttp:GroupMessage:12345），删掉该会话全部记忆</div></div>
        <div class="pc"><input class="inp" id="hfDangerSession" placeholder="会话 id" style="width:230px"><button class="btn s dg" onclick="hfPurge('session')">删除</button></div></div>
      <div class="prow"><div><div class="pn">重建关系链</div><div class="pd">把记忆之间的实体/时序/语义边重新算一遍（幂等，可反复点）</div></div>
        <div class="pc"><button class="btn s" onclick="hfGraphBuild(this)">重建</button></div></div>
    </div>`,
    { title: "危险区", sub: "这里的操作直接改库，不可恢复", cls: "sec" }
  )}`;
  return {
    html,
    mount: (host) => {
      const st = stats || {};
      const gateEl = host.querySelector("#hfDangerGateText");
      if (gateEl) gateEl.textContent = `7 天自动滚动，当前 ${fmtNum(st.gate_total || 0)} 条评分记录`;
      const learnEl = host.querySelector("#hfDangerLearnText");
      if (learnEl) learnEl.textContent = `删除全部 ${fmtNum(st.memories || 0)} 条记忆、${fmtNum(st.habits || 0)} 条表达习惯与全部关系链，好感保留。不可恢复。`;
    },
  };
}

export async function hfSaveConfig(btn) {
  const patch = {};
  $$("[data-hf-cfg]").forEach((el) => {
    const key = el.getAttribute("data-hf-cfg");
    if (!CONFIG_META[key]) return;
    patch[key] = el.type === "checkbox" ? el.checked : el.value;
  });
  if (btn) {
    btn.classList.add("loading");
    btn.disabled = true;
  }
  const res = await apiPostSafe("config/save", { patch });
  if (btn) {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
  toast(res.ok ? `已保存 ${Object.keys(patch).length} 项` : "保存失败：" + res.error, res.ok ? "ok" : "err");
  refreshCurrent();
}

export async function hfImportDetect() {
  const d = await apiSafe("import/detect", {}, {});
  toast(`检测完成：文档 ${d.documents || 0} · 原子 ${d.atoms || 0}`);
  refreshCurrent();
}

let importSub = null;

export async function hfImportStart(all) {
  const layers = [];
  if (($("#hfLayerDoc") || {}).checked) layers.push("documents");
  if (($("#hfLayerAtom") || {}).checked) layers.push("atoms");
  if (!layers.length) {
    toast("至少选一个导入层", "err");
    return;
  }
  const res = await apiPostSafe("import/start", { layers, limit: all ? null : 5 });
  const d = res.data || {};
  if (!res.ok || !d.started) {
    toast("未开始：" + (d.message || res.error || ""), "err");
    return;
  }
  toast("已开始导入，进度实时刷新", "ok");
  const phase = $("#hfImportPhase");
  if (phase) phase.textContent = "已启动…";
  if (importSub) {
    try {
      await bridge.unsubscribeSSE(importSub);
    } catch (err) {
      /* 订阅可能已断，忽略 */
    }
  }
  importSub = await bridge.subscribeSSE(
    EP("import/progress"),
    {
      onMessage(ev) {
        const p = ev.parsed || {};
        const bar = $("#hfImportBar");
        const pct = p.total ? Math.min(100, Math.round(((p.done || 0) / p.total) * 100)) : 0;
        if (bar) bar.style.width = pct + "%";
        const cnt = $("#hfImportCount");
        if (cnt) cnt.textContent = `${p.done || 0} / ${p.total || 0}`;
        const ph = $("#hfImportPhase");
        if (ph) ph.textContent = `${p.phase || ""} ${p.message || ""}${p.imported != null ? ` · 导入 ${p.imported} 跳过 ${p.skipped} 失败 ${p.failed}` : ""}`;
        if (p.phase === "done") {
          toast(`导入完成：新增 ${p.imported || 0} 条`, "ok");
          if (importSub) {
            const sid = importSub;
            importSub = null;
            Promise.resolve(bridge.unsubscribeSSE(sid)).catch(() => {});
          }
          refreshCurrent();
        }
      },
      onError() {
        console.warn("[starheart] 导入进度 SSE 断开");
      },
    },
    {}
  );
}

export async function hfPurge(scope) {
  if (scope === "session") {
    const sid = (($("#hfDangerSession") || {}).value || "").trim();
    if (!sid) {
      toast("先填会话 id", "err");
      return;
    }
    confirmModal("按会话删除记忆", `将删除会话 ${sid} 的全部记忆，不可恢复。`, async () => {
      const res = await apiPostSafe("purge/session", { session_id: sid });
      toast(res.ok ? `已删除 ${(res.data || {}).removed || 0} 条` : "失败：" + res.error, res.ok ? "ok" : "err");
      refreshCurrent();
    });
    return;
  }
  const label = scope === "gate" ? "门控流水" : "全部学习数据（记忆 + 习惯 + 关系链）";
  confirmModal(`清空${label}`, "不可恢复，确定继续？", async () => {
    const res = await apiPostSafe(scope === "gate" ? "purge/gate" : "purge/learning", {});
    toast(res.ok ? "已清空" : "失败：" + res.error, res.ok ? "ok" : "err");
    refreshCurrent();
  });
}

const CONN_MODES = [
  { v: "white", label: "白名单", hint: "只有名单里的群/人能被StarHeart看到；其余全部当不存在。（本项直接读写 AstrBot 原生配置：平台配置 → 白名单；插件只做筛选与合并写回、不另存）" },
  { v: "black", label: "黑名单", hint: "勾选 = 从原生白名单里剔除（其余原样保留）：不记忆、不学说话、不算好感、不进主动候选。（本项直接读写 AstrBot 原生配置：平台配置 → 白名单；插件只做筛选与合并写回、不另存）" },
];

/** 一对一的「可见性名单」编辑器：模式 + 多选 + 确定写入 */
function connCard(kind, title, list, filter) {
  const raw = String((filter.modes || {})[kind] || "white");
  const mode = raw === "black" ? "black" : "white";   // 只有黑白两种；历史 off 归一到白名单
  const meta = CONN_MODES.find((x) => x.v === mode) || CONN_MODES[0];
  const picked = (STATE.pick && STATE.pick[`${kind}:${mode}`]) || new Set();
  const verdicts = filter.verdicts || {};
  const rows = list
    .map((x) => {
      const id = String(x.id || x.group_id || x.user_id || "");
      if (!id) return "";
      const v = verdicts[`${kind}:${id}`] || {};
      // 名字候选：行自带 name / verdict.name / 全局 names 映射 —— **凡是等于号码的一律跳过**
      // （好友行的 name 常常就是号码本身，直接 || 会被短路，界面就成了「号码 号码」）
      const nm = [x.name, v.name, (filter.names || {})[`${kind}:${id}`]]
        .map((s) => String(s == null ? "" : s).trim())
        .find((s) => s && s !== id) || String(id);
      const on = picked.has(id);
      return `<label class="pickrow" data-name="${esc(nm.toLowerCase())}" style="cursor:pointer">
        <input type="checkbox" class="connbox" data-kind="${kind}" data-id="${esc(id)}" ${on ? "checked" : ""}
               onchange="hfConnToggle('${kind}', ${jsStr(id)}, this.checked)">
        <span class="nm">${esc(nm)}</span>
        <span class="mono mut" style="font-size:10.5px">${esc(id)}</span>
        <span class="tag ${v.visible === false ? "err" : v.visible ? "ok" : "gy"}">${v.visible === false ? "不可见" : v.visible ? "可见" : "未判"}</span>
      </label>`;
    })
    .join("");

  return card(
    `<div class="row bt wrap" style="gap:8px;margin-bottom:9px">
      ${segmentHtml(CONN_MODES.map((m) => ({ value: m.v, label: m.label, title: m.hint })), mode, `conn_${kind}`)}
      <span class="mut" style="font-size:11px">${esc(meta.hint)}</span>
      <span class="searchbox" style="width:140px"><i class="ic">⌕</i><input placeholder="过滤…" oninput="hfContactFilter(this.value, '${kind}')"></span>
    </div>
    <div class="row bt wrap" style="gap:6px;margin-bottom:8px">
      <span class="mut" style="font-size:11px">已选 <b id="connCnt_${kind}">${picked.size}</b> / 共 ${list.length} 项</span>
      <button class="btn xs" onclick="hfConnAll('${kind}', true)">全选</button>
      <button class="btn xs" onclick="hfConnAll('${kind}', false)">清空</button>
      <button class="btn p" onclick="hfConnSave('${kind}', this)">保存</button>
    </div>
    ${
      mode === "white" && !picked.size
        ? `<div class="noteblock" style="border-left-color:var(--error);margin-bottom:8px">
             ⚠ <b>白名单是空的</b>：<b>全部放行</b>（AstrBot 原生语义：名单为空 = 不触发）（原生语义：空名单 = 全部放行，等于不触发白名单限制）。
             想放行谁就勾上它，再点「保存」；也可以
             <button class="btn xs" onclick="hfConnSeedAll('${kind}', this)">全部放行</button>（把列出来的 ${list.length} 项一次加进白名单，之后慢慢删）。
           </div>`
        : ""
    }
    <div class="picklist" data-kind="${kind}" style="max-height:260px">${rows || emptyBlock("平台接口没返回名单（可能是适配器限制）", "☰")}</div>`,
    { title, sub: mode === "black" ? "名单内 = 对 bot 不存在" : mode === "white" ? "只有名单内可见" : "全部可见" }
  );
}

export async function renderContacts() {
  const [contacts, filter, rules] = await Promise.all([
    apiSafe("contacts", {}, { available: false, admins: [], groups: [], friends: [], bots: [], errors: [] }),
    apiSafe("contacts/filter", {}, { modes: {}, black: {}, white: {}, counts: {}, verdicts: {} }),
    apiSafe("proactive/rules", {}, { sessions: [] }),
  ]);
  STATE.contacts = contacts;
  STATE.filter = filter;
  STATE.rules = rules;
  // 多选状态：四份（群/私聊 × 黑/白）各自独立，切模式不会串味
  STATE.pick = STATE.pick || {};
  for (const kind of ["group", "private"]) {
    for (const mode of ["black", "white"]) {
      const key = `${kind}:${mode}`;
      if (!STATE.pick[key]) {
        STATE.pick[key] = new Set(((mode === "black" ? (filter.black || {}) : (filter.white || {}))[kind] || []).map(String));
      }
    }
  }
  const groups = contacts.groups || [];
  const friends = contacts.friends || [];
  const pk = { group: [], private: [] };
  (rules.sessions || []).forEach((x) => {
    if (x.verdict === "deny") pk[x.kind] = pk[x.kind] || [];
  });

  const html = `
  ${pageHead(
    "名单与可见性",
    "这里是「StarHeart能看到谁」的总闸门，只有<b>黑名单</b>和<b>白名单</b>两种：黑名单内 = 对 bot 不存在；白名单 = 只有名单内可见（默认、默认空选）。主动消息的黑白名单是在这之上的收窄；管理员名单读的是 AstrBot 原生配置；<b>白名单/黑名单也直接读写 AstrBot 原生「平台配置 → 白名单」</b>（enable_id_white_list / id_whitelist），插件只做筛选与合并写回、不另存第二份；<b>原生名单为空 = 全部放行（等于不触发）</b>。",
    `<button class="btn" onclick="hfContactsRefresh(this)">重新拉取</button>
     <button class="btn s" onclick="goPage('messages','proactive')">主动设置 →</button>`,
    "☰"
  )}
  ${
    contacts.derived
      ? `<div class="noteblock" style="border-left-color:var(--warning);margin-bottom:12px">
           平台接口没返回群/好友列表（可能是适配器限制），下面用的是<b>你自己聊过的会话</b>兜底 —— 一样能勾选、能写入名单。
           ${(contacts.errors || []).length ? `<div class="mut" style="font-size:10.5px;margin-top:6px">${esc((contacts.errors || []).join(" / "))}</div>` : ""}
         </div>`
      : ""
  }
  ${kpis(
    kpiCard("ctG", fmtNum(groups.length), "群聊")
    + kpiCard("ctF", fmtNum(friends.length), "好友")
    + kpiCard("ctB", fmtNum((contacts.bots || []).length), "机器人账号")
    + kpiCard("ctA", fmtNum((contacts.admins || []).length), "管理员")
  )}
  <div class="grid g2 sec">
    ${connCard("group", "群聊可见性", groups, filter)}
    ${connCard("private", "私聊可见性", friends, filter)}
  </div>
  ${card(
    `<div class="chips">${(contacts.admins || []).map((a) => `<span class="chip">🛡 ${esc(a.name || a.id || a)}</span>`).join("") || '<span class="mut">没有读到管理员</span>'}</div>
     <div class="mut" style="font-size:11px;margin-top:9px">机器人自己：${(contacts.bots || []).map((b) => esc(b.name || b.id || b)).join("、") || "—"}（已自动排除出人物画像）</div>
     ${(contacts.errors || []).length ? `<div class="mut" style="font-size:11px;margin-top:8px;color:var(--warn-tx)">接口警告：${esc((contacts.errors || []).join(" / "))}</div>` : ""}`,
    { title: "管理员与机器人自己", sub: "只读" }
  )}`;
  return {
    html,
    mount: (host) => {
      // 模式选择是分段控件：点一下立刻落库（切换只看模式，名单本身留着）
      ["group", "private"].forEach((kind) => {
        const seg = host.querySelector(`[data-seg="conn_${kind}"]`);
        if (!seg) return;
        seg.querySelectorAll(".sg").forEach((b) =>
          b.addEventListener("click", () => {
            if (b.classList.contains("on")) return;
            hfConnMode(kind, b.dataset.v);
          })
        );
        syncSeg(seg);
      });
    },
  };
}

/** 勾选/取消一项（不动服务端，等「确定写入」） */
export function hfConnToggle(kind, id, on) {
  const mode = String((STATE.filter && STATE.filter.modes && STATE.filter.modes[kind]) || "off");
  const key = `${kind}:${mode}`;
  STATE.pick = STATE.pick || {};
  STATE.pick[key] = STATE.pick[key] || new Set();
  if (on) STATE.pick[key].add(String(id));
  else STATE.pick[key].delete(String(id));
  const cnt = document.querySelector(`#connCnt_${kind}`);
  if (cnt) cnt.textContent = String(STATE.pick[key].size);
}

/** 全选 / 清空（只改本地勾选，仍需「确定写入」） */
export function hfConnAll(kind, on) {
  const mode = String((STATE.filter && STATE.filter.modes && STATE.filter.modes[kind]) || "off");
  const key = `${kind}:${mode}`;
  const boxes = $$(`.connbox[data-kind="${kind}"]`);
  STATE.pick[key] = new Set();
  boxes.forEach((b) => {
    b.checked = !!on;
    if (on) STATE.pick[key].add(String(b.getAttribute("data-id")));
  });
  const cnt = document.querySelector(`#connCnt_${kind}`);
  if (cnt) cnt.textContent = String(STATE.pick[key].size);
}

/** 切换模式（服务端把两份名单都留着，切回来不丢） */
export async function hfConnMode(kind, mode) {
  const filter = STATE.filter || {};
  const m = mode === "black" ? "black" : "white";
  const ids = ((m === "black" ? (filter.black || {}) : (filter.white || {}))[kind] || []).map(String);
  const res = await apiPostSafe("contacts/set", { kind, mode: m, ids });
  if (!res.ok) {
    toast("切换失败：" + res.error, "err");
    return;
  }
  STATE.pick = STATE.pick || {};
  STATE.pick[`${kind}:${m}`] = new Set(ids);
  toast(m === "black" ? "已切到黑名单：名单内对 bot 不存在" : "已切到白名单：只有名单内可见", "ok");
  refreshCurrent();
}

/** 确定写入：多选的结果一次提交（不用一个一个点） */
export async function hfConnSave(kind, btn) {
  const raw = String((STATE.filter && STATE.filter.modes && STATE.filter.modes[kind]) || "white");
  const mode = raw === "black" ? "black" : "white";
  const ids = Array.from((STATE.pick && STATE.pick[`${kind}:${mode}`]) || []);
  if (btn) btn.classList.add("loading");
  const res = await apiPostSafe("contacts/set", { kind, mode, ids });
  if (btn) btn.classList.remove("loading");
  if (!res.ok) {
    toast("写入失败：" + res.error, "err");
    return;
  }
  STATE.filter = res.data || STATE.filter;
  const warn = mode === "white" && !ids.length ? "（白名单为空 = 全部放行）" : "";
  toast(`已保存${kind === "group" ? "群聊" : "私聊"}${mode === "black" ? "黑名单" : "白名单"}：${ids.length} 项${warn}`, mode === "black" || ids.length ? "ok" : "err");
  refreshCurrent();
}

/** 白名单空选时的一键放行：把当前列出来的全部写进白名单（等于「先能用，再慢慢删」） */
export async function hfConnSeedAll(kind, btn) {
  const ids = $$(`.connbox[data-kind="${kind}"]`).map((b) => String(b.getAttribute("data-id") || "")).filter(Boolean);
  if (!ids.length) {
    toast("这个范围没有可放行的项", "err");
    return;
  }
  if (btn) btn.classList.add("loading");
  const res = await apiPostSafe("contacts/set", { kind, mode: "white", ids });
  if (btn) btn.classList.remove("loading");
  if (!res.ok) {
    toast("写入失败：" + res.error, "err");
    return;
  }
  STATE.filter = res.data || STATE.filter;
  STATE.pick = STATE.pick || {};
  STATE.pick[`${kind}:white`] = new Set(ids);
  toast(`已放行 ${ids.length} 项（${kind === "group" ? "群聊" : "私聊"}白名单）`, "ok");
  refreshCurrent();
}

export function hfContactFilter(v, kind) {
  const q = String(v || "").trim().toLowerCase();
  $$(`.picklist[data-kind="${kind}"] .pickrow`).forEach((row) => {
    const name = row.getAttribute("data-name") || "";
    const text = row.textContent.toLowerCase();
    row.style.display = !q || name.includes(q) || text.includes(q) ? "" : "none";
  });
}

export async function hfContactsRefresh(btn) {
  if (btn) btn.classList.add("loading");
  const res = await apiSafe("contacts", { force: "1" }, {});
  if (btn) btn.classList.remove("loading");
  toast(`已重新拉取：群 ${(res.groups || []).length} · 好友 ${(res.friends || []).length}`, "ok");
  refreshCurrent();
}

/* 面板跑在 AstrBot 的 iframe 里，URL 会带 ?locale=zh-CN。
   动态文案跟随 AstrBot 系统语言：这里读出 locale，中/英各一份标签。 */
const HF_LOCALE = (() => {
  try {
    const u = new URLSearchParams(location.search);
    return String(u.get("locale") || u.get("lang") || "zh-CN");
  } catch (err) {
    return "zh-CN";
  }
})();
export const HF_LANG = /^en/i.test(HF_LOCALE) ? "en" : "zh";
const L = (zh, en) => (HF_LANG === "en" ? en : zh);

/** Token 流水里的任务键 → 中文名（面板上再按语言取词） */
const TASK_LABEL = {
  "est:inject": "估算·注入上下文（非真实计费）",
  memory_summary: L("记忆总结", "Memory summary"),
  memory_extract: L("记忆提取", "Memory extract"),
  expression_extract: L("表达提取", "Expression extract"),
  person_profile: L("画像（人物）", "Profiles (person)"),
  group_profile: L("画像（群聊）", "Profiles (group)"),
  proactive: L("主动开口", "Proactive"),
  persona_evolve: L("人格进化", "Persona evolve"),
  forget: L("记忆遗忘评估", "Forget review"),
  rerank: L("结果重排", "Rerank"),
  embedding: L("向量嵌入", "Embedding"),
  import: L("导入解析", "Import parse"),
};
const taskCn = (k) => {
  const raw = String(k || "chat");
  const short = raw.includes(":") ? raw.split(":").pop() : raw;   // 兼容 bg:xxx 这种带前缀的写法
  return TASK_LABEL[short] || TASK_LABEL[raw] || short;
};

const MODEL_TASKS = [
  ["memory_summary", L("◍ 记忆总结", "◍ Memory summary"), L("对话 → 摘要 + 召回线索", "Dialogue → summary + cues"), "llm"],
  ["expression_extract", L("✎ 表达提取", "✎ Expression extract"), L("聊天 → 情景/表达方式", "Chat → scenes / expressions"), "llm"],
  // 画像 = 人物（L0）+ 群聊（L1）同一个模型槽；两段系统提示词都在这张卡里展开改（用户要求：不拆成两张卡）
  ["person_profile", L("☺ 画像", "☺ Profiles"), L("把一个人 / 一个群的记忆汇总成画像（含自动刷新）", "Turn a person's or a group's memories into a profile (auto-refresh)"), "llm", ["group_profile"]],
  ["persona_evolve", L("☺ 人格进化", "☺ Persona evolve"), L("按近期素材改写当前人格的表达（默认要你确认才写回；建议锁便宜模型）", "Rewrite the current persona (needs your approval by default; a cheaper model is recommended)"), "llm"],
  ["forget", L("⌛ 记忆遗忘评估", "⌛ Forget review"), L("定期评估哪些记忆该归档 / 该遗忘（配了就用模型筛候选，没配则纯阈值；建议锁便宜模型）", "Decide which memories to archive / forget (LLM narrows the threshold candidates; falls back to plain thresholds)"), "llm"],
  ["embedding", L("⬡ 向量嵌入", "⬡ Embedding"), L("记忆召回的 embedding", "Embedding for recall"), "embedding"],
  ["rerank", L("≡ 结果重排", "≡ Rerank"), L("召回候选交给它重新定序（配了才生效）", "Reorder recall candidates (only when configured)"), "rerank"],
];

export async function renderModels() {
  const [prov, cfg, prompts] = await Promise.all([
    apiSafe("providers", {}, {}),
    apiSafe("config", {}, {}),
    // 插件自管任务的系统提示词清单（对话/主动开口/图像理解不在此列 —— 它们走 AstrBot 原生提示词）
    apiSafe("prompts", {}, { items: [] }),
  ]);
  const plist = prompts.items || [];
  const promptErrHtml = plist.length
    ? ""
    : '<div class="mut" style="font-size:11px;margin-bottom:8px">读不到系统提示词清单（后端接口异常），下面卡片里就不会显示提示词框。</div>';
  const promptMap = {};
  plist.forEach((x) => (promptMap[x.task] = x));
  const promptBlock = (key) => {
    const pr = promptMap[key];
    if (!pr) return "";
    return `<details class="hf-pr" style="margin-top:8px">
          <summary style="font-size:11.5px;display:flex;align-items:center;gap:7px">
            <span class="tag ${pr.edited ? "ok" : "gy"}">${esc(pr.label || pr.task)} · 系统提示词 ${pr.edited ? "已自定义" : "内置默认"}</span>
            <span class="mut">点这里展开看 / 改</span>
          </summary>
          ${pr.desc ? `<div class="mut" style="font-size:11px;margin-top:5px">${esc(pr.desc)}</div>` : ""}
          <textarea class="inp" rows="8" data-hf-prompt="${esc(key)}" data-hf-default="${esc(pr.default)}" style="margin-top:6px;font-size:11.5px">${esc(pr.effective)}</textarea>
          ${pr.user_key ? `<div class="mut" style="font-size:11px;margin-top:6px">用户模板（${esc(pr.user_label || pr.user_key)}）</div>
          <textarea class="inp" rows="4" data-hf-userprompt="${esc(pr.user_key)}" style="margin-top:4px;font-size:11.5px">${esc(pr.user_value)}</textarea>` : ""}
          <div class="row bt" style="margin-top:6px">
            <span class="mut" style="font-size:11px" id="hfPromptMsg_${esc(key)}"></span>
            <span class="row" style="gap:6px">
              <button class="btn xs" onclick="hfPromptReset(${jsStr(key)}, this)">恢复默认</button>
              <button class="btn xs p" onclick="hfPromptSave(${jsStr(key)}, this)">保存</button>
            </span>
          </div>
          <div class="mut" style="font-size:11px;margin-top:4px">留空 = 用内置默认，可自由改（想改成什么风格都随你）。只影响这个后台任务，<b>不影响对话回复</b>。</div>
        </details>`;
  };

  const cur = prov.current || {};
  const p = prov || {};
  const html = `
  ${pageHead(
    "模型分配",
    `每个任务各选各的模型 · 下拉读自 AstrBot 已配置的提供商 · 对话类任务留空 = 跟随会话当前模型${cur.id ? `（当前 ${esc(cur.id)}）` : ""}；嵌入/重排留空 = 跟随 AstrBot 已配置的那一个`,
    `${p.available ? "" : '<span class="tag warn">读不到模型列表</span>'}<button class="btn p" onclick="hfSaveModels(this)">保存分配</button>`,
    "⬡"
  )}
  <div class="grid g23 sec">
    ${card(`<div id="mdNet"></div>`, { title: "任务 → 提供商 绑定图", sub: "中间是任务，外围是你配的提供商；亮线=已锁定，虚线=跟随会话" })}
    ${card(
      `<div class="mut" style="font-size:11.5px;line-height:1.8">
        · 不锁定：跟着会话当前模型走，换模型不用回来改<br>
        · 记忆总结这类后台重活建议锁一个便宜模型，避免消耗对话模型额度<br>
        · 嵌入 / 重排留空会跟随 AstrBot 已配置的那一个；<b>锁死更稳</b>（换会话时向量维度不会变）</div>
       <div class="row" style="gap:6px;margin-top:10px"><button class="btn s" onclick="hfTestAllModels(this)">逐个试跑</button></div>`,
      { title: "怎么配" }
    )}
  </div>
  <div class="grid g2 sec">
    ${MODEL_TASKS.map(([key, title, desc, kind, extraPrompts]) => {
      const list = p[kind] || [];
      const value = cfg["model_" + key] || "";
      // 工具槽位（嵌入/重排）留空是「跟随 AstrBot 已配置的那个」，不是"跟随会话当前模型"——
      // 对话模型没有 get_embedding/rerank，按"跟随会话"选等于把功能静默关掉（以前正是这么标的）。
      const isTool = key === "embedding" || key === "rerank";
      const followLabel = isTool
        ? `跟随 AstrBot 已配置的${key === "embedding" ? "嵌入" : "重排"}提供商（取第一个）`
        : "跟随会话当前模型（推荐）";
      return `${key === "memory_summary" ? promptErrHtml : ""}<div class="card cp hov">
        <div class="row bt" style="margin-bottom:8px">
          <span style="font-weight:700;font-size:13px">${esc(title)}</span>
          <span class="tag ${list.length ? "ok" : "gy"}">${list.length ? `● ${list.length} 个可选` : "该类型未配置"}</span>
        </div>
        <div class="mut" style="font-size:11px;margin-bottom:8px">${esc(desc)}</div>
        <select class="inp" style="width:100%" data-hf-model="${key}" ${list.length ? "" : "disabled"}>
          <option value="" ${value ? "" : "selected"}>${followLabel}</option>
          ${list.map((x) => `<option value="${esc(x.id)}" ${x.id === value ? "selected" : ""}>${esc(x.id)}${x.model ? " · " + esc(x.model) : ""}</option>`).join("")}
        </select>
        <div class="row bt" style="margin-top:8px">
          <span class="mut" style="font-size:11px" id="hfModelMsg_${key}">${value ? "已锁定：" + esc(value) : "未锁定（跟随会话）"}</span>
          <button class="btn xs" onclick="hfTestModel(${jsStr(key)}, this)">试跑</button>
        </div>
        ${key === "embedding" ? `<div class="mut" style="font-size:11px;margin-top:6px" id="hfDim_embedding">向量维度：读取中…</div>` : ""}${promptBlock(key)}${(extraPrompts || []).map((x) => promptBlock(x)).join("")}</div>`;
    }).join("")}
  </div>`;
  return {
    html,
    mount: (host) => {
      const assigns = {};
      MODEL_TASKS.forEach(([key, , , kind]) => {
        const v = cfg["model_" + key] || "";
        if (v) assigns[key] = v;
      });
      // 当前向量模型的维度（来自向量库各代：换模型=换库，这里让用户看得见）
      (async () => {
        try {
          const d = await apiSafe("model/dims", {}, { dims: {}, active_gen: "" });
          const el = host.querySelector("#hfDim_embedding");
          if (!el) return;
          const cur = cfg["model_embedding"] || "";
          const norm = (x) => String(x || "").toLowerCase().split("/").pop();
          const dim = (d.dims || {})[norm(cur)];
          el.textContent = dim
            ? `当前向量维度：${dim} 维（用向量库「${d.active_gen || cur}」这一代）`
            : "当前向量维度：未知（还没有该模型的向量，回填时自动建立，旧代保留）";
        } catch (err) { /* 维度查不到不影响模型分配 */ }
      })();
      const providersUsed = Array.from(new Set(Object.values(assigns)));
      mount(host, "#mdNet", (el) =>
        C.miniNetwork(el, {
          nodes: [
            ...MODEL_TASKS.map(([key, title]) => ({ id: `T:${key}`, label: title.replace(/^\S+\s/, ""), color: "#3c96ca", group: "task", r: 10 })),
            ...providersUsed.map((pid) => ({ id: `P:${pid}`, label: pid, color: "#3aa76d", group: "provider", r: 13 })),
          ],
          links: Object.keys(assigns).map((k) => ({ s: `T:${k}`, t: `P:${assigns[k]}`, w: 2 })),
          size: 240,
          interactive: true,
        })
      );
    },
  };
}

export async function hfSaveModels(btn) {
  const patch = {};
  // 只提交「真的能选」的下拉：providers 读取失败时下拉会是 disabled/空，这时提交会把已存绑定清空
  $$("[data-hf-model]").forEach((el) => {
    if (el.disabled) return;
    if (!el.options || el.options.length <= 1) return;   // 只剩「跟随…」那一项 = 该类型没读到模型，别拿它覆盖
    patch["model_" + el.getAttribute("data-hf-model")] = el.value || "";
  });
  if (!Object.keys(patch).length) {
    if (btn) btn.classList.remove("loading");
    toast("没读到可用模型列表，这次不保存（避免把已保存的绑定清空）", "err");
    return;
  }
  if (btn) btn.classList.add("loading");
  const res = await apiPostSafe("config/save", { patch });
  if (btn) btn.classList.remove("loading");
  toast(res.ok ? "模型分配已保存" : "保存失败：" + res.error, res.ok ? "ok" : "err");
  Object.keys(patch).forEach((k) => {
    const msg = document.getElementById("hfModelMsg_" + k.replace("model_", ""));
    if (msg) msg.textContent = patch[k] ? "已锁定：" + patch[k] : "未锁定（跟随会话）";
  });
}

export async function hfPromptSave(task, btn) {
  const ta = document.querySelector(`[data-hf-prompt="${task}"]`);
  const msg = document.getElementById("hfPromptMsg_" + task);
  if (!ta) return;
  if (btn) btn.classList.add("loading");
  const res = await apiPostSafe("prompt/save", { task, system: ta.value });
  // 用户模板（例如记忆总结的 {transcript} 模板）走同一套 config/save
  const patch = {};
  // 只提交「本任务卡片内」的用户模板（以前会把整页所有模板一起提交）
  const scope = ta.closest(".card") || document;
  scope.querySelectorAll("[data-hf-userprompt]").forEach((el) => (patch[el.getAttribute("data-hf-userprompt")] = el.value));
  const res2 = Object.keys(patch).length ? await apiPostSafe("config/save", { patch }) : { ok: true };
  if (btn) btn.classList.remove("loading");
  const ok = res.ok && res2.ok;
  if (msg) {
    msg.textContent = ok ? "✓ 已保存" + (ta.value.trim() ? "（自定义）" : "（用内置默认）") : "✗ " + (res.error || res2.error || "保存失败");
    msg.style.color = ok ? "var(--success)" : "var(--error)";
  }
}

export async function hfPromptReset(task, btn) {
  const ta = document.querySelector(`[data-hf-prompt="${task}"]`);
  const msg = document.getElementById("hfPromptMsg_" + task);
  if (!ta) return;
  ta.value = ta.getAttribute("data-hf-default") || "";
  if (btn) btn.classList.add("loading");
  const res = await apiPostSafe("prompt/save", { task, system: "" });
  if (btn) btn.classList.remove("loading");
  if (msg) {
    msg.textContent = res.ok ? "✓ 已恢复内置默认" : "✗ " + (res.error || "失败");
    msg.style.color = res.ok ? "var(--success)" : "var(--error)";
  }
}

export async function hfTestAllModels(btn) {
  if (btn) {
    btn.classList.add("loading");
    btn.disabled = true;
  }
  for (const [key] of MODEL_TASKS) {
    await hfTestModel(key, null);
  }
  if (btn) {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

export async function hfTestModel(key, btn) {
  const sel = document.querySelector(`[data-hf-model="${key}"]`);
  const pid = sel ? sel.value : "";
  const msg = document.getElementById("hfModelMsg_" + key);
  if (btn) btn.classList.add("loading");
  if (msg) msg.textContent = "试跑中…";
  const res = await apiPostSafe("model/test", { task: key, provider_id: pid });
  const d = res.data || {};
  if (btn) btn.classList.remove("loading");
  if (msg) {
    msg.textContent = res.ok && d.ok ? `✓ ${d.ms}ms · ${String(d.reply || "").slice(0, 40)}` : `✗ ${d.error || res.error || "失败"}`;
    msg.style.color = res.ok && d.ok ? "var(--success)" : "var(--error)";
  }
}

export async function renderTokens() {
  const data = await apiSafe("tokens", { days: 7 }, { items: [], days: 7, total_in: 0, total_out: 0, total_cached: 0, total_cost: 0 });
  const items = data.items || [];
  const byTask = {};
  items.forEach((x) => {
    const t = taskCn(x.task);            // 面板上显示中文任务名，不再露内部 key
    byTask[t] = (byTask[t] || 0) + (x.i || 0) + (x.o || 0);
  });
  const byModel = {};
  items.forEach((x) => {
    const m = x.model || "跟随会话";
    byModel[m] = (byModel[m] || 0) + (x.i || 0) + (x.o || 0);
  });
  const html = `
  ${pageHead("Token 消耗", `最近 ${data.days} 天的真实用量（来自 hf_tokens 流水）`, `<span class="tag gy">缓存命中 ${fmtNum(data.total_cached)}</span>`, "◧")}
  ${kpis(
    kpiCard("tkIn", fmtNum(data.total_in), "输入 tokens", data.est_in ? `<span class="mut">另有估算注入 ${fmtNum(data.est_in)}（单列，不计入）</span>` : "")
    + kpiCard("tkOut", fmtNum(data.total_out), "输出 tokens")
    + kpiCard("tkCache", fmtNum(data.total_cached), "命中缓存")
    + kpiCard("tkCost", data.has_pricing ? Number(data.total_cost).toFixed(4) : "未接入", "累计花费", data.has_pricing ? "" : `<span class="mut">插件侧没接计费，不是真的 0</span>`)
  )}
  <div class="grid g23 sec">
    ${card(`<div id="tkTask"></div>`, { title: "按任务", sub: "哪个任务在烧 token" })}
    ${card(`<div id="tkModel"></div>`, { title: "按模型", sub: "token 落在哪个模型上" })}
  </div>
  ${card(
    `<div style="overflow-x:auto"><table><thead><tr><th>任务</th><th>模型</th><th>输入</th><th>输出</th><th>缓存</th><th>花费</th><th>调用次数</th></tr></thead>
      <tbody>${
        items.length
          ? items
              .map(
                (x) => `<tr><td>${esc(taskCn(x.task))}</td><td class="mono">${esc(x.model || "跟随会话")}</td>
          <td class="mono">${fmtNum(x.i)}</td><td class="mono">${fmtNum(x.o)}</td><td class="mono">${fmtNum(x.c)}</td>
          <td class="mono">${!data.has_pricing || x.cost == null ? "—" : Number(x.cost).toFixed(4)}</td><td class="mono">${fmtNum(x.n)}</td></tr>`
              )
              .join("")
          : `<tr><td colspan="7" class="mut">还没有 token 记录</td></tr>`
      }</tbody></table></div>`,
    { title: "明细", sub: "按任务 + 模型聚合" }
  )}`;
  return {
    html,
    mount: (host) => {
      mount(host, "#tkTask", (el) => C.bars(el, { items: Object.keys(byTask).map((k) => ({ label: k, value: byTask[k], color: "#03c9d7" })) }));
      mount(host, "#tkModel", (el) =>
        C.barSplit(el, {
          items: Object.keys(byModel).map((k, i) => ({ label: k, value: byModel[k], color: ["#3c96ca", "#03c9d7", "#8b5cf6", "#e0559a", "#f59e0b"][i % 5] })),
          height: 18,
        })
      );
    },
  };
}

/* 顶栏人格查看视角：读真人格列表 + 记忆计数 */
export async function refreshPersonaSwitch() {
  const menu = $("#pswMenu");
  if (!menu) return;
  const p = await apiSafe("personas", {}, { available: false, items: [], active: "", counts: {} });
  STATE.personas = p;
  const counts = p.counts || {};
  const active = String(p.active || "");
  const label = $("#pswitchLabel");
  const dot = $("#pswitchDot");
  if (!STATE.personaViewTouched) STATE.personaView = active;
  if (label) label.textContent = STATE.personaView ? STATE.personaView : "全部人格";
  if (dot) dot.classList.toggle("on", !!STATE.personaView && STATE.personaView === active);
  const rows = [
    { id: "", name: "全部人格（不过滤）", n: Object.values(counts).reduce((s, v) => s + v, 0) },
    ...(p.items || []).map((x) => ({ id: x.persona_id, name: x.persona_id, n: counts[x.persona_id] || 0, isActive: x.persona_id === active })),
  ];
  if (Object.prototype.hasOwnProperty.call(counts, "")) rows.push({ id: "__none__", name: "（未归属人格的旧数据）", n: counts[""] || 0 });
  menu.innerHTML =
    `<div class="hd">记忆查看视角 · 只影响面板显示</div>` +
    rows
      .map(
        (r) => `<button type="button" class="psw-item ${String(STATE.personaView) === String(r.id) ? "sel" : ""}" onclick="hfPersonaPickView(${jsStr(r.id)})">
      <span class="pdot ${r.isActive ? "on" : ""}"></span><span class="n">${esc(r.name)}</span><span class="c">${fmtNum(r.n)}</span></button>`
      )
      .join("");
}

export function hfPersonaPickView(pid) {
  STATE.personaView = pid || "";
  STATE.personaViewTouched = true;
  const label = $("#pswitchLabel");
  if (label) label.textContent = STATE.personaView === "__none__" ? "未归属" : STATE.personaView || "全部人格";
  const det = $("#personaSwitch");
  if (det) det.removeAttribute("open");
  toast(`查看视角：${STATE.personaView === "__none__" ? "未归属" : STATE.personaView || "全部人格"}`);
  refreshCurrent();
  refreshPersonaSwitch();
}
