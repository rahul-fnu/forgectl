CREATE TABLE `kg_modules` (
  `path` TEXT PRIMARY KEY NOT NULL,
  `exports_json` TEXT NOT NULL,
  `imports_json` TEXT NOT NULL,
  `is_test` INTEGER NOT NULL DEFAULT 0,
  `last_modified` TEXT,
  `updated_at` TEXT DEFAULT (datetime('now'))
);

CREATE TABLE `kg_edges` (
  `from_path` TEXT NOT NULL,
  `to_path` TEXT NOT NULL,
  `imports_json` TEXT NOT NULL,
  `is_type_only` INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (`from_path`, `to_path`)
);

CREATE TABLE `kg_test_mappings` (
  `source_file` TEXT NOT NULL,
  `test_file` TEXT NOT NULL,
  `confidence` TEXT NOT NULL,
  PRIMARY KEY (`source_file`, `test_file`)
);

CREATE TABLE `kg_change_coupling` (
  `file_a` TEXT NOT NULL,
  `file_b` TEXT NOT NULL,
  `cochange_count` INTEGER NOT NULL,
  `total_commits` INTEGER NOT NULL,
  `coupling_score` REAL NOT NULL,
  PRIMARY KEY (`file_a`, `file_b`)
);

CREATE TABLE `kg_meta` (
  `key` TEXT PRIMARY KEY NOT NULL,
  `value` TEXT NOT NULL
);
