/**
 * QueryEngine 模块 —— 负责查询生命周期与会话状态管理。
 * 提供 QueryEngine 类和便捷的 ask() 函数，支持无头模式/SDK 调用以及交互式 REPL。
 */

import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import last from 'lodash-es/last.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from 'src/bootstrap/state.js'
import type {
  PermissionMode,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKStatus,
  SDKUserMessageReplay,
} from 'src/entrypoints/agentSdkTypes.js'
import { accumulateUsage, updateUsage } from 'src/services/api/claude.js'
import type { NonNullableUsage } from 'src/services/api/logging.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import stripAnsi from 'strip-ansi'
import type { Command } from './commands.js'
import { getSlashCommandToolSkills } from './commands.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from './constants/xml.js'
import {
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
} from './cost-tracker.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'
import { query } from './query.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import type { MCPServerConnection } from './services/mcp/types.js'
import type { AppState } from './state/AppState.js'
import { type Tools, type ToolUseContext, toolMatchesName } from './Tool.js'
import type { AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { Message } from './types/message.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { createAbortController } from './utils/abortController.js'
import type { AttributionState } from './utils/commitAttribution.js'
import { getGlobalConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { getFastModeState } from './utils/fastMode.js'
import {
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from './utils/fileHistory.js'
import {
  cloneFileStateCache,
  type FileStateCache,
} from './utils/fileStateCache.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { getInMemoryErrors } from './utils/log.js'
import { countToolCalls, SYNTHETIC_MESSAGES } from './utils/messages.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from './utils/model/model.js'
import { loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js'
import {
  type ProcessUserInputContext,
  processUserInput,
} from './utils/processUserInput/processUserInput.js'
import { fetchSystemPromptParts } from './utils/queryContext.js'
import { setCwd } from './utils/Shell.js'
import {
  flushSessionStorage,
  recordTranscript,
} from './utils/sessionStorage.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { resolveThemeSetting } from './utils/systemTheme.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './utils/thinking.js'

// 懒加载: MessageSelector.tsx 依赖 React/ink，仅在查询时消息过滤时才需要
/* eslint-disable @typescript-eslint/no-require-imports */
const messageSelector =
  (): typeof import('src/components/MessageSelector.js') =>
    require('src/components/MessageSelector.js')

import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import {
  buildSystemInitMessage,
  sdkCompatToolName,
} from './utils/messages/systemInit.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from './utils/permissions/filesystem.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  handleOrphanedPermission,
  isResultSuccessful,
  normalizeMessage,
} from './utils/queryHelpers.js'

// 死代码消除: 协调器模式下的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({})
/* eslint-enable @typescript-eslint/no-require-imports */

// 死代码消除: 历史记录压缩（snip）功能的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const snipProjection = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipProjection.js') as typeof import('./services/compact/snipProjection.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/** QueryEngine 配置选项 */
export type QueryEngineConfig = {
  /** 当前工作目录 */
  cwd: string
  /** 可用工具集合 */
  tools: Tools
  /** 斜杠命令列表 */
  commands: Command[]
  /** MCP 客户端连接列表 */
  mcpClients: MCPServerConnection[]
  /** 可用代理定义列表 */
  agents: AgentDefinition[]
  /** 检查工具是否可用的函数 */
  canUseTool: CanUseToolFn
  /** 获取当前应用状态 */
  getAppState: () => AppState
  /** 更新应用状态 */
  setAppState: (f: (prev: AppState) => AppState) => void
  /** 初始消息列表（用于恢复会话） */
  initialMessages?: Message[]
  /** 文件状态缓存 */
  readFileCache: FileStateCache
  /** 自定义系统提示词（覆盖默认） */
  customSystemPrompt?: string
  /** 追加到系统提示词末尾 */
  appendSystemPrompt?: string
  /** 用户指定的模型名称 */
  userSpecifiedModel?: string
  /** 降级备用模型 */
  fallbackModel?: string
  /** 思考配置（extended thinking） */
  thinkingConfig?: ThinkingConfig
  /** 最大对话轮次 */
  maxTurns?: number
  /** 最大预算（美元） */
  maxBudgetUsd?: number
  /** 任务预算限制 */
  taskBudget?: { total: number }
  /** JSON Schema（用于结构化输出模式） */
  jsonSchema?: Record<string, unknown>
  /** 是否输出详细信息 */
  verbose?: boolean
  /** 是否回放用户消息 */
  replayUserMessages?: boolean
  /** MCP 工具 -32042 错误引发的 URL 诱导处理器 */
  handleElicitation?: ToolUseContext['handleElicitation']
  /** 是否包含部分消息（流事件） */
  includePartialMessages?: boolean
  /** 设置 SDK 状态的回调 */
  setSDKStatus?: (status: SDKStatus) => void
  /** 外部中止控制器 */
  abortController?: AbortController
  /** 待处理的孤悬权限（前一轮未完成的工具调用权限） */
  orphanedPermission?: OrphanedPermission
  /**
   * Snip 边界处理器：接收每个生成的系统消息和当前的 mutableMessages 存储。
   * 如果该消息不是 snip 边界则返回 undefined；否则返回重放的 snip 结果。
   * 由 ask() 在 HISTORY_SNIP 启用时注入，使特性开关字符串保持在特性门控模块内
   * （保证 QueryEngine 不包含被排除的字符串，且可在 feature() 返回 false 时测试）。
   * 仅限 SDK：REPL 保留完整历史以支持 UI 回滚，并按需通过 projectSnippedView 投影；
   * QueryEngine 在此截断以限制长无头会话中的内存占用（无 UI 需要保留）。
   */
  snipReplay?: (
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
}

/**
 * QueryEngine —— 查询生命周期与会话状态管理器。
 * 它将 ask() 的核心逻辑提取为独立类，可供无头/SDK 路径以及（未来阶段）REPL 使用。
 *
 * 每个对话对应一个 QueryEngine 实例。每次 submitMessage() 调用在同一对话中
 * 开启新的一轮。状态（消息列表、文件缓存、用量统计等）跨轮次持续存在。
 */
export class QueryEngine {
  /** 引擎配置 */
  private config: QueryEngineConfig
  /** 可变消息列表（随对话推进不断增长） */
  private mutableMessages: Message[]
  /** 中止控制器（用于中断当前查询） */
  private abortController: AbortController
  /** 本轮中的权限拒绝记录列表（用于 SDK 报告） */
  private permissionDenials: SDKPermissionDenial[]
  /** 累计 API 用量（跨轮次累加） */
  private totalUsage: NonNullableUsage
  /** 是否已处理过孤悬权限（避免重复处理） */
  private hasHandledOrphanedPermission = false
  /** 文件状态缓存 */
  private readFileState: FileStateCache
  /**
   * 轮次级别的技能发现追踪（为 tengu_skill_tool_invocation 提供 was_discovered）。
   * 必须在 submitMessage 内部的两次 processUserInputContext 重建之间保持持久，
   * 但在每次 submitMessage 开始时清除，以避免 SDK 模式下多轮次无限增长。
   */
  private discoveredSkillNames = new Set<string>()
  /** 已加载的嵌套记忆路径集合（避免重复加载） */
  private loadedNestedMemoryPaths = new Set<string>()

  /**
   * @param config - 引擎配置选项
   */
  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }

  /**
   * 提交一条用户消息并开始新一轮查询。
   * 返回一个异步生成器，依次生成各种 SDK 消息类型（用户消息回放、助手回复、流事件、系统消息、结果等）。
   *
   * @param prompt - 用户输入的提示词（纯文本或 ContentBlock 数组）
   * @param options - 可选参数（消息 UUID、是否为元消息）
   */
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const {
      cwd,
      commands,
      tools,
      mcpClients,
      verbose = false,
      thinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      canUseTool,
      customSystemPrompt,
      appendSystemPrompt,
      userSpecifiedModel,
      fallbackModel,
      jsonSchema,
      getAppState,
      setAppState,
      replayUserMessages = false,
      includePartialMessages = false,
      agents = [],
      setSDKStatus,
      orphanedPermission,
    } = this.config

    // 清除上一轮的技能发现记录，开始新的一轮
    this.discoveredSkillNames.clear()
    setCwd(cwd)
    const persistSession = !isSessionPersistenceDisabled()
    const startTime = Date.now()

    /**
     * 包装 canUseTool 以追踪权限拒绝记录，用于 SDK 报告。
     * 当工具调用被拒绝时，将拒绝信息记录到 permissionDenials 数组中。
     */
    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const result = await canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )

      // 记录拒绝信息，用于向 SDK 报告
      if (result.behavior !== 'allow') {
        this.permissionDenials.push({
          tool_name: sdkCompatToolName(tool.name),
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }

      return result
    }

    const initialAppState = getAppState()
    const initialMainLoopModel = userSpecifiedModel
      ? parseUserSpecifiedModel(userSpecifiedModel)
      : getMainLoopModel()

    // 初始化 thinking 配置：如果未指定，则根据默认设置决定启用自适应模式还是禁用
    const initialThinkingConfig: ThinkingConfig = thinkingConfig
      ? thinkingConfig
      : shouldEnableThinkingByDefault() !== false
        ? { type: 'adaptive' }
        : { type: 'disabled' }

    headlessProfilerCheckpoint('before_getSystemPrompt')
    // 缩小类型范围，使 TS 能在后续条件分支中正确追踪类型
    const customPrompt =
      typeof customSystemPrompt === 'string' ? customSystemPrompt : undefined
    const {
      defaultSystemPrompt,
      userContext: baseUserContext,
      systemContext,
    } = await fetchSystemPromptParts({
      tools,
      mainLoopModel: initialMainLoopModel,
      additionalWorkingDirectories: Array.from(
        initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt: customPrompt,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(
        mcpClients,
        isScratchpadEnabled() ? getScratchpadDir() : undefined,
      ),
    }

    /**
     * 当 SDK 调用者提供了自定义系统提示词，并且设置了
     * CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 环境变量时，
     * 注入记忆机制提示词。该环境变量是明确的主动启用信号——
     * 调用者已配置了记忆目录，需要告知 Claude 如何使用
     * （调用哪些 Write/Edit 工具、MEMORY.md 文件名、加载语义等）。
     * 调用者可以通过 appendSystemPrompt 添加自己的策略文本。
     */
    const memoryMechanicsPrompt =
      customPrompt !== undefined && hasAutoMemPathOverride()
        ? await loadMemoryPrompt()
        : null

    // 组装最终的系统提示词
    const systemPrompt = asSystemPrompt([
      ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
      ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])

    // 注册结构化输出的函数钩子
    const hasStructuredOutputTool = tools.some(t =>
      toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    )
    if (jsonSchema && hasStructuredOutputTool) {
      registerStructuredOutputEnforcement(setAppState, getSessionId())
    }

    let processUserInputContext: ProcessUserInputContext = {
      messages: this.mutableMessages,
      /**
       * 斜杠命令（如 /force-snip）通过 setMessages(fn) 修改消息数组。
       * 交互模式下写回 AppState，打印模式下写回 mutableMessages，
       * 以便后续的查询循环能看到结果。
       * 在斜杠命令处理之后，第二个 processUserInputContext 配置为无操作，
       * 因为后续没有其他地方会调用 setMessages。
       */
      setMessages: fn => {
        this.mutableMessages = fn(this.mutableMessages)
      },
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false, // we use stdout, so don't want to clobber it
        tools,
        verbose,
        mainLoopModel: initialMainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        theme: resolveThemeSetting(getGlobalConfig().theme),
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: (
        updater: (prev: FileHistoryState) => FileHistoryState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.fileHistory)
          if (updated === prev.fileHistory) return prev
          return { ...prev, fileHistory: updated }
        })
      },
      updateAttributionState: (
        updater: (prev: AttributionState) => AttributionState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.attribution)
          if (updated === prev.attribution) return prev
          return { ...prev, attribution: updated }
        })
      },
      setSDKStatus,
    }

    /**
     * 处理孤悬权限（仅在引擎生命周期内处理一次）。
     * 孤悬权限是指上一轮因中断而未完成的工具调用权限请求，
     * 需要在新一轮开始时补充处理。
     */
    if (orphanedPermission && !this.hasHandledOrphanedPermission) {
      this.hasHandledOrphanedPermission = true
      for await (const message of handleOrphanedPermission(
        orphanedPermission,
        tools,
        this.mutableMessages,
        processUserInputContext,
      )) {
        yield message
      }
    }

    // 处理用户输入：解析消息、附件、斜杠命令等
    const {
      messages: messagesFromUserInput,
      shouldQuery,      // 是否需要进行 API 查询（斜杠命令可能不需要）
      allowedTools,     // 允许使用的工具列表
      model: modelFromUserInput, // 斜杠命令可能修改模型
      resultText,       // 本地命令的输出文本
    } = await processUserInput({
      input: prompt,
      mode: 'prompt',
      setToolJSX: () => {},
      context: {
        ...processUserInputContext,
        messages: this.mutableMessages,
      },
      messages: this.mutableMessages,
      uuid: options?.uuid,
      isMeta: options?.isMeta,
      querySource: 'sdk',
    })

    // 将用户输入（含附件）推入消息列表
    this.mutableMessages.push(...messagesFromUserInput)

    // 复制消息快照，反映斜杠命令处理后的最新状态
    const messages = [...this.mutableMessages]

    /**
     * 在进入查询循环之前将用户消息持久化到会话记录中。
     * 下方的 for-await 仅在 ask() 生成 assistant/user/compact_boundary
     * 消息时调用 recordTranscript——这在 API 响应之前不会发生。
     * 如果进程在此之前被终止（例如用户在发送后立即点击"停止"），
     * 会话记录中只会有队列操作条目；getLastSessionLog 会过滤掉这些条目，
     * 返回 null，导致 --resume 失败并报"未找到对话"。
     * 在此处写入使得即使从未收到 API 响应，也能从用户消息被接受的点恢复对话。
     *
     * --bare / SIMPLE 模式：即发即忘。脚本化调用不会在请求中途被杀后 --resume。
     * 等待操作用时约 4ms（SSD）~30ms（磁盘竞争）——这是模块评估后最大的可控关键路径开销。
     * 会话记录仍然会被写入（用于事后调试），只是不阻塞。
     */
    if (persistSession && messagesFromUserInput.length > 0) {
      const transcriptPromise = recordTranscript(messages)
      if (isBareMode()) {
        void transcriptPromise
      } else {
        await transcriptPromise
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }
    }

    /**
     * 筛选需要确认回放的用户消息。
     * 排除合成警示消息、工具结果（由查询循环确认）、
     * 以及非用户创作的消息（任务通知等）。
     * 压缩边界消息始终需要确认。
     */
    const replayableMessages = messagesFromUserInput.filter(
      msg =>
        (msg.type === 'user' &&
          !msg.isMeta &&
          !msg.toolUseResult &&
          messageSelector().selectableUserMessagesFilter(msg)) ||
        (msg.type === 'system' && msg.subtype === 'compact_boundary'),
    )
    const messagesToAck = replayUserMessages ? replayableMessages : []

    // 根据用户输入处理结果更新工具权限上下文
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        alwaysAllowRules: {
          ...prev.toolPermissionContext.alwaysAllowRules,
          command: allowedTools,
        },
      },
    }))

    const mainLoopModel = modelFromUserInput ?? initialMainLoopModel

    /**
     * 处理用户输入后重新创建 processUserInputContext，
     * 以获取更新后的消息列表和模型（可能被斜杠命令修改）。
     * 此时 setMessages 设为空操作，因为后续不再需要修改消息数组。
     */
    processUserInputContext = {
      messages,
      setMessages: () => {},
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false,
        tools,
        verbose,
        mainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        theme: resolveThemeSetting(getGlobalConfig().theme),
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: processUserInputContext.updateFileHistoryState,
      updateAttributionState: processUserInputContext.updateAttributionState,
      setSDKStatus,
    }

    headlessProfilerCheckpoint('before_skills_plugins')
    /**
     * 仅使用缓存加载技能和插件：无头/SDK/CCR 启动时不得阻塞网络等待引用的插件。
     * CCR 通过 CLAUDE_CODE_SYNC_PLUGIN_INSTALL（headlessPluginInstall）或
     * CLAUDE_CODE_PLUGIN_SEED_DIR 在运行前填充缓存；
     * 需要最新源文件的 SDK 调用者可以调用 /reload-plugins。
     */
    const [skills, { enabled: enabledPlugins }] = await Promise.all([
      getSlashCommandToolSkills(getCwd()),
      loadAllPluginsCacheOnly(),
    ])
    headlessProfilerCheckpoint('after_skills_plugins')

    // 生成系统初始化消息，包含工具、MCP 客户端、模型、命令、代理、技能、插件等信息
    yield buildSystemInitMessage({
      tools,
      mcpClients,
      model: mainLoopModel,
      permissionMode: initialAppState.toolPermissionContext
        .mode as PermissionMode, // TODO: 避免类型断言
      commands,
      agents,
      skills,
      plugins: enabledPlugins,
      fastMode: initialAppState.fastMode,
    })

    // 记录系统消息生成的时刻，用于无头模式延迟追踪
    headlessProfilerCheckpoint('system_message_yielded')

    if (!shouldQuery) {
      /**
       * 返回本地斜杠命令的执行结果。
       * 使用 messagesFromUserInput（而非 replayableMessages）获取命令输出，
       * 因为 selectableUserMessagesFilter 会过滤掉本地命令的 stdout 标签。
       */
      for (const msg of messagesFromUserInput) {
        if (
          msg.type === 'user' &&
          typeof msg.message.content === 'string' &&
          (msg.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.message.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
            msg.isCompactSummary)
        ) {
          yield {
            type: 'user',
            message: {
              ...msg.message,
              content: stripAnsi(msg.message.content),
            },
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
            isReplay: !msg.isCompactSummary,
            isSynthetic: msg.isMeta || msg.isVisibleInTranscriptOnly,
          } as SDKUserMessageReplay
        }

        // Local command output — yield as a synthetic assistant message so
        // RC renders it as assistant-style text rather than a user bubble.
        // Emitted as assistant (not the dedicated SDKLocalCommandOutputMessage
        // system subtype) so mobile clients + session-ingress can parse it.
        if (
          msg.type === 'system' &&
          msg.subtype === 'local_command' &&
          typeof msg.content === 'string' &&
          (msg.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          yield localCommandOutputToSDKAssistantMessage(msg.content, msg.uuid)
        }

        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          yield {
            type: 'system',
            subtype: 'compact_boundary' as const,
            session_id: getSessionId(),
            uuid: msg.uuid,
            compact_metadata: toSDKCompactMetadata(msg.compactMetadata),
          } as SDKCompactBoundaryMessage
        }
      }

      if (persistSession) {
        await recordTranscript(messages)
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }

      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        num_turns: messages.length - 1,
        result: resultText ?? '',
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
      }
      return
    }

    // 如果启用了文件历史记录，为用户输入中可筛选的消息创建快照
    if (fileHistoryEnabled() && persistSession) {
      messagesFromUserInput
        .filter(messageSelector().selectableUserMessagesFilter)
        .forEach(message => {
          void fileHistoryMakeSnapshot(
            (updater: (prev: FileHistoryState) => FileHistoryState) => {
              setAppState(prev => ({
                ...prev,
                fileHistory: updater(prev.fileHistory),
              }))
            },
            message.uuid,
          )
        })
    }

    /** 当前消息的 API 用量统计（每次 message_start 时重置） */
    let currentMessageUsage: NonNullableUsage = EMPTY_USAGE
    /** 当前轮次计数 */
    let turnCount = 1
    /** 是否已确认初始用户消息 */
    let hasAcknowledgedInitialMessages = false
    /** 从 StructuredOutput 工具调用中提取的结构化输出 */
    let structuredOutputFromTool: unknown
    /** 上一条助手消息的停止原因 */
    let lastStopReason: string | null = null
    /**
     * 基于引用的水印，使 error_during_execution 的错误列表限定在轮次范围内。
     * 使用基于长度的索引在 100 条环形缓冲区轮转时会失效（索引滑动）。
     * 如果该条目被轮转出去，lastIndexOf 返回 -1，则包含所有错误（安全回退）。
     */
    const errorLogWatermark = getInMemoryErrors().at(-1)
    /** 本次查询前结构化输出调用的快照计数，用于增量重试限制 */
    const initialStructuredOutputCalls = jsonSchema
      ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
      : 0

    // 进入主查询循环：与 API 交互，处理工具调用，生成消息
    for await (const message of query({
      messages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext: processUserInputContext,
      fallbackModel,
      querySource: 'sdk',
      maxTurns,
      taskBudget,
    })) {
      // 记录助手消息、用户消息和压缩边界消息
      if (
        message.type === 'assistant' ||
        message.type === 'user' ||
        (message.type === 'system' && message.subtype === 'compact_boundary')
      ) {
        /**
         * 在写入压缩边界之前，刷新 preservedSegment 尾部之前的所有仅内存消息。
         * 附件和进度消息现已内联记录（如下方 switch 分支所示），
         * 但此刷新对于 preservedSegment 尾部遍历仍然重要。
         * 如果 SDK 子进程在此之前重启（claude-desktop 在轮次间被终止），
         * tailUuid 会指向一条从未写入的消息 →
         * applyPreservedSegmentRelinks 的 tail→head 遍历失败 →
         * 返回而不修剪 → 恢复时加载完整的压缩前历史记录。
         */
        if (
          persistSession &&
          message.type === 'system' &&
          message.subtype === 'compact_boundary'
        ) {
          const tailUuid = message.compactMetadata?.preservedSegment?.tailUuid
          if (tailUuid) {
            const tailIdx = this.mutableMessages.findLastIndex(
              m => m.uuid === tailUuid,
            )
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1))
            }
          }
        }
        messages.push(message)
        if (persistSession) {
          /**
           * 助手消息采用"即发即忘"模式。claude.ts 为每个内容块生成一条助手消息，
           * 然后在 message_delta 时修改最后一条消息的 usage/stop_reason——
           * 依赖写入队列的 100ms 延迟 jsonStringify。在此处 await 会阻塞
           * ask() 的生成器，导致 message_delta 在所有内容块消费完毕前无法运行；
           * 耗尽定时器（在块 1 启动）会先触发。交互式 CC 不会遇到此问题是因为
           * useLogMessages.ts 使用了即发即忘。enqueueWrite 保证顺序，
           * 因此即发即忘是安全的。
           */
          if (message.type === 'assistant') {
            void recordTranscript(messages)
          } else {
            await recordTranscript(messages)
          }
        }

        // 首次记录会话文本后，确认初始用户消息
        if (!hasAcknowledgedInitialMessages && messagesToAck.length > 0) {
          hasAcknowledgedInitialMessages = true
          for (const msgToAck of messagesToAck) {
            if (msgToAck.type === 'user') {
              yield {
                type: 'user',
                message: msgToAck.message,
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: msgToAck.uuid,
                timestamp: msgToAck.timestamp,
                isReplay: true,
              } as SDKUserMessageReplay
            }
          }
        }
      }

      if (message.type === 'user') {
        turnCount++
      }

      // 用户消息计数器递增
      if (message.type === 'user') {
        turnCount++
      }

      // 根据消息类型分别处理
      switch (message.type) {
        case 'tombstone':
          // 墓碑消息是用于删除消息的控制信号，直接跳过
          break
        case 'assistant':
          // 捕获已设置的 stop_reason（用于合成消息）。
          // 流式响应中，在 content_block_stop 时为 null；
          // 实际值通过 message_delta 到达（在下方处理）。
          if (message.message.stop_reason != null) {
            lastStopReason = message.message.stop_reason
          }
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
        case 'progress':
          this.mutableMessages.push(message)
          /**
           * 内联记录，使得下一次 ask() 调用中的去重循环能将其视为已记录。
           * 否则，延迟的进度消息会与已记录的工具结果交错排列，
           * 去重遍历会在错误的消息处冻结 startingParentUuid —
           * 导致链分叉，恢复时对话被孤立。
           */
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }
          yield* normalizeMessage(message)
          break
        case 'user':
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
        case 'stream_event':
          // message_start：重置当前消息的用量统计
          if (message.event.type === 'message_start') {
            currentMessageUsage = EMPTY_USAGE
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              message.event.message.usage,
            )
          }
          // message_delta：累加用量并捕获 stop_reason
          if (message.event.type === 'message_delta') {
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              message.event.usage,
            )
            /**
             * 从 message_delta 捕获 stop_reason。
             * 助手消息在 content_block_stop 时以 stop_reason=null 生成；
             * 实际值仅在此处到达（参见 claude.ts 的 message_delta 处理器）。
             * 没有这个，result.stop_reason 始终为 null。
             */
            if (message.event.delta.stop_reason != null) {
              lastStopReason = message.event.delta.stop_reason
            }
          }
          // message_stop：将当前消息用量累加到总用量
          if (message.event.type === 'message_stop') {
            this.totalUsage = accumulateUsage(
              this.totalUsage,
              currentMessageUsage,
            )
          }

          // 如果配置了包含部分消息，则向 SDK 生成流事件
          if (includePartialMessages) {
            yield {
              type: 'stream_event' as const,
              event: message.event,
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: randomUUID(),
            }
          }

          break
        case 'attachment':
          this.mutableMessages.push(message)
          // 内联记录（与上方 progress 原因相同）
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }

          // 从 StructuredOutput 工具调用中提取结构化输出
          if (message.attachment.type === 'structured_output') {
            structuredOutputFromTool = message.attachment.data
          }
          // 处理 query.ts 发出的"已达最大轮次"信号
          else if (message.attachment.type === 'max_turns_reached') {
            if (persistSession) {
              if (
                isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
                isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
              ) {
                await flushSessionStorage()
              }
            }
            yield {
              type: 'result',
              subtype: 'error_max_turns',
              duration_ms: Date.now() - startTime,
              duration_api_ms: getTotalAPIDuration(),
              is_error: true,
              num_turns: message.attachment.turnCount,
              stop_reason: lastStopReason,
              session_id: getSessionId(),
              total_cost_usd: getTotalCost(),
              usage: this.totalUsage,
              modelUsage: getModelUsage(),
              permission_denials: this.permissionDenials,
              fast_mode_state: getFastModeState(
                mainLoopModel,
                initialAppState.fastMode,
              ),
              uuid: randomUUID(),
              errors: [
                `Reached maximum number of turns (${message.attachment.maxTurns})`,
              ],
            }
            return
          }
          // 将队列命令附件作为 SDK 用户消息回放生成
          else if (
            replayUserMessages &&
            message.attachment.type === 'queued_command'
          ) {
            yield {
              type: 'user',
              message: {
                role: 'user' as const,
                content: message.attachment.prompt,
              },
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: message.attachment.source_uuid || message.uuid,
              timestamp: message.timestamp,
              isReplay: true,
            } as SDKUserMessageReplay
          }
          break
        case 'stream_request_start':
          // 不生成流请求开始消息
          break
        case 'system': {
          /**
           * Snip 边界：在存储上重放以移除僵尸消息和过期标记。
           * 生成的边界是信号而非要推送的数据——重放会产生自己的等效边界。
           * 没有这个，标记会持续存在并在每轮重新触发，mutableMessages 永远不会缩小
           * （长时间 SDK 会话中的内存泄漏）。
           * 子类型检查位于注入的回调内，因此特性开关字符串不会出现在此文件中
           * （排除字符串检查）。
           */
          const snipResult = this.config.snipReplay?.(
            message,
            this.mutableMessages,
          )
          if (snipResult !== undefined) {
            if (snipResult.executed) {
              this.mutableMessages.length = 0
              this.mutableMessages.push(...snipResult.messages)
            }
            break
          }
          this.mutableMessages.push(message)
          // 向 SDK 生成压缩边界消息
          if (
            message.subtype === 'compact_boundary' &&
            message.compactMetadata
          ) {
            /**
             * 释放压缩前的消息以便垃圾回收。边界消息刚被推入，因此是最后一个元素。
             * query.ts 内部已使用 getMessagesAfterCompactBoundary()，
             * 因此后续只需要边界后的消息。
             */
            const mutableBoundaryIdx = this.mutableMessages.length - 1
            if (mutableBoundaryIdx > 0) {
              this.mutableMessages.splice(0, mutableBoundaryIdx)
            }
            const localBoundaryIdx = messages.length - 1
            if (localBoundaryIdx > 0) {
              messages.splice(0, localBoundaryIdx)
            }

            yield {
              type: 'system',
              subtype: 'compact_boundary' as const,
              session_id: getSessionId(),
              uuid: message.uuid,
              compact_metadata: toSDKCompactMetadata(message.compactMetadata),
            }
          }
          // API 错误重试信息
          if (message.subtype === 'api_error') {
            yield {
              type: 'system',
              subtype: 'api_retry' as const,
              attempt: message.retryAttempt,
              max_retries: message.maxRetries,
              retry_delay_ms: message.retryInMs,
              error_status: message.error.status ?? null,
              error: categorizeRetryableAPIError(message.error),
              session_id: getSessionId(),
              uuid: message.uuid,
            }
          }
          // 无头模式下不生成其他系统消息
          break
        }
        case 'tool_use_summary':
          // 向 SDK 生成工具使用摘要消息
          yield {
            type: 'tool_use_summary' as const,
            summary: message.summary,
            preceding_tool_use_ids: message.precedingToolUseIds,
            session_id: getSessionId(),
            uuid: message.uuid,
          }
          break
      }

      // 检查是否超出了美元预算上限
      if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
        if (persistSession) {
          if (
            isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
            isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
          ) {
            await flushSessionStorage()
          }
        }
        yield {
          type: 'result',
          subtype: 'error_max_budget_usd',
          duration_ms: Date.now() - startTime,
          duration_api_ms: getTotalAPIDuration(),
          is_error: true,
          num_turns: turnCount,
          stop_reason: lastStopReason,
          session_id: getSessionId(),
          total_cost_usd: getTotalCost(),
          usage: this.totalUsage,
          modelUsage: getModelUsage(),
          permission_denials: this.permissionDenials,
          fast_mode_state: getFastModeState(
            mainLoopModel,
            initialAppState.fastMode,
          ),
          uuid: randomUUID(),
          errors: [`已达到最大预算 ($${maxBudgetUsd})`],
        }
        return
      }

      // 检查结构化输出重试次数是否超出限制（仅在用户消息上检查）
      if (message.type === 'user' && jsonSchema) {
        const currentCalls = countToolCalls(
          this.mutableMessages,
          SYNTHETIC_OUTPUT_TOOL_NAME,
        )
        const callsThisQuery = currentCalls - initialStructuredOutputCalls
        const maxRetries = parseInt(
          process.env.MAX_STRUCTURED_OUTPUT_RETRIES || '5',
          10,
        )
        if (callsThisQuery >= maxRetries) {
          if (persistSession) {
            if (
              isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
              isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
            ) {
              await flushSessionStorage()
            }
          }
          yield {
            type: 'result',
            subtype: 'error_max_structured_output_retries',
            duration_ms: Date.now() - startTime,
            duration_api_ms: getTotalAPIDuration(),
            is_error: true,
            num_turns: turnCount,
            stop_reason: lastStopReason,
            session_id: getSessionId(),
            total_cost_usd: getTotalCost(),
            usage: this.totalUsage,
            modelUsage: getModelUsage(),
            permission_denials: this.permissionDenials,
            fast_mode_state: getFastModeState(
              mainLoopModel,
              initialAppState.fastMode,
            ),
            uuid: randomUUID(),
            errors: [
              `经过 ${maxRetries} 次尝试后仍未能提供有效的结构化输出`,
            ],
          }
          return
        }
      }
    }

    /**
     * Stop 钩子在助手响应之后生成进度/附件消息（通过 query.ts 中的 yield* handleStopHooks）。
     * 自 #23537 起这些消息被内联推入 `messages`，因此 last(messages) 可能是进度/附件消息
     * 而非助手消息——这会导致下面的 textResult 提取返回 ''，-p 模式输出空行。
     * 白名单限定为 assistant|user：isResultSuccessful 处理两者
     * （包含全部 tool_result 块的 user 消息是有效的成功终止状态）。
     */
    const result = messages.findLast(
      m => m.type === 'assistant' || m.type === 'user',
    )
    /**
     * 为 error_during_execution 诊断捕获类型信息。
     * isResultSuccessful 是类型谓词（message is Message），
     * 因此在 false 分支中 `result` 收窄为 never，这些访问无法通过类型检查。
     */
    const edeResultType = result?.type ?? 'undefined'
    const edeLastContentType =
      result?.type === 'assistant'
        ? (last(result.message.content)?.type ?? 'none')
        : 'n/a'

    /**
     * 在生成结果消息之前刷新缓冲的会话记录写入。
     * 桌面应用在收到结果消息后立即终止 CLI 进程，
     * 因此任何未刷新的写入都将丢失。
     */
    if (persistSession) {
      if (
        isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
        isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
      ) {
        await flushSessionStorage()
      }
    }

    if (!isResultSuccessful(result, lastStopReason)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        is_error: true,
        num_turns: turnCount,
        stop_reason: lastStopReason,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
        /**
         * 诊断前缀：这些是 isResultSuccessful() 检查的内容——
         * 如果结果类型不是 assistant-with-text/thinking 或 user-with-tool_result，
         * 且 stop_reason 不是 end_turn，这就是触发原因。
         * errors[] 通过水印限定在轮次范围内；之前它会转储整个进程的
         * logError 缓冲区（ripgrep 超时、ENOENT 等）。
         */
        errors: (() => {
          const all = getInMemoryErrors()
          const start = errorLogWatermark
            ? all.lastIndexOf(errorLogWatermark) + 1
            : 0
          return [
            `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${lastStopReason}`,
            ...all.slice(start).map(_ => _.error),
          ]
        })(),
      }
      return
    }

    // 根据消息类型提取文本结果
    let textResult = ''
    let isApiError = false

    if (result.type === 'assistant') {
      const lastContent = last(result.message.content)
      // 排除合成消息（如工具调用摘要）并提取用户可读的文本
      if (
        lastContent?.type === 'text' &&
        !SYNTHETIC_MESSAGES.has(lastContent.text)
      ) {
        textResult = lastContent.text
      }
      isApiError = Boolean(result.isApiErrorMessage)
    }

    // 生成最终的成功结果
    yield {
      type: 'result',
      subtype: 'success',
      is_error: isApiError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: getTotalAPIDuration(),
      num_turns: turnCount,
      result: textResult,
      stop_reason: lastStopReason,
      session_id: getSessionId(),
      total_cost_usd: getTotalCost(),
      usage: this.totalUsage,
      modelUsage: getModelUsage(),
      permission_denials: this.permissionDenials,
      structured_output: structuredOutputFromTool,
      fast_mode_state: getFastModeState(
        mainLoopModel,
        initialAppState.fastMode,
      ),
      uuid: randomUUID(),
    }
  }

  /** 中断当前查询 */
  interrupt(): void {
    this.abortController.abort()
  }

  /** 获取当前会话的消息列表（只读） */
  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  /** 获取文件状态缓存 */
  getReadFileState(): FileStateCache {
    return this.readFileState
  }

  /** 获取当前会话 ID */
  getSessionId(): string {
    return getSessionId()
  }

  /** 设置要使用的模型 */
  setModel(model: string): void {
    this.config.userSpecifiedModel = model
  }
}

