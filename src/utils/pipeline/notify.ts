import type { RunState } from './types.js';

/**
 * Slack and Microsoft Teams messages for pipeline runs (finished, failed, waiting for an
 * approval). Webhook URLs come from environment variables only, never from the pipeline file:
 * `notify: { slack: SLACK_WEBHOOK_URL, teams: TEAMS_WEBHOOK_URL, on: [failed, passed], dashboard: <url> }`
 * where slack / teams name the variables (Teams: a "Workflows" webhook, adaptive card).
 */

export const NOTIFY_EVENTS = ['passed', 'failed', 'canceled', 'awaiting-approval'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export type NotifyConfig = {
  slack?: string;
  teams?: string;
  on?: NotifyEvent[];
  dashboard?: string;
};

const ICON: Record<NotifyEvent, string> = {
  passed: '✅',
  failed: '❌',
  canceled: '⛔',
  'awaiting-approval': '⏸',
};

export function validateNotify(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object') return ['"notify" must be a map.'];
  const n = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ['slack', 'teams'] as const) {
    const name = n[key];
    if (name !== undefined && (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(name))) {
      errors.push(`"notify.${key}" must be the NAME of an environment variable holding the webhook URL.`);
    }
  }
  if (
    n.on !== undefined &&
    (!Array.isArray(n.on) || (n.on as unknown[]).some((e) => !(NOTIFY_EVENTS as readonly unknown[]).includes(e)))
  ) {
    errors.push(`"notify.on" must be a list of ${NOTIFY_EVENTS.join(', ')}.`);
  }
  return errors;
}

export function runUrl(config: NotifyConfig, run: RunState): string | undefined {
  return config.dashboard ? `${config.dashboard.replace(/\/$/, '')}/#run=${encodeURIComponent(run.id)}` : undefined;
}

export function messageText(event: NotifyEvent, pipeline: string, run: RunState, detail?: string): string {
  const what = {
    passed: 'passed',
    failed: 'failed',
    canceled: 'was canceled',
    'awaiting-approval': `is waiting for approval${detail ? `: ${detail}` : ''}`,
  }[event];
  const failedStage = run.stages.find((s) => s.status === 'failed');
  const extra =
    event === 'failed' && failedStage
      ? ` at "${failedStage.name}"${failedStage.error ? ` (${failedStage.error})` : ''}`
      : '';
  const where = [run.release && `release ${run.release}`, run.branch && `branch ${run.branch}`]
    .filter(Boolean)
    .join(' · ');
  return `${ICON[event]} ${pipeline} ${what}${extra}${where ? ` — ${where}` : ''} · run ${run.id}`;
}

export function slackPayload(text: string, url?: string): Record<string, unknown> {
  return { text: url ? `${text}\n<${url}|Open the run>` : text };
}

/** Teams Workflows webhooks take an adaptive card in a message attachment. */
export function teamsPayload(text: string, url?: string): Record<string, unknown> {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [{ type: 'TextBlock', text, wrap: true }],
          ...(url ? { actions: [{ type: 'Action.OpenUrl', title: 'Open the run', url }] } : {}),
        },
      },
    ],
  };
}

/** Sends the message to every configured channel; failures are reported, never thrown. */
export async function notify(
  config: NotifyConfig | undefined,
  event: NotifyEvent,
  pipeline: string,
  run: RunState,
  log: (message: string) => void,
  detail?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!config || !(config.on ?? ['failed', 'awaiting-approval']).includes(event)) return;
  const text = messageText(event, pipeline, run, detail);
  const url = runUrl(config, run);
  const targets: Array<[string, string | undefined, Record<string, unknown>]> = [
    ['Slack', config.slack && env[config.slack], slackPayload(text, url)],
    ['Teams', config.teams && env[config.teams], teamsPayload(text, url)],
  ];
  await Promise.all(
    targets
      .filter(([, webhook]) => webhook)
      .map(async ([name, webhook, body]) => {
        try {
          const res = await fetch(webhook!, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) log(`⚠ ${name} notification failed: HTTP ${res.status}`);
        } catch (error) {
          log(`⚠ ${name} notification failed: ${(error as Error).message}`);
        }
      })
  );
}
