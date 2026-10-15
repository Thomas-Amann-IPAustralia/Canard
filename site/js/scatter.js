// Canvas scatter plot with zoom, pan, hover, click and lasso selection, and animated
// transitions between layouts. Handles a few thousand points at 60 frames per second.

const POINT_RADIUS = 4.5; // CSS pixels: a 9 px marker.
const HIT_RADIUS = 12; // CSS pixels: a 24 px hit target.
const PAD = 28;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Scatter {
  constructor(canvas, { onHover = () => {}, onClick = () => {}, onLasso = () => {}, onEscape = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = { onHover, onClick, onLasso, onEscape };
    this.n = 0;
    this.pos = new Float32Array(0);
    this.from = null;
    this.to = new Float32Array(0);
    this.anim = null;
    this.view = { s: 100, ox: 0, oy: 0 };
    this.viewAnim = null;
    this.userZoomed = false;
    this.tool = 'pan';
    this.colourIdx = new Uint8Array(0);
    this.palette = ['#888'];
    this.visible = new Uint8Array(0);
    this.hideNonMatching = false;
    this.selected = new Set();
    this.focus = null;
    this.hover = null;
    this.lasso = null;
    this.pointers = new Map();
    this.drag = null;
    this.colours = { surface: '#fff', ink: '#000', dim: '#ccc', ring: '#fff', lassoFill: 'rgba(0,0,0,0.06)' };
    this.frame = 0;
    this.width = 0;
    this.height = 0;
    this.bind();
    this.resize();
  }

  // ---- data and appearance ----------------------------------------------------

  /** Set the target layout. With animate, points glide from where they are now. */
  setPositions(coords, { animate = false, fit = true, start = null } = {}) {
    const n = coords.length / 2;
    if (start && start.length === coords.length) {
      // Explicit starting positions (used when points are added or removed).
      this.n = n;
      this.pos = Float32Array.from(start);
      this.hover = null;
    }
    if (n !== this.n) {
      this.n = n;
      this.pos = Float32Array.from(coords);
      this.to = Float32Array.from(coords);
      this.anim = null;
      this.hover = null;
      if (fit) this.fit({ animate: false });
      this.draw();
      return;
    }
    this.to = Float32Array.from(coords);
    if (animate && n > 0) {
      this.from = Float32Array.from(this.pos);
      this.anim = { start: performance.now(), duration: reducedMotion() ? 1 : 550 };
    } else {
      this.pos = Float32Array.from(coords);
      this.anim = null;
    }
    if (fit) this.fit({ animate });
    this.draw();
  }

  setAppearance({ colourIdx, palette, visible, hideNonMatching, selected, focus }) {
    if (colourIdx) this.colourIdx = colourIdx;
    if (palette) this.palette = palette;
    if (visible) this.visible = visible;
    if (hideNonMatching !== undefined) this.hideNonMatching = hideNonMatching;
    if (selected) this.selected = selected;
    if (focus !== undefined) this.focus = focus;
    if (this.hover !== null && !this.isShown(this.hover)) this.setHover(null);
    this.draw();
  }

  setColours(colours) {
    this.colours = { ...this.colours, ...colours };
    this.draw();
  }

  setTool(tool) {
    this.tool = tool;
    this.canvas.dataset.tool = tool;
  }

  isShown(i) {
    return !this.hideNonMatching || this.visible[i] === 1;
  }

  // ---- view -------------------------------------------------------------------

  boundsFor(coords, onlyVisible) {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let i = 0; i < this.n; i += 1) {
      if (onlyVisible && this.visible[i] !== 1) continue;
      const x = coords[2 * i]; const y = coords[2 * i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (minX === Infinity) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
    return { minX, maxX, minY, maxY };
  }

  fitView(onlyVisible = false) {
    const b = this.boundsFor(this.to, onlyVisible);
    const w = Math.max(1, this.width - 2 * PAD);
    const h = Math.max(1, this.height - 2 * PAD);
    const spanX = Math.max(b.maxX - b.minX, 0.05);
    const spanY = Math.max(b.maxY - b.minY, 0.05);
    const s = Math.min(w / spanX, h / spanY);
    return { s, ox: this.width / 2 - (s * (b.minX + b.maxX)) / 2, oy: this.height / 2 + (s * (b.minY + b.maxY)) / 2 };
  }

  fit({ animate = true, onlyVisible = false } = {}) {
    const target = this.fitView(onlyVisible);
    this.baseScale = this.fitView(false).s;
    this.userZoomed = false;
    if (animate) {
      this.viewAnim = { from: { ...this.view }, to: target, start: performance.now(), duration: reducedMotion() ? 1 : 550 };
    } else {
      this.view = target;
      this.viewAnim = null;
    }
    this.draw();
  }

  /** Pan so that point i is in view (used when a point is chosen from the list). */
  reveal(i) {
    const [sx, sy] = this.toScreen(this.to[2 * i], this.to[2 * i + 1], this.viewAnim ? this.viewAnim.to : this.view);
    if (sx > PAD && sx < this.width - PAD && sy > PAD && sy < this.height - PAD) return;
    const from = { ...this.view };
    const to = { ...this.view, ox: this.view.ox + this.width / 2 - sx, oy: this.view.oy + this.height / 2 - sy };
    this.viewAnim = { from, to, start: performance.now(), duration: reducedMotion() ? 1 : 400 };
    this.draw();
  }

  zoomBy(factor, cx = this.width / 2, cy = this.height / 2) {
    const base = this.baseScale || this.view.s;
    const s = Math.min(base * 400, Math.max(base * 0.3, this.view.s * factor));
    const k = s / this.view.s;
    this.view = { s, ox: cx - (cx - this.view.ox) * k, oy: cy - (cy - this.view.oy) * k };
    this.viewAnim = null;
    this.userZoomed = true;
    this.draw();
  }

  panBy(dx, dy) {
    this.view = { ...this.view, ox: this.view.ox + dx, oy: this.view.oy + dy };
    this.viewAnim = null;
    this.userZoomed = true;
    this.draw();
  }

  toScreen(x, y, view = this.view) {
    return [view.ox + x * view.s, view.oy - y * view.s];
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.width && h === this.height && this.dpr === dpr) return;
    const dw = w - this.width;
    const dh = h - this.height;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (this.userZoomed) {
      this.view = { ...this.view, ox: this.view.ox + dw / 2, oy: this.view.oy + dh / 2 };
    } else if (this.n) {
      this.fit({ animate: false });
    }
    this.draw();
  }

  // ---- rendering --------------------------------------------------------------

  draw() {
    if (!this.frame) this.frame = requestAnimationFrame((t) => this.render(t));
  }

  render(now) {
    this.frame = 0;
    let animating = false;
    if (this.anim) {
      const t = Math.min(1, (now - this.anim.start) / this.anim.duration);
      const e = easeInOut(t);
      const { from, to } = this;
      for (let i = 0; i < this.pos.length; i += 1) this.pos[i] = from[i] + (to[i] - from[i]) * e;
      if (t >= 1) this.anim = null;
      else animating = true;
    }
    if (this.viewAnim) {
      const t = Math.min(1, (now - this.viewAnim.start) / this.viewAnim.duration);
      const e = easeInOut(t);
      const { from, to } = this.viewAnim;
      // Interpolate the scale geometrically so zooming feels even.
      const s = from.s * (to.s / from.s) ** e;
      this.view = { s, ox: from.ox + (to.ox - from.ox) * e, oy: from.oy + (to.oy - from.oy) * e };
      if (t >= 1) this.viewAnim = null;
      else animating = true;
    }
    this.paint();
    if (animating) this.draw();
  }

  paint() {
    const { ctx, colours } = this;
    const dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colours.surface;
    ctx.fillRect(0, 0, this.width, this.height);
    const n = this.n;
    if (!n) return;
    const { s, ox, oy } = this.view;
    const r = POINT_RADIUS;
    const minX = -r * 2; const maxX = this.width + r * 2;
    const minY = -r * 2; const maxY = this.height + r * 2;
    const sx = new Float32Array(n);
    const sy = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      sx[i] = ox + this.pos[2 * i] * s;
      sy[i] = oy - this.pos[2 * i + 1] * s;
    }
    this.screen = { sx, sy };
    const onScreen = (i) => sx[i] >= minX && sx[i] <= maxX && sy[i] >= minY && sy[i] <= maxY;

    // Entries that do not match the filters sit underneath, faded.
    if (!this.hideNonMatching) {
      ctx.beginPath();
      for (let i = 0; i < n; i += 1) {
        if (this.visible[i] === 1 || !onScreen(i)) continue;
        ctx.moveTo(sx[i] + r - 1, sy[i]);
        ctx.arc(sx[i], sy[i], r - 1, 0, Math.PI * 2);
      }
      ctx.fillStyle = colours.dim;
      ctx.fill();
    }

    // Matching entries, grouped by colour; "other" (index 0) first so colours sit on top.
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = colours.ring;
    for (let c = 0; c < this.palette.length; c += 1) {
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < n; i += 1) {
        if (this.visible[i] !== 1 || this.colourIdx[i] !== c || !onScreen(i)) continue;
        ctx.moveTo(sx[i] + r, sy[i]);
        ctx.arc(sx[i], sy[i], r, 0, Math.PI * 2);
        any = true;
      }
      if (!any) continue;
      ctx.fillStyle = this.palette[c];
      ctx.fill();
      ctx.stroke();
    }

    // Selected entries: enlarged with an ink ring.
    if (this.selected.size) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = colours.ink;
      for (const i of this.selected) {
        if (i >= n || !this.isShown(i) || !onScreen(i)) continue;
        ctx.beginPath();
        ctx.arc(sx[i], sy[i], r + 1.5, 0, Math.PI * 2);
        ctx.fillStyle = this.visible[i] === 1 ? this.palette[this.colourIdx[i]] : colours.dim;
        ctx.fill();
        ctx.stroke();
      }
    }
    if (this.focus !== null && this.focus < n && this.isShown(this.focus)) {
      const i = this.focus;
      ctx.beginPath();
      ctx.arc(sx[i], sy[i], r + 6, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = colours.ink;
      ctx.stroke();
    }
    if (this.hover !== null && this.hover < n) {
      const i = this.hover;
      ctx.beginPath();
      ctx.arc(sx[i], sy[i], r + 3.5, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = colours.ink;
      ctx.stroke();
    }
    if (this.lasso && this.lasso.length > 1) {
      ctx.beginPath();
      ctx.moveTo(this.lasso[0], this.lasso[1]);
      for (let k = 2; k < this.lasso.length; k += 2) ctx.lineTo(this.lasso[k], this.lasso[k + 1]);
      ctx.closePath();
      ctx.fillStyle = colours.lassoFill;
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = colours.ink;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---- hit testing ------------------------------------------------------------

  nearest(x, y) {
    if (!this.screen || this.anim) return null;
    const { sx, sy } = this.screen;
    let best = null;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    // Prefer matching points: they are drawn on top.
    for (let pass = 0; pass < 2 && best === null; pass += 1) {
      for (let i = 0; i < this.n; i += 1) {
        const match = this.visible[i] === 1;
        if (pass === 0 ? !match : match || this.hideNonMatching) continue;
        const d = (sx[i] - x) ** 2 + (sy[i] - y) ** 2;
        if (d <= bestD) { bestD = d; best = i; }
      }
    }
    return best;
  }

  pointsInLasso(poly) {
    const { sx, sy } = this.screen;
    const inside = [];
    const m = poly.length / 2;
    for (let i = 0; i < this.n; i += 1) {
      if (this.visible[i] !== 1) continue;
      const x = sx[i]; const y = sy[i];
      let hit = false;
      for (let a = 0, b = m - 1; a < m; b = a, a += 1) {
        const xa = poly[2 * a]; const ya = poly[2 * a + 1];
        const xb = poly[2 * b]; const yb = poly[2 * b + 1];
        if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) hit = !hit;
      }
      if (hit) inside.push(i);
    }
    return inside;
  }

  /** Ring a point without showing its tooltip (used when hovering the entry list). */
  highlight(i) {
    if (i === this.hover) return;
    this.hover = i;
    this.draw();
  }

  setHover(i, clientX = 0, clientY = 0) {
    if (i === this.hover) {
      if (i !== null) this.handlers.onHover(i, clientX, clientY);
      return;
    }
    this.hover = i;
    this.canvas.style.cursor = i !== null ? 'pointer' : '';
    this.handlers.onHover(i, clientX, clientY);
    this.draw();
  }

  // ---- input ------------------------------------------------------------------

  local(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
    c.addEventListener('pointerleave', (e) => { if (!this.drag && e.pointerType === 'mouse') this.setHover(null); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = this.local(e);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
      const delta = Math.max(-300, Math.min(300, e.deltaY * unit));
      this.zoomBy(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0018)), x, y);
      this.setHover(null);
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      const [x, y] = this.local(e);
      this.zoomBy(e.shiftKey ? 0.5 : 2, x, y);
    });
    c.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.resize()).observe(c);
  }

  onKey(e) {
    const step = 60;
    const keys = {
      ArrowLeft: () => this.panBy(step, 0), ArrowRight: () => this.panBy(-step, 0),
      ArrowUp: () => this.panBy(0, step), ArrowDown: () => this.panBy(0, -step),
      '+': () => this.zoomBy(1.4), '=': () => this.zoomBy(1.4), '-': () => this.zoomBy(1 / 1.4),
      0: () => this.fit(), Escape: () => this.handlers.onEscape(),
    };
    if (keys[e.key] && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      keys[e.key]();
    }
  }

  onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.canvas.setPointerCapture(e.pointerId);
    const [x, y] = this.local(e);
    this.pointers.set(e.pointerId, { x, y });
    if (this.pointers.size === 2) {
      // Second finger: switch to pinch zoom.
      const [a, b] = [...this.pointers.values()];
      this.drag = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
      this.lasso = null;
      return;
    }
    const lassoMode = this.tool === 'lasso' || e.shiftKey;
    this.drag = {
      kind: lassoMode ? 'lasso' : 'pan', startX: x, startY: y, lastX: x, lastY: y, moved: 0,
      time: performance.now(), mode: e.altKey ? 'subtract' : e.shiftKey ? 'add' : 'replace',
    };
    if (lassoMode) this.lasso = [x, y];
  }

  onPointerMove(e) {
    const [x, y] = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
    const d = this.drag;
    if (!d) {
      if (e.pointerType !== 'touch') this.setHover(this.nearest(x, y), e.clientX, e.clientY);
      return;
    }
    if (d.kind === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      this.panBy(mid[0] - d.mid[0], mid[1] - d.mid[1]);
      if (d.dist > 0) this.zoomBy(dist / d.dist, mid[0], mid[1]);
      d.dist = dist;
      d.mid = mid;
      return;
    }
    d.moved = Math.max(d.moved, Math.hypot(x - d.startX, y - d.startY));
    if (d.kind === 'pan') {
      if (d.moved > 3) {
        this.panBy(x - d.lastX, y - d.lastY);
        this.setHover(null);
        this.canvas.style.cursor = 'grabbing';
      }
    } else if (Math.hypot(x - d.lastX, y - d.lastY) > 2) {
      this.lasso.push(x, y);
      this.draw();
    }
    d.lastX = x;
    d.lastY = y;
  }

  onPointerUp(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'pinch') {
      if (this.pointers.size === 0) this.drag = null;
      return;
    }
    this.drag = null;
    this.canvas.style.cursor = '';
    const [x, y] = this.local(e);
    if (!cancelled && d.moved <= 4) {
      this.lasso = null;
      const i = this.nearest(x, y);
      this.handlers.onClick(i, { additive: e.shiftKey || e.metaKey || e.ctrlKey });
      this.draw();
      return;
    }
    if (d.kind === 'lasso' && !cancelled && this.lasso && this.lasso.length >= 6) {
      const picked = this.pointsInLasso(this.lasso);
      this.lasso = null;
      this.handlers.onLasso(picked, d.mode);
    }
    this.lasso = null;
    this.draw();
  }
}
