// 本地订阅转换引擎：节点分享链接 ⇄ Clash YAML ⇄ Base64 订阅内容。
// 全部解析在浏览器内完成，不发出任何网络请求。

import { load as yamlLoad, dump as yamlDump } from "js-yaml";

export interface ProxyNode {
  id: string;
  name: string;
  type: string; // vless | vmess | trojan | ss | hysteria2 | tuic | 其他 clash 类型
  server: string;
  port: number;
  /** 规范化后的分享链接；无法生成链接的节点为空字符串 */
  link: string;
  /** Clash 代理对象；无法生成时为 null */
  clash: Record<string, unknown> | null;
}

export interface ParseResult {
  nodes: ProxyNode[];
  warnings: string[];
  /** 识别到的输入类型（中文说明，展示给用户） */
  sourceKind: string;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `n${Date.now().toString(36)}-${idCounter}`;
}

// ---------- base64 工具 ----------

export function b64Decode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function b64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function isBase64Blob(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  return t.length >= 16 && /^[A-Za-z0-9+/=_-]+$/.test(t);
}

// ---------- 单条链接解析 ----------

const SCHEMES = ["vmess://", "vless://", "trojan://", "ss://", "hysteria2://", "hy2://", "tuic://"];

function splitWsOpts(params: URLSearchParams): Record<string, unknown> | null {
  const path = params.get("path");
  const host = params.get("host");
  if (!path && !host) return null;
  const opts: Record<string, unknown> = {};
  if (path) opts.path = path;
  if (host) opts.headers = { Host: host };
  return opts;
}

