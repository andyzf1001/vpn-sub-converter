import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import jsQR from "jsqr";
import QRCode from "qrcode";
import { api, type ApiResponse } from "./api";
import {
FORMAT_EXTENSIONS,
FORMAT_LABELS,
detectInputFormat,
generateClashYaml,
generateForFormat,
generateShareLinks,
generateSubscription,
parseAnyInput,
parseWithFormat,
renameNode,
suggestFileName,
type ConvertFormat,
type ProxyNode,
type SourceFormat,
} from "./lib/convert";

type InputTab = "text" | "file" | "qr";
type OutputTab = "links" | "clash" | "sub" | "suburl";
type HistoryItem = ApiResponse<typeof api, "listConversions">["items"][number];
type PublishedItem = ApiResponse<typeof api, "listPublishedSubs">["items"][number];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 独立版：订阅只存本机订阅库，没有公网地址；条目摘要取内容前若干字符展示 */
function contentSummary(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine;
}

/** UTF-8 安全的 base64 编码：先 TextEncoder 转字节再分块编码，中文不会被裸 btoa 搞坏 */
function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

type NativeSaveBridge = { saveTextFile?: (filename: string, base64: string) => boolean };

function nativeSaveBridge(): NativeSaveBridge | undefined {
  return (window as unknown as { SubConverterNative?: NativeSaveBridge })
    .SubConverterNative;
}

/** 是否运行在「订阅转换」APK 壳里（原生保存桥存在即是） */
function inApkShell(): boolean {
  const bridge = nativeSaveBridge();
  return !!bridge && typeof bridge.saveTextFile === "function";
}

