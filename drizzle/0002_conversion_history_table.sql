CREATE TABLE conversions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  node_names TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
DROP TABLE entries;
