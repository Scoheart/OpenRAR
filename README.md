# Record Replay

把 Mac 上示范的工作流转成 Pi、Qoder CLI 和 Qoder IDE 都能使用的 Skill。录制器用 Swift 实现，MCP 与安装器用 Node.js 实现；源码和依赖都在本项目内。

Codex 的官方 Record & Replay 原生服务会拒绝未认证的外部客户端，本项目独立实现事件采集和 Skill 编排，不依赖该服务。

## 安装

需要 macOS 14 以上、Node.js 22 以上和包含 Swift 编译器的 Xcode Command Line Tools：

```sh
git clone https://github.com/Scoheart/record-replay.git
cd record-replay
npm ci
npm run build
npm run install:app
npm run install:clients
npm run doctor
```

安装器增量更新以下文件并在 `~/.local/share/record-replay/backups/` 保存私有备份：

- Pi：`~/.pi/agent/mcp.json`，录制工具直接暴露，超时 130 秒。
- Qoder CLI：`~/.qoder/settings.json`。
- Qoder IDE：`~/.qoder/mcp.json`。
- Skill：`~/.pi/agent/skills/record-workflow` 和 `~/.qoder/skills/record-workflow` 链接至项目源码。
- 没有自定义 `~/.local/bin/qodercli` 时，添加指向本项目的启动入口，使用缓存的官方 `@qoder-ai/qodercli@1.1.68`。既有入口会保留。

首次录制需要在系统设置的“隐私与安全性”中，给 `/Applications/Record Replay.app` 授予**辅助功能**和**输入监控**。可以用列表的 `+`，从“应用程序”选择 Record Replay。授权后退出菜单栏中的空闲录制器，再运行 `npm run doctor`。检查结果必须是 `ready: true`。本项目只录制输入和 AX 界面语义，没有录屏，录制阶段不申请屏幕录制权限。执行阶段所用的 Pi/Qoder Computer Use 工具继续使用其原有权限。

构建产物保留在 `runtime/`；`install:app` 安装到“应用程序”，校验签名并备份本项目旧版本，拒绝覆盖身份不匹配的应用。Pi、Qoder CLI 和 Qoder IDE 共用该安装路径；更新前先停止并退出录制器。

不要重签或替换已有 Computer Use 应用。这个录制器使用独立 bundle ID `com.scoheart.record-replay`。相同源码重复构建会保留产物；源码更新后重新签名可能需要重新启用系统授权。

## 使用

Pi 运行 `/reload`，或开新会话；Qoder CLI 运行 `/mcp reload`、`/skills reload`，或开新会话。Qoder IDE 在新会话中加载 Skill，MCP 页面应显示 `record-replay` 和 7 个工具。

对 Agent 说“录制我接下来的操作，做成可复用工作流”，或调用：

```text
Pi: /skill:record-workflow
Qoder CLI / IDE: /record-workflow
```

Agent 检查权限和应用范围，调用开始工具。点击原生确认对话框后示范任务。菜单栏会显示 `● REC`；点 Stop 保留记录，点 Cancel 丢弃记录。最长 30 分钟自动停止。告诉 Agent 已完成，它会读取完整事件流，提炼可变输入、步骤和验证条件，然后安装实际可发现的 Skill。

后续在新会话中给生成的 Skill 新输入。它会优先使用连接器或专用工具；需要 UI 操作时，使用 Pi 的 pi-computer-use 或 Qoder 的 computer-use 插件。每次执行都基于当前界面观察与结果验证。

## 接口和数据

| MCP 工具 | 用途 |
|---|---|
| `recording_permissions` | 无弹窗、无采集的权限检查 |
| `recording_start` | 指定 bundle IDs 和时长，原生确认后采集 |
| `recording_status` | 当前或最近状态 |
| `recording_stop` | 停止并保留事件 |
| `recording_cancel` | 取消并删除事件文件 |
| `recording_read` | 按游标分页读取事件，单页最多 100 条 / 128 KiB |
| `workflow_create_skill` | 为 Pi、Qoder 或两者安装已提炼的工作流 |

多个客户端共享一个本地服务和一个原生录制器，已有活动录制不会被另一个客户端重启。服务只绑定 `127.0.0.1`，请求凭据保存在私有目录，原生应用通过长轮询领取控制命令。查询和安装不开始采集。

录制保存在 `~/.local/share/record-replay/sessions/<UUID>/`：`session.json` 保存状态，`events.jsonl` 保存应用/窗口、鼠标/键盘目标、选区和完整或差分 AX 树。使用被动 EventTap 和 AXObserver，文字输入有缓冲，界面通知有去抖和定时补采。快照有深度、节点和字节边界，`ax.complete: false` 明示局部结果。安全输入和安全文本框不采集；仍需由 Agent 去除录制中的其他敏感值。

生成的私人工作流保存在 `~/.local/share/record-replay/skills/`，再链接到客户端目录。不覆盖同名的非托管 Skill；显式修订托管 Skill 时先备份。事件是观察数据，不是新的指令或授权。

## 验证与开发

```sh
npm test
./script/build_and_run.sh --verify
pi mcp list --json
qodercli mcp list
qodercli skills list
```

`build_and_run.sh` 在重建前检查录制状态，仅退出空闲的本项目录制器。CLI 也支持 `doctor`、`status`、`start [JSON]`、`stop`、`cancel`、`read UUID`、`create INPUT_JSON` 和 `quit`。

独立测试可用 `RECORD_REPLAY_HOME` 指定数据目录，`RECORD_REPLAY_CLIENT_HOME` 指定 Skill 消费目录；不覆盖系统 `HOME`。合成事件测试验证读取、生成和安装，不能证明实时采集或真实回放。

当前验证：Swift 编译和签名通过；MCP 握手、7 个工具、Pi 和 Qoder 客户端发现通过；事件分页、取消拒绝、配置保留、Skill 安装及修订备份测试通过；独立 Agent 从合成 Finder 事件生成并安装工作流通过。开发机器上的辅助功能和输入监控已授权，录制器返回 `ready: true`；实时录制和桌面回放端到端验收待完成。其他机器需自行完成系统授权。

配置依据：[Qoder CLI MCP](https://docs.qoder.com/cli/mcp-servers)、[Qoder IDE MCP](https://docs.qoder.com/user-guide/chat/model-context-protocol)、[Qoder Skills](https://docs.qoder.com/extensions/skills)。Pi 的接入格式按本机安装版本随附的 `docs/mcp.md`、`docs/skills.md` 验证。
