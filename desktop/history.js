const $ = id => document.getElementById(id);
const call = (name, ...args) => masTransport.invoke("history:" + name, args);
let records = [];
let version = 0;

function report(error) { $("status").textContent = error.message || String(error); }

function button(label, action) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.onclick = () => action().catch(report);
  return node;
}

function render() {
  const query = $("history-search").value.trim().toLocaleLowerCase();
  const visible = records.filter(record => (!$("favorites-only").checked || record.favorite) &&
    (!query || (record.source + "\n" + record.translation).toLocaleLowerCase().includes(query)));
  $("empty").hidden = visible.length > 0;
  const items = visible.map(record => {
    const row = document.createElement("li");
    const meta = document.createElement("small");
    meta.textContent = new Date(record.time).toLocaleString() + " · " + record.target;
    const source = document.createElement("p");
    source.textContent = record.source.slice(0, 240);
    const result = document.createElement("p");
    result.textContent = record.translation.slice(0, 300);
    const actions = document.createElement("div");
    actions.className = "tool-actions";
    actions.append(button("在工作台打开", () => call("restore", record.id)),
      button("复制译文", () => call("copy", record.translation)),
      button(record.favorite ? "取消收藏" : "收藏", () => call("favorite", record.id)),
      button("删除", () => call("remove", record.id)));
    row.append(meta, source, result, actions);
    return row;
  });
  $("history-list").replaceChildren(...items);
}

async function refresh() {
  const current = ++version;
  const state = await chrome.storage.local.get(["desktopHistory", "desktopKeepHistory"]);
  if (current !== version) return;
  records = Array.isArray(state.desktopHistory) ? state.desktopHistory : [];
  $("keep-history").checked = state.desktopKeepHistory === true;
  render();
}

$("history-search").oninput = render;
$("favorites-only").onchange = render;
$("keep-history").onchange = () =>
  chrome.storage.local.set({ desktopKeepHistory: $("keep-history").checked }).catch(report);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.desktopHistory || changes.desktopKeepHistory)) refresh().catch(report);
});
refresh().catch(report);
