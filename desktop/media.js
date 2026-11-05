const $ = id => document.getElementById(id);
const call = (name, ...args) => masTransport.invoke("media:" + name, args);
const registry = globalThis.MAS_providers;
const subtitles = globalThis.MAS_desktopSubtitles;
let selected;
let cues = [];
let operation;
let visible = 100;
const exportButtons = [...document.querySelectorAll("[data-export]")];

for (const language of registry.languages) {
  $("source-language").append(new Option(language.name, language.name));
  $("target-language").append(new Option(language.name, language.name));
}
$("source-language").prepend(new Option(registry.autoSource, "", true, true));
$("target-language").prepend(new Option("跟随全局目标语言", "", true, true));

function report(text) { $("status").textContent = text; }
function explain(error) { return String(error?.message || error).replace(/^Error invoking remote method 'mas:call': Error: /, ""); }

function controls() {
  const busy = Boolean(operation);
  for (const id of ["choose", "microphone", "system-audio", "source-language", "target-language", "auto-translate"])
    $(id).disabled = busy;
  $("transcribe").disabled = busy || !selected;
  $("stop").disabled = !busy;
  $("translate").disabled = busy || !cues.some(cue => !cue.translation);
  const hasOutput = $("display").value !== "translated" || cues.some(cue => cue.translation);
  for (const button of exportButtons) button.disabled = !cues.length || !hasOutput;
}

function render() {
  const mode = $("display").value;
  $("empty").hidden = cues.length > 0;
  $("more").hidden = cues.length <= visible;
  const fragment = document.createDocumentFragment();
  for (const cue of cues.slice(0, visible)) {
    const row = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = subtitles.timestamp(cue.start, ".");
    const content = document.createElement("div");
    const append = text => { const p = document.createElement("p"); p.textContent = text; content.append(p); };
    if (mode !== "translated") append(cue.source);
    if (mode !== "source" && (mode === "translated" || cue.translation !== cue.source))
      append(cue.translation || (mode === "translated" ? "待翻译" : ""));
    row.append(time, content);
    fragment.append(row);
  }
  $("cues").replaceChildren(fragment);
  controls();
}

function start(kind) {
  const task = { kind, id: crypto.randomUUID(), controller: new AbortController() };
  operation = task;
  controls();
  return task;
}

async function translateCues(task, rows = cues) {
  const pending = rows.filter(cue => !cue.translation);
  if (!pending.length) return;
  const cfg = await chrome.storage.local.get([...registry.profileKeys, "targetLanguage", "translationGlossary"]);
  const target = $("target-language").value || cfg.targetLanguage || "简体中文";
  const provider = registry.resolveProviderId(cfg);
  for (let i = 0; i < pending.length; i += 6) {
    task.controller.signal.throwIfAborted();
    const batch = pending.slice(i, i + 6);
    const result = await chrome.runtime.sendMessage({
      type: "TRANSLATE_TEXT_BLOCKS", texts: batch.map(cue => cue.source),
      source: $("source-language").value || undefined, target, provider,
      glossary: cfg.translationGlossary, translateMixed: true,
    });
    task.controller.signal.throwIfAborted();
    if (!result?.ok || result.translations?.length !== batch.length)
      throw new Error(result?.reason || "翻译来源未返回完整字幕");
    batch.forEach((cue, j) => { cue.translation = result.translations[j]; });
    render();
    report(`已翻译 ${cues.filter(cue => cue.translation).length} / ${cues.length} 条字幕`);
  }
}

function addSegments(segments, offset = 0) {
  const rows = segments.filter(item => item && Number.isFinite(item.start) && Number.isFinite(item.end) &&
    typeof item.text === "string" && item.text.trim()).map(item => ({
      start: offset + item.start, end: offset + item.end, source: item.text.trim(), translation: "",
    }));
  if (cues.length + rows.length > 10000) throw new Error("字幕数量已达到 10000 条");
  cues.push(...rows);
  render();
  return rows;
}

function finish(task, error) {
  if (operation !== task) return;
  task.stream?.getTracks().forEach(track => track.stop());
  operation = undefined;
  if (task.controller.signal.aborted) report(cues.length ? "已停止，可继续翻译或导出已有字幕。" : "已停止。");
  else if (error) report(explain(error));
  else report(cues.length ? `已完成，共 ${cues.length} 条字幕。` : "未识别到可转写的语音。");
  controls();
}

masTransport.subscribe((event, update) => {
  if (event !== "media:progress" || operation?.id !== update.id || operation.controller.signal.aborted) return;
  try {
    addSegments(update.segments);
    report(`已识别至 ${subtitles.timestamp(update.processed, ".").slice(0, 8)}，共 ${cues.length} 条字幕`);
  } catch (error) {
    operation.error = error;
    call("cancel").catch(() => {});
  }
});

