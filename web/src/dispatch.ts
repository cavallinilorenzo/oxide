import type { DispatchRequest, PermissionMode, Settings, Thread } from "./bindings";

export interface DispatchForm {
  prompt: string;
  provider: string;
  model: string;
  effort: string;
  permissionMode: PermissionMode;
  baseBranch: string;
}

/** The dialog's starting values: the default Provider's Settings, branching off the checked-out branch. */
export function defaultDispatchForm(settings: Settings, currentBranch: string | null): DispatchForm {
  const provider = settings.defaultProvider || "claude";
  const defaults = settings.providers[provider as keyof Settings["providers"]];
  return {
    prompt: "",
    provider,
    model: defaults?.model ?? "",
    effort: defaults?.effort ?? "",
    permissionMode: defaults?.permissionMode ?? "auto-edit",
    baseBranch: currentBranch ?? "",
  };
}

/** The same form for another Provider, with that Provider's defaults for the rest. */
export function withProvider(form: DispatchForm, settings: Settings, provider: string): DispatchForm {
  const next = defaultDispatchForm({ ...settings, defaultProvider: provider as Settings["defaultProvider"] }, form.baseBranch || null);
  return { ...next, prompt: form.prompt };
}

/** The GitHub issue a task starts from. */
export interface DispatchIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** The form starting from an issue: its number, title, URL and body as an editable prompt. */
export function issueDispatchForm(form: DispatchForm, issue: DispatchIssue): DispatchForm {
  const head = `Issue #${issue.number}: ${issue.title}\n${issue.url}`;
  const body = issue.body.trim();
  return { ...form, prompt: body ? `${head}\n\n${body}` : head };
}

export function dispatchRequest(projectId: number, form: DispatchForm, issue?: DispatchIssue): DispatchRequest {
  const blankToNull = (text: string) => text.trim() || null;
  return {
    projectId,
    prompt: form.prompt.trim(),
    provider: form.provider,
    model: blankToNull(form.model),
    effort: blankToNull(form.effort),
    permissionMode: form.permissionMode,
    baseBranch: blankToNull(form.baseBranch),
    issueNumber: issue?.number ?? null,
    issueTitle: issue?.title ?? null,
  };
}

/** Whether the Thread has a worktree of its own: it came from the Board. */
export function isBoardThread(thread: Pick<Thread, "branch">): boolean {
  return thread.branch != null;
}
