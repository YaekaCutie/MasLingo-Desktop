const { contextBridge, ipcRenderer } = require("electron");

function makeTransport(manifest) {
  const token = globalThis.crypto.randomUUID();
  let counter = 0;
  const ready = ipcRenderer.invoke("mas:register", token);
  return {
    manifest,
    id: () => token + ":" + (++counter),
    invoke: (method, args) => ready.then(() => ipcRenderer.invoke("mas:call", token, method, args)),
    signal: (method, ...args) => {
      ready.then(() => ipcRenderer.send("mas:signal", token, method, args)).catch(() => {});
    },
    subscribe: listener => {
      ipcRenderer.on("mas:event", (_event, to, ...args) => {
        if (to === token) listener(...args);
      });
    },
  };
}
