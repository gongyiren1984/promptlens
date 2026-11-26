/**
 * PromptLens v1 契约类型：与 schemas/*.json 及本地 API 对齐。
 * 枚举以字符串字面量为准，UI 不手写业务枚举（新增值需同步 schema 与生成物）。
 */

export type ApiVersion = 'v1';

export interface Warning {
  code: string;
  message: string;
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  scope: string;
  details?: unknown;
  remediation?: string;
}

export interface EnvelopeMeta {
  serverVersion: string;
  completedAt: string;
  traceId?: string;
  durationMs?: number;
}

export interface Envelope<T> {
  apiVersion: ApiVersion;
  requestId: string;
  ok: boolean;
  data?: T;
  warnings: Warning[];
  error: ApiError | null;
  meta: EnvelopeMeta;
}

export interface Capabilities {
  product: string;
  apiVersion: ApiVersion;
  serverVersion: string;
  transport: { type: 'loopback'; host: string; port: number };
  workspace: string;
  mcp: { defaultProtocolVersion: string; supportedProtocolVersions: string[]; transports: string[] };
  limits: {
    maxVariants: number;
    maxModels: number;
    maxRepetitions: number;
    maxAttempts: number;
    maxConcurrency: number;
    maxFallbacksPerModel: number;
    maxBodyBytes: number;
    maxPageSize: number;
    maxReportMarkdownBytes: number;
  };
  errorCodes: Array<{ code: string; retryable: boolean; exitCode: number; scope: string; message: string }>;
  routes: string[];
  report: { requiredSections: string[] };
  features: { sse: boolean; drafts: boolean; importPreview: boolean; analytics: string };
  time: string;
}

/* ---------------- 项目 ---------------- */

export interface ProjectCounts {
  prompts: number;
  promptVersions: number;
  cases: number;
  testSets: number;
  models: number;
  runs: number;
  reports: number;
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  root: string;
  createdAt: string;
  archivedAt?: string | null;
  schema: string;
  counts: ProjectCounts;
  lastOpenedAt?: string | null;
  source?: 'recent' | 'workspace';
  created?: boolean;
}

export interface ProjectSettings {
  autoReport: boolean;
  autoExport: boolean;
  sensitiveFields: string[];
}

export interface ProjectBackupResult {
  schema: string;
  projectId: string;
  name: string;
  projectCreatedAt: string;
  backupAt: string;
  appVersion: string;
  databaseHash: string | null;
  counts: ProjectCounts;
  files: number;
  bytes: number;
  path: string;
}

export interface ProjectDeleteResult {
  projectId: string;
  name: string;
  path: string;
  permanent: boolean;
  recoverable: boolean;
  trashedAt?: string;
}

export interface TrashEntry {
  projectId: string;
  name: string;
  originalPath: string;
  trashedAt: string;
  trashPath: string;
}

export interface RecoveryObjects {
  database: 'readable' | 'missing' | 'unreadable';
  error: string | null;
  counts: ProjectCounts | null;
  prompts: Array<{ id: string; name: string; versions: number }>;
  testSets: Array<{ id: string; name: string }>;
  runs: Array<{ id: string; status: string; snapshot_hash: string }>;
  reports: Array<{ id: string; run_id: string; status: string }>;
}

export interface ProjectRecoveryResult {
  schema: 'promptlens.recovery/v1';
  projectId: string;
  name: string;
  sourcePath: string;
  recoveryAt: string;
  appVersion: string;
  readonly: true;
  databaseStatus: RecoveryObjects['database'];
  objects: RecoveryObjects;
  files: number;
  bytes: number;
  path: string;
  manifestPath: string;
}

export type CheckStatus = 'ok' | 'degraded' | 'error';

export interface HealthCheck {
  name: string;
  status: CheckStatus;
  [key: string]: unknown;
}

