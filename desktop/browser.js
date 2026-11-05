const invoke = method => masTransport.invoke("browser:" + method, []);
const report = value => { document.getElementById("status").textContent = value; };
invoke("path").then(value => { document.getElementById("path").textContent = value; }).catch(error => report(error.message));
document.getElementById("folder").onclick = () => invoke("folder").then(report).catch(error => report(error.message));
const code = document.getElementById("sync-code");
const pair = document.getElementById("pair-code");
const revoke = document.getElementById("revoke-sync");
const syncStatus = document.getElementById("sync-status");
let peerCount = 0;
function showSync(status) {
  if (status.peers !== peerCount) code.textContent = "";
  peerCount = status.peers;
  pair.disabled = Boolean(status.error);
  revoke.hidden = !peerCount;
  syncStatus.textContent = status.error || (peerCount ? `已配对 ${peerCount} 个浏览器配置` : "尚未配对");
}
pair.onclick = () => invoke("pair-code").then(value => {
  code.textContent = value + "（5 分钟内有效）";
}).catch(error => { syncStatus.textContent = error.message; });
revoke.onclick = () => invoke("revoke-sync").catch(error => { syncStatus.textContent = error.message; });
masTransport.subscribe((event, value) => { if (event === "sync:status") showSync(value); });
invoke("sync-status").then(showSync).catch(error => { syncStatus.textContent = error.message; });
