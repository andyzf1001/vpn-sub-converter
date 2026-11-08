// 独立版 API：平台版这里是调服务端 actions 的 RPC 客户端，独立版没有
// 服务器，全部改成本地实现，数据存浏览器 localStorage：
//   - 转换历史：只存元信息（标题、来源、节点数、节点名），与平台版一致。
//   - 订阅库：平台版「发布订阅」靠公共服务器生成可拉取的 https 地址；
//     独立版没有公共服务器，不生成任何地址，只把订阅内容存到本机，
//     条目带 content 字段，供界面复制 / 下载 / 生成二维码。
// 函数签名与平台版保持一致，App.tsx 的调用方式不用改。

export interface ConversionItem {
  id: number;
  title: string;
  source_kind: string;
  node_count: number;
  node_names: string[];
  created_at: string;
}

export interface PublishedItem {
  id: number;
  title: string;
  format: string;
  node_count: number;
  node_names: string[];
  /** 独立版没有公网订阅地址，恒为空字符串；订阅内容看 content 字段。 */
  url: string;
  /** 订阅内容本体（平台版存在服务端 blob 里，独立版随条目存本机）。 */
  content: string;
  created_at: string;
}

const HISTORY_KEY = "subconverter.conversions.v1";
const SUBS_KEY = "subconverter.published.v1";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return (parsed as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function nextId(items: { id: number }[]): number {
  return items.reduce((max, it) => Math.max(max, it.id), 0) + 1;
}

interface StoredSub extends PublishedItem {}

function loadSubs(): StoredSub[] {
  const items = readJson<StoredSub[]>(SUBS_KEY, []);
  return Array.isArray(items) ? items : [];
}

export const api = {
  async listConversions(args: { limit?: number } = {}): Promise<{ items: ConversionItem[] }> {
    const limit = args.limit ?? 30;
    const items = readJson<ConversionItem[]>(HISTORY_KEY, []);
    const sorted = [...items].sort((a, b) => b.id - a.id).slice(0, limit);
    return { items: sorted };
  },

  async saveConversion(args: {
    title: string;
    sourceKind: string;
    nodeCount: number;
    nodeNames: string[];
  }): Promise<{ id: number }> {
    const items = readJson<ConversionItem[]>(HISTORY_KEY, []);
    const item: ConversionItem = {
      id: nextId(items),
      title: args.title,
      source_kind: args.sourceKind,
      node_count: args.nodeCount,
      node_names: args.nodeNames,
      created_at: new Date().toISOString(),
    };
    items.push(item);
    writeJson(HISTORY_KEY, items);
    return { id: item.id };
  },

  async deleteConversion(args: { id: number }): Promise<{ ok: true }> {
    const items = readJson<ConversionItem[]>(HISTORY_KEY, []);
    writeJson(
      HISTORY_KEY,
      items.filter((it) => it.id !== args.id),
    );
    return { ok: true as const };
  },

  async publishSubscription(args: {
    title: string;
    format: "b64" | "clash";
    content: string;
    nodeCount: number;
    nodeNames: string[];
  }): Promise<{ id: number; url: string }> {
    const items = loadSubs();
    const item: StoredSub = {
      id: nextId(items),
      title: args.title,
      format: args.format,
      node_count: args.nodeCount,
      node_names: args.nodeNames,
      url: "",
      content: args.content,
      created_at: new Date().toISOString(),
    };
    items.push(item);
    writeJson(SUBS_KEY, items);
    // 独立版没有公网地址：url 恒为空，界面据此展示「本地订阅库」文案。
    return { id: item.id, url: "" };
  },

  async listPublishedSubs(args: { limit?: number } = {}): Promise<{ items: PublishedItem[] }> {
    const limit = args.limit ?? 30;
    const sorted = [...loadSubs()].sort((a, b) => b.id - a.id).slice(0, limit);
    return { items: sorted };
  },

  async deletePublishedSub(args: { id: number }): Promise<{ ok: true }> {
    writeJson(
      SUBS_KEY,
      loadSubs().filter((it) => it.id !== args.id),
    );
    return { ok: true as const };
  },
};

/** 与平台版相同的类型小工具：ApiResponse<typeof api, "listConversions"> 取某个方法的返回类型。 */
export type ApiResponse<
  T,
  K extends keyof T,
> = T[K] extends (...args: never[]) => Promise<infer R> ? R : never;

export type ApiRequest<
  T,
  K extends keyof T,
> = T[K] extends (arg: infer A) => Promise<unknown> ? A : never;
