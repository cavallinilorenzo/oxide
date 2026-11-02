/** The opening of the prompt Core builds when Line comments are sent to a Thread. */
const REVIEW_PROMPT_START = "I reviewed your changes and left ";

/** Whether a user message is a batch of Line comments, which the Transcript shows as formatted text. */
export const isReviewComments = (text: string) => text.startsWith(REVIEW_PROMPT_START) && text.includes("\n### ");
