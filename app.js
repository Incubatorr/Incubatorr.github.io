// The Incubator — a full-screen sketch surface where each finished drawing
// slowly grows over time, like ideas in an incubator.
//
// Performance model: a finished stroke is rendered ONCE into a small bitmap
// (sized to its bounding box). Growth is then just drawImage() of that bitmap
// scaled up — GPU-accelerated compositing, not per-frame geometry. The render
// loop only runs while something is animating, then goes idle (zero CPU).

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const WIDTHS = [
  { size: 3, dot: 6 },
  { size: 8, dot: 11 },
  { size: 16, dot: 18 },
];
const COLORS = ["#ffffff", "#f5a623", "#ff5c5c", "#4aa3ff", "#5ad17f"];

// --- Growth tuning (tweak to taste) ---
const GROWTH_PER_SEC = 0.05; // grows ~5% of original size per second...
const MAX_SCALE = 4; // ...up to 4x, then stops (lets the loop go idle)
const OVERSAMPLE = 2; // bitmap render resolution headroom (keeps it crisp as it grows)
const MIN_POINT_DIST = 1.5; // CSS px between recorded points (thinning)

const state = {
  tool: "pen", // "pen" | "eraser"
  color: COLORS[0],
  sizes: { pen: WIDTHS[1].size, eraser: WIDTHS[2].size },
  drawing: false,
};

let dpr = window.devicePixelRatio || 1;
let rect = { left: 0, top: 0 };

// ---- Strokes ----
// Committed: { tool, bitmap, w, h, cx, cy, birth }  (w/h/cx/cy in CSS px)
// In-progress: { tool, color, size, points:[{x,y}] }
const strokes = [];
let current = null;

function strokeStyleFor(c, tool, color) {
  // eraser bakes an opaque mask; on the main canvas it composites as destination-out
  c.strokeStyle = tool === "eraser" ? "#ffffff" : color;
}

// Render a finished stroke into its own tightly-cropped bitmap.
function bakeStroke(s) {
  const pts = s.points;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = s.size / 2 + 2;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const ox = minX - pad;
  const oy = minY - pad;

  const res = dpr * OVERSAMPLE;
  const bmp = document.createElement("canvas");
  bmp.width = Math.max(1, Math.ceil(w * res));
  bmp.height = Math.max(1, Math.ceil(h * res));
  const b = bmp.getContext("2d");
  b.setTransform(res, 0, 0, res, 0, 0);
  b.translate(-ox, -oy);
  b.lineCap = "round";
  b.lineJoin = "round";
  b.lineWidth = s.size;
  strokeStyleFor(b, s.tool, s.color);
  b.beginPath();
  b.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) b.lineTo(pts[0].x, pts[0].y);
  else for (let i = 1; i < pts.length; i++) b.lineTo(pts[i].x, pts[i].y);
  b.stroke();

  return {
    tool: s.tool,
    bitmap: bmp,
    w,
    h,
    cx: ox + w / 2,
    cy: oy + h / 2,
    birth: performance.now(),
  };
}

function scaleOf(s, now) {
  return Math.min(MAX_SCALE, 1 + (GROWTH_PER_SEC * (now - s.birth)) / 1000);
}

function clearDevice() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ---- Render loop (runs only while animating) ----
let rafId = null;

function frame() {
  const now = performance.now();
  let animating = state.drawing;
  clearDevice();

  // committed strokes: composite each cached bitmap, scaled around its center
  for (const s of strokes) {
    const sc = scaleOf(s, now);
    if (sc < MAX_SCALE) animating = true;
    const dw = s.w * sc * dpr;
    const dh = s.h * sc * dpr;
    const dx = (s.cx - (s.w * sc) / 2) * dpr;
    const dy = (s.cy - (s.h * sc) / 2) * dpr;
    ctx.globalCompositeOperation =
      s.tool === "eraser" ? "destination-out" : "source-over";
    ctx.drawImage(s.bitmap, dx, dy, dw, dh);
  }

  // in-progress stroke: live vector at 1x (does not grow until released)
  if (current && current.points.length) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = current.size;
    ctx.globalCompositeOperation =
      current.tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = current.tool === "eraser" ? "rgba(0,0,0,1)" : current.color;
    const p = current.points;
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    if (p.length === 1) ctx.lineTo(p[0].x, p[0].y);
    else for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
    ctx.stroke();
  }

  rafId = animating ? requestAnimationFrame(frame) : null;
}

function ensureLoop() {
  if (rafId == null) rafId = requestAnimationFrame(frame);
}

function undo() {
  if (strokes.length) {
    strokes.pop();
    ensureLoop();
  }
}

function reset() {
  strokes.length = 0;
  current = null;
  state.drawing = false;
  ensureLoop();
}

// ---- Canvas sizing (resetting size clears ctx state) ----
function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  rect = canvas.getBoundingClientRect();
  ensureLoop();
}

// ---- Drawing (input only appends points; the loop renders) ----
function start(e) {
  state.drawing = true;
  current = {
    tool: state.tool,
    color: state.color,
    size: state.sizes[state.tool],
    points: [{ x: e.clientX - rect.left, y: e.clientY - rect.top }],
  };
  canvas.setPointerCapture(e.pointerId);
  ensureLoop();
}

function move(e) {
  if (!state.drawing || !current) return;
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const pts = current.points;
  const last = pts[pts.length - 1];
  if (Math.hypot(x - last.x, y - last.y) >= MIN_POINT_DIST) pts.push({ x, y });
}

