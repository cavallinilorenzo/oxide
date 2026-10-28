import {
  BoldIcon,
  CodeIcon,
  HeadingIcon,
  ItalicIcon,
  LinkIcon,
  ListOrderedIcon,
  ListUnorderedIcon,
  QuoteIcon,
  TasklistIcon,
} from "@primer/octicons-react";
import { useLayoutEffect, useRef, useState, type KeyboardEventHandler } from "react";
import { applyFormat, type Format } from "./markdownEdit";
import { Markdown } from "./PullRequestMarkdown";

const TOOLS: { format: Format; label: string; Icon: typeof BoldIcon }[] = [
  { format: "heading", label: "Heading", Icon: HeadingIcon },
  { format: "bold", label: "Bold", Icon: BoldIcon },
  { format: "italic", label: "Italic", Icon: ItalicIcon },
  { format: "quote", label: "Quote", Icon: QuoteIcon },
  { format: "code", label: "Code", Icon: CodeIcon },
  { format: "link", label: "Link", Icon: LinkIcon },
  { format: "bullets", label: "Bulleted list", Icon: ListUnorderedIcon },
  { format: "numbers", label: "Numbered list", Icon: ListOrderedIcon },
  { format: "tasks", label: "Task list", Icon: TasklistIcon },
];

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  rows?: number;
  id?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
}

/** GitHub's comment box: Write and Preview tabs, and a toolbar that formats the selection. */
export function MarkdownEditor({
  value,
  onChange,
  label,
  placeholder,
  rows = 6,
  id,
  autoFocus,
  disabled,
  onKeyDown,
}: MarkdownEditorProps) {
  const [preview, setPreview] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  // The selection to restore once React has put the formatted text in the box.
  const selection = useRef<{ start: number; end: number } | null>(null);

  useLayoutEffect(() => {
    const el = area.current;
    const next = selection.current;
    if (!el || !next) return;
    selection.current = null;
    el.focus();
    el.setSelectionRange(next.start, next.end);
  }, [value]);

  function format(kind: Format) {
    const el = area.current;
    if (!el) return;
    const edit = applyFormat(el.value, el.selectionStart, el.selectionEnd, kind);
    selection.current = { start: edit.start, end: edit.end };
    onChange(edit.value);
  }

  return (
    <div className="md-editor" data-disabled={disabled || undefined}>
      <div className="md-editor-head">
        <div className="md-tabs" role="tablist" aria-label={`${label} mode`}>
          <button type="button" role="tab" aria-selected={!preview} onClick={() => setPreview(false)}>
            Write
          </button>
          <button type="button" role="tab" aria-selected={preview} onClick={() => setPreview(true)}>
            Preview
          </button>
        </div>
        {!preview && (
          <div className="md-tools" role="toolbar" aria-label="Formatting">
            {TOOLS.map(({ format: kind, label: name, Icon }) => (
              <button
                key={kind}
                type="button"
                className="md-tool"
                aria-label={name}
                title={name}
                disabled={disabled}
                // Keep the selection in the box while the button takes the click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => format(kind)}
              >
                <Icon size={16} />
              </button>
            ))}
          </div>
        )}
      </div>
      {preview ? (
        <div className="md-preview">
          {value.trim() ? <Markdown source={value} /> : <p className="pr-field-empty">Nothing to preview</p>}
        </div>
      ) : (
        <textarea
          ref={area}
          id={id}
          aria-label={label}
          placeholder={placeholder}
          rows={rows}
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
    </div>
  );
}
