import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  useRef,
  useState,
  type ReactElement,
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

type OptionProps = { value?: unknown; children?: ReactNode; disabled?: boolean };

/** Every <option> inside (through fragments, arrays and <optgroup>s). */
function countOptions(children: ReactNode): number {
  let n = 0;
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    if (c.type === 'option') n++;
    else n += countOptions((c.props as { children?: ReactNode }).children);
  });
  return n;
}

/** The children with only the options that match (and the one chosen, and the empty "choose…" one). */
function filterOptions(children: ReactNode, matches: (o: OptionProps) => boolean): ReactNode {
  return Children.map(children, (c) => {
    if (!isValidElement(c)) return c;
    const props = c.props as OptionProps;
    if (c.type === 'option') return matches(props) ? c : null;
    if (c.type === 'optgroup' || c.type === Fragment) {
      const inside = filterOptions(props.children, matches);
      const kept = Children.toArray(inside).length;
      return kept ? cloneElement(c as ReactElement<{ children?: ReactNode }>, {}, inside) : null;
    }
    return c;
  });
}

/** First option that matches and has a value. */
function firstMatch(children: ReactNode, matches: (o: OptionProps) => boolean): string | undefined {
  let found: string | undefined;
  Children.forEach(children, (c) => {
    if (found !== undefined || !isValidElement(c)) return;
    const props = c.props as OptionProps;
    if (c.type === 'option') {
      if (String(props.value ?? '') !== '' && !props.disabled && matches(props)) found = String(props.value);
    } else found = firstMatch(props.children, matches);
  });
  return found;
}

/** From this many options, a filter box shows next to the list. */
const FILTER_FROM = 13;

/**
 * A <select> that, when it has many options (fields, users, types, files…), gets a small filter box next to it:
 * typing narrows the list, Enter chooses the first match. Drop-in for <select> — the page's onChange runs as usual.
 */
export function Select({ children, className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const ref = useRef<HTMLSelectElement>(null);
  const [filter, setFilter] = useState('');
  const count = countOptions(children);
  if (props.multiple || count < FILTER_FROM)
    return (
      <select {...props} className={className}>
        {children}
      </select>
    );
  const needle = filter.trim().toLowerCase();
  const current = String(props.value ?? props.defaultValue ?? '');
  const matches = (o: OptionProps): boolean => {
    const value = String(o.value ?? '');
    return (
      !needle ||
      value === '' ||
      value === current ||
      value.toLowerCase().includes(needle) ||
      textOf(o.children).toLowerCase().includes(needle)
    );
  };
  const shown = needle ? filterOptions(children, matches) : children;
  const choose = (value: string) => {
    const select = ref.current;
    if (!select) return;
    // As if chosen by hand: the page's onChange runs
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    setFilter('');
  };
  return (
    <span className="select-filter">
      <input
        type="search"
        className="select-filter-input"
        placeholder={`⌕ ${count}`}
        title={`Type to narrow the ${count} choices; Enter picks the first`}
        value={filter}
        disabled={props.disabled}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const first = firstMatch(children, (o) => matches(o) && String(o.value ?? '') !== current) ?? undefined;
            if (first !== undefined) choose(first);
          } else if (e.key === 'Escape') setFilter('');
        }}
      />
      <select {...props} ref={ref} className={className}>
        {shown}
      </select>
    </span>
  );
}
