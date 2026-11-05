// Only these controls cross the desktop/browser boundary.
(() => {
  const registry = globalThis.MAS_providers;
  const booleans = [
    "autoTranslate", "webAutoTranslate", "hoverTranslate", "selectionTranslate",
    "inputAutoReplace", "videoAutoPrepare", "debugMode",
  ];
  const modes = ["webDisplayMode", "videoDisplayMode"];
  const languages = ["targetLanguage", "videoSourceLanguage", "videoTargetLanguage"];
  const numbers = {
    translationStrength: [0, 2],
    autoConcurrency: [1, 3],
    fontScale: [0.6, 1.6],
    overlayOpacity: [0.3, 1],
  };
  const keys = ["translationProvider", "translationGlossary", ...booleans, ...modes, ...languages, ...Object.keys(numbers)];
  const legacy = ["translationMode", "translationEndpoint"];
  const port = 41763;

  function pick(settings) {
    const preferences = {};
    for (const key of booleans) if (typeof settings[key] === "boolean") preferences[key] = settings[key];
    for (const key of modes)
      if (["bilingual", "translated", "source"].includes(settings[key])) preferences[key] = settings[key];
    for (const key of languages)
      if (typeof settings[key] === "string" && settings[key].length <= 100 && !/[\u0000-\u001f]/.test(settings[key]))
        preferences[key] = settings[key];
    for (const [key, [min, max]] of Object.entries(numbers))
      if (typeof settings[key] === "number" && settings[key] >= min && settings[key] <= max)
        preferences[key] = settings[key];
    const provider = settings.translationProvider || (settings.translationMode && registry.resolveProviderId(settings));
    if (registry.byId(provider)) preferences.translationProvider = provider;
    if (registry.glossaries.some(item => item.id === settings.translationGlossary))
      preferences.translationGlossary = settings.translationGlossary;
    return preferences;
  }

  function delta(before, after) {
    return Object.fromEntries(Object.entries(after).filter(([key, value]) => before[key] !== value));
  }

  globalThis.MAS_syncPreferences = { keys, legacy, port, pick, delta };
})();
