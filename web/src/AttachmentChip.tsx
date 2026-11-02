import {
  BookIcon,
  DeviceCameraVideoIcon,
  FileBinaryIcon,
  FileCodeIcon,
  FileIcon,
  FileZipIcon,
  ImageIcon,
  MarkdownIcon,
  NoteIcon,
  ProjectIcon,
  TableIcon,
  TypographyIcon,
  UnmuteIcon,
  XIcon,
  type Icon,
} from "@primer/octicons-react";
import type { AttachmentKind } from "./bindings";
import { chipLabel, formatSize, iconFor, shortenName, type ChipIcon } from "./attachments";

const ICONS: Record<ChipIcon, Icon> = {
  image: ImageIcon,
  pdf: BookIcon,
  document: NoteIcon,
  presentation: ProjectIcon,
  table: TableIcon,
  markdown: MarkdownIcon,
  text: FileIcon,
  code: FileCodeIcon,
  audio: UnmuteIcon,
  video: DeviceCameraVideoIcon,
  archive: FileZipIcon,
  font: TypographyIcon,
  file: FileBinaryIcon,
};

interface AttachmentChipProps {
  name: string;
  kind: AttachmentKind;
  sizeBytes: number;
  /** The file is still being stored. */
  busy?: boolean;
  /** Shows a remove button; used by the composer, not the Transcript. */
  removable?: boolean;
}

/**
 * An Attachment in a prompt: an icon for the type of file and its name, never a preview of the contents, the same for every
 * Provider. The composer draws it as static markup inside its editable text, so it carries no
 * handlers of its own.
 */
export function AttachmentChip({ name, kind, sizeBytes, busy = false, removable = false }: AttachmentChipProps) {
  const ChipGlyph = ICONS[iconFor(name)];
  const title = sizeBytes > 0 ? `${name} · ${formatSize(sizeBytes)}` : name;
  return (
    <span
      className={`attachment-chip${busy ? " busy" : ""}`}
      role="img"
      aria-label={chipLabel(name, kind)}
      aria-busy={busy || undefined}
      title={title}
    >
      <ChipGlyph size={14} className="attachment-chip-icon" />
      <span className="attachment-chip-name">{shortenName(name)}</span>
      {removable && (
        <button type="button" className="attachment-chip-remove" data-chip-remove tabIndex={-1} aria-label={`Remove ${name}`}>
          <XIcon size={10} />
        </button>
      )}
    </span>
  );
}
