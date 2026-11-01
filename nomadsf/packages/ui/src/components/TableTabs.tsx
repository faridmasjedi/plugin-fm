import { useState, type ReactNode } from 'react';

/**
 * Several tables of one subject in one box: a tab each (with its count), one shown at a time — instead of tables one
 * under the other. Each tab's table keeps its own filters, export and ticks while another tab is shown.
 */
export type TableTab = { id: string; label: string; count?: number; content: ReactNode };

export function TableTabs({
  tabs,
  initial,
  title,
  active: chosen,
  onChange,
}: {
  tabs: TableTab[];
  initial?: string;
  title?: ReactNode;
  /** The tab shown, when the page chooses it too (summary tiles that open a tab). */
  active?: string;
  onChange?: (id: string) => void;
}) {
  const [own, setOwn] = useState(initial ?? tabs[0]?.id ?? '');
  const active = chosen ?? own;
  const setActive = (id: string): void => {
    setOwn(id);
    onChange?.(id);
  };
  const shown = tabs.find((t) => t.id === active) ?? tabs[0];
  if (!shown) return null;
  return (
    <div className="table-tabs">
      <div className="table-tabs-bar">
        {title && <span className="table-tabs-title">{title}</span>}
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              className={`tab ${t.id === shown.id ? 'active' : ''}`}
              onClick={() => setActive(t.id)}
            >
              {t.label}
              {t.count !== undefined && <span className="tab-count">{t.count.toLocaleString()}</span>}
            </button>
          ))}
        </div>
      </div>
      {tabs.map((t) => (
        <div key={t.id} hidden={t.id !== shown.id}>
          {t.content}
        </div>
      ))}
    </div>
  );
}
