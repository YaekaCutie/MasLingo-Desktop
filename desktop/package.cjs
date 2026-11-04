const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { packager } = require("@electron/packager");
const { version: electronVersion } = require("electron/package.json");

async function build() {
  const root = path.resolve(__dirname, "..");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "maslingo-package-"));
  try {
    const backend = path.join(stage, "backend");
    fs.cpSync(path.join(root, "backend"), backend, {
      recursive: true,
      filter: file => !["tests", "__pycache__", ".env"].includes(path.basename(file)),
    });
    const companion = path.join(stage, "browser-companion");
    fs.cpSync(path.join(root, "extension"), companion, { recursive: true });
    const extraResource = [backend, companion, path.join(__dirname, "windows-ocr.ps1")];
    if (process.env.MAS_DESKTOP_ENGINE_DIR) {
      const engine = path.resolve(process.env.MAS_DESKTOP_ENGINE_DIR);
      const runtime = path.join(engine, "runtime");
      const models = path.join(engine, "models");
      if (!fs.existsSync(path.join(runtime, "python.exe")) || !fs.existsSync(models))
        throw new Error("MAS_DESKTOP_ENGINE_DIR 必须包含 runtime/python.exe 和 models");
      extraResource.push(runtime, models);
    }
    const apps = await packager({
      dir: root,
      out: path.join(root, "dist"),
      name: "MasLingo Desktop",
      executableName: "MasLingo Desktop",
      platform: "win32",
      arch: "x64",
      electronVersion,
      electronZipDir: process.env.MAS_ELECTRON_ZIP_DIR,
      asar: true,
      extraResource,
      ignore: /^\/(\.git|\.venv|\.hf|backend|dist|test)(\/|$)/,
      overwrite: true,
    });
    console.log(apps.join("\n"));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

build().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
