const { randomUUID } = require("node:crypto");
const limit = 60;
const byteLimit = 1024 * 1024;

function historyOf(settings) {
  return Array.isArray(settings.desktopHistory) ? settings.desktopHistory : [];
}

function remember(bridge, value) {
  const source = String(value?.source || "").trim().slice(0, 10000);
  const translation = String(value?.translation || "").trim().slice(0, 20000);
  if (!source || !translation) return;
  const target = String(value?.target || "简体中文").slice(0, 100);
  const sourceLanguage = String(value?.sourceLanguage || "").slice(0, 100);
  return bridge.save(settings => {
    if (!value.favorite && !settings.desktopKeepHistory) return {};
    const history = historyOf(settings);
    const previous = history.find(item => item.source === source && item.translation === translation &&
      item.target === target && item.sourceLanguage === sourceLanguage);
    if (value.favorite && !previous?.favorite && history.filter(item => item.favorite).length >= limit)
      throw new Error("收藏已满，请先取消一条收藏");
    const record = { id: previous?.id || randomUUID(), source, translation, sourceLanguage, target,
      time: Date.now(), favorite: Boolean(value.favorite || previous?.favorite) };
    const all = [record, ...history.filter(item => item.id !== record.id)];
    while (all.length > limit || Buffer.byteLength(JSON.stringify(all)) > byteLimit) {
      const removable = all.findLastIndex(item => !item.favorite);
      if (removable < 0) throw new Error("收藏已满，请先取消一条收藏");
      all.splice(removable, 1);
    }
    return { desktopHistory: all };
  });
}

function editHistory(bridge, id, remove) {
  return bridge.save(settings => {
    const history = historyOf(settings);
    if (!history.some(item => item.id === id)) return {};
    return { desktopHistory: remove ? history.filter(item => item.id !== id) :
      history.map(item => item.id === id ? { ...item, favorite: !item.favorite } : item) };
  });
}

module.exports = { remember, editHistory, historyOf };
