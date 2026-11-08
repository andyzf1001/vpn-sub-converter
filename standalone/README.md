# 订阅转换（独立版）

VPN 订阅转换工具的独立运行版本：不依赖 Muse Spaces 平台和任何服务器，
克隆/拷贝下来用静态服务器打开就能用。转换逻辑与平台版（vpn-sub-converter）
完全相同，核心引擎是同一份 `client/src/lib/convert.ts`。

## 功能

- 输入：节点分享链接（vless / vmess / trojan / ss / hysteria2 / tuic）、
  Clash 完整配置或 `proxies` 片段、Base64 订阅、JSON 节点列表、
  上传配置文件、上传二维码图片识别（jsQR，纯本地）。
- 输出：分享链接、Clash 完整配置（带 PROXY 分组与 MATCH 规则）、
  Base64 订阅内容、Clash `proxies` 片段、JSON 节点列表，以及二维码（qrcode 库本地生成）。
- **格式互转台**：源格式自动识别或手动指定，五种格式之间任意互转，
  可互换源/目标、把结果填回继续转。

## 本地运行

需要 Bun（或用任意静态服务器托管构建产物）：

```bash
bun install        # 安装依赖（全部为 npm 公开包）
bun run build      # 打包，产物在 dist/
bunx serve dist    # 或 python3 -m http.server -d dist
```

打开页面即可使用，不需要后端、不需要账号、不会向任何服务器发送数据。

开发校验：

```bash
bun run typecheck        # TypeScript 类型检查
bun run test:convert     # 转换引擎合成测试（假节点，四条互转链路）
```

## 与平台版的差异

平台版跑在 Muse Spaces 上，靠 `@hatch/space-sdk` 提供打包、服务端
actions、数据库和 blob 存储。独立版把这些全部换成公开/本地实现：

| 平台版 | 独立版 |
|---|---|
| `@hatch/space-sdk/build` 打包 | Bun 自带打包器 + `bun-plugin-tailwind`（公开包） |
| SDK 的 QueryClient、SafeArea 组件 | 应用自己的 `QueryClient`，去掉平台组件 |
| 服务端 actions + 数据库存转换记录 | `localStorage` 本地存储（只存元信息，不存链接和密码，与平台版一致） |
| 「发布订阅」生成可公网拉取的 https 订阅地址 | **没有公网地址**：改为「本地订阅库」，订阅内容存本机，条目提供复制内容、下载订阅文件、生成二维码、删除 |

特别说明：独立版无法生成能在客户端订阅栏里远程拉取更新的订阅 URL，
这是没有公共服务器的必然限制，界面里已如实标注，不存在假链接。
需要在别的设备上用订阅时，用下载文件或二维码传递即可。

## 数据与隐私

- 所有解析和生成都在浏览器本地完成，不经过任何第三方转换网站。
- 转换记录只保存时间、来源、节点数量与节点名。
- 订阅内容只保存在本机 localStorage；导出的文件/内容含节点凭据，
  不要发给不信任的人。

## 目录结构

```
.
├── client/
│   ├── index.html
│   └── src/            # App.tsx 界面、api.ts 本地数据层、lib/convert.ts 转换引擎
├── build.mjs           # Bun 打包脚本
├── test/convert.test.mjs
├── dist/               # 构建产物（index.html + assets/main.js + assets/main.css）
└── package.json
```
