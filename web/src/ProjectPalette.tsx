import { useEffect, useMemo, useRef, useState } from "react";
import { commands, type AppError, type GithubRepository, type Project } from "./bindings";
import { matchActions, matchProjects, moveHighlight, type PaletteActionId } from "./paletteSearch";

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: AppError };

type FormKind = "add-folder" | "new-project" | "clone-url" | "clone-github";
type Step = { label: string; placeholder: string; initial: string };

type Stage =
  | { kind: "search" }
  | { kind: "github" }
  | { kind: "form"; form: FormKind; repo?: string };

const GITHUB_SEARCH_DELAY_MS = 200;

function stepsFor(form: FormKind, defaultParent: string): Step[] {
  const parent: Step = { label: "Parent folder", placeholder: "~/Developer", initial: defaultParent };
  switch (form) {
    case "add-folder":
      return [{ label: "Folder to add", placeholder: "~/Developer/my-project", initial: "" }];
    case "new-project":
      return [{ label: "Project name", placeholder: "my-project", initial: "" }, parent];
    case "clone-url":
      return [
        { label: "Git URL", placeholder: "https://github.com/owner/repo.git", initial: "" },
        parent,
      ];
    case "clone-github":
      return [parent];
  }
}

function describeStage(stage: Stage): string {
  if (stage.kind === "search") return "Search Projects, or add one";
  if (stage.kind === "github") return "Search your GitHub repositories";
  if (stage.form === "clone-github") return `Clone ${stage.repo}`;
  return {
    "add-folder": "Add a local folder",
    "new-project": "Create a new Project",
    "clone-url": "Clone from a Git URL",
  }[stage.form];
}

/**
 * ⌘⇧N: find a Project and start a Thread in it, or register one more (an existing folder,
 * a new `git init` folder, a clone from a URL or from the user's GitHub repositories).
 * Keyboard-only: ↑/↓ pick, Enter confirms, Esc steps back.
 */
