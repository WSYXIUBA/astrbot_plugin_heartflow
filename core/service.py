"""StarHeart 业务服务层：所有路由逻辑都在这里，且**除 logger 外不依赖 astrbot**。

好处是能在本地直接跑真库做端到端测试（page_api 只做请求解析与响应包装）。
人格相关操作通过注入的 persona provider 完成，方便在 AstrBot 里接原生 PersonaManager。
"""

from __future__ import annotations

import asyncio
import json
import random
import re
import time
import unicodedata
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

# 审核规范（硬性）：logger 必须从 astrbot.api 导入，不得保留标准库 logging 的 fallback。
# 独立脚本环境（devtools 直接 import core）由 devtools/_astrbot_shim.py 在导入前注入桩，不进发布代码。
from astrbot.api import logger

from . import engine
from .importer import SOURCE_NAME, LivingMemoryImporter
from .storage import Store, session_platform

_ATOM_TYPES = frozenset(
    {"episodic", "factual", "relational", "preference", "planned", "routine", "opinion"}
)
# 助手自身状态/意愿不是「关于用户的记忆」，总结结果里出现这些主语就丢弃
_ASSISTANT_SUBJECT = re.compile(
    r"^\s*(?:助手|机器人|bot|ai|我)\b|助手(?:对|的|希望|想|觉得|认为|承诺|答应)|"
    r"(?:助手|bot|机器人)(?:偏好|喜欢|讨厌|希望|认为)"
)

def _salvage_fields(cand: str) -> dict[str, Any] | None:
    """最后一招：JSON 语法坏了也把常见字段抠出来（宁可要半成品，也不要"画像没生成"）。

    真机踩过：模型返回的字符串里有真实换行，json.loads 直接失败。
    """
    out: dict[str, Any] = {}
    keys = ["one_line", "identity", "traits", "likes", "dislikes", "topics", "relation", "events", "notes"]
    for k in keys:
        m = re.search(chr(34) + k + chr(34) + r"\s*[:：]\s*(\[[^\]]*\]|\{[^}]*\}|" + chr(34) + r"[^" + chr(34) + r"]*" + chr(34) + r"|[^,}\n]+)", cand, re.S)
        if not m:
            continue
        raw = m.group(1).strip()
        if raw.startswith("["):
            items = [x.strip().strip(chr(34)).strip() for x in raw.strip("[]").split(",")]
            out[k] = [x for x in items if x]
        elif raw.startswith("{"):
            inner = _salvage_fields(raw) or {}
            out[k] = [inner] if inner else []
        else:
            out[k] = raw.strip(chr(34)).strip()
    return out or None


def _repair_json(cand: str) -> str:
    """修模型常犯的几种 JSON 毛病：字符串里的真实换行/制表、全角标点、尾逗号。"""
    t = "".join((ch if ch >= " " or ch == chr(10) else " ") for ch in cand)
    t = t.replace(chr(10), " ").replace(chr(13), " ").replace(chr(9), " ")   # 字符串里的换行 → 空格
    t = t.replace(chr(0x201c), chr(34)).replace(chr(0x201d), chr(34))                 # 全角引号
    t = t.replace(chr(0xff1a), ":").replace(chr(0xff0c), ",")               # 全角冒号/逗号
    t = re.sub(r",\s*}", "}", t)
    t = re.sub(r",\s*]", "]", t)
    return t


_BAD_FIELD = ""


