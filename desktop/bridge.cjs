const { app, dialog, ipcMain, safeStorage } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { franc } = require("franc-min");
const { iso6393To1 } = require("iso-639-3");
const { host_permissions: hosts } = require("../extension/manifest.json");
require("../extension/translation/providers.js");
const providers = globalThis.MAS_providers;

function settingsCrypto(mode, contents) {
  const script = path.join(app.isPackaged ? process.resourcesPath : __dirname, "settings-crypto.ps1");
  return new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", mode,
    ], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, output) => {
      if (error) reject(new Error(mode === "protect" ? "无法加密桌面设置" : "无法解密桌面设置"));
      else resolve(output);
    });
    child.stdin.on("error", reject);
    child.stdin.end(contents, "utf8");
  });
}

async function installBridge(desktop) {
  const endpoints = new Map();
  const requests = new Map();
  const fetches = new Map();
  const settingsPath = path.join(app.getPath("userData"), "settings.json");
  let settings = {};
  let pendingWrite = Promise.resolve();
  let serial = 0;
  let workerReady;
  const ready = new Promise(resolve => { workerReady = resolve; });
  if (fs.existsSync(settingsPath)) {
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (data.dpapi) settings = JSON.parse(await settingsCrypto("unprotect", data.dpapi));
    else if (data.encrypted) {
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(data.encrypted, "base64"));
      settings = JSON.parse(result);
    } else settings = data.values || {};
  }
  if (!settings.translationProvider && !settings.translationMode)
    settings.translationProvider = "google-free";
  delete settings.desktopSyncPeers;

  function emit(endpoint, event, ...args) {
    if (endpoint && !endpoint.contents.isDestroyed()) {
      endpoint.contents.send("mas:event", endpoint.token, event, ...args);
    }
  }

  function broadcast(event, ...args) {
    for (const endpoint of endpoints.values()) emit(endpoint, event, ...args);
  }

  function save(values) {
    const write = pendingWrite.then(async () => {
      const patch = typeof values === "function" ? values(settings) : values;
      const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) =>
        !isDeepStrictEqual(settings[key], value)).map(([key, value]) =>
        [key, { oldValue: settings[key], newValue: value }]));
      if (!Object.keys(changes).length) return;
      const next = { ...settings, ...patch };
      const encrypted = await settingsCrypto("protect", JSON.stringify(next));
      await fs.promises.writeFile(settingsPath + ".tmp", JSON.stringify({
        dpapi: encrypted,
      }), { mode: 0o600 });
      await fs.promises.rename(settingsPath + ".tmp", settingsPath);
      settings = next;
      broadcast("storage:change", changes, "local");
    });
    pendingWrite = write.catch(() => {});
    return write;
  }

  function from(event, token) {
    const endpoint = endpoints.get(event.sender.id);
    if (endpoint?.token !== token || event.senderFrame !== event.sender.mainFrame)
      throw new Error("消息来源已失效");
    return endpoint;
  }

  ipcMain.handle("mas:register", (event, token) => {
    const role = desktop.roleOf(event.sender, event.senderFrame);
    if (!role || typeof token !== "string") throw new Error("无效的页面");
    endpoints.set(event.sender.id, { token, role, contents: event.sender });
  });

  async function backgroundMessage(message) {
    await ready;
    const worker = [...endpoints.values()].find(endpoint => endpoint.role === "background");
    if (!worker) throw new Error("翻译服务暂不可用，请重启应用");
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timeout = setTimeout(() => {
        requests.delete(id);
        reject(new Error("翻译请求超时"));
      }, 360000);
      requests.set(id, result => { clearTimeout(timeout); resolve(result); });
      emit(worker, "request", id, message, { url: desktop.origin + "/" });
    });
  }

  async function fetchResponse(endpoint, id, url, options) {
    if (!/^https?:\/\//i.test(url) || options.body?.byteLength > 32 * 1024 * 1024 ||
        (endpoint.role !== "background" && !desktop.canFetch(endpoint.role, url)))
      throw new Error("请求地址或大小无效");
    const controller = new AbortController();
    fetches.set(id, { endpoint, controller });
    try {
      const response = await desktop.network.fetch(url, {
        ...options,
        referrer: /^https?:\/\//i.test(options.referrer) ? options.referrer : undefined,
        credentials: "omit",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(360000)]),
      });
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 192 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("响应文件过大");
        }
        chunks.push(Buffer.from(value));
      }
      return {
        status: response.status, statusText: response.statusText, headers: [...response.headers],
        body: reader ? Uint8Array.from(Buffer.concat(chunks, size)).buffer : null,
      };
    } finally {
      fetches.delete(id);
    }
  }

  ipcMain.handle("mas:call", async (event, token, method, args) => {
    const endpoint = from(event, token);
    const [first, second, third] = args;
    if (endpoint.role === "capture") return desktop.command("capture", method, ...args);
    switch (method) {
      case "runtime:message": return backgroundMessage(first);
      case "storage:get": {
        const keys = typeof first === "string" ? [first] : first;
        return Object.fromEntries((keys || Object.keys(settings))
          .filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]));
      }
      case "storage:set": return save(first);
      case "storage:save-provider":
        if (!providers.byId(first)) throw new Error("未知翻译来源");
        return save(current => {
          if (third && providers.resolveProviderId(current) !== first)
            throw new Error("翻译来源已在其他窗口变更，请确认来源后再保存。");
          return providers.providerUpdate(current, first, second);
        });
      case "app:options": return desktop.command(endpoint.role, "app:options");
      case "permissions:contains":
        return first.every(pattern => hosts.includes(pattern) || settings.desktopAllowedOrigins?.includes(pattern));
      case "permissions:request": {
        if (first.length !== 1 || !/^https:\/\/[^/]+\/\*$/.test(first[0])) return false;
        const result = await dialog.showMessageBox({
          type: "question", buttons: ["允许访问", "取消"], defaultId: 1, cancelId: 1,
          message: "允许此翻译接口接收待翻译的内容？", detail: first[0].slice(0, -2),
        });
        if (result.response !== 0) return false;
        await save(current => ({
          desktopAllowedOrigins: [...new Set([...(current.desktopAllowedOrigins || []), first[0]])],
        }));
        return true;
      }
      case "language:detect": {
        if (endpoint.role !== "background") break;
        const language = iso6393To1[franc(first, { minLength: 12 })];
        return { languages: language ? [{ language }] : [] };
      }
      case "fetch": return fetchResponse(endpoint, first, second, third);
      default: return desktop.command(endpoint.role, method, ...args);
    }
    throw new Error("此页面无权执行该操作");
  });

  ipcMain.on("mas:signal", (event, token, method, [id, value]) => {
    let endpoint;
    try { endpoint = from(event, token); } catch { return; }
    if (method === "background:ready" && endpoint.role === "background") workerReady();
    if (method === "reply" && endpoint.role === "background") {
      requests.get(id)?.(value);
      requests.delete(id);
    }
    if (method === "fetch:abort" && fetches.get(id)?.endpoint === endpoint)
      fetches.get(id).controller.abort();
  });

  return {
    broadcast,
    read: () => settings,
    save,
    watch(contents) {
      const id = contents.id;
      const detach = () => {
        const endpoint = endpoints.get(id);
        endpoints.delete(id);
        for (const item of fetches.values()) {
          if (item.endpoint === endpoint) item.controller.abort();
        }
      };
      contents.on("render-process-gone", detach);
      contents.on("destroyed", detach);
    },
  };
}

module.exports = { installBridge };