/**
 * 向 Claude API 发送单条提示词并返回响应。
 * 假设 Claude 以非交互方式使用——不会向用户询问权限或进一步输入。
 *
 * 基于 QueryEngine 的一次性使用便捷封装。
 */
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  orphanedPermission,
}: {
  /** 可用斜杠命令列表 */
  commands: Command[]
  /** 用户输入提示词 */
  prompt: string | Array<ContentBlockParam>
  /** 提示词 UUID（用于消息追踪） */
  promptUuid?: string
  /** 是否为元消息（如系统内部消息） */
  isMeta?: boolean
  /** 当前工作目录 */
  cwd: string
  /** 可用工具集合 */
  tools: Tools
  /** 是否输出详细信息 */
  verbose?: boolean
  /** MCP 客户端连接列表 */
  mcpClients: MCPServerConnection[]
  /** 思考配置 */
  thinkingConfig?: ThinkingConfig
  /** 最大对话轮次 */
  maxTurns?: number
  /** 最大预算（美元） */
  maxBudgetUsd?: number
  /** 任务预算限制 */
  taskBudget?: { total: number }
  /** 检查工具是否可用 */
  canUseTool: CanUseToolFn
  /** 可变的现有消息列表（用于恢复对话） */
  mutableMessages?: Message[]
  /** 自定义系统提示词（覆盖默认） */
  customSystemPrompt?: string
  /** 追加到系统提示词末尾 */
  appendSystemPrompt?: string
  /** 用户指定的模型名称 */
  userSpecifiedModel?: string
  /** 降级备用模型 */
  fallbackModel?: string
  /** JSON Schema（用于结构化输出模式） */
  jsonSchema?: Record<string, unknown>
  /** 获取应用状态 */
  getAppState: () => AppState
  /** 更新应用状态 */
  setAppState: (f: (prev: AppState) => AppState) => void
  /** 获取文件读取缓存 */
  getReadFileCache: () => FileStateCache
  /** 设置文件读取缓存 */
  setReadFileCache: (cache: FileStateCache) => void
  /** 外部中止控制器 */
  abortController?: AbortController
  /** 是否回放用户消息 */
  replayUserMessages?: boolean
  /** 是否包含部分消息（流事件） */
  includePartialMessages?: boolean
  /** MCP 工具 -32042 错误引发的 URL 诱导处理器 */
  handleElicitation?: ToolUseContext['handleElicitation']
  /** 可用代理定义列表 */
  agents?: AgentDefinition[]
  /** 设置 SDK 状态的回调 */
  setSDKStatus?: (status: SDKStatus) => void
  /** 待处理的孤悬权限 */
  orphanedPermission?: OrphanedPermission
}): AsyncGenerator<SDKMessage, void, unknown> {
  // 创建 QueryEngine 实例，克隆文件缓存以避免共享可变状态
  const engine = new QueryEngine({
    cwd,
    tools,
    commands,
    mcpClients,
    agents,
    canUseTool,
    getAppState,
    setAppState,
    initialMessages: mutableMessages,
    readFileCache: cloneFileStateCache(getReadFileCache()),
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    abortController,
    orphanedPermission,
    // 如果启用了 HISTORY_SNIP 功能，注入 snip 重放处理器
    ...(feature('HISTORY_SNIP')
      ? {
          snipReplay: (yielded: Message, store: Message[]) => {
            if (!snipProjection!.isSnipBoundaryMessage(yielded))
              return undefined
            return snipModule!.snipCompactIfNeeded(store, { force: true })
          },
        }
      : {}),
  })

  try {
    // 代理到引擎的 submitMessage 方法
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
    })
  } finally {
    // 无论成功还是异常，确保将更新后的文件状态缓存写回
    setReadFileCache(engine.getReadFileState())
  }
}
