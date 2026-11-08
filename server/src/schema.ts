// Drizzle schema for this space: 转换历史（只存元信息，不存节点链接等敏感内容）。

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const conversions = sqliteTable("conversions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  sourceKind: text("source_kind").notNull(),
  nodeCount: integer("node_count").notNull(),
  nodeNames: text("node_names").notNull(), // JSON 数组字符串
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// 已发布的订阅：用户点「发布」后，订阅内容存为公开 blob，
// token 是随机串，拼进 blob 的公开地址里当订阅链接；删除记录时连 blob 一起删，链接立即失效。
export const publishedSubs = sqliteTable("published_subs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  title: text("title").notNull(),
  format: text("format").notNull(), // b64 | clash
  nodeCount: integer("node_count").notNull(),
  nodeNames: text("node_names").notNull(), // JSON 数组字符串
  blobKey: text("blob_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
