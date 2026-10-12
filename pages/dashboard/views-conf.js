/**
 * StarHeart 面板 · 配置域渲染器（门控 / 记忆 / 表达 / 好感 / 撤回 / 主动 / 输出 / 人格 / 主开关）
 *
 * 这些是**写进数据库的真配置**（CONFIG_DOMAINS 白名单），不是设计稿上的假开关：
 * 保存时只提交本页出现过的键，避免误改别的域。
 */

import * as C from "./charts.js?v=1.0.0";
import {
  $, $$, api, apiSafe, apiPostSafe, esc, toast, pageHead, card, mount, emptyBlock, refreshCurrent, normList, jsStr,
} from "./store.js?v=1.0.0";

/** key -> [标签, 说明, 类型, min, max, step, 选项] */
export const CONFIG_META = {
  master_switch: ["总开关", "关掉后StarHeart整体不介入（适合临时排查）", "bool"],
  session_context_enabled: ["会话上下文", "把同会话最近的消息一起交给模型", "bool"],

  // 平台边界：本插件只服务 QQ（OneBot/aiocqhttp），别的平台的会话不进库
  track_platforms: ["允许记录的平台", "留空=自动只认 OneBot(QQ) 实例；也可手写平台实例名", "text"],
  person_exclude_platforms: ["永不记录的平台", "webchat/webui 已写死拦截，这里可再加", "text"],
  // 记忆域（views-memory.js 的「记忆设置」页渲染这些键，保存走 hfSaveDomain('memory')）——
  // 以前这里没有 memory_* 键，导致那一页的「保存」被 CONFIG_META 过滤成空 patch，10 个参数一个也存不了。
  memory_inject_enabled: ["记忆注入", "把召回到的记忆拼进 prompt", "bool"],
  memory_inject_top_k: ["注入条数", "每轮最多注入几条记忆", "num", 1, 20, 1],
  memory_inject_budget_tokens: ["注入预算", "记忆部分的 token 上限（超了会截断）", "num", 100, 6000, 100],
  memory_capture_enabled: ["对话自动总结", "聊完自动蒸馏出「关于用户的记忆」", "bool"],
  memory_capture_turns: ["触发轮数", "攒够几轮对话触发一次总结", "num", 1, 60, 1],
  memory_capture_min_interval: ["最小间隔(秒)", "两次总结之间至少隔多久", "num", 30, 7200, 30],
  memory_capture_max_per_run: ["单次上限", "一次总结最多产出几条记忆", "num", 1, 20, 1],
  memory_decay_half_life_days: ["衰减半衰期(天)", "记忆强度按指数衰减，这是半衰期", "num", 1, 365, 1],
  memory_evict_below: ["淘汰阈值", "强度低于此值的记忆会被标记 stale", "num", 0.01, 0.5, 0.01],
  memory_summary_prompt: ["总结自定义提示词", "空=内置；支持 {transcript} 占位", "text"],
  memory_persona_isolated: ["记忆人格隔离", "记忆按人格分开存放", "bool"],
  gate_enabled: ["门控开关", "决定机器人「该不该开口」", "bool"],
  gate_shadow: ["影子模式", "只记录评分不真的拦，用来观察门控准不准", "bool"],
  gate_threshold: ["触发阈值", "总分 ≥ 阈值才开口（分数永不进 prompt）", "num", 0, 200, 1],
  gate_window_seconds: ["连发窗口(秒)", "窗口内的多条消息合并成一次评估", "num", 3, 300, 1],

  expression_enabled: ["表达学习", "从真实对话里学「情景 → 表达方式」", "bool"],
  expression_min_uses: ["已验证门限(次)", "习惯至少生效过 N 次才算已验证；没达标的只在名额没用满时补位（避免冷启动死锁）", "num", 0, 50, 1],
  favour_enabled: ["好感结算", "按对话表现结算关系分数与区间", "bool"],
  favour_settle_mode: ["结算方式", "tag=由模型尾行自报结算（目前唯一实现）", "select", 0, 0, 0, ["tag"]],
  favour_daily_cap: ["好感日上限", "当天正增量累计到这个值就封顶（0=不限）", "num", 0, 200, 1],
  favour_daily_half_life_days: ["每日半衰期(天)", "daily 按这个天数半衰；0=关闭衰减（lifetime 永不衰减）", "num", 0, 60, 0.5],
  favour_tag_required: ["需要标签才结算", "开=只有模型给出好感标签才结算；关=无标签也按 +1（仍受日上限约束）", "bool"],
  recall_handling: ["撤回处理", "对方撤回消息时怎么处理相关记忆", "select", 0, 0, 0, ["log_only", "weaken", "delete"]],
  recall_weaken_factor: ["降权系数", "撤回命中记忆后强度乘这个系数", "num", 0.05, 1, 0.05],
  recall_keep_days: ["流水保留(天)", "撤回事件流水保留多久", "num", 1, 365, 1],
  recall_withdraw_reply: ["撤回连回复一起撤", "撤回时把该会话最近落库的 bot 语料一并撤掉并丢弃待总结轮次（平台删消息需要回复 id，AstrBot 未提供，故只做本地撤销）", "bool"],
  recall_react_enabled: ["撤回反应（当场走主动通道）", "用户撤回一条消息后，当场让模型自己决定说什么（装没看见/追问/调侃都行）；走 AstrBot 完整提示词、不看主动名单、不受免打扰限制，用户看到的是一条普通消息", "bool"],
  recall_react_group: ["撤回反应·群聊范围", "related=只对与 bot 有互动的消息（前/后一条是 bot 发言）/ all=群里任何人都触发 / off=群聊不触发", "select", 0, 0, 0, ["related", "all", "off"]],
  recall_react_images: ["撤回反应·带上图片", "被撤回的图片一并交给模型看（原生多模态，最多 2 张）", "bool"],
  recall_react_extra: ["撤回反应·附加指示", "追加在撤回通知后面的自定义指示（留空=不加）", "text"],
  proactive_enabled: ["主动消息开关", "机器人能不能主动开口找人聊天", "bool"],
  proactive_shadow: ["影子模式", "只挑选候选不真发，先看它想说什么", "bool"],
  proactive_idle_min: ["静默多久(分钟)", "会话静默超过这么久才考虑主动", "num", 10, 2880, 10],
  proactive_daily_cap: ["每日上限", "每个会话每天最多主动几条", "num", 1, 50, 1],
  proactive_min_interval_min: ["最小间隔(分钟)", "两次主动之间至少隔多久", "num", 5, 1440, 5],
  proactive_quiet_start: ["静默开始", "HH:MM，这段时间内不主动", "text"],
  proactive_quiet_end: ["静默结束", "HH:MM", "text"],
  proactive_min_zone: ["最低关系档", "关系低于这一档不主动开口", "select", 0, 0, 0, ["HOSTILE", "COLD", "NEUTRAL", "FAMILIAR", "CLOSE", "DEVOTED"]],
  proactive_last_only: ["只发最后一个会话", "一次扫描最多发一条，避免到处打招呼", "bool"],
  proactive_style: ["开口风格", "写进 prompt 的自然语言，描述主动消息该怎么说", "text"],
  proactive_auto_wl: ["自动白名单", "把人自动加进白名单的策略", "select", 0, 0, 0, ["off", "close", "familiar"]],
  proactive_wl_private: ["私聊白名单", "逗号分隔的 user_id", "list"],
  proactive_bl_private: ["私聊黑名单", "逗号分隔的 user_id", "list"],
  proactive_wl_group: ["群聊白名单", "逗号分隔的群号", "list"],
  proactive_bl_group: ["群聊黑名单", "逗号分隔的群号", "list"],
  proactive_use_persona: ["主动开口吃 AstrBot 提示词", "开启=主动开口复用 AstrBot 那份完整系统提示词（人格+技能+安全）；关掉会让主动消息吃不到人格，不建议关", "bool"],
  proactive_context_memories: ["带几条记忆", "主动开口时参考几条记忆", "num", 0, 20, 1],

  output_split_messages: ["分段发送", "长回复按语义边界拆成多条发（短句不拆）", "bool"],
  output_typing_delay: ["打字延迟", "补发的后续条目按「每字秒数 × 字数」延迟（首条立即发）", "bool"],
  output_typing_per_char: ["每字秒数", "0.3 ≈ 一字 0.3 秒", "num", 0, 2, 0.05],
  output_typing_max: ["单条延迟上限(秒)", "打字时长封顶，别等太久", "num", 0, 30, 0.5],
  persona_active_id: ["当前人格 id", "留空=跟随 AstrBot 原生当前人格", "text"],
};

