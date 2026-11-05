const $ = id => document.getElementById(id);
const invoke = (method, ...args) => masTransport.invoke("shell:" + method, args);
const source = $("source");
const output = $("output");
const status = $("status");
const language = $("ocr-language");
const sourceLanguage = $("source-language");
const targetLanguage = $("control-targetLanguage");
const registry = globalThis.MAS_providers;
let revision = 0;
let translating = false;
let lookupVersion = 0;
let completed;

sourceLanguage.append(new Option(registry.autoSource, ""));
for (const item of registry.languages) sourceLanguage.append(new Option(item.name, item.name));

function report(error) {
  status.textContent = String(error.message || error).replace(/^Error invoking remote method 'mas:call': Error: /, "");
}

function controls() {
  $("translate").disabled = translating || !source.value.trim();
  $("copy").disabled = !output.value;
  $("speak-source").disabled = !source.value.trim() || !globalThis.speechSynthesis;
  $("speak-result").disabled = !output.value || !globalThis.speechSynthesis;
  $("lookup").disabled = !source.value.trim();
  $("favorite").disabled = !completed;
  $("swap-languages").disabled = !sourceLanguage.value ||
    ![...sourceLanguage.options].some(option => option.value === targetLanguage.value);
}

async function translate() {
  const text = source.value.trim();
  if (!text) return;
  const id = ++revision;
  translating = true;
  completed = undefined;
  output.value = "";
  status.textContent = "正在翻译…";
  controls();
  try {
    const sourceName = sourceLanguage.value;
    const target = targetLanguage.value ||
      (await chrome.storage.local.get("targetLanguage")).targetLanguage || "简体中文";
    const paragraphs = text.match(/[\s\S]{1,1800}/gu);
    const translated = [];
    for (let i = 0; i < paragraphs.length; i += 4) {
      const result = await chrome.runtime.sendMessage({
        type: "TRANSLATE_TEXT_BLOCKS", texts: paragraphs.slice(i, i + 4),
        source: sourceName || undefined, target,
      });
      if (id !== revision) return;
      if (!result?.ok) throw new Error(result?.reason || "翻译失败，请检查设置");
      translated.push(...result.translations);
    }
    output.value = translated.join("\n");
    completed = { source: text, translation: output.value, sourceLanguage: sourceName, target };
    invoke("remember", completed).catch(report);
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

function speak(text, name) {
  const engine = globalThis.speechSynthesis;
  if (!engine || !text) return;
  if (engine.speaking) {
    engine.cancel();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = registry.languageByName(name)?.google || navigator.language;
  utterance.onerror = () => { status.textContent = "朗读不可用，请检查 Windows 的语音语言包。"; };
  engine.speak(utterance);
}

function showDictionary(result) {
  const container = $("dictionary-entry");
  container.replaceChildren();
  if (result.kind === "dictionary") {
    const title = document.createElement("h3");
    title.textContent = [result.entry.word, result.entry.reading].filter(Boolean).join(" · ");
    const senses = document.createElement("ol");
    result.entry.senses.forEach((sense, index) => {
      const item = document.createElement("li");
      item.textContent = [
        [result.entry.contextSense === index + 1 ? "本文义项" : "", sense.pos, sense.meaning].filter(Boolean).join(" · "),
        sense.example, sense.exampleTranslation,
      ].filter(Boolean).join("\n");
      senses.append(item);
    });
    container.append(title, senses);
  } else {
    const item = document.createElement("p");
    item.textContent = [result.translation, result.notice].filter(Boolean).join("\n");
    container.append(item);
  }
  $("dictionary").hidden = false;
}

$("lookup").onclick = async () => {
  const selected = source.value.slice(source.selectionStart, source.selectionEnd).trim() || source.value.trim();
  if (!selected || selected.length > 200) {
    status.textContent = "请在原文框选中一个词或一小段文字。";
    return;
  }
  const id = ++lookupVersion;
  status.textContent = "正在查词…";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "LOOKUP_WORD", word: true, text: selected,
      context: source.value.slice(Math.max(0, source.selectionStart - 250), source.selectionEnd + 250),
      source: sourceLanguage.value || undefined, target: targetLanguage.value,
    });
    if (id !== lookupVersion) return;
    if (!result?.ok) throw new Error(result?.reason || "查词失败");
    showDictionary(result);
    status.textContent = "查词完成";
  } catch (error) { if (id === lookupVersion) report(error); }
};

$("speak-source").onclick = () => speak(source.value, sourceLanguage.value);
$("speak-result").onclick = () => speak(output.value, completed?.target || targetLanguage.value);
$("favorite").onclick = () => invoke("remember", { ...completed, favorite: true })
  .then(() => { status.textContent = "已收藏译文"; }).catch(report);
$("swap-languages").onclick = () => {
  const previous = sourceLanguage.value;
  sourceLanguage.value = targetLanguage.value;
  targetLanguage.value = previous;
  sourceLanguage.dispatchEvent(new Event("change"));
  targetLanguage.dispatchEvent(new Event("change"));
  if (output.value) source.value = output.value.slice(0, source.maxLength);
  source.dispatchEvent(new Event("input"));
};
sourceLanguage.onchange = () => {
  controls();
  chrome.storage.local.set({ desktopSourceLanguage: sourceLanguage.value }).catch(report);
};
targetLanguage.addEventListener("change", controls);
chrome.storage.local.get("desktopSourceLanguage").then(cfg => {
  if ([...sourceLanguage.options].some(item => item.value === cfg.desktopSourceLanguage))
    sourceLanguage.value = cfg.desktopSourceLanguage;
  controls();
}).catch(report);

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
$("translation-form").addEventListener("keydown", event => {
  if (event.ctrlKey && event.key === "Enter" && !$("translate").disabled) {
    event.preventDefault();
    $("translation-form").requestSubmit();
  }
});
source.addEventListener("input", () => {
  revision++;
  lookupVersion++;
  completed = undefined;
  $("dictionary").hidden = true;
  translating = false;
  output.value = "";
  status.textContent = "";
  controls();
});
const translationSettings = new Set([...registry.profileKeys, "targetLanguage",
  "translationGlossary", "translationStrength", "backendUrl", "desktopSourceLanguage"]);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(changes).some(key => translationSettings.has(key))) return;
  lookupVersion++;
  controls();
  if (!translating) return;
  revision++;
  translating = false;
  status.textContent = "翻译设置已更新，请重新翻译。";
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
    source.dispatchEvent(new Event("input"));
    status.textContent = label;
    controls();
    translate();
  }
  if (event === "shell:restore") {
    source.value = text.source;
    source.dispatchEvent(new Event("input"));
    output.value = text.translation;
    completed = text;
    status.textContent = `已载入记录 · ${text.target}`;
    controls();
  }
});
Promise.all([invoke("languages"), chrome.storage.local.get("desktopOcrLanguage")]).then(([languages, config]) => {
  for (const item of languages) language.append(new Option(item.name, item.tag));
  if ([...language.options].some(option => option.value === config.desktopOcrLanguage))
    language.value = config.desktopOcrLanguage;
  return invoke("ocr-language", language.value);
}).catch(report);
invoke("hotkeys").then(failed => {
  if (failed.length) $("shortcut-hint").textContent = `快捷键已被占用（${failed.join("、")}），可从上方按钮使用。`;
}).catch(report);
