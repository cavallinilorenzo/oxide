export function formatIssueLabel(issue: { number: number; title: string }): string {
  return `#${issue.number} ${issue.title}`;
}

export function canSubmitIssue(title: string): boolean {
  return title.trim().length > 0;
}

export function canSubmitComment(body: string): boolean {
  return body.trim().length > 0;
}
