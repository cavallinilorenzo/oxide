/** Keep CLI diagnostics available while giving the user a concrete next step. */
export function describeCreatePrError(message: string, base: string) {
  if (/no commits between/i.test(message)) {
    return {
      title: "No commits to compare",
      guidance: `This branch has no new commits compared with ${base}. Commit your changes or choose a different base branch, then try again.`,
    };
  }
  if (/pull request .*already exists/i.test(message)) {
    return {
      title: "A pull request already exists",
      guidance: "Reload from GitHub to open this branch’s existing pull request.",
    };
  }
  if (/not logged|authentication|gh auth login|bad credentials|HTTP 401/i.test(message)) {
    return {
      title: "GitHub authentication required",
      guidance: "Run gh auth login in the terminal, then try again.",
    };
  }
  if (/could not resolve|failed to connect|network is unreachable|connection refused|connection reset|i\/o timeout|TLS handshake timeout/i.test(message)) {
    return {
      title: "Couldn’t reach GitHub",
      guidance: "Check your connection, then try again.",
    };
  }
  if (/permission denied|not accessible by integration|resource not accessible|HTTP 403|must be a collaborator/i.test(message)) {
    return {
      title: "GitHub denied access",
      guidance: "Check that your GitHub account has permission to push to this repository and open pull requests.",
    };
  }
  if (/non-fast-forward|\[rejected\]|updates were rejected/i.test(message)) {
    return {
      title: "The branch couldn’t be pushed",
      guidance: "Sync your branch with its remote and resolve any conflicts, then try again.",
    };
  }
  return {
    title: "Couldn’t create the pull request",
    guidance: "Review the details below, resolve the reported problem, then try again.",
  };
}