function downloadText(filename: string, text: string) {
  // 在「订阅转换」APK 里：WebView 默认不处理 blob: 下载，必须走原生保存桥
  //（桥用 MediaStore 把文件写入系统「下载」目录，并用 Toast 反馈成功/失败）。
  const bridge = nativeSaveBridge();
  if (bridge && typeof bridge.saveTextFile === "function") {
    bridge.saveTextFile(filename, textToBase64(text));
    return;
  }
  // 普通浏览器：原来的 blob 下载逻辑不变。
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function decodeQrImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx || !canvas.width || !canvas.height) {
          reject(new Error("图片读取失败"));
          return;
        }
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        URL.revokeObjectURL(url);
        if (code && code.data) resolve(code.data);
        else reject(new Error("这张图片里没有识别到二维码"));
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e instanceof Error ? e : new Error("二维码识别失败"));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败"));
    };
    img.src = url;
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function App() {
  const queryClient = useQueryClient();
  const [inputTab, setInputTab] = useState<InputTab>("text");
  const [textInput, setTextInput] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [qrStatus, setQrStatus] = useState<string | null>(null);
  const [nodes, setNodes] = useState<ProxyNode[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [sourceKind, setSourceKind] = useState("");
  const [converted, setConverted] = useState(false);
  const [outputTab, setOutputTab] = useState<OutputTab>("links");
  const [yamlFileName, setYamlFileName] = useState("clash配置.yaml");
  const [yamlNameEdited, setYamlNameEdited] = useState(false);
  const [qrNodeId, setQrNodeId] = useState<string | null>(null);
  const [qrKind, setQrKind] = useState<"link" | "sub">("link");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [pubFormat, setPubFormat] = useState<"b64" | "clash">("b64");
  const [pubSaved, setPubSaved] = useState(false);
  const [subQrId, setSubQrId] = useState<number | null>(null);
  const [subQrUrl, setSubQrUrl] = useState<string | null>(null);
  const [subQrError, setSubQrError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // 格式互转台状态（与上面的快捷转换相互独立）
  const [mutualSource, setMutualSource] = useState<SourceFormat>("auto");
  const [mutualTarget, setMutualTarget] = useState<ConvertFormat>("clash");
  const [mutualInput, setMutualInput] = useState("");
  const [mutualOutput, setMutualOutput] = useState("");
  const [mutualNodes, setMutualNodes] = useState<ProxyNode[]>([]);
  const [mutualWarnings, setMutualWarnings] = useState<string[]>([]);
  const [mutualDetected, setMutualDetected] = useState("");
  const [mutualDone, setMutualDone] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qrInputRef = useRef<HTMLInputElement>(null);

  const history = useQuery({
    queryKey: ["conversions"],
    queryFn: () => api.listConversions({ limit: 30 }),
  });

  const saveMutation = useMutation({
    mutationFn: (args: { title: string; sourceKind: string; nodeCount: number; nodeNames: string[] }) =>
      api.saveConversion(args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversions"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteConversion({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversions"] }),
  });

  const published = useQuery({
    queryKey: ["published-subs"],
    queryFn: () => api.listPublishedSubs({ limit: 30 }),
  });

  const publishMutation = useMutation({
    mutationFn: (args: {
      title: string;
      format: "b64" | "clash";
      content: string;
      nodeCount: number;
      nodeNames: string[];
    }) => api.publishSubscription(args),
    onSuccess: () => {
      setPubSaved(true);
      queryClient.invalidateQueries({ queryKey: ["published-subs"] });
    },
  });

  const deletePublishedMutation = useMutation({
    mutationFn: (id: number) => api.deletePublishedSub({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["published-subs"] }),
  });

  const shareLinks = useMemo(() => generateShareLinks(nodes), [nodes]);
  const clashYaml = useMemo(() => (nodes.length ? generateClashYaml(nodes) : ""), [nodes]);
  const subContent = useMemo(() => generateSubscription(nodes), [nodes]);
  const linklessCount = nodes.length - shareLinks.length;
  const clashlessCount = nodes.filter((n) => !n.clash).length;
  const publishContent = pubFormat === "clash" ? clashYaml : subContent;
  const canPublish = pubFormat === "clash" ? nodes.some((n) => n.clash) : shareLinks.length > 0;
  const publishTitle =
    nodes.length === 1 ? (nodes[0]?.name ?? "订阅") : `${nodes.length} 个节点的订阅`;

  function handlePublish() {
    if (!canPublish || !publishContent) return;
    publishMutation.mutate({
      title: publishTitle,
      format: pubFormat,
      content: publishContent,
      nodeCount: nodes.length,
      nodeNames: nodes.map((n) => n.name),
    });
  }

  const qrNode = useMemo(() => {
    const withLink = nodes.filter((n) => n.link);
    return withLink.find((n) => n.id === qrNodeId) ?? withLink[0] ?? null;
  }, [nodes, qrNodeId]);

  const qrText = qrKind === "sub" ? subContent : (qrNode?.link ?? "");

  useEffect(() => {
    if (!converted || !qrText) {
      setQrDataUrl(null);
      setQrError(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(qrText, { width: 560, margin: 2 })
      .then((url) => {
        if (!cancelled) {
          setQrDataUrl(url);
          setQrError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrDataUrl(null);
          setQrError("内容太长，生成不了二维码，请用复制或下载");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [qrText, converted]);

  function markCopied(key: string) {
    setCopiedKey(key);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedKey(null), 1600);
  }

  async function handleCopy(key: string, text: string) {
    if (!text) return;
    const ok = await copyText(text);
    if (ok) markCopied(key);
  }

  async function toggleSubQr(id: number, content: string) {
    if (subQrId === id) {
      setSubQrId(null);
      setSubQrUrl(null);
      setSubQrError(null);
      return;
    }
    setSubQrId(id);
    setSubQrUrl(null);
    setSubQrError(null);
    try {
      const url = await QRCode.toDataURL(content, { width: 480, margin: 2 });
      setSubQrUrl(url);
    } catch {
      setSubQrError("内容太长，生成不了二维码，请用复制内容或下载文件");
    }
  }

  function applyResult(resultNodes: ProxyNode[], resultWarnings: string[], kind: string, saveTitle: string) {
    setNodes(resultNodes);
    setWarnings(resultWarnings);
    setSourceKind(kind);
    setConverted(true);
    setOutputTab("links");
    setPubSaved(false);
    setQrKind("link");
    setQrNodeId(resultNodes.find((n) => n.link)?.id ?? null);
    if (!yamlNameEdited) setYamlFileName(suggestFileName(resultNodes));
    if (resultNodes.length > 0) {
      saveMutation.mutate({
        title: saveTitle,
        sourceKind: kind || "未知来源",
        nodeCount: resultNodes.length,
        nodeNames: resultNodes.map((n) => n.name),
      });
    }
  }

  function runConvert(raw: string, saveTitle: string) {
    const result = parseAnyInput(raw);
    applyResult(result.nodes, result.warnings, result.sourceKind, saveTitle);
  }

  function handleConvertText() {
    if (!textInput.trim()) {
      setWarnings(["先粘贴节点链接、订阅内容或 Clash 配置，再点转换"]);
      setConverted(true);
      setNodes([]);
      return;
    }
    runConvert(textInput, "粘贴文本转换");
  }

  async function handleConfigFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setFileName(file.name);
    try {
      const text = await file.text();
      runConvert(text, file.name);
    } catch {
      setWarnings(["这个文件读不出来，换一个试试"]);
      setConverted(true);
      setNodes([]);
    }
  }

  async function handleQrFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setQrStatus("正在识别二维码…");
    try {
      const decoded = await decodeQrImage(file);
      setQrStatus("二维码识别成功，正在转换");
      setTextInput(decoded);
      runConvert(decoded, "二维码转换");
    } catch (err) {
      setQrStatus(null);
      setWarnings([err instanceof Error ? err.message : "二维码识别失败，换一张清晰的截图试试"]);
      setConverted(true);
      setNodes([]);
    }
  }

  function handleRename(id: string, name: string) {
    setPubSaved(false);
    setNodes((prev) => {
      const next = prev.map((n) => (n.id === id ? renameNode(n, name) : n));
      if (!yamlNameEdited) setYamlFileName(suggestFileName(next));
      return next;
    });
  }

  function handleRemoveNode(id: string) {
    setPubSaved(false);
    setNodes((prev) => {
      const next = prev.filter((n) => n.id !== id);
      if (!yamlNameEdited) setYamlFileName(suggestFileName(next));
      return next;
    });
  }

  function handleClear() {
    setTextInput("");
    setFileName(null);
    setQrStatus(null);
    setNodes([]);
    setWarnings([]);
    setSourceKind("");
    setConverted(false);
    setPubSaved(false);
  }

  // ---------- 格式互转 ----------

  const mutualDetectedFormat = useMemo(
    () => (mutualInput.trim() ? detectInputFormat(mutualInput) : "unknown"),
    [mutualInput],
  );

  function handleMutualConvert() {
    if (!mutualInput.trim()) {
      setMutualWarnings(["先把要转换的内容粘贴到左边，再点「开始互转」"]);
      setMutualNodes([]);
      setMutualOutput("");
      setMutualDone(true);
      return;
    }
    const result = parseWithFormat(mutualInput, mutualSource);
    setMutualWarnings(result.warnings);
    setMutualNodes(result.nodes);
    setMutualDetected(result.sourceKind);
    setMutualDone(true);
    if (result.nodes.length === 0) {
      setMutualOutput("");
      return;
    }
    const out = generateForFormat(result.nodes, mutualTarget);
    setMutualOutput(out);
    if (!out) {
      setMutualWarnings([
        ...result.warnings,
        mutualTarget === "links" || mutualTarget === "base64"
          ? "这些节点生成不了分享链接，所以目标格式没有内容；换成 Clash 完整配置、proxies 片段或 JSON 试试。"
          : "这些节点放不进目标格式，所以没有内容；换一个目标格式试试。",
      ]);
    }
    saveMutation.mutate({
      title: `格式互转：${result.sourceKind || "未知格式"} → ${FORMAT_LABELS[mutualTarget]}`,
      sourceKind: "格式互转",
      nodeCount: result.nodes.length,
      nodeNames: result.nodes.map((n) => n.name),
    });
  }

  function handleSwapFormats() {
    const currentSource: ConvertFormat =
      mutualSource === "auto"
        ? mutualDetectedFormat !== "unknown"
          ? mutualDetectedFormat
          : "links"
        : mutualSource;
    setMutualSource(mutualTarget);
    setMutualTarget(currentSource);
    if (mutualOutput) {
      setMutualInput(mutualOutput);
      setMutualOutput("");
      setMutualNodes([]);
      setMutualWarnings([]);
      setMutualDone(false);
    }
  }

  function handleChainConvert() {
    if (!mutualOutput) return;
    setMutualInput(mutualOutput);
    setMutualSource(mutualTarget);
    setMutualOutput("");
    setMutualNodes([]);
    setMutualWarnings([]);
    setMutualDone(false);
  }

  function mutualDownloadName(): string {
    const base =
      mutualTarget === "clash"
        ? "clash配置"
        : mutualTarget === "clash-proxies"
          ? "proxies片段"
          : mutualTarget === "json"
            ? "节点列表"
            : mutualTarget === "base64"
              ? "订阅内容"
              : "节点链接";
    return `${base}.${FORMAT_EXTENSIONS[mutualTarget]}`;
  }

  const tabBtn = (active: boolean) =>
    `flex-1 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
      active ? "bg-[var(--accent)] text-[var(--accent-text)]" : "text-[var(--dim)]"
    }`;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <main className="mx-auto w-full max-w-3xl px-4 pb-12">
        <div className="pt-6 pb-4">
          <h1 className="text-2xl font-semibold leading-snug">二维码 / 配置文件 → 订阅内容</h1>
          <p className="mt-1.5 text-sm text-[var(--dim)]">
            粘贴节点链接、上传 Clash 配置或二维码截图，转成分享链接、完整 Clash 配置和订阅内容；转换都在这台设备上完成，不经过第三方网站。这是独立版：没有服务器，记录和订阅都只存在本机，「本地订阅」一栏可以把订阅保存到本地订阅库，需要时复制内容、下载文件或扫二维码导入。下面新增的「格式互转」可以选定源格式和目标格式，在五种格式之间来回转。
          </p>
        </div>

        {/* 格式互转 */}
        <section aria-label="格式互转" className="mb-5 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] p-4">
          <h2 className="text-lg font-semibold">格式互转</h2>
          <p className="mt-1 text-sm text-[var(--dim)]">
            选源格式 → 选目标格式 → 粘贴内容 → 开始互转。五种格式任意互转：分享链接、Base64 订阅、Clash 完整配置、Clash proxies 片段、JSON 节点列表。比如把一条 vless:// 链接选「分享链接 → Clash 完整配置」，就能得到 Clash Meta 直接导入的 YAML。
          </p>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label htmlFor="mutual-source" className="text-sm font-medium">
                源格式
              </label>
              <select
                id="mutual-source"
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5"
                value={mutualSource}
                onChange={(e) => setMutualSource(e.target.value as SourceFormat)}
              >
                <option value="auto">自动识别</option>
                {(Object.keys(FORMAT_LABELS) as ConvertFormat[]).map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABELS[f]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              aria-label="互换源格式和目标格式"
              className="shrink-0 rounded-lg border border-[var(--border)] px-4 py-2.5 font-semibold"
              onClick={handleSwapFormats}
            >
              ⇄ 互换
            </button>
            <div className="flex-1">
              <label htmlFor="mutual-target" className="text-sm font-medium">
                目标格式
              </label>
              <select
                id="mutual-target"
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5"
                value={mutualTarget}
                onChange={(e) => setMutualTarget(e.target.value as ConvertFormat)}
              >
                {(Object.keys(FORMAT_LABELS) as ConvertFormat[]).map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABELS[f]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {mutualSource === "auto" && mutualInput.trim() && (
            <p className="mt-2 text-[13px] text-[var(--dim)]">
              自动识别：{mutualDetectedFormat === "unknown" ? "还没认出这段内容是什么格式" : `看起来是「${FORMAT_LABELS[mutualDetectedFormat]}」`}
            </p>
          )}

          <label htmlFor="mutual-input" className="mt-3 block text-sm font-medium">
            要转换的内容
          </label>
          <textarea
            id="mutual-input"
            className="mono mt-1 h-36 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-[13px] leading-relaxed outline-none focus:border-[var(--accent)]"
            placeholder={"粘贴任意一种格式的内容，例如：\nvless://…（分享链接）\n或整段 Base64 订阅内容\n或 Clash YAML / proxies 片段 / JSON 节点列表"}
            value={mutualInput}
            onChange={(e) => setMutualInput(e.target.value)}
          />
          <button
            type="button"
            className="mt-3 w-full rounded-lg bg-[var(--accent)] px-4 py-3 text-base font-semibold text-[var(--accent-text)]"
            onClick={handleMutualConvert}
          >
            开始互转 → {FORMAT_LABELS[mutualTarget]}
          </button>

          {mutualWarnings.length > 0 && (
            <div className="mt-3 rounded-lg bg-[var(--warn-bg)] px-3 py-2.5" role="alert">
              {mutualWarnings.map((w, i) => (
                <p key={i} className="text-sm text-[var(--warn)]">
                  {w}
                </p>
              ))}
            </div>
          )}

          {mutualDone && mutualNodes.length > 0 && (
            <div className="mt-4 border-t border-[var(--border)] pt-3">
              <p className="text-sm font-medium">
                转出 {mutualNodes.length} 个节点
                {mutualDetected && <span className="ml-2 font-normal text-[var(--dim)]">来源：{mutualDetected}</span>}
                <span className="ml-2 font-normal text-[var(--dim)]">
                  节点：{mutualNodes.map((n) => n.name).join("、")}
                </span>
              </p>
              <label htmlFor="mutual-output" className="mt-3 block text-sm font-medium">
                转换结果（{FORMAT_LABELS[mutualTarget]}）
              </label>
              <textarea
                id="mutual-output"
                readOnly
                className="mono mt-1 h-44 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-[12px] leading-relaxed outline-none"
                value={mutualOutput}
                placeholder="目标格式没有生成内容"
              />
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  className="flex-1 rounded-lg bg-[var(--accent)] px-4 py-3 font-semibold text-[var(--accent-text)] disabled:opacity-50"
                  disabled={!mutualOutput}
                  onClick={() => handleCopy("mutual-output", mutualOutput)}
                >
                  {copiedKey === "mutual-output" ? "已复制 ✓" : "复制结果"}
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-lg border border-[var(--border)] px-4 py-3 font-semibold disabled:opacity-50"
                  disabled={!mutualOutput}
                  onClick={() => downloadText(mutualDownloadName(), mutualOutput)}
                >
                  下载结果（{mutualDownloadName()}）
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-lg border border-[var(--border)] px-4 py-3 font-semibold disabled:opacity-50"
                  disabled={!mutualOutput}
                  onClick={handleChainConvert}
                >
                  把结果填回继续转
                </button>
              </div>
              <p className="mt-2 text-[13px] text-[var(--dim)]">「把结果填回继续转」会把这次的结果放回输入框，并把源格式设为刚才的目标格式，接着选新目标就能连续转下去；点上面的「⇄ 互换」还会同时把结果带过去。</p>
            </div>
          )}
        </section>

        {/* 输入区 */}
        <section aria-label="输入" className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex gap-1 rounded-lg bg-[var(--surface-alt)] p-1" role="tablist" aria-label="输入方式">
            <button type="button" role="tab" aria-selected={inputTab === "text"} className={tabBtn(inputTab === "text")} onClick={() => setInputTab("text")}>
              粘贴文本
            </button>
            <button type="button" role="tab" aria-selected={inputTab === "file"} className={tabBtn(inputTab === "file")} onClick={() => setInputTab("file")}>
              上传配置文件
            </button>
            <button type="button" role="tab" aria-selected={inputTab === "qr"} className={tabBtn(inputTab === "qr")} onClick={() => setInputTab("qr")}>
              上传二维码
            </button>
          </div>

          {inputTab === "text" && (
            <div className="mt-4">
              <label htmlFor="paste-input" className="text-sm font-medium">
                节点链接 / 订阅内容 / Clash 配置
              </label>
              <textarea
                id="paste-input"
                className="mono mt-2 h-44 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-[13px] leading-relaxed outline-none focus:border-[var(--accent)]"
                placeholder={"把内容粘贴到这里，例如：\nvless://… 或 vmess://…（可多条，一行一条）\n或整段 Base64 订阅内容\n或 Clash 的 YAML 配置全文"}
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
              />
              <button
                type="button"
                className="mt-3 w-full rounded-lg bg-[var(--accent)] px-4 py-3 text-base font-semibold text-[var(--accent-text)]"
                onClick={handleConvertText}
              >
                开始转换
              </button>
            </div>
          )}

          {inputTab === "file" && (
            <div className="mt-4">
              <p className="text-sm text-[var(--dim)]">选一个 Clash 配置文件（.yaml / .yml）或存着节点链接的文本文件，选好后自动转换。</p>
              <input ref={fileInputRef} type="file" accept=".yaml,.yml,.txt,.conf,.json,text/plain" className="hidden" aria-label="选择配置文件" onChange={handleConfigFile} />
              <button
                type="button"
                className="mt-3 w-full rounded-lg border-2 border-dashed border-[var(--border)] bg-[var(--bg)] px-4 py-8 text-base font-medium"
                onClick={() => fileInputRef.current?.click()}
              >
                {fileName ? `已选：${fileName}（点这里换一个）` : "点这里选择配置文件"}
              </button>
            </div>
          )}

          {inputTab === "qr" && (
            <div className="mt-4">
              <p className="text-sm text-[var(--dim)]">选一张节点二维码截图，识别出链接后自动转换。截图里二维码要完整、清晰。</p>
              <input ref={qrInputRef} type="file" accept="image/*" className="hidden" aria-label="选择二维码图片" onChange={handleQrFile} />
              <button
                type="button"
                className="mt-3 w-full rounded-lg border-2 border-dashed border-[var(--border)] bg-[var(--bg)] px-4 py-8 text-base font-medium"
                onClick={() => qrInputRef.current?.click()}
              >
                点这里选择二维码图片
              </button>
              {qrStatus && <p className="mt-2 text-sm text-[var(--dim)]">{qrStatus}</p>}
            </div>
          )}

          {warnings.length > 0 && (
            <div className="mt-4 rounded-lg bg-[var(--warn-bg)] px-3 py-2.5" role="alert">
              {warnings.map((w, i) => (
                <p key={i} className="text-sm text-[var(--warn)]">
                  {w}
                </p>
              ))}
            </div>
          )}
        </section>

        {/* 结果区 */}
        {converted && nodes.length > 0 && (
          <>
            <section aria-label="节点列表" className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">
                  识别到 {nodes.length} 个节点
                  {sourceKind && <span className="ml-2 text-sm font-normal text-[var(--dim)]">来源：{sourceKind}</span>}
                </h2>
                <button type="button" className="text-sm text-[var(--dim)] underline" onClick={handleClear}>
                  清空重来
                </button>
              </div>
              {linklessCount > 0 && (
                <p className="mt-1 text-sm text-[var(--warn)]">其中 {linklessCount} 个节点生成不了分享链接，只能放进 Clash 配置。</p>
              )}
              {clashlessCount > 0 && (
                <p className="mt-1 text-sm text-[var(--warn)]">其中 {clashlessCount} 个节点放不进 Clash 配置，只能用分享链接。</p>
              )}
              <ul className="mt-3 divide-y divide-[var(--border)]">
                {nodes.map((n) => (
                  <li key={n.id} className="py-3">
                    <div className="flex items-center gap-2">
                      <span className="mono shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] font-semibold uppercase">
                        {n.type}
                      </span>
                      <input
                        aria-label={`节点名称：${n.name}`}
                        className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-base font-medium outline-none focus:border-[var(--border)] focus:bg-[var(--bg)]"
                        value={n.name}
                        onChange={(e) => handleRename(n.id, e.target.value)}
                      />
                      <button
                        type="button"
                        aria-label={`删除节点 ${n.name}`}
                        className="shrink-0 px-1 text-lg leading-none text-[var(--dim)]"
                        onClick={() => handleRemoveNode(n.id)}
                      >
                        ×
                      </button>
                    </div>
                    <p className="mono mt-1 truncate text-[13px] text-[var(--dim)]">
                      {n.server}:{n.port}
                    </p>
                    <div className="mt-1.5 flex gap-4">
                      {n.link && (
                        <>
                          <button type="button" className="text-sm text-[var(--accent)]" onClick={() => handleCopy(`node-${n.id}`, n.link)}>
                            {copiedKey === `node-${n.id}` ? "已复制 ✓" : "复制链接"}
                          </button>
                          <button
                            type="button"
                            className="text-sm text-[var(--accent)]"
                            onClick={() => {
                              setQrKind("link");
                              setQrNodeId(n.id);
                            }}
                          >
                            看二维码
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[13px] text-[var(--dim)]">节点名可以直接改，改完下面的链接、Clash 配置和下载文件名会跟着变。</p>
            </section>

            <section aria-label="转换结果" className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex gap-1 rounded-lg bg-[var(--surface-alt)] p-1" role="tablist" aria-label="输出格式">
                <button type="button" role="tab" aria-selected={outputTab === "links"} className={tabBtn(outputTab === "links")} onClick={() => setOutputTab("links")}>
                  分享链接
                </button>
                <button type="button" role="tab" aria-selected={outputTab === "clash"} className={tabBtn(outputTab === "clash")} onClick={() => setOutputTab("clash")}>
                  Clash 配置
                </button>
                <button type="button" role="tab" aria-selected={outputTab === "sub"} className={tabBtn(outputTab === "sub")} onClick={() => setOutputTab("sub")}>
                  订阅内容
                </button>
                <button type="button" role="tab" aria-selected={outputTab === "suburl"} className={tabBtn(outputTab === "suburl")} onClick={() => setOutputTab("suburl")}>
                  本地订阅
                </button>
              </div>

              {outputTab === "links" && (
                <div className="mt-4">
                  <p className="text-sm text-[var(--dim)]">一行一个节点链接，粘贴到 v2rayNG / 小火箭 / Clash Meta 里就能导入。</p>
                  <pre className="mono mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--bg)] p-3 text-[12px] leading-relaxed">
                    {shareLinks.join("\n")}
                  </pre>
                  <button
                    type="button"
                    className="mt-3 w-full rounded-lg bg-[var(--accent)] px-4 py-3 font-semibold text-[var(--accent-text)]"
                    onClick={() => handleCopy("all-links", shareLinks.join("\n"))}
                  >
                    {copiedKey === "all-links" ? "已复制 ✓" : "复制全部链接"}
                  </button>
                </div>
              )}

              {outputTab === "clash" && (
                <div className="mt-4">
                  <p className="text-sm text-[var(--dim)]">
                    完整配置：带 PROXY 分组和规则，导入 Clash Meta 后在「代理」页就能选节点。下载文件名可以先改好再下载。
                  </p>
                  <label htmlFor="yaml-filename" className="mt-3 block text-sm font-medium">
                    下载文件名
                  </label>
                  <input
                    id="yaml-filename"
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 outline-none focus:border-[var(--accent)]"
                    value={yamlFileName}
                    onChange={(e) => {
                      setYamlFileName(e.target.value);
                      setYamlNameEdited(true);
                    }}
                  />
                  <pre className="mono mt-3 max-h-64 overflow-auto whitespace-pre rounded-lg bg-[var(--bg)] p-3 text-[12px] leading-relaxed">
                    {clashYaml}
                  </pre>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      className="flex-1 rounded-lg bg-[var(--accent)] px-4 py-3 font-semibold text-[var(--accent-text)]"
                      onClick={() => downloadText(yamlFileName.trim() || "clash配置.yaml", clashYaml)}
                    >
                      下载 .yaml
                    </button>
                    <button
                      type="button"
                      className="flex-1 rounded-lg border border-[var(--border)] px-4 py-3 font-semibold"
                      onClick={() => handleCopy("clash", clashYaml)}
                    >
                      {copiedKey === "clash" ? "已复制 ✓" : "复制配置"}
                    </button>
                  </div>
                </div>
              )}

              {outputTab === "sub" && (
                <div className="mt-4">
                  <p className="text-sm text-[var(--dim)]">
                    这是订阅的原始内容（Base64）：在 v2rayNG / 小火箭里选「从剪贴板导入」或粘贴到订阅内容里就能用；也可以下载成文件保存。独立版没有 https 订阅地址，常用的订阅可以在「本地订阅」里保存到本地订阅库，随时取用。
                  </p>
                  <pre className="mono mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--bg)] p-3 text-[12px] leading-relaxed">
                    {subContent}
                  </pre>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      className="flex-1 rounded-lg bg-[var(--accent)] px-4 py-3 font-semibold text-[var(--accent-text)]"
                      onClick={() => handleCopy("sub", subContent)}
                    >
                      {copiedKey === "sub" ? "已复制 ✓" : "复制订阅内容"}
                    </button>
                    <button
                      type="button"
                      className="flex-1 rounded-lg border border-[var(--border)] px-4 py-3 font-semibold"
                      onClick={() => downloadText("订阅内容.txt", subContent)}
                    >
                      下载 .txt
                    </button>
                  </div>
                </div>
              )}

              {outputTab === "suburl" && (
                <div className="mt-4">
                  <p className="text-sm text-[var(--dim)]">
                    独立版没有公共服务器，订阅不会生成可公网拉取的 https 地址，而是把订阅内容保存到这台设备自己的「本地订阅库」里。之后在下面的订阅库条目里可以复制内容、下载订阅文件或生成二维码，拿去导入 Clash Meta / v2rayNG / 小火箭。
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      aria-pressed={pubFormat === "b64"}
                      className={`rounded-lg px-3 py-2 text-sm font-medium ${pubFormat === "b64" ? "bg-[var(--accent)] text-[var(--accent-text)]" : "bg-[var(--surface-alt)] text-[var(--dim)]"}`}
                      onClick={() => {
                        setPubFormat("b64");
                        setPubSaved(false);
                      }}
                    >
                      通用订阅（Base64）
                    </button>
                    <button
                      type="button"
                      aria-pressed={pubFormat === "clash"}
                      className={`rounded-lg px-3 py-2 text-sm font-medium ${pubFormat === "clash" ? "bg-[var(--accent)] text-[var(--accent-text)]" : "bg-[var(--surface-alt)] text-[var(--dim)]"}`}
                      onClick={() => {
                        setPubFormat("clash");
                        setPubSaved(false);
                      }}
                    >
                      Clash 配置（YAML）
                    </button>
                  </div>
                  <p className="mt-2 text-[13px] text-[var(--dim)]">
                    {pubFormat === "b64"
                      ? "通用订阅适合 v2rayNG / 小火箭，内容就是「订阅内容」那份 Base64。"
                      : "Clash 配置适合 Clash Meta，保存的就是完整的 YAML 配置，下载文件导入后在「代理」页选 PROXY 分组。"}
                  </p>
                  <div className="mt-3 rounded-lg bg-[var(--warn-bg)] px-3 py-2.5" role="note">
                    <p className="text-sm text-[var(--warn)]">
                      保存后，这份订阅内容（里面有节点链接）只存在这台设备的浏览器本地存储里，不会上传到任何服务器。注意别把导出的订阅文件或内容发给不信任的人；不用了随时在下面「本地订阅库」里删除。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="mt-3 w-full rounded-lg bg-[var(--accent)] px-4 py-3 font-semibold text-[var(--accent-text)] disabled:opacity-50"
                    disabled={!canPublish || publishMutation.isPending}
                    onClick={handlePublish}
                  >
                    {publishMutation.isPending ? "正在保存…" : "保存到本地订阅库"}
                  </button>
                  {!canPublish && (
                    <p className="mt-2 text-sm text-[var(--warn)]">
                      {pubFormat === "b64"
                        ? "当前节点都生成不了分享链接，没法保存通用订阅，换 Clash 配置格式试试。"
                        : "当前节点都放不进 Clash 配置，没法保存 Clash 订阅，换通用订阅格式试试。"}
                    </p>
                  )}
                  {publishMutation.isError && (
                    <p className="mt-2 text-sm text-[var(--warn)]">保存失败，本地存储可能已满，清掉一些旧订阅再试一次。</p>
                  )}
                  {pubSaved && (
                    <div className="mt-3">
                      <p className="text-sm font-medium">
                        已保存到本地订阅库（保存的是刚才这一刻的内容，之后改名或删节点不会影响它，要更新就重新保存）。独立版没有公网订阅地址，请到下方「本地订阅库」里复制内容、下载文件或生成二维码使用。
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* 二维码 */}
              <div className="mt-6 border-t border-[var(--border)] pt-4">
                <h3 className="text-base font-semibold">二维码</h3>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    aria-pressed={qrKind === "link"}
                    className={`rounded-lg px-3 py-2 text-sm font-medium ${qrKind === "link" ? "bg-[var(--accent)] text-[var(--accent-text)]" : "bg-[var(--surface-alt)] text-[var(--dim)]"}`}
                    onClick={() => setQrKind("link")}
                  >
                    节点链接二维码
                  </button>
                  <button
                    type="button"
                    aria-pressed={qrKind === "sub"}
                    className={`rounded-lg px-3 py-2 text-sm font-medium ${qrKind === "sub" ? "bg-[var(--accent)] text-[var(--accent-text)]" : "bg-[var(--surface-alt)] text-[var(--dim)]"}`}
                    onClick={() => setQrKind("sub")}
                  >
                    订阅内容二维码
                  </button>
                </div>
                {qrKind === "link" && nodes.filter((n) => n.link).length > 1 && (
                  <div className="mt-3">
                    <label htmlFor="qr-node-select" className="text-sm font-medium">
                      选哪个节点
                    </label>
                    <select
                      id="qr-node-select"
                      className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5"
                      value={qrNode?.id ?? ""}
                      onChange={(e) => setQrNodeId(e.target.value)}
                    >
                      {nodes
                        .filter((n) => n.link)
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.name}
                          </option>
                        ))}
                    </select>
                  </div>
                )}
                <div className="mt-3 flex flex-col items-center">
                  {qrError && <p className="text-sm text-[var(--warn)]">{qrError}</p>}
                  {qrDataUrl && !qrError && (
                    <>
                      <img src={qrDataUrl} alt={qrKind === "sub" ? "订阅内容二维码" : `节点 ${qrNode?.name ?? ""} 的二维码`} className="w-56 max-w-full rounded-lg bg-white p-1" />
                      <p className="mono mt-2 max-w-full truncate text-[12px] text-[var(--dim)]">
                        {qrKind === "sub" ? "订阅内容（全部节点）" : (qrNode?.name ?? "")}
                      </p>
                      <p className="mt-1 text-[13px] text-[var(--dim)]">用小火箭 / v2rayNG 扫一扫就能导入</p>
                    </>
                  )}
                </div>
              </div>
            </section>
          </>
        )}

        {converted && nodes.length === 0 && (
          <section aria-label="没有结果" className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-sm text-[var(--dim)]">这次没有转出节点。检查一下内容是不是完整的链接、订阅内容或带 proxies 的 Clash 配置，再试一次。</p>
          </section>
        )}

        {!converted && (
          <section aria-label="使用说明" className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="text-base font-semibold">怎么用</h2>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-[var(--dim)]">
              <li>把节点链接粘贴进来，或上传 Clash 配置文件 / 二维码截图。</li>
              <li>点「开始转换」，核对识别出的节点，名字不对可以直接改。</li>
              <li>按需要拿结果：复制分享链接、下载带文件名的 Clash 配置、复制订阅内容、扫二维码导入，或在「本地订阅」里把订阅保存到本地订阅库。</li>
            </ol>
            <p className="mt-3 text-sm text-[var(--dim)]">
              支持 vless、vmess、trojan、ss、hysteria2、tuic 链接，Clash YAML 配置，以及 Base64 订阅内容，互相之间都能转。
            </p>
          </section>
        )}

        {/* 本地订阅库（独立版：平台版这里是已发布的订阅，靠服务器地址拉取） */}
        <section aria-label="本地订阅库" className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-base font-semibold">本地订阅库</h2>
          <p className="mt-1 text-[13px] text-[var(--dim)]">保存在这台设备上的订阅，没有公网地址；用复制内容、下载文件或二维码导入客户端。</p>
          {published.isPending && <p className="mt-2 text-sm text-[var(--dim)]">加载中…</p>}
          {published.data && published.data.items.length === 0 && (
            <p className="mt-2 text-sm text-[var(--dim)]">还没有保存过订阅。转换出节点后，在结果的「本地订阅」里可以保存到本地订阅库。</p>
          )}
          {published.data && published.data.items.length > 0 && (
            <ul className="mt-2 divide-y divide-[var(--border)]">
              {published.data.items.map((item: PublishedItem) => (
                <li key={item.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {item.title} · {item.node_count} 个节点 · {item.format === "clash" ? "Clash 配置" : "通用订阅"}
                      </p>
                      <p className="truncate text-[13px] text-[var(--dim)]">
                        {formatTime(item.created_at)}
                        {item.node_names.length > 0 ? ` · ${item.node_names.join("、")}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`删除订阅 ${item.title}`}
                      className="shrink-0 text-sm text-[var(--dim)] underline"
                      onClick={() => deletePublishedMutation.mutate(item.id)}
                    >
                      删除
                    </button>
                  </div>
                  <p className="mono mt-1.5 truncate text-[12px] text-[var(--dim)]">{contentSummary(item.content)}</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                    <button
                      type="button"
                      className="text-sm text-[var(--accent)]"
                      onClick={() => handleCopy(`pub-${item.id}`, item.content)}
                    >
                      {copiedKey === `pub-${item.id}` ? "已复制 ✓" : "复制内容"}
                    </button>
                    <button
                      type="button"
                      className="text-sm text-[var(--accent)]"
                      onClick={() =>
                        downloadText(
                          item.format === "clash" ? `${item.title}.yaml` : `${item.title}.txt`,
                          item.content,
                        )
                      }
                    >
                      下载文件
                    </button>
                    <button
                      type="button"
                      className="text-sm text-[var(--accent)]"
                      onClick={() => void toggleSubQr(item.id, item.content)}
                    >
                      {subQrId === item.id ? "收起二维码" : "二维码"}
                    </button>
                  </div>
                  {subQrId === item.id && (
                    <div className="mt-2 flex flex-col items-start">
                      {subQrError && <p className="text-sm text-[var(--warn)]">{subQrError}</p>}
                      {subQrUrl && !subQrError && (
                        <img src={subQrUrl} alt={`订阅 ${item.title} 的二维码`} className="w-48 max-w-full rounded-lg bg-white p-1" />
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 转换记录 */}
        <section aria-label="转换记录" className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-base font-semibold">转换记录</h2>
          {history.isPending && <p className="mt-2 text-sm text-[var(--dim)]">加载中…</p>}
          {history.data && history.data.items.length === 0 && (
            <p className="mt-2 text-sm text-[var(--dim)]">还没有转换记录。记录只保存时间、来源和节点名，不保存链接和密码。</p>
          )}
          {history.data && history.data.items.length > 0 && (
            <ul className="mt-2 divide-y divide-[var(--border)]">
              {history.data.items.map((item: HistoryItem) => (
                <li key={item.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {item.title} · {item.node_count} 个节点
                    </p>
                    <p className="truncate text-[13px] text-[var(--dim)]">
                      {formatTime(item.created_at)} · {item.source_kind}
                      {item.node_names.length > 0 ? ` · ${item.node_names.join("、")}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`删除记录 ${item.title}`}
                    className="shrink-0 text-sm text-[var(--dim)] underline"
                    onClick={() => deleteMutation.mutate(item.id)}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* APK 下载入口：只在普通浏览器里显示；APK 壳里（保存桥存在）隐藏，
            避免用户在 App 内点到同目录下并不存在的 APK 文件。 */}
        {!inApkShell() && (
          <p className="mt-8 text-center text-[13px] text-[var(--dim)]">
            <a href="订阅转换_V1.1.apk" download className="underline">
              下载安卓版 APK（订阅转换 V1.1）
            </a>
          </p>
        )}

        {/* 网页版入口（与上面镜像）：只在 APK 壳里显示；点击走壳的导航拦截，
            交给系统浏览器打开，不在 WebView 里把本地应用顶掉。 */}
        {inApkShell() && (
          <p className="mt-8 text-center text-[13px] text-[var(--dim)]">
            网页版：
            <a
              href="https://8000-agq2wptml5xfnwp63fiqovdu6m.instabox.tech"
              className="underline"
            >
              8000-agq2wptml5xfnwp63fiqovdu6m.instabox.tech
            </a>{" "}
            <button
              type="button"
              className="text-[var(--accent)]"
              onClick={() =>
                handleCopy(
                  "web-version-url",
                  "https://8000-agq2wptml5xfnwp63fiqovdu6m.instabox.tech",
                )
              }
            >
              {copiedKey === "web-version-url" ? "已复制 ✓" : "复制地址"}
            </button>
          </p>
        )}
      </main>
    </div>
  );
}
