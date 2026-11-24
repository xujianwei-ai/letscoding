/**
 * Shared wire protocol for the DeepSeek Harness SDK runtime: the
 * newline-delimited JSON-RPC stdio transport plus the named request, result,
 * and notification types both wire ends speak. The runtime server plugin
 * (`@deepseek-ai/dsh-sdk-jsonrpc-server`) serves this protocol; SDK clients
 * (`@deepseek-ai/dsh-sdk-client`, the Python SDK) drive it.
 *
 * @module @deepseek-ai/dsh-sdk-protocol
 */

export { JsonRpcLineTransport, JsonRpcResponseError } from './transport.ts'
export type { JsonRpcTransportPeer } from './transport.ts'
export type {
  ApprovalRequestParams,
  ApprovalRequestResult,
  CommandExecution,
  HarnessSdkClientRequestMap,
  HarnessSdkNotificationMap,
  HarnessSdkRequestMap,
  HarnessSdkHostRequestMap,
  InitializeParams,
  ModelsDeleteProviderParams,
  ModelsProviderConfig,
  ModelsProviderConfigParams,
  ModelsDiscoverParams,
  ModelsSaveProviderParams,
  ModelsSaveProviderResult,
  ModelsTestParams,
  LlmModelTestResult,
  InitializeResult,
  SdkEncodedImageBlock,
  SdkPromptContentBlock,
  SdkRunStatus,
  SdkModelCatalog,
  SdkModelInfo,
  SdkModelProviderFailure,
  SdkModelProviderGroup,
  SdkUserQuestionRequest,
  SdkUserQuestionAnswer,
  SdkUserQuestionResult,
  SdkUserQuestionCancelled,
  SdkSessionSummary,
  SessionEventNotification,
  SessionHistoryParams,
  SessionHistoryResult,
  SessionListParams,
  SessionListResult,
  SessionQueryParams,
  SessionQueryResult,
  SessionStatusNotification,
  SessionPromptParams,
  SessionPromptResult,
  SessionCancelParams,
  SessionCancelResult,
  SessionResumeParams,
  SessionRewindParams,
  SessionSelectModelParams,
  SessionWaitParams,
  SessionWorkingDirectoryParams,
  SessionWorkingDirectorySetParams,
  SessionWorkingDirectoryResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from './types.ts'
