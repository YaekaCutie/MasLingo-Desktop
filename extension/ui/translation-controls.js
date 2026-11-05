(() => {
  const panel = document.querySelector("[data-translation-controls]");
  if (!panel) return;

  const registry = globalThis.MAS_providers;
  const languages = registry.languages.map(language => [language.name, language.name]);
  const modes = [["bilingual", "双语对照"], ["translated", "纯译文"], ["source", "纯原文"]];
  const omitted = new Set((panel.dataset.omit || "").split(" "));
  const fields = new Map();
  let loadVersion = 0;

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }

  function field(parent, key, title, kind, options, fallback) {
    if (omitted.has(key)) return;
    const label = element("label");
    label.className = "translation-field";
    const text = element("span", title);
    const control = element(kind === "select" ? "select" : "input");
    control.id = "control-" + key;
    label.htmlFor = control.id;
    if (kind === "select") {
      control.append(...options.map(([value, name]) => new Option(name, value)));
    } else {
      control.type = kind;
    }
    if (kind === "checkbox") label.classList.add("translation-check");
    if (kind === "range") {
      const [min, max, step] = options;
      control.min = min;
      control.max = max;
      control.step = step;
    }
    label.append(text, control);
    const reading = kind === "range" ? element("output") : null;
    if (reading) {
      reading.htmlFor = control.id;
      label.append(reading);
      control.addEventListener("input", () => { reading.textContent = control.value + "%"; });
    }
    parent.append(label);
    fields.set(key, { control, kind, reading, fallback });
    control.addEventListener("change", () => {
      const value = kind === "checkbox" ? control.checked : kind === "range" ? Number(control.value) / 100 :
        typeof fallback === "number" ? Number(control.value) : control.value;
      save(key, value);
    });
  }

  const common = element("div");
  common.className = "translation-common";
  field(common, "translationProvider", "翻译来源", "select", [], "");
  registry.appendProviderOptions(fields.get("translationProvider").control);
  field(common, "targetLanguage", "目标语言", "select", languages, "简体中文");
  field(common, "translationGlossary", "专业术语", "select",
    registry.glossaries.map(item => [item.id, item.label]), "general");
  field(common, "translationStrength", "AI 润色", "select",
    [[0, "轻度润色"], [1, "结合上下文"], [2, "逐条复核"]], 0);
  const providerHint = element("p");
  providerHint.className = "hint translation-provider-hint";
  const configure = element("button", "打开完整设置");
  configure.type = "button";
  configure.className = "link";
  configure.onclick = () => chrome.runtime.openOptionsPage().catch(report);
  providerHint.append(element("span"), configure);

  const advanced = element("details");
  advanced.className = "translation-advanced";
  advanced.append(element("summary", "网页、漫画与字幕控件"));
  const groups = element("div");
  groups.className = "translation-groups";
  function group(title) {
    const node = element("fieldset");
    node.append(element("legend", title));
    groups.append(node);
    return node;
  }
  const web = group("网页与划词");
  field(web, "webAutoTranslate", "网页自动翻译", "checkbox", null, false);
  field(web, "hoverTranslate", "悬停翻译", "checkbox", null, false);
  field(web, "selectionTranslate", "划词词典", "checkbox", null, true);
  field(web, "inputAutoReplace", "输入框自动替换", "checkbox", null, true);
  field(web, "webDisplayMode", "网页显示", "select", modes, "bilingual");
  const manga = group("漫画识别");
  field(manga, "autoTranslate", "自动识别全图", "checkbox", null, false);
  field(manga, "debugMode", "显示识别原文", "checkbox", null, true);
  field(manga, "autoConcurrency", "同时处理数量", "select", [[1, "1"], [2, "2"], [3, "3"]], 1);
  field(manga, "fontScale", "译文字体", "range", [60, 160, 5], 1);
  field(manga, "overlayOpacity", "译文不透明度", "range", [30, 100, 5], 1);
  const video = group("视频字幕");
  field(video, "videoAutoPrepare", "自动预翻译字幕", "checkbox", null, true);
  field(video, "videoDisplayMode", "字幕显示", "select", modes, "bilingual");
  field(video, "videoSourceLanguage", "字幕源语言", "select",
    [[registry.autoSource, registry.autoSource], ...languages], registry.autoSource);
  field(video, "videoTargetLanguage", "字幕目标语言", "select",
    [["", "跟随目标语言"], ...languages], "");
  advanced.append(groups);
  const feedback = element("p");
  feedback.className = "hint translation-feedback";
  feedback.setAttribute("role", "status");
  feedback.hidden = true;
  panel.append(common, providerHint);
  if (!panel.hasAttribute("data-basic-only")) panel.append(advanced);
  panel.append(feedback);

  const keys = new Set([...fields.keys(), ...registry.profileKeys]);
  async function refresh() {
    const version = ++loadVersion;
    const cfg = await chrome.storage.local.get([
      ...keys, ...registry.list.map(provider => registry.profileKey(provider.id)),
    ]);
    if (version !== loadVersion) return;
    const provider = registry.byId(registry.resolveProviderId(cfg));
    const ai = registry.isChatProvider(provider);
    const issue = registry.configurationIssue(provider, registry.providerSettings(cfg, provider?.id));
    providerHint.firstChild.textContent = issue ? issue + "。" : "";
    for (const [key, { control, kind, reading, fallback }] of fields) {
      let value = cfg[key] ?? fallback;
      if (key === "translationProvider") value = provider?.id || "none";
      if (key === "translationStrength") value = registry.normalizeStrength(value);
      if (key === "targetLanguage") {
        value ||= fallback;
        control.querySelector("[data-custom]")?.remove();
        if (!languages.some(([code]) => code === value)) {
          const option = new Option(value, value);
          option.dataset.custom = "true";
          control.append(option);
        }
      }
      if (kind === "checkbox") control.checked = Boolean(value);
      else if (kind === "range") {
        control.value = Math.round(value * 100);
        reading.textContent = control.value + "%";
      } else {
        control.value = String(value);
        if (control.selectedIndex < 0) control.value = String(fallback);
      }
      control.disabled = ["translationGlossary", "translationStrength", "selectionTranslate", "inputAutoReplace"].includes(key) &&
        (!ai || (key === "inputAutoReplace" && cfg.selectionTranslate === false));
      control.title = control.disabled
        ? (ai ? "先开启划词词典" : "需要 AI 翻译来源")
        : "";
    }
  }

  function report(error) {
    feedback.hidden = false;
    feedback.textContent = error.message;
  }

  async function save(key, value) {
    feedback.hidden = true;
    try {
      if (key === "translationProvider") await registry.saveProvider(value);
      else await chrome.storage.local.set({ [key]: value });
      await refresh();
    } catch (error) {
      report(error);
      refresh().catch(report);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some(key => keys.has(key) || key.startsWith("translationProfile:")))
      refresh().catch(report);
  });
  refresh().catch(report);
})();
