export interface DiscordBotConfig {
  token: string;
  daemon_url: string;
  daemon_token?: string;
  allowed_channel_ids?: string[];
  notification_channel_id?: string;
}

/** Maps a Discord channel ID to a repository for the channel=repo paradigm. */
export interface ChannelRepoMapping {
  channel_id: string;
  repo: string;
  workflow?: string;
}

/** Reaction-based control emoji constants. */
export const REACTION_CONTROLS = {
  CANCEL: "\u274c",       // ❌
  RETRY: "\ud83d\udd01",  // 🔁
  APPROVE: "\u2705",      // ✅
  REJECT: "\ud83d\udeab", // 🚫
  PAUSE: "\u23f8\ufe0f",  // ⏸️
  LOGS: "\ud83d\udcdc",   // 📜
} as const;

export type ReactionControl = typeof REACTION_CONTROLS[keyof typeof REACTION_CONTROLS];

/** Thread lifecycle state for task tracking. */
export interface ThreadLifecycle {
  runId: string;
  threadId: string;
  channelId: string;
  repo?: string;
  task: string;
  status: "dispatched" | "running" | "validating" | "completed" | "failed" | "cancelled" | "paused";
  userId: string;
  createdAt: number;
  updatedAt: number;
}
