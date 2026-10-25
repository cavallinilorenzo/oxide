import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "@primer/octicons-react";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
}

/** A single-select listbox. Selection is committed only by click, Enter or Space. */
export function Dropdown<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const items = list.current?.querySelectorAll<HTMLElement>("[role=option]");
    if (!list.current?.contains(document.activeElement)) {
      items?.[Math.max(0, options.findIndex((option) => option.value === value))]?.focus();
    }
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, options, value]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const select = (next: T) => {
    onChange(next);
    close();
  };

  return (
    <div className="dropdown" ref={container} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button ref={trigger} type="button" className="dropdown-trigger"
        aria-label={`${label}: ${selected?.label ?? value}`} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? id : undefined} disabled={options.length === 0}
        onClick={() => setOpen(!open)} onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}>
        {selected?.icon}<span>{selected?.label ?? value}</span><ChevronDownIcon size={16} />
      </button>
      {open && <div id={id} ref={list} className="dropdown-menu" role="listbox" aria-label={label}
        onKeyDown={(event) => {
          event.stopPropagation();
          const items = Array.from(list.current?.querySelectorAll<HTMLElement>("[role=option]") ?? []);
          const index = items.findIndex((item) => item === document.activeElement);
          let next: number;
          switch (event.key) {
            case "ArrowDown": next = (index + 1) % items.length; break;
            case "ArrowUp": next = (index - 1 + items.length) % items.length; break;
            case "Home": next = 0; break;
            case "End": next = items.length - 1; break;
            case "Escape": event.preventDefault(); close(); return;
            default: return;
          }
          event.preventDefault();
          items[next]?.focus();
        }}>
        {options.map((option) => <div key={option.value} role="option" tabIndex={-1}
          className="dropdown-option" aria-selected={option.value === value}
          onClick={() => select(option.value)} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              select(option.value);
            }
          }}>
          {option.icon}<span>{option.label}{option.description && <small className="dropdown-description">{option.description}</small>}</span>
          {option.value === value && <CheckIcon size={16} />}
        </div>)}
      </div>}
    </div>
  );
}
