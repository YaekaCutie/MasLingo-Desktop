const { app, dialog, ipcMain, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { franc } = require("franc-min");
const { iso6393To1 } = require("iso-639-3");
const { host_permissions: hosts } = require("../extension/manifest.json");

function installBridge(desktop) {
  const endpoints = new Map();
  const requests = new Map();
  const fetches = new Map();
  const settingsPath = path.join(app.getPath("userData"), "settings.json");
  let settings = {};
  let serial = 0;
  let workerReady;
  const ready = new Promise(resolve => { workerReady = resolve; });
  if (fs.existsSync(settingsPath)) {
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    settings = data.encrypted
      ? JSON.parse(safeStorage.decryptString(Buffer.from(data.encrypted, "base64")))
      : data.values || {};
  }

  function emit(endpoint, event, ...args) {
    if (endpoint && !endpoint.contents.isDestroyed()) {
      endpoint.contents.send("mas:event", endpoint.token, event, ...args);
    }
  }

  function broadcast(event, ...args) {
    for (const endpoint of endpoints.values()) emit(endpoint, event, ...args);
  }

  function save(values) {
    const changes = Object.fromEntries(Object.entries(values).map(([key, value]) =>
      [key, { oldValue: settings[key], newValue: value }]));
    const next = { ...settings, ...values };
    const data = safeStorage.isEncryptionAvailable()
      ? { encrypted: safeStorage.encryptString(JSON.stringify(next)).toString("base64") }
      : { values: next };
    fs.writeFileSync(settingsPath + ".tmp", JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(settingsPath + ".tmp", settingsPath);
    settings = next;
    broadcast("storage:change", changes, "local");
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
        save({ desktopAllowedOrigins: [...new Set([...(settings.desktopAllowedOrigins || []), first[0]])] });
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
