// 需要 Node 22.13+：把 engine.ts 去掉类型生成 engine.js（engine.js 已提交，平时不必运行）
const m = require("node:module"); const fs = require("fs"); const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "engine.ts"), "utf8");
fs.writeFileSync(path.join(__dirname, "..", "engine.js"), "// 由 engine.ts 生成（去掉类型标注）\n" + m.stripTypeScriptTypes(src));