const DOMAIN_META = {
  gate: { title: "门控参数", icon: "◉", desc: "机器人「该不该开口」的判定：总分 = 各因子加权和，超过阈值才回复" },
  memory: { title: "记忆设置", icon: "◍", desc: "记忆注入 / 抓取 / 衰减 / 整理" },
  expression: { title: "学习参数", icon: "✎", desc: "表达习惯的学习开关" },
  favour: { title: "结算参数", icon: "♥", desc: "好感分怎么结算、按什么模式打标" },
  recall: { title: "撤回处理参数", icon: "↩", desc: "对方撤回消息时，命中的记忆怎么处理" },
  proactive: { title: "主动护栏", icon: "☎", desc: "主动消息的所有硬约束：静默时长、频率上限、名单与人格" },
  output: { title: "输出拟人参数", icon: "✎", desc: "回复的拟人化处理" },
  persona: { title: "人格", icon: "☺", desc: "当前人格 id（人格本体在 AstrBot 原生人格库里改，本插件只用不改）" },
  master: { title: "总开关", icon: "⏻", desc: "StarHeart整体的开关与会话上下文" },
};

/** 一门域的参数行；返回 {html, values} */
export function domainRowsHtml(domain, values, keys) {
  const list = keys || Object.keys(CONFIG_META).filter((k) => (domain === "proactive" ? k.startsWith("proactive_") : true));
  return list
    .filter((k) => CONFIG_META[k])
    .map((key) => {
      const [name, desc, type, min, max, step, options] = CONFIG_META[key];
      const v = values[key];
      let control = "";
      if (type === "bool") {
        control = `<label class="sw"><input type="checkbox" data-hf-cfg="${key}" ${v ? "checked" : ""}><span class="tk"></span><span class="kb"></span></label>`;
      } else if (type === "num") {
        control = `<input class="inp" type="number" data-hf-cfg="${key}" value="${esc(v ?? "")}" ${min != null ? `min="${min}"` : ""} ${max ? `max="${max}"` : ""} ${step ? `step="${step}"` : ""}>`;
      } else if (type === "select") {
        control = `<select class="inp" data-hf-cfg="${key}">${(options || [])
          .map((o) => `<option value="${esc(o)}" ${String(v) === o ? "selected" : ""}>${esc(o)}</option>`)
          .join("")}</select>`;
      } else if (type === "list") {
        control = `<input class="inp" style="min-width:220px" data-hf-cfg="${key}" data-hf-list="1" value="${esc((Array.isArray(v) ? v : []).join(", "))}" placeholder="逗号分隔">`;
      } else {
        control = `<input class="inp" style="min-width:240px" data-hf-cfg="${key}" value="${esc(v ?? "")}">`;
      }
      return `<div class="prow" data-key="${key}"><div><div class="pn">${esc(name)}</div>
        <div class="pd">${esc(desc)} · <span class="mono">${key}</span></div></div>
        <div class="pc">${control}</div></div>`;
    })
    .join("");
}

