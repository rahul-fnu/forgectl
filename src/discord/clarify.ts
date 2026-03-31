/**
 * Discord clarification flow — routes agent questions through Discord threads.
 *
 * When an agent needs clarification (detected from output patterns or explicit
 * clarification signals), the bot posts the question in a Discord thread and
 * waits for a reply. The reply is forwarded back to the agent prompt.
 */

// Generic clarification utilities live in src/agent/clarify.ts.
// Re-export them here for backward compatibility.
export {
  CLARIFICATION_PATTERNS,
  detectClarificationNeed,
  extractQuestion,
} from "../agent/clarify.js";
export type { ClarificationCallback } from "../agent/clarify.js";
import type { ClarificationCallback } from "../agent/clarify.js";

/** Default timeout for waiting on a Discord reply (30 minutes). */
export const DEFAULT_CLARIFICATION_TIMEOUT_MS = 30 * 60 * 1000;

/** Minimal Discord client interface for testability. */
export interface DiscordClient {
  sendMessageToThread(
    threadId: string,
    content: string,
    options?: MessageOptions,
  ): Promise<string>;
  waitForReply(
    threadId: string,
    timeoutMs: number,
  ): Promise<DiscordReply | null>;
}

export interface MessageOptions {
  mentionUserId?: string;
  components?: ButtonRow[];
}

export interface ButtonRow {
  buttons: ButtonDef[];
}

export interface ButtonDef {
  label: string;
  customId: string;
  style: "primary" | "secondary" | "success" | "danger";
}

export interface DiscordReply {
  content: string;
  userId: string;
  isButtonInteraction: boolean;
  buttonCustomId?: string;
}

/**
 * Result of a clarification request through Discord.
 */
export interface ClarificationResult {
  answered: boolean;
  answer?: string;
  skipped: boolean;
  timedOut: boolean;
}

/**
 * Clarification button custom IDs.
 */
export const BUTTON_IDS = {
  APPROVE: "forgectl_approve",
  REJECT: "forgectl_reject",
  RETRY: "forgectl_retry",
  SKIP: "forgectl_skip",
} as const;

/**
 * Build the standard button rows for a clarification message.
 */
export function buildClarificationButtons(): ButtonRow {
  return {
    buttons: [
      { label: "Skip", customId: BUTTON_IDS.SKIP, style: "secondary" },
    ],
  };
}

/**
 * Build button rows for PR review notifications.
 */
export function buildReviewButtons(): ButtonRow {
  return {
    buttons: [
      { label: "Approve", customId: BUTTON_IDS.APPROVE, style: "success" },
      { label: "Reject", customId: BUTTON_IDS.REJECT, style: "danger" },
    ],
  };
}

/**
 * Build button rows for failed run notifications.
 */
export function buildFailedRunButtons(): ButtonRow {
  return {
    buttons: [
      { label: "Retry", customId: BUTTON_IDS.RETRY, style: "primary" },
    ],
  };
}

/**
 * Route a clarification question through a Discord thread.
 *
 * 1. Posts the question in the thread with a mention
 * 2. Waits for a reply (text or button) with timeout
 * 3. Returns the result
 */
export async function requestClarificationViaDiscord(
  client: DiscordClient,
  threadId: string,
  question: string,
  mentionUserId?: string,
  timeoutMs: number = DEFAULT_CLARIFICATION_TIMEOUT_MS,
): Promise<ClarificationResult> {
  const mention = mentionUserId ? `<@${mentionUserId}> ` : "";
  const messageContent = `${mention}The agent is asking:\n> ${question}`;

  await client.sendMessageToThread(threadId, messageContent, {
    mentionUserId,
    components: [buildClarificationButtons()],
  });

  const reply = await client.waitForReply(threadId, timeoutMs);

  if (!reply) {
    await client.sendMessageToThread(
      threadId,
      "No response received. Agent will proceed with its best judgment.",
    );
    return { answered: false, skipped: false, timedOut: true };
  }

  if (reply.isButtonInteraction && reply.buttonCustomId === BUTTON_IDS.SKIP) {
    return { answered: false, skipped: true, timedOut: false };
  }

  return {
    answered: true,
    answer: reply.content,
    skipped: false,
    timedOut: false,
  };
}

/**
 * Create a ClarificationCallback wired to a Discord thread.
 */
export function createDiscordClarificationCallback(
  client: DiscordClient,
  threadId: string,
  mentionUserId?: string,
  timeoutMs?: number,
): ClarificationCallback {
  return async (question: string): Promise<string | undefined> => {
    const result = await requestClarificationViaDiscord(
      client,
      threadId,
      question,
      mentionUserId,
      timeoutMs,
    );
    return result.answered ? result.answer : undefined;
  };
}

/**
 * Handle button interactions for PR review and failed run notifications.
 */
export function resolveButtonAction(
  customId: string,
): { action: "approve" | "reject" | "retry" | "skip"; } | undefined {
  switch (customId) {
    case BUTTON_IDS.APPROVE:
      return { action: "approve" };
    case BUTTON_IDS.REJECT:
      return { action: "reject" };
    case BUTTON_IDS.RETRY:
      return { action: "retry" };
    case BUTTON_IDS.SKIP:
      return { action: "skip" };
    default:
      return undefined;
  }
}
