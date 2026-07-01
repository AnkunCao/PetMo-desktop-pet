const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "src", "settings", "index.html"),
  "utf8"
);

test("设置页包含可折叠的 API Key 获取引导区", () => {
  assert.match(html, /id="api-guide"/);
  assert.match(html, /id="api-guide-toggle"/);
  assert.match(html, /id="api-guide-body"/);
});

test("引导区同时提供中英文内容块", () => {
  assert.match(html, /data-lang-content="zh"/);
  assert.match(html, /data-lang-content="en"/);
  assert.match(html, /platform\.openai\.com/);
  assert.match(html, /Create new secret key/);
});

test("引导区包含醒目的安全警告文案", () => {
  assert.match(html, /密码/);
  assert.match(html, /泄漏/);
  assert.match(html, /password/);
  assert.match(html, /leaked/);
  assert.match(html, /api-guide-warning/);
});

test("引导区提供中英文语言切换按钮", () => {
  assert.match(html, /data-lang="zh"/);
  assert.match(html, /data-lang="en"/);
  assert.match(html, /lang-button/);
});
