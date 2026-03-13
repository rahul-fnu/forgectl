ALTER TABLE `runs` ADD `parent_run_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `role` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `depth` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `runs` ADD `max_children` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `children_dispatched` integer DEFAULT 0;--> statement-breakpoint
CREATE TABLE `delegations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_run_id` text NOT NULL,
	`child_run_id` text,
	`task_spec` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`result` text,
	`retry_count` integer NOT NULL DEFAULT 0,
	`last_error` text,
	`created_at` text NOT NULL,
	`completed_at` text
);--> statement-breakpoint
CREATE INDEX `delegations_parent_run_id_idx` ON `delegations` (`parent_run_id`);--> statement-breakpoint
CREATE INDEX `delegations_child_run_id_idx` ON `delegations` (`child_run_id`);
