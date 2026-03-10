import type { App } from "@octokit/app";

/**
 * Register webhook event handlers on the GitHub App.
 * These are skeleton handlers that log events for now.
 * Actual logic will be implemented in Plans 02-04.
 */
export function registerWebhookHandlers(app: App): void {
  app.webhooks.on("issues.labeled", async ({ payload }) => {
    const { issue, label, repository } = payload;
    app.log.info(
      `[github] issues.labeled: ${repository.full_name}#${issue.number} labeled "${label?.name}"`
    );
  });

  app.webhooks.on("issues.opened", async ({ payload }) => {
    const { issue, repository } = payload;
    app.log.info(
      `[github] issues.opened: ${repository.full_name}#${issue.number} "${issue.title}"`
    );
  });

  app.webhooks.on("issue_comment.created", async ({ payload }) => {
    const { comment, issue, repository } = payload;
    app.log.info(
      `[github] issue_comment.created: ${repository.full_name}#${issue.number} by ${comment.user?.login ?? "unknown"}`
    );
  });

  app.webhooks.on("issue_comment.deleted", async ({ payload }) => {
    const { comment, issue, repository } = payload;
    app.log.info(
      `[github] issue_comment.deleted: ${repository.full_name}#${issue.number} comment ${comment.id}`
    );
  });
}