export interface ProjectHealth {
  projectId: string;
  name: string;
  root: string;
  status: CheckStatus;
  checks: HealthCheck[];
  counts: ProjectCounts;
  schemaVersion: string | null;
}

export interface ProjectOverview {
  summary: ProjectSummary;
  health: ProjectHealth;
  recentRuns: RunSummary[];
  runTotal: number;
  recentReports: ReportRecord[];
  analytics: AnalyticsTotals;
  lastRunAt: string | null;
}

export interface ProjectListResult {
  root: string;
  home: string;
  projects: ProjectSummary[];
}

/* ---------------- 提示词 ---------------- */

export interface PromptVersionSummary {
  versionId: string;
  versionNumber: number;
  contentHash: string;
  variables: string[];
  createdAt: string;
}

export interface PromptVariant {
  variantId: string;
  label: string;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  versions: PromptVersionSummary[];
}

export interface Prompt {
  promptId: string;
  name: string;
  description: string | null;
  createdAt: string;
  variants: PromptVariant[];
}

export interface PromptVersionDetail {
  versionId: string;
  promptId: string;
  promptName: string;
  variantId: string;
  label: string;
  versionNumber: number;
  content: string;
  variables: string[];
  contentHash: string;
  createdAt: string;
}

export interface PromptVersionRestoreResult {
  promptId: string;
  promptName: string;
  variantId: string;
  label: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  restoredFromVersionId: string;
  created: boolean;
}

export interface PromptDiffLine {
  type: 'equal' | 'add' | 'remove';
  line: string;
  leftLine?: number;
  rightLine?: number;
}

export interface PromptDiff {
  left: { versionId: string; label: string; versionNumber: number; contentHash: string };
  right: { versionId: string; label: string; versionNumber: number; contentHash: string };
  identical: boolean;
  lines: PromptDiffLine[];
}

export interface PromptSuggestionEvidence {
  trialId?: string;
  casePreview: string;
  score: number | null;
  outputPreview: string;
}

export type PromptSuggestionStatus = 'generated' | 'accepted' | 'dismissed';

export interface PromptSuggestionContext {
  runId: string;
  base: { versionId: string; label: string; versionNumber: number; promptName: string; contentHash: string };
  evaluation: { profileVersionId: string; name: string; scale?: EvaluationScale | null };
  generator: { modelConfigVersionId: string; name: string; providerType: string; pricing: Pricing | null };
  summary: PromptSuggestionResult['summary'];
  evidenceCount: number;
  lowDimensions: Array<{ id: string; name: string; mean: number | null }>;
  maxSuggestions: { requested: number; limit: number; default: number };
  cost: { amount: string | null; currency: string | null; completeness: string; note?: string };
  note: string;
}

export interface PromptSuggestion {
  priority: 'high' | 'medium' | 'low';
  dimension: string | null;
  dimensionName: string | null;
  issue: string;
  suggestion: string;
  expectedImpact: string | null;
  evidence: PromptSuggestionEvidence[];
}

export interface PromptSuggestionResult {
  suggestionId: string;
  runId: string;
  promptVersionId: string;
  base: {
    versionId: string;
    promptId: string;
    promptName: string;
    label: string;
    versionNumber: number;
    contentHash: string;
  };
  evaluation: { profileVersionId: string; name: string; scale?: EvaluationScale | null };
  promptUnchanged: true;
  status: PromptSuggestionStatus;
  summary: {
    trialCount: number;
    meanScore: number | null;
    dimensions: Array<{ id: string; name: string; mean: number | null; failedRules: Array<{ type: string; value: unknown; count: number }> }>;
  };
  suggestions: PromptSuggestion[];
  generator: { modelConfigVersionId: string; name: string; providerType: string; focus: string; generatedAt: string; latencyMs: number };
  cost: { amount: string | null; currency: string | null; billingState?: string };
  usage: Record<string, unknown> | null;
  contentHash: string;
  createdAt: string;
}

