import type { SalesforceClient } from './client.js';
import { describeGlobal } from './query.js';

/**
 * Streaming API (CometD / Bayeux long polling) for Platform Events, Change Data Capture and
 * PushTopics. The HTTP part is injected: the extension posts with the browser session and
 * cookies; the local app posts from Node with its own cookie jar (Salesforce pins the
 * session to a server with the BAYEUX_BROWSER cookie).
 */

export type BayeuxMessage = {
  channel: string;
  clientId?: string;
  successful?: boolean;
  error?: string;
  subscription?: string;
  advice?: { reconnect?: 'retry' | 'handshake' | 'none'; interval?: number; timeout?: number };
  data?: { event?: { replayId?: number; createdDate?: string }; payload?: unknown; sobject?: unknown };
  [key: string]: unknown;
};

/** Posts Bayeux messages to /cometd/<version> and returns the answers. */
export type BayeuxPost = (messages: Array<Record<string, unknown>>) => Promise<BayeuxMessage[]>;

export type StreamEvent = {
  channel: string;
  replayId?: number;
  createdDate?: string;
  payload: unknown;
  receivedAt: string;
};

/** -1: only new events; -2: every event still retained (up to 72 hours). */
export type ReplayFrom = -1 | -2 | number;

/** Bayeux over the client's transport (proxy in the app, browser session in the extension). */
export function cometdPost(client: SalesforceClient): BayeuxPost {
  return async (messages) => {
    const version = await client.version();
    const response = await client.raw({
      method: 'POST',
      path: `/cometd/${version}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messages),
    });
    return JSON.parse(response.body) as BayeuxMessage[];
  };
}

export class CometdClient {
  private clientId?: string;
  private stopped = false;

  public constructor(private readonly post: BayeuxPost) {}

  /** Subscribes and calls `onEvent` until stop(); resolves when stopped or the server says no. */
  public async run(
    channel: string,
    replayFrom: ReplayFrom,
    onEvent: (event: StreamEvent) => void,
    onStatus: (status: string) => void = () => undefined
  ): Promise<void> {
    if (!/^\/(event|data|topic|u)\/[\w/]+$/.test(channel)) throw new Error('Unknown channel.');
    this.stopped = false;
    await this.handshake();
    const [subscribed] = await this.post([
      {
        channel: '/meta/subscribe',
        clientId: this.clientId,
        subscription: channel,
        ext: { replay: { [channel]: replayFrom } },
      },
    ]);
    if (!subscribed?.successful) throw new Error(subscribed?.error ?? `Could not subscribe to ${channel}.`);
    onStatus(`Listening on ${channel}`);
    while (!this.stopped) {
      // eslint-disable-next-line no-await-in-loop
      const messages = await this.post([
        { channel: '/meta/connect', clientId: this.clientId, connectionType: 'long-polling' },
      ]);
      for (const message of messages) {
        if (message.channel === '/meta/connect') {
          if (message.successful === false) {
            if (message.advice?.reconnect === 'none') throw new Error(message.error ?? 'The server ended the stream.');
            onStatus('Reconnecting…');
            // eslint-disable-next-line no-await-in-loop
            await this.handshake();
            // eslint-disable-next-line no-await-in-loop
            await this.post([{ channel: '/meta/subscribe', clientId: this.clientId, subscription: channel }]);
          }
        } else if (message.channel === channel || message.channel.startsWith(channel.replace(/\/[^/]*$/, ''))) {
          onEvent({
            channel: message.channel,
            replayId: message.data?.event?.replayId,
            createdDate: message.data?.event?.createdDate,
            payload: message.data?.payload ?? message.data?.sobject ?? message.data,
            receivedAt: new Date().toISOString(),
          });
        }
      }
    }
    await this.post([{ channel: '/meta/disconnect', clientId: this.clientId }]).catch(() => undefined);
    onStatus('Stopped');
  }

  public stop(): void {
    this.stopped = true;
  }

  private async handshake(): Promise<void> {
    const [answer] = await this.post([
      {
        channel: '/meta/handshake',
        version: '1.0',
        minimumVersion: '1.0',
        supportedConnectionTypes: ['long-polling'],
        ext: { replay: true },
      },
    ]);
    if (!answer?.successful || !answer.clientId) throw new Error(answer?.error ?? 'Streaming handshake failed.');
    this.clientId = answer.clientId;
  }
}

export type StreamChannel = {
  channel: string;
  label: string;
  kind: 'Platform Event' | 'Change Data Capture' | 'PushTopic';
};

/** Channels of the org: platform events, CDC (all changes and per object enabled), PushTopics. */
export async function listChannels(client: SalesforceClient): Promise<StreamChannel[]> {
  const objects = await describeGlobal(client);
  const events = objects
    .filter((o) => o.name.endsWith('__e'))
    .map((o) => ({ channel: `/event/${o.name}`, label: o.label, kind: 'Platform Event' as const }));
  const changes = objects
    .filter((o) => o.name.endsWith('ChangeEvent'))
    .map((o) => ({ channel: `/data/${o.name}`, label: o.label, kind: 'Change Data Capture' as const }));
  let topics: StreamChannel[] = [];
  try {
    const result = await client.rest<{ records: Array<{ Name: string }> }>(
      'GET',
      `/query?q=${encodeURIComponent('SELECT Name FROM PushTopic WHERE IsActive = true')}`
    );
    topics = result.records.map((t) => ({ channel: `/topic/${t.Name}`, label: t.Name, kind: 'PushTopic' as const }));
  } catch {
    // PushTopics are not available in every org
  }
  return [
    ...events,
    { channel: '/data/ChangeEvents', label: 'All change events', kind: 'Change Data Capture' as const },
    ...changes,
    ...topics,
  ];
}

/** Publishes a platform event (REST insert of the __e object). */
export async function publishEvent(
  client: SalesforceClient,
  eventName: string,
  fields: Record<string, unknown>
): Promise<string> {
  if (!/^\w+__e$/.test(eventName)) throw new Error('Not a platform event.');
  return (await client.rest<{ id: string }>('POST', `/sobjects/${eventName}`, fields)).id;
}
