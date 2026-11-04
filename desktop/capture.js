const selection = document.getElementById("selection");
let start;
let done = false;
const send = (method, ...args) => {
  if (done) return;
  done = true;
  masTransport.invoke("capture:" + method, args).catch(() => { done = false; });
};
function area(event) {
  const x = Math.max(0, Math.min(innerWidth, event.clientX));
  const y = Math.max(0, Math.min(innerHeight, event.clientY));
  return { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
}
addEventListener("pointerdown", event => {
  if (event.button !== 0 || done) return;
  document.body.setPointerCapture(event.pointerId);
  start = { x: event.clientX, y: event.clientY };
});
addEventListener("pointermove", event => {
  if (!start) return;
  const { x, y, width, height } = area(event);
  Object.assign(selection.style, { left: x + "px", top: y + "px", width: width + "px", height: height + "px" });
  selection.hidden = false;
});
addEventListener("pointerup", event => {
  if (!start || event.button !== 0) return;
  const { x, y, width, height } = area(event);
  start = null;
  if (width < 4 || height < 4) { selection.hidden = true; return; }
  send("finish", { x: x / innerWidth, y: y / innerHeight, width: width / innerWidth, height: height / innerHeight });
});
addEventListener("keydown", event => { if (event.key === "Escape") send("cancel"); });
