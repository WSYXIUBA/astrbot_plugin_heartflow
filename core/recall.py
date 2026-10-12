"""混合召回（照 livingmemory 的"双路检索 + RRF 融合"做简化版）+ 会话消息/来源导入。

为什么这么做（读 livingmemory 源码/文档后的结论，不是拍脑袋）：
  · core/retrieval/ 下有 bm25_retriever / vector_retriever / graph_keyword_retriever /
    graph_vector_retriever / dual_route_retriever / rrf_fusion —— 关键词路 + 向量路，
    再用 RRF（Reciprocal Rank Fusion）把多个排名列表融合，最后叠加重要性/时间衰减/会话隔离。
  · 我们数据量小（几百~几千条），不引第三方库：关键词路用 CJK 二元切分 + 字段加权命中，
    向量路用 float32 BLOB 余弦，融合用同一个 RRF 公式。
  · 没有向量时只跑关键词路，并如实回报走了哪条路 —— 不许假装召回成功。
"""

from __future__ import annotations

import math
import re
import struct
import time
from collections.abc import Awaitable, Callable
from typing import Any

CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
WORD = re.compile(r"[a-zA-Z0-9_']+")
STOP = {"的", "了", "是", "我", "你", "他", "她", "它", "们", "在", "和", "有", "就", "都", "也", "不", "吗",
        "么", "啊", "呢", "吧", "呀", "那", "这", "个", "上", "下", "里", "什么", "怎么", "一个", "the", "a", "is"}

EmbedFn = Callable[[str], Awaitable[list[float] | None]]
# 重排回调：给(query, 候选文本列表) → 返回按相关性排序的候选下标（空列表 = 不重排）
RerankFn = Callable[[str, list[str]], Awaitable[list[int]]]


def tokenize(text: str) -> list[str]:
    """CJK 走二元组（单字噪声太大），英文/数字走整词。免依赖，几百条规模足够。"""
    text = (text or "").lower()
    out: list[str] = []
    cjk_runs = re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+", text)
    for run in cjk_runs:
        if len(run) == 1:
            out.append(run)
            continue
        out.extend(run[i : i + 2] for i in range(len(run) - 1))
        if len(run) <= 4:
            out.append(run)                     # 短词整体也留一份，提高"生日""教案"这类精确命中
    out.extend(w for w in WORD.findall(text) if len(w) > 1)
    return [t for t in out if t not in STOP]


def _field_score(tokens: list[str], text: str, weight: float) -> float:
    if not text:
        return 0.0
    low = text.lower()
    hit = sum(1 for t in tokens if t in low)
    if not hit:
        return 0.0
    # 命中率 + 覆盖率一起算：内容长的条目不该因为长就占便宜
    return weight * (hit / max(1, len(tokens))) * (1.0 + math.log1p(hit) / 4.0)


