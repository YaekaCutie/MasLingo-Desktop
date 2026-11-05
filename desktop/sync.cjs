const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
require("../extension/translation/providers.js");
require("../extension/sync/preferences.js");

const { pick, delta, port } = globalThis.MAS_syncPreferences;
const registry = globalThis.MAS_providers;
const peersKey = "desktopSyncPeers";
const hash = token => createHash("sha256").update(token).digest("hex");

function startControlSync(bridge) {
  const pending = new Set();
  let pairing;
  let revision = randomUUID();
  let current = pick(bridge.read());
  let serverError = "";

  const peers = () => bridge.read()[peersKey] || {};
  const status = () => ({ peers: Object.keys(peers()).length, error: serverError });
  const snapshot = () => ({ preferences: current, revision });

  function withPreferences(settings, incoming, extra = {}) {
    const changes = { ...delta(pick(settings), pick(incoming)), ...extra };
    const id = changes.translationProvider;
    return id ? registry.providerUpdate(settings, id, changes) : changes;
  }

  bridge.onSave(() => {
    const next = pick(bridge.read());
    if (Object.keys(delta(current, next)).length || Object.keys(delta(next, current)).length) {
      current = next;
      revision = randomUUID();
      for (const finish of pending) finish();
    }
  });

  function reply(res, status, body) {
    if (res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }

  async function handle(req, res) {
    const origin = req.headers.origin;
    if (req.headers.host !== "127.0.0.1:" + port || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin || ""))
      return reply(res, 403, { error: "仅允许本机浏览器伴侣连接" });
    if (req.method !== "POST" || !["/pair", "/sync", "/disconnect"].includes(req.url))
      return reply(res, 404, { error: "未知同步请求" });
    if (req.headers["content-type"] !== "application/json")
      return reply(res, 415, { error: "无效同步请求" });

    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const tokenHash = token && hash(token);
    const linked = () => tokenHash && peers()[tokenHash] === origin;
    if (req.url !== "/pair" && !linked())
      return reply(res, 401, { error: "配对已失效，请重新配对" });

    const parts = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 8192) return reply(res, 413, { error: "同步请求过大" });
      parts.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch {}
    if (!body || typeof body !== "object") return reply(res, 400, { error: "无效同步请求" });

    if (req.url === "/pair") {
      if (!pairing || pairing.until < Date.now() || body.code !== pairing.code)
        return reply(res, 403, { error: "配对码错误或已过期" });
      if (status().peers >= 8) return reply(res, 409, { error: "已达到配对数量上限" });
      pairing = undefined;
      const secret = randomBytes(32).toString("base64url");
      await bridge.save(settings => withPreferences(settings,
        { ...pick(body.preferences || {}), ...pick(settings) },
        { [peersKey]: { ...settings[peersKey], [hash(secret)]: origin } }));
      bridge.broadcast("sync:status", status());
      return reply(res, 200, { ...snapshot(), token: secret });
    }

    if (!linked()) return reply(res, 401, { error: "配对已失效，请重新配对" });
    if (req.url === "/disconnect") {
      await bridge.save(settings => {
        const remaining = { ...settings[peersKey] };
        delete remaining[tokenHash];
        return { [peersKey]: remaining };
      });
      for (const finish of pending) finish();
      bridge.broadcast("sync:status", status());
      return reply(res, 200, {});
    }
    const changes = pick(body.patch || {});
    if (Object.keys(changes).length) {
      await bridge.save(settings => linked() ? withPreferences(settings, changes) : {});
      if (!linked()) return reply(res, 401, { error: "配对已失效，请重新配对" });
    }
    if (!body.wait || Object.keys(changes).length || body.revision !== revision || pending.size >= 8)
      return reply(res, 200, snapshot());

    const cleanup = () => {
      clearTimeout(timer);
      pending.delete(finish);
    };
    const finish = () => {
      cleanup();
      if (linked()) reply(res, 200, snapshot());
      else reply(res, 401, { error: "配对已失效，请重新配对" });
    };
    const timer = setTimeout(finish, 20000);
    pending.add(finish);
    res.once("close", cleanup);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => reply(res, 500, { error: "保存同步设置失败" }));
  });
  server.on("error", () => {
    serverError = "同步端口不可用，翻译控件仍可在各端独立使用。";
    bridge.broadcast("sync:status", status());
  });
  server.requestTimeout = 15000;
  server.listen(port, "127.0.0.1");

  return {
    status,
    pairCode() {
      if (serverError) throw new Error(serverError);
      pairing = { code: randomBytes(8).toString("hex").toUpperCase(), until: Date.now() + 300000 };
      return pairing.code;
    },
    async revoke() {
      pairing = undefined;
      await bridge.save({ [peersKey]: {} });
      for (const finish of pending) finish();
      bridge.broadcast("sync:status", status());
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

module.exports = { startControlSync };
