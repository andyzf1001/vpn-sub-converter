# VPN订阅转换工具（vpn-sub-converter）

一个在本地完成代理节点格式转换的工具，用于把节点分享链接、Clash 配置、Base64 订阅和二维码在本地互相转换，无需把含节点凭据的内容提交到第三方转换网站。

本项目是一个 TypeScript Web 应用：前端为 React 客户端，服务端为 TypeScript actions，数据表结构以 Drizzle SQL 迁移文件的形式随源码提供。

## 支持的格式

输入：

- 节点分享链接：`vless://`、`vmess://`、`trojan://`、`ss://`、`hysteria2://`、`tuic://`
- Clash 完整配置（YAML）与 Clash `proxies` 片段
- Base64 订阅内容
- JSON 节点列表
- 二维码图片（上传图片后在本地识别其中的链接）
- 配置文件上传（文本内容在本地解析）

输出：

- 节点分享链接（可逐个复制，或生成二维码扫码导入）
- Clash 完整配置（YAML，带 `PROXY` 代理组与 `MATCH` 规则，可直接导入 Clash Meta / Mihomo 内核客户端）
- Clash `proxies` 片段
- Base64 订阅内容
- JSON 节点列表

## 主要功能

- **格式互转台**：源格式可自动识别或手动指定，目标格式任意选择，支持一键交换源与目标、把转换结果带回继续转换，实现多种格式之间的连续互转。
- **常规转换**：粘贴文本、上传文件或上传二维码图片，解析为节点列表后统一输出为分享链接、Clash 完整配置、订阅内容和二维码；节点名可在列表中修改，输出内容同步更新。
- **订阅发布（可选）**：仅当用户明确点击发布时，才把当次订阅内容保存为带随机 token 地址的订阅链接；删除该记录时链接立即失效。不点击发布则不会生成任何订阅地址。
- **转换历史**：只保存元信息（时间、来源类型、节点数量、节点名），不保存节点链接和密码。

## 项目结构

```
.
├── client/
│   ├── index.html          # 页面入口
│   ├── build.mjs           # 客户端打包脚本（调用 @hatch/space-sdk）
│   └── src/
│       ├── main.tsx        # 客户端入口
│       ├── App.tsx         # 界面与交互
│       ├── api.ts          # 服务端 action 调用封装
│       ├── lib/convert.ts  # 核心转换逻辑（解析与生成，全部在客户端运行）
│       └── theme.css       # 主题样式
├── server/
│   └── src/
│       ├── actions.ts      # 服务端 actions（转换历史、已发布订阅）
│       └── schema.ts       # Drizzle 数据表结构
├── drizzle/                # 数据库迁移 SQL
├── package.json            # 依赖与脚本
├── bun.lock                # Bun 锁文件
├── bunfig.toml             # Bun 安装配置
├── space.json              # 运行环境描述（TypeScript Web 应用）
└── icon.webp               # 工具图标
```

## 本地运行

运行环境为 Bun（`package.json` 中声明 `packageManager: bun@1.3.10`）与 Muse Spaces 的 TypeScript Web 应用运行时。需要说明的是：`package.json` 中的 `@hatch/space-sdk` 以本地文件路径形式引用，是上述运行环境的组成部分，未发布到 npm，因此在该运行环境之外直接克隆本仓库无法独立安装全部依赖。

在上述运行环境内，可用的脚本与 `package.json` 一致：

```bash
bun install        # 安装依赖
bun run typecheck  # 对 client 与 server 做 TypeScript 类型检查
bun run build      # 构建服务端 actions 与客户端 bundle
```

## 数据与隐私

- 链接、配置文件与二维码的解析和格式生成由客户端代码在本地完成，不经过第三方转换服务。
- 转换历史只记录元信息；订阅内容仅在用户明确执行发布操作时才保存，并以随机 token 作为地址的一部分，删除记录后地址失效。
- 本仓库不包含任何真实节点数据；数据库文件、已发布订阅的数据文件、`node_modules` 与构建产物均未包含在本仓库中。

## 安全提示

节点分享链接、Clash 配置和订阅内容都包含节点凭据（如 UUID、密码），等同于账号密码：

- 不要把包含真实节点的订阅地址、配置文件或二维码公开发布或转发给他人；
- 在公开仓库、截图和聊天中分享本工具时，只使用不含真实节点内容的示例；
- 订阅地址一旦泄露，应立即删除对应发布记录并更换节点凭据。
