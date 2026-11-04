const $ = id => document.getElementById(id);
const invoke = (method, ...args) => masTransport.invoke("shell:" + method, args);
const source = $("source");
const output = $("output");
const status = $("status");
const language = $("ocr-language");
const registry = globalThis.MAS_providers;
let revision = 0;
let translating = false;

function report(error) {
  status.textContent = String(error.message || error).replace(/^Error invoking remote method 'mas:call': Error: /, "");
}

function controls() {
  $("translate").disabled = translating || !source.value.trim();
  $("copy").disabled = !output.value;
}

async function refreshProvider() {
  const cfg = await chrome.storage.local.get([...registry.profileKeys, "targetLanguage"]);
  const provider = registry.byId(registry.resolveProviderId(cfg));
  $("provider").textContent = `${provider?.label || "请选择翻译来源"} · ${cfg.targetLanguage || "简体中文"}`;
}

async function translate() {
  const text = source.value.trim();
  if (!text) return;
  const id = ++revision;
  translating = true;
  output.value = "";
  status.textContent = "正在翻译…";
  controls();
  try {
    const paragraphs = text.match(/[\s\S]{1,1800}/gu);
    const translated = [];
    for (let i = 0; i < paragraphs.length; i += 4) {
      const result = await chrome.runtime.sendMessage({
        type: "TRANSLATE_TEXT_BLOCKS", texts: paragraphs.slice(i, i + 4),
      });
      if (id !== revision) return;
      if (!result?.ok) throw new Error(result?.reason || "翻译失败，请检查设置");
      translated.push(...result.translations);
    }
    output.value = translated.join("\n");
    status.textContent = "翻译完成";
  } catch (error) {
    if (id === revision) report(error);
  } finally {
    if (id === revision) {
      translating = false;
      controls();
    }
  }
}

for (const button of document.querySelectorAll("[data-tool]"))
  button.onclick = () => invoke("tool", button.dataset.tool).catch(report);
$("capture").onclick = () => invoke("capture", language.value).catch(report);
$("clipboard").onclick = () => invoke("clipboard").catch(report);
$("image").onclick = () => invoke("image", language.value).catch(report);
$("copy").onclick = () => invoke("copy", output.value).then(() => { status.textContent = "已复制译文"; }).catch(report);
$("clear").onclick = () => {
  source.value = "";
  source.dispatchEvent(new Event("input"));
  source.focus();
};
$("translation-form").onsubmit = event => { event.preventDefault(); translate(); };
source.addEventListener("input", () => {
  revision++;
  translating = false;
  output.value = "";
  status.textContent = "";
  controls();
});
language.onchange = async () => {
  try {
    await invoke("ocr-language", language.value);
    await chrome.storage.local.set({ desktopOcrLanguage: language.value });
  } catch (error) { report(error); }
};
masTransport.subscribe((event, text, label) => {
  if (event === "shell:notice") status.textContent = text;
  if (event === "shell:text") {
    source.value = text.slice(0, source.maxLength);
    status.textContent = label;
    controls();
    translate();
  }
});
chrome.storage.onChanged.addListener(() => refreshProvider().catch(report));
refreshProvider().catch(report);
Promise.all([invoke("languages"), chrome.storage.local.get("desktopOcrLanguage")]).then(([languages, config]) => {
  for (const item of languages) language.append(new Option(item.name, item.tag));
  if ([...language.options].some(option => option.value === config.desktopOcrLanguage))
    language.value = config.desktopOcrLanguage;
  return invoke("ocr-language", language.value);
}).catch(report);
invoke("hotkeys").then(failed => {
  if (failed.length) $("shortcut-hint").textContent = `快捷键已被占用（${failed.join("、")}），可从上方按钮使用。`;
}).catch(report);
