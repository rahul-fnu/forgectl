CREATE TABLE `execution_locks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lock_type` text NOT NULL,
	`lock_key` text NOT NULL,
	`owner_id` text NOT NULL,
	`daemon_pid` integer NOT NULL,
	`acquired_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_locks_lock_type_lock_key_unique` ON `execution_locks` (`lock_type`,`lock_key`);--> statement-breakpoint
ALTER TABLE `runs` ADD `pause_reason` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `pause_context` text;