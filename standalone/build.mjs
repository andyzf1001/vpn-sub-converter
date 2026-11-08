// 独立版打包脚本：用 Bun 自带打包器 + 公开的 bun-plugin-tailwind，
// 替代平台版 client/build.mjs 里 SDK 的 buildClient()。
// 产物是纯静态文件（dist/index.html + assets/main.js + assets/main.css），
// 任何静态服务器可托管，也方便塞进 APK 的 assets。

import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["./client/src/main.tsx"],
  outdir: "./dist/assets",
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [tailwind],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const entry = result.outputs.find((o) => o.kind === "entry-point");
if (!entry) throw new Error("no entry output");
// bun-plugin-tailwind 把编译好的 CSS 作为一个 asset 输出（文件名后缀不可靠），
// 按内容特征（以 tailwind 注释/层声明开头）识别它并统一命名为 main.css。
let cssOutput = null;
for (const o of result.outputs) {
  if (o === entry) continue;
  const head = await o.text().then((t) => t.slice(0, 200));
  if (head.includes("tailwindcss") || head.includes("@layer")) {
    cssOutput = o;
    break;
  }
}
if (!cssOutput) throw new Error("no css output from tailwind plugin");

// Bun 默认把入口产为 dist/assets/main.js；CSS 统一写成 main.css 并删掉插件的原名文件。
await Bun.write("./dist/assets/main.css", await cssOutput.text());
if (!cssOutput.path.endsWith("main.css")) {
  const fs = await import("node:fs");
  fs.rmSync(cssOutput.path, { force: true });
}

let html = await Bun.file("./client/index.html").text();
html = html.replace(
  '<script src="./src/main.tsx" type="module"></script>',
  '<link rel="stylesheet" href="./assets/main.css" />\n    <script src="./assets/main.js" type="module"></script>',
);
await Bun.write("./dist/index.html", html);

console.log("BUILD_OK entry+css ->", "dist/assets/main.js", "dist/assets/main.css");
