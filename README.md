# 窗口置顶（Windows 桌面版）

在 Windows 桌面版 DeepSeek Harness 的标题栏添加一个类似微信桌面端的置顶按钮。点击后，应用窗口始终显示在其他窗口之上；按钮状态跟随窗口的真实置顶状态。

## 功能

| 状态 | 按钮 | 行为 |
|---|---|---|
| 恢复态、未置顶 | 与原生最小化按钮一致的标题栏 caption 格、灰色图钉 | 点击后置顶 |
| 恢复态、已置顶 | 浅蓝色 caption 格、蓝色图钉 | 点击后取消置顶 |
| 窗口最大化 | 与最小化按钮一致的 caption 格、灰色图钉、禁用 | 不能点击；若原本已置顶，最大化期间暂停置顶，恢复窗口后自动恢复 |
| 普通浏览器 / 非 Windows / 窗口全屏 | 不显示 | — |

按钮位于标题栏右侧、原生最小化/最大化/关闭按钮的左侧，不会遮挡这些按钮，也不影响标题栏其余区域的拖动。

## 环境要求

- Windows 10/11
- DeepSeek Harness 桌面版（Electron 主窗口）
- 仅桌面版有效；在浏览器中打开 Web GUI 不会显示按钮
- 只作用于主窗口；登录、欢迎、更新等附属窗口不置顶

## 安装

当前通过 GitHub 安装，适用于 Windows 桌面版 DeepSeek Harness：

```sh
dsh plugin --profile <profile> add github:01TY10/dsh-pin-window
```

桌面端也可以在 **Plugins** 页面通过 **Add plugin** 选择本仓库，或本地开发时指向本目录。安装后如按钮未出现，刷新一次页面或重启桌面应用。

如果之后发布了 npm 包，也可以改用：

```sh
dsh plugin --profile <profile> add dsh-pin-window
```

无需额外安装原生依赖：插件从运行中的 DSH 安装解析随附的 `koffi` 3.1.1（桌面版 Host 本身也使用它）。`win32.js` 依次尝试 Host 入口、`DSH_INSTALL_DIR` 和包内 `koffi`；独立打包安装时如果运行环境不提供 `koffi`，需要在包内提供该依赖。

## 工作方式

- Client 半在 `shell.overlay` 中渲染标题栏按钮，每 1 秒及窗口 resize/focus 时向 Host 查询真实状态。
- Host 半只注册三个本地路由：
  - `GET /dsh-pin-window/state`
  - `POST /dsh-pin-window/pin`
  - `POST /dsh-pin-window/unpin`
- Host 通过 `process.ppid` 定位 Electron 主进程拥有的 `Chrome_WidgetWin_1` 主窗口，用 koffi 调用 `IsZoomed`、`GetWindowLongW`、`SetWindowPos` 读写原生置顶状态。
- 所有路由先经过 DSH 的 `connection.requestRejection` 信任栅栏；不接受请求体，不读写 Session 数据。

## 已知限制

- 不支持 macOS/Linux 的原生置顶；非 Windows 平台不显示按钮。
- 窗口全屏时按钮隐藏；若全屏前已置顶，窗口可能继续保持置顶。
- 置顶是进程内状态，不跨应用重启保存。
- 最大化期间暂停置顶，恢复窗口后自动恢复；这是本插件的交互选择。
- 依赖主窗口的类名/标题与 Electron 主进程的父子关系；未来桌面版若改变窗口结构，插件会报告不可用而不是误操作。
- 禁用插件会清除原生置顶，但不会改变窗口的最大化状态。

## 开发

```powershell
# 静态检查
<DSH_NODE> --check index.js
<DSH_NODE> --check win32.js
<DSH_NODE> --check client.js

# 原生只读 smoke：枚举主窗口并读取状态（必须用桌面版 Electron 的 Node 模式，
# 以便解析 app.asar 中随附的 koffi）
$env:ELECTRON_RUN_AS_NODE = '1'
& $env:DSH_NODE_EXECUTABLE scripts/native-smoke.mjs
```

置顶写入由安装后的 Host 路由和界面按钮验证。沙箱化 shell 的受限令牌会被 Windows UIPI 拒绝（`SetWindowPos` 返回 `ERROR_ACCESS_DENIED`），因此不要用 `DSH_PIN_SMOKE_TOGGLE=1` 在普通 shell 中测试写入。

## 文件

- `index.js` — Host 路由、`wanted` 状态机、最大化挂起/恢复、卸载清理
- `win32.js` — koffi 绑定、主窗口解析、置顶读写
- `client.js` — 标题栏按钮、三态样式、轮询、locale、可访问性
- `locale/*.json` — Plugin Manager 的标题/描述/详情入口
- `docs/` — 单图详情页与示意图
- `icon.svg` — 插件图标
