// The desktop tools and browser companion share translation and document modules.
function installChrome(transport) {
  const event = () => {
    const listeners = new Set();
    return {
      addListener: listener => listeners.add(listener),
      emit: (...args) => { for (const listener of listeners) listener(...args); },
      listeners,
    };
  };
  const messages = event();
  const changes = event();
  const invoke = (method, ...args) => transport.invoke(method, args);
  transport.subscribe((type, ...args) => {
    if (type === "storage:change") changes.emit(...args);
    if (type !== "request") return;
    const [id, message, sender] = args;
    let waiting = false;
    let replied = false;
    const reply = value => {
      if (replied) return;
      replied = true;
      transport.signal("reply", id, value);
    };
    for (const listener of messages.listeners) {
      waiting = listener(message, sender, reply) === true || waiting;
      if (replied) break;
    }
    if (!waiting) reply(undefined);
  });
  globalThis.chrome = {
    runtime: {
      getManifest: () => transport.manifest,
      sendMessage: message => invoke("runtime:message", message),
      onMessage: messages,
      onConnect: event(),
      openOptionsPage: () => invoke("app:options"),
    },
    storage: {
      local: { get: keys => invoke("storage:get", keys), set: values => invoke("storage:set", values) },
      onChanged: changes,
    },
    permissions: {
      contains: ({ origins }) => invoke("permissions:contains", origins),
      request: ({ origins }) => invoke("permissions:request", origins),
    },
    i18n: {
      detectLanguage: (sample, callback) => invoke("language:detect", sample).then(callback, () => callback(null)),
    },
  };
}
