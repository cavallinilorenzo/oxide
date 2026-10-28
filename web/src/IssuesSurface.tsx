import { CommentIcon, PlusIcon, SearchIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";
import { commands, type IssuesState_Serialize, type IssueSummary, type Thread } from "./bindings";
import { Avatar } from "./Avatar";
import { IssueCreate } from "./IssueCreate";
import { IssueDetailView } from "./IssueDetailView";
import { IssueStateIcon } from "./IssueStateIcon";
import { issuePhase } from "./issueView";
import { LabelChip } from "./PullRequestPeople";
import { relativeTime } from "./pullRequestReview";
import { useAutoRefresh } from "./useAutoRefresh";

export interface IssuesSurfaceProps {
  projectId: number;
  /** Changes after the user's own actions that should reload the surface. */
  refreshKey?: number;
  /** Called after issue mutations (create/close/comment), so parent views can react if needed. */
  onChanged?: () => void;
  /** A Thread was started from an issue: the new Thread, for the sidebar. */
  onDispatched?: (thread: Thread) => void;
}

type Availability =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "guidance"; guidance: string }
  | { state: "ready"; issuesState: IssuesState_Serialize };

/** How long typing pauses before the search runs: every search is a `gh` call. */
const SEARCH_DELAY_MS = 350;

/** The repository's issues on GitHub, through `gh`. Like the Pull request tab it reloads by
 *  itself: when opened, after the user's own changes, when the window regains focus, and
 *  periodically while visible. State belongs to one Project, so a different one remounts it. */
export function IssuesSurface(props: IssuesSurfaceProps) {
  return <IssuesViews key={props.projectId} {...props} />;
}

function IssuesViews({ projectId, refreshKey = 0, onChanged, onDispatched }: IssuesSurfaceProps) {
  const tick = useAutoRefresh();
  const reload = refreshKey + tick;
  const [availability, setAvailability] = useState<Availability>({ state: "loading" });
  const [opened, setOpened] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  // Bumped after the list changed under it (a new issue, a closed one), beyond the timer.
  const [listRevision, setListRevision] = useState(0);

  useEffect(() => {
    let active = true;
    void commands.issuesState(projectId).then((result) => {
      if (!active) return;
      if (result.status === "error") {
        setAvailability({ state: "error", message: result.error.message });
      } else if (result.data.availability !== "ready") {
        setAvailability({
          state: "guidance",
          guidance: result.data.guidance ?? "The GitHub CLI is not ready.",
        });
      } else {
        setAvailability({ state: "ready", issuesState: result.data });
      }
    });
    return () => {
      active = false;
    };
  }, [projectId, reload]);

  const changed = () => {
    setListRevision((n) => n + 1);
    onChanged?.();
  };

  let content: React.ReactNode;
  if (availability.state === "loading") {
    content = <p className="pr-empty">Loading…</p>;
  } else if (availability.state === "error") {
    content = (
      <p role="alert" className="pr-empty error">
        {availability.message}
      </p>
    );
  } else if (availability.state === "guidance") {
    content = <p className="pr-empty">{availability.guidance}</p>;
  } else if (creating) {
    content = (
      <IssueCreate
        projectId={projectId}
        onBack={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          setOpened(created.number);
          changed();
        }}
      />
    );
  } else if (opened !== null) {
    content = (
      <IssueDetailView
        projectId={projectId}
        number={opened}
        refreshKey={reload}
        onBack={() => {
          setOpened(null);
          setListRevision((n) => n + 1);
        }}
        onChanged={changed}
        onDispatched={onDispatched}
      />
    );
  } else {
    content = (
      <IssueList
        projectId={projectId}
        refreshKey={reload + listRevision}
        onOpen={setOpened}
        onCreate={() => setCreating(true)}
      />
    );
  }

  return (
    <div className="pr-views">
      <section className="pr-panel pr-panel-flush" aria-label="Issues">
        {content}
      </section>
    </div>
  );
}

type List = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; issues: IssueSummary[] };

interface IssueListProps {
  projectId: number;
  refreshKey: number;
  onOpen: (number: number) => void;
  onCreate: () => void;
}

function IssueList({ projectId, refreshKey, onOpen, onCreate }: IssueListProps) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [closed, setClosed] = useState(false);
  const [mine, setMine] = useState(false);
  const [list, setList] = useState<List>({ state: "loading" });

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    void commands.listIssues(projectId, closed, mine, search).then((result) => {
      if (!active) return;
      setList(
        result.status === "ok"
          ? { state: "ready", issues: result.data }
          : { state: "error", message: result.error.message },
      );
    });
    return () => {
      active = false;
    };
  }, [projectId, closed, mine, search, refreshKey]);

  const filtered = search !== "" || mine;
  return (
    <div className="pr-browser">
      <form className="pr-search issue-search" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="pr-search-field">
          <SearchIcon size={14} />
          <input
            aria-label="Search issues"
            placeholder="Search issues"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </form>
      <div className="issue-new">
        <button className="primary" onClick={onCreate}>
          <PlusIcon size={16} /> New issue
        </button>
      </div>
      <div className="issue-filters">
        <div className="pr-seg" role="group" aria-label="State">
          <button aria-pressed={!closed} onClick={() => setClosed(false)}>
            Open
          </button>
          <button aria-pressed={closed} onClick={() => setClosed(true)}>
            Closed
          </button>
        </div>
        <button
          type="button"
          className="pr-chip"
          aria-pressed={mine}
          title="Only issues you opened"
          onClick={() => setMine((m) => !m)}
        >
          Mine
        </button>
      </div>
      <div className="pr-scroll">
        {list.state === "loading" && <p className="pr-empty">Loading…</p>}
        {list.state === "error" && (
          <p role="alert" className="pr-empty error">
            {list.message}
          </p>
        )}
        {list.state === "ready" && list.issues.length === 0 && (
          <p className="pr-empty">
            {filtered ? "No issues match." : closed ? "No closed issues." : "No open issues."}
          </p>
        )}
        {list.state === "ready" && list.issues.length > 0 && (
          <ul className="pr-list" aria-label={closed ? "Closed issues" : "Open issues"}>
            {list.issues.map((issue) => (
              <li key={issue.number}>
                <button className="pr-row" onClick={() => onOpen(issue.number)}>
                  <IssueStateIcon phase={issuePhase(issue)} />
                  <span className="pr-row-body">
                    <span className="pr-row-title">{issue.title}</span>
                    {issue.labels.length > 0 && (
                      <span className="pr-labels">
                        {issue.labels.map((l) => (
                          <LabelChip key={l.name} label={l} />
                        ))}
                      </span>
                    )}
                    <span className="pr-row-meta">
                      <Avatar login={issue.author} size={16} />
                      <span className="pr-row-author">{issue.author}</span>
                      <span aria-hidden>·</span>
                      <span>#{issue.number}</span>
                      {issue.createdAt && (
                        <>
                          <span aria-hidden>·</span>
                          <time dateTime={issue.createdAt}>{relativeTime(issue.createdAt)}</time>
                        </>
                      )}
                      {issue.commentsCount > 0 && (
                        <span className="issue-comments" title={`${issue.commentsCount} comments`}>
                          <CommentIcon size={12} /> {issue.commentsCount}
                        </span>
                      )}
                    </span>
                  </span>
                  {issue.assignees.length > 0 && (
                    <span className="issue-assignees" title={`Assigned to ${issue.assignees.join(", ")}`}>
                      {issue.assignees.slice(0, 3).map((login) => (
                        <Avatar key={login} login={login} size={18} />
                      ))}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
