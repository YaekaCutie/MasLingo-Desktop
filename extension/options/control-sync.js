(() => {
  if (globalThis.masTransport) return;
  const panel = document.getElementById("desktop-sync");
  const code = document.getElementById("desktop-pair-code");
  const pair = document.getElementById("desktop-pair");
  const disconnect = document.getElementById("desktop-disconnect");
  const status = document.getElementById("desktop-sync-status");
  panel.hidden = false;

  async function update(type, value) {
    pair.disabled = disconnect.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type, code: value });
      if (!result?.ok) throw new Error(result?.error || "无法读取同步状态");
      pair.hidden = code.hidden = result.linked;
      disconnect.hidden = !result.linked;
      code.value = "";
      status.textContent = result.linked ? "已配对。桌面端运行时会自动同步。" : "尚未配对";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      pair.disabled = disconnect.disabled = false;
    }
  }

  pair.onclick = () => update("DESKTOP_SYNC_PAIR", code.value);
  disconnect.onclick = () => update("DESKTOP_SYNC_DISCONNECT");
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.desktopControlLink &&
        Boolean(changes.desktopControlLink.oldValue) !== Boolean(changes.desktopControlLink.newValue))
      update("DESKTOP_SYNC_STATUS");
  });
  update("DESKTOP_SYNC_STATUS");
})();
