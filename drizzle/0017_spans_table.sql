CREATE TABLE IF NOT EXISTS `spans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text,
	`operation_name` text NOT NULL,
	`start_ms` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`attributes` text
);
