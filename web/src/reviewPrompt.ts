/** The opening of the prompt Core builds when Line comments are sent to a Thread. */
const REVIEW_PROMPT_START = "I reviewed your changes and left ";

/** Whether a user message is a batch of Line comments, which the Transcript shows as structured text. */
export const isReviewComments = (text: string) => text.startsWith(REVIEW_PROMPT_START) && text.includes("\n### ");

export interface SentComment {
  /** `path:line`, with a note for a removed line. */
  where: string;
  code: string;
  body: string;
}

/** Splits the prompt Core builds (see `line_comments::prompt`) back into its intro and comments. */
export function parseReviewComments(text: string): { intro: string; comments: SentComment[] } {
  const [intro, ...sections] = text.split("\n### ");
  const comments = sections.map((section) => {
    const lines = section.split("\n");
    const where = lines[0] ?? "";
    const fence = /^`{3,}$/.exec(lines[1] ?? "")?.[0];
    if (!fence) return { where, code: "", body: lines.slice(1).join("\n").trim() };
    const end = lines.indexOf(fence, 2);
    if (end < 0) return { where, code: lines.slice(2).join("\n"), body: "" };
    return { where, code: lines.slice(2, end).join("\n"), body: lines.slice(end + 1).join("\n").trim() };
  });
  return { intro: intro.trim(), comments };
}
