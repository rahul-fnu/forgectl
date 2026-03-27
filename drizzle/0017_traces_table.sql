CREATE TABLE `spans` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `trace_id` text NOT NULL,
  `span_id` text NOT NULL,
  `parent_span_id` text,
  `name` text NOT NULL,
  `start_ms` integer NOT NULL,
  `end_ms` integer,
  `status` text NOT NULL DEFAULT 'running',
  `attributes` text
);
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `trace_id` TEXT;
