CREATE TABLE IF NOT EXISTS `cooldown_state` (
	`id` INTEGER PRIMARY KEY DEFAULT 1,
	`active` INTEGER NOT NULL DEFAULT 0,
	`entered_at` TEXT,
	`resume_at` TEXT,
	`probe_count` INTEGER DEFAULT 0
);
