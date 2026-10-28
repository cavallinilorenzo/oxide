import {
  CommentDiscussionIcon,
  FileDiffIcon,
  GitPullRequestIcon,
  PlusIcon,
  ProjectIcon,
  RepoIcon,
} from "@primer/octicons-react";
import type { Project, Thread } from "./bindings";
import { relativeAge, threadTitle } from "./threadList";

export function ProjectOverview({
  project,
  threads,
  onNewThread,
  onOpenThread,
  onOpenBoard,
  onOpenDiff,
  onOpenPullRequest,
}: {
  project: Project;
  threads: Thread[];
  onNewThread: () => void;
  onOpenThread: (id: number) => void;
  onOpenBoard: () => void;
  onOpenDiff: () => void;
  onOpenPullRequest: () => void;
}) {
  const working = threads.filter((t) => t.status === "working").length;
  const needsInput = threads.filter((t) =>
    ["needs-input", "error", "interrupted"].includes(t.status),
  ).length;
  return (
    <main className="project-overview" aria-label="Project overview">
      <div className="project-overview-content">
        <RepoIcon size={28} className="project-overview-mark" />
        <h1>{project.name}</h1>
        <p className="project-overview-path" title={project.path}>
          {project.path}
        </p>
        <p className="project-overview-intro">
          {threads.length === 0
            ? "A clear space for your next idea. Start a Thread to work with your coding Provider."
            : "Pick up where you left off, or start something new."}
        </p>
        <div className="project-overview-actions">
          <button
            className="btn primary"
            disabled={project.missing}
            onClick={onNewThread}
          >
            <PlusIcon size={16} /> New Thread
          </button>
          <button className="btn" onClick={onOpenBoard}>
            <ProjectIcon size={16} /> Thread Board
          </button>
        </div>
        {project.missing && (
          <p role="alert" className="error">
            This Project’s folder is missing. Reconnect it from the Project
            palette.
          </p>
        )}
        <div className="project-overview-summary" aria-label="Thread summary">
          <span>{threads.length} Threads</span>
          <span>{working} working</span>
          <span>{needsInput} need input</span>
        </div>
        {threads.length > 0 && (
          <section className="project-overview-recent">
            <h2>Recent Threads</h2>
            <ul>
              {threads.slice(0, 5).map((thread) => (
                <li key={thread.id}>
                  <button onClick={() => onOpenThread(thread.id)}>
                    <CommentDiscussionIcon size={16} />
                    <span>{threadTitle(thread)}</span>
                    <span className="dim">{thread.status}</span>
                    <time className="dim">{relativeAge(thread.updatedAt)}</time>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <nav className="project-overview-links" aria-label="Project tools">
          <button onClick={onOpenDiff}>
            <FileDiffIcon size={16} /> Review changes
          </button>
          <button onClick={onOpenPullRequest}>
            <GitPullRequestIcon size={16} /> Pull requests
          </button>
        </nav>
      </div>
    </main>
  );
}
