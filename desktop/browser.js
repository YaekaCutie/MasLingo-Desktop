const invoke = method => masTransport.invoke("browser:" + method, []);
const report = value => { document.getElementById("status").textContent = value; };
invoke("path").then(value => { document.getElementById("path").textContent = value; }).catch(error => report(error.message));
document.getElementById("folder").onclick = () => invoke("folder").then(report).catch(error => report(error.message));
