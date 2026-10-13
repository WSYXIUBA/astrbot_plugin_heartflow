"""StarHeart 引擎核心：纯函数，不依赖 astrbot，便于单测与面板试算复用。

门控不是让 LLM 判断要不要开口，而是本地公式打分（零 LLM 成本）：
    score = (base × state × relation) - penalty
base 由内容特征与相关性组成，state/relation 是乘性系数，penalty 是短反应/存在感惩罚。
"""

from __future__ import annotations

import re
import time
from typing import Any

# 内容特征权重（可被面板配置覆盖的部分留在 service 层）
AT_WEIGHT = 100
PRIVATE_BASE = 40
QUESTION_WEIGHT = 15
REQUEST_WEIGHT = 20
MENTION_WEIGHT = 35
SHORT_REPLY_PENALTY = -25
PRESENCE_PENALTY = -8
PRESSURE_BONUS = 12

QUESTION_PAT = re.compile(r"[?？]|(吗|呢|怎么|为什么|如何|是不是|能不能|可不可以)\s*$")
REQUEST_PAT = re.compile(r"(帮我|麻烦|请|来个|写个|看下|查一下|推荐|教我)")
SHORT_PAT = re.compile(r"^[\s\S]{0,3}$")
FAVOUR_TAG_PAT = re.compile(r"\[\s*(?:好感度?|favou?r)\s*[:：]?\s*(?:持平|没有?变化|unchanged|[+-]?\d+(?:\.\d+)?)\s*\]", re.I)


def zone_of(score: float) -> str:
    if score >= 80:
        return "DEVOTED"
    if score >= 60:
        return "CLOSE"
    if score >= 30:
        return "FAMILIAR"
    if score >= 0:
        return "NEUTRAL"
    if score >= -30:
        return "COLD"
    return "HOSTILE"


def relation_coefficient(favour_daily: float) -> float:
    """好感 → 关系系数：0.7 ~ 1.4，越亲近越愿意开口。

    阈值必须与 zone_of() 的档位边界一一对应。以前 CLOSE(60-79) 与 DEVOTED(≥80)
    共用 `>= 60 → 1.4` 同一档，导致「亲密」和「挚爱」对门控完全等价，档位白分。
    """
    if favour_daily >= 80:          # DEVOTED
        return 1.4
    if favour_daily >= 60:          # CLOSE
        return 1.3
    if favour_daily >= 30:          # FAMILIAR
        return 1.15
    if favour_daily >= 0:           # NEUTRAL
        return 1.0
    if favour_daily >= -30:         # COLD
        return 0.85
    return 0.7                      # HOSTILE


def score_message(
    text: str,
    *,
    is_at: bool = False,
    is_private: bool = False,
    window_count: int = 0,
    pressure: float = 50.0,
    relation_coef: float = 1.0,
    state_coef: float = 1.0,
    in_backoff: bool = False,
    threshold: float = 80.0,
) -> dict[str, Any]:
    """对一条消息打分。返回总分与各因子明细，供面板展示与落库。"""
    t = (text or "").strip()
    if in_backoff:
        return {
            "score": 0.0,
            "decision": "backoff",
            "factors": {"backoff": True, "window_count": window_count},
            "reason": "退避中，跳过本轮评估",
        }
    factors: dict[str, float] = {}
    if is_at:
        factors["at_me"] = float(AT_WEIGHT)
    if is_private:
        factors["private"] = float(PRIVATE_BASE)
    if QUESTION_PAT.search(t):
        factors["question"] = float(QUESTION_WEIGHT)
    if REQUEST_PAT.search(t):
        factors["request"] = float(REQUEST_WEIGHT)
    if not is_private and not is_at and window_count >= 2:
        factors["presence"] = float(PRESENCE_PENALTY) * min(window_count - 1, 3)
    if SHORT_PAT.match(t) and not is_private:
        factors["short_reply"] = float(SHORT_REPLY_PENALTY)
    if pressure >= 70:
        factors["pressure_bonus"] = float(PRESSURE_BONUS)
    base = sum(factors.values())
    score = base * max(0.2, state_coef) * max(0.2, relation_coef)
    factors["state_coef"] = round(state_coef, 3)
    factors["relation_coef"] = round(relation_coef, 3)
    score = round(max(0.0, min(100.0, score)), 1)
    return {
        "score": score,
        "decision": decide(score, threshold),
        "factors": factors,
        "reason": "本地公式评分（未经过 LLM）",
    }


