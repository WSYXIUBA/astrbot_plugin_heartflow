# StarHeart

**Long-term memory for AstrBot.** It writes your chats down, recalls what is relevant when it matters, and keeps a light profile of the people and groups behind them.

**English** · [中文](./README.md)

|  |  |
| --- | --- |
| Package | `astrbot_plugin_starheart` |
| Display name | StarHeart |
| Current version | `1.0.0` |
| Author | 肆一纸心 |
| Repository | <https://github.com/WSYXIUBA/astrbot_plugin_starheart> |
| Adapters | `aiocqhttp` (OneBot v11 — NapCat, Lagrange, …) |
| Requires | AstrBot **>= 4.24.0** |

## How it works

Once installed it simply listens along: messages come in and get answered as usual — it never cuts in and never rewrites your bot's replies. It only folds what is worth keeping into memories kept in a local database, then hands the possibly relevant ones to the model before the next reply goes out.

## Features

- **Long-term memory** — conversations are distilled into memories; the ones nobody touches for a while fade out and get archived instead of piling up.
- **Relevant recall** — every turn it picks the memories that match the current topic, so the bot remembers what was said.
- **Person / group profiles** — a running "what is this person or group like", updated on its own.
- **Relationship score** — everyday interaction builds a score that nudges the tone of voice.
- **Expression habits** — it picks up how people phrase things, and blends in more the longer you chat.
- **Proactive lines** (optional) — after a quiet stretch it may open a topic by itself.
- **Recall log** — when someone deletes a message, what it said is kept (images included).
- **Dashboard** — memory graph, memory list, message events, persona, settings: all built in.

## Install

Two ways, either one works:

1. **From AstrBot** (recommended): Plugins → Install plugin → search `StarHeart`; or pick "install from URL" and paste this repository's address.
2. **Manually**: download this repository, drop the `astrbot_plugin_starheart` folder into AstrBot's `data/plugins/` (you should see `main.py` right inside it), then restart AstrBot or hit "Reload" in the plugin manager.

Afterwards, open the plugin's configuration and dashboard from the plugin page.

## Data

Memories, profiles, relationship scores and settings all live locally, under `data/plugin_data/astrbot_plugin_starheart/`. Apart from the model endpoints you configure yourself, the plugin sends nothing to any third party.

## License

MIT License — see [`LICENSE`](./LICENSE).

```
Copyright (c) 2026 肆一纸心 (WSYXIUBA)
```

## How it was built: entirely with AI

**Everything in this plugin — backend logic, dashboard frontend, copy and documentation — was written by AI**: requirements, trade-offs, review and testing are handled by the maintainer, while the implementation was written from scratch by AI. There is no "AI drafted it, a human rewrote every line" part.
