/** Cache prefixes shared by the Diff Surface's pull request views, so a mutation refreshes its owner. */

/** A Project's GitHub review threads, keyed further by Diff scope and pull request. */
export const reviewThreadsPrefix = (projectId: number) => `p${projectId}:review-threads:`;

/** A Project's draft review comments, keyed further by pull request. */
export const pullRequestCommentsPrefix = (projectId: number) => `p${projectId}:pr-comments:`;
