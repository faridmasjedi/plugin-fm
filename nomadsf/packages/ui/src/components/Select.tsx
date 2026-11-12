import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

/** Text of an option's children ("Account (12)"). */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

type Choice = { value: string; text: string; group?: string; disabled?: boolean };

/** Every <option> inside (through fragments, arrays and <optgroup>s), with its group. */
function choicesOf(children: ReactNode, group?: string, out: Choice[] = []): Choice[] {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const props = c.props as { value?: unknown; children?: ReactNode; disabled?: boolean; label?: string };
    if (c.type === 'option')
      out.push({
        value: String(props.value ?? textOf(props.children)),
        text: textOf(props.children),
        group,
        disabled: props.disabled,
      });
    else choicesOf(props.children, c.type === 'optgroup' ? props.label : group, out);
  });
  return out;
}

/** From this many options, the list can be searched. */
const SEARCH_FROM = 13;
const MAX_SHOWN = 400;

/**
 * A <select> that, with many options (fields, users, types, files…), opens as a list you can type in: the chosen one
 * stays shown, a click opens the whole list with a search box on top, ↑ ↓ Enter pick, the row under the mouse or
 * the arrows is highlighted. Drop-in for <select>: a hidden native select gets the choice, so the page's onChange
 * runs as usual. Short lists stay the browser's own.
 */
export function Select({ children, className, style, title, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const native = useRef<HTMLSelectElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [active, setActive] = useState(0);
  const choices = useMemo(() => choicesOf(children), [children]);
  const searchable = !props.multiple && choices.length >= SEARCH_FROM;
  const current = String(props.value ?? props.defaultValue ?? '');
  const needle = typed.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!needle) return choices.slice(0, MAX_SHOWN);
    const rank = (c: Choice): number => {
      const v = c.value.toLowerCase();
      const t = c.text.toLowerCase();
      if (v === needle || t === needle) return 0;
      if (t.startsWith(needle) || v.startsWith(needle)) return 1;
      if (t.includes(needle) || v.includes(needle)) return 2;
      return 3;
    };
    return choices
      .map((c, i) => ({ c, i, r: rank(c) }))
      .filter((x) => x.r < 3)
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.c)
      .slice(0, MAX_SHOWN);
  }, [choices, needle]);

  // Closes on a click anywhere else
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  // The chosen row in view when the list opens
  useEffect(() => {
    if (open) box.current?.querySelector('.search-select-list li.active')?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  if (!searchable)
    return (
      <select {...props} className={className} style={style} title={title}>
        {children}
      </select>
    );

  const chosen = choices.find((c) => c.value === current);
  const openList = () => {
    if (props.disabled) return;
    setTyped('');
    setActive(
      Math.max(
        0,
        choices.findIndex((c) => c.value === current)
      )
    );
    setOpen(true);
  };
  const pick = (c: Choice | undefined) => {
    if (!c || c.disabled) return;
    const select = native.current;
    if (select) {
      // As if chosen by hand: the page's onChange runs
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, c.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setOpen(false);
  };

  return (
    <span ref={box} className={`search-select ${className ?? ''}`} style={style} title={title}>
      <select {...props} ref={native} tabIndex={-1} aria-hidden className="search-select-native">
        {children}
      </select>
      <button
        type="button"
        className="search-select-button"
        disabled={props.disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openList();
          } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
            // Typing on the closed list starts the search
            openList();
            setTyped(e.key);
            setActive(0);
          }
        }}
      >
        <span className="search-select-text">{chosen?.text ?? ''}</span>
        <span className="search-select-caret">▾</span>
      </button>
      {open && (
        <div className="search-select-pop">
          <input
            autoFocus
            type="search"
            placeholder={`Search ${choices.length} choices`}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => (e.key === 'ArrowDown' ? Math.min(shown.length - 1, a + 1) : Math.max(0, a - 1)));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(shown[active]);
              } else if (e.key === 'Escape') setOpen(false);
            }}
          />
          <ul className="search-select-list" role="listbox">
            {shown.map((c, i) => (
              <li
                key={`${c.value}|${i}`}
                role="option"
                aria-selected={c.value === current}
                className={`${i === active ? 'active' : ''} ${c.value === current ? 'chosen' : ''} ${
                  c.disabled ? 'disabled' : ''
                }`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
              >
                {c.group && <span className="muted small">{c.group} · </span>}
                {c.text || <span className="muted">—</span>}
              </li>
            ))}
            {!shown.length && <li className="muted small disabled">Nothing matches “{typed}”.</li>}
          </ul>
        </div>
      )}
    </span>
  );
}
