CREATE TABLE `run_outcomes` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `task_id` TEXT,
  `started_at` TEXT,
  `completed_at` TEXT,
  `status` TEXT,
  `total_turns` INTEGER,
  `lint_iterations` INTEGER,
  `review_rounds` INTEGER,
  `review_comments_json` TEXT,
  `failure_mode` TEXT,
  `failure_detail` TEXT,
  `human_review_result` TEXT,
  `human_review_comments` INTEGER,
  `modules_touched` TEXT,
  `files_changed` INTEGER,
  `tests_added` INTEGER,
  `raw_events_json` TEXT
);
