CREATE TABLE IF NOT EXISTS `review_metrics` (
	`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` TEXT NOT NULL,
	`pr_number` INTEGER NOT NULL,
	`review_round` INTEGER NOT NULL DEFAULT 1,
	`review_comments_count` INTEGER NOT NULL DEFAULT 0,
	`review_must_fix` INTEGER NOT NULL DEFAULT 0,
	`review_should_fix` INTEGER NOT NULL DEFAULT 0,
	`review_nit` INTEGER NOT NULL DEFAULT 0,
	`review_approved_round` INTEGER,
	`review_escalated` INTEGER NOT NULL DEFAULT 0,
	`final_outcome` TEXT,
	`human_override` INTEGER NOT NULL DEFAULT 0,
	`created_at` TEXT NOT NULL,
	`updated_at` TEXT NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `review_metrics_repo_pr_number_review_round_unique` ON `review_metrics` (`repo`, `pr_number`, `review_round`);
