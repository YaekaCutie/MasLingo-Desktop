(() => {
  function timestamp(seconds, separator) {
    const ms = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
    const time = [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60]
      .map(value => String(value).padStart(2, "0")).join(":");
    return time + separator + String(ms % 1000).padStart(3, "0");
  }

  function cueText(cue, mode) {
    if (mode === "source") return cue.source;
    if (mode === "translated") return cue.translation || "";
    return [cue.source, cue.translation && cue.translation !== cue.source ? cue.translation : ""].filter(Boolean).join("\n");
  }

  function serialize(cues, format, mode) {
    const records = cues.map(cue => ({ ...cue, text: cueText(cue, mode).trim() })).filter(cue => cue.text);
    if (format === "txt") return records.map(cue => cue.text).join("\n\n");
    const separator = format === "vtt" ? "." : ",";
    const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const content = records.map((cue, index) => {
      const start = timestamp(cue.start, separator);
      const end = timestamp(Math.max(cue.end, cue.start + .001), separator);
      const text = cue.text.replace(/\r?\n[ \t]*\r?\n/g, "\n");
      return [index + 1, start + " --> " + end, format === "vtt" ? escape(text) : text].join("\n");
    }).join("\n\n");
    return (format === "vtt" ? "WEBVTT\n\n" : "") + content + "\n";
  }

  globalThis.MAS_desktopSubtitles = { timestamp, serialize };
})();