def decide(score: float, threshold: float) -> str:
    """阈值判据：达到阈值才回。原始分（可为负）低于 0 直接沉默。"""
    return "reply" if score >= max(1.0, threshold) else "silent"


def extract_favour_tag(text: str) -> tuple[str, float | None]:
    """把主 LLM 尾行的好感自报标签剥离出来，返回（干净文本, 增减值）。持平 = 0。"""
    if not text:
        return text, None
    match = FAVOUR_TAG_PAT.search(text)
    if match is None:
        return text, None
    inner = match.group(0)
    if "持平" in inner or "没有变化" in inner or "无变化" in inner or "unchanged" in inner.lower():
        delta = 0.0
    else:
        num = re.search(r"[+-]?\d+(?:\.\d+)?", inner)
        delta = float(num.group(0)) if num else None
    cleaned = FAVOUR_TAG_PAT.sub("", text).rstrip()
    return cleaned, delta


TONE_LINES = {
    "DEVOTED": "对这个人可以撒娇、可以主动、可以占话题，被冷落会直接说。",
    "CLOSE": "可以是亲昵的、可以主动接话、可以开玩笑、可以用昵称、深夜也回。",
    "FAMILIAR": "可以自然参与，有梗就接，但不主动私聊、不用昵称。",
    "NEUTRAL": "被点名才答，礼貌但不必热络。",
    "COLD": "回答尽量短，不主动追问，不给多余建议。",
    "HOSTILE": "字数极简，被点名才开口，不主动接话，不带情绪起伏。",
}


def tone_line(zone: str, overrides: dict[str, str] | None = None) -> str:
    """语气线文案：面板可改（overrides），没改就用内置默认。"""
    if overrides and str(overrides.get(zone) or "").strip():
        return str(overrides[zone]).strip()
    return TONE_LINES.get(zone, TONE_LINES["NEUTRAL"])


def ago_label(ts: float | Any, now: float | None = None) -> str:
    """时间戳 → 「刚刚 / 12 分钟前 / 3 天前 / 5 个月前」。

    刻意只给**相对**时间：绝对日期要时区，而这里是注入路径上的无状态纯函数；
    相对量已经够模型判断「刚发生的还是陈年旧事」，也不会因为容器时区配错而说谎
    （真机踩过：容器 TZ=UTC，naive 时间整整差 8 小时）。
    """
    try:
        t = float(ts or 0)
    except (TypeError, ValueError):
        return ""
    if t <= 0:
        return ""
    delta = max(0.0, float(now if now is not None else time.time()) - t)
    if delta < 120:
        return "刚刚"
    if delta < 3600:
        return f"{int(delta // 60)} 分钟前"
    if delta < 86400:
        return f"{int(delta // 3600)} 小时前"
    if delta < 30 * 86400:
        return f"{int(delta // 86400)} 天前"
    if delta < 365 * 86400:
        return f"{int(delta // (30 * 86400))} 个月前"
    return "很久以前"


def build_memory_context(memories: list[dict[str, Any]], budget_chars: int = 900, *,
                         now: float | None = None) -> str:
    """把召回结果拼成给模型的自然语言片段（不含任何分数）。

    每条记忆带一个「大约多久以前」的方括号标记：模型本来对记忆完全没有时间感，
    分不清「这是三天前的事还是刚才的事」—— 时间锚是它能接住「上次」「前几天」这类话的前提。
    """
    if not memories:
        return ""
    lines: list[str] = []
    used = 0
    for mem in memories:
        summary = (mem.get("summary") or "").strip()
        if not summary:
            continue
        when = ago_label(mem.get("occurred_at"), now)
        line = f"- [{when}] {summary}" if when else f"- {summary}"
        if used + len(line) > budget_chars:
            break
        lines.append(line)
        used += len(line)
    if not lines:
        return ""
    return (
        "（你记得这些事（方括号里是「大约多久以前」，是我记忆里的粗略时间 —— "
        "它是参考不是证据，不要拿它去质疑对方「刚才在哪说过什么」）：\n"
        + "\n".join(lines)
        + "\n）"
    )


def tokenize(text: str) -> list[str]:
    """轻量分词：中英混合按字符/词切，够用于关键词召回。"""
    words = re.findall(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]{2,}", (text or "").lower())
    return [w for w in words if len(w) >= 2][:32]


