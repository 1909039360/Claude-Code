# Claude Code 项目分析报告

> 分析对象：`@anthropic-ai/claude-code` 还原源码  
> 生成日期：2026-06-18  
> 工作区：`C:\Users\zhongxu.zhao\OneDrive - L'Oréal\Documents\workspace\Claude-Code`

---

## 一、项目概述

本项目是一份**从 npm 包 source map 还原的 Claude Code 源码**，版本号为 `999.0.0-restored`，仅供研究学习。它完整保留了 Anthropic 内部版 Claude Code 的 TypeScript 源码结构，包括大量外部发布版中不存在的隐藏功能。

| 项目信息 | 内容 |
|----------|------|
| 包名 | `@anthropic-ai/claude-code` |
| 版本 | `999.0.0-restored` |
| 包管理器 | Bun `1.3.5` |
| 运行时要求 | Bun ≥ 1.3.5、Node.js ≥ 24 |
| 许可证 | `SEE LICENSE IN LICENSE.md` |
| 仓库 | https://github.com/anthropics/claude-code.git |

### 1.1 性质说明

- **非官方版本**：基于公开 npm 包 source map 还原，源码版权归 Anthropic 所有。
- **可本地运行**：提供 `bun run dev` 等脚本，可在本地启动 CLI。
- **研究性质**：README 明确声明仅供技术研究与学习，不得用于商业用途。

---

## 二、规模与代码统计

### 2.1 总体规模

| 指标 | 数值 |
|------|------|
| `src/` 总文件数 | **2,039** 个 |
| TypeScript 文件 (`.ts`) | 1,421 个 |
| TSX 文件 (`.tsx`) | 566 个 |
| JavaScript 文件 (`.js`/`.jsx`) | 19 个 |
| `src/` 总代码行数 | **27,638** 行（仅统计 `.ts`/`.tsx`） |
| 顶级目录数 | 约 50 个 |
| 命令（`src/commands/`） | 102 个 |
| 工具（`src/tools/`） | 54 个 |
| 组件（`src/components/`） | 约 146 个顶层 |
| Hooks（`src/hooks/`） | 105 个 |
| 依赖数量 | 74 个运行时依赖 |
| `feature()` 调用 | 1,076 处 |
| 测试文件 | 0 个 |

### 2.2 文件分布

| 目录 | 文件数 | 主要职责 |
|------|--------|----------|
| `src/utils/` | 574 | 通用工具、平台抽象、权限、模型、Git、MCP 等 |
| `src/components/` | 406 | 终端 UI 组件（Ink + React） |
| `src/commands/` | 213 | 斜杠命令实现 |
| `src/tools/` | 199 | Agent 工具实现 |
| `src/hooks/` | 105 | 自定义 React hooks |
| `src/ink/` | 100 | Ink 终端渲染框架封装 |
| `src/services/` | 148 | API、MCP、分析、LSP、设置同步等 |
| `src/bridge/` | 33 | 远程桥接控制 |
| `src/types/` | 19 | 共享类型定义 |
| `src/state/` | 6 | 全局状态管理 |
| `src/tasks/` | 14 | 后台任务定义 |

### 2.3 最大的源文件

| 文件 | 行数 | 作用 |
|------|------|------|
| `src/main.tsx` | 4,690 | 主入口，CLI 启动流程 |
| `src/cli/print.ts` | 5,594 | CLI 输出/打印 |
| `src/utils/messages.ts` | 5,512 | 消息构造与格式化 |
| `src/utils/sessionStorage.ts` | 5,105 | 会话存储 |
| `src/screens/REPL.tsx` | 5,061 | 交互式 REPL 界面 |
| `src/utils/hooks.ts` | 5,022 | Hooks 工具 |
| `src/utils/bash/bashParser.ts` | 4,436 | Bash 命令解析 |
| `src/utils/attachments.ts` | 3,997 | 附件处理 |
| `src/services/api/claude.ts` | 3,419 | Anthropic API 调用核心 |
| `src/services/mcp/client.ts` | 3,348 | MCP 客户端 |

---

## 三、技术栈

### 3.1 核心运行时与框架

| 技术 | 用途 |
|------|------|
| **Bun** | 运行时与包管理器，支持 `bun:bundle` 原生特性（如 `feature()` 编译开关） |
| **TypeScript** | 全栈类型安全 |
| **React** | UI 组件模型 |
| **Ink** | 终端 React 渲染框架 |
| **@anthropic-ai/sdk** | Anthropic API 调用 |
| **@modelcontextprotocol/sdk** | MCP 协议实现 |
| **Zod** | Schema 校验 |
| **Commander.js** | CLI 参数解析 |

### 3.2 关键依赖类别

- **AI / API**：`@anthropic-ai/sdk`、`@aws-sdk/client-bedrock-runtime`、`google-auth-library`
- **终端 UI**：`ink`、`chalk`、`wrap-ansi`、`cli-boxes`、`figures`
- **系统工具**：`execa`、`tree-kill`、`proper-lockfile`、`signal-exit`
- **数据/搜索**：`fuse.js`、`lru-cache`、`yaml`、`marked`、`highlight.js`
- **遥测/可观测性**：OpenTelemetry 全套、`@growthbook/growthbook`
- **原生模块 shim**：`color-diff-napi`、`modifiers-napi`、`url-handler-napi` 等（本地 shim）

