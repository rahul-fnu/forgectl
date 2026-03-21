CREATE TABLE `run_retries` (
  `run_id` TEXT NOT NULL,
  `attempt` INTEGER NOT NULL,
  `next_retry_at` TEXT,
  `backoff_ms` INTEGER,
  `failure_reason` TEXT,
  `created_at` TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (`run_id`, `attempt`)
);