/**
 * 通用域参数页：右侧还塞一张「域相关小图」，让参数页不只是表单。
 * 传 keys 可只渲染某几个键（例如主动域只渲染主动相关键）。
 */
/** 最近一次 config/domains 拿到的「域 → 键白名单」。保存时用它收窄 patch。 */
let DOMAIN_KEYS = {};

export async function renderDomainConf(domain, opts = {}) {
  const dom = await apiSafe("config/domains", {}, { domains: {}, values: {} });
  // config/domains 失败时必须显式报错，不能退化成「全部参数 + 空值」——
  // 那样看起来像「配置被清空了」，而且一保存就会把全量键写回去。
  if (dom && typeof dom === "object" && dom.__err) {
    return {
      html: pageHead(
        "参数读取失败",
        `这一页的参数清单来自后端 <span class="mono">config/domains</span>，现在拿不到`,
        `<button class="btn p" onclick="hfRefresh()">重试</button>`,
        "⚠"
      ) + card(
        `<div class="fnote">⚠ 读取失败：${esc(String(dom.__err))}</div>
         <div class="cs">为避免「看起来像配置被清空」以及误写全量配置，这一页不再渲染空表单。请重试。</div>`,
        { title: "读取失败" }
      ),
    };
  }
  DOMAIN_KEYS = dom.domains && typeof dom.domains === "object" ? dom.domains : {};
  const values = dom.values || {};
  const keys = (dom.domains && dom.domains[domain]) || Object.keys(CONFIG_META);
  const meta = DOMAIN_META[domain] || { title: domain, icon: "⚙", desc: "" };
  const extra = opts.extra || "";
  // top：整宽卡片，放在参数网格之前（「一键试发」这类需要显眼的东西放这儿，
  // 塞进右侧 side 列会被参数卡挡得看不着 —— 用户抱怨过「太隐蔽」）
  const top = opts.top || "";
  const html = `
  ${pageHead(
    meta.title,
    `${esc(meta.desc)} · 这些键由后端 <span class="mono">CONFIG_DOMAINS['${esc(domain)}']</span> 白名单管理`,
    `<button class="btn p" onclick="hfSaveDomain(${jsStr(domain)},this)">保存本域参数</button>
     ${opts.actions || ""}`,
    meta.icon
  )}
  ${top ? `<div class="sec">${top}</div>` : ""}
  <div class="grid g32 sec">
    ${card(domainRowsHtml(domain, values, keys), { title: "参数", sub: `共 ${keys.length} 项 · 改动会写进数据库` })}
    <div class="col">${opts.side || ""}<div id="dcChart"></div>${extra}</div>
  </div>`;
  return {
    html,
    mount: (host) => {
      mount(host, "#dcChart", (el) =>
        C.bars(el, {
          items: keys
            .filter((k) => CONFIG_META[k] && (CONFIG_META[k][2] === "num" || CONFIG_META[k][2] === "bool"))
            .slice(0, 10)
            .map((k) => ({
              label: CONFIG_META[k][0],
              value: typeof values[k] === "number" ? values[k] : values[k] ? 1 : 0,
              color: values[k] ? "var(--primary,#3c96ca)" : "#9aa4b2",
              sub: CONFIG_META[k][2] === "bool" ? (values[k] ? "已开启" : "已关闭") : "当前值",
            })),
          valueFmt: (v) => (v === 1 || v === 0 ? String(v) : String(v)),
        })
      );
    },
  };
}