---

## 四、架构分析

### 4.1 入口与启动流程

```
src/dev-entry.ts
      │
      ▼
  检查缺失的相对 import
      │
      ▼
  如果无缺失 → import('./entrypoints/cli.tsx')
      │
      ▼
  src/main.tsx（主 CLI 入口）
```

- `dev-entry.ts`：开发/还原环境的启动器，会先扫描缺失的相对导入，并在缺失时给出友好提示。
- `main.tsx`：真正的主入口，负责初始化 OAuth、GrowthBook、权限、MCP、LSP、设置迁移、启动 REPL 等。
- `entrypoints/cli.tsx`：原始 CLI 引导入口。

### 4.2 核心模块分层

```
┌──────────────────────────────────────────────────────┐
│  UI 层 (components/, screens/, ink/)                 │  终端 React 界面
├──────────────────────────────────────────────────────┤
│  命令层 (commands/, commands.ts)                     │  斜杠命令注册与分发
├──────────────────────────────────────────────────────┤
│  工具层 (tools/, Tool.ts, tools.ts)                  │  AI Agent 可用工具
├──────────────────────────────────────────────────────┤
│  服务层 (services/)                                  │  API/MCP/LSP/分析/遥测
├──────────────────────────────────────────────────────┤
│  状态层 (state/, bootstrap/state.ts)                │  应用状态管理
├──────────────────────────────────────────────────────┤
│  工具函数层 (utils/)                                 │  平台、权限、模型、Git 等
└──────────────────────────────────────────────────────┘
```

### 4.3 工具系统（Tools）

`src/tools.ts` 是工具注册中心，通过 `getAllBaseTools()` 返回所有可用工具。

核心工具包括：

| 工具 | 说明 |
|------|------|
| `BashTool` | 执行 shell 命令 |
| `FileReadTool` / `FileEditTool` / `FileWriteTool` | 文件读写编辑 |
| `GlobTool` / `GrepTool` | 文件搜索 |
| `AgentTool` | 启动子代理 |
| `TaskCreateTool` / `TaskGetTool` / `TaskUpdateTool` / `TaskListTool` | 任务管理 |
| `WebFetchTool` / `WebSearchTool` | 网络请求与搜索 |
| `MCP` 相关工具 | `MCPTool`、`ListMcpResourcesTool`、`ReadMcpResourceTool`、`McpAuthTool` |
| `NotebookEditTool` | Jupyter Notebook 编辑 |
| `LSPTool` | LSP 服务器交互 |
| `EnterPlanModeTool` / `ExitPlanModeTool` | 计划模式 |
| `EnterWorktreeTool` / `ExitWorktreeTool` | Git worktree 模式 |

工具加载受多因素影响：
- `feature('...')` 编译开关
- `process.env.USER_TYPE === 'ant'` 内部用户检查
- `isEnvTruthy(process.env.XXX)` 环境变量
- `isTodoV2Enabled()`、`isToolSearchEnabledOptimistic()` 等运行时配置

### 4.4 命令系统（Commands）

`src/commands.ts` 聚合了所有斜杠命令，总数约 **102 个**。

命令类型：
- **常驻命令**：`init`、`login`、`logout`、`help`、`diff`、`review`、`commit` 等
- **特性门控命令**：`buddy`、`proactive`、`assistant`、`brief`、`bridge`、`voice`、`ultraplan` 等
- **内部命令**（`USER_TYPE === 'ant'`）：`teleport`、`bughunter`、`mock-limits`、`ctx_viz` 等

命令注册示例：

```typescript
const proactive = feature('PROACTIVE') || feature('KAIROS')
  ? require('./commands/proactive.js').default
  : null
```

### 4.5 特性门控体系

项目存在三层门控：

1. **编译时开关** `feature()`：约 50 个，构建时决定代码是否包含。
2. **用户类型** `USER_TYPE`：
   - `'ant'`：Anthropic 内部用户，解锁全部功能
   - `'external'`：外部用户，功能受限
3. **远程配置**（GrowthBook）：如 `tengu_kairos`、`tengu_ultraplan_model` 等动态 A/B 开关

高频 `feature()` 调用（1,076 处）说明项目大量使用编译时裁剪来区分内部/外部构建。

---

## 五、隐藏功能概览

项目源码中发现了大量外部版未公开的隐藏功能，详见 `docs/` 下已有的专题分析：