function end() {
  if (!state.drawing) return;
  state.drawing = false;
  if (current && current.points.length) strokes.push(bakeStroke(current));
  current = null;
  ensureLoop();
}

// ---- Brush-size ring cursor ----
const cursorEl = document.getElementById("cursor");
let cursorX = 0;
let cursorY = 0;
let cursorVisible = false;

function applyCursorSize() {
  const d = state.sizes[state.tool];
  cursorEl.style.width = d + "px";
  cursorEl.style.height = d + "px";
  cursorEl.classList.toggle("eraser", state.tool === "eraser");
}
function moveCursor() {
  cursorEl.style.transform =
    "translate(" + cursorX + "px," + cursorY + "px) translate(-50%,-50%)";
  cursorEl.style.display = cursorVisible ? "block" : "none";
}

canvas.addEventListener("pointerdown", (e) => {
  start(e);
  cursorX = e.clientX;
  cursorY = e.clientY;
  cursorVisible = true;
  moveCursor();
});
canvas.addEventListener("pointermove", (e) => {
  cursorX = e.clientX;
  cursorY = e.clientY;
  cursorVisible = true;
  moveCursor();
  if (state.drawing) move(e);
});
canvas.addEventListener("pointerup", end);
canvas.addEventListener("pointercancel", end);
canvas.addEventListener("pointerenter", (e) => {
  cursorVisible = true;
  cursorX = e.clientX;
  cursorY = e.clientY;
  applyCursorSize();
  moveCursor();
});
canvas.addEventListener("pointerleave", () => {
  cursorVisible = false;
  moveCursor();
});

// ---- Tool selection ----
const penBtn = document.getElementById("tool-pen");
const eraserBtn = document.getElementById("tool-eraser");

function setTool(tool) {
  state.tool = tool;
  penBtn.classList.toggle("active", tool === "pen");
  eraserBtn.classList.toggle("active", tool === "eraser");
  applyCursorSize();
  moveCursor();
}

// ---- Flyout open/close (hover on desktop, tap on touch) ----
const groups = document.querySelectorAll(".tool-group");
const gPen = document.getElementById("g-pen");
const gEraser = document.getElementById("g-eraser");
const gColor = document.getElementById("g-color");

function closeAll(except) {
  groups.forEach((g) => {
    if (g !== except) g.classList.remove("open");
  });
}
function toggleOpen(g) {
  const willOpen = !g.classList.contains("open");
  closeAll(g);
  g.classList.toggle("open", willOpen);
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".tool-group")) closeAll(null);
});
// Close a flyout once the cursor leaves both the icon and its submenu
groups.forEach((g) => {
  g.addEventListener("mouseleave", () => g.classList.remove("open"));
});

penBtn.addEventListener("click", () => {
  setTool("pen");
  toggleOpen(gPen);
});
eraserBtn.addEventListener("click", () => {
  setTool("eraser");
  toggleOpen(gEraser);
});
document
  .getElementById("tool-color")
  .addEventListener("click", () => toggleOpen(gColor));

// ---- Width chips (pen + eraser each keep their own size) ----
const widthSyncers = [];

function buildWidths(containerId, tool, group) {
  const wrap = document.getElementById(containerId);
  function sync() {
    [...wrap.children].forEach((b) =>
      b.classList.toggle("active", +b.dataset.size === state.sizes[tool])
    );
  }
  WIDTHS.forEach((w) => {
    const b = document.createElement("button");
    b.className = "width";
    b.dataset.size = w.size;
    b.setAttribute("aria-label", "Width " + w.size);
    const dot = document.createElement("span");
    dot.className = "width-dot";
    dot.style.width = w.dot + "px";
    dot.style.height = w.dot + "px";
    b.appendChild(dot);
    b.addEventListener("click", () => {
      state.sizes[tool] = w.size;
      setTool(tool);
      sync();
      group.classList.remove("open");
    });
    wrap.appendChild(b);
  });
  widthSyncers.push(sync);
}

buildWidths("widths", "pen", gPen);
buildWidths("eraser-widths", "eraser", gEraser);

// ---- Color chips ----
const colorDot = document.getElementById("color-dot");
const swatchWrap = document.getElementById("swatches");
function syncColors() {
  colorDot.style.background = state.color;
  [...swatchWrap.children].forEach((b) =>
    b.classList.toggle("active", b.dataset.color === state.color)
  );
}
COLORS.forEach((c) => {
  const b = document.createElement("button");
  b.className = "swatch";
  b.dataset.color = c;
  b.style.background = c;
  b.setAttribute("aria-label", "Color " + c);
  b.addEventListener("click", () => {
    state.color = c;
    setTool("pen");
    syncColors();
    gColor.classList.remove("open");
  });
  swatchWrap.appendChild(b);
});

// ---- Undo + reset ----
document.getElementById("undo").addEventListener("click", undo);
document.getElementById("reset").addEventListener("click", reset);

// ---- Keyboard shortcuts ----
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  } else if (e.key === "b" || e.key === "B") {
    setTool("pen");
  } else if (e.key === "e" || e.key === "E") {
    setTool("eraser");
  }
});

// ---- Init ----
window.addEventListener("resize", resize);
resize();
applyCursorSize();
widthSyncers.forEach((fn) => fn());
syncColors();
