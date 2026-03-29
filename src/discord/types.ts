export interface DiscordBotConfig {
  token: string;
  daemon_url: string;
  daemon_token?: string;
  allowed_channel_ids?: string[];
  notification_channel_id?: string;
}
