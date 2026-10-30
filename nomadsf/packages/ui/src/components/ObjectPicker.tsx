import { useState, type ReactNode } from 'react';
import { parseDataPicks, parseObjectList, type ObjectPick } from '@nomadsf/core';
import { AiAsk } from './AiHelp';
import { useProject } from '../project';
import { Status } from '../statusLog';

export type PickerObject = { name: string; label: string; custom: boolean };

type Mode = 'browse' | 'type' | 'ai';

/**
 * Choosing objects three ways: browse the list (filter, tick, settings per object), type or
 * paste API names / labels separated by commas, or describe in words and let the AI choose
 * (objects, conditions, fields), then review the choice in the list.
 */
export function ObjectPicker({
  objects,
  purpose,
  chosenCount,
  isChosen,
  disabledReason,
  onToggle,
  onApply,
  renderTags,
  renderActions,
  renderSettings,
  toolbar,
}: {
  objects: PickerObject[] | null;
  purpose: 'backup' | 'copy';
  chosenCount: number;
  isChosen: (name: string) => boolean;
  /** Why an object cannot be ticked (e.g. not part of "All custom objects"). */
  disabledReason?: (o: PickerObject) => string | undefined;
  onToggle: (name: string, on: boolean) => void;
  /** Objects chosen by name or by the AI: added to the choice, or replacing it. */
  onApply: (picks: ObjectPick[], replace: boolean) => void;
  renderTags?: (o: PickerObject) => ReactNode;
  renderActions?: (o: PickerObject) => ReactNode;
  renderSettings?: (o: PickerObject) => ReactNode;
  toolbar?: ReactNode;
}) {
  const { aiReady } = useProject();
  const [mode, setMode] = useState<Mode>('browse');
  const [filter, setFilter] = useState('');
  const [onlyChosen, setOnlyChosen] = useState(false);
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState('');
  const list = objects ?? [];

  const applyTyped = (replace: boolean) => {
    const { found, unknown } = parseObjectList(typed, list);
    if (!found.length) {
      setMessage(`❌ None of these is an object here${unknown.length ? `: ${unknown.join(', ')}` : ''}.`);
      return;
    }
    onApply(
      found.map((name) => ({ name })),
      replace
    );
    setMessage(
      `✓ ${replace ? 'Chose' : 'Added'} ${found.length} object(s).${
        unknown.length ? ` Not found: ${unknown.join(', ')}.` : ''
      }`
    );
    setOnlyChosen(true);
    setMode('browse');
  };

  const shown = list.filter(
    (o) => (!onlyChosen || isChosen(o.name)) && `${o.label} ${o.name}`.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="object-picker">
      <div className="picker-bar">
        <div className="tabs">
          <button className={`tab ${mode === 'browse' ? 'active' : ''}`} onClick={() => setMode('browse')}>
            Browse
          </button>
          <button className={`tab ${mode === 'type' ? 'active' : ''}`} onClick={() => setMode('type')}>
            Type names
          </button>
          {aiReady && (
            <button className={`tab ${mode === 'ai' ? 'active' : ''}`} onClick={() => setMode('ai')}>
              ✦ Describe
            </button>
          )}
        </div>
        <span className="grow" />
        <span className="muted">
          {chosenCount} of {list.length} chosen
        </span>
        {toolbar}
      </div>
      <Status text={message} block />

      {mode === 'type' && (
        <div className="picker-type">
          <textarea
            className="mono"
            rows={4}
            placeholder="Account, Contact, Opportunity, Invoice__c — API names or labels, separated by commas, semicolons or new lines"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className="form">
            <button className="primary" disabled={!typed.trim()} onClick={() => applyTyped(false)}>
              Add to the choice
            </button>
            <button disabled={!typed.trim()} onClick={() => applyTyped(true)}>
              Replace the choice
            </button>
            <span className="muted">Names that do not exist here are listed, not added.</span>
          </div>
        </div>
      )}

      {mode === 'ai' && (
        <div className="picker-ai">
          <AiAsk
            task="pick-data"
            placeholder={
              purpose === 'backup'
                ? '✦ e.g. all sales data of the last 2 years, without people’s phone numbers'
                : '✦ e.g. 50 customer accounts with their contacts, open opportunities and cases'
            }
            button="Choose objects"
            what="your request and this org's object names"
            build={async () => ({
              schema: `Purpose: ${
                purpose === 'backup' ? 'data backup' : 'copy data into another org'
              }\nObjects (API name: label): ${list.map((o) => `${o.name}: ${o.label}`).join(', ')}`,
            })}
            onAnswer={(answer) => {
              try {
                const { picks, unknown, note } = parseDataPicks(answer.text, list);
                if (!picks.length) throw new Error('The AI chose no objects that exist here; try rephrasing.');
                onApply(picks, true);
                setMessage(
                  `✦ ${
                    note || `Chose ${picks.length} object(s).`
                  } Check the choice below (conditions and fields under Settings) before running.${
                    unknown.length ? ` Not found here: ${unknown.join(', ')}.` : ''
                  }`
                );
                setOnlyChosen(true);
                setMode('browse');
              } catch (e) {
                setMessage(`❌ ${(e as Error).message}`);
              }
            }}
          />
          <p className="muted">
            The AI only fills in the choice; you review it here, and nothing runs until you press the usual button.
          </p>
        </div>
      )}

      {mode === 'browse' && (
        <>
          <div className="form picker-filter">
            <input
              placeholder={`Filter ${list.length} objects`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <label className="check">
              <input type="checkbox" checked={onlyChosen} onChange={(e) => setOnlyChosen(e.target.checked)} /> Only
              chosen
            </label>
          </div>
          {objects === null && <p className="muted">Loading objects…</p>}
          <div className="obj-table">
            <div className="obj-row obj-head">
              <span />
              <span>Object</span>
              <span>API name</span>
              <span />
              <span />
            </div>
            {shown.map((o) => {
              const on = isChosen(o.name);
              const reason = disabledReason?.(o);
              return (
                <div key={o.name} className={`obj-item ${on ? 'on' : ''}`}>
                  <div className="obj-row" title={reason ?? o.name}>
                    <input
                      type="checkbox"
                      aria-label={o.label}
                      checked={on}
                      disabled={Boolean(reason)}
                      onChange={(e) => onToggle(o.name, e.target.checked)}
                    />
                    <span className="obj-label" onClick={() => !reason && onToggle(o.name, !on)}>
                      {o.label}
                    </span>
                    <span className="obj-api mono" onClick={() => !reason && onToggle(o.name, !on)}>
                      {o.name}
                    </span>
                    <span className="obj-tags">
                      {o.custom && <span className="backup-tag">custom</span>}
                      {renderTags?.(o)}
                    </span>
                    <span className="obj-actions">{renderActions?.(o)}</span>
                  </div>
                  {renderSettings?.(o)}
                </div>
              );
            })}
            {objects !== null && !shown.length && <p className="muted obj-empty">No objects match.</p>}
          </div>
        </>
      )}
    </div>
  );
}