$("choose").onclick = () => $("media-file").click();
$("media-file").onchange = async () => {
  const input = $("media-file");
  try {
    if (!input.files.length) return;
    const file = await masTransport.chooseMedia(input.files[0]);
    if (!file) return;
    selected = file;
    cues = [];
    visible = 100;
    $("file").firstChild.textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB。 `;
    render();
    report("文件已选好，可以开始转写。");
  } catch (error) { report(explain(error)); }
  finally { input.value = ""; }
};

$("transcribe").onclick = async () => {
  cues = [];
  visible = 100;
  const task = start("file");
  render();
  report("正在读取音轨并加载语音模型…");
  try {
    await call("transcribe", { id: task.id, language: registry.languageBase($("source-language").value) || undefined });
    task.controller.signal.throwIfAborted();
    if (task.error) throw task.error;
    if ($("auto-translate").checked) await translateCues(task);
    finish(task);
  } catch (error) { finish(task, task.error || error); }
};

$("translate").onclick = async () => {
  const task = start("translation");
  try { await translateCues(task); finish(task); }
  catch (error) { finish(task, error); }
};

function record(audio, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const recorder = new MediaRecorder(audio, { mimeType: "audio/webm;codecs=opus" });
    const chunks = [];
    const stop = () => { if (recorder.state !== "inactive") recorder.stop(); };
    const timer = setTimeout(stop, 5500);
    const clean = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => { clean(); resolve(new Blob(chunks, { type: "audio/webm" })); };
    recorder.onerror = event => { clean(); reject(event.error); };
    signal.addEventListener("abort", stop, { once: true });
    recorder.start();
  });
}

async function live(source) {
  cues = [];
  visible = 100;
  const task = start("live");
  render();
  report("正在连接音源…");
  const { signal } = task.controller;
  try {
    const stream = await (source === "mic" ? navigator.mediaDevices.getUserMedia({ audio: true })
      : navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }));
    if (signal.aborted) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    task.stream = stream;
    const tracks = task.stream.getAudioTracks();
    if (!tracks.length) throw new Error("未获得声音，请检查音源和系统权限");
    for (const track of tracks) track.onended = () => task.controller.abort();
    const audio = new MediaStream(tracks);
    const [base] = await globalThis.MAS_backendCandidates();
    const language = registry.languageBase($("source-language").value);
    const started = performance.now();
    report(source === "mic" ? "正在转写麦克风声音…" : "正在转写系统声音…");
    let pending;
    let failure;
    while (!signal.aborted && !failure) {
      const offset = (performance.now() - started) / 1000;
      const blob = await record(audio, signal);
      if (!blob.size || pending || signal.aborted) continue;
      pending = (async () => {
        const body = new FormData();
        body.append("audio", blob, "segment.webm");
        if (language) body.append("language", language);
        const response = await fetch(base + "/api/transcribe-audio", { method: "POST", body, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
        const payload = await response.json();
        signal.throwIfAborted();
        if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "实时转写失败");
        const rows = addSegments(payload.segments || [], offset);
        if (rows.length && $("auto-translate").checked) {
          try { await translateCues(task, rows); }
          catch (error) { if (!signal.aborted) report(explain(error) + "。原文会继续保留。"); }
        }
      })().catch(error => { if (!signal.aborted) failure = error; }).finally(() => { pending = undefined; });
    }
    await pending;
    finish(task, failure);
  } catch (error) { finish(task, error); }
}

$("microphone").onclick = () => live("mic");
$("system-audio").onclick = () => live("system");
$("stop").onclick = () => {
  if (!operation) return;
  operation.controller.abort();
  operation.stream?.getTracks().forEach(track => track.stop());
  if (operation.kind === "file") call("cancel").catch(() => {});
  finish(operation);
};
$("pin").onchange = () => call("pin", $("pin").checked).catch(error => report(explain(error)));
$("document").onclick = () => call("document").catch(error => report(explain(error)));
$("more").onclick = () => { visible += 100; render(); };
for (const button of exportButtons) button.onclick = () => {
  const format = button.dataset.export;
  const text = subtitles.serialize(cues, format, $("display").value);
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  const name = selected?.name.replace(/\.[^.]+$/, "") || "MasLingo-字幕";
  anchor.href = url;
  anchor.download = name + "." + format;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  report("已生成字幕文件。");
};

const settings = { "source-language": "videoSourceLanguage", "target-language": "videoTargetLanguage",
  display: "videoDisplayMode", "auto-translate": "videoAutoPrepare" };
for (const [id, key] of Object.entries(settings)) $(id).onchange = () => {
  const input = $(id);
  chrome.storage.local.set({ [key]: input.type === "checkbox" ? input.checked : input.value }).catch(error => report(explain(error)));
  if (id.endsWith("language")) cues.forEach(cue => { cue.translation = ""; });
  render();
};
chrome.storage.local.get(Object.values(settings)).then(cfg => {
  for (const [id, key] of Object.entries(settings)) {
    if (cfg[key] === undefined) continue;
    const control = $(id);
    if (control.type === "checkbox") control.checked = cfg[key] !== false;
    else if ([...control.options].some(option => option.value === cfg[key])) control.value = cfg[key];
  }
}).catch(error => report(explain(error)));
