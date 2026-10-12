/**
 * Types shared by the pipeline runner, the run store and the dashboard.
 */

export const STAGE_USES = [
  'build',
  'quality',
  'deploy',
  'check-duplicates',
  'script',
  'shell',
  'approval',
  'tag',
  'ai-runbook',
] as const;
export type StageUses = (typeof STAGE_USES)[number];

/** When a stage runs, based on the outcome of the stages before it. */
export type StageCondition = 'success' | 'failure' | 'always';

/** What triggered the run: a pull request, a push to the branch, or a manual run. */
export const PIPELINE_EVENTS = ['pr', 'push', 'manual'] as const;
export type PipelineEvent = (typeof PIPELINE_EVENTS)[number];

export type StageConfig = {
  id: string;
  name?: string;
  description?: string;
  uses: StageUses;
  /** Flags passed to fm commands (build/quality/deploy/check-duplicates). */
  with?: Record<string, unknown>;
  /** Script path (uses: script) or command line (uses: shell). */
  run?: string;
  env?: Record<string, string>;
  if?: StageCondition;
  /** Only run for these events (default: every event). */
  on?: PipelineEvent[];
  /** Run only when this value (or every value in the list) is truthy, e.g. ${stages.build.result.wavesById.data-cloud.hasChanges}. */
  when?: unknown;
  'continue-on-error'?: boolean;
  /** Ask for confirmation before running this stage. */
  manual?: boolean;
  'timeout-minutes'?: number;
};

export type PipelineConfig = {
  name: string;
  release?: string;
  env?: Record<string, string>;
  stages: StageConfig[];
};

export type StageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'warning' | 'skipped' | 'awaiting-approval';

export type RunStatus = 'running' | 'passed' | 'failed' | 'paused' | 'awaiting-approval' | 'canceled';

export type Metric = { label: string; value: string | number; tone?: 'good' | 'bad' | 'warn' | 'neutral' };

export type StageState = {
  id: string;
  name: string;
  uses: StageUses;
  description?: string;
  status: StageStatus;
  manual: boolean;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  metrics?: Metric[];
  /** Command result (trimmed) used for ${stages.<id>.result.*} and the dashboard. */
  result?: unknown;
  approvedBy?: string;
  /** Why the stage was skipped. */
  skipReason?: string;
  /** An action inside the stage (e.g. an AI runbook step) waiting for approval. */
  pendingAction?: { key: string; kind: string; title: string; detail: string };
  /** Target org of build/deploy/script stages, shown on the release overview. */
  targetOrg?: string;
  /** Mode of deploy stages (validation, deployment, quick). */
  deployMode?: string;
};

export type RunState = {
  id: string;
  pipeline: string;
  release: string;
  configPath: string;
  branch: string;
  commit: string;
  commitMessage?: string;
  author?: string;
  ciUrl?: string;
  trigger: 'local' | 'ci' | 'dashboard';
  event: PipelineEvent;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  stages: StageState[];
};

export type ApprovalDecision = { decision: 'approve' | 'reject'; by: string; at: string };

/** Written by the dashboard / `sf fm pipeline approve`, read by the runner. */
export type RunControl = {
  approvals: Record<string, ApprovalDecision>;
  cancel?: { by: string; at: string };
};
