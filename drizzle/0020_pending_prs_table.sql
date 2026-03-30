CREATE TABLE IF NOT EXISTS `pending_prs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`branch` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`resolved_at` text
);
