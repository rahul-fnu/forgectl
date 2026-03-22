ALTER TABLE `run_outcomes` ADD COLUMN `context_enabled` INTEGER;
--> statement-breakpoint
ALTER TABLE `run_outcomes` ADD COLUMN `context_files_json` TEXT;