export interface PromptSuggestionSummary {
  suggestionId: string;
  runId: string;
  promptVersionId: string;
  modelConfigVersionId: string;
  status: PromptSuggestionStatus;
  contentHash: string;
  suggestionCount: number;
  createdAt: string;
}

export interface PromptIterationVerification {
  round?: number;
  status?: string;
  verificationStatus?: string;
  candidateVersionId?: string;
  candidateLabel?: string;
  runId: string | null;
  reportId: string | null;
  detached?: boolean;
}

export interface PromptIterationContext {
  runId: string;
  base: { versionId: string; label: string; versionNumber: number; promptName: string; contentHash: string };
  generator: { modelConfigVersionId: string; name: string; providerType: string; pricing: Pricing | null };
  rounds: { requested: number; max: number };
  evidence: {
    variants: Array<{ versionId: string; label: string; meanScore: number | null; trials: number }>;
    lowScores: Array<{ variantLabel: string; score: number | null; input: unknown; output: unknown }>;
  };
  cost: { amount: string | null; currency: string | null; completeness: string; rounds: number; note?: string };
  verification: { requiresSave: boolean; inlineSupported: boolean; note: string };
}

export interface PromptIterationResult {
  runId: string;
  base: {
    versionId: string;
    promptId: string;
    promptName: string;
    label: string;
    versionNumber: number;
    content: string;
    contentHash: string;
  };
  proposal: {
    content: string;
    rationale: string | null;
    label: string;
    created: boolean;
    versionId: string | null;
    versionNumber: number | null;
  };
  rounds?: Array<{
    round: number;
    content: string;
    rationale: string | null;
    label: string;
    diff: { identical: boolean; lines: PromptDiffLine[] };
    saved: { versionId: string; label: string; versionNumber: number; created: boolean } | null;
    verification: PromptIterationVerification;
  }>;
  verification?: PromptIterationVerification[];
  diff: { identical: boolean; lines: PromptDiffLine[] };
  evidence: {
    variants: Array<{ versionId: string; label: string; meanScore: number | null; trials: number }>;
    lowScores: Array<{ variantLabel: string; score: number | null; input: unknown; output: unknown }>;
  };
  generator: {
    modelConfigVersionId: string;
    name: string;
    providerType: string;
    instruction: string;
    rounds?: number;
    generatedAt: string;
    latencyMs: number;
  };
  cost: { amount: string | null; currency: string | null; billingState?: string };
  usage: Record<string, number> | null;
  saved: { versionId: string; label: string; versionNumber: number; created: boolean } | null;
}

/* ---------------- 用例 ---------------- */

export interface CaseRecord {
  caseVersionId: string;
  contentHash: string;
  input: unknown;
  expected: unknown;
  meta: Record<string, unknown> | null;
}

export interface CasePage {
  total: number;
  limit: number;
  offset: number;
  cases: CaseRecord[];
}

export interface ImportPreview {
  previewId: string;
  format: 'csv' | 'json' | 'jsonl';
  setName: string | null;
  totalRecords: number;
  validRecords: number;
  errorCount: number;
  errors: Array<{ row: number; message: string }>;
  duplicateRecords: number;
  columns: string[];
  sample: Array<{ input: unknown; expected: unknown; meta: Record<string, unknown> | null }>;
  expiresAt: string;
}

export interface ImportCommitResult {
  previewId: string;
  batchId?: string;
  testSetId?: string;
  testSetName: string;
  testSetVersionId?: string;
  contentHash?: string;
  imported?: number;
  duplicates?: number;
  caseCount?: number;
  newVersion?: boolean;
  duplicatePolicy?: string;
  skippedAll?: boolean;
}

export interface TestSetVersionSummary {
  testSetVersionId: string;
  versionNumber: number;
  contentHash: string;
  caseCount: number;
  createdAt: string;
  origin?: TestSetOrigin | null;
}

export interface TestSet {
  testSetId: string;
  name: string;
  createdAt: string;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  contentHash: string | null;
  caseCount: number;
  versions: TestSetVersionSummary[];
}