export function ProjectPalette({
  projects,
  defaultParent,
  onClose,
  onStartThread,
  onOpenProject,
}: {
  projects: Project[];
  defaultParent: string;
  onClose: () => void;
  /** A Project was picked from the search: start a new Thread in it. */
  onStartThread: (project: Project) => void;
  /** A Project was just registered: open it. */
  onOpenProject: (project: Project) => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "search" });
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [repositories, setRepositories] = useState<GithubRepository[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const steps = useMemo(
    () => (stage.kind === "form" ? stepsFor(stage.form, defaultParent) : []),
    [stage, defaultParent],
  );

  const projectRows = useMemo(
    () => (stage.kind === "search" ? matchProjects(projects, query) : []),
    [stage, projects, query],
  );
  const actionRows = useMemo(() => (stage.kind === "search" ? matchActions(query) : []), [stage, query]);
  const rowCount =
    stage.kind === "search" ? projectRows.length + actionRows.length : stage.kind === "github" ? repositories.length : 0;

  useEffect(() => {
    input.current?.focus();
  }, [stage, step]);

  // GitHub search runs through `gh` on the user's request: once typing settles.
  useEffect(() => {
    if (stage.kind !== "github") return;
    let current = true;
    const timer = setTimeout(() => {
      setSearching(true);
      void commands.searchGithubRepositories(query).then((res: Result<GithubRepository[]>) => {
        if (!current) return;
        setSearching(false);
        if (res.status === "ok") {
          setRepositories(res.data);
          setError(null);
        } else {
          setRepositories([]);
          setError(res.error.message);
        }
      });
    }, GITHUB_SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [stage.kind, query]);

  const goTo = (next: Stage, initialValues: string[] = []) => {
    setStage(next);
    setStep(0);
    setValues(initialValues);
    setQuery("");
    setHighlight(0);
    setError(null);
  };

  const back = () => {
    if (stage.kind === "search") onClose();
    else if (stage.kind === "form" && step > 0) {
      setStep(step - 1);
      setError(null);
    } else if (stage.kind === "form" && stage.form === "clone-github") goTo({ kind: "github" });
    else goTo({ kind: "search" });
  };

  const register = async (run: () => Promise<Result<Project>>) => {
    setBusy(true);
    setError(null);
    const res = await run();
    setBusy(false);
    if (res.status === "ok") {
      onOpenProject(res.data);
      onClose();
    } else setError(res.error.message);
  };

  const submit = (form: FormKind, repo: string | undefined, all: string[]) => {
    switch (form) {
      case "add-folder":
        return register(() => commands.addProject(all[0]));
      case "new-project":
        return register(() => commands.createProject(all[1], all[0]));
      case "clone-url":
        return register(() => commands.cloneProject(all[0], all[1]));
      case "clone-github":
        return register(() => commands.cloneGithubRepository(repo ?? "", all[0]));
    }
  };

  const chooseAction = (id: PaletteActionId) => {
    if (id === "clone-github") goTo({ kind: "github" });
    else goTo({ kind: "form", form: id });
  };

  const enter = () => {
    if (busy) return;
    if (stage.kind === "search") {
      const project = projectRows[highlight];
      if (project) {
        onStartThread(project);
        onClose();
        return;
      }
      const action = actionRows[highlight - projectRows.length];
      if (action) chooseAction(action.id);
    } else if (stage.kind === "github") {
      const repo = repositories[highlight];
      if (repo) goTo({ kind: "form", form: "clone-github", repo: repo.nameWithOwner });
    } else {
      const typed = (values[step] ?? steps[step].initial).trim();
      if (typed === "") return;
      const all = steps.map((s, i) => (i === step ? typed : (values[i] ?? s.initial).trim()));
      if (step < steps.length - 1) {
        setValues(all);
        setStep(step + 1);
        setError(null);
      } else void submit(stage.form, stage.repo, all);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      back();
    } else if (e.key === "Enter") {
      e.preventDefault();
      enter();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(moveHighlight(highlight, rowCount, e.key === "ArrowDown" ? 1 : -1));
    }
  };

  const inForm = stage.kind === "form";
  const field = inForm ? steps[step] : null;
  const value = field ? (values[step] ?? field.initial) : query;

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Project palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-title">
          {describeStage(stage)}
          {field && steps.length > 1 && (
            <span className="palette-step">
              {" "}
              · {step + 1}/{steps.length}
            </span>
          )}
        </div>
        <input
          ref={input}
          className="palette-input"
          aria-label={field?.label ?? "Search"}
          placeholder={field?.placeholder ?? (stage.kind === "github" ? "owner/repository" : "Project name")}
          value={value}
          disabled={busy}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => {
            if (inForm) {
              const next = [...values];
              next[step] = e.target.value;
              setValues(next);
            } else {
              setQuery(e.target.value);
              setHighlight(0);
            }
          }}
          onKeyDown={onKeyDown}
        />
        {field && <div className="palette-hint">{field.label} · Enter to continue · Esc to go back</div>}
        {busy && <p className="palette-hint">Working…</p>}
        {error && <p className="error palette-error">{error}</p>}
        {stage.kind === "search" && (
          <ul className="palette-list" role="listbox" aria-label="Results">
            {projectRows.map((p, i) => (
              <li key={p.id} role="option" aria-selected={i === highlight}>
                <span className="palette-name">{p.name}</span>
                <span className="palette-detail">{p.path}</span>
              </li>
            ))}
            {actionRows.map((a, i) => (
              <li
                key={a.id}
                role="option"
                className="palette-action"
                aria-selected={projectRows.length + i === highlight}
              >
                {a.label}
              </li>
            ))}
            {rowCount === 0 && <li className="palette-empty">No match</li>}
          </ul>
        )}
        {stage.kind === "github" && (
          <ul className="palette-list" role="listbox" aria-label="GitHub repositories">
            {repositories.map((r, i) => (
              <li key={r.nameWithOwner} role="option" aria-selected={i === highlight}>
                <span className="palette-name">{r.nameWithOwner}</span>
                <span className="palette-detail">{r.description}</span>
              </li>
            ))}
            {repositories.length === 0 && !error && (
              <li className="palette-empty">{searching ? "Searching…" : "No repository found"}</li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
