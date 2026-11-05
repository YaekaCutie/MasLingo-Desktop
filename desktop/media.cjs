const fs = require("node:fs");
const path = require("node:path");

const formats = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "mp4", "mkv", "webm", "mov", "avi"];
const MAX_BYTES = 160 * 1024 * 1024;

function createMediaTools(bridge) {
  let file;
  let active;

  async function choose(selected) {
    if (active) throw new Error("请先停止当前任务");
    if (!selected || !formats.includes(path.extname(selected).slice(1).toLowerCase()))
      throw new Error("请选择支持的音频或视频文件");
    const stat = await fs.promises.stat(selected);
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw new Error("请选择 160 MB 以内的非空文件");
    file = selected;
    return { name: path.basename(file), size: stat.size };
  }

  async function transcribe({ language, id }) {
    if (!file || active) throw new Error("请选择文件或停止当前任务");
    const controller = new AbortController();
    active = controller;
    try {
      const configured = bridge.read().backendUrl || "http://127.0.0.1:8001";
      const endpoint = new URL(configured.replace(/\/+$/, "") + "/api/transcribe-file");
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
        throw new Error("引擎地址无效");
      const audio = await fs.openAsBlob(file);
      if (!audio.size || audio.size > MAX_BYTES) throw new Error("文件已变更，请重新选择");
      const body = new FormData();
      body.append("audio", audio, path.basename(file));
      if (language) body.append("language", language);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2 * 60 * 60 * 1000)]);
      let response;
      try {
        response = await fetch(endpoint, { method: "POST", body, signal, redirect: "error" });
      } catch (error) {
        signal.throwIfAborted();
        throw new Error("无法连接语音引擎，请检查应用设置中的引擎地址");
      }
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(typeof error.detail === "string" ? error.detail : `转写失败（HTTP ${response.status}）`);
      }
      if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson"))
        throw new Error("当前引擎不支持音视频文件转写，请启动新版桌面引擎");

      const decoder = new TextDecoder();
      let tail = "";
      let complete = false;
      for await (const chunk of response.body) {
        tail += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = tail.indexOf("\n")) >= 0) {
          const line = tail.slice(0, index);
          tail = tail.slice(index + 1);
          if (!line.trim()) continue;
          if (line.length > 500000) throw new Error("转写响应过大");
          const event = JSON.parse(line);
          if (event.error) throw new Error(String(event.error));
          if (event.done) complete = true;
          else if (Array.isArray(event.segments)) {
            bridge.broadcast("media:progress", { id, ...event });
          }
        }
        if (tail.length > 500000) throw new Error("转写响应过大");
      }
      if (!complete) throw new Error("转写连接中断，可保留并导出已完成的字幕");
    } finally {
      controller.abort();
      active = undefined;
    }
  }

  return {
    choose, transcribe,
    cancel() { active?.abort(); },
    clear() { active?.abort(); file = undefined; },
  };
}

module.exports = { createMediaTools };