export interface TestSetVersion {
  testSetId: string;
  name: string;
  testSetVersionId: string;
  versionNumber: number;
  contentHash: string;
  caseCount: number;
  cases: CaseRecord[];
  createdAt: string;
  origin?: TestSetOrigin | null;
}

export interface LibrarySource {
  projectId: string;
  projectName: string | null;
  testSetId: string;
  testSetVersionId: string;
  testSetVersionNumber: number;
}

export interface LibraryEntrySummary {
  libraryId: string;
  setName: string;
  version: number;
  caseCount: number;
  contentHash: string;
  license: string | null;
  sensitive: boolean;
  createdAt: string;
  source: LibrarySource;
}

export interface LibraryEntryDetail extends LibraryEntrySummary {
  cases: Array<{ input: unknown; expected: unknown; meta: unknown }>;
}

export interface LibraryImportResult {
  testSetId: string;
  testSetName: string;
  testSetVersionId: string;
  versionNumber?: number;
  contentHash: string;
  caseCount: number;
  newVersion: boolean;
  imported: number;
  duplicates: number;
  library: LibraryEntrySummary;
  warnings: Warning[];
}

export interface TestSetOrigin {
  libraryId: string;
  libraryVersion: number;
  sourceProjectId: string | null;
  sourceProjectName: string | null;
  sourceTestSetVersionId: string | null;
  license: string | null;
  sensitive: boolean;
  importedAt: string;
}

/* ---------------- 模型与评分 ---------------- */

export interface Pricing {
  currency: string;
  unit: 'per_million_tokens' | 'per_token' | 'per_request';
  input?: string;
  output?: string;
  cachedInput?: string;
  reasoning?: string;
  perRequest?: string;
}

export interface ModelCapabilities {
  chat: boolean;
  streaming: boolean;
  modelList: boolean;
  maxContextTokens: number | null;
}

export interface ModelConfigVersion {
  modelConfigVersionId: string;
  profileId: string;
  name: string;
  providerType: 'mock' | 'openai_compatible';
  modelId: string;
  baseUrl: string | null;
  credentialRef: string | null;
  params: Record<string, unknown>;
  pricing: Pricing | null;
  versionNumber: number;
  contentHash: string;
  createdAt: string;
  adapterVersion: string;
  capabilities: ModelCapabilities;
}

export interface ModelProfile {
  profileId: string;
  name: string;
  providerType: 'mock' | 'openai_compatible';
  latest: ModelConfigVersion | null;
  versions: ModelConfigVersion[];
}