def _clean_text(v: Any, limit: int = 400) -> str:
    """字段级清洗：丢了坏值/坏转义（真机上出现过只剩一个反斜杠的字段），不改变含义。"""
    s = str(v if v is not None else "").strip()
    if not s:
        return ""
    # 只剩标点/反斜杠/空白 → 判为坏值（模型坏转义留下的残渣）
    # 坏值只判「没有任何实义字符（字母/数字/符号）」：纯标点/反斜杠才算坏。
    # 这样 emoji、♥ 这类合法昵称字符不会被误杀（红队实测过），坏转义残渣仍会被丢弃。
    if not any(unicodedata.category(ch)[0] in ("L", "N", "S") for ch in s):
        return ""
    if s.count(chr(92)) >= max(4, len(s) // 3):     # 反斜杠密度过高才算坏转义
        s = s.replace(chr(92), "")
    s = s.strip()
    return s[:limit]


def _clean_list(v: Any, limit: int = 30) -> list[str]:
    out: list[str] = []
    for x in (v if isinstance(v, list) else ([v] if v else [])):
        s = _clean_text(x, 120)
        if s and s not in out:
            out.append(s)
    return out[:limit]


def _clean_events(v: Any, limit: int = 24) -> list[dict[str, str]]:
    """events 必须是对象数组；模型常给「字符串化的 JSON 对象」或纯字符串（真机实测）。"""
    out: list[dict[str, str]] = []
    for x in (v if isinstance(v, list) else ([v] if v else [])):
        if isinstance(x, dict):
            when, what = _clean_text(x.get("when"), 60), _clean_text(x.get("what"), 240)
        elif isinstance(x, str):
            s = x.strip()
            when = what = ""
            if s.startswith("{"):
                try:
                    d = json.loads(s)
                    if isinstance(d, dict):
                        when, what = _clean_text(d.get("when"), 60), _clean_text(d.get("what"), 240)
                except Exception:
                    what = ""
            what = what or _clean_text(s, 240)
        else:
            continue
        if what:
            out.append({"when": when, "what": what})
    return out[:limit]


def _sanitize_profile(body: Any, pid: str = "", name: str = "") -> dict[str, Any]:
    """画像落库前的最后一道闸：字段级清洗 + 不泄漏内部 id（人物 id 不该出现在给人看的正文里）。"""
    b = body if isinstance(body, dict) else {}
    out: dict[str, Any] = {
        "one_line": _clean_text(b.get("one_line"), 120),
        "identity": _clean_text(b.get("identity"), 200),
        "traits": _clean_list(b.get("traits")),
        "likes": _clean_list(b.get("likes")),
        "dislikes": _clean_list(b.get("dislikes")),
        "topics": _clean_list(b.get("topics")),
        "relation": _clean_text(b.get("relation"), 500),
        "events": _clean_events(b.get("events")),
        "notes": _clean_text(b.get("notes"), 500),
    }
    pid = str(pid or "")
    if pid:
        # 只替换「人物 id xxx」这类整词；别把正文里恰好相同的短子串一起改，
        # 也绝不臆造性别代词（name 为空就用中性的「该联系人」）。
        safe = name or "该联系人"
        for k in ("one_line", "identity", "relation", "notes"):
            v = str(out.get(k) or "")
            if pid and pid in v:
                v = re.sub(r"(人物[ \t]*id|ID|id)[ \t:：]*" + re.escape(pid), safe, v)
                v = re.sub(r"(?<![0-9A-Za-z_])" + re.escape(pid) + r"(?![0-9A-Za-z_])", safe, v)
                out[k] = v
    return out


def _sanitize_group_profile(body: Any, gid: str = "", name: str = "") -> dict[str, Any]:
    """群聊画像落库前的字段级清洗（与人物画像同思路：只留白名单字段，号不进正文）。"""
    b = body if isinstance(body, dict) else {}
    members: list[dict[str, Any]] = []
    for m in (b.get("members") or [])[:40]:
        if not isinstance(m, dict):
            continue
        who = _clean_text(m.get("who"), 60)
        if not who:
            continue
        members.append({"who": who, "role": _clean_text(m.get("role"), 160),
                        "n": _clean_text(m.get("n"), 20)})
    out: dict[str, Any] = {
        "one_line": _clean_text(b.get("one_line"), 120),
        "kind": _clean_text(b.get("kind"), 80),
        "atmosphere": _clean_text(b.get("atmosphere"), 400),
        "topics": _clean_list(b.get("topics")),
        "members": members,
        "norms": _clean_list(b.get("norms")),
        "relation": _clean_text(b.get("relation"), 500),
        "notes": _clean_text(b.get("notes"), 500),
    }
    gid = str(gid or "")
    if gid:
        safe = name or "该群"
        for kk in ("one_line", "kind", "atmosphere", "relation", "notes"):
            v = str(out.get(kk) or "")
            if gid and gid in v:
                v = re.sub(r"(群[ \t]*号|群[ \t]*id|ID|id)[ \t:：]*" + re.escape(gid), safe, v)
                v = re.sub(r"(?<![0-9A-Za-z_])" + re.escape(gid) + r"(?![0-9A-Za-z_])", safe, v)
                out[kk] = v
    return out


def _json_block(text: str) -> dict[str, Any] | None:
    """从模型输出里抠出 JSON 对象，三级容错：严格 → 修复 → 正则抠字段。

    不要用 rfind("}")：模型常在 JSON 后面又补一句带花括号的话，那样切出来的不是合法 JSON。
    """
    t = str(text or "").strip()
    t = t.replace("```json", "").replace("```JSON", "").replace("```", "").strip()
    start = t.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    cand = ""
    for i in range(start, len(t)):
        ch = t[i]
        if in_str:
            if esc:
                esc = False
            elif ch == chr(92):
                esc = True
            elif ch == chr(34):
                in_str = False
            continue
        if ch == chr(34):
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                cand = t[start:i + 1]
                break
    if not cand:
        return None
    for attempt in (cand, _repair_json(cand)):
        try:
            out = json.loads(attempt)
            if isinstance(out, dict):
                return out
        except Exception:
            continue
    return _salvage_fields(cand)


DEFAULT_CONFIG: dict[str, Any] = {
    "master_switch": True,
    # 3D 图谱控制台的界面配置（布局/镜头/配色/参数…）：前端每改一次自动写回这里，刷新不丢
    "graph_ui": {},
    "gate_enabled": True,
    "gate_shadow": True,
    "gate_threshold": 80,
    "gate_window_seconds": 20,
    "memory_inject_enabled": True,
    "memory_inject_top_k": 5,
    "memory_inject_budget_tokens": 600,
    "memory_decay_half_life_days": 21,
    "memory_evict_below": 0.08,
    "memory_persona_isolated": True,
    "session_context_enabled": True,
    "memory_capture_enabled": True,
    "memory_capture_turns": 6,
    "memory_capture_min_interval": 300,
    "memory_capture_max_per_run": 5,
    # 跨会话动作留痕：bot 借工具（含第三方工具类插件）在别的会话里发了什么，这里留台账 +
    # 在相关会话注入知会，并在记忆库留一条（避免「问它谁让你发的，它答不知道」）。
    "cross_session_enabled": True,
    "cross_session_ttl_min": 120,
    "cross_session_memory": True,
    "memory_summary_prompt": "",     # 记忆总结自定义提示词（空 = 用内置；支持 {transcript} 占位）
    # 插件自管任务的系统提示词覆盖（留空 = 用内置默认；面板「模型分配」可展开编辑）
    "sys_prompt_memory_summary": "",
    "sys_prompt_expression_extract": "",
    "sys_prompt_person_profile": "",
    # 群聊画像：与 service.TASK_PROMPTS["group_profile"] 一一对应。
    # 以前只在 _conf_schema.json 里登记、这里漏了 → main.py 的「采纳原生配置」循环
    # 遍历的是 DEFAULT_CONFIG，于是跳过它，AstrBot 原生插件配置页里填的值永远不生效
    # （只有面板 prompt/save 旁路能写，双源行为不一致 = 假控件）。
    "sys_prompt_group_profile": "",
    "sys_prompt_persona_evolve": "",
    "sys_prompt_forget": "",
    "favour_enabled": True,
    "favour_settle_mode": "tag",
    "favour_daily_cap": 15,              # 好感日上限：当天正增量累计到此封顶（0 = 不限）
    "favour_daily_half_life_days": 0,    # 好感 daily 的半衰期天数（0 = 关闭衰减；库里配了值就以库里的为准）
    "favour_tag_required": True,         # 必须带好感标签才结算；关掉则无标签也按 +1
    "expression_enabled": True,
    "expression_min_uses": 3,            # 表达习惯至少生效过 N 次才算"已验证"（没达标的只在名额没用满时补位）
    # 输出拟人（分段发送 + 打字延迟）：默认全关，开了才动行为
    # 下面这四个键以前没进 DEFAULT_CONFIG：原生页能改、但面板保存会被静默丢弃、新装也没有默认值。
    "output_enabled": True,              # 输出收拾总开关（压缩空行 / 剥离好感标记）
    "output_typo_mode": "off",            # 错字拟人档位：off / light / medium
    "output_split_messages": True,      # 长回复拆成多条发（按语义边界切，短句不拆）
    "output_typing_delay": True,         # 补发的后续条目按"打字时长"延迟（首条立即发）
    "output_typing_per_char": 0.3,       # 每个字的打字秒数
    "output_typing_max": 6,            # 单条最多等这么多秒
    "sticker_slot": "off",                # 表情包目录（预留槽位：回复出现 [表情] 时随机发一张；off=关闭）
    "voice_slot": "off",                  # 语音槽位：TTS provider id 或 session=跟随会话；off=关闭
    "persona_active_id": "",
    "proactive_enabled": False,
    "proactive_shadow": True,
    "proactive_idle_min": 120,
    "proactive_daily_cap": 3,             # 每会话每天（自然日 0:00–23:59，按 AstrBot 时区）最多主动几条
    "proactive_min_interval_min": 90,
    "proactive_quiet_start": "23:30",
    "proactive_quiet_end": "08:00",
    "proactive_min_zone": "FAMILIAR",
    "proactive_last_only": False,
    "proactive_style": "自然地开一句话题，短、不追问、不解释自己为什么开口",
    # 主动名单跟可见性一样：每个范围一种模式（white=只对这些主动 / black=只对这些不主动）
    "proactive_mode_group": "white",
    "proactive_mode_private": "white",
    "proactive_auto_wl": "off",
    "proactive_wl_private": [],
    "proactive_bl_private": [],
    "proactive_wl_group": [],
    "proactive_bl_group": [],
    "proactive_use_persona": True,
    "proactive_context_memories": 3,
    "proactive_lists_enabled": True,      # 主动名单总开关（代码在 service 里读它，以前没有默认值 = 库里丢键就静默变行为）
    # ---- 基础名单（可见性）：黑名单里的群/人 = 对 bot 完全不存在 ----
    # 这是「主动消息名单」的地基：主动只能在这个可见集合里再收窄，不会给它扩容。
    # 可见性名单只有两种：black（名单内对 bot 不存在）/ white（只有名单内可见）
    # 默认 white + 空名单 = 一开始谁都不打扰，由你显式放行（面板会红字提醒）
    "conn_mode_group": "white",
    "conn_mode_private": "white",
    "conn_black_group": [],
    "conn_white_group": [],
    "conn_black_private": [],
    "conn_white_private": [],
    # 人物画像里要排除的 id（bot 自己会自动识别并落库，这里留着手工兜底）
    "person_exclude_ids": [],
    # 平台边界：可记录 = OneBot（QQ）实例 + AstrBot 自带 WebChat（ChatUI），两者都自动认得；
    # track_platforms 用来额外放行别的平台实例 id。
    # person_exclude_platforms 是排除名单（默认只排除 webui）；想让 ChatUI 也进记忆就把它从名单里删掉，
    # 想反过来让 ChatUI 对插件不可见，就把 "webchat" 加回来 —— 代码里不再写死任何平台。
    "track_platforms": [],
    "person_exclude_platforms": ["webui"],
    "recall_handling": "log_only",
    "recall_weaken_factor": 0.3,
    "recall_keep_days": 30,
    "recall_withdraw_reply": False,      # 撤回时连 bot 那份回复的本地痕迹一起撤（语料/待总结轮次）
    "recall_interrupt_reply": True,      # 撤回时打断"还在生成中"的那条回复（内容已作废，说完也白说）
    # 撤回反应（用户撤回一条消息 → **当场**走主动通道起一轮，让模型自己决定说什么/装没看见）
    "recall_react_enabled": False,        # 开关（面板「撤回」板块）
    "recall_react_group": "related",      # 群聊范围：related=只对与 bot 有互动的消息 / all=群里任何人都触发 / off=群聊不触发
    "recall_react_images": True,          # 把被撤回的图片一并交给模型看（原生多模态，最多 2 张）
    "recall_react_extra": "",             # 追加在撤回通知后面的自定义指示（留空=不加）
    "import_layers": ["documents", "atoms"],
    # 六个任务的模型分配：空字符串 = 跟随会话当前模型，只有显式选择才锁定
    # 人格自动进化（详细说明在 _conf_schema.json；面板也能改）
    "evolve_auto": True,
    "evolve_min_hours": 24,
    "evolve_min_memories": 6,
    "evolve_scope": "desc_style",
    "evolve_require_confirm": True,
    "evolve_pending_ttl_hours": 72,      # 待审提案超过这么多小时自动作废（不再永久阻塞进化）
    # 运行时时间戳（面板显示用，不在配置界面里暴露）
    "persona_last_evolve_at": 0.0,
    "persona_last_save_at": 0.0,
    # 任务 × 模型分配：空字符串 = 跟随会话当前模型，只有显式选择才锁定
    "model_memory_summary": "",
    "model_expression_extract": "",
    "model_person_profile": "",   # 画像生成（人物 L0 / 群聊 L1 共用；留空 = 跟随会话当前模型）
    "model_persona_evolve": "",   # 人格进化提案：留空 = 跟随会话当前模型（可锁便宜模型，不影响对话链路）
    "model_embedding": "",
    # 自动遗忘：久未被提及 → 归档；归档后再久未被提及且不重要 → 遗忘
    "forget_enabled": True,
    "archive_after_days": 30,
    "forget_after_days": 30,
    "forget_min_strength": 0.35,
    "forget_keep_poignancy": 8,
    "forget_batch_per_tick": 20,
    "model_forget": "",            # 记忆遗忘评估：配了就让模型判断"哪条真该忘"（见 lifecycle_tick）
    "auto_import_external": True,
    "model_rerank": "",            # 召回结果重排：配了就把召回候选交给它重排
    # 门控退避：连发到一定密度就安静一会儿（base 秒起步、指数增长、上限 max 秒；base=0 关闭）
    "gate_backoff_base": 15,
    "gate_backoff_max": 300,
    # ---- 补齐 9 个「只在面板生效」的开关 ----
    # 这些键原先没登记进默认配置表，而 save_config/seed 都以本表为准，
    # 于是面板/配置页改完也不生效（真·死开关），这里补全。
    "vision_enabled": True,          # 聊天里的图片也进记忆
    "vision_max_images": 4,          # 单条消息最多处理几张图（控成本）
    "profile_auto": True,            # 人物画像自动补齐
    "profile_min_memories": 5,       # 至少积累多少条记忆才自动生成
    "profile_refresh_hours": 72,     # 多久刷新一次
    "profile_batch_per_tick": 2,     # 每轮后台最多生成几个
    "burst_merge_enabled": True,     # 同一人连发多条时合并成一次回复
    "burst_merge_window": 3.0,       # 连发合并窗口（秒）
    "burst_merge_group": False,      # 群聊也按人合并（默认只私聊合并）
}

ZONE_TEXT = {
    "DEVOTED": "可以撒娇、可以主动、可以占话题",
    "CLOSE": "可以亲昵、可以未 @ 接话、能开玩笑、深夜也秒回",
    "FAMILIAR": "正常参与、有梗就接、不主动私聊",
    "NEUTRAL": "被点名才答、礼貌但不热络",
    "COLD": "字数极简、不主动追问",
    "HOSTILE": "字数极简、被点名才开口、不带情绪波动",
}

PersonaProvider = Callable[..., Awaitable[Any]]



# 各域面板只暴露引擎真正读取的配置键（避免出现假开关）
CONFIG_DOMAINS: dict[str, list[str]] = {
    "gate": ["gate_enabled", "gate_shadow", "gate_threshold", "gate_window_seconds"],
    "memory": ["memory_summary_prompt", "memory_inject_enabled", "memory_inject_top_k", "memory_inject_budget_tokens",
               "memory_decay_half_life_days", "memory_evict_below",
               "memory_capture_enabled", "memory_capture_turns",
               "memory_capture_min_interval", "memory_capture_max_per_run",
               "cross_session_enabled", "cross_session_ttl_min", "cross_session_memory"],
    "expression": ["expression_enabled", "expression_min_uses"],
    "favour": ["favour_enabled", "favour_settle_mode", "favour_daily_cap", "favour_daily_half_life_days", "favour_tag_required"],
    "recall": ["recall_handling", "recall_weaken_factor", "recall_keep_days", "recall_withdraw_reply",
               "recall_interrupt_reply",
               "recall_react_enabled", "recall_react_group", "recall_react_images", "recall_react_extra"],
    "proactive": ["proactive_enabled", "proactive_shadow", "proactive_idle_min", "proactive_daily_cap",
                  "proactive_min_interval_min", "proactive_quiet_start", "proactive_quiet_end",
                  "proactive_min_zone", "proactive_last_only", "proactive_style",
                  "proactive_mode_group", "proactive_mode_private",
                  "proactive_auto_wl", "proactive_wl_private",
                  "proactive_bl_private", "proactive_wl_group", "proactive_bl_group",
                  "proactive_use_persona", "proactive_context_memories"],
    "output": ["output_split_messages", "output_typing_delay", "output_typing_per_char", "output_typing_max", ],
    "persona": ["persona_active_id"],
    "contacts": ["conn_mode_group", "conn_black_group", "conn_white_group",
                 "track_platforms", "person_exclude_platforms",
                 "conn_mode_private", "conn_black_private", "conn_white_private",
                 "person_exclude_ids"],
    "master": ["master_switch", "session_context_enabled"],
}
ZONE_RANK = {"HOSTILE": 0, "COLD": 1, "NEUTRAL": 2, "FAMILIAR": 3, "CLOSE": 4, "DEVOTED": 5}

# ---------------- 原生白名单快照（名单/可见性统一来源） ----------------
_NATIVE_SYS: dict[str, Any] = {"provider": None}


def _native_vis() -> dict[str, Any] | None:
    """取 AstrBot 原生白名单；桥未注册/读取失败 → None（调用方退回旧逻辑，不放大权限）。"""
    fn = (_NATIVE_SYS.get("provider") or {}).get("native_visibility_read")
    if not callable(fn):
        return None
    try:
        nat = fn() or {}
        if nat.get("err"):
            return None
        return {"enable": bool(nat.get("enable")), "ids": [str(x) for x in (nat.get("ids") or [])]}
    except Exception:                                           # noqa: BLE001
        return None


def contact_ids(contacts: Any) -> list[str]:
    """把平台联系人结构摊平成 id 列表。

    ⚠️ 真机踩过的坑（2026-10-11）：``system["contacts"]`` 返回的是 **dict**
    ``{platforms, groups, friends, admins, bots, errors, member_names,
       admin_in_friends, admin_not_in_friends}``。
    黑名单写回分支曾直接 ``for row in contacts`` 迭代 —— dict 迭代拿到的是 **键名**，
    于是这 9 个键名被当成"联系人"写进了 AstrBot 原生白名单（真机 id_whitelist 里就躺着它们）。
    """
    out: list[str] = []

    def push(value: Any) -> None:
        s = str(value or "").strip()
        if s and s not in out:
            out.append(s)

    if isinstance(contacts, dict):
        for key in ("friends", "groups", "admins", "bots"):
            for row in (contacts.get(key) or []):
                if isinstance(row, str):
                    push(row)
                elif isinstance(row, dict):
                    push(row.get("user_id") or row.get("group_id") or row.get("id") or row.get("ident"))
    elif isinstance(contacts, (list, tuple, set)):
        for row in contacts:
            if isinstance(row, str):
                push(row)
            elif isinstance(row, dict):
                push(row.get("id") or row.get("ident") or row.get("user_id") or row.get("group_id"))
    return out


# 联系人结构体的键名：它们**不是**会话 id，任何写名单的路径都不该收
CONTACT_SHAPE_KEYS = {
    "platforms", "groups", "friends", "admins", "bots", "errors",
    "member_names", "admin_in_friends", "admin_not_in_friends",
}


class StarHeartService:
    def __init__(
        self,
        store: Store,
        data_root: str | Path,
        persona_provider: dict[str, PersonaProvider] | None = None,
        system_provider: dict[str, PersonaProvider] | None = None,
    ) -> None:
        self.store = store
        self.importer = LivingMemoryImporter(store, data_root)
        self.persona = persona_provider or {}
        self.system = system_provider or {}
        _NATIVE_SYS["provider"] = self.system      # 供 classmethod visible() 读原生白名单
        self._import_task: asyncio.Task | None = None
        self._import_state: dict[str, Any] = {"phase": "idle"}
        self._import_subs: list[asyncio.Queue] = []
        self._import_watch = False

    # ---------------- 配置 ----------------

    # ---------------- 撤回 ----------------
    async def recalls(self, limit: int = 200) -> dict[str, Any]:
        return {"items": await self.store.list_recalls(limit), "config": await self.config()}

    async def handle_recall(self, info: dict[str, Any]) -> dict[str, Any]:
        """用户撤回了消息：命中记忆就降权标 stale，否则只记录事件。"""
        cfg = await self.config()
        ref = str(info.get("message_id") or "")
        mode = str(cfg.get("recall_handling") or "log_only")
        if mode not in ("log_only", "weaken", "archive", "delete"):
            mode = "log_only"                               # 非法值不静默变形，按最保守的 log_only
        if mode == "delete":                                # 兼容旧值：真删 → 归档
            mode = "archive"
        matched = 0
        action = "log_only"
        if ref:
            hits = await self.store.memories_by_source_ref(ref)
            ids = [h["id"] for h in hits]
            if ids and mode == "weaken":
                matched = await self.store.mark_memories_stale(
                    ids, float(cfg.get("recall_weaken_factor") or 0.3)
                )
                action = "weaken_memories"
            elif ids and mode == "archive":      # 注意：上面已把旧值 delete 归一成 archive，
                                                 # 这里再判 delete 会让归档分支变成死代码（已踩过）

                # 用户定：不物理删除，改成归档（可在面板「复活历史记忆」找回，被提及也会自动拉回）
                matched = await self.store.archive_memories(ids, float(cfg.get("recall_weaken_factor") or 0.3))
                action = "archive_memories"
            else:
                matched = len(ids)                         # log_only：命中数照报，一条都不动
        entry = {
            "session_id": info.get("session_id") or "",
            "user_id": info.get("user_id") or "",
            "notice_type": info.get("notice_type") or "",
            "message_id": ref,
            "operator_id": info.get("operator_id") or "",
            "matched": matched,
            "action": action,
            "detail": {
                "handling": mode,
                "weaken_factor": cfg.get("recall_weaken_factor"),
                # 撤回正文（谁 + 撤回了什么 + 图片网址）：面板要显示完整内容，不是只记一条流水
                "recalled": info.get("recalled") or {},
            },
        }
        await self.store.log_recall(entry)
        await self.store.audit("recall.handle", f"{entry['notice_type']} matched={matched}")
        return {"matched": matched, "action": action}

    async def recall_log_cleanup(self) -> int:
        """撤回流水按 recall_keep_days 滚动清理（原配置存了但从未执行）。"""
        cfg = await self.config()
        days = float(cfg.get("recall_keep_days") or 30)
        if days <= 0:
            return 0
        cutoff = time.time() - days * 86400
        cur = await self.store.db.execute("DELETE FROM hf_recall_log WHERE ts < ?", (cutoff,))
        await self.store.db.commit()
        return int(cur.rowcount or 0)

    # ---------------- 主动消息名单（私聊/群聊各自独立） ----------------
    @staticmethod
    def session_kind(session_id: str) -> tuple[str, str]:
        """会话字符串 platform:MessageType:id → ("group"|"private", id)。

        WebChat 尾段 `webchat!<用户名>!<会话id>` → 归一化成用户名（账户名才是「人」）。
        """
        parts = str(session_id or "").split(":")
        if len(parts) >= 3:
            mtype, ident = parts[-2].lower(), parts[-1]
            if ident.lower().startswith("webchat!") and ident.count("!") >= 2:
                ident = ident.split("!")[1].strip() or ident
            if "group" in mtype:
                return "group", ident
            if "friend" in mtype or "private" in mtype:
                return "private", ident
            return "other", ident
        return "other", str(session_id or "")

    # ---------------- 基础名单（可见性）：黑名单里的群/人对 bot 完全不存在 ----------------
    @staticmethod
    def _conn_keys(kind: str, mode: str) -> str:
        """kind: group|private，mode: black|white → 配置键名。"""
        k = "group" if kind == "group" else "private"
        m = "black" if mode == "black" else "white"
        return f"conn_{m}_{k}"

    @classmethod
    def visible(cls, kind: str, ident: str, cfg: dict[str, Any], platform: str = "") -> tuple[bool, str]:
        """这个群/这个人对 bot 是否「存在」。

        ``platform``：会话的平台实例 id。**webchat（ChatUI）不受名单约束** —— 它是操作者自己的
        控制台，而白名单是按 QQ 号/群号组织的（里面根本没有它的账户名，面板也选不出来）。
        ChatUI 进不进插件由平台级开关 person_exclude_platforms 决定（见 main._is_trackable_session）。

        **判定来源 = AstrBot 原生白名单**（平台配置 → 白名单），插件只做筛选、不另存第二份。
        原生语义：**未启用 / 名单为空 = 全部放行（等于不触发）**；启用且非空 = 仅名单内可见。

        黑名单：名单内 → 不存在；
        白名单：名单外 → 不存在（名单为空 = 谁都不存在，宁可让用户先明确授权）；
        off：全都存在。
        """
        if kind not in ("group", "private"):
            return True, ""
        if not ident:
            return True, ""
        if str(platform or "").strip().lower() == "webchat":
            return True, "webchat（ChatUI 控制台）不受名单约束"
        nat = _native_vis()
        if nat is not None:
            if not nat["enable"] or not nat["ids"]:
                return True, "原生白名单未启用/为空（全部放行）"
            if str(ident) in set(nat["ids"]):
                return True, "在原生白名单里"
            return False, "不在原生白名单里"
        # ↓↓ 以下为桥不可用时的退回逻辑（与旧行为完全一致，不放大权限）
        # 只有黑名单/白名单两种模式；历史值 "off" 归一成白名单（与面板一致，
        # 否则界面显示白名单、后端却按「全部可见」放行，说的和做的不一样）
        mode = str(cfg.get(f"conn_mode_{kind}") or "white").lower()
        if mode not in ("black", "white"):
            mode = "white"
        ids = [str(x) for x in (cfg.get(cls._conn_keys(kind, mode)) or [])]
        if not ident:
            return True, ""
        if mode == "black":
            if ident in ids:
                return False, "在可见性黑名单里"
            return True, ""
        if ident in ids:
            return True, ""
        return False, ("可见性白名单为空（谁都不回）" if not ids else "不在可见性白名单里")

    async def contact_filter(self) -> dict[str, Any]:
        """基础名单现状：模式 + 两份名单 + 每个平台联系人的「可见/不可见」判定。"""
        cfg = await self.config()
        out: dict[str, Any] = {"modes": {}, "black": {}, "white": {}, "counts": {}, "hidden": {}}
        for kind in ("group", "private"):
            mode = str(cfg.get(f"conn_mode_{kind}") or "white").lower()
            if mode not in ("black", "white"):
                mode = "white"
            black = [str(x) for x in (cfg.get(self._conn_keys(kind, "black")) or [])]
            white = [str(x) for x in (cfg.get(self._conn_keys(kind, "white")) or [])]
            out["modes"][kind] = mode
            out["black"][kind] = black
            out["white"][kind] = white
            out["counts"][kind] = {"black": len(black), "white": len(white)}
            # 白名单为空 = 谁都看不到：面板要能一眼看见这个「静默」状态
            out.setdefault("silent", {})[kind] = bool(mode == "white" and not white)
        try:
            hidden = await self.store.hidden_contacts()
            out["hidden"] = {"group": hidden.get("group", []), "private": hidden.get("private", [])}
        except Exception:
            out["hidden"] = {"group": [], "private": []}
        # 给平台名单打分（面板直接显示「可见/不可见」），并把昵称/群名一并带上
        verdicts: dict[str, Any] = {}
        names: dict[str, str] = {}
        try:
            data = await self.contacts(False)
            for kind, rows in (("group", data.get("groups") or []), ("private", data.get("friends") or [])):
                for row in rows:
                    ident = str(row.get("id") or row.get("group_id") or row.get("user_id") or "")
                    if not ident:
                        continue
                    # 好友的名称字段是 nickname / remark，群里是 name —— 只认 name 就会满屏号码
                    label = str(row.get("name") or row.get("nickname") or row.get("remark") or "").strip()
                    if label:
                        names[f"{kind}:{ident}"] = label
                    vis, why = self.visible(kind, ident, cfg, platform=str(row.get("platform") or ""))
                    verdicts[f"{kind}:{ident}"] = {"visible": vis, "why": why, "name": label}
        except Exception:
            pass
        out["verdicts"] = verdicts
        out["names"] = names
        return out

    async def set_contact_filter(self, kind: str, mode: str, ids: list[str]) -> dict[str, Any]:
        """整表写入某一边的名单（面板就是「多选 → 确定」这一步）。"""
        if kind not in ("group", "private"):
            raise ValueError(f"unknown kind: {kind}")
        mode = str(mode or "white").lower()
        if mode not in ("black", "white"):
            raise ValueError(f"unknown mode: {mode}")
        clean: list[str] = []
        _junk: list[str] = []
        for x in ids or []:
            x = str(x).strip()
            if not x:
                continue
            if x in CONTACT_SHAPE_KEYS:               # ← 结构体键名不是会话 id，永远不收
                _junk.append(x)
                continue
            if x not in clean:
                clean.append(x)
        if _junk:
            logger.warning(
                f"[StarHeart] 名单里混进了联系人结构体键名，已丢弃：{', '.join(_junk)}"
                "（0.50.1 及更早版本黑名单写回的 bug；原生白名单里若残留，删掉即可）"
            )
        await self.store.set_config(f"conn_mode_{kind}", mode)
        # ★ 原生白名单是「群号 + 用户号」共用一份列表：保存前先取回本类（kind）的旧条目，
        #   写回时只替换本类的、其他类原样保留 —— 否则保存私聊会把群聊名单整表冲掉。
        _prev_cur: list[str] = []
        for _m in ("white", "black"):
            try:
                _old = await self.store.get_config(self._conn_keys(kind, _m), []) or []
                _prev_cur += [str(x) for x in _old]
            except Exception:                                  # noqa: BLE001
                pass
        await self.store.set_config(self._conn_keys(kind, mode), clean)
        # ★ 名单统一写 AstrBot 原生那份（platform_settings.enable_id_white_list / id_whitelist）：
        #   白名单卡 = 勾选者直接进白名单；黑名单卡 = 勾选者**不进**白名单、其余全部进（= 选中者被挡）。
        #   插件只做筛选入口、不再自留第二份真相；写失败只记日志，本地兼容数据照旧保留。
        fn = self.system.get("native_visibility_write")
        if callable(fn):
            try:
                native_now = []
                rfn = self.system.get("native_visibility_read")
                if callable(rfn):
                    native_now = [str(x) for x in ((rfn() or {}).get("ids") or [])]
                if mode == "black":
                    # 黑名单 = 从原生列表里「剔除」勾选者；没勾选的原样保留（不重建、更不清空）。
                    # 例：之前「群聊白名单全选」存过一批，现在在黑名单卡勾它 → 就从名单里删掉。
                    native_ids = list(native_now)
                    for _x in _prev_cur:
                        if _x not in native_ids:
                            native_ids.append(_x)
                    try:
                        cfn = self.system.get("contacts")
                        allc = await cfn() if callable(cfn) else {}
                        # contacts() 是 dict，必须摊平（曾经直接迭代 dict → 9 个键名被写进原生白名单）
                        for _id in contact_ids(allc):
                            if _id and _id not in native_ids:
                                native_ids.append(_id)
                    except Exception as exc:                        # noqa: BLE001
                        logger.warning(f"[StarHeart] 黑名单取联系人失败（不影响剔除，名单不会被清空）：{exc}")
                    native_ids = [x for x in native_ids if x not in set(clean)]
                else:
                    # 白名单 = 勾选者进名单；只替换本类旧条目，其他类（另一种 kind）原样保留。
                    native_ids = [x for x in native_now if x not in set(_prev_cur)]
                    native_ids += [x for x in clean if x not in set(native_ids)]
                logger.info(f"[StarHeart] 原生白名单写回：mode={mode} kind={kind} 本类旧={len(_prev_cur)} 勾选={len(clean)} 原生旧={len(native_now)} 合计={len(native_ids)}")
                r = await fn(True, native_ids)
                logger.info(f"[StarHeart] 名单已写原生白名单：mode={mode} kind={kind} 勾选={len(clean)} 原生={len(native_ids)} ok={bool((r or {}).get('ok'))}")
            except Exception as exc:                                # noqa: BLE001
                logger.warning(f"[StarHeart] 写原生白名单失败（本地记录已保留）：{exc}")
        await self.store.audit(f"contacts.set_{kind}_{mode}", f"{len(clean)} 项")
        # 原实现是一句 `self.store.invalidate_config() if hasattr(...) else None`：
        # storage 里从来没有 invalidate_config 这个方法 → hasattr 恒假 → 死代码。
        # 配置缓存失效有真实入口（set_config 内部自己刷新），这里不需要也别留假调用。
        return await self.contact_filter()

    def _list_key(self, kind: str, mode: str) -> str:
        return f"proactive_{'wl' if mode == 'allow' else 'bl'}_{'group' if kind == 'group' else 'private'}"

    @staticmethod
    def _auto_wl_allows(auto_mode: str, kind: str, zone: str) -> bool:
        """「自动白名单」策略判定 —— 让面板三选项 off / close / familiar 都能走到分支。

        close    = 只自动放行已经亲近的人（好感档 CLOSE 及以上）
        familiar = 熟人就放行（FAMILIAR 及以上）
        both / group / private = 旧配置的兼容值，按会话类型放行
        """
        if auto_mode in ("", "off"):
            return False
        if auto_mode == "close":
            return ZONE_RANK.get(zone, 2) >= ZONE_RANK["CLOSE"]
        if auto_mode == "familiar":
            return ZONE_RANK.get(zone, 2) >= ZONE_RANK["FAMILIAR"]
        return auto_mode in ("both", kind)

    @staticmethod
    def proactive_mode(cfg: dict[str, Any], kind: str) -> str:
        """主动名单模式：white（只对名单内主动，默认）/ black（只对名单内不主动）。"""
        k = "group" if kind == "group" else "private"
        mode = str(cfg.get(f"proactive_mode_{k}") or "").lower()
        if mode in ("black", "white"):
            return mode
        # 老配置迁移：以前是「全局白名单开关 + 两份名单」，
        # 若当时关了白名单且填过拦截名单，语义等于「黑名单模式」，别让它一夜之间全禁。
        if cfg.get("proactive_lists_enabled") is False and (cfg.get(f"proactive_bl_{k}") or []):
            return "black"
        return "white"

    async def _whitelist_sessions(self, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        """白名单里显式点过的会话（哪怕没聊过）也纳入候选——否则名单没意义。"""
        if self.proactive_mode(cfg, "group") != "white" and self.proactive_mode(cfg, "private") != "white":
            return []
        platform = ""
        try:
            fn = self.system.get("contacts")
            if callable(fn):
                data = await fn(False)
                bots = data.get("bots") or []
                if bots:
                    platform = str(bots[0].get("platform") or "")
        except Exception:
            platform = ""
        platform = platform or "aiocqhttp"
        out: list[dict[str, Any]] = []
        for kind, key in (("group", "proactive_wl_group"), ("private", "proactive_wl_private")):
            if self.proactive_mode(cfg, kind) != "white":
                continue
            for ident in (cfg.get(key) or []):
                ident = str(ident).strip()
                if not ident:
                    continue
                mtype = "GroupMessage" if kind == "group" else "FriendMessage"
                out.append({
                    "session_id": f"{platform}:{mtype}:{ident}",
                    "user_id": "" if kind == "group" else ident,
                    "last_user_ts": 0.0, "msgs": 0, "sent_today": 0, "last_proactive_ts": 0.0,
                    "from_whitelist": True,
                })
        return out

    async def contact_names(self) -> dict[str, str]:
        """把平台联系人整理成 {"group:群号": 群名, "private:QQ": 昵称}。

        为什么要它：面板上到处只显示 QQ 号/群号，一屏数字谁也认不出是谁 ——
        昵称和群名才是「一眼辨别」的关键（好友的字段是 nickname/remark，群是 name，别只认 name）。
        """
        names: dict[str, str] = {}
        try:
            data = await self.contacts(False)
            for kind, rows, key in (("group", data.get("groups") or [], "group_id"), ("private", data.get("friends") or [], "user_id")):
                for row in rows:
                    ident = str(row.get(key) or row.get("id") or "").strip()
                    if not ident:
                        continue
                    label = str(row.get("name") or row.get("nickname") or row.get("remark") or "").strip()
                    if label:
                        names[f"{kind}:{ident}"] = label
        except Exception:
            pass
        try:
            for fav in await self.store.list_favours():
                uid = str(fav.get("user_id") or "").strip()
                if uid and fav.get("name") and f"private:{uid}" not in names:
                    names[f"private:{uid}"] = str(fav["name"])
        except Exception:
            pass
        return names

    async def proactive_rules(self) -> dict[str, Any]:
        cfg = await self.config()
        rules = {
            "modes": {k: self.proactive_mode(cfg, k) for k in ("group", "private")},
            "base_modes": {k: (str(cfg.get(f"conn_mode_{k}") or "white") if str(cfg.get(f"conn_mode_{k}") or "white") in ("black", "white") else "white") for k in ("group", "private")},
            "base_black": {k: [str(x) for x in (cfg.get(self._conn_keys(k, "black")) or [])] for k in ("group", "private")},
            "base_white": {k: [str(x) for x in (cfg.get(self._conn_keys(k, "white")) or [])] for k in ("group", "private")},
            "auto_wl": str(cfg.get("proactive_auto_wl") or "off"),
            "wl_private": list(cfg.get("proactive_wl_private") or []),
            "bl_private": list(cfg.get("proactive_bl_private") or []),
            "wl_group": list(cfg.get("proactive_wl_group") or []),
            "bl_group": list(cfg.get("proactive_bl_group") or []),
        }
        base = await self.store.proactive_baseline(self._day_start_ts(cfg))
        names = await self.contact_names()
        rules["names"] = names
        # —— 候选宇宙：聊过的会话 ∪ 平台联系人（好友 + 群）——
        # 用户口径（2026-10-11）：「原名单默认是空，那么主动消息黑白名单会显示所有用户和群聊」。
        # 原名单（可见性）空 = 谁都在 → 名单页就该把所有人都摆出来让你挑，
        # 而不是只显示「已开启主动」的几个、其余藏进按钮里（旧行为，用户反馈显示不正常）。
        peers: dict[tuple[str, str], dict[str, Any]] = {}
        try:
            ct = await self.contacts()
        except Exception as exc:                            # noqa: BLE001 联系人拿不到不影响名单页
            logger.debug(f"[StarHeart] 主动名单取联系人失败：{exc}")
            ct = {}
        # 原生白名单非空 → 候选只保留名单内的（空 = 全部放行，下面照旧全显示）
        _nat = _native_vis()
        _allow_ids: set[str] = set()
        if _nat and _nat.get("enable") and _nat.get("ids"):
            _allow_ids = {str(x) for x in _nat["ids"]}
        for kind, rows, id_keys in (
            ("group", ct.get("groups") or [], ("group_id", "id")),
            ("private", ct.get("friends") or [], ("user_id", "id")),
        ):
            for row in rows:
                ident = ""
                for k in id_keys:
                    ident = str(row.get(k) or "").strip()
                    if ident:
                        break
                if not ident:
                    continue
                if _allow_ids and ident not in _allow_ids:
                    continue                                     # 原生名单外：不显示（也就不会被勾到）
                label = str(row.get("name") or row.get("nickname") or row.get("remark") or "").strip()
                if label:
                    names.setdefault(f"{kind}:{ident}", label)
                peers[(kind, ident)] = row
        judged = []
        for item in base.get("sessions", []):
            sid = str(item.get("session_id") or "")
            # ChatUI（webchat）是操作者自己的控制台 / 测试通道，不是「会被主动打扰的人」——
            # 名单里不显示、也不参与主动（用户原话：正经人谁拿这个聊天，都是用来测功能的）。
            if sid.split(":", 1)[0].strip().lower() == "webchat":
                continue
            kind, ident = self.session_kind(sid)
            if _allow_ids and ident and ident not in _allow_ids:
                continue                                         # 原生名单外的会话不进候选（已失效）
            verdict, why = self._judge(kind, ident, rules, cfg, sid.split(":", 1)[0])
            judged.append({"session_id": item.get("session_id"), "kind": kind, "id": ident,
                           "name": names.get(f"{kind}:{ident}", ""),
                           "verdict": verdict, "why": why,
                           "msgs": item.get("msgs", 0), "idle_min": item.get("idle_min", 0),
                           "sent_today": item.get("sent_today", 0), "user_id": item.get("user_id", "")})
        # 联系人里「还没聊过」的也要出现在名单上（勾上保存就能进白名单）
        _seen = {(x["kind"], x["id"]) for x in judged}
        for (kind, ident), _row in peers.items():
            if (kind, ident) in _seen:
                continue
            _seen.add((kind, ident))
            verdict, why = self._judge(kind, ident, rules, cfg)
            judged.append({
                "session_id": "", "kind": kind, "id": ident,
                "name": names.get(f"{kind}:{ident}", ""), "verdict": verdict, "why": why,
                "msgs": 0, "idle_min": 0, "sent_today": 0, "user_id": "", "no_history": True,
            })
        # 名单里保存过、但既不在会话里也不在联系人里的（典型：原生名单一收窄，它就掉出去了）
        # 必须**由后端给出真实判定**再展示 —— 前端旧实现对这些行硬编码 verdict=allow（"名单里显式添加"），
        # 于是「已失效」的条目在界面上仍显示成「可主动」（面板说能发、实际发不出）。
        # 展示成「被拦 · 已失效」而不是隐藏：① 一眼看懂发生了什么；② 行还在，才能取消勾选保存来清理。
        for _key, _kind in (("wl_private", "private"), ("bl_private", "private"),
                            ("wl_group", "group"), ("bl_group", "group")):
            for _ident in (rules.get(_key) or []):
                _ident = str(_ident).strip()
                if not _ident or (_kind, _ident) in _seen:
                    continue
                _seen.add((_kind, _ident))
                _verdict, _why = self._judge(_kind, _ident, rules, cfg)
                judged.append({
                    "session_id": "", "kind": _kind, "id": _ident,
                    "name": names.get(f"{_kind}:{_ident}", ""), "verdict": _verdict, "why": _why,
                    "msgs": 0, "idle_min": 0, "sent_today": 0, "user_id": "", "from_list": True,
                })
        rules["sessions"] = judged
        rules["allowed"] = sum(1 for x in judged if x["verdict"] == "allow")
        rules["blocked"] = sum(1 for x in judged if x["verdict"] == "deny")
        return rules

    def _judge(self, kind: str, ident: str, rules: dict[str, Any],
               cfg: dict[str, Any] | None = None, platform: str = "") -> tuple[str, str]:
        """判定一个会话在**主动名单**下的结论。

        用户口径（2026-10-11，两次拍板后的最终版）：
        · 主动名单自己回答「能不能主动开口」（白名单外 / 黑名单内 = 拦）；
        · **AstrBot 原生白名单是地基**（实时只读，不缓存、不镜像）：
          - 原生未启用 / 名单为空 = 全部放行（等于不触发）→ 主动名单说了算；
          - 原生名单非空 = 只在名单内收窄 → 名单外的会话在主动这里一并**自动失效**
            （哪怕它之前被保存进过主动名单：用户口径「插件会自动读到并进行失效」）。
        为什么必须实时读：名单页与心跳都走这一个函数 —— 原生名单一动，两边同时跟着变，不会各说各话。
        """
        if cfg is not None and ident:
            try:
                _ok, _why = self.visible(kind, ident, cfg, platform=platform)
            except Exception:                                    # noqa: BLE001 原生读失败不放大权限
                _ok, _why = True, ""
            if not _ok:
                return "deny", f"{_why}（主动名单已自动失效）"
        k = "group" if kind == "group" else "private"
        bl = [str(x) for x in (rules.get(f"bl_{k}") or [])]
        wl = [str(x) for x in (rules.get(f"wl_{k}") or [])]
        mode = str((rules.get("modes") or {}).get(k) or "white").lower()
        if mode not in ("black", "white"):
            mode = "white"
        if mode == "black":
            if ident and ident in bl:
                return "deny", "在主动黑名单里"
            return "allow", ""
        # 白名单模式：名单为空 = 谁都不主动（避免误扰）
        # ⚠️ 「不在白名单里」这五个字是 auto_wl（自动加白）的判据字符串，改文案前先搜 _auto_wl_allows 的调用处
        if ident not in wl:
            return "deny", ("主动白名单为空（谁都不主动）" if not wl else "不在白名单里")
        return "allow", ""

    async def proactive_set(self, kind: str, mode: str, ids: list[str]) -> dict[str, Any]:
        """面板「多选 + 保存」：一次写模式 + 该模式的名单（另一份名单留着，切回来不丢）。"""
        if kind not in ("group", "private"):
            raise ValueError(f"unknown kind: {kind}")
        mode = str(mode or "white").lower()
        if mode not in ("black", "white"):
            raise ValueError(f"unknown mode: {mode}")
        clean: list[str] = []
        for x in ids or []:
            x = str(x).strip()
            if x and x not in clean:
                clean.append(x)
        await self.store.set_config(f"proactive_mode_{kind}", mode)
        key = "proactive_wl_" + kind if mode == "white" else "proactive_bl_" + kind
        await self.store.set_config(key, clean)
        await self.store.audit(f"proactive.set_{kind}_{mode}", f"{len(clean)} 项")
        return await self.proactive_rules()

    async def rule_bulk(self, kind: str, action: str, ids: list[str]) -> dict[str, Any]:
        """多选确认：整表替换该名单。action: allow | deny。"""
        if action not in ("allow", "deny"):
            raise ValueError(f"unknown action: {action}")
        if kind not in ("group", "private"):
            raise ValueError(f"unknown kind: {kind}")
        wl_key, bl_key = self._list_key(kind, "allow"), self._list_key(kind, "deny")
        clean = []
        for x in ids or []:
            x = str(x).strip()
            if x and x not in clean:
                clean.append(x)
        cfg = await self.config()
        if action == "allow":
            await self.store.set_config(wl_key, clean)
            # 二选一：进了白名单的自动从黑名单移除
            await self.store.set_config(bl_key, [x for x in (cfg.get(bl_key) or []) if str(x) not in clean])
        else:
            await self.store.set_config(bl_key, clean)
            await self.store.set_config(wl_key, [x for x in (cfg.get(wl_key) or []) if str(x) not in clean])
        await self.store.audit(f"proactive.bulk_{action}", f"{kind}:{len(clean)}")
        return await self.proactive_rules()

    async def rule_set(self, kind: str, ident: str, action: str) -> dict[str, Any]:
        """action: allow（进白名单，并从黑名单移除）| deny（进黑名单，并从白名单移除）| clear（两个都清）。"""
        if not ident:
            raise ValueError("missing id")
        cfg = await self.config()
        wl_key, bl_key = self._list_key(kind, "allow"), self._list_key(kind, "deny")
        wl = [str(x) for x in (cfg.get(wl_key) or [])]
        bl = [str(x) for x in (cfg.get(bl_key) or [])]
        wl = [x for x in wl if x != ident]
        bl = [x for x in bl if x != ident]
        if action == "allow":
            wl.append(ident)
        elif action == "deny":
            bl.append(ident)
        elif action != "clear":
            raise ValueError(f"unknown action: {action}")
        await self.store.set_config(wl_key, wl)
        await self.store.set_config(bl_key, bl)
        await self.store.audit(f"proactive.{action}", f"{kind}:{ident}")
        return await self.proactive_rules()

    # ---------------- 主动消息 ----------------
    async def proactive_view(self, limit: int = 200) -> dict[str, Any]:
        cfg = await self.config()
        day_start = self._day_start_ts(cfg)
        baseline = await self.store.proactive_baseline(day_start)
        plan = await self.store.get_config("proactive_plan", {}) or {}
        date = self._day_str(cfg)
        raw = plan.get("slots") or []
        slots = ([float(x) for x in raw if isinstance(x, (int, float)) and float(x) > 0]
                 if str(plan.get("date") or "") == date else [])
        return {
            "items": await self.store.list_proactive(limit),
            "sessions": baseline["sessions"],
            "candidates": baseline["candidates"],
            "config": {k: cfg.get(k) for k in CONFIG_DOMAINS["proactive"]},
            "plan": {"date": str(plan.get("date") or ""), "today": date, "cap": plan.get("cap"),
                     "slots": slots, "day_start": day_start, "day_end": day_start + 86400.0},
        }

    def _tzinfo(self, cfg: dict[str, Any]):
        """解析时区：AstrBot 全局配置 → 插件配置 → None（退回本机）。静默时段与「一天」边界共用。"""
        tz_name = ""
        fn = self.system.get("timezone")
        if callable(fn):
            try:
                tz_name = str(fn() or "")
            except Exception:
                tz_name = ""
        tz_name = tz_name or str(cfg.get("timezone") or "")
        if tz_name:
            try:
                from zoneinfo import ZoneInfo

                return ZoneInfo(tz_name)
            except Exception:
                pass
        return None

    def timezone(self, cfg: dict[str, Any]):
        """对外别名：插件各处要「按 AstrBot 时区」算时间时统一走它（容器时区常见是 UTC）。"""
        return self._tzinfo(cfg)

    def _day_start_ts(self, cfg: dict[str, Any], now_ts: float | None = None) -> float:
        """「今天」从哪一刻算：本地（AstrBot 时区）自然日 00:00。
        用户口径（2026-10-12）：一天按 0:00–23:59 计，不是滚动 24 小时。"""
        from datetime import datetime

        ts = time.time() if now_ts is None else now_ts
        tz = self._tzinfo(cfg)
        d = datetime.fromtimestamp(ts, tz) if tz is not None else datetime.fromtimestamp(ts)
        return d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

    def _day_str(self, cfg: dict[str, Any], now_ts: float | None = None) -> str:
        """本地自然日的 YYYY-MM-DD（好感日上限的记账键，必须与 _day_start_ts 同一时区）。"""
        from datetime import datetime

        ts = time.time() if now_ts is None else now_ts
        tz = self._tzinfo(cfg)
        d = datetime.fromtimestamp(ts, tz) if tz is not None else datetime.fromtimestamp(ts)
        return d.strftime("%Y-%m-%d")

    def _now_hhmm(self, cfg: dict[str, Any]) -> str:
        """当前钟点：优先用 AstrBot 配置的时区（容器常见是 UTC，直接用会误判静默时段）。"""
        from datetime import datetime

        tz = self._tzinfo(cfg)
        if tz is not None:
            return datetime.now(tz).strftime("%H:%M")
        return time.strftime("%H:%M", time.localtime())

    def _quiet_now(self, cfg: dict[str, Any], now_hhmm: str) -> bool:
        start = str(cfg.get("proactive_quiet_start") or "")
        end = str(cfg.get("proactive_quiet_end") or "")

        def mins(t: str) -> int | None:
            try:
                h, m = t.split(":")
                return int(h) * 60 + int(m)
            except (ValueError, AttributeError):
                return None

        s_m, e_m = mins(start), mins(end)
        cur = mins(now_hhmm)
        if s_m is None or e_m is None or cur is None:
            return False
        if s_m <= e_m:
            return s_m <= cur < e_m
        return cur >= s_m or cur < e_m  # 跨午夜

    # ---------------- 主动开口排布（当天随机时间点） ----------------
    # 机制：不再「最小间隔一到就发」——每天先把 N 个开口时间点排好（N=每日上限，
    # 落在当天 0:00–23:59 里随机分布、避开静默时段），扫描只在「到点了」才尝试开口；
    # 改上限 / 跨天自动重排；被更晚时间点追上的旧时间点按「错过」作废。
    @staticmethod
    def _hm_to_min(v: Any) -> int | None:
        m = re.match(r"^(\d{1,2}):(\d{2})$", str(v or "").strip())
        if not m:
            return None
        h, mi = int(m.group(1)), int(m.group(2))
        return h * 60 + mi if 0 <= h < 24 and 0 <= mi < 60 else None

    def _day_segments(self, cfg: dict[str, Any], day_start: float) -> list[tuple[float, float]]:
        """当天可开口时段 = 全天 − 静默时段（静默可为跨午夜区间）。"""
        day_end = day_start + 86400.0
        segs: list[tuple[float, float]] = [(day_start, day_end)]
        s_m = self._hm_to_min(cfg.get("proactive_quiet_start"))
        e_m = self._hm_to_min(cfg.get("proactive_quiet_end"))
        if s_m is not None and e_m is not None and s_m != e_m:
            qsegs = ([(day_start + s_m * 60.0, day_start + e_m * 60.0)] if s_m < e_m
                     else [(day_start, day_start + e_m * 60.0), (day_start + s_m * 60.0, day_end)])
            for q0, q1 in qsegs:
                nxt: list[tuple[float, float]] = []
                for a, b in segs:
                    if q1 <= a or q0 >= b:
                        nxt.append((a, b))
                        continue
                    if a < q0:
                        nxt.append((a, q0))
                    if q1 < b:
                        nxt.append((q1, b))
                segs = nxt
        return [(a, b) for a, b in segs if b - a > 60]

    def _gen_slots(self, cfg: dict[str, Any], n: int, lo: float, hi: float, day_start: float) -> list[float]:
        """在 [lo, hi] ∩ 可开口时段里随机排 n 个时间点：分层采样，整段分散、不扎堆。"""
        avail = [(max(a, lo), min(b, hi)) for a, b in self._day_segments(cfg, day_start)]
        avail = [(a, b) for a, b in avail if b - a > 30]
        total = sum(b - a for a, b in avail)
        if n <= 0 or total <= 60:
            return []
        n = min(n, max(1, int(total // 300)))  # 两位至少隔 5 分钟，排不下就少排
        slots: list[float] = []
        for i in range(n):
            t0, t1 = total * i / n, total * (i + 1) / n
            w = t1 - t0
            target = random.uniform(t0 + w * 0.15, t1 - w * 0.15) if w > 120 else random.uniform(t0, t1)
            acc = 0.0
            ts = avail[-1][1] - 1.0
            for a, b in avail:
                if target <= acc + (b - a):
                    ts = a + (target - acc)
                    break
                acc += b - a
            slots.append(round(ts, 1))
        slots.sort()
        return slots

    async def _plan_sent_today(self, day_start: float) -> int:
        """今天已真发出几条（不含手动试发）——排布余量的记数源。"""
        row = await (await self.store.db.execute(
            "SELECT COUNT(*) FROM hf_proactive_log WHERE status='sent' AND ts >= ? "
            "AND guard NOT LIKE '%\"manual\"%'", (day_start,)
        )).fetchone()
        return int(row[0] or 0) if row else 0

    async def _plan_ensure(self, cfg: dict[str, Any], now_ts: float) -> dict[str, Any]:
        """取/刷新今天的开口排布。触发重排：新的一天、每日上限变化。"""
        day_start = self._day_start_ts(cfg, now_ts)
        date = self._day_str(cfg, now_ts)
        cap = max(0, int(cfg.get("proactive_daily_cap") or 0))
        sent = await self._plan_sent_today(day_start)
        need = max(0, cap - sent)
        plan = await self.store.get_config("proactive_plan", {}) or {}
        raw = plan.get("slots") or []
        slots = [float(x) for x in raw if isinstance(x, (int, float)) and float(x) > 0]
        changed = False
        if str(plan.get("date") or "") != date or int(plan.get("cap") or -1) != cap:
            # 新的一天 / 上限变了：按「当前使用之后的剩余量」重排剩余时间条
            slots = self._gen_slots(cfg, need, max(now_ts, day_start), day_start + 86400.0, day_start)
            changed = True
        else:
            while len(slots) >= 2 and now_ts >= slots[1]:
                slots.pop(0)  # 被更晚时间点追上的：按「错过」作废
                changed = True
            if len(slots) > need:
                slots = slots[:need]
                changed = True
        if changed:
            plan = {"date": date, "cap": cap, "slots": slots, "gen_ts": now_ts}
            await self.store.set_config("proactive_plan", plan)
        return {"date": date, "cap": cap, "slots": slots}

    async def _plan_consume(self) -> dict[str, Any]:
        """一个开口真的发出去了：消耗最早的那个（也就是刚到的）时间点。"""
        plan = await self.store.get_config("proactive_plan", {}) or {}
        slots = [float(x) for x in (plan.get("slots") or []) if isinstance(x, (int, float))]
        if slots:
            slots.pop(0)
        plan["slots"] = slots
        await self.store.set_config("proactive_plan", plan)
        return plan

    def _ts_hhmm(self, cfg: dict[str, Any], ts: float) -> str:
        from datetime import datetime

        tz = self._tzinfo(cfg)
        d = datetime.fromtimestamp(ts, tz) if tz is not None else datetime.fromtimestamp(ts)
        return d.strftime("%H:%M")

    async def proactive_scan(self) -> dict[str, Any]:
        """真扫一遍：够格的说一句（影子模式只落候选）。"""
        cfg = await self.config()
        # 语义：总开关关掉 = 不扫；主动关掉但还在影子模式 = 仍旧扫（方便在面板看候选）。
        if not cfg.get("master_switch") or (
            cfg.get("proactive_enabled") is False and not cfg.get("proactive_shadow")
        ):
            return {"scanned": 0, "candidates": 0, "sent": 0, "skipped": 0}
        # skip 流水按天滚动：扫描每分钟跑一次，不清理会把库撑爆
        cutoff = time.time() - 7 * 86400
        await self.store.db.execute(
            "DELETE FROM hf_proactive_log WHERE status IN ('skipped','candidate') AND ts < ?", (cutoff,)
        )
        await self.store.db.commit()
        baseline = await self.store.proactive_baseline(self._day_start_ts(cfg))
        favours = {str(f.get("user_id") or ""): f for f in await self.store.list_favours()}
        now_ts = time.time()
        plan = await self._plan_ensure(cfg, now_ts)
        due_ts: float | None = float(plan["slots"][0]) if plan.get("slots") else None
        hhmm = self._now_hhmm(cfg)
        quiet = self._quiet_now(cfg, hhmm)
        min_rank = ZONE_RANK.get(str(cfg.get("proactive_min_zone") or "FAMILIAR"), 3)
        sent = skipped = cands = 0
        max_idle = float(cfg.get("proactive_idle_min") or 120)
        sessions = baseline["sessions"]
        known = {str(x.get("session_id") or "") for x in sessions}
        for extra in await self._whitelist_sessions(cfg):
            if extra["session_id"] not in known:
                sessions.append(extra)
                known.add(extra["session_id"])
        if cfg.get("proactive_last_only"):
            # last_only 只裁剪「历史会话」，白名单是手工点过的显式授权，不能被裁掉
            history = [x for x in sessions if not x.get("from_whitelist")]
            if history:
                history = sorted(history, key=lambda x: x.get("last_user_ts") or 0, reverse=True)[:1]
            sessions = history + [x for x in sessions if x.get("from_whitelist")]
        rules = await self.proactive_rules()
        auto_mode = str(cfg.get("proactive_auto_wl") or "off")
        for item in sessions:
            idle_min = (now_ts - float(item.get("last_user_ts") or 0)) / 60.0
            _sid2 = str(item.get("session_id") or "")
            kind, ident = self.session_kind(_sid2)
            verdict, why = self._judge(kind, ident, rules, cfg, _sid2.split(":", 1)[0])
            fav = favours.get(str(item.get("user_id") or "")) or {}
            zone = str(fav.get("zone") or "NEUTRAL")
            # 自动白名单：互动过的会话（有过发言）自动放进白名单，省得手工加。
            # 老代码只认 auto_mode in ("both", kind)，而面板 select 给的是 off/close/familiar
            # → 选 close 或 familiar 全都等于没开（静默失效），真正有效的 both 又没有入口。
            # 现在按好感档位实现这两档，both/group/private 保留为旧配置兼容值。
            if (
                verdict == "deny"
                and why == "不在白名单里"
                and int(item.get("msgs") or 0) >= 1
                and self._auto_wl_allows(auto_mode, kind, zone)
            ):
                await self.rule_set(kind, ident, "allow")
                verdict, why = "allow", "自动加入白名单"
            guard: dict[str, Any] = {
                "idle_min": round(idle_min, 1), "quiet": quiet, "kind": kind, "id": ident,
                "sent_today": item.get("sent_today", 0), "cap": cfg.get("proactive_daily_cap"),
                "verdict": verdict, "why": why,
            }
            if verdict == "deny":
                skipped += 1
                if cfg.get("proactive_shadow"):
                    await self.store.log_proactive({
                        "session_id": item["session_id"], "user_id": item.get("user_id") or "",
                        "zone": zone, "idle_min": idle_min, "score": 0.0,
                        "status": "skipped", "reason": f"名单拦截：{why}", "guard": guard,
                    })
                continue
            guard["zone"] = zone
            guard["due"] = round(due_ts) if due_ts else None
            reason = ""
            if due_ts is None:
                reason = "今日预定开口已排完"
            elif now_ts < due_ts:
                reason = f"未到预定开口时间（下次 {self._ts_hhmm(cfg, due_ts)}）"
            elif idle_min < max_idle:
                reason = f"距上次发言 {idle_min:.0f} 分钟 < {max_idle:.0f}"
            elif quiet:
                reason = "静默时段"
            elif int(item.get("sent_today") or 0) >= int(cfg.get("proactive_daily_cap") or 3):
                reason = "今日已达上限"
            elif (now_ts - float(item.get("last_proactive_ts") or 0)) / 60.0 < float(cfg.get("proactive_min_interval_min") or 90):
                reason = "距上次主动未到最小间隔"
            elif ZONE_RANK.get(zone, 2) < min_rank:
                reason = f"关系区间 {zone} 低于 {cfg.get('proactive_min_zone')}"
            if reason:
                skipped += 1
                # 无论影子与否都记录 skip 原因：面板「被挡下的原因」要有据可查
                await self.store.log_proactive({
                    "session_id": item["session_id"], "user_id": item.get("user_id") or "",
                    "zone": zone, "idle_min": idle_min, "score": 0.0,
                    "status": "skipped", "reason": reason, "guard": guard,
                })
                continue
            score = round(min(100.0, idle_min / max(1.0, max_idle) * 30 + ZONE_RANK.get(zone, 2) * 12), 1)
            cands += 1
            if cfg.get("proactive_shadow") or not cfg.get("proactive_enabled"):
                await self.store.log_proactive({
                    "session_id": item["session_id"], "user_id": item.get("user_id") or "",
                    "zone": zone, "idle_min": idle_min, "score": score,
                    "status": "candidate", "reason": "影子模式：够格但未发送", "guard": guard,
                })
                continue
            text = await self._proactive_text(item, zone, cfg)
            ok = False
            send = self.system.get("send_proactive")
            if text and callable(send):
                ok = bool(await send(item["session_id"], text))
            await self.store.log_proactive({
                "session_id": item["session_id"], "user_id": item.get("user_id") or "",
                "zone": zone, "idle_min": idle_min, "score": score,
                "status": "sent" if ok else "failed", "reason": "" if ok else "发送失败",
                "guard": guard, "text": text,
            })
            sent += 1 if ok else 0
            if ok:
                plan = await self._plan_consume()
                _left = [float(x) for x in (plan.get("slots") or []) if isinstance(x, (int, float))]
                due_ts = _left[0] if _left else None
        return {"scanned": len(sessions), "candidates": cands, "sent": sent, "skipped": skipped, "quiet": quiet, "next_open": due_ts}

    async def _build_proactive_prompt(self, item: dict[str, Any], zone: str, cfg: dict[str, Any]) -> dict[str, Any]:
        """拼出真正发给模型的东西：人格（可选）+ 情境 + 记忆。"""
        kind, ident = self.session_kind(item.get("session_id") or "")
        limit = max(0, int(cfg.get("proactive_context_memories") or 3))
        memories: list[str] = []
        if limit:
            rows = await (await self.store.db.execute(
                "SELECT summary FROM hf_memories WHERE session_id=? AND status='active' ORDER BY updated_at DESC LIMIT ?",
                (str(item.get("session_id") or ""), limit),
            )).fetchall()
            memories = [str(r["summary"]).strip() for r in rows if r["summary"]]
        persona_text = ""
        agent_system = ""
        contexts: list[Any] = []
        if cfg.get("proactive_use_persona", True):
            # 首选：AstrBot 那份**拼好的完整系统提示词**（人格 + 技能 + 安全 + 全局前缀），
            # 也就是「对话回复」实际吃到的那一份 —— 主动开口本质是对话回复，必须同一份。
            fn_agent = self.system.get("agent_prompt")
            if callable(fn_agent):
                try:
                    got = await fn_agent(str(item.get("session_id") or "")) or {}
                except Exception:
                    got = {}
                agent_system = str(got.get("system") or "")
                contexts = list(got.get("contexts") or [])
            if not agent_system.strip():
                # 该会话还没说过话（缓存为空/已过期）→ 退回只取人格，并在返回值里如实标明来源
                fn = self.system.get("persona_text")
                if callable(fn):
                    try:
                        persona_text = str(await fn() or "")
                    except Exception:
                        persona_text = ""
        style = str(cfg.get("proactive_style") or "自然地开一句话题，短、不追问")
        base_sys = agent_system.strip() or persona_text.strip()
        system = ((base_sys + "\n\n") if base_sys else "")
        system += (
            "【本轮情境】你正在主动给对方发消息，不是回复任何消息。\n"
            f"关系区间：{zone} · 当前语气线：{engine.tone_line(zone)}\n"
            f"距对方上次说话约 {round(float(item.get('idle_min') or 0))} 分钟。\n"
            "本轮没有任何工具、技能或函数可调用：不要输出工具调用、不要输出 JSON/代码块/思考过程。\n"
            "硬要求：只输出你要发送的那一句话；口语化、简短；不要解释、不要加引号、"
            "不要用括号写动作、不要说“在吗”、不要提醒对方回复你。"
        )
        user = f"开口风格：{style}。" + (
            f"可以参考这些记忆：{'；'.join(m[:40] for m in memories)}。" if memories else "（这个会话还没有可参考的记忆）"
        )
        source = "astrbot" if agent_system.strip() else ("persona" if persona_text.strip() else "none")
        return {
            "system": system, "user": user, "memories": memories, "contexts": contexts,
            "persona_used": bool(base_sys), "prompt_source": source, "kind": kind,
        }

    async def _proactive_text(self, item: dict[str, Any], zone: str, cfg: dict[str, Any]) -> str:
        gen = self.system.get("llm_generate")
        if not callable(gen):
            return ""
        built = await self._build_proactive_prompt(item, zone, cfg)
        self._last_prompt = built
        out = await gen(built["user"], "proactive", built["system"], contexts=built.get("contexts"),
                        umo=str(item.get("session_id") or ""))
        return str(out or "").strip().strip('"')[:200]

    async def proactive_preview(self, session_id: str, zone: str = "NEUTRAL") -> dict[str, Any]:
        """只生成不发送：把「实际发给模型的东西」也一并返回，面板可展开看。"""
        cfg = await self.config()
        idle = 0.0
        try:
            base = await self.store.proactive_baseline(self._day_start_ts(cfg))
            for item in base.get("sessions", []):
                if item.get("session_id") == session_id:
                    idle = (time.time() - float(item.get("last_user_ts") or 0)) / 60.0
        except Exception:
            pass
        built = await self._build_proactive_prompt({"session_id": session_id, "idle_min": idle}, zone, cfg)
        gen = self.system.get("llm_generate")
        if not callable(gen):
            return {"ok": False, "error": "模型通道不可用", "system_prompt": built["system"], "user_prompt": built["user"]}
        started = time.time()
        text = await gen(built["user"], "proactive", built["system"], contexts=built.get("contexts"),
                         umo=str(session_id or ""))
        text = str(text or "").strip().strip('"')[:200]
        return {
            "ok": bool(text), "text": text, "zone": zone, "idle_min": round(idle, 1),
            "ms": int((time.time() - started) * 1000),
            "system_prompt": built["system"][:1500], "user_prompt": built["user"][:800],
            "memories_used": len(built["memories"]), "persona_used": built["persona_used"], "kind": built["kind"],
            # prompt_source：astrbot = 用的就是 AstrBot 拼好的完整提示词；persona = 该会话还没说过话，只取到人格；
            # none = 都没取到（主动消息会吃不到人格，面板据此标红）
            "prompt_source": built.get("prompt_source", "none"),
            "contexts_used": len(built.get("contexts") or []),
            "error": "" if text else "模型没有返回内容（这个声音由会话当前模型决定）",
        }


    # ---------------- 撤回反应（用户撤回一条消息 → 当场走主动通道起一轮） ----------------
    #
    # 用户拍板（2026-10-11）：走主动消息通道、用户在聊天里**看不出区别**（就是一条普通消息）、
    # 无视主动消息名单（proactive_wl_*/bl_*/mode_*）—— 因为这是「用户刚发了一条消息」的等价物，
    # 而不是主动搭话；因此也不受免打扰/日上限限制。可见性名单（原生白名单）照常管，不破原生限制。
    RECALL_REACT_SILENT = "[沉默]"          # 模型用它表示"这轮不说话"
    RECALL_REACT_MAX_IMGS = 2

    async def _recall_neighbors(self, session_id: str, ts: float) -> tuple[bool, bool]:
        """被撤回消息的前/后一条是不是 bot 发的（群聊判「与 bot 有互动」用）。"""
        prev_bot = next_bot = False
        try:
            row = await (await self.store.db.execute(
                "SELECT is_bot FROM hf_messages WHERE session_id=? AND ts<? ORDER BY ts DESC LIMIT 1",
                (session_id, float(ts or 0)),
            )).fetchone()
            prev_bot = bool(row and int(row["is_bot"] or 0))
            row = await (await self.store.db.execute(
                "SELECT is_bot FROM hf_messages WHERE session_id=? AND ts>? ORDER BY ts ASC LIMIT 1",
                (session_id, float(ts or 0)),
            )).fetchone()
            next_bot = bool(row and int(row["is_bot"] or 0))
        except Exception:                                       # noqa: BLE001
            return False, False
        return prev_bot, next_bot

    async def recall_react(self, info: dict[str, Any]) -> dict[str, Any]:
        """撤回反应入口：跑一轮，然后把「模型的决定 + 说的话」写回那条撤回流水（面板显示）。"""
        res = await self._recall_react_impl(info)
        if not (isinstance(res, dict) and res.get("skipped") == "dup"):
            mid = str(info.get("message_id") or "")
            if mid:
                try:
                    await self.store.attach_recall_react(mid, {
                        "at": time.time(),
                        "said": bool(res.get("sent")),
                        "silent": bool(res.get("silent")),
                        "text": str(res.get("text") or "")[:300],
                        "ms": int(res.get("ms") or 0),
                        "skip": str(res.get("skipped") or ""),
                        "error": str(res.get("error") or "")[:120],
                    })
                except Exception as exc:                        # noqa: BLE001
                    logger.debug(f"[StarHeart] 撤回反应落流水跳过：{exc}")
        return res

    async def _recall_react_impl(self, info: dict[str, Any]) -> dict[str, Any]:
        """撤回反应：把「这条消息已被撤回（含正文/图片）」**当场**交给模型，由它决定说什么。

        链路：撤回事件 → 可见性/范围判定 → 组包（AstrBot 完整 agent 提示词 + 本轮原始消息=撤回通知）
              → 会话当前模型生成（原生多模态带上被撤回的图）→ 模型说就说、[沉默] 就不发 → 记流水。
        """
        try:
            cfg = await self.config()
        except Exception:                                       # noqa: BLE001
            cfg = {}
        if not cfg.get("master_switch", True):
            return {"ok": False, "skipped": "master-off"}
        if not cfg.get("recall_react_enabled", False):
            return {"ok": False, "skipped": "disabled"}
        sid = str(info.get("session_id") or "")
        mid = str(info.get("message_id") or "")
        if not sid or not mid:
            return {"ok": False, "skipped": "no-session"}
        # 同一条只反应一次（防重复触发，不是频率限制——用户要求不限频）
        seen = getattr(self, "_recall_reacted", None)
        if seen is None:
            seen = self._recall_reacted = []
        if mid in seen:
            return {"ok": False, "skipped": "dup"}
        seen.append(mid)
        del seen[:-64]
        kind, ident = self.session_kind(sid)
        # 可见性：原生的名单判定照常走（webchat 例外在 visible 内部处理）—— 不破原生限制
        try:
            vis_ok, why = self.visible(kind, ident, cfg, platform=session_platform(sid))
        except Exception:                                       # noqa: BLE001
            vis_ok, why = True, ""
        if not vis_ok:
            logger.info(f"[StarHeart] 撤回反应跳过：该目标{why}")
            return {"ok": False, "skipped": "invisible"}
        # 群聊范围：related = 只对与 bot 有互动的消息反应（前后一条是 bot 发言）
        if kind == "group":
            mode = str(cfg.get("recall_react_group") or "related").lower()
            if mode in ("off", "none", "false"):
                return {"ok": False, "skipped": "group-off"}
            if mode != "all":
                recalled0 = info.get("recalled") or {}
                ts = float(recalled0.get("ts") or 0)
                if not ts:
                    found = await self.store.find_message_by_ext_id(f"qq:{mid}")
                    ts = float((found or {}).get("ts") or 0)
                prev_bot, next_bot = await self._recall_neighbors(sid, ts)
                if not ts or not (prev_bot or next_bot):
                    logger.info("[StarHeart] 撤回反应跳过：群消息与 bot 无互动")
                    return {"ok": False, "skipped": "group-not-related"}
        # 组包：AstrBot 那份拼好的完整系统提示词（人格 + 技能 + 上下文）
        recalled = info.get("recalled") or {}
        who = str(recalled.get("sender_name") or recalled.get("sender") or "").strip()
        text = str(recalled.get("text") or "").strip()
        img_all = [str(u) for u in (recalled.get("imgs") or []) if str(u).strip()]
        imgs = img_all[: self.RECALL_REACT_MAX_IMGS] if cfg.get("recall_react_images", True) else []
        agent_system = ""
        contexts: list[Any] = []
        fn_agent = self.system.get("agent_prompt")
        if callable(fn_agent):
            try:
                got = await fn_agent(sid) or {}
                agent_system = str(got.get("system") or "")
                contexts = list(got.get("contexts") or [])
            except Exception:                                   # noqa: BLE001
                pass
        if not agent_system.strip():
            fn = self.system.get("persona_text")
            if callable(fn):
                try:
                    agent_system = str(await fn() or "")
                except Exception:                               # noqa: BLE001
                    agent_system = ""
        if not agent_system.strip():
            # 吃不到 AstrBot 提示词的调用不许参与对话链路（用户红线）→ 宁可不动
            logger.warning("[StarHeart] 撤回反应跳过：取不到 AstrBot 提示词（会话还没说过话？）")
            return {"ok": False, "skipped": "no-prompt"}
        what = text or (f"（图片 {len(img_all)} 张）" if img_all else "（内容未留存）")
        extra = str(cfg.get("recall_react_extra") or "").strip()
        notice = (
            "【系统通知】当前消息已被用户撤回 —— 它已经不算数了，不要再当成有效上下文。\n"
            f"撤回的人：{who or '对方'}\n"
            f"被撤回的内容：{what}\n"
            + (f"（随本轮附上被撤回的图片 {len(imgs)} 张，你可以直接看）\n" if imgs else "")
            + (extra + "\n" if extra else "")
            + "要不要回应、怎么回应（装没看见 / 追问 / 调侃 / 认错 / 什么都不说）完全由你决定；"
              "想说话就直接输出要发的那句话（口语化、别解释）；不想说话就只输出 " + self.RECALL_REACT_SILENT + "。"
        )
        gen = self.system.get("llm_generate")
        if not callable(gen):
            return {"ok": False, "error": "模型通道不可用"}
        started = time.time()
        try:
            out = await gen(notice, "recall_react", agent_system,
                            image_urls=imgs or None, contexts=contexts, umo=sid)
        except Exception as exc:                                # noqa: BLE001
            logger.warning(f"[StarHeart] 撤回反应生成失败：{exc}")
            return {"ok": False, "error": str(exc)[:120]}
        said = str(out or "").strip()
        silent = (not said) or (self.RECALL_REACT_SILENT in said)
        if silent:
            logger.info("[StarHeart] 撤回反应：模型选择沉默（不发送）")
            await self.store.audit("recall.react", f"{mid} silent")
            return {"ok": True, "sent": False, "silent": True, "ms": int((time.time() - started) * 1000)}
        said = said.replace(self.RECALL_REACT_SILENT, "").strip()[:300]
        send = self.system.get("send_proactive")
        ok = False
        if callable(send) and said:
            try:
                ok = bool(await send(sid, said, "撤回反应"))
            except Exception as exc:                            # noqa: BLE001
                logger.warning(f"[StarHeart] 撤回反应发送失败：{exc}")
        await self.store.audit("recall.react", f"{mid} sent={bool(ok)} {said[:80]}")
        return {"ok": True, "sent": bool(ok), "text": said, "ms": int((time.time() - started) * 1000)}

    async def hidden_contacts(self) -> dict[str, Any]:
        out = await self.store.hidden_contacts()
        return {"group": out.get("group", []), "private": out.get("private", [])}

    async def set_hidden_contacts(self, kind: str, ids: list[str]) -> dict[str, Any]:
        await self.store.set_hidden_contacts(kind, ids)
        await self.store.audit(f"contacts.hide_{kind}", ",".join((ids or [])[:6]))
        return await self.hidden_contacts()

    async def contacts(self, force: bool = False) -> dict[str, Any]:
        """机器人真实的群聊/好友/自身 + AstrBot 管理员名单（来自平台接口）。

        平台接口拿不到时**不摆烂**：用我们自己聊过的会话兜底（标 derived=True），
        否则名单页是一片空白，用户连「选谁」都无从选起。
        """
        empty = {"available": False, "admins": [], "groups": [], "friends": [], "bots": [],
                 "platforms": [], "errors": [], "derived": False}
        data = dict(empty)
        fn = self.system.get("contacts")
        if callable(fn):
            try:
                data.update(await fn(force) or {})
            except Exception as exc:  # noqa: BLE001
                data["errors"] = [*data.get("errors", []), f"平台接口异常：{exc}"]
        else:
            data["errors"] = ["contacts 通道不可用"]
        if not data.get("groups") and not data.get("friends"):
            try:
                fallback = await self.store.recent_contacts()
                data["groups"] = fallback.get("groups") or []
                data["friends"] = fallback.get("friends") or []
                data["derived"] = bool(data["groups"] or data["friends"])
                if data["derived"]:
                    data["errors"] = [*data.get("errors", []), "平台名单为空，已用「你聊过的会话」兜底"]
            except Exception as exc:  # noqa: BLE001
                data["errors"] = [*data.get("errors", []), f"兜底名单失败：{exc}"]
        data["available"] = bool(data.get("groups") or data.get("friends") or data.get("bots"))
        # 私聊昵称回填：平台接口常见只给号码（name 与 id 相同 ⇒ 界面上就是「ID 和 ID」），
        # 这里用我们自己同步过的称呼（upsert_person_names_bulk 落的那份）补上显示名。
        try:
            _reader = None
            for _m in ("get_person_names", "person_names", "get_person_name_map",
                       "person_name_map", "all_person_names", "get_names"):
                _f = getattr(self.store, _m, None)
                if callable(_f):
                    _reader = _f
                    break
            if _reader is not None:
                _nm = _reader()
                if hasattr(_nm, "__await__"):
                    _nm = await _nm
                _map: dict[str, str] = {}
                if isinstance(_nm, dict):
                    _map = {str(k): str(v) for k, v in _nm.items() if v}
                elif isinstance(_nm, (list, tuple)):
                    for _row in _nm:
                        if isinstance(_row, dict):
                            _k = str(_row.get("ident") or _row.get("id") or "")
                            _v = _row.get("name") or _row.get("nickname")
                            if _k and _v:
                                _map[_k] = str(_v)
                _fixed = 0
                for _fr in (data.get("friends") or []):
                    if not isinstance(_fr, dict):
                        continue
                    _id = str(_fr.get("user_id") or _fr.get("id") or "")
                    _cur = str(_fr.get("name") or _fr.get("nickname") or "").strip()
                    _hit = _map.get(_id)
                    if _hit and (not _cur or _cur == _id):
                        _fr["nickname"] = _hit
                        _fr["name"] = _hit
                        _fixed += 1
                if _fixed:
                    logger.info(f"[StarHeart] 私聊昵称回填 {_fixed} 条（平台只给了号码）")
        except Exception as exc:                                # noqa: BLE001
            logger.debug(f"[StarHeart] 私聊昵称回填失败（不影响名单）：{exc}")
        # 兜底（更硬的来源）：平台接口只给号码时，直连协议端 get_stranger_info 实时取昵称。
        try:
            _miss: list[str] = []
            for _fr in (data.get("friends") or []):
                if not isinstance(_fr, dict):
                    continue
                _id = str(_fr.get("user_id") or _fr.get("id") or "").strip()
                _cur = str(_fr.get("name") or _fr.get("nickname") or "").strip()
                if _id and (not _cur or _cur == _id):
                    _miss.append(_id)
            _rfn = self.system.get("resolve_user_names")
            if _miss and callable(_rfn):
                _live = await _rfn(_miss[:60]) or {}
                _n2 = 0
                for _fr in (data.get("friends") or []):
                    if not isinstance(_fr, dict):
                        continue
                    _id = str(_fr.get("user_id") or _fr.get("id") or "").strip()
                    _hit = _live.get(_id) if isinstance(_live, dict) else None
                    if _hit:
                        _fr["nickname"] = str(_hit)
                        _fr["name"] = str(_hit)
                        _n2 += 1
                if _n2:
                    logger.info(f"[StarHeart] 名单页私聊昵称实时补全 {_n2} 条")
        except Exception as exc:                                # noqa: BLE001
            logger.debug(f"[StarHeart] 实时补昵称失败（不影响名单）：{exc}")
        return data

    async def _resolve_session(self, session_id: str, kind: str, ident: str) -> str:
        """面板可能只给「一个好友的 QQ」或「一个群号」，这里补成完整会话串。"""
        sid = str(session_id or "").strip()
        if sid:
            return sid
        kind = "group" if str(kind or "").lower() == "group" else "private"
        ident = str(ident or "").strip()
        if not ident:
            return ""
        platform = ""
        try:
            fn = self.system.get("contacts")
            if callable(fn):
                data = await fn(False)
                for x in (data.get("bots") or []):
                    platform = str(x.get("platform") or "")
                    if platform:
                        break
        except Exception:
            platform = ""
        platform = platform or "aiocqhttp"
        mtype = "GroupMessage" if kind == "group" else "FriendMessage"
        return f"{platform}:{mtype}:{ident}"

    async def proactive_test_send(self, session_id: str = "", text: str = "",
                                  kind: str = "", ident: str = "") -> dict[str, Any]:
        """面板「立即发一条」：以系统身份让 bot 直接给指定会话/人发一条。

        设计要点（用户明确要求）：
        - **一步到位**：不给文本就直接生成，生成完立刻发，不需要「先生成再点发送」；
        - **绝不卡死**：生成 30s、发送 20s 硬超时，超时就返回明确错误，前端不会一直转圈；
        - 无视空闲门槛/静默时段/额度（那是自动扫描的护栏），这是人工试发。
        """
        send = self.system.get("send_proactive")
        if not callable(send):
            return {"ok": False, "error": "发送通道不可用（插件未就绪或平台适配器不支持主动发送）"}
        sid = await self._resolve_session(session_id, kind, ident)
        if not sid:
            return {"ok": False, "error": "没给目标：会话号 / 群号 / QQ 至少要有一个"}
        cfg = await self.config()
        # 目标被基础名单挡着时给个告警（人工试发仍然执行，但要让用户知道自动扫描不会发它）
        warn = ""
        k2, id2 = self.session_kind(sid)
        vis, why = self.visible(k2, id2, cfg, platform=session_platform(sid))
        if not vis:
            warn = f"注意：这个目标{why}，自动主动扫描不会发它（本次手动试发仍然会发）"
        started = time.time()
        text = str(text or "").strip()
        generated = False
        if not text:
            try:
                text = await asyncio.wait_for(
                    self._proactive_text({"session_id": sid, "idle_min": 0}, "NEUTRAL", cfg), timeout=30
                )
            except TimeoutError:
                return {"ok": False, "error": "生成超时（30s）：模型通道没响应，检查「模型分配 → 对话回复」", "session_id": sid, "warn": warn}
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "error": f"生成失败：{exc}", "session_id": sid, "warn": warn}
            generated = True
            text = str(text or "").strip()
        if not text:
            return {"ok": False, "error": "模型没有返回内容（检查「模型分配 → 对话回复」）", "session_id": sid, "warn": warn}
        gen_ms = int((time.time() - started) * 1000)
        send_ms = 0
        try:
            t2 = time.time()
            ok = bool(await asyncio.wait_for(send(sid, text, "手动试发"), timeout=20))
            send_ms = int((time.time() - t2) * 1000)
        except TimeoutError:
            ok = False
            await self.store.log_proactive({
                "session_id": sid, "status": "failed", "reason": "面板手动试发超时",
                "text": text, "guard": {"manual": True, "timeout": 20},
            })
            return {"ok": False, "error": "发送超时（20s）：平台适配器没回执，检查 bot 是否在线",
                    "text": text, "session_id": sid, "warn": warn}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"发送异常：{exc}", "text": text, "session_id": sid, "warn": warn}
        await self.store.log_proactive({
            "session_id": sid, "status": "sent" if ok else "failed",
            "reason": "面板手动试发", "text": text,
            "guard": {"manual": True, "generated": generated},
        })
        return {
            "ok": ok, "text": text, "session_id": sid, "warn": warn,
            "generated": generated, "gen_ms": gen_ms if generated else 0, "send_ms": send_ms,
            "ms": int((time.time() - started) * 1000),
            "error": "" if ok else "发送接口返回 False（bot 掉线或该会话不可达）",
        }

    # ---------------- 人格进化提案 ----------------
    async def persona_proposals(self, limit: int = 20) -> dict[str, Any]:
        return {"items": await self.store.list_proposals(limit), "config": await self.config()}

    async def evolve_state(self) -> dict[str, Any]:
        """人格进化的参数与时间标记（面板「人格状态与进化」用）。"""
        cfg = await self.config()
        last = float(cfg.get("persona_last_evolve_at") or 0)
        save_at = float(cfg.get("persona_last_save_at") or 0)
        hours = max(1, int(cfg.get("evolve_min_hours", 24) or 24))
        need = max(1, int(cfg.get("evolve_min_memories", 6) or 6))
        # 当前人格：新记忆只数它的（未归属的算人人有份）
        cur_pid = str(cfg.get("persona_active_id") or "")
        try:
            people = await self.personas()
            cur_pid = str(people.get("active") or cur_pid)
        except Exception:                                     # noqa: BLE001 读不到就退回配置值
            pass
        props = await self.store.list_proposals(20)
        pending = [x for x in props if x.get("status") == "pending"]
        approved = [x for x in props if x.get("status") == "approved"]
        # 冷却基准 = max(上次通过, 上次生成提案)：否则「驳回 → 下一小时又生成」来回抖动
        last_proposal_at = float(props[0]["ts"]) if props else 0
        cool_base = max(last, last_proposal_at)
        new_mem = await self.store.memories_since(cool_base, cur_pid) if cool_base else await self.store.memories_since(0, cur_pid)
        return {
            "ok": True,
            "params": {
                "evolve_auto": bool(cfg.get("evolve_auto", True)),
                "evolve_min_hours": hours,
                "evolve_min_memories": need,
                "evolve_scope": str(cfg.get("evolve_scope") or "desc_style"),
                "evolve_require_confirm": bool(cfg.get("evolve_require_confirm", True)),
            },
            "last_evolve_at": last, "last_save_at": save_at,
            "cooldown_base": cool_base, "persona_id": cur_pid,
            "next_due_at": (cool_base + hours * 3600) if cool_base else 0,
            "new_memories": int(new_mem), "pending": len(pending), "approved": len(approved),
            "pending_ttl_hours": max(1, int(cfg.get("evolve_pending_ttl_hours", 72) or 72)),
            "last_proposal_at": last_proposal_at,
            "llm_ready": callable(self.system.get("llm_generate")),
        }

    def _evolve_scope_hint(self, scope: str) -> str:
        return {
            "desc_only": "只允许改「人格描述」",
            "all": "允许整段重写人格",
        }.get(scope, "只允许改「人格描述与说话风格」")

    async def evolve_tick(self) -> dict[str, Any]:
        """按策略自动出进化提案（默认不自动写入，等你点通过）。"""
        cfg = await self.config()
        if not cfg.get("evolve_auto", True):
            return {"skipped": "evolve_auto 关闭"}
        if not callable(self.system.get("llm_generate")):
            return {"skipped": "模型通道不可用"}
        st = await self.evolve_state()
        # ① 先做无条件清理：待审提案超 TTL 自动作废。
        #    「永不过期」会让忘点一次 = 再也不进化；而且清理必须在冷却判定之前，
        #    否则冷却先把本轮挡掉，过期提案会一直挂在面板上显示「待审核」。
        ttl = float(st.get("pending_ttl_hours") or 72) * 3600
        expired = 0
        for x in await self.store.list_proposals(50):
            if x.get("status") == "pending" and (time.time() - float(x.get("ts") or 0)) > ttl:
                await self.store.decide_proposal(int(x["id"]), "expired")
                expired += 1
        if expired:
            await self.store.audit("persona.proposal_expired", f"{expired} 条超时作废")
            st = await self.evolve_state()
        # ② 再判门控：冷却 / 新记忆 / 待审
        base_ts = float(st.get("cooldown_base") or 0)
        hours = int(st["params"]["evolve_min_hours"])
        if base_ts and (time.time() - base_ts) < hours * 3600:
            return {"skipped": f"距上次进化 / 上次提案不足 {hours} 小时"}
        if st["new_memories"] < int(st["params"]["evolve_min_memories"]):
            return {"skipped": f"新记忆不足（{st['new_memories']}/{st['params']['evolve_min_memories']}，只数当前人格）"}
        if st["pending"]:
            return {"skipped": f"已有 {st['pending']} 条待审核提案（超过 {int(ttl/3600)} 小时会自动作废）"}
        res = await self.persona_propose()
        if not res.get("ok"):
            return res
        if not st["params"]["evolve_require_confirm"]:
            pid = int(res.get("id") or 0)
            if pid:
                decided = await self.persona_decide(pid, True)
                return {"auto_applied": True, "proposal": res, "decide": decided}
        return {"proposed": True, "proposal": res}

    async def persona_propose(self) -> dict[str, Any]:
        gen = self.system.get("llm_generate")
        if not callable(gen):
            return {"ok": False, "error": "模型通道不可用"}
        people = await self.personas()
        cfg_active = str((await self.config()).get("persona_active_id") or "")
        items = people.get("items") or []
        # 严格取当前人格（AstrBot 原生那个），绝不能回退到 items[0]——
        # 那会进化成另一个人格（实测踩过：提案写成的是另一个人格，实际在用的却是当前人格）
        want = str(people.get("active") or cfg_active or "")
        cur = next((p for p in items if p.get("persona_id") == want), None) if want else None
        if cur is None and items:
            # 没有 active 信息时：取配置里指定的人格，仍无则明确报错让用户去面板选
            cfg_pid = str((await self.config()).get("persona_active_id") or "")
            cur = next((p for p in items if p.get("persona_id") == cfg_pid), None)
        if cur is None:
            return {"ok": False, "error": "读不到当前人格（面板「人格管理」里先确认哪个是当前使用）"}
        base = str(cur.get("system_prompt") or "")
        if not base:
            return {"ok": False, "error": "该人格没有可进化的文本"}
        # 必须把**完整人格**喂给模型：以前只喂前 2000 字、却按整段写回 → 尾部设定被静默丢掉。
        # 超长人格不硬塞（上下文会爆），明确拒绝并说清怎么办。
        if len(base) > 12000:
            return {"ok": False, "error": f"人格文本 {len(base)} 字，超过单次进化上限 12000 字 —— "
                                          f"请先精简人格，或分段手动进化（避免静默截断丢设定）"}
        # 数据源：学到的说话习惯 + bot 自己最近说过的话（自省哪里不像自己）
        habits = await self.store.list_habits()
        my_scope = f"学习·{cur.get('persona_id') or ''}"
        learned = [h for h in habits if str(h.get("scope") or "") in (my_scope, "学习", "全局")]
        style = "；".join(f"{h.get('scene')}→{h.get('way')}" for h in learned[:10])
        bot_said = await self.store.list_corpus(limit=20, is_bot=1, persona_id=str(cur.get("persona_id") or ""))
        recent = "\n".join(f"- {str(r.get('text') or '')[:80]}" for r in bot_said[:15])
        prompt = (
            f"下面是「{cur.get('persona_id')}」这个角色现在的人格设定。请结合数据给它出一版更自然的改写。\n\n"
            + (f"它最近从群友/好友那里学到的说话习惯：{style}。\n" if style else "")
            + (f"它自己最近说过这些话（这些是它说过的话，**不要照抄进人格文本**，只用来判断哪里不像它）：\n{recent}\n" if recent else "")
            + "\n改写要求：\n"
            "1. 保留核心设定（身份、性格底色、与他人关系）不变，只让说话更像真人。\n"
            "2. 把学到的口头禅、句尾语气词、常用口语融进去——但只写**可复用的说法**，"
            "不要把它说过的具体句子原文搬进来（否则它会复读自己说过的话）。\n"
            "3. 砍掉它自己说过的话里那些不像它的地方（比如太工整、像客服、说教、列建议）。\n"
            "4. 说话言简意赅，除非对方特别要求。真人话少，别写长篇。\n"
            "5. 不要写成方法论或步骤清单，要写成这个人物自己的性格与说话习惯。\n"
            "6. **不要出现「你平时大概会这样说话」这类示例对话段落**——示例属于 few-shot，"
            "会诱发复读；这里只写性格与说话习惯本身。\n"
            "7. 只输出改写后的完整人格文本，不要解释、不要 markdown。\n"
            + f"8. 可改范围：{self._evolve_scope_hint(str((await self.config()).get('evolve_scope') or 'desc_style'))}"
            "——超出这个范围的内容一律原样保留。\n\n"
            "【原文】\n" + base
        )
        out = await gen(prompt, "persona_evolve")
        proposal = str(out or "").strip()
        if not proposal:
            return {"ok": False, "error": "模型没有返回内容"}
        pid = await self.store.add_proposal({
            "persona_id": str(cur.get("persona_id") or ""), "base": base, "proposal": proposal,
            "rationale": "由面板触发的一次进化提案（需人工审核后才会生效）",
        })
        await self.store.audit("persona.propose", str(pid))
        return {"ok": True, "id": pid}

    async def _persona_text(self, persona_id: str) -> str | None:
        """读某个人格当前的 system_prompt（原生数据）；读不到返回 None（不误判成"过期"）。"""
        try:
            people = await self.personas()
        except Exception:                                     # noqa: BLE001
            return None
        for p in people.get("items") or []:
            if str(p.get("persona_id") or "") == str(persona_id or ""):
                return str(p.get("system_prompt") or "")
        return None

    async def persona_rollback(self, pid: int) -> dict[str, Any]:
        """把某条提案里保存的「旧版本」写回该人格 —— 进化错了要有退路，不用去翻备份。"""
        item = await self.store.get_proposal(int(pid))
        if item is None:
            return {"ok": False, "error": "提案不存在"}
        if str(item.get("status") or "") != "approved":
            return {"ok": False, "error": f"只有「已采纳」的提案能回滚（当前状态：{item.get('status')}）"}
        base_text = str(item.get("base") or "").strip()
        if not base_text:
            return {"ok": False, "error": "这条提案没有保存旧版本，无法回滚"}
        save = self.persona.get("update")
        if not callable(save):
            return {"ok": False, "error": "人格写入通道不可用"}
        await save(str(item.get("persona_id") or ""), {"system_prompt": base_text})
        # 回滚也是一次"写入人格"，刷新时间标记（否则面板「人格上次保存」与实际不符）
        await self.store.set_config("persona_last_save_at", time.time())
        await self.store.audit("persona.rollback", f"id={pid} persona={item.get('persona_id')}")
        return {"ok": True, "id": int(pid), "persona_id": str(item.get("persona_id") or ""), "len": len(base_text)}

    async def persona_decide(self, pid: int, approve: bool) -> dict[str, Any]:
        """通过 / 驳回一条进化提案。

        通过前**必须**校验 base 新鲜度：人格在你审阅这段时间里可能被手改过，
        拿旧提案覆盖新人格 = 静默丢掉你的修改。写回失败也不许把状态留在 approved。
        """
        item = await self.store.get_proposal(int(pid))
        if item is None:
            return {"ok": False, "error": "提案不存在"}
        if approve:
            cur_text = await self._persona_text(str(item.get("persona_id") or ""))
            base_text = str(item.get("base") or "")
            if cur_text is not None and base_text.strip() and cur_text.strip() != base_text.strip():
                await self.store.decide_proposal(int(pid), "stale")
                return {"ok": False, "stale": True,
                        "error": "这条提案基于旧版人格（你之后改过人格），已标记为过期 —— 请重新生成提案再通过"}
            item = await self.store.decide_proposal(int(pid), "approved") or item
            # 记下"上次进化 / 上次写入人格"的时间：面板要显示进化时间标记
            await self.store.set_config("persona_last_evolve_at", time.time())
            await self.store.set_config("persona_last_save_at", time.time())
        else:
            item = await self.store.decide_proposal(int(pid), "rejected") or item
        if approve:
            save = self.persona.get("update")
            if not callable(save):
                await self.store.decide_proposal(int(pid), "pending")
                return {"ok": False, "error": "人格写入通道不可用，提案已退回待审"}
            try:
                await save(item.get("persona_id") or "", {"system_prompt": item.get("proposal") or ""})
            except Exception as exc:                          # noqa: BLE001
                await self.store.decide_proposal(int(pid), "pending")
                return {"ok": False, "error": f"写回人格失败：{exc}（提案已退回待审）"}
        await self.store.audit(f"persona.{'approve' if approve else 'reject'}", str(pid))
        return {"ok": True, "id": pid, "status": item.get("status")}

    # ---------------- 插件自管模型任务的提示词 ----------------
    #
    # 为什么要有这几条：这些任务是**插件自己调模型**干的活（不参与对话回复），提示词完全由插件
    # 决定。以前只有「人物画像」带 system 提示词，其余 4 个把约束塞在 user 文本里 —— 用户既看不见
    # 也改不了。现在统一登记进 TASK_PROMPTS：面板「模型分配」可展开查看与修改（留空 = 用内置默认）。
    # 注意：工具类（function calling）提示词不在清单里，按用户要求不展开。
    MEMORY_SUMMARY_SYSTEM = (
        "你是记忆整理器。从对话里蒸馏出「关于用户的长期记忆」：偏好、习惯、事实、约定、情绪触发点。\n"
        "硬性要求：1) 只写用户的事，不要写你自己（助手/bot）的内心戏或自夸；"
        "2) 材料不足就少写几条，严禁编造；3) 每条必须是可复用的长期信息，不要流水账；"
        "4) 严格按调用方给定的逐行格式输出，不要解释、不要多余文字。"
    )
    EXPRESSION_SYSTEM = (
        "你是语言风格分析器。从真实聊天记录里提取「可复用的说话方式」：口头禅、句尾语气词、"
        "常用句式、称呼习惯、回应风格。\n"
        "硬性要求：1) 只提取怎么说话，不要提取隐私内容、具体事件与人名；"
        "2) 场景必须是社交情境（例如「被夸」「被催」），不要写「群聊/私聊」这类场所词；"
        "3) 只输出调用方要求的格式行，不要解释。"
    )
    PERSONA_EVOLVE_SYSTEM = (
        "你是角色人格编辑。给定一个角色的现有人格文本与它的近期素材，输出一版更自然、更像真人的改写。\n"
        "硬性要求：1) 身份、性格底色、说话习惯、与用户的关系保持不变，只改表达；"
        "2) 绝对不得引入其它角色/其它人格的内容（人名、关系、设定都不许跨人格搬）；"
        "3) 不得添加或删改安全边界；4) 只输出新人格全文本身，不要解释、不要前言后语。"
    )
    FORGET_SYSTEM = (
        "你是记忆守门人。给定一批候选记忆，只挑出「确实该遗忘」的编号。\n"
        "硬性要求：1) 只能从候选里收窄，不得新增、不得扩大范围；2) 拿不准就少挑；"
        "3) 只输出编号列表，不要解释。"
    )

    # ---------------- 聚合页 ----------------
    # ---------------- 人物画像（补齐功能）----------------
    # 画像该回答的是"这个人是谁、和她怎么相处"，而不是几条计数。
    # 没数据就明说没有（面板会给出"生成画像"按钮），不许显示空壳当正常。
    PROFILE_SYSTEM = (
        "你在为一个真实的人写「人物画像」。只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余文字。\n"
        "字段（全部按给定材料写，材料不足就留空，严禁臆造）：\n"
        '{"one_line":"一句话她是谁（30字内，具体）",'
        '"identity":"身份/称呼/关系",'
        '"traits":["性格特点",...],'
        '"likes":["喜欢·在意的事",...],'
        '"dislikes":["忌讳·雷区",...],'
        '"topics":["常聊话题",...],'
        '"relation":"和用户（bot 的主人）的关系与相处建议：2-3 句，要具体可执行",'
        '"events":[{"when":"时间","what":"关键事件"}],'
        '"notes":"其他要注意的：称呼习惯、语气偏好等"}'
    )
    # 群聊画像（L1）：群不是人，问的是"这是个什么群、氛围如何、谁在活跃、常聊什么、有什么默契"。
    # 与人物画像同一套口径：材料不足留空、严禁臆造、字段级清洗后再入库。
    GROUP_PROFILE_SYSTEM = (
        "你在为一个 QQ 群写「群聊画像」。只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余文字。\n"
        "字段（全部按给定材料写，材料不足就留空，严禁臆造）：\n"
        '{"one_line":"一句话这是个什么群（30字内，具体）",'
        '"kind":"群的性质（熟人闲聊群/游戏群/工作群/项目群…）",'
        '"atmosphere":"氛围与说话风格（2-3 句）",'
        '"topics":["常聊话题",...],'
        '"members":[{"who":"成员称呼","role":"在群里是什么角色·常做什么","n":"发言量或记忆数"}],'
        '"norms":["群里的默契与忌讳",...],'
        '"relation":"这个群和用户（bot 的主人）的关系、bot 在群里该注意什么：2-3 句，要具体可执行",'
        '"notes":"其他要注意的"}'
    )

    async def person_merge(self, alias_id: str, canonical_id: str, reason: str = "manual") -> dict[str, Any]:
        """把别名号并入主号（同一个人的两个 QQ 号场景）。"""
        return await self.store.merge_persons(alias_id, canonical_id, reason=reason)

    async def person_unmerge(self, alias_id: str) -> dict[str, Any]:
        """拆开别名（并错了要能退回来）。"""
        return await self.store.unmerge_person(alias_id)

    async def purge_platform_sessions(self, platforms: list[str]) -> dict[str, Any]:
        """清掉非 QQ 平台（webchat 等）在库里留下的痕迹。"""
        return await self.store.purge_platform_sessions(platforms)

    async def person_profile_reset(self, pid: str, subject_kind: str = "user", persona_id: str = "") -> dict[str, Any]:
        """清掉某个人的画像（垃圾画像清理）。"""
        ok = await self.store.profile_delete(pid, subject_kind, persona_id)
        await self.store.audit("person.profile_reset", str(pid))
        return {"ok": ok, "person_id": str(pid)}

    # 任务 → 面板展示与默认提示词（system 为空 = 该任务没有系统提示词）
    TASK_PROMPTS: dict[str, dict[str, str]] = {
        "memory_summary": {"label": "记忆总结", "system": MEMORY_SUMMARY_SYSTEM,
                           "desc": "把一段对话压成摘要 + 召回线索，供以后回忆",
                           "user_key": "memory_summary_prompt", "user_label": "总结用户模板"},
        "expression_extract": {"label": "表达提取", "system": EXPRESSION_SYSTEM,
                               "desc": "从聊天里学「怎么说话」（口头禅 / 句式 / 称呼），供拟人输出"},
        "person_profile": {"label": "人物画像", "system": PROFILE_SYSTEM,
                           "desc": "把某个人的记忆汇总成一句话画像（会自动刷新）"},
        "group_profile": {"label": "群聊画像", "system": GROUP_PROFILE_SYSTEM,
                          "desc": "把某个群的记忆与成员汇总成群聊画像（会自动刷新）"},
        "persona_evolve": {"label": "人格进化", "system": PERSONA_EVOLVE_SYSTEM,
                           "desc": "按近期素材改写当前人格的表达（默认要你确认才写回）"},
        "forget": {"label": "记忆遗忘评估", "system": FORGET_SYSTEM,
                   "desc": "筛出可以归档 / 遗忘的旧记忆（只收窄，不新增）"},
    }

    async def person_profile(self, pid: str, subject_kind: str = "user", persona_id: str = "") -> dict[str, Any]:
        """读一份画像（L0 人物 / L1 群聊）+ 它的数据规模（没有时明确说"还没生成"，不造假数据）。"""
        pid = str(pid or "").strip()
        k = "group" if str(subject_kind or "").lower() == "group" else "user"
        if not pid:
            return {"ok": False, "error": "缺少主体 id"}
        row = await self.store.profile_get(pid, k, persona_id)
        dossier = await self.store.subject_dossier(pid, k, limit=200, persona_id=persona_id)
        out: dict[str, Any] = {
            "ok": True, "person_id": pid, "subject_kind": k,
            "name": dossier.get("name") or pid,
            "members": dossier.get("members") or [],
            "profile_persona": str((row or {}).get("persona_id") or ""),
            "persona_ids": await self.store.profile_persona_ids(pid, k),
            "mem_count": dossier.get("mem_count") or 0, "msg_count": dossier.get("msgs") or 0,
            "sessions": len(dossier.get("sessions") or []),
            "has_profile": bool(row),
            "profile": (row or {}).get("profile") or {},
            "updated_at": (row or {}).get("updated_at") or 0,
            "memories": [
                {"id": m["id"], "summary": m["summary"][:80], "atom_type": m["atom_type"],
                 "strength": m["strength"], "occurred_at": m["occurred_at"]}
                for m in (dossier.get("memories") or [])[:12]
            ],
            "top_entities": (dossier.get("top_entities") or [])[:12],
            "top_cues": (dossier.get("top_cues") or [])[:12],
            "llm_ready": callable(self.system.get("llm_generate")),
        }
        if out["has_profile"]:
            # 脏画像识别：真机上出现过 mem_count=0 却入库的「身份未知，仅知为人物 id …」
            prof_text = json.dumps(out["profile"], ensure_ascii=False)
            bad = (int((row or {}).get("mem_count") or 0) <= 0
                   or "仅知为人物 id" in prof_text
                   or ("身份未知" in prof_text and not (out["profile"].get("traits") or out["profile"].get("topics"))))
            if bad:
                out["invalid"] = True
                out["invalid_reason"] = ("这份画像是在材料不足时生成的（当时记忆 "
                                        f"{int((row or {}).get('mem_count') or 0)} 条），"
                                        "内容没有依据，已在自动任务里标记为待重建 —— 也可以现在点下面的按钮重生成")
                out["has_profile"] = False
            else:
                out["invalid"] = False
        if not out["has_profile"]:
            # 缺陷要显式暴露：告诉面板"没有画像 + 为什么 + 怎么办"
            if out["mem_count"] == 0 and out["msg_count"] == 0:
                out["reason"] = "这个人还没有任何记忆和互动记录 —— 先让 bot 和她正常聊几次，或用「导入」把历史记录补进来"
            else:
                out["reason"] = "还没有生成过画像（有 %d 条记忆可用）" % out["mem_count"]
        return out

    # ---------------- 图像识别：整段移除（不再是独立模型调用） ----------------
    #
    # 原先两条路：① 与对话同模型时，把 image_urls 交给总结模型自己看；② 配了不同模型时，先用那个
    # 「图像识别」模型识别、再把描述并进文本。现在只剩 ①，而且不需要任何配置：
    #   · 对话本身用到的图片由 AstrBot 自己的管线处理（prepare_request_images 在 on_llm_request 之后执行），
    #     插件不介入 —— 既不会改变回复，也不会丢人格/提示词；
    #   · 记忆里要留图片内容时，image_urls 直接交给做总结的模型（原生多模态）。
    # 删掉 ② 的原因：那个独立模型吃不到 AstrBot 的提示词，属于「吃不到提示词的模型参与对话链路」，
    # 用户明确禁止（自审模型就是这么坏的）。同时 `model_vision` 槽位一并下线。

    async def _persona_id_list(self) -> list[str]:
        """当前有哪些人格。后台要**逐人格**生成画像（人格之间互不可见），所以必须拿到真实 id 列表。"""
        ids: list[str] = []
        try:
            data = await self.personas()
        except Exception:
            return []
        for it in data.get("items") or []:
            pid = str((it or {}).get("id") or (it or {}).get("persona_id") or "").strip()
            if pid:
                ids.append(pid)
        return list(dict.fromkeys(ids))

    async def auto_profile_tick(self) -> dict[str, Any]:
        """后台自动补齐/刷新画像：**逐个人格**分别生成 L0 人物画像与 L1 群聊画像。

        为什么逐人格：画像就是"这个人物眼里的世界"，人格隔离是硬约束 —— 人格 A 的画像
        绝不能拿人格 B 的记忆来生成（真机上两个人格曾共用一份画像，属于定性错误）。
        """
        cfg = await self.config()
        if not cfg.get("profile_auto", True):
            return {"skipped": "profile_auto 关闭"}
        if not callable(self.system.get("llm_generate")):
            return {"skipped": "模型通道不可用"}
        # 配置值可能被面板写成非数字（实测会把 int() 抛出去、整轮画像静默停摆）→ 逐个容错回落默认值
        def _int(key: str, dflt: int) -> int:
            try:
                return int(cfg.get(key, dflt) or dflt)
            except (TypeError, ValueError):
                logger.warning(f"[StarHeart] 画像参数 {key}={cfg.get(key)!r} 不是数字，本轮按默认 {dflt} 处理")
                return dflt

        limit = max(1, _int("profile_batch_per_tick", 2))
        min_mem = max(1, _int("profile_min_memories", 5))
        hours = max(1, _int("profile_refresh_hours", 72))
        personas = await self._persona_id_list()
        if not personas:
            # 读不到人格列表时**不能**退回"不筛人格"：那样生成的画像会落成无归属行，
            # 而"全部人格"读取路径会把它们当任何人格的画像用 —— 隔离直接被绕过。
            return {"skipped": "读不到人格列表（AstrBot 人格接口不可用）—— 已跳过本轮，"
                               "避免写入无归属画像；修复后会自动继续",
                    "personas": 0, "built": []}
        done: list[dict[str, Any]] = []
        for persona_id in personas:
            for kind in ("user", "group"):
                try:
                    todo = await self.store.subjects_needing_profile(
                        kind, min_memories=min_mem, refresh_hours=hours, limit=limit, persona_id=persona_id)
                except Exception as exc:                     # 单个人格出错不影响其余
                    done.append({"persona": persona_id, "kind": kind, "ok": False, "err": str(exc)})
                    continue
                for item in todo:
                    try:
                        r = await self.person_profile_build(item["person_id"], kind, persona_id)
                        done.append({"persona": persona_id, "kind": kind, "pid": item["person_id"],
                                     "ok": bool(r.get("ok")), "err": r.get("error", "")})
                    except Exception as exc:
                        done.append({"persona": persona_id, "kind": kind, "pid": item["person_id"],
                                     "ok": False, "err": str(exc)})
        return {"built": done, "personas": len(personas)}

    async def person_profile_build(self, pid: str, subject_kind: str = "user", persona_id: str = "") -> dict[str, Any]:
        """根据主体（人物 L0 / 群聊 L1）的记忆材料，让 LLM 生成/更新一份画像并落库。"""
        pid = str(pid or "").strip()
        k = "group" if str(subject_kind or "").lower() == "group" else "user"
        who = "这个群" if k == "group" else "这个人"
        if not pid:
            return {"ok": False, "error": "缺少主体 id"}
        # 人格必填：画像是"这个人物眼里的世界"，落成无归属行会被"全部人格"读取路径捞出来当
        # 任何人格的画像用（隔离被绕过）。宁可明确拒绝，让调用方先把当前人格解析出来。
        persona_id = "" if str(persona_id) == "__none__" else str(persona_id or "").strip()
        if not persona_id:
            return {"ok": False, "code": "persona_required",
                    "error": "没有确定当前人格，已拒绝生成画像 —— 画像按人格隔离，必须先指定人格再生成"}
        gen = self.system.get("llm_generate")
        if not callable(gen):
            return {"ok": False, "error": "模型通道不可用：先在「设置 → 模型」里配好一个可用的对话模型"}
        try:
            _cfg = await self.config()
            min_mem = int(_cfg.get("profile_min_memories") or 5)
        except Exception:
            _cfg = {}
            min_mem = 5
        min_mem = max(1, min_mem)
        # 记忆时间锚要用「AstrBot 时区」而不是容器本地时间（容器常见是 UTC，会整体差 8 小时）
        from datetime import datetime

        tz = self._tzinfo(_cfg)
        dossier = await self.store.subject_dossier(pid, k, limit=120, persona_id=persona_id)
        mems = dossier.get("memories") or []
        if not mems and not dossier.get("msgs"):
            tail = "先让 bot 在群里多聊几次，或用「导入」补历史记录" if k == "group" else "先让 bot 和她聊几次，或用「导入」补历史记录"
            return {"ok": False, "error": f"{who}还没有任何记忆和互动记录，没法做画像 —— " + tail}
        # 门槛：材料太少的画像就是模型瞎猜（真机上就生成过「身份未知，仅知为人物 id …」这种垃圾）。
        # 宁可明确拒绝并说清缺什么，也不许把垃圾写进库。
        if len(mems) < min_mem:
            return {"ok": False, "code": "not_enough_material",
                    "error": f"材料不足：{who}的记忆只有 {len(mems)} 条（至少需要 {min_mem} 条）"
                             f"，互动消息 {int(dossier.get('msgs') or 0)} 条。"
                             f"先让它多聊几次，或用「设置 → 危险区 / 导入」补历史对话，再生成画像",
                    "mem_count": len(mems), "min_memories": min_mem}

        if k == "group":
            lines = ["【已知信息】",
                     f"群号：{pid}", f"群名（若已知）：{dossier.get('name') or '未知'}",
                     f"群消息数：{dossier.get('msgs')}，这个群的记忆条数：{len(mems)}",
                     f"涉及会话数：{len(dossier.get('sessions') or [])}"]
            if dossier.get("members"):
                lines.append("活跃成员（按发言量）：" + "、".join(
                    f"{m.get('name') or m.get('user_id')}({m.get('msgs')})" for m in dossier["members"][:16]))
        else:
            lines = ["【已知信息】",
                     f"人物 id：{pid}", f"称呼（若已知）：{dossier.get('name') or '未知'}",
                     f"互动消息数：{dossier.get('msgs')}，记忆条数：{len(mems)}",
                     f"出现在 {len(dossier.get('sessions') or [])} 个会话里"]
        if dossier.get("top_entities"):
            lines.append("常出现的实体：" + "、".join(f"{e['name']}({e['n']})" for e in dossier["top_entities"][:16]))
        if dossier.get("top_cues"):
            lines.append("常出现的线索：" + "、".join(f"{c['name']}({c['n']})" for c in dossier["top_cues"][:16]))
        lines.append("")
        lines.append("【这个群的记忆（按重要性排）】" if k == "group" else "【她的记忆（按重要性排）】")
        for i, m in enumerate(mems[:70], 1):
            when = ""
            if m.get("occurred_at"):
                try:
                    ts = float(m["occurred_at"])
                    when = (
                        datetime.fromtimestamp(ts, tz).strftime("%Y-%m-%d %H:%M")
                        if tz is not None
                        else time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))
                    )
                except Exception:
                    when = ""
            bits = [f"{i}. [{m.get('atom_type') or ''}{('/' + when) if when else ''}] {m.get('summary') or ''}"]
            if m.get("cues"):
                bits.append("   线索：" + "、".join(str(x) for x in m["cues"][:6]))
            if m.get("entities"):
                bits.append("   实体：" + "、".join(str(x) for x in m["entities"][:8]))
            if m.get("evidence"):
                bits.append("   原文：" + str(m["evidence"])[:160])
            lines.extend(bits)
        prompt = "\n".join(lines) + ("\n\n请据此输出群聊画像 JSON。" if k == "group" else "\n\n请据此输出人物画像 JSON。")

        started = time.time()
        try:
            if k == "group":
                raw = await gen(prompt, "group_profile", self.GROUP_PROFILE_SYSTEM)
            else:
                raw = await gen(prompt, "person_profile", self.PROFILE_SYSTEM)
        except Exception as exc:  # 模型报错也要能被面板看见
            return {"ok": False, "error": f"模型调用失败：{exc}"}
        text = str(raw or "").strip()
        if not text:
            return {"ok": False, "error": "模型没有返回内容（可能是模型通道限流或超时）"}
        body = _json_block(text)
        if body is None:
            # 模型返回数组/标量时，_json_block 拿不到对象 → 以前会把原文塞进 one_line 当画像存下来
            # （面板上就出现「一句话」是 ["a","b"] 这种垃圾）。这类输出明确拒绝，不当画像。
            if text.lstrip()[:1] in ("[", "\"") or text.strip() in ("true", "false", "null"):
                return {"ok": False, "code": "unparseable_output",
                        "error": "模型没有按要求返回 JSON 对象（返回的是数组/标量），已拒绝入库 —— 请重试或换模型"}
            body = {"one_line": text[:200], "notes": "（模型未按要求返回 JSON，这里原样保留输出）"}
        nm = str(dossier.get("name") or "")
        if k == "group":
            body = _sanitize_group_profile(body, gid=pid, name=nm)
            thin = not body.get("one_line") and not body.get("kind") and not body.get("notes")
        else:
            body = _sanitize_profile(body, pid=pid, name=nm)
            thin = not body.get("one_line") and not body.get("identity") and not body.get("notes")
        if thin:
            return {"ok": False, "code": "empty_profile",
                    "error": "模型返回的画像全是坏字段（清洗后为空），已拒绝入库 —— 请重试或换一个模型"}
        await self.store.profile_save(pid, body, mem_count=len(mems), msg_count=int(dossier.get("msgs") or 0),
                                      built_by="llm", subject_kind=k, persona_id=persona_id)
        try:      # 画像生成必须留审计（以前只 log；出问题时无法追溯是谁在什么人格下生成的）
            await self.store.audit("profile.build",
                                   f"{k}:{pid} @ {persona_id or '未归属'} · 记忆 {len(mems)} 条 · "
                                   f"模型 {int((time.time() - started) * 1000)}ms")
        except Exception:
            pass
        return {"ok": True, "person_id": pid, "subject_kind": k, "persona_id": persona_id,
                "profile": body, "mem_count": len(mems),
                "msgs": int(dossier.get("msgs") or 0), "ms": int((time.time() - started) * 1000),
                "updated_at": time.time()}

    async def persons(self, limit: int = 60, persona_id: str = "") -> dict[str, Any]:
        """按人聚合；群聊单独返回（群不是人，别把群号当 QQ 摆进去）。

        bot 自己的 id 只从可信来源取：平台 get_login_info + 配置里的手工排除，
        取到就落库（kind='self'），下次即使平台接口挂了也不会把自己当成「聊过的人」。
        """
        exclude: set[str] = set()
        try:
            cfg = await self.config()
            exclude.update(str(x) for x in (cfg.get("person_exclude_ids") or []) if str(x).strip())
        except Exception:
            pass
        try:
            data = await self.contacts(False)
            for b in data.get("bots") or []:
                uid = str(b.get("user_id") or b.get("id") or "").strip()
                if uid:
                    exclude.add(uid)
        except Exception:
            pass
        if exclude:
            try:
                await self.store.set_bot_self_ids(sorted(exclude))
            except Exception:
                pass
        try:
            ignore = list((await self.config()).get("person_exclude_platforms") or [])
        except Exception:
            ignore = []
        out = await self.store.person_overview(limit, exclude=exclude, ignore_platforms=ignore,
                                               persona_id=str(persona_id or ""))
        if isinstance(out, dict):
            out["bots"] = sorted(exclude)
            return out
        return {"items": out or [], "groups": [], "bots": sorted(exclude)}

    async def favour_insight(self) -> dict[str, Any]:
        return await self.store.favour_insight()

    async def habit_log(self, limit: int = 100) -> dict[str, Any]:
        log = await self.store.habit_log(limit)
        # 语料统计：让「自学习」有可见进度（学了多少条原话 / 用掉多少）
        return {**log, "corpus": await self.store.corpus_stats()}

    async def corpus_list(self, limit: int = 50, *, is_bot: int | None = None) -> dict[str, Any]:
        """看语料原文（面板「表达学习 → 语料」用）。"""
        return {
            "items": await self.store.list_corpus(limit=limit, is_bot=is_bot),
            "stats": await self.store.corpus_stats(),
        }

    async def prompt_registry(self) -> dict[str, Any]:
        """面板「模型分配」用：每个自管任务的系统提示词（内置/覆盖/生效）与用户模板。"""
        cfg = await self.config()
        items = []
        for task, info in self.TASK_PROMPTS.items():
            default = str(info.get("system") or "")
            override = str(cfg.get(f"sys_prompt_{task}") or "")
            user_key = str(info.get("user_key") or "")
            items.append({
                "task": task,
                "label": info.get("label") or task,
                "desc": info.get("desc") or "",
                "default": default,
                "override": override,
                "effective": override or default,
                "edited": bool(override.strip()),
                "user_key": user_key,
                "user_label": info.get("user_label") or "",
                "user_value": str(cfg.get(user_key) or "") if user_key else "",
                "editable": True,
            })
        return {"items": items,
                "note": "留空 = 使用内置默认。这里只列插件自己调模型的任务；"
                        "对话回复 / 主动开口 / 图像理解走 AstrBot 原生提示词，不在此处（也不该在此处改）。"}

    async def save_task_prompt(self, task: str, system_text: str | None = None) -> dict[str, Any]:
        """保存某任务的系统提示词覆盖（传空字符串 = 恢复内置默认）。"""
        task = str(task or "").strip()
        if task not in self.TASK_PROMPTS:
            return {"ok": False, "error": f"未知任务：{task}"}
        if system_text is None:
            return {"ok": False, "error": "缺少 system 字段"}
        key = f"sys_prompt_{task}"
        await self.store.set_config(key, str(system_text))
        await self.store.audit("prompt.save", f"{task} len={len(str(system_text))}")
        # 与「面板保存配置」走同一条路：写回原生插件配置。否则就是双源 ——
        # 面板改了原生页看不见、原生页改了不生效（原生页只读，权威源仍是插件配置）。
        native: dict[str, Any] = {"ok": False, "error": "未接入原生写回"}
        fn = self.system.get("save_native_config")
        if callable(fn):
            try:
                native = await fn({key: str(system_text)})
            except Exception as exc:                          # noqa: BLE001
                native = {"ok": False, "error": str(exc)[:120]}
        return {"ok": True, "task": task, "edited": bool(str(system_text).strip()), "_native_write": native}

    async def config_domains(self) -> dict[str, Any]:
        cfg = await self.config()
        return {"domains": CONFIG_DOMAINS, "values": cfg}

    # ---------------- 表达提取（真跑一次 LLM） ----------------
    async def habit_extract(self, limit: int = 60) -> dict[str, Any]:
        """从群友/好友的真实原话里学说话习惯（语料库是数据源，记忆摘要只做辅助）。"""
        gen = self.system.get("llm_generate")
        if not callable(gen):
            return {"ok": False, "error": "模型通道不可用"}
        persona_id = self.system.get("active_persona")
        pid = ""
        if callable(persona_id):
            try:
                pid = str(await persona_id() or "")
            except Exception:
                pid = ""
        # 优先取没学过的群友/好友原话
        rows = await self.store.list_corpus(limit=limit, is_bot=0, unused_only=True)
        used_ids = [int(r["id"]) for r in rows]
        if len(rows) < 10:  # 语料不够时拿已用过的补齐，保证能学
            rows += await self.store.list_corpus(limit=limit - len(rows), is_bot=0)
        if not rows:
            return {"ok": False, "error": "还没有群友/好友的语料——先在群里聊几句（面板「表达学习 → 立即提取」）"}
        by_chat: dict[str, list[str]] = {}
        for r in rows:
            body = str(r.get("text") or "").strip()[:120]
            if not body:
                continue
            who = r.get("user_name") or r.get("user_id") or "某人"
            by_chat.setdefault(f"{r.get('chat_type') or '群聊'}·{who}", []).append(body)
        # 编号原话列表：prompt 要求模型按「行号」回填出处，所以必须先编号，再把编号写进样本
        numbered: list[tuple[int, str, str]] = []          # (行号, 场景标签, 原话)
        for tag, lines in by_chat.items():
            for line in lines[:12]:
                numbered.append((len(numbered) + 1, tag, line))
        numbered = numbered[:60]
        # 逐行拼样本，超 3500 字就停：样本里出现的编号一定在 by_idx 里（模型不会引用到被截掉的行）
        sample_lines: list[str] = []
        used = 0
        for idx, tag, line in numbered:
            item = f"{idx}. [{tag}] {line}"
            if used + len(item) > 3500:
                break
            sample_lines.append(item)
            used += len(item)
        sample = "\n".join(sample_lines)
        prompt = (
            "下面是我这个聊天机器人的群友和好友平时真实说的话（原文照抄，不要改）。\n"
            "请观察他们怎么说话，总结出这个机器人**可以直接套用的说话套路**。\n\n"
            "硬性要求：\n"
            "1. 每条一行，格式：什么时候用|怎么说|参考了第几行原话（可多个，逗号分隔；没参考就留空）\n"
            "2. **不要整句照抄原话**，要抽象成可复用的句式或词。比如原话里出现「我真的会谢」，"
            "写成「夸张地表达无语 → 说『我真的会谢』」；不要写成「私聊 → 我真的会谢 笑不活了」。\n"
            "3. 场景要是**社交情境**（被夸/被调侃/无语/同意/想炫耀/关心人/敷衍…），"
            "不要写「群聊」「私聊」这种聊天场所。\n"
            "4. 说法要具体、能直接说出口，带上原话里的口头禅、语气词、句尾拖音写法。\n"
            "5. 最多 6 条，宁少勿滥。没有值得学的就只输出一行「无」。\n"
            "6. 第三段只填你真的参考过的原话行号（上面编号列表里的号），别瞎填；不要编号、不要 markdown、不要解释。\n\n"
            f"【他们的原话】\n{sample}"
        )
        out = await gen(prompt, "expression_extract")
        saved = 0
        by_idx = {idx: line for idx, _tag, line in numbered}
        for line in str(out or "").splitlines():
            line = line.strip().lstrip("-*0123456789. ")
            if "|" not in line:
                continue
            parts = [x.strip() for x in line.split("|")]
            scene = parts[0] if parts else ""
            way = parts[1] if len(parts) > 1 else ""
            if not scene or not way or way in ("无", "none"):
                continue
            # 出处：模型回填的行号 → 真实原话（最多 3 条）。回填不出来就留空，
            # 面板会明确标"无来源原话"，不假装有出处。
            cues: list[str] = []
            for tok in str(parts[2] if len(parts) > 2 else "").replace("，", ",").split(","):
                tok = tok.strip().lstrip("#")
                if not tok.isdigit():
                    continue
                src = by_idx.get(int(tok))
                if src and src not in cues:
                    cues.append(src[:60])
                if len(cues) >= 3:
                    break
            await self.store.upsert_habit(
                {
                    "scene": scene[:40],
                    "way": way[:120],
                    "cues": cues,
                    "weight": 0.5,
                    "scope": f"学习·{pid}" if pid else "学习",
                    "enabled": 1,
                }
            )
            saved += 1
        if used_ids:
            await self.store.mark_corpus_used(used_ids)
        await self.store.prune_corpus(5000)
        await self.store.audit("habit.extract", f"corpus={len(rows)} saved={saved} persona={pid}")
        return {"ok": True, "saved": saved, "scanned": len(rows), "persona": pid}

    async def summarize_dialogue(
        self,
        turns: list[dict[str, str]],
        *,
        session_id: str = "",
        user_id: str = "",
        user_name: str = "",
        persona_id: str = "",
        image_urls: list[str] | None = None,
    ) -> dict[str, Any]:
        """把一轮对话蒸馏成记忆条目（聊天记忆自动总结）。

        image_urls：图片直接交给模型自己看（原生多模态）。只有这一条路 —— 「先用独立图像模型识别、
        再喂给文本模型」已整段下线（那个模型吃不到 AstrBot 的提示词）。

        turns: [{"user": "...", "bot": "..."}]，由调用方按会话累积。
        走「模型分配」里的 memory_summary 模型；解析失败/无内容都不抛错，只记 audit。
        """
        gen = self.system.get("llm_generate")
        if not callable(gen):
            return {"ok": False, "error": "模型通道不可用"}
        cfg = await self.config()
        if not cfg.get("memory_capture_enabled", True):
            return {"ok": False, "skipped": "capture_disabled"}
        cleaned = [
            t for t in turns
            if (t.get("user") or "").strip() or (t.get("bot") or "").strip()
        ]
        if not cleaned:
            return {"ok": False, "skipped": "empty"}
        limit = int(cfg.get("memory_capture_max_per_run", 5) or 5)
        convo_lines: list[str] = []
        for i, t in enumerate(cleaned[-12:], 1):
            u = (t.get("user") or "").strip().replace("\n", " ")[:200]
            b = (t.get("bot") or "").strip().replace("\n", " ")[:200]
            if u or b:
                convo_lines.append(f"{i}. 用户：{u}\n   助手：{b}")
        if not convo_lines:
            return {"ok": False, "skipped": "empty"}
        who = f"对话对象：{user_name}（{user_id}）" if user_id else ""
        prompt = (
            "下面是一段人机对话。请从中提取**关于对话对象（对方，不是助手自己）**值得长期记住的信息，"
            f"最多 {limit} 条。每条一行，格式：\n"
            "摘要|类型|强度|情绪浓度\n"
            "其中：类型 ∈ planned（未来计划与约定）/factual（客观事实）/preference（偏好习惯）/"
            "routine（日常规律）/episodic（共同经历）/relational（关系与称呼变化）/opinion（用户的观点态度）；"
            "强度与情绪浓度都是 0-1 的小数（如 0.7）。\n"
            "硬性规则：\n"
            "1. 只写用户的事。助手的性格、偏好、想法、对用户的好感一律不记（那是助手自己的状态，不是关于用户的记忆）。\n"
            "2. 不要记录寒暄、表情、客套、安慰与纯闲聊；不记录助手许下的承诺或意愿。\n"
            "3. 只写具体可复述的事实，不要推断、不要编造；同一件事不要重复。\n"
            "4. 简写要像人给自己记的笔记：**不要每条都以「用户」开头**，直接说事"
            "（如「偏好消息分开发送，觉得换行不是好习惯」「下周三约了朋友吃饭」）；"
            "确实需要主语时用「对方」，不要用「用户」二字，也不要以「助手」开头。\n"
            "5. 只写内容本身，不要写「在群里说的」「刚刚用户说」这类来源或时间状语。\n"
            "6. 没有值得记的就只输出一行「无」。不要编号、不要 markdown、不要解释。\n\n"
            f"{who}\n对话内容：\n" + "\n".join(convo_lines)
        )
        custom_prompt = str(cfg.get("memory_summary_prompt") or "").strip()
        if custom_prompt:
            # 「记忆总结自定义提示词」：只替换"指令段"。{transcript} 占位 = 对话正文；
            # 没写占位就把自定义提示词接在内置提示词前面。输出格式行（摘要|类型|强度|情绪浓度）
            # 仍按内置规则解析 —— 自定义时务必保留格式行，否则解析不到记忆。
            transcript = f"{who}\n对话内容：\n" + "\n".join(convo_lines)
            prompt = (
                custom_prompt.replace("{transcript}", transcript)
                if "{transcript}" in custom_prompt
                else custom_prompt + "\n\n" + prompt
            )
        try:
            out = await gen(prompt, "memory_summary")
        except Exception as exc:  # LLM 故障不阻塞对话
            await self.store.audit("memory.capture", f"llm_error {exc}")
            return {"ok": False, "error": str(exc)}
        items: list[dict[str, Any]] = []
        for line in str(out or "").splitlines():
            line = line.strip().lstrip("-*0123456789. ").strip()
            if not line or "|" not in line:
                continue
            parts = [x.strip() for x in line.split("|")]
            summary = parts[0][:200]
            if not summary or summary in ("无", "none", "None"):
                continue
            # 兜底：助手的内心戏/承诺不是「关于用户的记忆」，模型不听话时也拦住
            if _ASSISTANT_SUBJECT.search(summary):
                continue
            atom = (parts[1] if len(parts) > 1 else "factual").lower()
            if atom not in _ATOM_TYPES:
                atom = "factual"
            try:
                strength = float(parts[2]) if len(parts) > 2 else 0.5
            except ValueError:
                strength = 0.5
            try:
                poignancy = float(parts[3]) if len(parts) > 3 else 5.0
            except ValueError:
                poignancy = 5.0
            strength = min(1.0, max(0.05, strength))
            if 0 < poignancy <= 1.0:      # 旧输出是 0-1 制：≤1 一律放大成 0-10，否则 0.7→1 让「情绪保护」永不生效
                poignancy *= 10.0
            poignancy = int(round(min(10.0, max(0.0, poignancy))))
            items.append(
                {
                    "summary": summary,
                    "atom_type": atom,
                    "strength": strength,
                    "poignancy": poignancy,
                }
            )
            if len(items) >= limit:
                break
        if not items:
            await self.store.audit("memory.capture", f"no_memory turns={len(cleaned)}")
            return {"ok": True, "saved": 0, "scanned": len(cleaned)}
        saved = 0
        linked = 0
        link_errors = 0
        evidence = "\n".join(
            f"{(t.get('user') or '').strip()[:80]} / {(t.get('bot') or '').strip()[:80]}"
            for t in cleaned[-3:]
            if (t.get("user") or t.get("bot"))
        )[:500]
        for it in items:
            mid = await self.store.insert_memory(
                {
                    "summary": it["summary"],
                    "content": it["summary"],
                    "atom_type": it["atom_type"],
                    "strength": it["strength"],
                    "poignancy": it["poignancy"],
                    "source_mode": "dialogue",
                    "source_ref": f"capture:{session_id}",
                    "session_id": session_id,
                    "persona_id": persona_id or "",
                    "tags": ["自动总结"],
                    "entities": [user_name] if user_name else [],
                    "cues": [it["summary"][:24]],
                    "evidence": evidence,
                    "recalls": 0,
                    "status": "active",
                }
            )
            if mid:
                saved += 1
                # 关键：新记忆立刻建关系链（实体边 + 同会话时序边 + 共享实体语义边）。
                # 不建链的话图谱就是一堆孤点，用户看到的就是「没有关系链」。
                try:
                    links = await self.store.link_memory(
                        mid,
                        entities=[user_name] if user_name else [],
                        session_id=session_id,
                        persona_id=persona_id or "",
                        cues=[it["summary"][:24]],
                    )
                    linked += sum(links.values())
                except Exception:  # 建链失败不影响记忆本身落库，但要能看见
                    link_errors += 1
        await self.store.audit(
            "memory.capture",
            f"saved={saved} turns={len(cleaned)} session={session_id} links={linked} link_errors={link_errors}",
        )
        return {
            "ok": True,
            "saved": saved,
            "scanned": len(cleaned),
            "links": linked,
            "link_errors": link_errors,
            "ids": [],
        }

    async def purge_stale(self, persona_id: str | None = None) -> dict[str, Any]:
        """清理非活跃记忆（软删）。传 persona_id 只作用于该人格，不传 = 全部人格。"""
        n = await self.store.purge_stale_memories(persona_id)
        await self.store.audit("memory.purge_stale", f"{n} 条" + (f"（人格 {persona_id}）" if persona_id else "（全部人格）"))
        return {"removed": n, "persona_id": persona_id or "", "mode": "soft_delete"}

    async def memory_maintenance(self) -> dict[str, Any]:
        """记忆衰减 + 淘汰（设计里的「向量记忆与衰减」落地点）。"""
        cfg = await self.config()
        half = float(cfg.get("memory_decay_half_life_days") or 21)
        floor = float(cfg.get("memory_evict_below") or 0.08)
        if half <= 0:
            return {"decayed": 0, "evicted": 0}
        await self.store.ensure_strength_updated_at()
        total = int((await (await self.store.db.execute(
            "SELECT COUNT(*) AS n FROM hf_memories WHERE status != 'deleted'")).fetchone())["n"] or 0)
        act = int((await (await self.store.db.execute(
            "SELECT COUNT(*) AS n FROM hf_memories WHERE status='active'")).fetchone())["n"] or 0)
        # 安全阀：active 比例过低说明衰减已经失控（真机出现过 5.5%），先停下并记账，别再继续往下压
        if total >= 50 and act < total * 0.15:
            await self.store.audit("memory.maintenance", f"跳过衰减：active 比例过低 ({act}/{total})")
            return {"decayed": 0, "evicted": 0, "skipped": "active_ratio_too_low", "active": act, "total": total}
        rows = await (await self.store.db.execute(
            "SELECT id, strength, COALESCE(NULLIF(strength_updated_at,0), NULLIF(last_used_at,0), "
            "         occurred_at, created_at) AS ts FROM hf_memories WHERE status='active'"
        )).fetchall()
        decayed = evicted = 0
        stamp = time.time()
        for row in rows:
            cur = float(row["strength"] or 0)
            # 增量幂等：只补算「距上次衰减基线」的这段时间；旧实现拿累计年龄反复乘当前强度 = 复利崩塌
            new_s = engine.decay_strength(cur, engine.age_days(row["ts"]), half)
            if new_s >= cur:
                continue
            decayed += 1
            if new_s < floor:
                evicted += 1
                await self.store.db.execute(
                    "UPDATE hf_memories SET strength=?, strength_updated_at=?, status='stale', updated_at=? WHERE id=?", (new_s, stamp, stamp, row["id"])
                )
            else:
                await self.store.db.execute(
                    "UPDATE hf_memories SET strength=?, strength_updated_at=?, updated_at=? WHERE id=?", (new_s, stamp, stamp, row["id"])
                )
        await self.store.db.commit()
        if decayed:
            await self.store.audit("memory.maintenance", f"decayed={decayed} evicted={evicted}")
        return {"decayed": decayed, "evicted": evicted}

    # ---------------- 表达习惯注入（把学到的说话方式带进 prompt） ----------------
    async def habit_hints(self, persona_id: str = "", limit: int = 6) -> str:
        """把启用的表达习惯拼成注入片段（表达学习从「只提取不使用」变成真生效）。"""
        habits = await self.store.list_habits()
        cfg = await self.config()
        try:
            min_uses = max(0, int(cfg.get("expression_min_uses") or 0))
        except Exception:
            min_uses = 0
        usable = [h for h in habits if h.get("enabled")]
        if persona_id:
            scoped = [h for h in usable if str(h.get("scope") or "") in (f"学习·{persona_id}", "全局")]
            if scoped:
                usable = scoped
        usable.sort(key=lambda h: (float(h.get("weight") or 0.5), int(h.get("uses") or 0)), reverse=True)
        # 「表达最少使用次数」：达到 N 次才算"已验证"，优先注入；没达标的只在名额没用满时补位
        # （不能直接排除：habit_mark_used 只给"启用中的习惯"计数，直接排除会让新习惯永远升不上来）
        verified = [h for h in usable if int(h.get("uses") or 0) >= min_uses]
        fresh = [h for h in usable if int(h.get("uses") or 0) < min_uses]
        picked = (verified + fresh)[:max(1, limit)]
        lines = [f"- {h.get('scene')}→{h.get('way')}" for h in picked if h.get("scene") and h.get("way")]
        if not lines:
            return ""
        return "【表达习惯参考】像真人一样说话，可以参考这些习惯（不要逐字复读）：\n" + "\n".join(lines)

    async def habit_mark_used(self) -> None:
        """注入即计一次使用（weight 演化与面板「生效次数」的数据来源）。"""
        habits = await self.store.list_habits()
        enabled = [h for h in habits if h.get("enabled")][:6]
        stamp = time.time()
        for h in enabled:
            await self.store.db.execute(
                "UPDATE hf_habits SET uses=uses+1, updated_at=? WHERE id=?",
                (stamp, h["id"]),
            )
        if enabled:
            await self.store.db.commit()

    # ---------------- 关系边 ----------------
    async def memory_edges(self, mid: str | int) -> dict[str, Any]:
        return {"items": await self.store.edges_of(mid)}

    async def edge_save(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        n = 0
        for it in items or []:
            if await self.store.update_edge(it.get("id"), it.get("weight"), it.get("status")):
                n += 1
        await self.store.audit("edge.save", f"n={n}")
        return {"saved": n}

    async def config(self) -> dict[str, Any]:
        saved = await self.store.all_config()
        merged = dict(DEFAULT_CONFIG)
        merged.update(saved)
        return merged

    async def save_config(self, patch: dict[str, Any]) -> dict[str, Any]:
        """保存配置：先写本插件库（per-session 开关的家），再**写回原生插件配置**。

        为什么要写回原生：红队审计实测「面板私库 / 原生页 / hf_config」是两份源，只写一份
        就会出现「原生页改了不生效、面板改了原生页看不见」。插件只是调用原生 —— 不另造权威。
        """
        written: dict[str, Any] = {}
        for k, v in (patch or {}).items():
            if k in DEFAULT_CONFIG:
                await self.store.set_config(k, v)
                written[k] = v
        await self.store.audit("config.save", ",".join(list((patch or {}).keys())[:8]))
        native: dict[str, Any] = {"ok": False, "error": "未接入原生写回"}
        fn = self.system.get("save_native_config")
        if callable(fn) and written:
            try:
                native = await fn(written)
            except Exception as exc:                          # noqa: BLE001
                native = {"ok": False, "error": str(exc)[:120]}
        out = await self.config()
        if isinstance(out, dict):
            out["_native_write"] = native                     # 面板可见：哪些键真的写进原生配置了
        return out

    # ---------------- 总览 ----------------
    async def overview(self, persona_id: str = "") -> dict[str, Any]:
        stats = await self.store.stats(persona_id=persona_id)
        cfg = await self.config()
        batches = await self.store.list_batches(3)
        detect = await self.importer.detect_async()
        stats["config"] = {
            "master_switch": cfg["master_switch"],
            "gate_enabled": cfg["gate_enabled"],
            "gate_shadow": cfg["gate_shadow"],
            "output_enabled": cfg["output_enabled"],
            "proactive_enabled": cfg["proactive_enabled"],
        }
        stats["livingmemory"] = {
            "installed": detect["plugin_dir_exists"],
            "db_exists": detect["db_exists"],
            "documents": detect["documents"],
            "atoms": detect["atoms"],
            "imported": detect["already_imported"],
        }
        stats["recent_batches"] = batches
        return stats

    # ---------------- 记忆 ----------------
    async def memories(self, **kw: Any) -> dict[str, Any]:
        return await self.store.list_memories(
            q=kw.get("q", "") or "",
            tag=kw.get("tag", "") or "",
            source=kw.get("source", "") or "",
            page=int(kw.get("page", 1) or 1),
            size=min(int(kw.get("size", 50) or 50), 500),
            persona_id=kw.get("persona_id", "") or "",
        )

    async def memory(self, mid: str) -> dict[str, Any] | None:
        return await self.store.get_memory(mid)

    async def memory_update(self, mid: str, fields: dict[str, Any]) -> dict[str, Any]:
        ok = await self.store.update_memory(mid, fields or {})
        await self.store.audit("memory.update", str(mid), ",".join(list((fields or {}).keys())[:6]))
        return {"updated": ok}

    async def panel_stats(self, persona_id: str = "") -> dict[str, Any]:
        return await self.store.panel_stats(persona_id=persona_id)

    async def purge(self, scope: str, session_id: str = "") -> dict[str, Any]:
        """危险区操作。scope: gate | learning | session。"""
        if scope == "gate":
            removed: Any = await self.store.purge_gate_log()
        elif scope == "learning":
            removed = await self.store.purge_learning()
        elif scope == "session":
            sid = (session_id or "").strip()
            if not sid:
                raise ValueError("missing session_id")
            removed = await self.store.purge_session_memories(sid)
        else:
            raise ValueError(f"unknown scope: {scope}")
        await self.store.audit(f"purge.{scope}", str(removed))
        return {"scope": scope, "removed": removed}

    async def memory_delete(self, mid: str) -> dict[str, Any]:
        await self.store.delete_memory(mid)
        await self.store.audit("memory.delete", str(mid))
        return {"deleted": True}

    async def graph(self, limit: int = 4000, persona_id: str = "") -> dict[str, Any]:
        return await self.store.graph(limit, persona_id=persona_id)

    async def graph_stats(self, persona_id: str = "") -> dict[str, Any]:
        """图谱关系链体检数据（孤立点 / 平均度数 / 连通分量 / 枢纽）。"""
        return await self.store.graph_stats(persona_id)

    async def graph_build(self, limit: int = 3000, persona_id: str = "") -> dict[str, Any]:
        """重建记忆之间的关系链（面板按钮与 hf 命令共用）。

        老库、或只导入过一半的库，记忆之间是没有边的 —— 图谱就只剩孤点。
        重建是幂等的（add_edge 是 upsert），所以可以放心反复点。
        """
        stat = await self.store.rebuild_links(limit, persona_id=persona_id)
        await self.store.audit(
            "graph.rebuild",
            f"persona={persona_id or 'all'} memories={stat.get('memories')} "
            f"entity={stat.get('entity')} temporal={stat.get('temporal')} semantic={stat.get('semantic')}",
        )
        return {"ok": True, **stat, "stats": await self.store.graph_stats(persona_id)}

    # ---------------- 好感 ----------------
    async def favours(self) -> dict[str, Any]:
        items = await self.store.list_favours()
        for it in items:
            it["zone_text"] = ZONE_TEXT.get(it.get("zone", "NEUTRAL"), "")
        return {"items": items}

    async def favour_adjust(self, user_id: str, delta: float, reason: str = "", scope: str = "both", name: str = "") -> dict[str, Any]:
        if not user_id:
            raise ValueError("user_id required")
        cfg = await self.config()
        daily_only = scope == "daily"
        lifetime_only = scope == "lifetime"
        cur = {f["user_id"]: f for f in await self.store.list_favours()}.get(user_id, {})
        ev = list(cur.get("evidence") or [])
        day = self._day_str(cfg)     # 自然日（AstrBot 时区）0:00–23:59，与主动额度同一口径
        # 「好感日上限」：当天正增量累计到 cap 就封顶（0 = 不限）。日记账写进 evidence（面板"依据"列可见）。
        try:
            cap = float(cfg.get("favour_daily_cap") or 0)
        except Exception:
            cap = 0.0
        if cap > 0 and delta > 0:
            used = 0.0
            for e in ev:
                m = re.match(r"^(\d{4}-\d{2}-\d{2})\s*([+-][\d.]+)$", str(e))
                if m and m.group(1) == day and float(m.group(2)) > 0:
                    used += float(m.group(2))
            delta = min(delta, max(0.0, cap - used))
        if delta:
            ev.append(f"{day} {delta:+g}")
        daily = float(cur.get("daily", 0)) + (0 if lifetime_only else delta)
        lifetime = float(cur.get("lifetime", 0)) + (0 if daily_only else delta)
        patch = {
            "name": name or cur.get("name", user_id),
            "session_id": cur.get("session_id", ""),
            "daily": daily,
            "lifetime": lifetime,
            "zone": self.store.zone_of(daily),
            "evidence": ev[-40:],
        }
        out = await self.store.upsert_favour(user_id, patch)
        await self.store.audit("favour.adjust", user_id, f"delta={delta} reason={reason} scope={scope}")
        return out

    async def favour_decay_tick(self) -> int:
        """「好感每日半衰期」：daily 按 half_life 天半衰，避免"很久没聊还满好感"。

        half_life <= 0 = 关闭（DEFAULT_CONFIG 里默认 0；库里配了值就以库里的为准）。
        lifetime 不衰减（那是历史累计，只增不减）。距上次更新不到半天的不动，避免频繁抖动。
        """
        cfg = await self.config()
        try:
            hl = float(cfg.get("favour_daily_half_life_days") or 0)
        except Exception:
            hl = 0.0
        if hl <= 0:
            return 0
        ts = time.time()
        n = 0
        for r in await self.store.list_favours():
            daily = float(r.get("daily") or 0)
            last = float(r.get("updated_at") or 0)
            if daily == 0 or last <= 0:
                continue
            days = max(0.0, (ts - last) / 86400.0)
            if days < 0.5:
                continue
            new = daily * (0.5 ** (days / hl))
            if abs(new - daily) < 0.01:
                continue
            await self.store.upsert_favour(
                r["user_id"], {**r, "daily": new, "zone": self.store.zone_of(new), "evidence": r.get("evidence") or []}
            )
            n += 1
        if n:
            await self.store.audit("favour.decay", str(n), f"half_life={hl}d")
        return n

    async def withdraw_reply_trace(self, session_id: str, minutes: int = 10) -> int:
        """「撤回连回复一起撤」：把该会话最近这段落库的 bot 语料撤掉（本地一定做得到的那部分）。

        平台侧删消息需要"bot 那条回复的消息 id"，AstrBot 没有把这个 id 交给插件，所以不在这项能力内；
        调用方会把这一限制写进日志，不做静默假装。
        """
        if not session_id:
            return 0
        since = time.time() - max(1, int(minutes)) * 60
        n = await self.store.drop_bot_corpus_since(session_id, since)
        if n:
            await self.store.audit("recall.withdraw_reply", session_id, f"清掉 bot 语料 {n} 条")
        return n

    # ---------------- 表达习惯 ----------------
    async def habits(self) -> dict[str, Any]:
        return {"items": await self.store.list_habits()}

    async def habit_save(self, habit: dict[str, Any]) -> dict[str, Any]:
        hid = await self.store.upsert_habit(habit or {})
        await self.store.audit("habit.save", str(hid), habit.get("scene", ""))
        return {"id": hid}

    async def habit_delete(self, hid: int) -> dict[str, Any]:
        await self.store.delete_habit(int(hid))
        await self.store.audit("habit.delete", str(hid))
        return {"deleted": True}

    # ---------------- 门控 / token ----------------
    async def gate_log(self, limit: int = 100, offset: int = 0) -> dict[str, Any]:
        return {
            "items": await self.store.list_gate(max(1, min(limit, 200)), max(0, offset)),
            "total": await self.store.count_gate(),
        }

    async def tokens(self, days: int = 7) -> dict[str, Any]:
        return await self.store.tokens_summary(days)

    # ---------------- 人格（走注入的原生 provider） ----------------
    async def personas(self) -> dict[str, Any]:
        if not self.persona.get("list"):
            return {"available": False, "items": [], "active": ""}
        items = await self.persona["list"]()
        cfg = await self.config()
        # 只用 AstrBot 原生人格：当前人格一律问 AstrBot，
        # 插件的 persona_active_id 只在原生接口读不到时当兜底（例如插件先启动了）。
        active = ""
        if self.system.get("active_persona"):
            try:
                active = str(await self.system["active_persona"]() or "")
            except Exception:
                active = ""
        if not active:
            active = str(cfg.get("persona_active_id", "") or "")
        counts = await self.store.persona_memory_counts()
        return {
            "available": True,
            "items": items,
            "active": active,
            "counts": counts,
            "isolated": bool(cfg.get("memory_persona_isolated", True)),
        }

    async def persona_save(self, payload: dict[str, Any]) -> dict[str, Any]:
        # 面板里改人格 = 一次"保存"，记下时间给「人格状态与进化」显示
        await self.store.set_config("persona_last_save_at", time.time())
        if not self.persona.get("update"):
            raise ValueError("persona provider unavailable")
        pid = (payload or {}).get("persona_id") or ""
        if not pid:
            raise ValueError("persona_id required")
        fields = {k: payload[k] for k in ("system_prompt", "begin_dialogs", "tools") if k in (payload or {})}
        await self.persona["update"](pid, fields)
        await self.store.audit("persona.update", pid, ",".join(fields.keys()))
        return {"updated": True}

    async def persona_set_active(self, pid: str) -> dict[str, Any]:
        """切换人格：走 AstrBot 官方配置路径真切换，并同步插件库 persona_active_id。"""
        result: dict[str, Any] = {}
        if self.system.get("activate_persona"):
            result = await self.system["activate_persona"](pid) or {}
        await self.store.set_config("persona_active_id", pid)
        await self.store.audit("persona.active", pid)
        return {"active": pid, "applied": bool(result.get("ok")), "error": result.get("error", "")}

    # ---------------- 系统读取（模型 / 人格等真实配置） ----------------
    async def providers(self) -> dict[str, Any]:
        """读取 AstrBot 真实的模型提供商配置（面板「模型分配」用）。"""
        if not self.system.get("providers"):
            return {"available": False, "llm": [], "tts": [], "embedding": [], "stt": [], "note": "当前 AstrBot 未提供模型列表接口"}
        try:
            data = await self.system["providers"]()
        except Exception as exc:
            return {"available": False, "llm": [], "tts": [], "embedding": [], "stt": [], "note": f"读取失败：{exc}"}
        data["available"] = True
        return data

    async def model_test(self, task: str, provider_id: str) -> dict[str, Any]:
        """试跑：真调一次所选提供商（LLM 走 text_chat，嵌入/重排走 get_embedding）。"""
        if not self.system.get("model_test"):
            return {"ok": False, "error": "当前 AstrBot 未提供模型调用接口"}
        try:
            return await self.system["model_test"](task, provider_id)
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:200]}

    # ---------------- livingmemory 导入 ----------------
    async def import_detect(self) -> dict[str, Any]:
        info = await self.importer.detect_async()
        info["running"] = self._import_state.get("phase") not in ("idle", "done", "error")
        info["state"] = dict(self._import_state)
        info["batches"] = await self.store.list_batches(10)
        return info

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._import_subs.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self._import_subs:
            self._import_subs.remove(q)

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        self._import_state = dict(payload)
        for q in list(self._import_subs):
            try:
                q.put_nowait(dict(payload))
            except asyncio.QueueFull:
                pass

    async def import_start(self, layers: list[str] | None = None, limit: int | None = None) -> dict[str, Any]:
        if self._import_task and not self._import_task.done():
            return {"started": False, "message": "已有导入任务在运行"}
        detect = await self.importer.detect_async()
        if not detect["db_exists"]:
            return {"started": False, "message": "未检测到 astrbot_plugin_livingmemory 数据库"}
        self._import_watch = True
        self._import_task = asyncio.create_task(self._run_import(layers, limit))
        return {"started": True, "total": detect["documents"] + detect["atoms"], "watch": True}

    async def _run_import(self, layers: list[str] | None, limit: int | None) -> None:
        try:
            await self.importer.run(self._broadcast, layers=layers, limit=limit)
            if self._import_watch:
                await self._broadcast(
                    {"phase": "watch", "message": "后台监控中：每 60s 检查源库新增并自动增量导入，直到追平"}
                )
        except Exception as exc:  # 导入失败要显式暴露给面板
            await self._broadcast({"phase": "error", "message": f"导入失败：{exc}"})
            await self.store.audit("import.error", SOURCE_NAME, str(exc))

    async def import_watch_tick(self) -> None:
        """后台循环调用：源库有新增就增量导入（幂等），追平后自动停止监控。"""
        if not self._import_watch or (self._import_task and not self._import_task.done()):
            return
        try:
            detect = await self.importer.detect_async()
        except Exception as exc:
            await self.store.audit("import.watch.error", SOURCE_NAME, f"对账失败：{exc}")
            return
        if not detect["db_exists"]:
            self._import_watch = False
            await self.store.audit("import.watch.stop", SOURCE_NAME, "源库不存在，停止监控")
            return
        source_total = detect["documents"] + detect["atoms"]
        imported = detect["already_imported"]
        if imported >= source_total:
            self._import_watch = False
            await self.store.audit("import.watch.done", SOURCE_NAME, f"已追平 {imported}/{source_total}，停止监控")
            await self._broadcast({"phase": "done", "done": source_total, "total": source_total, "message": "已追平源库，监控结束"})
            return
        await self.store.audit("import.watch.tick", SOURCE_NAME, f"新增 {source_total - imported} 条，开始增量导入")
        await self._broadcast(
            {"phase": "watch", "done": imported, "total": source_total, "message": f"发现新增 {source_total - imported} 条，自动增量导入"}
        )
        self._import_task = asyncio.create_task(self._run_watch_import())

    async def _run_watch_import(self) -> None:
        try:
            await self.importer.run(self._broadcast, layers=["documents", "atoms"], limit=None)
            if self._import_watch:
                await self._broadcast({"phase": "watch", "message": "增量完成，继续监控源库"})
        except Exception as exc:
            await self._broadcast({"phase": "error", "message": f"增量导入失败：{exc}"})
            await self.store.audit("import.error", SOURCE_NAME, str(exc))

    async def import_events(self):
        """SSE 生成器：先推当前状态，再实时推进度。"""
        q = self.subscribe()
        try:
            yield {"phase": self._import_state.get("phase", "idle"), "message": "已连接导入进度"}
            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=20)
                except TimeoutError:
                    yield {"phase": "ping", "message": "keepalive"}
                    continue
                yield item
                if item.get("phase") in ("done", "error"):
                    break
        finally:
            self.unsubscribe(q)

    # ---------------- 其他 ----------------
    async def audit(self, limit: int = 50) -> dict[str, Any]:
        return {"items": await self.store.list_audit(limit)}

    async def persona_zone_preview(self) -> dict[str, Any]:
        favs = await self.store.list_favours()
        return {
            "zones": [
                {"zone": z, "text": t, "users": [f["user_id"] for f in favs if f.get("zone") == z]}
                for z, t in ZONE_TEXT.items()
            ]
        }

    async def health(self) -> dict[str, Any]:
        return {"ok": True, "ts": time.time(), "source": SOURCE_NAME}

    # ===================== 记忆库（管理表）/ 召回 / 原文补齐 =====================

    async def memory_search(
        self,
        q: str = "",
        session_id: str = "",
        persona_id: str = "",
        status: str = "",
        atom_type: str = "",
        source: str = "",
        sort: str = "recent",
        limit: int = 20,
        offset: int = 0,
    ) -> dict[str, Any]:
        """记忆库管理表：关键词（含 ID/内容）+ 会话 + 状态 + 类型 + 来源 筛选，可排序分页。"""
        return await self.store.search_memories(
            q=q, session_id=session_id, persona_id=persona_id, status=status,
            atom_type=atom_type, source=source, sort=sort, limit=limit, offset=offset,
        )

    async def memory_sessions(self) -> dict[str, Any]:
        """会话清单 + 人格清单（记忆库按人格分类）。"""
        return {
            "items": await self.store.memory_sessions(),
            "personas": await self.store.memory_personas(),
            "msg": await self.store.msg_stats(),
        }

    async def vector_gens(self) -> dict[str, Any]:
        """多代向量库：每一代的模型/维度/覆盖率 + 当前在用哪一代。"""
        await self.store.ensure_vector_migration()
        gens = await self.store.gen_stats()
        active = next((g for g in gens if g["active"]), None)
        src = (await self.config()).get("model_embedding") or ""
        return {"ok": True, "items": gens, "active": active, "current_model": src,
                "note": "换模型/维度会新建一代，旧代保留（暂停使用），新代建好再切换；换回来立刻可用，不用重算"}

    async def vector_switch(self, gen_key: str) -> dict[str, Any]:
        gens = await self.store.gen_stats()
        if not any(g["gen_key"] == gen_key for g in gens):
            return {"ok": False, "error": "没有这一代向量库"}
        await self.store.set_active_gen(gen_key)
        await self.store.audit("vector.switch", gen_key, "")
        return {"ok": True, "active": gen_key, "items": await self.store.gen_stats()}

    async def vector_drop(self, gen_key: str) -> dict[str, Any]:
        n = await self.store.drop_gen(gen_key)
        await self.store.audit("vector.drop", gen_key, f"{n} 条")
        return {"ok": True, "removed": n, "items": await self.store.gen_stats()}

    async def embedding_coverage(self) -> dict[str, Any]:
        """向量覆盖按"当前代"算（旧列 embedding 已经不代表真相：换模型后旧向量会被暂停）。"""
        cov = await self.store.embedding_coverage()
        cfg = await self.config()
        model = str(cfg.get("model_embedding") or "")
        await self.store.ensure_vector_migration()
        gen = await self.store.active_gen()
        total = (await self.store.gen_stats()) or []
        act = next((g for g in total if g["gen_key"] == gen), None)
        if act:
            cov["total"] = act["total"]
            cov["embedded"] = act["covered"]
            cov["missing"] = max(0, act["total"] - act["covered"])
            cov["gen"] = act["gen_key"]
            cov["dim"] = act["dim"]
        cov["model"] = model
        cov["status"] = await self.store.status_counts()
        return cov

    async def sync_active_gen(self) -> dict[str, Any]:
        """模型即切换按钮：配置里选了哪个向量模型，就切到"那一代"向量库（维度不同也不影响）。

        逻辑：按模型名找已有的代 → 找到就用它（换回旧模型 = 秒切回旧向量库）；
        没找到就留空，等第一次回填时按真实维度建新代（旧代保持不动）。
        """
        cfg = await self.config()
        model = str(cfg.get("model_embedding") or "").strip()
        if not model:
            return {"ok": False, "error": "未配置向量嵌入模型"}
        await self.store.ensure_vector_migration()
        gens = await self.store.gen_stats()
        want = self.store.norm_model(model)
        same = [g for g in gens if self.store.norm_model(str(g["model"])) == want]
        if not same:
            return {"ok": True, "switched": False, "note": f"还没有「{model}」这一代向量，回填时会自动建立", "items": gens}
        # 同模型可能有多代（历史维度不同）：优先覆盖率高的一代
        best = sorted(same, key=lambda g: g["covered"], reverse=True)[0]
        if not best["active"]:
            await self.store.set_active_gen(best["gen_key"])
            await self.store.audit("vector.autoswitch", best["gen_key"], f"model={model}")
        return {"ok": True, "switched": True, "active": best["gen_key"], "dim": best["dim"],
                "coverage": best["coverage"], "items": await self.store.gen_stats()}

    async def model_dims(self) -> dict[str, Any]:
        """每个向量模型已知的维度（从已有代推出来的；面板模型分配里显示用）。"""
        await self.store.ensure_vector_migration()
        out: dict[str, int] = {}
        for g in await self.store.gen_stats():
            m = str(g["model"] or "").strip()
            if m and int(g["dim"] or 0) > 0:
                out[m] = max(out.get(m, 0), int(g["dim"]))
        return {"ok": True, "dims": out, "active_gen": await self.store.active_gen()}

    async def config_save_sync(self) -> dict[str, Any]:
        """配置保存后的副作用：向量模型变了就自动切到对应代。"""
        try:
            return await self.sync_active_gen()
        except Exception as exc:                             # noqa: BLE001
            return {"ok": False, "error": str(exc)[:120]}

    async def memory_reactivate(self, ids: list[int] | None = None, floor: float = 0.45) -> dict[str, Any]:
        """批量激活（把 stale/decayed 拉回召回范围）。"""
        n = await self.store.reactivate(ids=ids, floor=float(floor or 0.45))
        await self.store.audit("memory.reactivate", ",".join(str(i) for i in (ids or [])[:8]) or "all-stale", f"{n} 条")
        cov = await self.store.embedding_coverage()
        return {"ok": True, "reactivated": n, "coverage": cov}

    async def messages_list(self, session_id: str, q: str = "", limit: int = 200, offset: int = 0) -> dict[str, Any]:
        return await self.store.messages_for_session(session_id=session_id, q=q, limit=limit, offset=offset)

    async def memory_evidence(self, mid: str) -> dict[str, Any]:
        """详情页的"详细对话"：① 记忆学自哪几句（精确）② 原文（不截断）③ 那一刻前后的真实对话。"""
        raw = str(mid).lstrip("m")
        mem = await self.store.get_memory(raw)
        if mem is None:
            return {"ok": False, "error": "memory not found"}
        sources = await self.store.memory_sources(raw)
        text = mem.get("source_text") or ""
        sid = mem.get("session_id") or ""
        ts = float(mem.get("occurred_at") or mem.get("created_at") or 0)
        around = await self.store.messages_around(sid, ts, before=8, after=8) if sid else []
        have_msgs = len((await self.messages_list(sid, limit=1))["items"]) > 0 if sid else False
        return {
            "ok": True,
            "id": raw,
            "sources": sources,
            "source_text": text,
            "around": around,
            "session_id": sid,
            "session_has_messages": have_msgs,
            "note": "" if (sources or around) else (
                "这条记忆是导入来的旧数据，来源库没留下对应对话" if mem.get("external_source") else
                "这条记忆写入时没带上下文（旧版本行为），新记忆都会带"
            ),
        }

    async def import_extras(self) -> dict[str, Any]:
        """补齐 livingmemory 的会话消息 / 记忆来源轮次 / 完整原文（幂等，可反复点）。"""
        if self._import_task and not self._import_task.done():
            return {"ok": False, "error": "已有导入任务在跑，等它跑完再点"}
        out = await self.importer.import_extras(self._broadcast)
        out["ok"] = True
        out["stats"] = await self.store.msg_stats()
        await self.store.audit("import.extras", "livingmemory", str(out)[:200])
        return out

    # ===================== 自动遗忘生命周期 =====================

    async def lifecycle_preview(self) -> dict[str, Any]:
        """面板要看的两条队列 + 现状统计（只读）。"""
        cfg = await self.config()
        arch = float(cfg.get("archive_after_days") or 30)
        forg = float(cfg.get("forget_after_days") or 30)
        queue = await self.store.memory_lifecycle_scan(archive_days=arch, forget_days=forg)
        nowt = __import__("time").time()
        arch_cut = nowt - arch * 86400
        return {
            "ok": True,
            "enabled": bool(cfg.get("forget_enabled", True)),
            "archive_after_days": arch,
            "forget_after_days": forg,
            "min_strength": float(cfg.get("forget_min_strength") or 0.35),
            "keep_poignancy": float(cfg.get("forget_keep_poignancy") or 8),
            "counts": await self.store.lifecycle_counts(),
            "archive_queue": [x for x in queue if x.get("status") == "active" and float(x.get("last_touch") or 0) < arch_cut],
            "forget_queue": [x for x in queue if x.get("status") == "archived"],
        }

    async def lifecycle_tick(self, limit: int | None = None, dry: bool = False) -> dict[str, Any]:
        """跑一轮：归档 + 遗忘。被提及过的（last_used_at 新）自然不会被选中。"""
        cfg = await self.config()
        if not cfg.get("forget_enabled", True):
            return {"ok": True, "skipped": "自动遗忘已关闭"}
        arch = float(cfg.get("archive_after_days") or 30)
        forg = float(cfg.get("forget_after_days") or 30)
        min_s = float(cfg.get("forget_min_strength") or 0.35)
        keep_p = float(cfg.get("forget_keep_poignancy") or 8)
        limit = int(limit or cfg.get("forget_batch_per_tick") or 20)
        pv = await self.lifecycle_preview()
        arch_ids = [int(x["id"]) for x in pv["archive_queue"][:limit]]
        # 遗忘只针对"不重要"的：强度低于阈值 且 情绪强度不高（重要记忆受保护）
        forget_ids = [
            int(x["id"])
            for x in pv["forget_queue"]
            if float(x.get("strength") or 0) < min_s and float(x.get("poignancy") or 0) < keep_p
        ][:limit]
        if dry:
            return {"ok": True, "dry": True, "would_archive": len(arch_ids), "would_forget": len(forget_ids)}
        # 「记忆遗忘评估」：配了模型就先让模型在这些候选里挑"哪条真该忘"。
        # 模型只能**收窄**候选（阈值已经先筛过一遍），失败就退回阈值判定 —— 永不因为模型乱来而多忘。
        if forget_ids and str(cfg.get("model_forget") or ""):
            picked = await self._model_pick_forget(forget_ids)
            if picked is not None:
                forget_ids = picked
        n_a = await self.store.archive_memories(arch_ids, why="idle")
        n_f = await self.store.forget_memories(forget_ids, why="unimportant")
        if n_a or n_f:
            await self.store.audit("memory.lifecycle", f"archive={n_a} forget={n_f}", f"arch={arch}d forget={forg}d")
        return {"ok": True, "archived": n_a, "forgotten": n_f, "counts": await self.store.lifecycle_counts()}

    async def _model_pick_forget(self, ids: list[int]) -> list[int] | None:
        """让「记忆遗忘评估」模型在这些候选里挑出真正可以忘掉的 id。

        返回 None = 模型不可用/输出没法解析 → 调用方退回阈值判定（保守：宁可少忘）。
        """
        gen = self.system.get("llm_generate")
        if not callable(gen) or not ids:
            return None
        sql = "SELECT id, summary, strength, poignancy, recalls FROM hf_memories WHERE id IN (%s)" % ",".join("?" * len(ids))
        rows = await (await self.store.db.execute(sql, ids)).fetchall()
        if not rows:
            return None
        lines = [
            "%s | 强度%.2f | 情绪%s | 被提及%s次 | %s"
            % (r["id"], float(r["strength"] or 0), r["poignancy"], r["recalls"], str(r["summary"] or "")[:60])
            for r in rows
        ]
        prompt = (
            "下面是长期没人提起的记忆候选，请判断哪些**可以安全忘掉**。\n\n"
            "判断标准：只留那些「事实性、可重新问到、对关系没有长期价值」的；"
            "凡是涉及人、偏好、约定、共同经历、称呼、雷区的，一律保留。\n\n"
            "只输出可以忘掉的 id，一行一个；一个都没有就只输出「无」。不要解释、不要编号、不要其它文字。\n\n"
            + "\n".join(lines)
        )
        try:
            out = await gen(prompt, "forget")
        except Exception as exc:                            # noqa: BLE001 模型挂了不许影响遗忘主流程
            logger.debug(f"[StarHeart] 遗忘评估失败，退回阈值判定：{exc}")
            return None
        picked: list[int] = []
        for line in str(out or "").splitlines():
            line = line.strip()
            if not line or line in ("无", "none", "None", "没有"):
                continue
            for tok in re.findall(r"\d+", line):
                v = int(tok)
                if v in ids and v not in picked:
                    picked.append(v)
        if not picked:
            return []                                        # 模型说"一条都不用忘" → 尊重它
        await self.store.audit("memory.forget.review", f"{len(ids)}→{len(picked)}", "模型筛过遗忘候选")
        return picked

    # ===================== 消息事件聚合（该页一次取全，前端不再自己拼） =====================

    async def message_hub(self, limit: int = 60, session_id: str = "") -> dict[str, Any]:
        """门控 / 主动 / 撤回三源合并：KPI + 24h 节律 + 漏斗原料 + 跳过原因 + 统一事件流。

        为什么在后端聚合：前端要发 6 次请求再对齐时间与分桶，既慢又容易前后不一致；
        数据量又很小（门控 230 / 主动 5974），一次算完最省事也最准。
        """
        import json as _json
        import time as _t

        nowt = _t.time()
        day = nowt - 86400
        week = nowt - 7 * 86400      # 注意：是"时间戳-7天"，不是 day*7（曾因此热力图全 0）
        month = nowt - 30 * 86400
        where_s = ""
        args: list[Any] = []
        if session_id:
            where_s = " AND session_id=?"
            args = [session_id]
        db = self.store.db
        # 三类各取最近 per 条再合并：门控/撤回数据量远小于主动，若统一 LIMIT，
        # 时间轴会被"主动"淹没（实测 60 条全是 proactive）→ 页面就没用了。
        per = max(10, int(limit) // 3)

        async def week_grid(table: str, extra: str = "") -> list[list[int]]:
            """7(周一..周日) × 24 小时 计数网格。SQLite 的 %w 是 0=周日，手动挪成周一开头。"""
            grid = [[0] * 24 for _ in range(7)]
            rows = await (await db.execute(
                "SELECT CAST(strftime('%w', ts, 'unixepoch') AS INT) AS w,"
                " CAST(strftime('%H', ts, 'unixepoch') AS INT) AS h, COUNT(*) AS n"
                f" FROM {table} WHERE ts>?{extra} GROUP BY w, h",
                # 占位符与参数必须配平：extra 里没有 ? 时不能把 args 全塞进去
                # （审查实证：带会话筛选时 1 个占位符配 2 个参数 → sqlite3.ProgrammingError → 整页 500）
                [week, *list(args)[: extra.count("?")]])).fetchall()
            for r in rows:
                w = (int(r["w"]) + 6) % 7
                h = int(r["h"])
                if 0 <= w <= 6 and 0 <= h <= 23:
                    grid[w][h] = int(r["n"])
            return grid

        # ---------- 门控 ----------
        gate_rows = await (await db.execute(
            f"SELECT * FROM hf_gate_log WHERE 1=1{where_s} ORDER BY ts DESC LIMIT ?", [*args, per]
        )).fetchall()
        gate_all = (await (await db.execute("SELECT COUNT(*) FROM hf_gate_log")).fetchone())[0]
        gate_24 = (await (await db.execute(
            f"SELECT COUNT(*) FROM hf_gate_log WHERE ts>?{where_s}", [day, *args])).fetchone())[0]
        gate_by_dec: dict[str, int] = {}
        for r in await (await db.execute(
                f"SELECT decision, COUNT(*) AS n FROM hf_gate_log WHERE 1=1{where_s} GROUP BY decision", args)).fetchall():
            gate_by_dec[str(r["decision"] or "")] = int(r["n"])
        gate_hours = [0] * 24
        for r in await (await db.execute(
                f"SELECT CAST(strftime('%H', ts, 'unixepoch') AS INT) AS h, COUNT(*) AS n"
                f" FROM hf_gate_log WHERE ts>?{where_s} GROUP BY h", [week, *args])).fetchall():
            if 0 <= int(r["h"]) <= 23:
                gate_hours[int(r["h"])] = int(r["n"])
        gate_bands: dict[str, int] = {}
        for r in await (await db.execute(
                f"SELECT CAST(score/20 AS INT)*20 AS b, COUNT(*) AS n FROM hf_gate_log"
                f" WHERE 1=1{where_s} GROUP BY b ORDER BY b", args)).fetchall():
            gate_bands[str(int(r["b"]))] = int(r["n"])

        # ---------- 主动 ----------
        pro_rows = await (await db.execute(
            f"SELECT * FROM hf_proactive_log WHERE 1=1{where_s} ORDER BY ts DESC LIMIT ?", [*args, per]
        )).fetchall()
        pro_24 = (await (await db.execute(
            f"SELECT COUNT(*) FROM hf_proactive_log WHERE ts>?{where_s}", [day, *args])).fetchone())[0]
        pro_by_status: dict[str, int] = {}
        for r in await (await db.execute(
                f"SELECT status, COUNT(*) AS n FROM hf_proactive_log WHERE 1=1{where_s} GROUP BY status", args)).fetchall():
            pro_by_status[str(r["status"] or "")] = int(r["n"])
        pro_reasons = [dict(r) for r in await (await db.execute(
            f"SELECT reason, COUNT(*) AS n FROM hf_proactive_log WHERE 1=1{where_s}"
            f" GROUP BY reason ORDER BY n DESC LIMIT 6", args)).fetchall()]
        pro_zones: dict[str, int] = {}
        for r in await (await db.execute(
                f"SELECT zone, COUNT(*) AS n FROM hf_proactive_log WHERE 1=1{where_s} GROUP BY zone", args)).fetchall():
            pro_zones[str(r["zone"] or "未标")] = int(r["n"])
        pro_hours = [0] * 24
        for r in await (await db.execute(
                f"SELECT CAST(strftime('%H', ts, 'unixepoch') AS INT) AS h, COUNT(*) AS n"
                f" FROM hf_proactive_log WHERE status='sent' AND ts>?{where_s} GROUP BY h",
                [month, *args])).fetchall():
            if 0 <= int(r["h"]) <= 23:
                pro_hours[int(r["h"])] = int(r["n"])

        # ---------- 撤回 ----------
        recall_rows = await (await db.execute(
            f"SELECT * FROM hf_recall_log WHERE 1=1{where_s} ORDER BY ts DESC LIMIT ?", [*args, per]
        )).fetchall()
        recall_total = (await (await db.execute(
            f"SELECT COUNT(*) FROM hf_recall_log WHERE 1=1{where_s}", args)).fetchone())[0]

        # ---------- 会话清单（筛选下拉用）----------
        sess: dict[str, int] = {}
        for r in await (await db.execute(
                "SELECT session_id, COUNT(*) AS n FROM ("
                " SELECT session_id FROM hf_gate_log UNION ALL SELECT session_id FROM hf_proactive_log"
                ") GROUP BY session_id ORDER BY n DESC LIMIT 30")).fetchall():
            sess[str(r["session_id"] or "")] = int(r["n"])

        # ---------- 三源合并成统一事件流 ----------
        stream: list[dict[str, Any]] = []
        for r in gate_rows:
            d = dict(r)
            try:
                d["factors"] = _json.loads(d.get("factors") or "{}")
            except (TypeError, ValueError):
                d["factors"] = {}
            stream.append({"kind": "gate", "ts": d.get("ts") or 0, "session_id": d.get("session_id") or "",
                           "user_id": d.get("user_id") or "", "data": d})
        for r in pro_rows:
            d = dict(r)
            try:
                d["guard"] = _json.loads(d.get("guard") or "{}")
            except (TypeError, ValueError):
                d["guard"] = {}
            stream.append({"kind": "proactive", "ts": d.get("ts") or 0, "session_id": d.get("session_id") or "",
                           "user_id": d.get("user_id") or "", "data": d})
        for r in recall_rows:
            d = dict(r)
            stream.append({"kind": "recall", "ts": d.get("ts") or 0, "session_id": d.get("session_id") or "",
                           "user_id": d.get("user_id") or "", "data": d})
        stream.sort(key=lambda x: -float(x.get("ts") or 0))

        sent = int(pro_by_status.get("sent", 0))
        skipped = int(pro_by_status.get("skipped", 0))
        cand = int(pro_by_status.get("candidate", 0))
        return {
            "ok": True,
            "kpi": {
                "gate_24h": int(gate_24), "gate_total": int(gate_all),
                "gate_reply": int(gate_by_dec.get("reply", 0)),
                "gate_silent": int(gate_by_dec.get("silent", 0)),
                "gate_backoff": int(gate_by_dec.get("backoff", 0)),
                "pro_24h": int(pro_24), "pro_sent": sent, "pro_skipped": skipped, "pro_candidate": cand,
                "recall_total": int(recall_total),
            },
            "rhythm": {"gate_hours": gate_hours, "pro_hours": pro_hours},
            "grid": {"gate": await week_grid("hf_gate_log"),
                     "pro": await week_grid("hf_proactive_log", " AND status='sent'")},
            "gate_bands": gate_bands,
            "gate_threshold": float((await self.config()).get("gate_threshold") or 80),
            "pro_reasons": pro_reasons,
            "pro_zones": pro_zones,
            "sessions": sess,
            "stream": stream[:limit],
            "per_kind": per,
            "counts": {"gate": int(gate_all), "pro": sent + skipped + cand, "recall": int(recall_total)},
        }
