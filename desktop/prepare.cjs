const fs = require("node:fs");
const path = require("node:path");

const extension = path.resolve(__dirname, "../extension");
const output = path.join(__dirname, "generated");
const source = (...parts) => fs.readFileSync(path.join(...parts), "utf8");
const manifest = { version: require("../package.json").version };
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "trusted.cjs"), source(__dirname, "preload.js") + `
  contextBridge.exposeInMainWorld("masTransport", makeTransport(${JSON.stringify(manifest)}));
`);

const worker = source(extension, "background", "service-worker.js").replace(/^importScripts\(.*\);\r?\n/gm, "");
fs.writeFileSync(path.join(output, "worker.js"), [
  source(extension, "config.js"),
  source(extension, "translation", "providers.js"),
  worker,
].join("\n;\n"));