export interface ModelLibraryEntry {
  id: string;
  name: string;
  providerType: 'mock' | 'openai_compatible';
  modelId: string;
  baseUrl: string | null;
  credentialRef: string | null;
  params: Record<string, unknown>;
  pricing: Pricing | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelLibrary {
  schema: 'promptlens.model-library/v1';
  entries: ModelLibraryEntry[];
}

export interface ModelConnectionTest {
  modelConfigVersionId: string;
  modelId: string;
  ok: boolean;
  latencyMs: number;
  sample: string;
  finishReason: string;
  usage: Record<string, number | null>;
  adapterVersion: string;
  capabilities: ModelCapabilities;
}

export interface ModelProbeResult {
  modelConfigVersionId: string;
  modelId: string;
  latencyMs: number;
  models: Array<{ id: string; ownedBy: string | null; created: number | null }>;
  adapterVersion: string;
  capabilities: ModelCapabilities;
}

export interface EvaluationScale {
  min: number;
  max: number;
  anchors?: Record<string, string>;
}

export interface EvaluationDimension {
  id: string;
  name: string;
  weight: number;
  normalizedWeight?: number;
  gating?: boolean;
  gate?: number;
  description?: string;
  rules?: Array<Record<string, unknown>>;
}

export interface EvaluationProfileSummary {
  profileId: string;
  name: string;
  latestVersionId: string | null;
  latestVersionNumber: number | null;
  contentHash: string | null;
  dimensionCount: number;
  scale?: EvaluationScale | null;
  weightTotal?: number;
  dimensions?: Array<{
    id: string;
    name: string;
    weight: number;
    normalizedWeight: number;
    gating: boolean;
    gate: number | null;
  }>;
  versions: Array<{ profileVersionId: string; versionNumber: number; contentHash: string; createdAt: string }>;
}

export interface EvaluationProfileVersion {
  profileId: string;
  name: string;
  profileVersionId: string;
  versionNumber: number;
  contentHash: string;
  config: {
    schema?: string;
    scale?: EvaluationScale | null;
    dimensions: EvaluationDimension[];
    judge?: { enabled?: boolean; defaultInstructions?: string; promptVersionId?: string } | null;
  };
  scale?: EvaluationScale | null;
  weightTotal?: number;
  normalizedWeights?: Record<string, number>;
  createdAt: string;
}

/* ---------------- 草稿 ---------------- */

export interface DraftPayload {
  name?: string;
  branchVersionIds?: string[];
  testSetVersionId?: string;
  sampleSize?: number | null;
  modelVersionIds?: string[];
  fallbackVersionIds?: string[];
  repetitions?: number;
  maxAttempts?: number;
  maxConcurrency?: number;
  order?: 'sequential' | 'seeded_random';
  evalProfileVersionId?: string;
  judgePromptVersionId?: string | null;
  budget?: { maxRequests?: number; maxTotalTokens?: number; maxDurationSeconds?: number; maxAmount?: { amount: string; currency: string } };
  [key: string]: unknown;
}

export interface ExperimentDraft {
  draftId: string;
  projectId: string;
  name: string | null;
  step: number;
  payload: DraftPayload;
  createdAt: string;
  updatedAt: string;
}

/* ---------------- 运行 ---------------- */

export type RunStatus = 'queued' | 'running' | 'cancel_requested' | 'completed' | 'completed_with_errors' | 'canceled' | 'failed';
export type TrialStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'canceled' | 'aborted_unknown';
export type OutputValidity = 'valid' | 'invalid_empty' | 'invalid_truncated' | 'invalid_format' | 'policy_blocked' | 'not_available';
export type EvaluationStatus = 'not_requested' | 'pending' | 'completed' | 'incomplete' | 'failed';

export interface RunCounts {
  total: number;
  queued: number;
  running: number;
  retrying: number;
  completed: number;
  failed: number;
  canceled: number;
  abortedUnknown: number;
  outputValid: number;
  outputInvalid: number;
  comparisonEligible: number;
  fallbackUsed: number;
}

export interface RunSummary {
  runId: string;
  projectId: string;
  snapshotId: string;
  snapshotHash: string;
  status: RunStatus;
  parentRunId?: string;
  stopReason?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  counts: RunCounts;
  cost?: { amount: string | null; unknownCount: number; complete: boolean };
  meanScore?: number | null;
}

export interface Attempt {
  id: string;
  trialId: string;
  attemptNumber: number;
  status: string;
  startedAt: string;
  finishedAt?: string;
  originalModelConfigVersionId: string;
  actualModelConfigVersionId: string;
  originalModelId: string;
  actualModelId: string;
  fallbackUsed: boolean;
  crossModelSubstitution: boolean;
  billingState: string;
  responseRef?: string;
  normalizedUsage?: Record<string, number | null>;
  error?: { code: string; message: string; retryable?: boolean };
}

export interface DialogueTurn {
  id: string;
  trialId: string;
  round: number;
  role: 'generator' | 'candidate';
  modelConfigVersionId: string;
  modelId: string;
  content: string;
  usage: Record<string, number | null> | null;
  terminationReason: string | null;
  createdAt: string;
}

export interface DialogueConfig {
  maxRounds: number;
  generatorModelConfigVersionId: string;
  generatorPromptVersionId?: string;
  initialInputPolicy: 'case_first' | 'generator_first';
  maxOutputTokensPerTurn?: number | null;
  termination: Array<{ type: 'literal' | 'regex' | 'json_condition'; value: string }>;
}

export interface Trial {
  id: string;
  runId: string;
  variantVersionId: string;
  caseVersionId: string;
  modelConfigVersionId: string;
  repetitionIndex: number;
  idempotencyKey: string;
  trialStatus: TrialStatus;
  outputValidity: OutputValidity;
  evaluationStatus: EvaluationStatus;
  comparisonEligible: boolean;
  ineligibilityReasons: string[];
  truncated: boolean;
  dialogueTurns?: DialogueTurn[];
  attempts: Attempt[];
}

export interface TrialOutput {
  content?: string | null;
  finishReason?: string;
  truncated?: boolean;
  modelConfigVersionId?: string;
  modelId?: string;
  usage?: Record<string, number | null>;
  cost?: { amount: string | null; currency: string | null; billingState: string };
  latencyMs?: number;
  fallbackUsed?: boolean;
  attemptId?: string;
  error?: { code: string; message: string; retryable?: boolean };
  dialogue?: { maxRounds: number; rounds: number; turns: number; terminationReason: string };
}

export interface RunEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface RunDetail {
  run: {
    id: string;
    projectId: string;
    snapshotId: string;
    snapshotHash: string;
    status: RunStatus;
    parentRunId?: string;
    stopReason?: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    updatedAt: string;
  };
  counts: RunCounts;
  trials: Trial[];
  outputs?: Record<string, TrialOutput>;
  events?: RunEvent[];
}

export interface EvaluationRecord {
  evaluationId: string;
  trialId: string;
  status: EvaluationStatus;
  overallScore: number | null;
  scores: {
    dimensions?: Record<string, number | null>;
    details?: Record<string, { rules?: Array<{ rule?: string; passed?: boolean; detail?: string }>; ruleScore?: number | null; judgeScore?: number | null; score?: number | null; scaleScore?: number | null; weight?: number; normalizedWeight?: number | null; gating?: boolean; gate?: number | null }>;
    overall?: number | null;
    gateFailed?: { dimension: string; score: number | null; gate: number } | null;
    skipped?: string;
    outputValidity?: string;
  } | null;
  caseVersionId: string;
  variantVersionId: string;
  modelConfigVersionId: string;
}

export interface RunBundle extends RunDetail {
  trialTotal: number;
  trialLimit: number;
  trialOffset: number;
  labels: {
    variants: Record<string, { label: string; promptName: string; variantLabel: string; versionNumber: number; contentHash: string }>;
    models: Record<string, { name: string; providerType: string; modelId: string; pricing: Pricing | null; isFallback: boolean }>;
    cases: Record<string, { preview: string; input: unknown; expected: unknown; meta: Record<string, unknown> | null }>;
    testSetName: string;
  };
  evaluations: EvaluationRecord[];
  snapshotSummary: {
    hash: string;
    createdAt: string;
    repetitions: number;
    budget: Record<string, unknown>;
    execution: {
      order: string;
      seed: number;
      maxAttempts: number;
      backoffBaseMs: number;
      maxBackoffMs: number;
      maxConcurrency: number;
      dialogue?: {
        maxRounds: number;
        generatorModel: string;
        initialInputPolicy: string;
        maxOutputTokensPerTurn: number | null;
        termination: Array<{ type: string; value: string }>;
        callsPerTrial: number;
      };
    };
    variants: string[];
    models: string[];
    caseCount: number;
    evaluation: { name: string; scale?: EvaluationScale | null; weightTotal?: number; dimensions: EvaluationDimension[] };
  };
}

export interface RunCostSummary {
  amount: string | null;
  currency: string | null;
  complete: boolean;
  byModel: Array<{ name: string; requests: number; amount: string | null; currency: string | null; complete: boolean }>;
  judge?: {
    enabled: boolean;
    model: string | null;
    calls: number;
    amount: string | null;
    currency: string | null;
    complete: boolean;
  };
  averageLatencyMs: number | null;
  latency: {
    count: number;
    averageMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  };
  requestCount: number;
}

export interface PreflightResult {
  snapshotHash: string;
  trialCount: number;
  plan: {
    variants: string[];
    models: string[];
    cases: number;
    repetitions: number;
    trialCount: number;
    maxAttempts: number;
    maxConcurrency: number;
    budget: Record<string, unknown>;
    worstCaseRequests?: number;
    dialogue?: {
      maxRounds: number;
      generatorModel: string;
      initialInputPolicy: string;
      maxOutputTokensPerTurn: number | null;
      termination: Array<{ type: string; value: string }>;
      callsPerTrial: number;
    };
  };
  estimate: { amount: string | null; currency: string | null; completeness: string; plannedRequests: number; note?: string | null };
  warnings: Warning[];
  risks: string[];
  snapshot?: unknown;
}

export interface RunCreateResult {
  runId: string;
  snapshotId: string;
  snapshotHash: string;
  trialCount: number;
  status: RunStatus;
  reused?: boolean;
  detached?: boolean;
  warnings?: Warning[];
  plan?: PreflightResult['plan'];
  estimate?: PreflightResult['estimate'];
  counts?: RunCounts;
  stopReason?: string | null;
}

/* ---------------- 报告 ---------------- */

export interface ReportRecord {
  schema: string;
  reportId: string;
  projectId: string;
  runId: string;
  templateVersionId: string;
  snapshotHash: string;
  evaluationVersionIds: string[];
  format: 'markdown';
  language: string;
  status: string;
  contentHash?: string;
  path?: string;
  generatedAt: string;
  evidenceState?: string;
  redactions?: string[];
  warnings?: Warning[];
  summary?: Record<string, unknown>;
}

export interface ReportDetail {
  report: ReportRecord;
  markdown: string | null;
  projectId?: string;
}

/* ---------------- 分析 ---------------- */

export interface AnalyticsTotals {
  runs: number;
  completed: number;
  withErrors: number;
  canceled: number;
  failed: number;
}

export interface AnalyticsResult {
  runs: RunSummary[];
  failureReasons: Array<{ reason: string; count: number }>;
  totals: AnalyticsTotals;
}

export interface AuditEvent {
  id: string;
  type: string;
  actor: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface AppConfigOnboarding {
  completedAt: string | null;
  version: number;
  skipped: boolean;
}

export interface AppConfigLegal {
  privacyVersion: string | null;
  privacyAcceptedAt: string | null;
  termsVersion: string | null;
  termsAcceptedAt: string | null;
}

export interface AppConfig {
  schema: 'promptlens.app-config/v1';
  defaultProjectRoot: string | null;
  workspaceRoot: string | null;
  onboarding: AppConfigOnboarding;
  legal: AppConfigLegal;
  tour: { completedVersion: number | null };
}

export interface KeychainCredentialResult {
  credentialRef: string;
}

export interface McpLaunchSpec {
  command: string;
  args: string[];
}

export interface McpClientConfig {
  mcpServers: Record<string, McpLaunchSpec>;
}

export interface McpProjectInfo {
  mode: 'server';
  transports: string[];
  defaultProtocolVersion: string;
  supportedProtocolVersions: string[];
  toolCount: number;
  tools: string[];
  scopes: { default: string[]; write: string[] };
  projectRoot: string;
  launch: McpLaunchSpec;
  clientConfig: McpClientConfig;
}

export interface AppConfigPatch {
  defaultProjectRoot?: string | null;
  workspaceRoot?: string | null;
  onboarding?: Partial<AppConfigOnboarding>;
  legal?: Partial<AppConfigLegal>;
  tour?: { completedVersion?: number | null };
}
