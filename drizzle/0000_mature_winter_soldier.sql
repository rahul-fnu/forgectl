CREATE TABLE `pipeline_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`pipeline_definition` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`node_states` text,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`workflow` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`options` text,
	`submitted_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`result` text,
	`error` text
);
