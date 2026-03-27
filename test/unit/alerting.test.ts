import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { signPayload, dispatchWebhook } from "../../src/alerting/webhook.js";
import { formatSlackBlocks, dispatchSlack } from "../../src/alerting/slack.js";
import { AlertManager } from "../../src/alerting/manager.js";
import type { AlertEvent, WebhookTarget } from "../../src/alerting/types.js";

function makeEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    type: overrides.type ?? "run_failed",
    timestamp: overrides.timestamp ?? "2026-03-27T00:00:00.000Z",
    runId: overrides.runId ?? "run-123",
    issueIdentifier: overrides.issueIdentifier ?? "TEST-1",
    message: overrides.message ?? "Test alert",
    metadata: overrides.metadata,
  };
}

describe("webhook", () => {
  describe("signPayload", () => {
    it("produces correct HMAC-SHA256 hex digest", () => {
      const payload = '{"type":"run_failed"}';
      const secret = "my-secret";
      const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      expect(signPayload(payload, secret)).toBe(expected);
    });

    it("produces different signatures for different secrets", () => {
      const payload = '{"type":"run_failed"}';
      expect(signPayload(payload, "secret-a")).not.toBe(signPayload(payload, "secret-b"));
    });
  });

  describe("dispatchWebhook", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("sends POST with correct payload shape", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
      const target: WebhookTarget = { url: "https://example.com/hook", events: ["run_failed"], secret: "s3cret" };
      const event = makeEvent();

      await dispatchWebhook(target, event);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://example.com/hook");
      expect(opts?.method).toBe("POST");

      const body = JSON.parse(opts?.body as string);
      expect(body.type).toBe("run_failed");
      expect(body.runId).toBe("run-123");
      expect(body.timestamp).toBe("2026-03-27T00:00:00.000Z");
      expect(body.issueIdentifier).toBe("TEST-1");
      expect(body.message).toBe("Test alert");
    });

    it("includes HMAC signature header when secret is set", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
      const target: WebhookTarget = { url: "https://example.com/hook", events: ["run_failed"], secret: "s3cret" };
      const event = makeEvent();

      await dispatchWebhook(target, event);

      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers["X-Forgectl-Signature"]).toBeDefined();
      const expectedSig = signPayload(JSON.stringify(event), "s3cret");
      expect(headers["X-Forgectl-Signature"]).toBe(expectedSig);
    });

    it("omits signature header when no secret", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
      const target: WebhookTarget = { url: "https://example.com/hook", events: ["run_failed"] };
      await dispatchWebhook(target, makeEvent());

      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers["X-Forgectl-Signature"]).toBeUndefined();
    });

    it("skips dispatch when event type not in target events", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
      const target: WebhookTarget = { url: "https://example.com/hook", events: ["run_completed"] };
      await dispatchWebhook(target, makeEvent({ type: "run_failed" }));

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

describe("slack", () => {
  describe("formatSlackBlocks", () => {
    it("uses red sidebar for run_failed", () => {
      const result = formatSlackBlocks(makeEvent({ type: "run_failed" }));
      const attachments = result.attachments as Array<{ color: string }>;
      expect(attachments[0].color).toBe("#a30200");
    });

    it("uses green sidebar for run_completed", () => {
      const result = formatSlackBlocks(makeEvent({ type: "run_completed" }));
      const attachments = result.attachments as Array<{ color: string }>;
      expect(attachments[0].color).toBe("#2eb886");
    });

    it("uses orange sidebar for cost_ceiling_hit", () => {
      const result = formatSlackBlocks(makeEvent({ type: "cost_ceiling_hit" }));
      const attachments = result.attachments as Array<{ color: string }>;
      expect(attachments[0].color).toBe("#daa038");
    });

    it("uses orange sidebar for usage_limit_detected", () => {
      const result = formatSlackBlocks(makeEvent({ type: "usage_limit_detected" }));
      const attachments = result.attachments as Array<{ color: string }>;
      expect(attachments[0].color).toBe("#daa038");
    });

    it("uses orange sidebar for review_escalated", () => {
      const result = formatSlackBlocks(makeEvent({ type: "review_escalated" }));
      const attachments = result.attachments as Array<{ color: string }>;
      expect(attachments[0].color).toBe("#daa038");
    });

    it("includes event type and run ID in fields", () => {
      const result = formatSlackBlocks(makeEvent());
      const attachments = result.attachments as Array<{ blocks: Array<{ fields?: Array<{ text: string }> }> }>;
      const fields = attachments[0].blocks[1].fields!;
      expect(fields.some((f) => f.text.includes("run_failed"))).toBe(true);
      expect(fields.some((f) => f.text.includes("run-123"))).toBe(true);
    });

    it("includes issue identifier when present", () => {
      const result = formatSlackBlocks(makeEvent({ issueIdentifier: "PROJ-42" }));
      const attachments = result.attachments as Array<{ blocks: Array<{ fields?: Array<{ text: string }> }> }>;
      const fields = attachments[0].blocks[1].fields!;
      expect(fields.some((f) => f.text.includes("PROJ-42"))).toBe(true);
    });

    it("includes message in section text", () => {
      const result = formatSlackBlocks(makeEvent({ message: "Something broke" }));
      const attachments = result.attachments as Array<{ blocks: Array<{ text?: { text: string } }> }>;
      expect(attachments[0].blocks[0].text?.text).toBe("Something broke");
    });
  });

  describe("dispatchSlack", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("sends formatted payload to Slack webhook URL", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
      await dispatchSlack("https://hooks.slack.com/test", makeEvent());

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://hooks.slack.com/test");
      const body = JSON.parse(opts?.body as string);
      expect(body.attachments).toBeDefined();
      expect(body.attachments[0].color).toBe("#a30200");
    });
  });
});

describe("AlertManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches to matching webhooks and Slack", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const manager = new AlertManager({
      webhooks: [
        { url: "https://hook1.example.com", events: ["run_failed", "run_completed"] },
        { url: "https://hook2.example.com", events: ["run_completed"], secret: "abc" },
      ],
      slack_webhook_url: "https://hooks.slack.com/test",
    });

    await manager.fire(makeEvent({ type: "run_failed" }));

    // hook1 matches run_failed, hook2 does not, Slack always fires
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://hook1.example.com");
    expect(urls).toContain("https://hooks.slack.com/test");
  });

  it("swallows errors from failing webhooks", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));
    const manager = new AlertManager({
      webhooks: [{ url: "https://hook.example.com", events: ["run_failed"] }],
    });

    // Should not throw
    await manager.fire(makeEvent());
  });

  it("does nothing when no webhooks or Slack configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const manager = new AlertManager({});

    await manager.fire(makeEvent());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("filters webhooks by event type", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const manager = new AlertManager({
      webhooks: [
        { url: "https://hook.example.com", events: ["cost_ceiling_hit"] },
      ],
    });

    await manager.fire(makeEvent({ type: "run_completed" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
