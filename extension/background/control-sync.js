(() => {
  const registry = globalThis.MAS_providers;
  const { keys, legacy, pick, delta, port } = globalThis.MAS_syncPreferences;
  const linkKey = "desktopControlLink";
  const alarm = "maslingo-control-sync";
  const read = () => chrome.storage.local.get([...keys, ...legacy, linkKey]);
  let request;
  let loop;
  let generation = 0;

  async function exchange(route, body, token, signal) {
    const timeout = AbortSignal.timeout(route === "sync" ? 24000 : 5000);
    const response = await fetch("http://127.0.0.1:" + port + "/" + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token && { Authorization: "Bearer " + token }) },
      body: JSON.stringify(body),
      credentials: "omit",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch(error => {
      if (signal?.aborted) throw error;
      throw new Error("无法连接桌面端，请确认 MasLingo 正在运行");
    });
    if (response.status === 401) return null;
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "同步失败");
    return result;
  }

  function apply(snapshot, token, sent, expectedGeneration) {
    // Use the same lock as provider edits in the browser settings and reader.
    return navigator.locks.request("maslingo-translation-provider", async () => {
      const settings = await chrome.storage.local.get([
        ...keys, ...legacy, ...registry.profileKeys, linkKey,
        registry.profileKey(snapshot.preferences.translationProvider),
      ]);
      if (generation !== expectedGeneration) return;
      const latest = pick(settings);
      const changedInFlight = delta(sent, latest);
      const updates = delta(latest, { ...snapshot.preferences, ...changedInFlight });
      const link = settings[linkKey];
      const next = { token, revision: snapshot.revision, baseline: snapshot.preferences };
      if (link?.token !== next.token || link.revision !== next.revision) updates[linkKey] = next;
      const id = updates.translationProvider;
      if (Object.keys(updates).length) {
        await chrome.storage.local.set(id ? registry.providerUpdate(settings, id, updates) : updates);
      }
    });
  }

  async function synchronize() {
    if (loop) return;
    loop = true;
    try {
      for (;;) {
        const settings = await read();
        const link = settings[linkKey];
        if (!link) return;
        const expectedGeneration = generation;
        const sent = pick(settings);
        const controller = new AbortController();
        request = controller;
        let snapshot;
        try {
          snapshot = await exchange("sync", { revision: link.revision, patch: delta(link.baseline, sent), wait: true },
            link.token, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) continue;
          return; // The next alarm, or a local edit, reconnects.
        } finally {
          if (request === controller) request = undefined;
        }
        if (generation !== expectedGeneration) continue;
        if (!snapshot) {
          await chrome.storage.local.remove(linkKey);
          await chrome.alarms.clear(alarm);
          return;
        }
        if (!controller.signal.aborted) await apply(snapshot, link.token, sent, expectedGeneration);
      }
    } finally {
      loop = false;
    }
  }

  async function start() {
    if (!(await chrome.storage.local.get(linkKey))[linkKey]) return;
    if (!(await chrome.alarms.get(alarm))) await chrome.alarms.create(alarm, { periodInMinutes: 1 });
    synchronize().catch(() => {});
  }

  async function pair(code) {
    const preferences = pick(await read());
    const snapshot = await exchange("pair", { code, preferences });
    const expectedGeneration = ++generation;
    request?.abort();
    await apply(snapshot, snapshot.token, preferences, expectedGeneration);
    await start();
  }

  async function disconnect() {
    const link = (await chrome.storage.local.get(linkKey))[linkKey];
    generation++;
    request?.abort();
    await chrome.storage.local.remove(linkKey);
    await chrome.alarms.clear(alarm);
    if (link) await exchange("disconnect", {}, link.token).catch(() => {});
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || changes[linkKey] || !keys.some(key => changes[key])) return;
    request?.abort();
    synchronize().catch(() => {});
  });
  chrome.alarms.onAlarm.addListener(event => { if (event.name === alarm) start().catch(() => {}); });
  chrome.runtime.onStartup.addListener(() => start().catch(() => {}));
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!["DESKTOP_SYNC_PAIR", "DESKTOP_SYNC_DISCONNECT", "DESKTOP_SYNC_STATUS"].includes(message?.type) ||
        sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("options/options.html")) return;
    (async () => {
      if (message.type === "DESKTOP_SYNC_PAIR") await pair(String(message.code || "").trim().toUpperCase());
      if (message.type === "DESKTOP_SYNC_DISCONNECT") await disconnect();
      const linked = Boolean((await chrome.storage.local.get(linkKey))[linkKey]);
      if (linked) start().catch(() => {});
      return { ok: true, linked };
    })().then(reply, error => reply({ ok: false, error: error.message }));
    return true;
  });
  start().catch(() => {});
})();