| 功能 | 开关 | 源码位置 |
|------|------|----------|
| **BUDDY** — AI 电子宠物 | `feature('BUDDY')` | `src/buddy/` |
| **KAIROS** — 持久助手 / 主动模式 | `feature('KAIROS')` | `src/assistant/`、`src/proactive/`、`src/services/autoDream/` |
| **ULTRAPLAN** — 云端深度规划 | `feature('ULTRAPLAN')` | `src/commands/ultraplan.tsx`、`src/utils/ultraplan/` |
| **COORDINATOR_MODE** — 多 Agent 编排 | `feature('COORDINATOR_MODE')` | `src/coordinator/` |
| **BRIDGE_MODE** — 远程遥控终端 | `feature('BRIDGE_MODE')` | `src/bridge/`（33 文件） |
| **VOICE_MODE** — 语音交互 | `feature('VOICE_MODE')` | `src/voice/` |
| **隐藏命令** | 多种开关 | `src/commands.ts`、`src/commands/` |
| **50+ 编译开关** | `feature('...')` | 遍布全源码 |

---

## 六、依赖与构建分析

### 6.1 package.json 关键配置

```json
{
  "type": "module",
  "packageManager": "bun@1.3.5",
  "scripts": {
    "dev": "bun run ./src/dev-entry.ts",
    "start": "bun run ./src/dev-entry.ts",
    "version": "bun run ./src/dev-entry.ts --version"
  }
}
```

- **纯 ESM**：`"type": "module"`
- **Bun 专用**：大量依赖 `bun:bundle` 和 Bun 运行时特性
- **无测试脚本**：未配置 `test`、`lint` 脚本
- **本地 shim 包**：通过 `file:./shims/...` 引用 7 个本地 shim 包

### 6.2 本地 shim 与 vendor

| 目录 | 作用 |
|------|------|
| `shims/` | 原生模块/私有包的兼容替代，共 7 个包 |
| `vendor/` | 原生绑定源码，如 `image-processor`、`audio-capture`、`modifiers-napi` |

---

## 七、优势

1. **功能完整**：还原版保留了官方构建中被裁剪的大量内部功能，是研究 Claude Code 架构的珍贵材料。
2. **架构清晰**：按职责分层明确，工具、命令、服务、组件分离良好。
3. **高度可配置**：通过环境变量、settings.json、CLI 参数支持多种 API 后端（Anthropic、Bedrock、Vertex、第三方兼容服务）。
4. **工具生态丰富**：内置 54+ 个工具，覆盖文件、Shell、Web、MCP、Agent、任务等。
5. **终端 UI 成熟**：基于 Ink 的 TUI，组件数量多，交互体验接近桌面应用。

---

## 八、潜在问题与风险

1. **版权与合规风险**
   - 源码为 Anthropic 私有财产，未经授权不得商用或再分发。
   - 仅适合个人本地研究。

2. **还原完整性风险**
   - `dev-entry.ts` 会扫描缺失的相对导入，说明还原可能不完整。
   - 部分内部私有包被替换为 shim，功能可能受限。

3. **无测试覆盖**
   - 项目中未找到 `.test.ts` / `.spec.ts` 文件。
   - 验证依赖手动运行 `bun run dev` / `bun run version`。

4. **Bun 运行时依赖**
   - 依赖 `bun:bundle` 等 Bun 专有 API，无法直接迁移到 Node.js。
   - 版本锁定在 Bun `1.3.5`。

5. **安全与权限**
   - 工具可直接执行 Bash、编辑文件、访问网络，存在较高权限风险。
   - 权限系统虽然存在，但还原版可能未完整保留所有安全策略。

6. **维护性挑战**
   - 单文件体积过大（如 `main.tsx` 4,690 行、`cli/print.ts` 5,594 行）。
   - 大量 `feature()` 分支和条件导入增加了代码复杂度。

---

## 九、结论

本项目是一份**高价值的 Claude Code 源码还原样本**，完整展现了 Anthropic 内部版 CLI 的宏大架构：约 2,000 个源文件、27K+ 行代码、50+ 个编译开关、102 个命令、54 个工具。它不仅是学习 AI Agent 终端工具设计的绝佳案例，也揭示了官方发布版之外被裁剪的隐藏能力。

但作为还原版本，其在**完整性、合规性、测试覆盖、可维护性**方面存在固有风险。建议仅用于：

- 技术研究和个人学习
- 理解 Claude Code 的命令、工具、权限和 UI 架构
- 分析 AI Agent 产品的工程实现模式

不建议用于生产环境或商业用途。

---

## 十、附录：目录速查

```
Claude-Code/
├── src/                    # 核心源码
│   ├── commands/           # 斜杠命令
│   ├── components/         # 终端 UI 组件
│   ├── hooks/              # 自定义 React hooks
│   ├── ink/                # Ink 封装
│   ├── services/           # API/MCP/LSP/分析等服务
│   ├── tools/              # Agent 工具
│   ├── utils/              # 工具函数
│   ├── state/              # 状态管理
│   ├── bridge/             # 远程桥接
│   ├── buddy/              # 宠物系统
│   ├── assistant/          # KAIROS 助手模式
│   ├── coordinator/         # 多 Agent 编排
│   ├── proactive/          # 主动模式
│   ├── vim/                # Vim 模式
│   └── voice/              # 语音交互
├── shims/                  # 本地兼容 shim 包
├── vendor/                 # 原生绑定源码
├── docs/                   # 项目文档与分析报告
├── package.json            # 包配置
├── tsconfig.json           # TypeScript 配置
└── README.md               # 项目说明
```
