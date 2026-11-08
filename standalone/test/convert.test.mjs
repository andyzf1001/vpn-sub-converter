// 合成测试：全部使用假节点（假 UUID、test.example.com），不含任何真实节点。
// 运行：node ./test/convert.test.mjs（Node 24 自带 TS 类型擦除，直接 import convert.ts）
import assert from "node:assert";
import { load as yamlLoad } from "js-yaml";
import {
  parseAnyInput,
  parseWithFormat,
  generateClashYaml,
  generateForFormat,
} from "../client/src/lib/convert.ts";

const FAKE_UUID = "11111111-2222-3333-4444-555555555555";
const link = `vless://${FAKE_UUID}@test.example.com:443?encryption=none&security=tls&sni=test.example.com&type=ws&path=%2Fws#TestNode`;

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

// 1) 分享链接 → Clash 完整配置（可被 YAML 解析）
const r1 = parseAnyInput(link);
assert.equal(r1.nodes.length, 1, "link parse node count");
assert.equal(r1.nodes[0].name, "TestNode");
const clash = generateClashYaml(r1.nodes);
ok("link->clash", () => {
  const doc = yamlLoad(clash);
  assert.ok(Array.isArray(doc.proxies), "clash proxies present");
  assert.equal(doc.proxies[0].type, "vless");
  assert.equal(doc.proxies[0].server, "test.example.com");
  assert.equal(doc.proxies[0].port, 443);
  assert.ok(Array.isArray(doc["proxy-groups"]), "proxy-groups present");
  assert.ok(Array.isArray(doc.rules), "rules present");
});

// 2) Clash 配置 → 分享链接
ok("clash->link", () => {
  const r2 = parseAnyInput(clash);
  assert.equal(r2.nodes.length, 1, "clash parse node count");
  const links = generateForFormat(r2.nodes, "links");
  assert.ok(links.startsWith("vless://"), "link scheme");
  assert.ok(links.includes(FAKE_UUID), "uuid roundtrip");
  assert.ok(links.includes("test.example.com"), "server roundtrip");
});

// 3) Base64 订阅 → JSON
ok("base64->json", () => {
  const sub = generateForFormat(r1.nodes, "base64");
  const r3 = parseAnyInput(sub);
  assert.equal(r3.nodes.length, 1, "base64 parse node count");
  const json = generateForFormat(r3.nodes, "json");
  const arr = JSON.parse(json);
  assert.ok(Array.isArray(arr), "json is array");
  assert.equal(arr[0].name, "TestNode");
  assert.equal(arr[0].server, "test.example.com");
});

// 4) proxies 片段互转：节点 → 片段 → 节点
ok("proxies-fragment roundtrip", () => {
  const frag = generateForFormat(r1.nodes, "clash-proxies");
  assert.ok(frag.includes("proxies:"), "fragment has proxies key");
  const doc = yamlLoad(frag);
  assert.equal(doc.proxies[0].name, "TestNode");
  const r4 = parseWithFormat(frag, "clash-proxies");
  assert.equal(r4.nodes.length, 1, "fragment parse node count");
  assert.equal(r4.nodes[0].server, "test.example.com");
  // 再从片段解析结果生成完整配置，确认链路闭环
  const clash2 = generateForFormat(r4.nodes, "clash");
  assert.ok(yamlLoad(clash2).proxies[0].uuid === FAKE_UUID, "fragment->clash uuid");
});

console.log(`ALL ${passed}/4 PASSED`);
