CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`timestamp` text NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE TABLE `run_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`step_name` text NOT NULL,
	`timestamp` text NOT NULL,
	`state` text NOT NULL
);