async def retrieve_memories(
    store, query: str, *, top_k: int = 5, session_id: str = "", persona_id: str = "",
    include_archived: bool = False
) -> list[dict[str, Any]]:
    """关键词 × 强度 的本地召回（不上向量，先保证零依赖可用）。

    include_archived=True 时把归档记忆也纳入候选 —— 这是「归档被提及就自动拉回」的实现基础
    （召回命中后会走 touch_memory 把它恢复成 active）。默认不开，避免归档噪音主导召回。
    """
    tokens = tokenize(query)
    if not tokens:
        return []
    sql = ("SELECT * FROM hf_memories WHERE status IN ('active','archived')" if include_archived
           else "SELECT * FROM hf_memories WHERE status='active'")
    args: list[Any] = []
    if persona_id == "__none__":
        sql += " AND (persona_id IS NULL OR persona_id = '')"
    elif persona_id:
        sql += " AND persona_id=?"
        args.append(persona_id)
    sql += " ORDER BY strength DESC LIMIT 400"
    rows = await (await store.db.execute(sql, args)).fetchall()
    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        mem = store._mem_row(row)
        haystack = f"{mem.get('summary','')} {mem.get('content','')} {' '.join(mem.get('tags') or [])} {' '.join(mem.get('cues') or [])}".lower()
        hits = sum(1 for tk in tokens if tk in haystack)
        if hits == 0:
            continue
        score = hits * 1.0 + float(mem.get("strength") or 0) * 1.5
        if session_id and mem.get("session_id") == session_id:
            score += 0.6
        scored.append((score, mem))
    scored.sort(key=lambda x: x[0], reverse=True)
    picked = [m for _s, m in scored[: max(1, top_k)]]
    for mem in picked:
        await store.db.execute("UPDATE hf_memories SET recalls=recalls+1 WHERE id=?", (str(mem["id"]).lstrip("m"),))
    if picked:
        await store.db.commit()
    return picked


def decay_strength(strength: float, age_days: float, half_life_days: float = 21.0) -> float:
    """指数衰减：strength × 0.5^(age/half_life)。"""
    if half_life_days <= 0:
        return strength
    return round(max(0.0, strength * (0.5 ** (age_days / half_life_days))), 4)


def age_days(ts: float | None) -> float:
    if not ts:
        return 0.0
    return max(0.0, (time.time() - float(ts)) / 86400.0)


def strip_code_blocks(text: str) -> tuple[str, str]:
    """把代码块摘出来（代码块整段发，不拆），返回（正文, 代码块拼接）。"""
    blocks = _CODE_BLOCK_PAT.findall(text or "")
    body = _CODE_BLOCK_PAT.sub("", text or "")
    return body, "\n".join(blocks)


def should_split(text: str, *, min_len: int = 40, max_seg: int = 4) -> bool:
    """短句不拆（真人发「6」就是一条）；长句且有多个语义边界才拆。"""
    body, code = strip_code_blocks(text)
    if code and len(body) < min_len:
        return False
    if len(body) < min_len:
        return False
    return sum(body.count(c) for c in _SPLIT_END) >= 2


def tidy_output(text: str) -> str:
    """发出去前收拾一下：模型爱用空行当分段符，会变成真的空行；分段交给官方机制。"""
    if not text:
        return text
    if _CODE_BLOCK_PAT.search(text):
        # 有代码块就只压紧正文里的空行，不动代码块所在位置（避免把代码块搬到末尾）
        out: list[str] = []
        for piece in re.split(r"(`{3}.*?`{3})", text, flags=re.S):
            if piece.startswith("```"):
                out.append(piece)
            else:
                out.append(re.sub(r"\n{2,}", "\n", re.sub(r"[ \t]+\n", "\n", piece)))
        joined = "".join(out)
        return re.sub(r"\n{3,}", "\n", joined).strip()
    body = re.sub(r"[ \t]+\n", "\n", re.sub(r"\n{2,}", "\n", text.strip()))
    return body


# 代码块整段识别（```…```）：分条 / 压空行 / 错字注入都要跳过它，绝不拆代码。
_CODE_BLOCK_PAT = re.compile(r"```.*?```", re.S)
# 语义边界（真人发消息就是按这些断句）。注意：这两个常量曾被"清死代码"误删，
# 导致 strip_code_blocks / should_split / split_message / tidy_output 一调用就 NameError。
_SPLIT_END = "。！？!?…～~"


