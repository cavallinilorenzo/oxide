import { describe, expect, it } from "vitest";
import {
  busyChip,
  chipLabel,
  chipFor,
  decodeDraft,
  encodeDraft,
  formatSize,
  hasContent,
  iconFor,
  insertAt,
  isBusy,
  lengthOf,
  plainText,
  replaceChip,
  shortenName,
  toPromptInput,
  toPromptSegments,
  type ComposerChip,
  type ComposerSegment,
} from "./attachments";

const chip = (name: string, id: string | null = name): ComposerChip => ({
  kind: "attachment",
  key: `k-${name}`,
  id,
  name,
  attachmentKind: "image",
  mediaType: "image/png",
  sizeBytes: 3,
  path: `/h/attachments/${id}/${name}`,
});
const text = (t: string): ComposerSegment => ({ kind: "text", text: t });

describe("prompt segments", () => {
  it("sends text and Attachments in order, trimmed at the ends, Attachments by id", () => {
    const value = [text("  Ciao prova "), chip("immagine.png"), text(" 123!!!  ")];
    expect(toPromptInput(value)).toEqual([
      { kind: "text", text: "Ciao prova " },
      { kind: "attachment", id: "immagine.png" },
      { kind: "text", text: " 123!!!" },
    ]);
  });

  it("drops blank text around a prompt made only of Attachments", () => {
    expect(toPromptInput([text("  "), chip("a.png"), text("\n")])).toEqual([{ kind: "attachment", id: "a.png" }]);
    expect(hasContent([chip("a.png")])).toBe(true);
    expect(hasContent([text("  \n")])).toBe(false);
  });

  it("reads an Attachment as [name] in plain text", () => {
    expect(plainText([text("compare "), chip("a.png"), text(" with "), chip("b.png")])).toBe("compare [a.png] with [b.png]");
  });

  it("keeps the Attachment details for the sending Turn", () => {
    const [, attachment] = toPromptSegments([text("x "), chip("a.png")]);
    expect(attachment).toMatchObject({ kind: "attachment", id: "a.png", name: "a.png", attachmentKind: "image", sizeBytes: 3 });
  });

  it("is busy while a file is being stored, and a busy chip is never sent", () => {
    const busy = busyChip("big.pdf");
    expect(isBusy([text("x"), busy])).toBe(true);
    expect(toPromptInput([busy])).toEqual([]);
    expect(isBusy([text("x"), chip("a.png")])).toBe(false);
  });
});

describe("inserting", () => {
  it("puts chips at the caret inside text", () => {
    const next = insertAt([text("Ciao  123")], 5, [chip("a.png")]);
    expect(next).toEqual([text("Ciao "), chip("a.png"), text(" 123")]);
  });

  it("puts chips at the end, between chips, and into an empty prompt", () => {
    expect(insertAt([text("hi")], 2, [chip("a.png")])).toEqual([text("hi"), chip("a.png")]);
    expect(insertAt([chip("a.png"), chip("b.png")], 1, [chip("c.png")]).map((s) => (s.kind === "text" ? s.text : s.name))).toEqual(["a.png", "c.png", "b.png"]);
    expect(insertAt([], 0, [chip("a.png")])).toEqual([chip("a.png")]);
  });

  it("counts a chip and a line break as one caret unit each", () => {
    expect(lengthOf([text("a\nb"), chip("x.png")])).toBe(4);
  });

  it("replaces a busy chip with the stored one, or removes it", () => {
    const busy = busyChip("a.png");
    const stored = chipFor({ id: "id1", name: "a.png", attachmentKind: "image", mediaType: "image/png", sizeBytes: 9, path: "/p" }, busy.key);
    const filled = replaceChip([text("a "), busy, text(" b")], busy.key, stored);
    expect(filled[1]).toMatchObject({ key: busy.key, id: "id1", sizeBytes: 9 });
    expect(replaceChip([text("a "), busy, text(" b")], busy.key, null)).toEqual([text("a  b")]);
  });
});

describe("drafts", () => {
  it("keeps plain text plain", () => {
    expect(encodeDraft([text("hello")])).toBe("hello");
    expect(decodeDraft("hello")).toEqual([text("hello")]);
    expect(decodeDraft("")).toEqual([]);
  });

  it("round-trips a draft that holds Attachments", () => {
    const value = [text("see "), chip("a.png"), text(" please")];
    const encoded = encodeDraft(value);
    expect(encoded).not.toBe(plainText(value));
    expect(decodeDraft(encoded)).toEqual(value);
  });
});

describe("chip display", () => {
  it("picks an icon from the extension", () => {
    expect(iconFor("shot.PNG")).toBe("image");
    expect(iconFor("spec.pdf")).toBe("pdf");
    expect(iconFor("README.md")).toBe("markdown");
    expect(iconFor("main.rs")).toBe("code");
    expect(iconFor("data.xlsx")).toBe("table");
    expect(iconFor("backup.tar")).toBe("archive");
    expect(iconFor("Makefile")).toBe("file");
    expect(iconFor("weird.zzz")).toBe("file");
  });

  it("shortens long names in the middle and keeps the extension", () => {
    expect(shortenName("immagine.png")).toBe("immagine.png");
    const long = "Screenshot 2026-10-28 at 10.41.22 AM final version.png";
    const short = shortenName(long);
    expect(short.length).toBeLessThanOrEqual(28);
    expect(short.endsWith(".png")).toBe(true);
    expect(short).toContain("…");
    expect(short.startsWith("Screenshot")).toBe(true);
  });

  it("names a chip for a screen reader, and sizes for people", () => {
    expect(chipLabel("immagine.png", "image")).toBe("Attachment, immagine.png, image");
    expect(chipLabel("a.bin", "other")).toBe("Attachment, a.bin, file");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(20 * 1024 * 1024)).toBe("20.0 MB");
  });
});
