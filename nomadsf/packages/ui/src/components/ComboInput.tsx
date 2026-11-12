import { useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';

export type ComboOption = { value: string; label?: string };

/** Puts a value in the input as if typed, so the page's own onChange runs. */
function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Most likely first: the exact name or label, then starting with the text, then containing it. */
function ranked(options: ComboOption[], typed: string): ComboOption[] {
  const needle = typed.trim().toLowerCase();
  if (!needle) return options;
  const rank = (o: ComboOption): number => {
    const v = o.value.toLowerCase();
    const l = (o.label ?? '').toLowerCase();
    if (v === needle || l === needle) return 0;
    if (v.startsWith(needle)) return 1;
    if (l.startsWith(needle)) return 2;
    if (v.includes(needle) || l.includes(needle)) return 3;
    return 4;
  };
  return options
    .map((o, i) => ({ o, i, r: rank(o) }))
    .filter((x) => x.r < 4)
    .sort((a, b) => a.r - b.r || a.o.value.length - b.o.value.length || a.i - b.i)
    .map((x) => x.o);
}

const MAX_SHOWN = 300;

/**
 * A text box with its own list to choose from (objects, metadata types…), instead of the browser's datalist: on
 * click the whole list shows (not only what matches the current value), typing narrows it, ↑ ↓ Enter pick. Anything
 * can still be typed. Drop-in for <input list=…>: the page's onChange gets the picked value as if typed.
 */
export function ComboInput({
  options,
  className,
  onFocus,
  onBlur,
  onKeyDown,
  onChange,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'list'> & { options: ComboOption[] }) {
  const ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // null: just opened, every option shows; text: what was typed since
  const [typed, setTyped] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const shown = useMemo(() => ranked(options, typed ?? '').slice(0, MAX_SHOWN), [options, typed]);
  const more = typed === null ? options.length - shown.length : 0;

  const pick = (value: string) => {
    if (ref.current) typeInto(ref.current, value);
    setOpen(false);
    setTyped(null);
    setActive(-1);
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && shown.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (e.key === 'ArrowDown' ? Math.min(shown.length - 1, a + 1) : Math.max(0, a - 1)));
      return;
    }
    if (open && e.key === 'Enter' && active >= 0 && shown[active]) {
      e.preventDefault();
      pick(shown[active].value);
      return;
    }
    if (e.key === 'Escape' && open) {
      setOpen(false);
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <span className={`combo ${/\bgrow\b/.test(className ?? '') ? 'grow' : ''}`}>
      <input
        {...input}
        ref={ref}
        className={className}
        autoComplete="off"
        onFocus={(e) => {
          setOpen(true);
          setTyped(null);
          setActive(-1);
          e.target.select();
          onFocus?.(e);
        }}
        // Clicked again after picking (still focused): the whole list again
        onClick={() => {
          if (!open) {
            setOpen(true);
            setTyped(null);
            setActive(-1);
          }
        }}
        onBlur={(e) => {
          setOpen(false);
          onBlur?.(e);
        }}
        onChange={(e) => {
          setTyped(e.target.value);
          setOpen(true);
          setActive(-1);
          onChange?.(e);
        }}
        onKeyDown={keys}
      />
      {open && shown.length > 0 && (
        <ul className="combo-list" role="listbox">
          {shown.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              // Before the input's blur: the click still counts
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o.value);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <b>{o.value}</b>
              {o.label && o.label !== o.value && <span className="muted small">{o.label}</span>}
            </li>
          ))}
          {more > 0 && <li className="muted small combo-more">… {more} more: type to narrow</li>}
        </ul>
      )}
    </span>
  );
}
