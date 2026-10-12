# 开发与部署

面向改这套代码的人（面板前端 + 插件后端）。使用者不需要看这一页。

## 版本号

- 功能 / 界面调整：升第二位、第三位归零；只修 bug：升第三位。
- 一次改齐这几处（散着手改容易漏）：`metadata.yaml`、`main.py` 的 `@register`、README 的版本行，
  以及 `index.html` 与 6 个带 `?v=` 的面板模块（共 7 个面板文件）。

## 打包与部署

插件是普通目录插件：把仓库内容放进 AstrBot 的 `data/plugins/astrbot_plugin_starheart/` 即可。
用容器跑 AstrBot 时，一个常见的部署流程长这样（把 `target` 与容器名换成你自己的）：

```bash
git archive --format=tar HEAD | ssh target 'docker exec -i <容器> sh -c "cat > /tmp/hf-<ver>.tar"'
ssh target 'docker exec <容器> sh -c "cd /AstrBot/data/plugins && rm -rf astrbot_plugin_starheart \
  && mkdir -p astrbot_plugin_starheart && tar -xf /tmp/hf-<ver>.tar -C astrbot_plugin_starheart"'
ssh target 'docker exec <容器> python3 -c "import astrbot_plugin_starheart.main"'   # 导入失败就别重启
ssh target 'docker restart <容器>'
ssh target "docker logs --tail 200 <容器> | grep -oE 'astrbot_plugin_starheart \(0\.[0-9.]+' | tail -1"
```

用 `git archive` 而不是直接打包目录：它只导出被跟踪的文件，本地脚本、备份、测试产物不会被带上。

## 提交前自检

1. **前端 JS 语法**：复制成 `.mjs` 再 `node --check` —— `.js` 后缀的 ES 模块直接查会「假绿」；
2. **后端**：`pyflakes` + `python -m compileall -q main.py core/`；
   （自检脚本直接 `import core.*` 时，要先 `import _astrbot_shim` 装好脚本环境桩 —— core 只从 `astrbot.api` 取 logger，发布代码不含标准库 logging。）
3. **版本一致性**：`metadata.yaml` ↔ `index.html` 的 `?v=` ↔ `main.py` 的 `@register` ↔ README 中/英 ↔ CHANGELOG（五件套，`bump_version.py` 会全部自检）；
4. **仓库卫生**：本地脚本、数据库、导出包、截图都不该进仓库，确认都落在 `.gitignore` 里。

## 改前端时的经验教训

- 换大段代码时**锚点要连变量定义一起核对**：替换后立刻回读，提交后 `git show HEAD:…` 再核一遍，
  部署后在容器里 grep 第三遍。
- 内联 `onclick` 调用的函数必须挂在 `app.js` 的 `Object.assign(window, {...})` 块里。
  只在模块内部写 `window.x =` 运行时也能用，但静态检查认不出来（会被当成「死按钮」），统一挂载最稳。
- 往 `innerHTML` / 属性值里拼接口数据一律用 `esc()`；`value="…"` 这类属性位最容易漏。
- 改完**硬刷新**（Ctrl+Shift+R）再看，否则可能还跑着旧缓存；UI 改动一定要打开页面目视过一遍。
- 面板跑在受限 sandbox 的 iframe 里：接口一律走 `store.js` 的 bridge 封装，直连 `/api/...` 会失败。

## 本地验收

面板是纯静态页面（零依赖、零构建），不必每次部署到 AstrBot 才能看：

```bash
cd pages/dashboard && python -m http.server 8791   # 起个静态服务器
```

配套的假 bridge / 假后端与逐页断言脚本属于本机开发工具，不随仓库发布（见 `.gitignore`）。
