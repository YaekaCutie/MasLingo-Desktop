installChrome(globalThis.masTransport);

// The extension previously used host permissions for these cross-origin requests.
const localFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, init) => {
  const request = new Request(url, init);
  if (new URL(request.url).protocol === "data:") return localFetch(request);
  const { signal } = request;
  const id = masTransport.id();
  const abort = () => masTransport.signal("fetch:abort", id);
  const options = {
    method: request.method,
    headers: [...request.headers],
    body: request.body ? await request.arrayBuffer() : undefined,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  };
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await masTransport.invoke("fetch", [id, request.url, options]);
    signal.throwIfAborted();
    return new Response(response.body, response);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
};
