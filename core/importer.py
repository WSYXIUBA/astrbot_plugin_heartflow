"""astrbot_plugin_livingmemory 记忆导入适配器。

现实约束：LivingMemory 各版本表结构会变，所以这里**不假设字段**——
先探库（PRAGMA table_info）再映射，缺列就跳过那一项，慢一点但不会因为版本差异炸掉。

导入两层（可选）：
- 摘要层 documents：人类可读的整段记忆 + metadata(session/persona/importance/topics/key_facts)
- 原子层 memory_atoms：细粒度事实 + entities + 生命期状态

统一落地为 StarHeart 记忆：source_mode 记成插件名，tags 追加「livingmemory导入」，
external_id 去重（重复导入不会翻倍）。
"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from collections.abc import Awaitable, Callable
from contextlib import closing
from pathlib import Path
from typing import Any

# ---------------- 源定位与来源标记 ----------------
# 历史 bug：源目录名与来源标记共用同一个常量，而且被写成了**本插件自己的名字**，
# 于是 detect / 导入一律去 plugin_data/astrbot_plugin_starheart/ 找 livingmemory.db，
# 正常环境下永远读不到源库 —— 表现就是「导入」整条功能不可用。
#
# 现在拆成三件事，互不牵连：
#   1) 目录名：按候选顺序探测，兼容「源插件自己的 data 目录」与「人工把源库放进本插件 data 目录」两种部署；
#   2) 来源标记 SOURCE_NAME（写进 hf_memories.external_source）：用源插件的真名，面板「来源库」才显示得对；
#   3) 去重 SOURCE_DEDUP_NAMES：必须同时认新旧两个标记 —— 老库那 825 条的 external_source 是旧名
#      （唯一索引 idx_hf_mem_ext 建在 (external_source, external_id) 上），只认新名会导致升级后再导一遍、记忆翻倍。
SOURCE_DIR_CANDIDATES = ("astrbot_plugin_livingmemory", "astrbot_plugin_starheart")
SOURCE_NAME = "astrbot_plugin_livingmemory"
SOURCE_DEDUP_NAMES = ("astrbot_plugin_livingmemory", "astrbot_plugin_starheart")
IMPORT_TAG = "livingmemory导入"
BATCH_COMMIT = 50

# LivingMemory 的 atom_type / status 到 StarHeart 枚举的映射（未知值原样保留成标签）
ATOM_MAP = {
    "unknown": "factual",
    "factual": "factual",
    "episodic": "episodic",
    "preference": "preference",
    "planned": "planned",
    "routine": "routine",
    "relational": "relational",
    "opinion": "opinion",
}
STATUS_MAP = {"active": "active", "expired": "decayed", "forgotten": "archived"}

Progress = Callable[[dict[str, Any]], Awaitable[None]]


def _ro_connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE name=?", (table,)).fetchone()
    return row is not None


def _json_load(raw: Any) -> Any:
    if raw is None:
        return None
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def _clean(text: str) -> str:
    """去掉多余空白；LivingMemory 的 FTS 文本可能带分词空格，这里只做轻量清理。"""
    return re.sub(r"\s+", " ", (text or "").strip())


def _parse_session(session_id: str) -> tuple[str, str]:
    """'testbot:FriendMessage:100000000' -> ('person', '100000000')；无法解析则返回 ('session', '')。

    ⚠️ 解析不出来时必须返回**空号**，不能回退成整串 session_id 当实体名 ——
    否则畸形会话（尾段不是数字，例如 '示例群:GroupMessage:'）会在 hf_entities 里
    造出一个叫「示例群:GroupMessage:」的垃圾实体，并且直接显示在图谱与卡片上
    （用户报的「还显示了不该显示的【示例群:GroupMessage:】」就有这一份）。
    两个调用点都要用 `if ident:` 守卫。
    """
    parts = (session_id or "").split(":")
    if len(parts) >= 3 and parts[-1].isdigit():
        kind = "person" if "Friend" in parts[-2] else "session"
        return kind, parts[-1]
    return "session", ""


class LivingMemoryImporter:
    """探测 + 导入，全部走真实数据；进度通过回调逐步上报。"""

    def __init__(self, store, data_root: str | Path) -> None:
        self.store = store
        self.data_root = Path(data_root)
        self._dir_name_cache: str | None = None

    def _source_dir_name(self) -> str:
        """挑第一个「真的有源库」的候选目录名；都没有就退回首选名，让报错信息指向正确位置。"""
        if self._dir_name_cache:
            return self._dir_name_cache
        for name in SOURCE_DIR_CANDIDATES:
            d = self.data_root / "plugin_data" / name
            if (d / "livingmemory.db").is_file() or (d / "conversations.db").is_file():
                self._dir_name_cache = name
                return name
        self._dir_name_cache = SOURCE_DIR_CANDIDATES[0]
        return self._dir_name_cache

    async def _imported_ids(self) -> set[str]:
        """已导入过的 external_id 集合（新旧来源标记取并集，保证升级后不重复导入）。"""
        out: set[str] = set()
        for name in SOURCE_DEDUP_NAMES:
            out |= await self.store.imported_external_ids(name)
        return out

    # ---------------- 探测 ----------------
    @property
    def plugin_dir(self) -> Path:
        return self.data_root / "plugins" / self._source_dir_name()

    @property
    def plugin_data_dir(self) -> Path:
        return self.data_root / "plugin_data" / self._source_dir_name()

    def detect(self) -> dict[str, Any]:
        db_main = self.plugin_data_dir / "livingmemory.db"
        db_conv = self.plugin_data_dir / "conversations.db"
        info: dict[str, Any] = {
            "source": self._source_dir_name(),
            "plugin_dir_exists": self.plugin_dir.is_dir(),
            "data_dir_exists": self.plugin_data_dir.is_dir(),
            "db_exists": db_main.is_file(),
            "db_path": str(db_main),
            "conversations_db": str(db_conv) if db_conv.is_file() else "",
            "version": "",
            "documents": 0,
            "atoms": 0,
            "sessions": 0,
            "messages": 0,
            "capabilities": {},
        }
        if info["plugin_dir_exists"]:
            for meta in (self.plugin_dir / "metadata.yaml", self.plugin_dir / ".plugin_version"):
                if meta.is_file():
                    try:
                        text = meta.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        continue
                    m = re.search(r"version:\s*([0-9][^\s#]*)", text) or re.search(r"([0-9]+\.[0-9]+[^\s]*)", text)
                    if m:
                        info["version"] = m.group(1)
                        break
        if info["db_exists"]:
            try:
                with closing(_ro_connect(db_main)) as conn:
                    for table, key in (("documents", "documents"), ("memory_atoms", "atoms")):
                        if _table_exists(conn, table):
                            info[key] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    info["capabilities"] = {
                        "documents": _table_exists(conn, "documents"),
                        "atoms": _table_exists(conn, "memory_atoms"),
                        "columns_documents": sorted(_columns(conn, "documents")),
                        "columns_atoms": sorted(_columns(conn, "memory_atoms")),
                    }
            except sqlite3.Error as exc:
                info["error"] = f"读取库失败：{exc}"
        if db_conv.is_file():
            try:
                with closing(_ro_connect(db_conv)) as conn:
                    if _table_exists(conn, "sessions"):
                        info["sessions"] = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
                    if _table_exists(conn, "messages"):
                        info["messages"] = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            except sqlite3.Error:
                pass
        return info

    async def detect_async(self) -> dict[str, Any]:
        info = await asyncio.to_thread(self.detect)
        info["already_imported"] = len(await self._imported_ids())
        info["starheart_memories"] = (await self.store.memory_counts())["total"]
        return info

    # ---------------- 读取源数据（同步、只读） ----------------
    def _read_documents(self, limit: int | None = None) -> list[dict[str, Any]]:
        db = self.plugin_data_dir / "livingmemory.db"
        out: list[dict[str, Any]] = []
        with closing(_ro_connect(db)) as conn:
            if not _table_exists(conn, "documents"):
                return out
            cols = _columns(conn, "documents")
            has_meta = "metadata" in cols
            sql = f"SELECT id, doc_id, text{', metadata' if has_meta else ''} FROM documents ORDER BY id"
            if limit:
                sql += f" LIMIT {int(limit)}"
            for row in conn.execute(sql):
                meta = _json_load(row["metadata"]) if has_meta else None
                meta = meta if isinstance(meta, dict) else {}
                text = _clean(row["text"] if "text" in row.keys() else "")
                if not text:
                    continue
                topics = meta.get("topics") or []
                if isinstance(topics, str):
                    topics = [topics]
                out.append(
                    {
                        "external_id": f"doc:{row['doc_id'] or row['id']}",
                        "text": text,
                        "session_id": str(meta.get("session_id") or ""),
                        "persona_id": str(meta.get("persona_id") or ""),
                        "importance": float(meta.get("importance") or 0.5),
                        "create_time": meta.get("create_time"),
                        "topics": [str(t) for t in topics if str(t).strip()],
                        "key_facts": [str(t) for t in (meta.get("key_facts") or []) if str(t).strip()],
                    }
                )
        return out

    def _read_atoms(self, limit: int | None = None) -> list[dict[str, Any]]:
        db = self.plugin_data_dir / "livingmemory.db"
        out: list[dict[str, Any]] = []
        with closing(_ro_connect(db)) as conn:
            if not _table_exists(conn, "memory_atoms"):
                return out
            cols = _columns(conn, "memory_atoms")
            want = [
                c
                for c in (
                    "id",
                    "atom_type",
                    "content",
                    "entities",
                    "importance",
                    "created_at",
                    "event_time",
                    "session_id",
                    "persona_id",
                    "status",
                    "reinforcement_count",
                )
                if c in cols
            ]
            sql = f"SELECT {', '.join(want)} FROM memory_atoms ORDER BY id"
            if limit:
                sql += f" LIMIT {int(limit)}"
            for row in conn.execute(sql):
                text = _clean(row["content"] if "content" in row.keys() else "")
                if not text:
                    continue
                ents = _json_load(row["entities"]) if "entities" in row.keys() else None
                if not isinstance(ents, list):
                    ents = []
                out.append(
                    {
                        "external_id": f"atom:{row['id']}",
                        "text": text,
                        "atom_type": str(row["atom_type"] if "atom_type" in row.keys() else "unknown"),
                        "entities": [str(e) for e in ents if str(e).strip()],
                        "importance": float(row["importance"] if "importance" in row.keys() else 0.5),
                        "created_at": row["created_at"] if "created_at" in row.keys() else None,
                        "event_time": row["event_time"] if "event_time" in row.keys() else None,
                        "session_id": str(row["session_id"] if "session_id" in row.keys() else ""),
                        "persona_id": str(row["persona_id"] if "persona_id" in row.keys() else ""),
                        "status": str(row["status"] if "status" in row.keys() else "active"),
                    }
                )
        return out

    # ---------------- 映射与导入 ----------------
    def _to_memory(self, item: dict[str, Any], layer: str, batch_id: str) -> dict[str, Any]:
        text = item["text"]
        tags = [IMPORT_TAG]
        if layer == "documents":
            tags += item.get("topics", [])
            atom_type = "factual"
            entities = [{"kind": "topic", "name": t} for t in item.get("topics", [])]
            entities += [{"kind": "topic", "name": k} for k in item.get("key_facts", [])[:3]]
            occurred = item.get("create_time")
        else:
            raw_type = item.get("atom_type", "unknown")
            atom_type = ATOM_MAP.get(raw_type, "factual")
            if raw_type != atom_type:
                tags.append(f"类型:{raw_type}")
            status_raw = item.get("status", "active")
            if status_raw != "active":
                tags.append(f"状态:{status_raw}")
            entities = [{"kind": "topic", "name": e} for e in item.get("entities", [])]
            occurred = item.get("event_time") or item.get("created_at")
        session_id = item.get("session_id") or ""
        if session_id:
            kind, ident = _parse_session(session_id)
            if ident:                      # 解析不出号就别造垃圾实体（详见 _parse_session 注释）
                entities.append({"kind": kind, "name": ident})
        importance = max(0.0, min(1.0, float(item.get("importance") or 0.5)))
        status = "active"
        if layer == "atoms":
            status = STATUS_MAP.get(item.get("status", "active"), "active")
        return {
            "summary": text[:120],
            "content": text,
            "atom_type": atom_type,
            "strength": importance,
            "poignancy": max(1, min(10, round(importance * 10))),
            "source_mode": SOURCE_NAME,
            "source_ref": item["external_id"],
            "session_id": session_id,
            "persona_id": item.get("persona_id") or "",
            "tags": tags,
            "entities": [e["name"] for e in entities],
            "cues": [e["name"] for e in entities[:5]],
            "evidence": text[:200],
            "status": status,
            "occurred_at": occurred,
            "external_source": SOURCE_NAME,
            "external_id": item["external_id"],
            "import_batch": batch_id,
        }

    async def run(
        self,
        progress: Progress,
        *,
        layers: list[str] | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """执行导入；progress 收到 {phase,total,done,imported,skipped,failed,message}。"""
        layers = layers or ["documents", "atoms"]
        layers = [x for x in layers if x in ("documents", "atoms")] or ["documents"]
        await progress({"phase": "scan", "message": "扫描源库…"})
        collected: list[tuple[str, dict[str, Any]]] = []
        if "documents" in layers:
            for item in await asyncio.to_thread(self._read_documents, limit):
                collected.append(("documents", item))
        if "atoms" in layers:
            for item in await asyncio.to_thread(self._read_atoms, limit):
                collected.append(("atoms", item))

        total = len(collected)
        batch_id = await self.store.new_batch(
            SOURCE_NAME, total, note="layers=" + ",".join(layers)
        )
        result = {"batch_id": batch_id, "total": total, "imported": 0, "skipped": 0, "failed": 0}
        await progress({"phase": "start", "total": total, "done": 0, "message": f"共 {total} 条待处理"})

        entities_seen: dict[tuple[str, str], str] = {}
        topic_index: dict[str, list[str]] = {}
        session_seq: dict[str, list[tuple[float, str]]] = {}

        # 显式去重。insert_memory 只靠唯一索引 idx_hf_mem_ext(external_source, external_id) 拦重复，
        # 而本次来源标记已从旧名 astrbot_plugin_starheart 换成新名 → 老库那些行不会与新标记冲突，
        # 只靠索引会**把旧数据再导一遍、记忆翻倍**。所以这里先把新旧两个标记下已导入的
        # external_id 全捞出来，逐条跳过。
        # （原先还有一个 seen_doc_ids 字典，只写不读、从未参与去重，这里一并删掉。）
        already = await self._imported_ids()

        for idx, (layer, item) in enumerate(collected, start=1):
            try:
                if item["external_id"] in already:
                    result["skipped"] += 1
                    continue
                mem = self._to_memory(item, layer, batch_id)
                new_id = await self.store.insert_memory(mem)
                if new_id is None:
                    result["skipped"] += 1
                    continue
                already.add(item["external_id"])
                result["imported"] += 1
                mid = f"m{new_id}"
                # 实体与边：memory -> entity
                for name in mem["entities"]:
                    kind = "topic"
                    for ent in self._entities_of(item, layer):
                        if ent["name"] == name:
                            kind = ent["kind"]
                            break
                    key = (kind, name)
                    if key not in entities_seen:
                        entities_seen[key] = await self.store.ensure_entity(kind, name)
                    await self.store.add_edge("memory", mid, "entity", entities_seen[key], "entity", 1.4)
                for topic in (item.get("topics") or []):
                    topic_index.setdefault(topic, []).append(mid)
                if mem["session_id"]:
                    session_seq.setdefault(mem["session_id"], []).append(
                        (float(mem["occurred_at"] or 0), mid)
                    )
                if idx % BATCH_COMMIT == 0:
                    await progress(
                        {
                            "phase": "import",
                            "total": total,
                            "done": idx,
                            "imported": result["imported"],
                            "skipped": result["skipped"],
                            "failed": result["failed"],
                            "message": f"已处理 {idx}/{total}",
                        }
                    )
            except Exception:  # 单条失败不影响整批
                result["failed"] += 1
                await self.store.audit("import.item.failed", item.get("external_id", ""), "导入单条失败", SOURCE_NAME)

        # 记忆之间的语义边（同主题）与同会话时序边
        await progress({"phase": "link", "total": total, "done": total, "message": "构建关系链…"})
        for topic, mids in topic_index.items():
            for i in range(len(mids)):
                for j in range(i + 1, min(len(mids), i + 6)):
                    await self.store.add_edge("memory", mids[i], "memory", mids[j], "semantic", 1.0)
        for _sid, seq in session_seq.items():
            seq.sort(key=lambda x: x[0])
            for i in range(len(seq) - 1):
                await self.store.add_edge("memory", seq[i][1], "memory", seq[i + 1][1], "temporal", 0.9)

        await self.store.update_batch(
            batch_id,
            finished_at=__import__("time").time(),
            imported=result["imported"],
            skipped=result["skipped"],
            failed=result["failed"],
            status="done",
        )
        await self.store.audit(
            "import.done",
            batch_id,
            f"imported={result['imported']} skipped={result['skipped']} failed={result['failed']}",
            SOURCE_NAME,
        )
        await progress({**result, "phase": "done", "done": total, "message": "导入完成"})
        return result

    @staticmethod
    def _entities_of(item: dict[str, Any], layer: str) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        if layer == "documents":
            out += [{"kind": "topic", "name": t} for t in item.get("topics", [])]
        else:
            out += [{"kind": "topic", "name": e} for e in item.get("entities", [])]
        sid = item.get("session_id") or ""
        if sid:
            kind, ident = _parse_session(sid)
            if ident:                      # 解析不出号就别造垃圾实体（详见 _parse_session 注释）
                out.append({"kind": kind, "name": ident})
        return out

    # ===================== 会话消息 / 来源轮次 / 完整原文 =====================
    # livingmemory 把「会话消息」单独放 conversations.db.messages，把「这条记忆由哪几句总结出来」
    # 放 livingmemory.db.memory_sources.source_json。这两样我们第一次导入时都没要，
    # 所以详情里只有 250 字截断的 evidence —— 这里补齐（只读对方库，不改它）。

    def _read_messages(self, limit: int | None = None) -> list[dict[str, Any]]:
        db = self.plugin_data_dir / "conversations.db"
        if not db.is_file():
            return []
        conn = _ro_connect(db)
        try:
            if not _table_exists(conn, "messages"):
                return []
            cols = _columns(conn, "messages")
            tcol = "timestamp" if "timestamp" in cols else ("ts" if "ts" in cols else None)
            sql = "SELECT id, %s AS ts, session_id, role, content%s%s%s%s FROM messages" % (
                tcol or "0",
                ", sender_id" if "sender_id" in cols else "",
                ", sender_name" if "sender_name" in cols else "",
                ", platform" if "platform" in cols else "",
                ", metadata" if "metadata" in cols else "",
            )
            if limit:
                sql += " ORDER BY id DESC LIMIT %d" % int(limit)
            rows = []
            for r in conn.execute(sql):
                d = dict(r)
                meta = _json_load(d.pop("metadata", "{}")) or {}
                rows.append({
                    "session_id": d.get("session_id") or "",
                    "role": d.get("role") or "",
                    "content": str(d.get("content") or ""),
                    "sender_id": str(d.get("sender_id") or ""),
                    "sender_name": str(d.get("sender_name") or ""),
                    "platform": str(d.get("platform") or ""),
                    "ts": float(d.get("ts") or 0),
                    "is_bot": bool(isinstance(meta, dict) and meta.get("is_bot_message")),
                    "ext_id": "lmmsg:%s" % d.get("id"),
                })
            return rows
        finally:
            conn.close()

    def _read_memory_sources(self) -> list[tuple[str, list[dict[str, Any]]]]:
        """返回 [(doc_id, [轮次…])]，doc_id 用来对上我们库里的 external_id（doc:<uuid>）。"""
        db = self.plugin_data_dir / "livingmemory.db"
        if not db.is_file():
            return []
        conn = _ro_connect(db)
        try:
            if not (_table_exists(conn, "memory_sources") and _table_exists(conn, "documents")):
                return []
            out: list[tuple[str, list[dict[str, Any]]]] = []
            for r in conn.execute(
                "SELECT d.doc_id AS doc_id, s.source_json AS src FROM memory_sources s"
                " JOIN documents d ON d.id = s.memory_id"
            ):
                turns = _json_load(r["src"])
                if not isinstance(turns, list):
                    continue
                clean: list[dict[str, Any]] = []
                for t in turns:
                    if not isinstance(t, dict):
                        continue
                    clean.append({
                        "role": str(t.get("role") or ""),
                        "speaker": str(t.get("sender_name") or t.get("sender_id") or ""),
                        "content": str(t.get("content") or ""),
                        "ts": float(t.get("timestamp") or 0),
                        "session_id": str(t.get("session_id") or ""),
                    })
                if clean:
                    out.append((str(r["doc_id"]), clean))
            return out
        finally:
            conn.close()

    def _read_document_texts(self) -> list[tuple[str, str]]:
        db = self.plugin_data_dir / "livingmemory.db"
        if not db.is_file():
            return []
        conn = _ro_connect(db)
        try:
            if not _table_exists(conn, "documents"):
                return []
            return [(str(r["doc_id"]), str(r["text"] or "")) for r in conn.execute("SELECT doc_id, text FROM documents")]
        finally:
            conn.close()

    async def import_extras(self, progress: Progress | None = None) -> dict[str, Any]:
        """补齐三样：会话消息、记忆来源轮次、完整原文。可重复调用（幂等）。"""
        out: dict[str, Any] = {"messages": 0, "sessions": 0, "sources": 0, "texts": 0, "errors": []}

        # ① 会话消息（唯一键 ext_id=lmmsg:<id>，重复导入不会翻倍）
        try:
            msgs = await asyncio.to_thread(self._read_messages)
            for i in range(0, len(msgs), 200):
                out["messages"] += await self.store.add_messages(msgs[i : i + 200])
                if progress:
                    await progress({"layer": "messages", "done": min(i + 200, len(msgs)), "total": len(msgs)})
            out["sessions"] = len({m["session_id"] for m in msgs})
        except Exception as exc:                     # noqa: BLE001 对方库结构变了也不该炸面板
            out["errors"].append("会话消息：%s" % str(exc)[:120])

        # ② 每条记忆的精确来源轮次
        try:
            idmap = await self.store.external_id_map()
            for doc_id, turns in await asyncio.to_thread(self._read_memory_sources):
                mid = idmap.get("doc:%s" % doc_id)
                if mid:
                    await self.store.save_memory_sources(mid, turns)
                    out["sources"] += 1
        except Exception as exc:                     # noqa: BLE001
            out["errors"].append("来源轮次：%s" % str(exc)[:120])

        # ③ 完整原文（修正旧的 250 字截断）
        try:
            idmap = await self.store.external_id_map()
            for doc_id, text in await asyncio.to_thread(self._read_document_texts):
                mid = idmap.get("doc:%s" % doc_id)
                if mid and text:
                    await self.store.set_source_text(mid, text)
                    out["texts"] += 1
        except Exception as exc:                     # noqa: BLE001
            out["errors"].append("完整原文：%s" % str(exc)[:120])

        return out
