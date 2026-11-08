// Actions for this artifact: 转换历史 + 已发布订阅。
// 转换历史只保存元信息（标题、来源类型、节点数、节点名），不保存节点链接、
// 密码、UUID 等敏感内容；转换本身全部在浏览器本地完成。
// 已发布订阅是例外：用户明确点「发布」后，订阅内容（含节点链接）会存为
// 公开 blob，换取一个带随机 token 的 https 订阅地址；删除即失效。

import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const conversionItem = z.object({
  id: z.number(),
  title: z.string(),
  source_kind: z.string(),
  node_count: z.number(),
  node_names: z.array(z.string()),
  created_at: z.string(),
});

const listResponse = z.object({ items: z.array(conversionItem) });

type ConversionItem = z.infer<typeof conversionItem>;

function toItem(row: typeof schema.conversions.$inferSelect): ConversionItem {
  let names: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.nodeNames);
    if (Array.isArray(parsed)) names = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    names = [];
  }
  return {
    id: row.id,
    title: row.title,
    source_kind: row.sourceKind,
    node_count: row.nodeCount,
    node_names: names,
    created_at: row.createdAt.toISOString(),
  };
}

const publishedItem = z.object({
  id: z.number(),
  title: z.string(),
  format: z.string(),
  node_count: z.number(),
  node_names: z.array(z.string()),
  url: z.string(),
  created_at: z.string(),
});

const publishedListResponse = z.object({ items: z.array(publishedItem) });

type PublishedItem = z.infer<typeof publishedItem>;

function toPublishedItem(
  row: typeof schema.publishedSubs.$inferSelect,
  url: string,
): PublishedItem {
  let names: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.nodeNames);
    if (Array.isArray(parsed)) names = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    names = [];
  }
  return {
    id: row.id,
    title: row.title,
    format: row.format,
    node_count: row.nodeCount,
    node_names: names,
    url,
    created_at: row.createdAt.toISOString(),
  };
}

export const Actions = {
  listConversions: defineAction({
    description: "列出最近的转换历史（只有元信息，不含节点链接），最新在前。",
    request: z.object({
      limit: z.number().int().positive().max(100).default(30),
    }),
    response: listResponse,
    async handler(ctx, args): Promise<z.infer<typeof listResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.conversions)
        .orderBy(desc(schema.conversions.id))
        .limit(args.limit);
      return { items: rows.map(toItem) };
    },
  }),

  saveConversion: defineAction({
    description: "保存一条转换历史元信息（标题、来源类型、节点数、节点名列表）。",
    request: z.object({
      title: z.string().min(1).max(200),
      sourceKind: z.string().min(1).max(100),
      nodeCount: z.number().int().nonnegative(),
      nodeNames: z.array(z.string().max(200)).max(200),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.conversions)
        .values({
          title: args.title,
          sourceKind: args.sourceKind,
          nodeCount: args.nodeCount,
          nodeNames: JSON.stringify(args.nodeNames),
        })
        .returning({ id: schema.conversions.id });
      const inserted = result[0];
      if (!inserted) throw new Error("saveConversion: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteConversion: defineAction({
    description: "删除一条转换历史记录。",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.conversions).where(eq(schema.conversions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  publishSubscription: defineAction({
    description:
      "把一份订阅内容发布为公开 blob，返回带随机 token 的 https 订阅地址；内容含节点链接，只在用户明确点发布时调用。",
    request: z.object({
      title: z.string().min(1).max(200),
      format: z.enum(["b64", "clash"]),
      content: z.string().min(1).max(1_000_000),
      nodeCount: z.number().int().nonnegative(),
      nodeNames: z.array(z.string().max(200)).max(200),
    }),
    response: z.object({ id: z.number(), url: z.string() }),
    async handler(ctx, args) {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const blobKey = `published-subs/${token}`;
      const contentType =
        args.format === "clash" ? "text/yaml; charset=utf-8" : "text/plain; charset=utf-8";
      await ctx.blobs.put(blobKey, args.content, { contentType, public: true });
      const url = await ctx.blobs.getUrl(blobKey, { public: true });
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.publishedSubs)
        .values({
          token,
          title: args.title,
          format: args.format,
          nodeCount: args.nodeCount,
          nodeNames: JSON.stringify(args.nodeNames),
          blobKey,
        })
        .returning({ id: schema.publishedSubs.id });
      const inserted = result[0];
      if (!inserted) throw new Error("publishSubscription: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id, url };
    },
  }),

  listPublishedSubs: defineAction({
    description: "列出已发布的订阅（标题、格式、节点数、订阅地址），最新在前。",
    request: z.object({
      limit: z.number().int().positive().max(100).default(30),
    }),
    response: publishedListResponse,
    async handler(ctx, args): Promise<z.infer<typeof publishedListResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.publishedSubs)
        .orderBy(desc(schema.publishedSubs.id))
        .limit(args.limit);
      const items: PublishedItem[] = [];
      for (const row of rows) {
        let url = "";
        try {
          url = await ctx.blobs.getUrl(row.blobKey, { public: true });
        } catch {
          url = "";
        }
        items.push(toPublishedItem(row, url));
      }
      return { items };
    },
  }),

  deletePublishedSub: defineAction({
    description: "删除一条已发布的订阅：删掉公开 blob 和记录，订阅地址立即失效。",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.publishedSubs)
        .where(eq(schema.publishedSubs.id, args.id))
        .limit(1);
      const row = rows[0];
      if (row) {
        try {
          await ctx.blobs.delete(row.blobKey);
        } catch {
          /* blob 已不在也要把记录删掉 */
        }
        await db.delete(schema.publishedSubs).where(eq(schema.publishedSubs.id, args.id));
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