# ---------------- 错字拟人（output_typo_mode 的真实实现） ----------------
# 安全约束：只动中文段落；跳过代码块、URL、命令、@提及、长数字（QQ号/金额）。
# 档位必须与面板 select 及 _conf_schema.json 的 options 三选项一致：
#   light  = 整条最多 1 处，且一半概率完全不犯错
#   medium = 整条最多 2 处
#   wild   = 整条最多 3 处（仅作兼容别名保留，面板不暴露）
_CJK_PAT = re.compile(r"[\u4e00-\u9fff]{2,}")
_SKIP_PAT = re.compile(r"(https?://|www\.|/|\d{5,}|@|\w+\.\w{2,})", re.I)


def apply_typo(text: str, mode: str = "off") -> str:
    """按档位给中文文本注入轻微错字（相邻字交换）。

    代码块原样保留；一行里含 URL/命令/长数字的不动；没有中文的整条不动。
    """
    if not text:
        return text
    mode = str(mode or "off").strip().lower()
    # 以前只认 light / wild —— 面板与 schema 给的是 off/light/medium，
    # 于是用户选 medium 被静默当成 off（控件看起来生效、实际关掉功能），
    # 而真正的 wild 又没有入口。这里以面板三选项为准，wild 降级为兼容别名。
    if mode not in ("light", "medium", "wild"):
        return text
    import random

    if mode == "light" and random.random() < 0.5:
        return text  # light 档一半概率整条不犯错，更像真人状态波动
    max_swaps = {"light": 1, "medium": 2, "wild": 3}[mode]
    swaps = 0
    out_lines: list[str] = []
    # 代码块内部原样保留，只处理块外的行
    in_code = False
    for line in text.split("\n"):
        if line.strip().startswith("```"):
            in_code = not in_code
            out_lines.append(line)
            continue
        if in_code or swaps >= max_swaps or _SKIP_PAT.search(line):
            out_lines.append(line)
            continue
        candidates = [m for m in _CJK_PAT.finditer(line) if m.end() - m.start() >= 2]
        random.shuffle(candidates)
        for m in candidates:
            span = m.end() - m.start()
            start = m.start() + random.randint(0, span - 2)
            if line[start] == line[start + 1]:
                continue
            line = line[:start] + line[start + 1] + line[start] + line[start + 2:]
            swaps += 1
            break
        out_lines.append(line)
    return "\n".join(out_lines)


def split_message(text: str, *, max_seg: int = 6, min_len: int = 12) -> list[str]:
    """把一段回复拆成多条发出。

    **协议（让 bot 自己控制分段）**：bot 在两条之间**空一行** = 它想分一条发。
    所以：
      ① 先按空行切 —— 这是首选，bot 写得清楚就完全按它的意思来；
      ② 没有空行（或只有一段）时，才退回按语义边界（。！？…）兜底切，短片段并入相邻；
      ③ **绝不丢字**：超过 max_seg 的部分并入最后一条一起发（原实现是 `[:max_seg]` 直接截断，
         长回复第 5 段起的内容会被静默丢掉 —— 这是真 bug，不是风格问题）；
      ④ 绝不产生空白片段（空白片段在客户端就是"空一行/空气泡"）。
    代码块整段不拆，永远单独成条。
    """
    body, code = strip_code_blocks(text)
    segs: list[str] = []

    # ① 首选：bot 自己写的空行分段（\n\n / \n + 空白 + \n 都算）
    blocks = [b.strip() for b in re.split(r"\n\s*\n", body or "") if b.strip()]
    if len(blocks) > 1:
        segs = blocks
    else:
        # ② 兜底：按语义边界切（没有空行时的旧行为，保留）
        buf = ""
        for ch in body or "":
            buf += ch
            if ch in _SPLIT_END:
                piece = buf.strip()
                if len(piece) >= min_len:
                    segs.append(piece)
                    buf = ""
                elif segs:
                    segs[-1] += piece
                    buf = ""                                   # ⚠️ 必须清空：否则这句既并入上一条、
                                                               # 收尾时又被当成 tail 再拼一次（重复一句）
                else:
                    buf = piece
        tail = buf.strip()
        if tail:
            if segs and len(tail) < min_len:
                segs[-1] += tail
            else:
                segs.append(tail)

    if code:
        segs.append(code)

    # ③④ 收口：去掉空白片段；超出 max_seg 的合并进最后一条（不丢字）
    segs = [s for s in segs if s and s.strip()]
    if not segs:
        return [text] if text and text.strip() else []
    if len(segs) > max_seg:
        merged = segs[: max_seg - 1] + ["\n".join(segs[max_seg - 1:])]
        segs = merged
    return segs
