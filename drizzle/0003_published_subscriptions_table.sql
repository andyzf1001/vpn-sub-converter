CREATE TABLE published_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  title TEXT NOT NULL,
  format TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  node_names TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX published_subs_token_unique ON published_subs (token);
