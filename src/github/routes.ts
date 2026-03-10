import type { FastifyInstance } from "fastify";
import type { GitHubAppService } from "./app.js";

/**
 * Register GitHub webhook routes on a Fastify instance.
 *
 * Uses an encapsulated plugin to scope the raw-body content type parser
 * to the webhook prefix only, preventing it from breaking JSON parsing
 * on other routes.
 */
export function registerGitHubRoutes(
  fastify: FastifyInstance,
  appService: GitHubAppService
): void {
  // Use fastify.register to encapsulate the content type parser
  void fastify.register(async function githubWebhookPlugin(instance) {
    // Override the JSON content-type parser within this plugin scope
    // to preserve the raw string body needed for HMAC verification
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body, done) => {
        done(null, body);
      }
    );

    instance.post("/api/v1/github/webhook", async (request, reply) => {
      const id = request.headers["x-github-delivery"] as string;
      const name = request.headers["x-github-event"] as string;
      const signature = request.headers["x-hub-signature-256"] as string;
      const rawBody = request.body as string;

      if (!id || !name || !signature) {
        return reply.status(400).send({
          error: {
            code: "MISSING_HEADERS",
            message:
              "Missing required GitHub webhook headers (x-github-delivery, x-github-event, x-hub-signature-256)",
          },
        });
      }

      try {
        await appService.app.webhooks.verifyAndReceive({
          id,
          name: name as Parameters<
            typeof appService.app.webhooks.verifyAndReceive
          >[0]["name"],
          payload: rawBody,
          signature,
        });

        return reply.status(200).send({ ok: true });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";

        // Signature verification failures from @octokit/webhooks
        if (message.includes("signature") || message.includes("Signature")) {
          return reply.status(401).send({
            error: {
              code: "INVALID_SIGNATURE",
              message: "Webhook signature verification failed",
            },
          });
        }

        return reply.status(500).send({
          error: {
            code: "WEBHOOK_ERROR",
            message: `Webhook processing error: ${message}`,
          },
        });
      }
    });
  });
}
