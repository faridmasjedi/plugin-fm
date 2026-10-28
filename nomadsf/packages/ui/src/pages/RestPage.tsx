import { useState } from 'react';
import { describeGlobal, parseRestRequest, restExplorer, type RestAnswer, type RestCall } from '@nomadsf/core';
import { AiAsk, AiExplain } from '../components/AiHelp';
import { CodeEditor } from '../components/CodeEditor';
import { storage, useStudio } from '../context';

const METHODS: Array<RestCall['method']> = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const EXAMPLES = [
  '/services/data/',
  '/services/data/vXX.X/limits',
  '/services/data/vXX.X/sobjects',
  '/services/data/vXX.X/sobjects/Account/describe',
  '/services/data/vXX.X/query?q=SELECT+Id,Name+FROM+Account+LIMIT+5',
  '/services/data/vXX.X/tooling/query?q=SELECT+Id,Name+FROM+ApexClass+LIMIT+5',
  '/services/data/vXX.X/recent',
];

const pretty = (body: string): string => {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

/** Any Salesforce REST call; vXX.X becomes the org's latest API version. Changes ask first. */
export function RestPage() {
  const studio = useStudio();
  const [method, setMethod] = useState<RestCall['method']>('GET');
  const [path, setPath] = useState<string>(() => storage.get('rest.path', '/services/data/vXX.X/limits'));
  const [body, setBody] = useState('');
  const [answer, setAnswer] = useState<RestAnswer | null>(null);
  const [running, setRunning] = useState(false);
  const [aiNote, setAiNote] = useState('');

  const send = async (target = path, verb = method) => {
    if (verb !== 'GET' && !(await studio.confirmChange(`${verb} ${target}`))) return;
    setRunning(true);
    storage.set('rest.path', target);
    const result = await restExplorer(studio.client, { method: verb, path: target, body });
    if (verb !== 'GET') studio.logActivity('rest call', { method: verb, path: target, status: result.status });
    setAnswer(result);
    setRunning(false);
  };

  // Follow links in answers (nextRecordsUrl, urls of sObjects, …)
  const links = answer ? [...new Set(answer.body.match(/"\/services\/[^"\s{}]+"/g) ?? [])].slice(0, 40) : [];

  return (
    <div className="page">
      <div className="toolbar">
        <h2>REST Explorer</h2>
        <select value={method} onChange={(e) => setMethod(e.target.value as RestCall['method'])}>
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input
          className="mono grow"
          list="rest-examples"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
        />
        <datalist id="rest-examples">
          {EXAMPLES.map((e) => (
            <option key={e} value={e} />
          ))}
        </datalist>
        <button
          className={`primary ${running ? 'working' : ''}`}
          disabled={running || !path.trim()}
          onClick={() => void send()}
        >
          {running ? 'Sending…' : 'Send'}
        </button>
      </div>
      <AiAsk
        task="rest-request"
        placeholder="✦ Describe the call, e.g. create a contact Ann Lee for Acme, or the last 10 cases with their owner"
        button="Build the request"
        what="your request and this org's object names"
        build={async () => ({
          schema: `Objects: ${(await describeGlobal(studio.client).catch(() => []))
            .map((o) => o.name)
            .join(', ')
            .slice(0, 20_000)}`,
        })}
        onAnswer={(reply) => {
          const draft = parseRestRequest(reply.text);
          setMethod(draft.method);
          setPath(draft.path);
          setBody(draft.body);
          setAiNote(`✦ Filled in by AI (${reply.model}). Check it, then press Send.`);
        }}
      />
      {aiNote && (
        <p className="muted" style={{ margin: 0 }}>
          {aiNote}
        </p>
      )}
      {method !== 'GET' && (
        <div className="editor-box small">
          <CodeEditor language="json" value={body} onChange={setBody} />
        </div>
      )}
      {answer && (
        <div className="card section">
          <p className="muted" style={{ margin: 0 }}>
            <b className={answer.status >= 400 || answer.status === 0 ? 'bad-text' : 'good-text'}>
              {answer.status || 'error'}
            </b>{' '}
            · {answer.durationMs} ms · {answer.body.length.toLocaleString()} bytes
            {answer.headers['sforce-limit-info'] ? ` · ${answer.headers['sforce-limit-info']}` : ''}
          </p>
          {links.length > 0 && (
            <div className="chips">
              {links.map((l) => {
                const target = l.slice(1, -1);
                return (
                  <button
                    key={target}
                    className="chip link"
                    onClick={() => {
                      setMethod('GET');
                      setPath(target);
                      void send(target, 'GET');
                    }}
                  >
                    {target.replace(/^\/services\/data\/v[\d.]+/, '')}
                  </button>
                );
              })}
            </div>
          )}
          <div className="chips">
            <AiExplain
              task="explain-response"
              label="Explain this response"
              what="the request and the response"
              getText={() => answer.body.slice(0, 60_000)}
              getExtra={() => `${method} ${path}\nStatus ${answer.status}`}
            />
          </div>
          <pre className="rest-body">{pretty(answer.body)}</pre>
        </div>
      )}
    </div>
  );
}
