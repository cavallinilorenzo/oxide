// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "./bindings";
import { PullRequestCreate } from "./PullRequestCreate";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
beforeEach(() => {
  vi.spyOn(commands, "gitStatus").mockResolvedValue({
    status: "ok",
    data: {
      branch: "fix/topic",
      upstream: null,
      ahead: 1,
      behind: 0,
      added: 0,
      removed: 0,
      changedFiles: 0,
      protected: false,
      unpublished: true,
      pickerDisabledReason: null,
    },
  });
  vi.spyOn(commands, "pullRequestDraft").mockResolvedValue({
    status: "ok",
    data: {
      title: "Fix topic",
      body: "Tested locally",
      base: "main",
      head: "fix/topic",
    },
  });
  vi.spyOn(commands, "dossierPullRequestSection").mockResolvedValue({
    status: "ok",
    data: {
      markdown:
        "<!-- oxide:dossier:start -->\nfacts\n<!-- oxide:dossier:end -->",
      visibility: "public",
      headSha: "abc123",
    },
  });
  vi.spyOn(commands, "pullRequestBaseBranches").mockResolvedValue({
    status: "ok",
    data: ["main", "dev", "fix/topic"],
  });
});
afterEach(async () => {
  await act(async () => root.render(null));
  vi.restoreAllMocks();
});

it("submits a prefilled draft and keeps the form and diagnostics when the push fails", async () => {
  const created = vi.fn();
  const create = vi.spyOn(commands, "createPullRequest").mockResolvedValue({
    status: "error",
    error: { message: "non-fast-forward [rejected]" },
  });
  await act(async () =>
    root.render(
      <PullRequestCreate
        projectId={1}
        threadId={7}
        onCancel={() => {}}
        onCreated={created}
      />,
    ),
  );
  expect(
    host.querySelector<HTMLInputElement>(".pr-create-title input")?.value,
  ).toBe("Fix topic");
  await act(async () =>
    host.querySelector<HTMLInputElement>(".pr-create-draft input")!.click(),
  );
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(create).toHaveBeenCalledWith(1, 7, {
    title: "Fix topic",
    body: "Tested locally",
    base: "main",
    draft: true,
    dossierSection:
      "<!-- oxide:dossier:start -->\nfacts\n<!-- oxide:dossier:end -->",
    dossierIncludePrompts: false,
    dossierIncludeAgentMessage: false,
    dossierHeadSha: "abc123",
  });
  expect(created).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "couldn’t be pushed",
  );
  expect(
    host.querySelector<HTMLInputElement>(".pr-create-title input")?.value,
  ).toBe("Fix topic");
  const pr = {
    number: 12,
    title: "Fix topic",
    body: "",
    author: "me",
    url: "",
    head: "fix/topic",
    base: "main",
    draft: true,
    createdAt: "",
  };
  create.mockResolvedValue({ status: "ok", data: pr });
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(created).toHaveBeenCalledWith(pr);
});

it("blocks PR creation from main before loading defaults or pushing", async () => {
  const status = await commands.gitStatus(1, 7);
  if (status.status !== "ok") throw new Error("fixture");
  vi.mocked(commands.gitStatus).mockResolvedValue({
    status: "ok",
    data: { ...status.data, branch: "main", protected: true },
  });
  await act(async () =>
    root.render(
      <PullRequestCreate
        projectId={1}
        threadId={7}
        onCancel={() => {}}
        onCreated={() => {}}
      />,
    ),
  );
  expect(host.textContent).toContain("create a branch");
  expect(commands.pullRequestDraft).not.toHaveBeenCalled();
  expect(host.querySelector('[type="submit"]')).toBeNull();
});

const pullRequest = {
  number: 12,
  title: "Fix topic",
  body: "",
  author: "me",
  url: "",
  head: "fix/topic",
  base: "main",
  draft: false,
  createdAt: "",
};

async function open(threadId: number | null) {
  await act(async () =>
    root.render(
      <PullRequestCreate
        projectId={1}
        threadId={threadId}
        onCancel={() => {}}
        onCreated={() => {}}
      />,
    ),
  );
}

async function submit() {
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

it("previews the Dossier with the repository's visibility, publishes what was edited and offers prompts only as an opt-in", async () => {
  const create = vi
    .spyOn(commands, "createPullRequest")
    .mockResolvedValue({ status: "ok", data: pullRequest });
  await open(7);
  expect(commands.dossierPullRequestSection).toHaveBeenLastCalledWith(
    1,
    7,
    false,
    false,
  );
  expect(host.querySelector(".pr-create-visibility")?.textContent).toContain(
    "public",
  );
  const preview = [...host.querySelectorAll("textarea")].find((area) =>
    area.value.includes("facts"),
  )!;
  expect(preview).toBeTruthy();

  const prompts = [...host.querySelectorAll<HTMLInputElement>("input")].find(
    (input) => input.parentElement?.textContent?.includes("my prompts"),
  )!;
  await act(async () => prompts.click());
  expect(commands.dossierPullRequestSection).toHaveBeenLastCalledWith(
    1,
    7,
    true,
    false,
  );
  await submit();
  expect(create.mock.calls[0][2].dossierSection).toContain("facts");
});

it("declining the Dossier publishes the description as written", async () => {
  const create = vi
    .spyOn(commands, "createPullRequest")
    .mockResolvedValue({ status: "ok", data: pullRequest });
  await open(7);
  const toggle = [...host.querySelectorAll<HTMLInputElement>("input")].find(
    (input) => input.parentElement?.textContent?.includes("Add the Dossier"),
  )!;
  await act(async () => toggle.click());
  await submit();
  expect(create.mock.calls[0][2].dossierSection).toBeNull();
});

it("offers no Dossier outside a Thread", async () => {
  const create = vi
    .spyOn(commands, "createPullRequest")
    .mockResolvedValue({ status: "ok", data: pullRequest });
  await open(null);
  expect(commands.dossierPullRequestSection).not.toHaveBeenCalled();
  expect(host.querySelector(".pr-create-dossier")).toBeNull();
  await submit();
  expect(create.mock.calls[0][2].dossierSection).toBeNull();
});
