const {
  app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, Menu,
  nativeImage, net, protocol, screen, session, shell,
} = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");
const { installBridge } = require("./bridge.cjs");
const { createMediaTools } = require("./media.cjs");
const { remember, editHistory, historyOf } = require("./history.cjs");

const root = path.resolve(__dirname, "..");
const origin = "maslingo://app";
const local = route => origin + "/" + route;
const routes = {
  options: "extension/options/options.html",
  document: "extension/document/document.html",
  media: "desktop/media.html",
  history: "desktop/history.html",
};
const tools = new Map();
const runFile = promisify(execFile);
let window, worker, bridge, backend, capture, hotkeyFailures = [];
let media;
let busy = false;

app.setName("MasLingo Desktop");
if (process.env.MAS_DESKTOP_PROFILE) app.setPath("userData", process.env.MAS_DESKTOP_PROFILE);
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{
  scheme: "maslingo",
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

async function appProtocol(request) {
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname);
  if (url.host === "app" && pathname === "/desktop/screen.png" && capture?.image)
    return new Response(capture.image.toPNG(), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  const filename = path.resolve(root, "." + pathname);
  if (url.host !== "app" || !filename.startsWith(root + path.sep) ||
      !/^\/(desktop|extension)\//.test(pathname) || !/\.(html|css|js)$/.test(filename))
    return new Response(null, { status: 404 });
  try {
    const response = await net.fetch(pathToFileURL(filename).href);
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    headers.set("X-Content-Type-Options", "nosniff");
    if (pathname === "/" + routes.options || pathname === "/" + routes.document) {
      const html = (await response.text()).replace('<script src="../config.js">', [
        '<script src="/desktop/client.js"></script>',
        '<script src="/desktop/trusted.js"></script>',
        '<script src="../config.js">',
      ].join("\n"));
      headers.delete("Content-Length");
      return new Response(html, { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function createWindow(options = {}) {
  const result = new BrowserWindow({
    show: false, autoHideMenuBar: true, ...options,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: path.join(__dirname, "generated", "trusted.cjs"),
    },
  });
  const contents = result.webContents;
  bridge.watch(contents);
  contents.on("will-navigate", event => event.preventDefault());
  contents.on("will-attach-webview", event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const route = Object.keys(routes).find(name => url.split("#")[0] === local(routes[name]));
    if (route) setImmediate(() => openTool(route, new URL(url).hash));
    else if (/^https:\/\//i.test(url)) setImmediate(() => shell.openExternal(url).catch(() => {}));
    return { action: "deny" };
  });
  return result;
}

function openTool(name, hash = "") {
  if (!Object.hasOwn(routes, name)) throw new Error("未知工具");
  const existing = tools.get(name);
  if (existing) { existing.focus(); return; }
  const tool = createWindow({ width: 950, height: 780, minWidth: 430, minHeight: 460 });
  tools.set(name, tool);
  tool.once("ready-to-show", () => tool.show());
  tool.on("closed", () => {
    if (name === "media") media.clear();
    tools.delete(name);
  });
  tool.loadURL(local(routes[name]) + hash).catch(console.error);
}

function showMain() {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function showClipboard() {
  showMain();
  const text = clipboard.readText().trim();
  if (text) bridge.broadcast("shell:text", text.slice(0, 10000), "已读取剪贴板文本");
  else bridge.broadcast("shell:notice", "剪贴板中没有可翻译的文本");
}

function ocrScript() {
  return app.isPackaged ? path.join(process.resourcesPath, "windows-ocr.ps1") : path.join(__dirname, "windows-ocr.ps1");
}

async function runOcr(...args) {
  try {
    const { stdout } = await runFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", ocrScript(), ...args,
    ], { windowsHide: true, timeout: 35000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const message = error.stderr?.trim().split(/\r?\n/)[0];
    throw new Error(message || "Windows 文字识别未能完成");
  }
}

async function recognize(image, language) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "maslingo-ocr-"));
  try {
    const filename = path.join(folder, "crop.png");
    const { width, height } = image.getSize();
    if (Math.max(width, height) > 3800)
      image = image.resize(width > height ? { width: 3800 } : { height: 3800 });
    fs.writeFileSync(filename, image.toPNG());
    return await runOcr("-ImagePath", filename, "-Language", language || "auto");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

async function deliverImage(image, language) {
  showMain();
  bridge.broadcast("shell:notice", "正在识别画面文字…");
  try {
    const { text } = await recognize(image, language);
    const joined = text.replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[ \t]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, "");
    if (joined.trim()) bridge.broadcast("shell:text", joined, "已识别画面文字");
    else bridge.broadcast("shell:notice", "所选区域未识别到文字");
  } catch (error) {
    bridge.broadcast("shell:notice", error.message);
  } finally {
    busy = false;
  }
}

async function startCapture(language) {
  if (busy) return;
  busy = true;
  const restore = window.isVisible() && !window.isMinimized();
  const focused = window.isFocused();
  if (restore) window.hide();
  try {
    await new Promise(resolve => setTimeout(resolve, 170));
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { bounds, scaleFactor } = display;
    const sources = await desktopCapturer.getSources({
      types: ["screen"], thumbnailSize: {
        width: Math.round(bounds.width * scaleFactor), height: Math.round(bounds.height * scaleFactor),
      },
    });
    const source = sources.find(item => item.display_id === String(display.id)) ||
      (sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) throw new Error("无法读取当前显示器画面");
    const image = nativeImage.createFromBuffer(source.thumbnail.toPNG());
    const overlay = createWindow({ ...bounds, frame: false, resizable: false, movable: false, skipTaskbar: true });
    capture = { overlay, image, language, restore, focused };
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.on("closed", () => {
      if (capture?.overlay === overlay) finishCapture();
    });
    await overlay.loadURL(local("desktop/capture.html"));
    overlay.show();
    overlay.focus();
  } catch (error) {
    const overlay = capture?.overlay;
    capture = undefined;
    overlay?.destroy();
    busy = false;
    showMain();
    bridge.broadcast("shell:notice", error.message);
  }
}

function finishCapture(rect) {
  if (!capture) return;
  const { overlay, image, language, restore, focused } = capture;
  capture = undefined;
  if (!overlay.isDestroyed()) overlay.destroy();
  if (!rect) {
    busy = false;
    if (restore) focused ? showMain() : window.showInactive();
    return;
  }
  const { width, height } = image.getSize();
  const left = Math.floor(rect.x * width);
  const top = Math.floor(rect.y * height);
  const right = Math.min(width, Math.ceil((rect.x + rect.width) * width));
  const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * height));
  deliverImage(image.crop({ x: left, y: top, width: right - left, height: bottom - top }), language);
}

async function openImage(language) {
  if (busy) return;
  busy = true;
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      properties: ["openFile"], filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (canceled) { busy = false; return; }
    const image = nativeImage.createFromPath(filePaths[0]);
    if (image.isEmpty()) throw new Error("无法读取图片");
    await deliverImage(image, language);
  } catch (error) {
    busy = false;
    bridge.broadcast("shell:notice", error.message);
  }
}

function command(role, method, value) {
  if (method === "app:options" && role !== "capture") return openTool("options");
  if (role === "capture") {
    if (method === "capture:cancel") { setImmediate(finishCapture); return; }
    if (method === "capture:finish") {
      const { x, y, width, height } = value;
      if ([x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 &&
          width > 0 && height > 0 && x + width <= 1.000001 && y + height <= 1.000001)
        setImmediate(() => finishCapture({ x, y, width, height }));
      else throw new Error("选区无效");
      return;
    }
  }
  if (role === "media") {
    if (method === "media:choose") return media.choose(value);
    if (method === "media:transcribe") return media.transcribe(value);
    if (method === "media:cancel") return media.cancel();
    if (method === "media:document") return openTool("document");
    if (method === "media:pin") return tools.get("media").setAlwaysOnTop(Boolean(value));
  }
  if (role === "history") {
    if (method === "history:restore") {
      const item = historyOf(bridge.read()).find(entry => entry.id === value);
      if (item) {
        showMain();
        bridge.broadcast("shell:restore", item);
      }
      return;
    }
    if (method === "history:copy") return clipboard.writeText(String(value));
    if (method === "history:favorite") return editHistory(bridge, value, false);
    if (method === "history:remove") return editHistory(bridge, value, true);
  }
  if (role === "shell") {
    if (method === "shell:tool") return openTool(value);
    if (method === "shell:clipboard") return showClipboard();
    if (method === "shell:hotkeys") return hotkeyFailures;
    if (method === "shell:languages") return runOcr("-ListLanguages");
    if (method === "shell:capture") return startCapture(value);
    if (method === "shell:image") return openImage(value);
    if (method === "shell:copy") return clipboard.writeText(value);
    if (method === "shell:remember") return remember(bridge, value);
    if (method === "shell:ocr-language") { currentLanguage = value; return; }
  }
  throw new Error("此页面无权执行该操作");
}

let currentLanguage = "auto";
function startLocalBackend() {
  const source = app.isPackaged ? process.resourcesPath : root;
  const venv = path.join(source, ".venv", "Scripts", "python.exe");
  const bundled = path.join(source, "runtime", "python.exe");
  const built = path.join(root, "build", "desktop-engine");
  const python = process.env.MAS_DESKTOP_PYTHON || [bundled, path.join(built, "runtime", "python.exe"), venv]
    .find(filename => fs.existsSync(filename));
  if (!python || process.env.MAS_DESKTOP_NO_BACKEND === "1") return;
  const speechModel = path.join(app.isPackaged ? source : built, "models", "speech-base");
  const log = fs.openSync(path.join(app.getPath("userData"), "backend.log"), "a");
  try {
    backend = spawn(python, ["-m", "uvicorn", "backend.desktop_app:app", "--app-dir", source,
      "--host", "127.0.0.1", "--port", "8001", "--no-access-log"], {
      cwd: source, windowsHide: true, stdio: ["ignore", log, log],
      env: {
        ...process.env, PYTHONUNBUFFERED: "1",
        MAS_ENABLE_SPEECH: process.env.MAS_ENABLE_SPEECH || "1",
        MAS_SPEECH_MODEL: process.env.MAS_SPEECH_MODEL || (fs.existsSync(speechModel) ? speechModel : "base"),
        MAS_SPEECH_CACHE: process.env.MAS_SPEECH_CACHE || path.join(app.getPath("userData"), "models"),
      },
    });
    backend.on("error", error => console.error("本地识别服务启动失败", error.message));
    backend.on("exit", () => { backend = undefined; });
  } finally {
    fs.closeSync(log);
  }
}

async function start() {
  const ui = session.defaultSession;
  ui.protocol.handle("maslingo", appProtocol);
  const isMedia = contents => contents && contents === tools.get("media")?.webContents;
  ui.setPermissionRequestHandler((contents, permission, respond, details) => respond(
    permission === "clipboard-sanitized-write" || (isMedia(contents) &&
      (permission === "display-capture" || (permission === "media" && details.mediaTypes?.every(type => type === "audio")))),
  ));
  ui.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permission === "clipboard-sanitized-write" || (isMedia(contents) &&
      (permission === "display-capture" || (permission === "media" && details.mediaType === "audio"))));
  ui.setDisplayMediaRequestHandler((request, respond) => {
    const frame = tools.get("media")?.webContents.mainFrame;
    // Chromium requires a video source for this API. Use the tool's own frame,
    // and record only the system audio track in the renderer.
    if (frame && request.frame === frame && request.userGesture && request.audioRequested)
      respond({ video: frame, audio: "loopback" });
    else respond(null);
  });
  bridge = await installBridge({
    origin, command, network: session.fromPartition("maslingo-requests"),
    roleOf(contents, frame) {
      if (!frame || frame !== contents.mainFrame || !frame.url.startsWith(origin + "/")) return;
      if (contents === window?.webContents) return "shell";
      if (contents === worker?.webContents) return "background";
      if (contents === capture?.overlay.webContents) return "capture";
      for (const [role, tool] of tools) if (contents === tool.webContents) return role;
    },
    canFetch: (role, url) => {
      const endpoint = new URL(url).pathname;
      return (role === "document" && /\/api\/document\/(text|export)$/.test(endpoint)) ||
        (role === "media" && endpoint.endsWith("/api/transcribe-audio"));
    },
  });
  media = createMediaTools(bridge);
  Menu.setApplicationMenu(null);
  worker = createWindow();
  await worker.loadURL(local("desktop/background.html"));
  window = createWindow({ width: 1080, height: 760, minWidth: 710, minHeight: 590, title: "MasLingo Desktop" });
  window.on("closed", () => app.quit());
  for (const [shortcut, action] of [["Ctrl+Alt+S", () => startCapture(currentLanguage)], ["Ctrl+Alt+T", showClipboard]]) {
    if (!globalShortcut.register(shortcut, action)) hotkeyFailures.push(shortcut);
  }
  await window.loadURL(local("desktop/index.html"));
  showMain();
  startLocalBackend();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window && !window.isDestroyed()) showMain(); });
  app.on("before-quit", () => {
    media?.cancel();
    globalShortcut.unregisterAll();
    backend?.kill();
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox("MasLingo Desktop 启动失败", error.message);
    app.exit(1);
  });
}
