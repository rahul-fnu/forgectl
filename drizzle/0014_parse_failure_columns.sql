ALTER TABLE `review_metrics` ADD COLUMN `parse_failure_count` INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `review_metrics` ADD COLUMN `parse_success_count` INTEGER NOT NULL DEFAULT 0;
