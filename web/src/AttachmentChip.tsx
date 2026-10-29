import {
  FileBinaryIcon,
  FileCodeIcon,
  FileIcon,
  FileMediaIcon,
  FileZipIcon,
  MarkdownIcon,
  NoteIcon,
  TableIcon,
  XIcon,
  type Icon,
} from "@primer/octicons-react";
import type { AttachmentKind } from "./bindings";
import { useEffect, useState } from "react";
import { attachmentPreview } from "./attachmentPreview";
import { chipLabel, formatSize, iconFor, shortenName, type ChipIcon } from "./attachments";

const ICONS: Record<ChipIcon, Icon> = {
  image: FileMediaIcon,
  pdf: NoteIcon,
  markdown: MarkdownIcon,
  text: FileIcon,
  code: FileCodeIcon,
  table: TableIcon,
  archive: FileZipIcon,
  file: FileBinaryIcon,
};

interface AttachmentChipProps {
  id?: string | null;
  name: string;
  kind: AttachmentKind;
  sizeBytes: number;
  /** The file is still being stored. */
  busy?: boolean;
  /** Shows a remove button; used by the composer, not the Transcript. */
  removable?: boolean;
}

/**
 * An Attachment in a prompt: an image preview or file icon and name, the same for every
 * Provider. The composer draws it as static markup inside its editable text, so it carries no
 * handlers of its own.
 */
export function AttachmentChip({ id, name, kind, sizeBytes, busy = false, removable = false }: AttachmentChipProps) {
  const [preview, setPreview] = useState<{ id: string; src: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (id && kind === "image") void attachmentPreview(id).then((src) => {
      if (active && src) setPreview({ id, src });
    });
    return () => { active = false; };
  }, [id, kind]);
  const ChipGlyph = ICONS[iconFor(name)];
  const title = sizeBytes > 0 ? `${name} · ${formatSize(sizeBytes)}` : name;
  return (
    <span
      className={`attachment-chip${busy ? " busy" : ""}${kind === "image" ? " attachment-image" : ""}`}
      role="img"
      aria-label={chipLabel(name, kind)}
      aria-busy={busy || undefined}
      title={title}
    >
      {kind === "image" && <img className="attachment-thumbnail" src={preview?.id === id ? preview?.src : undefined} alt="" draggable={false} onError={(event) => { event.currentTarget.hidden = true; }} />}
      <ChipGlyph size={12} className="attachment-chip-icon" />
      <span className="attachment-chip-name">{shortenName(name)}</span>
      {removable && (
        <button type="button" className="attachment-chip-remove" data-chip-remove tabIndex={-1} aria-label={`Remove ${name}`}>
          <XIcon size={10} />
        </button>
      )}
    </span>
  );
}