function parseVless(u: URL, raw: string): ProxyNode {
  const p = u.searchParams;
  const security = p.get("security") ?? "";
  const network = p.get("type") ?? "tcp";
  const clash: Record<string, unknown> = {
    name: "",
    type: "vless",
    server: u.hostname,
    port: Number(u.port || 443),
    uuid: decodeURIComponent(u.username),
    udp: true,
  };
  if (security === "tls" || security === "reality") clash.tls = true;
  const flow = p.get("flow");
  if (flow) clash.flow = flow;
  if (network !== "tcp") clash.network = network;
  const sni = p.get("sni") || p.get("host") || undefined;
  if ((security === "tls" || security === "reality") && sni) clash.servername = sni;
  const fp = p.get("fp");
  if (security === "reality") {
    clash["client-fingerprint"] = fp || "chrome";
    const reality: Record<string, unknown> = {};
    const pbk = p.get("pbk");
    const sid = p.get("sid");
    if (pbk) reality["public-key"] = pbk;
    if (sid) reality["short-id"] = sid;
    if (Object.keys(reality).length) clash["reality-opts"] = reality;
  } else if (fp) {
    clash["client-fingerprint"] = fp;
  }
  if (network === "ws") {
    const ws = splitWsOpts(p);
    if (ws) clash["ws-opts"] = ws;
  }
  if (network === "grpc") {
    const svc = p.get("serviceName");
    if (svc) clash["grpc-opts"] = { "grpc-service-name": svc };
  }
  const name = decodeURIComponent(u.hash.replace(/^#/, "")) || `${u.hostname}:${clash.port}`;
  clash.name = name;
  return { id: nextId(), name, type: "vless", server: u.hostname, port: Number(clash.port), link: raw, clash };
}

function parseVmess(link: string): ProxyNode {
  const json = JSON.parse(b64Decode(link.slice("vmess://".length))) as Record<string, unknown>;
  const name = String(json.ps ?? "") || `${String(json.add ?? "")}:${String(json.port ?? "")}`;
  const port = Number(json.port ?? 443);
  const network = String(json.net ?? "tcp");
  const clash: Record<string, unknown> = {
    name,
    type: "vmess",
    server: String(json.add ?? ""),
    port,
    uuid: String(json.id ?? ""),
    alterId: Number(json.aid ?? 0),
    cipher: String(json.scy ?? "auto"),
    udp: true,
  };
  if (json.tls === "tls") {
    clash.tls = true;
    const sni = (json.sni as string) || (json.host as string);
    if (sni) clash.servername = sni;
  }
  if (network !== "tcp") clash.network = network;
  if (network === "ws") {
    const opts: Record<string, unknown> = {};
    if (json.path) opts.path = json.path;
    if (json.host) opts.headers = { Host: json.host };
    if (Object.keys(opts).length) clash["ws-opts"] = opts;
  }
  if (network === "grpc") {
    const svc = (json.path as string) || "";
    if (svc) clash["grpc-opts"] = { "grpc-service-name": svc };
  }
  return { id: nextId(), name, type: "vmess", server: String(json.add ?? ""), port, link, clash };
}

function parseTrojan(u: URL, raw: string): ProxyNode {
  const p = u.searchParams;
  const network = p.get("type") ?? "tcp";
  const clash: Record<string, unknown> = {
    name: "",
    type: "trojan",
    server: u.hostname,
    port: Number(u.port || 443),
    password: decodeURIComponent(u.username),
    udp: true,
    tls: true,
  };
  const sni = p.get("sni") || p.get("peer");
  if (sni) clash.sni = sni;
  if (p.get("allowInsecure") === "1" || p.get("insecure") === "1") clash["skip-cert-verify"] = true;
  if (network !== "tcp") clash.network = network;
  if (network === "ws") {
    const ws = splitWsOpts(p);
    if (ws) clash["ws-opts"] = ws;
  }
  if (network === "grpc") {
    const svc = p.get("serviceName");
    if (svc) clash["grpc-opts"] = { "grpc-service-name": svc };
  }
  const name = decodeURIComponent(u.hash.replace(/^#/, "")) || `${u.hostname}:${clash.port}`;
  clash.name = name;
  return { id: nextId(), name, type: "trojan", server: u.hostname, port: Number(clash.port), link: raw, clash };
}

function parseSS(link: string): ProxyNode {
  const hashIdx = link.indexOf("#");
  const name = hashIdx >= 0 ? decodeURIComponent(link.slice(hashIdx + 1)) : "";
  const main = hashIdx >= 0 ? link.slice(0, hashIdx) : link;
  const body = main.slice("ss://".length);
  const qIdx = body.indexOf("?");
  const query = qIdx >= 0 ? body.slice(qIdx + 1) : "";
  const core = qIdx >= 0 ? body.slice(0, qIdx) : body;

  let method = "";
  let password = "";
  let host = "";
  let port = 0;

  if (core.includes("@")) {
    const atIdx = core.lastIndexOf("@");
    const userinfo = core.slice(0, atIdx);
    const hostport = core.slice(atIdx + 1);
    if (userinfo.includes(":")) {
      const ci = userinfo.indexOf(":");
      method = decodeURIComponent(userinfo.slice(0, ci));
      password = decodeURIComponent(userinfo.slice(ci + 1));
    } else {
      const decoded = b64Decode(userinfo);
      const ci = decoded.indexOf(":");
      method = decoded.slice(0, ci);
      password = decoded.slice(ci + 1);
    }
    const pi = hostport.lastIndexOf(":");
    host = hostport.slice(0, pi).replace(/^\[|\]$/g, "");
    port = Number(hostport.slice(pi + 1));
  } else {
    // 旧格式：整体 base64(method:password@host:port)
    const decoded = b64Decode(core);
    const atIdx = decoded.lastIndexOf("@");
    const userinfo = decoded.slice(0, atIdx);
    const hostport = decoded.slice(atIdx + 1);
    const ci = userinfo.indexOf(":");
    method = userinfo.slice(0, ci);
    password = userinfo.slice(ci + 1);
    const pi = hostport.lastIndexOf(":");
    host = hostport.slice(0, pi).replace(/^\[|\]$/g, "");
    port = Number(hostport.slice(pi + 1));
  }
  if (!method || !host || !port) throw new Error("ss 链接字段不完整");

  const clash: Record<string, unknown> = {
    name: name || `${host}:${port}`,
    type: "ss",
    server: host,
    port,
    cipher: method,
    password,
    udp: true,
  };
  const params = new URLSearchParams(query);
  const plugin = params.get("plugin");
  if (plugin) {
    const parts = plugin.split(";");
    const pluginName = parts[0] ?? "";
    if (pluginName === "v2ray-plugin" || pluginName === "obfs-local") {
      clash.plugin = pluginName === "obfs-local" ? "obfs" : "v2ray-plugin";
      const opts: Record<string, unknown> = {};
      for (const kv of parts.slice(1)) {
        const eq = kv.indexOf("=");
        if (eq < 0) continue;
        const k = kv.slice(0, eq);
        const v = kv.slice(eq + 1);
        if (k === "mode") opts.mode = v;
        if (k === "host") opts.host = v;
        if (k === "path") opts.path = v;
        if (k === "tls") opts.tls = true;
        if (k === "obfs") opts.mode = v;
        if (k === "obfs-host") opts.host = v;
      }
      if (Object.keys(opts).length) clash["plugin-opts"] = opts;
    }
  }
  return { id: nextId(), name: clash.name as string, type: "ss", server: host, port, link, clash };
}

function parseHysteria2(u: URL, raw: string): ProxyNode {
  const p = u.searchParams;
  const clash: Record<string, unknown> = {
    name: "",
    type: "hysteria2",
    server: u.hostname,
    port: Number(u.port || 443),
    password: decodeURIComponent(u.username),
    udp: true,
  };
  const sni = p.get("sni");
  if (sni) clash.sni = sni;
  if (p.get("insecure") === "1") clash["skip-cert-verify"] = true;
  const obfs = p.get("obfs");
  if (obfs) clash.obfs = obfs;
  const obfsPw = p.get("obfs-password");
  if (obfsPw) clash["obfs-password"] = obfsPw;
  const name = decodeURIComponent(u.hash.replace(/^#/, "")) || `${u.hostname}:${clash.port}`;
  clash.name = name;
  return { id: nextId(), name, type: "hysteria2", server: u.hostname, port: Number(clash.port), link: raw, clash };
}

function parseTuic(u: URL, raw: string): ProxyNode {
  const p = u.searchParams;
  const userinfo = decodeURIComponent(u.username);
  const ci = userinfo.indexOf(":");
  const clash: Record<string, unknown> = {
    name: "",
    type: "tuic",
    server: u.hostname,
    port: Number(u.port || 443),
    uuid: ci >= 0 ? userinfo.slice(0, ci) : userinfo,
    password: ci >= 0 ? userinfo.slice(ci + 1) : decodeURIComponent(u.password || ""),
    udp: true,
  };
  const sni = p.get("sni");
  if (sni) clash.sni = sni;
  const alpn = p.get("alpn");
  if (alpn) clash.alpn = alpn.split(",");
  if (p.get("allow_insecure") === "1" || p.get("allowInsecure") === "1") clash["skip-cert-verify"] = true;
  const cc = p.get("congestion_control");
  if (cc) clash["congestion-controller"] = cc;
  const urm = p.get("udp_relay_mode");
  if (urm) clash["udp-relay-mode"] = urm;
  const name = decodeURIComponent(u.hash.replace(/^#/, "")) || `${u.hostname}:${clash.port}`;
  clash.name = name;
  return { id: nextId(), name, type: "tuic", server: u.hostname, port: Number(clash.port), link: raw, clash };
}

export function parseSingleLink(link: string): ProxyNode {
  const raw = link.trim();
  if (raw.startsWith("vmess://")) return parseVmess(raw);
  if (raw.startsWith("vless://")) return parseVless(new URL(raw), raw);
  if (raw.startsWith("trojan://")) return parseTrojan(new URL(raw), raw);
  if (raw.startsWith("ss://")) return parseSS(raw);
  if (raw.startsWith("hysteria2://") || raw.startsWith("hy2://")) return parseHysteria2(new URL(raw), raw);
  if (raw.startsWith("tuic://")) return parseTuic(new URL(raw), raw);
  throw new Error("不支持的链接协议");
}

// ---------- Clash 对象 → 分享链接 ----------

function clashToLink(c: Record<string, unknown>): string {
  const name = String(c.name ?? "");
  const server = String(c.server ?? "");
  const port = Number(c.port ?? 443);
  const frag = `#${encodeURIComponent(name)}`;
  const type = String(c.type ?? "");

  if (type === "vless") {
    const q = new URLSearchParams();
    q.set("encryption", "none");
    const isReality = !!c["reality-opts"];
    if (c.tls) q.set("security", isReality ? "reality" : "tls");
    else q.set("security", "none");
    if (c.flow) q.set("flow", String(c.flow));
    const network = String(c.network ?? "tcp");
    q.set("type", network);
    if (c.servername) q.set("sni", String(c.servername));
    if (c["client-fingerprint"]) q.set("fp", String(c["client-fingerprint"]));
    if (isReality) {
      const r = c["reality-opts"] as Record<string, unknown>;
      if (r["public-key"]) q.set("pbk", String(r["public-key"]));
      if (r["short-id"]) q.set("sid", String(r["short-id"]));
    }
    if (network === "ws") {
      const ws = (c["ws-opts"] ?? {}) as Record<string, unknown>;
      if (ws.path) q.set("path", String(ws.path));
      const headers = (ws.headers ?? {}) as Record<string, unknown>;
      if (headers.Host) q.set("host", String(headers.Host));
    }
    if (network === "grpc") {
      const g = (c["grpc-opts"] ?? {}) as Record<string, unknown>;
      if (g["grpc-service-name"]) q.set("serviceName", String(g["grpc-service-name"]));
    }
    return `vless://${c.uuid}@${server}:${port}?${q.toString()}${frag}`;
  }
  if (type === "vmess") {
    const ws = (c["ws-opts"] ?? {}) as Record<string, unknown>;
    const headers = (ws.headers ?? {}) as Record<string, unknown>;
    const json: Record<string, unknown> = {
      v: "2",
      ps: name,
      add: server,
      port: String(port),
      id: String(c.uuid ?? ""),
      aid: String(c.alterId ?? 0),
      scy: String(c.cipher ?? "auto"),
      net: String(c.network ?? "tcp"),
      type: "none",
      host: String(headers.Host ?? ""),
      path: String(ws.path ?? ""),
      tls: c.tls ? "tls" : "",
      sni: String(c.servername ?? ""),
    };
    return `vmess://${b64Encode(JSON.stringify(json))}`;
  }
  if (type === "trojan") {
    const q = new URLSearchParams();
    if (c.sni) q.set("sni", String(c.sni));
    if (c["skip-cert-verify"]) q.set("allowInsecure", "1");
    const network = String(c.network ?? "tcp");
    if (network !== "tcp") {
      q.set("type", network);
      if (network === "ws") {
        const ws = (c["ws-opts"] ?? {}) as Record<string, unknown>;
        if (ws.path) q.set("path", String(ws.path));
        const headers = (ws.headers ?? {}) as Record<string, unknown>;
        if (headers.Host) q.set("host", String(headers.Host));
      }
      if (network === "grpc") {
        const g = (c["grpc-opts"] ?? {}) as Record<string, unknown>;
        if (g["grpc-service-name"]) q.set("serviceName", String(g["grpc-service-name"]));
      }
    }
    const qs = q.toString();
    return `trojan://${encodeURIComponent(String(c.password ?? ""))}@${server}:${port}${qs ? `?${qs}` : ""}${frag}`;
  }
  if (type === "ss") {
    const userinfo = b64Encode(`${c.cipher}:${c.password}`)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `ss://${userinfo}@${server}:${port}${frag}`;
  }
  if (type === "hysteria2") {
    const q = new URLSearchParams();
    if (c.sni) q.set("sni", String(c.sni));
    if (c["skip-cert-verify"]) q.set("insecure", "1");
    if (c.obfs) q.set("obfs", String(c.obfs));
    if (c["obfs-password"]) q.set("obfs-password", String(c["obfs-password"]));
    const qs = q.toString();
    return `hysteria2://${encodeURIComponent(String(c.password ?? ""))}@${server}:${port}${qs ? `?${qs}` : ""}${frag}`;
  }
  if (type === "tuic") {
    const q = new URLSearchParams();
    if (c.sni) q.set("sni", String(c.sni));
    if (Array.isArray(c.alpn)) q.set("alpn", (c.alpn as unknown[]).join(","));
    if (c["skip-cert-verify"]) q.set("allow_insecure", "1");
    if (c["congestion-controller"]) q.set("congestion_control", String(c["congestion-controller"]));
    if (c["udp-relay-mode"]) q.set("udp_relay_mode", String(c["udp-relay-mode"]));
    const qs = q.toString();
    return `tuic://${c.uuid}:${encodeURIComponent(String(c.password ?? ""))}@${server}:${port}${qs ? `?${qs}` : ""}${frag}`;
  }
  return "";
}

// ---------- 格式互转：格式定义 ----------

export type ConvertFormat = "links" | "base64" | "clash" | "clash-proxies" | "json";
export type SourceFormat = "auto" | ConvertFormat;

export const FORMAT_LABELS: Record<ConvertFormat, string> = {
  links: "分享链接（每行一条）",
  base64: "Base64 订阅内容",
  clash: "Clash 完整配置（YAML）",
  "clash-proxies": "Clash proxies 片段（YAML）",
  json: "JSON 节点列表",
};

export const FORMAT_EXTENSIONS: Record<ConvertFormat, string> = {
  links: "txt",
  base64: "txt",
  clash: "yaml",
  "clash-proxies": "yaml",
  json: "json",
};

/** 粗略判断一段文本最像哪种格式（用于「自动识别」时给用户反馈） */
export function detectInputFormat(input: string): ConvertFormat | "unknown" {
  const text = input.trim();
  if (!text) return "unknown";
  if (/^\s*proxies\s*:/m.test(text)) {
    // 带完整配置标志的是完整配置，只有 proxies 的是片段
    if (/(^|\n)\s*(proxy-groups|rules|mixed-port|dns)\s*:/.test(text)) return "clash";
    return "clash-proxies";
  }
  if (/^\s*-\s+name\s*:/m.test(text)) return "clash-proxies";
  if ((text.startsWith("{") || text.startsWith("[")) && text.includes('"')) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      /* 不是合法 JSON，继续判断 */
    }
  }
  if (text.includes("://")) return "links";
  if (isBase64Blob(text)) return "base64";
  return "unknown";
}

function nodesFromClashList(list: unknown[]): ParseResult | null {
  const nodes: ProxyNode[] = [];
  const warnings: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    // JSON 互转格式里节点带 clash 字段时优先用它
    const clashObj =
      c.clash && typeof c.clash === "object" ? (c.clash as Record<string, unknown>) : c;
    const nm = String(clashObj.name ?? c.name ?? "");
    if (!nm || !clashObj.type || !clashObj.server) {
      warnings.push("有一条节点缺少 name/type/server，已跳过");
      continue;
    }
    const storedLink = typeof c.link === "string" ? c.link : "";
    const link = storedLink || clashToLink(clashObj);
    if (!link) warnings.push(`节点「${nm}」是 ${String(clashObj.type)} 类型，无法生成分享链接，但可以包含在 Clash 配置里`);
    nodes.push({
      id: nextId(),
      name: nm,
      type: String(clashObj.type),
      server: String(clashObj.server),
      port: Number(clashObj.port ?? 0),
      link,
      clash: clashObj,
    });
  }
  if (nodes.length === 0) return null;
  return { nodes, warnings, sourceKind: "Clash 配置文件（YAML）" };
}

function parseJsonInput(text: string): ParseResult | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  let list: unknown[] | null = null;
  if (Array.isArray(doc)) list = doc;
  else if (doc && typeof doc === "object") {
    const obj = doc as Record<string, unknown>;
    if (Array.isArray(obj.nodes)) list = obj.nodes;
    else if (Array.isArray(obj.proxies)) list = obj.proxies;
    else if (obj.type && obj.server) list = [obj];
  }
  if (!list || list.length === 0) return null;
  const result = nodesFromClashList(list);
  if (result) result.sourceKind = "JSON 节点列表";
  return result;
}

function parseYamlFragment(text: string): ParseResult | null {
  let doc: unknown;
  try {
    doc = yamlLoad(text);
  } catch {
    return null;
  }
  if (Array.isArray(doc)) {
    const result = nodesFromClashList(doc);
    if (result) result.sourceKind = "Clash proxies 片段（YAML）";
    return result;
  }
  if (doc && typeof doc === "object") {
    const proxies = (doc as Record<string, unknown>).proxies;
    if (Array.isArray(proxies) && proxies.length > 0) {
      const result = nodesFromClashList(proxies);
      if (result) {
        const hasFull = ["proxy-groups", "rules", "mixed-port", "dns"].some((k) => k in (doc as Record<string, unknown>));
        result.sourceKind = hasFull ? "Clash 配置文件（YAML）" : "Clash proxies 片段（YAML）";
      }
      return result;
    }
  }
  return null;
}

// ---------- Clash YAML 解析 ----------

function parseClashYaml(text: string): ParseResult | null {
  let doc: unknown;
  try {
    doc = yamlLoad(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const proxies = (doc as Record<string, unknown>).proxies;
  if (!Array.isArray(proxies) || proxies.length === 0) return null;
  const nodes: ProxyNode[] = [];
  const warnings: string[] = [];
  for (const item of proxies) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const nm = String(c.name ?? "");
    if (!nm || !c.type || !c.server) {
      warnings.push("YAML 里有一条代理缺少 name/type/server，已跳过");
      continue;
    }
    const link = clashToLink(c);
    if (!link) warnings.push(`节点「${nm}」是 ${String(c.type)} 类型，无法生成分享链接，但可以包含在 Clash 配置里`);
    nodes.push({
      id: nextId(),
      name: nm,
      type: String(c.type),
      server: String(c.server),
      port: Number(c.port ?? 0),
      link,
      clash: c,
    });
  }
  if (nodes.length === 0) return null;
  return { nodes, warnings, sourceKind: "Clash 配置文件（YAML）" };
}

// ---------- 总入口：任意输入 → 节点列表 ----------

function extractLinks(text: string, warnings: string[]): ProxyNode[] {
  const nodes: ProxyNode[] = [];
  const pattern = new RegExp(`(${SCHEMES.join("|").replace(/\//g, "\\/")})[^\\s"'<>]+`, "g");
  const matches: string[] = text.match(pattern) ?? [];
  // 逐行兜底：整行是链接但正则没抓全时按行处理
  if (matches.length === 0) {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (SCHEMES.some((s) => t.startsWith(s))) matches.push(t);
    }
  }
  for (const m of matches) {
    try {
      nodes.push(parseSingleLink(m));
    } catch {
      warnings.push(`有一条链接解析失败，已跳过：${m.slice(0, 60)}…`);
    }
  }
  return nodes;
}

function dedupeNames(nodes: ProxyNode[]): ProxyNode[] {
  const seen = new Map<string, number>();
  for (const n of nodes) {
    const count = seen.get(n.name) ?? 0;
    seen.set(n.name, count + 1);
    if (count > 0) {
      n.name = `${n.name} (${count + 1})`;
      if (n.clash) n.clash.name = n.name;
      if (n.link) {
        try {
          n.link = clashToLink({ ...(n.clash ?? {}), name: n.name }) || n.link;
        } catch {
          /* 保留原链接 */
        }
      }
    }
  }
  return nodes;
}

export function parseAnyInput(input: string): ParseResult {
  const text = input.trim();
  const warnings: string[] = [];
  if (!text) return { nodes: [], warnings: ["输入是空的"], sourceKind: "" };

  // 0) JSON 节点列表
  if (text.startsWith("{") || text.startsWith("[")) {
    const jsonResult = parseJsonInput(text);
    if (jsonResult) {
      jsonResult.nodes = dedupeNames(jsonResult.nodes);
      return jsonResult;
    }
  }

  // 0.5) YAML 列表片段（直接以 - name: 开头的 proxies 列表）
  if (/^\s*-\s+name\s*:/m.test(text)) {
    const frag = parseYamlFragment(text);
    if (frag) {
      frag.nodes = dedupeNames(frag.nodes);
      return frag;
    }
  }

  // 1) Clash YAML
  if (/^\s*proxies\s*:/m.test(text) || text.includes("\nproxies:")) {
    const yamlResult = parseClashYaml(text);
    if (yamlResult) {
      yamlResult.nodes = dedupeNames(yamlResult.nodes);
      return yamlResult;
    }
    warnings.push("看起来像 YAML，但没有读到有效的 proxies 节点");
  }

  // 2) 整段是 Base64 订阅内容
  if (!text.includes("://") && isBase64Blob(text)) {
    try {
      const decoded = b64Decode(text.replace(/\s+/g, ""));
      if (decoded.includes("://")) {
        const nodes = extractLinks(decoded, warnings);
        if (nodes.length) return { nodes: dedupeNames(nodes), warnings, sourceKind: "Base64 订阅内容" };
      }
    } catch {
      /* 继续走链接提取 */
    }
  }

  // 3) 直接提取链接（可能混在多行文本里）
  let nodes = extractLinks(text, warnings);
  if (nodes.length) {
    return { nodes: dedupeNames(nodes), warnings, sourceKind: nodes.length > 1 ? "多条节点链接" : "节点分享链接" };
  }

  // 4) 逐行尝试 Base64（订阅内容被分行粘贴等情况）
  const joined = text.replace(/\s+/g, "");
  if (isBase64Blob(joined)) {
    try {
      const decoded = b64Decode(joined);
      nodes = extractLinks(decoded, warnings);
      if (nodes.length) return { nodes: dedupeNames(nodes), warnings, sourceKind: "Base64 订阅内容" };
    } catch {
      /* 落空 */
    }
  }

  return { nodes: [], warnings: [...warnings, "没有识别到有效的节点链接、订阅内容或 Clash 配置"], sourceKind: "" };
}

// ---------- 输出生成 ----------

export function generateShareLinks(nodes: ProxyNode[]): string[] {
  return nodes.filter((n) => n.link).map((n) => n.link);
}

/** v2ray / 小火箭通用订阅内容：全部链接拼起来再 Base64 */
export function generateSubscription(nodes: ProxyNode[]): string {
  const links = generateShareLinks(nodes);
  if (!links.length) return "";
  return b64Encode(links.join("\n"));
}

/** 完整的 Clash Meta 配置：带 PROXY 分组和 MATCH 规则，导入后能直接选节点 */
export function generateClashYaml(nodes: ProxyNode[]): string {
  const proxies = nodes.map((n) => n.clash).filter((c): c is Record<string, unknown> => !!c);
  const names = proxies.map((c) => String(c.name));
  const config: Record<string, unknown> = {
    "mixed-port": 7890,
    "allow-lan": false,
    mode: "rule",
    "log-level": "info",
    dns: {
      enable: true,
      nameserver: ["223.5.5.5", "119.29.29.29", "8.8.8.8"],
      fallback: ["8.8.4.4", "1.1.1.1"],
    },
    proxies,
    "proxy-groups": [
      { name: "PROXY", type: "select", proxies: [...names, "AUTO", "DIRECT"] },
      {
        name: "AUTO",
        type: "url-test",
        proxies: names,
        url: "http://www.gstatic.com/generate_204",
        interval: 300,
        tolerance: 50,
      },
    ],
    rules: ["MATCH,PROXY"],
  };
  return yamlDump(config, { lineWidth: 120, noRefs: true });
}

/** 只含 proxies 的 YAML 片段，可粘回完整配置或单独保存 */
export function generateClashProxiesYaml(nodes: ProxyNode[]): string {
  const proxies = nodes.map((n) => n.clash).filter((c): c is Record<string, unknown> => !!c);
  if (!proxies.length) return "";
  return yamlDump({ proxies }, { lineWidth: 120, noRefs: true });
}

/** JSON 节点列表：保留分享链接和 Clash 对象，方便程序处理和再次转回 */
export function generateNodesJson(nodes: ProxyNode[]): string {
  if (!nodes.length) return "";
  const list = nodes.map((n) => ({
    name: n.name,
    type: n.type,
    server: n.server,
    port: n.port,
    link: n.link,
    clash: n.clash,
  }));
  return JSON.stringify(list, null, 2);
}

/** 按目标格式生成输出（格式互转用） */
export function generateForFormat(nodes: ProxyNode[], format: ConvertFormat): string {
  switch (format) {
    case "links":
      return generateShareLinks(nodes).join("\n");
    case "base64":
      return generateSubscription(nodes);
    case "clash":
      return nodes.length ? generateClashYaml(nodes) : "";
    case "clash-proxies":
      return generateClashProxiesYaml(nodes);
    case "json":
      return generateNodesJson(nodes);
  }
}

/** 按指定源格式解析；选了具体格式就严格按该格式读，读不出给出对应提示 */
export function parseWithFormat(input: string, format: SourceFormat): ParseResult {
  const text = input.trim();
  if (!text) return { nodes: [], warnings: ["输入是空的"], sourceKind: "" };
  if (format === "auto") return parseAnyInput(input);

  if (format === "json") {
    const result = parseJsonInput(text);
    if (result) {
      result.nodes = dedupeNames(result.nodes);
      return result;
    }
    return { nodes: [], warnings: ["这段内容不是有效的 JSON 节点列表（需要数组，或带 nodes / proxies 的对象）"], sourceKind: "" };
  }
  if (format === "clash" || format === "clash-proxies") {
    const result = parseYamlFragment(text) ?? parseClashYaml(text);
    if (result) {
      result.nodes = dedupeNames(result.nodes);
      result.sourceKind = format === "clash" ? "Clash 配置文件（YAML）" : "Clash proxies 片段（YAML）";
      return result;
    }
    return { nodes: [], warnings: ["这段 YAML 里没有读到有效的节点（需要 proxies 列表，每条带 name / type / server）"], sourceKind: "" };
  }
  if (format === "base64") {
    const warnings: string[] = [];
    try {
      const decoded = b64Decode(text.replace(/\s+/g, ""));
      const nodes = extractLinks(decoded, warnings);
      if (nodes.length) return { nodes: dedupeNames(nodes), warnings, sourceKind: "Base64 订阅内容" };
    } catch {
      /* 落空 */
    }
    return { nodes: [], warnings: ["这段内容解不开 Base64 订阅（解码后没有节点链接）"], sourceKind: "" };
  }
  // links
  const warnings: string[] = [];
  const nodes = extractLinks(text, warnings);
  if (nodes.length) {
    return { nodes: dedupeNames(nodes), warnings, sourceKind: nodes.length > 1 ? "多条节点链接" : "节点分享链接" };
  }
  return { nodes: [], warnings: [...warnings, "没有识别到有效的节点链接（一行一条，如 vless://…）"], sourceKind: "" };
}

/** 改名后同步更新节点：名称、Clash 对象、分享链接一起变 */
export function renameNode(node: ProxyNode, newName: string): ProxyNode {
  const name = newName.trim() || node.name;
  const clash = node.clash ? { ...node.clash, name } : null;
  let link = node.link;
  if (clash) {
    const regenerated = clashToLink(clash);
    if (regenerated) link = regenerated;
  }
  return { ...node, name, clash, link };
}

/** 建议的默认下载文件名：单个节点用节点名，多个节点用通用名 */
export function suggestFileName(nodes: ProxyNode[]): string {
  if (nodes.length === 1) {
    const only = nodes[0];
    if (only) return `${only.name.replace(/[\\/:*?"<>|]/g, "_")}.yaml`;
  }
  return "clash配置.yaml";
}
