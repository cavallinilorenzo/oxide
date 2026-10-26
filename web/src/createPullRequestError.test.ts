import { expect, it } from "vitest";
import { describeCreatePrError } from "./createPullRequestError";

it.each([
  ["GraphQL: No commits between main and fix/ui (createPullRequest)", "No commits to compare"],
  ["a pull request for branch fix/ui into branch main already exists", "A pull request already exists"],
  ["HTTP 401: Bad credentials", "GitHub authentication required"],
  ["dial tcp: lookup api.github.com: i/o timeout", "Couldn’t reach GitHub"],
  ["HTTP 403: Resource not accessible by integration", "GitHub denied access"],
  ["! [rejected] fix/ui -> fix/ui (fetch first)", "The branch couldn’t be pushed"],
  ["an unfamiliar service error", "Couldn’t create the pull request"],
])("explains %s", (message, title) => {
  expect(describeCreatePrError(message, "main").title).toBe(title);
});

it("uses the selected base branch in the no-commits recovery", () => {
  expect(describeCreatePrError("No commits between develop and fix/ui", "develop").guidance)
    .toContain("compared with develop");
});
