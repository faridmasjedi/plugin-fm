import { useEffect, useRef, useState } from 'react';
import {
  CometdClient,
  cometdPost,
  listChannels,
  publishEvent,
  type ReplayFrom,
  type StreamChannel,
  type StreamEvent,
} from '@nomadsf/core';
import { CodeEditor } from '../components/CodeEditor';
import { storage, useStudio } from '../context';
import { Status } from '../statusLog';

const MAX_EVENTS = 500;

/** Platform Events, Change Data Capture and PushTopics: watch live, replay, publish. */
export function EventsPage() {
  const studio = useStudio();
  const { client } = studio;
  const [channels, setChannels] = useState<StreamChannel[]>([]);
  const [channel, setChannel] = useState<string>(() => storage.get('events.channel', ''));
  const [replay, setReplay] = useState<ReplayFrom>(-1);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [open, setOpen] = useState<StreamEvent | null>(null);
  const [status, setStatus] = useState('');
  const [listening, setListening] = useState(false);
  const [payload, setPayload] = useState('{\n  \n}');
  const stream = useRef<CometdClient | null>(null);

  useEffect(() => {
    listChannels(client)
      .then((list) => {
        setChannels(list);
        setChannel((current) => current || list[0]?.channel || '');
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
    return () => stream.current?.stop();
  }, [client]);

  const start = () => {
    storage.set('events.channel', channel);
    const cometd = new CometdClient(cometdPost(client));
    stream.current = cometd;
    setListening(true);
    setStatus('Connecting…');
    cometd
      .run(channel, replay, (event) => setEvents((list) => [event, ...list].slice(0, MAX_EVENTS)), setStatus)
      .catch((e: Error) => setStatus(`❌ ${e.message}`))
      .finally(() => setListening(false));
  };

  const stop = () => {
    stream.current?.stop();
    setStatus('Stopping (after the current long poll)…');
  };

  const eventName = /^\/event\/(\w+__e)$/.exec(channel)?.[1];
  const publish = async () => {
    if (!eventName) return;
    let fields: Record<string, unknown>;
    try {
      fields = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      setStatus('❌ The event fields must be JSON.');
      return;
    }
    if (!(await studio.confirmChange(`Publish ${eventName} to ${studio.org.label}`))) return;
    try {
      const id = await publishEvent(client, eventName, fields);
      studio.logActivity('publish event', { event: eventName, id });
      setStatus(`✓ Published ${eventName} (${id}).`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const kinds = [...new Set(channels.map((c) => c.kind))];

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Events</h2>
        <select
          value={channel}
          disabled={listening}
          onChange={(e) => setChannel(e.target.value)}
          style={{ maxWidth: 420 }}
        >
          {kinds.map((kind) => (
            <optgroup key={kind} label={kind}>
              {channels
                .filter((c) => c.kind === kind)
                .map((c) => (
                  <option key={c.channel} value={c.channel}>
                    {c.label} — {c.channel}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <select value={replay} disabled={listening} onChange={(e) => setReplay(Number(e.target.value) as ReplayFrom)}>
          <option value={-1}>New events only</option>
          <option value={-2}>Replay retained (last 72 h)</option>
        </select>
        {listening ? (
          <button onClick={stop}>Stop</button>
        ) : (
          <button className="primary" disabled={!channel} onClick={start}>
            Listen
          </button>
        )}
        <span className="grow" />
        <button disabled={!events.length} onClick={() => setEvents([])}>
          Clear
        </button>
      </div>
      {status && <Status text={status} block />}
      {channels.length === 0 && !status && <p className="muted">Finding channels…</p>}
      <div className="split">
        <div className="card">
          {events.length === 0 ? (
            <p className="muted">{listening ? 'Waiting for events…' : 'Choose a channel and Listen.'}</p>
          ) : (
            <table className="record events">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Channel</th>
                  <th>Replay Id</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr
                    key={`${e.replayId ?? ''}-${i}`}
                    className={open === e ? 'selected' : ''}
                    onClick={() => setOpen(e)}
                  >
                    <td>{new Date(e.receivedAt).toLocaleTimeString()}</td>
                    <td className="mono">{e.channel}</td>
                    <td className="mono">{e.replayId ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card section">
          {open ? (
            <pre className="rest-body">{JSON.stringify(open.payload, null, 2)}</pre>
          ) : (
            <p className="muted">Click an event to see its payload.</p>
          )}
          {eventName && (
            <>
              <h3>Publish {eventName}</h3>
              <div className="editor-box small">
                <CodeEditor language="json" value={payload} onChange={setPayload} />
              </div>
              <div className="form">
                <button onClick={() => void publish()}>Publish</button>
                <span className="muted">Asks for the org name; listed on Activity.</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