/** 保存当前页里的本域参数（只提交本域白名单里的、且本页出现过的 data-hf-cfg） */
export async function hfSaveDomain(domain, btn) {
  // 原实现声明了 `const allowed = [domain]` 却从未使用过 —— 于是「域白名单」在客户端根本不存在。
  // 现在真正用它收窄；拿不到白名单就中止（宁可让用户重试，也不要把全量键写回去）。
  let whitelist = Array.isArray(DOMAIN_KEYS[domain]) ? DOMAIN_KEYS[domain] : [];
  if (!whitelist.length) {
    // ⚠️ 不能因为「白名单没拿到」就不让保存：config/domains 只是一次网络请求，
    //    它失败时（鉴权/超时/桥断）用户点保存会**毫无反应**，而白名单可以就地推出来 ——
    //    本页渲染出来的控件就带 data-hf-cfg，再用 CONFIG_META 过滤一次，收窄效果完全相同
    //    （依然只写本页、本域的键，绝不会误写全量）。真机上就是这么卡的：面板一直红字、
    //    怎么点都存不上，而同一时刻后端其实是好的。
    whitelist = Array.from($$("[data-hf-cfg]") || [])
      .map((el) => (el ? el.getAttribute("data-hf-cfg") : ""))
      .filter((k) => k && CONFIG_META[k]);
    if (!whitelist.length) {
      toast("这一页没有可保存的参数", "err");
      return;
    }
    console.warn("[starheart] config/domains 不可用，已改用本页控件就地推导白名单");
  }
  const allowed = new Set(whitelist);
  const patch = {};
  $$("[data-hf-cfg]").forEach((el) => {
    const key = el.getAttribute("data-hf-cfg");
    if (!CONFIG_META[key]) return;
    if (!allowed.has(key)) return;           // ← 域白名单真正生效
    if (el.type === "checkbox") patch[key] = el.checked;
    else if (el.dataset.hfList) patch[key] = normList(el.value);
    else if (el.type === "number") patch[key] = Number(el.value);
    else patch[key] = el.value;
  });
  if (!Object.keys(patch).length) {
    toast("这一页没有可保存的参数", "err");
    return;
  }
  if (btn) {
    btn.classList.add("loading");
    btn.disabled = true;
  }
  const res = await apiPostSafe("config/save", { patch });
  if (btn) {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
  if (!res.ok) {
    toast("保存失败：" + res.error, "err");
    return;
  }
  toast(`已保存 ${Object.keys(patch).length} 项配置`, "ok");
  refreshCurrent();
}
