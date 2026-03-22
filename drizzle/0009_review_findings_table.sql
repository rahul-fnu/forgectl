CREATE TABLE `review_findings` (
	`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` TEXT NOT NULL,
	`pattern` TEXT NOT NULL,
	`module` TEXT NOT NULL,
	`occurrence_count` INTEGER NOT NULL DEFAULT 1,
	`first_seen` TEXT NOT NULL,
	`last_seen` TEXT NOT NULL,
	`promoted_to_convention` INTEGER NOT NULL DEFAULT 0,
	`example_comment` TEXT
);--> statement-breakpoint
CREATE UNIQUE INDEX `review_findings_category_pattern_module_unique` ON `review_findings` (`category`, `pattern`, `module`);--> statement-breakpoint
CREATE TABLE `review_calibration` (
	`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	`module` TEXT NOT NULL,
	`total_comments` INTEGER NOT NULL DEFAULT 0,
	`overridden_comments` INTEGER NOT NULL DEFAULT 0,
	`false_positive_rate` REAL NOT NULL DEFAULT 0,
	`last_updated` TEXT NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `review_calibration_module_unique` ON `review_calibration` (`module`);
