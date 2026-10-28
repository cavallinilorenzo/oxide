import { CheckCircleFillIcon, ChevronDownIcon, DotFillIcon, LinkExternalIcon, XCircleFillIcon } from "@primer/octicons-react";
import type { PullRequestCheck } from "./bindings";
import { countChecks, dedupeChecks } from "./pullRequestReview";

const CHECK_WORD = { success: "Passed", failure: "Failed", pending: "Running" } as const;

/** Checks in a box: what needs attention is listed, what passed folds into one row you can open.
 *  A check with a link opens its run on GitHub, to see what went wrong. */
export function Checks({ checks, onOpen }: { checks: PullRequestCheck[]; onOpen: (url: string) => void }) {
  const { failing, pending, passing } = countChecks(checks);
  const all = dedupeChecks(checks);
  // Once branch protection names required checks, the others are shown but do not count.
  const hasRequired = checks.some((c) => c.required);
  if (all.length === 0) return null;
  const attention = all.filter((c) => c.state !== "success");
  const passed = all.filter((c) => c.state === "success");
  const summary = [
    failing > 0 && `${failing} failing`,
    pending > 0 && `${pending} running`,
    passing > 0 && `${passing} passed`,
  ]
    .filter(Boolean)
    .join(" · ");
  const inline = attention.length === 0 && passed.length <= 3;
  return (
    <section className="pr-box pr-checks-box" aria-label="Checks">
      <header>
        <h4>Checks</h4>
        <span className="pr-checks-summary">{summary}</span>
        <span className="pr-bar" role="img" aria-label={`${failing} failing, ${pending} running, ${passing} passing`}>
          {failing > 0 && <i className="failure" style={{ flexGrow: failing }} />}
          {pending > 0 && <i className="pending" style={{ flexGrow: pending }} />}
          {passing > 0 && <i className="success" style={{ flexGrow: passing }} />}
        </span>
      </header>
      {attention.length > 0 && (
        <ul className="pr-checks">
          {attention.map((c) => (
            <CheckRow key={c.name} check={c} optional={hasRequired && !c.required} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {passed.length > 0 &&
        (inline ? (
          <ul className="pr-checks">
            {passed.map((c) => (
              <CheckRow key={c.name} check={c} optional={hasRequired && !c.required} onOpen={onOpen} />
            ))}
          </ul>
        ) : (
          <details className="pr-passed">
            <summary>
              <CheckCircleFillIcon size={14} className="pr-check-success" />
              {attention.length > 0 ? `${passed.length} passed` : `All ${passed.length} passed`}
              <ChevronDownIcon size={14} className="pr-chev" />
            </summary>
            <ul className="pr-checks">
              {passed.map((c) => (
                <CheckRow key={c.name} check={c} optional={hasRequired && !c.required} onOpen={onOpen} />
              ))}
            </ul>
          </details>
        ))}
    </section>
  );
}

function CheckRow({ check, optional, onOpen }: { check: PullRequestCheck; optional: boolean; onOpen: (url: string) => void }) {
  const icon =
    check.state === "success" ? (
      <CheckCircleFillIcon size={14} />
    ) : check.state === "failure" ? (
      <XCircleFillIcon size={14} />
    ) : (
      <DotFillIcon size={14} className="pr-pulse" />
    );
  const body = (
    <>
      {icon}
      <span className="pr-check-name">{check.name}</span>
      {optional && <span className="pr-check-optional">Not required</span>}
      <span className="pr-check-state">{CHECK_WORD[check.state]}</span>
      {check.url && <LinkExternalIcon size={12} className="pr-check-open" />}
    </>
  );
  const url = check.url;
  return (
    <li className={`pr-check pr-check-${check.state}`}>
      {url ? (
        <button
          className="pr-check-link"
          title={check.state === "failure" ? "See what went wrong on GitHub" : "Open on GitHub"}
          aria-label={`${check.name}: ${CHECK_WORD[check.state]}. Open on GitHub`}
          onClick={() => onOpen(url)}
        >
          {body}
        </button>
      ) : (
        <div className="pr-check-link">{body}</div>
      )}
    </li>
  );
}