class HybridRecall:
    """关键词路 + 向量路 → RRF 融合 → 强度/时间加权。"""

    def __init__(self, store: Any, embed: EmbedFn | None = None, rerank: RerankFn | None = None) -> None:
        self.store = store
        self.embed = embed
        self.rerank = rerank
        self._vec_cache: list[tuple[str, tuple[float, ...]]] = []
        self._vec_cache_at = 0.0

    # ---------- 向量缓存：853 条 × 1024 维解一次约几十毫秒，缓存 60 秒 ----------
    async def _vectors(self, persona_id: str = "") -> list[tuple[str, tuple[float, ...]]]:
        if time.time() - self._vec_cache_at > 60:
            # 只读"当前代"：同一维度，不会出现混代导致的维度不一致
            gen = ""
            try:
                gen = await self.store.active_gen()
            except Exception:                               # noqa: BLE001
                gen = ""
            if gen:
                rows = await self.store.all_embeddings_gen(gen, persona_id=persona_id, include_stale=True)
            else:
                rows = await self.store.all_embeddings(persona_id=persona_id, include_stale=True)
            parsed: list[tuple[str, tuple[float, ...]]] = []
            for mid, blob in rows:
                if not blob:
                    continue
                try:
                    vec = struct.unpack("<%df" % (len(blob) // 4), blob)
                    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
                    parsed.append((str(mid), tuple(x / norm for x in vec)))
                except Exception:               # noqa: BLE001 坏数据不该拖垮召回
                    continue
            self._vec_cache, self._vec_cache_at = parsed, time.time()
        return self._vec_cache

    async def search(
        self,
        query: str,
        *,
        persona_id: str = "",
        session_id: str = "",
        topk: int = 8,
        k_rrf: int = 60,
        pool: int = 500,
    ) -> dict[str, Any]:
        t0 = time.time()
        tokens = tokenize(query)
        # 关键词路也要按人格过滤 —— 只过滤向量路会让别的人格的关键词命中漏进召回结果
        docs = (await self.store.search_memories(
            session_id=session_id, persona_id=persona_id, limit=pool
        ))["items"]
        by_id = {str(d["id"]): d for d in docs}
        kw_rank: dict[str, float] = {}
        why: dict[str, list[str]] = {}
        for d in docs:
            s = (
                _field_score(tokens, str(d.get("summary") or ""), 3.0)
                + _field_score(tokens, str(d.get("cues") or ""), 2.0)
                + _field_score(tokens, str(d.get("entities") or ""), 1.6)
                + _field_score(tokens, str(d.get("content") or ""), 1.4)
                + _field_score(tokens, str(d.get("source_text") or ""), 1.0)
            )
            if s > 0:
                mid = str(d["id"])
                kw_rank[mid] = s
                low = " ".join(str(d.get(k) or "").lower() for k in ("summary", "content", "cues", "source_text"))
                why[mid] = [t for t in tokens if t in low][:6]

        # 向量路（无模型/无向量则跳过，并如实记录原因）
        vec_rank: dict[str, float] = {}
        vec_note = ""
        if self.embed is None:
            vec_note = "未配置嵌入模型：只跑关键词路"
        else:
            vectors = await self._vectors(persona_id)
            if not vectors:
                vec_note = "库里还没有向量：只跑关键词路（可在记忆库点「补全向量」）"
            else:
                qvec = None
                try:
                    qvec = await self.embed(query)
                except Exception as exc:        # noqa: BLE001 接口挂了也不能让参数页刷不出召回
                    vec_note = f"嵌入接口失败：{str(exc)[:60]}；只跑关键词路"
                if qvec:
                    norm = math.sqrt(sum(x * x for x in qvec)) or 1.0
                    qn = [x / norm for x in qvec]
                    if len(qn) != len(vectors[0][1]):
                        vec_note = f"向量维度不一致（查询 {len(qn)} vs 库 {len(vectors[0][1])}）：只跑关键词路"
                    else:
                        for mid, vec in vectors:
                            if session_id and mid not in by_id:
                                continue
                            dot = sum(a * b for a, b in zip(qn, vec))
                            if dot > 0.15:          # 低于阈值的基本是噪声，进池子反而挤掉好结果
                                vec_rank[mid] = dot
                        if not vec_rank:
                            vec_note = "向量相似度全部低于阈值 0.15"
                elif not vec_note:
                    vec_note = "查询向量化返回空：只跑关键词路"

        # RRF 融合（standard k=60）
        fused: dict[str, float] = {}
        for rank, (mid, _sc) in enumerate(sorted(kw_rank.items(), key=lambda x: -x[1])[:pool], start=1):
            fused[mid] = fused.get(mid, 0.0) + 1.0 / (k_rrf + rank)
        for rank, (mid, _) in enumerate(sorted(vec_rank.items(), key=lambda x: -x[1])[:pool], start=1):
            fused[mid] = fused.get(mid, 0.0) + 1.0 / (k_rrf + rank)

        now = time.time()
        out = []
        for mid, sc in fused.items():
            d = by_id.get(mid)
            if d is None:
                continue
            strength = float(d.get("strength") or 0.5)
            occ = float(d.get("occurred_at") or d.get("created_at") or now)
            age_days = max(0.0, (now - occ) / 86400.0)
            decay = math.exp(-age_days / 365.0)            # 一年衰减到 ~37%，跟 livingmemory 的时间衰减同向
            final = sc * (0.75 + 0.5 * strength) * (0.6 + 0.4 * decay)
            out.append({
                "id": d["id"],
                "summary": d.get("summary") or "",
                "content": d.get("content") or "",
                "session_id": d.get("session_id") or "",
                "occurred_at": occ,
                "strength": strength,
                "poignancy": d.get("poignancy"),
                "recalls": d.get("recalls"),
                "cues": d.get("cues"),
                "entities": d.get("entities"),
                "has_vec": bool(d.get("has_vec")),
                "external_source": d.get("external_source") or "",
                "score": round(final, 6),
                "rrf": round(sc, 6),
                "in_keyword": mid in kw_rank,
                "in_vector": mid in vec_rank,
                "matched_terms": why.get(mid, []),
            })
        out.sort(key=lambda x: -x["score"])
        # 结果重排：配了「结果重排」模型就让它重新定序（失败/未配 → 保持原序，绝不影响召回可用性）
        rerank_note = ""
        if self.rerank is not None and len(out) > 1:
            try:
                idxs = await self.rerank(
                    query,
                    [f"{d.get('summary') or ''} {d.get('content') or ''}".strip()[:300] for d in out],
                )
            except Exception as exc:                        # noqa: BLE001 重排不许把召回测试打崩
                idxs, rerank_note = [], f"重排失败：{str(exc)[:60]}"
            if idxs:
                seen: set[int] = set()
                ordered: list[dict[str, Any]] = []
                for i in idxs:
                    if 0 <= i < len(out) and i not in seen:
                        seen.add(i)
                        ordered.append(out[i])
                ordered += [d for i, d in enumerate(out) if i not in seen]
                out = ordered
                rerank_note = f"重排已生效（{len(idxs)} 条）"
        by_id_rank = {r["id"]: i + 1 for i, r in enumerate(out)}
        return {
            "query": query,
            "tokens": tokens[:16],
            "route": {
                "keyword_hits": len(kw_rank),
                "vector_hits": len(vec_rank),
                "vector_note": ((vec_note + "；" if vec_note else "") + rerank_note) if rerank_note else vec_note,
                "rerank_note": rerank_note,
            },
            "took_ms": int((time.time() - t0) * 1000),
            "candidates": len(docs),
            "items": out[: max(1, topk)],
            "ranked_ids": list(by_id_rank.keys()),
        }
