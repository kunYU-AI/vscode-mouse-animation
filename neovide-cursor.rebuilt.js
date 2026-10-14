/*
 * Independent implementation of neovide-cursor-rebuilt.spec.md v1.0.
 * Load ONE cursor script through Custom CSS and JS Loader, then reload the window.
 * Optional pre-injection overrides: window.NEOVIDE_REBUILT_OPTIONS = { ... }.
 * Cleanup: window.__neovideCursorRebuilt.destroy().
 * No settings, external dependencies, network requests or persistent storage.
 */
(() => {
  "use strict";

  const DEFAULTS = Object.freeze({
    color: "#C8D3F5", // "theme" follows --vscode-editorCursor-background
    opacity: 1,
    glow: 4,
    glowColor: "same",
    response: 0.10,
    shortResponse: 0.04,
    trail: 0.75,
    maxStretch: 180,
    maxJump: 500,
    crossEditor: false,
    discoveryMs: 1200,
    respectReducedMotion: true,
  });
  const UNIT_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

  // Pure motion model. Coordinates are CSS pixels; times are milliseconds.
  class Motion {
    constructor(rect, now = 0, options = DEFAULTS) {
      this.options = { ...DEFAULTS, ...options };
      this.points = UNIT_CORNERS.map(() => ({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, omega: 1 }));
      this.reset(rect, now);
    }

    reset(rect, now) {
      this.rect = { ...rect };
      this.time = now;
      this.moving = false;
      this.points.forEach((p, i) => {
        p.x = p.tx = rect.x + UNIT_CORNERS[i][0] * rect.w;
        p.y = p.ty = rect.y + UNIT_CORNERS[i][1] * rect.h;
        p.vx = p.vy = 0;
      });
    }

    target(rect, now, immediate = false) {
      this.advance(now);
      const dx = rect.x - this.rect.x;
      const dy = rect.y - this.rect.y;
      const distance = Math.hypot(dx, dy);
      if (immediate || rect.w !== this.rect.w || rect.h !== this.rect.h || distance > this.options.maxJump) {
        this.reset(rect, now);
        return;
      }
      if (distance < 0.001) return;
      const short = Math.abs(dy) < 0.1 && Math.abs(dx) <= Math.max(16, rect.w * 2);
      const response = short ? this.options.shortResponse : this.options.response;
      this.rect = { ...rect };
      this.points.forEach((p, i) => {
        const [cx, cy] = UNIT_CORNERS[i];
        const alignment = ((2 * cx - 1) * dx + (2 * cy - 1) * dy) / (Math.SQRT2 * distance);
        const lag = (1 - alignment) * 0.5;
        const duration = short ? response : response * (1 - this.options.trail * (1 - lag));
        p.omega = 4 / Math.max(0.005, duration);
        p.tx = rect.x + cx * rect.w;
        p.ty = rect.y + cy * rect.h;
        this.limit(p);
      });
      this.moving = true;
    }

    limit(p) {
      const dx = p.x - p.tx;
      const dy = p.y - p.ty;
      const distance = Math.hypot(dx, dy);
      if (distance > this.options.maxStretch) {
        const scale = this.options.maxStretch / distance;
        p.x = p.tx + dx * scale;
        p.y = p.ty + dy * scale;
        // A deliberate discontinuity only at the configured safety bound.
        p.vx = p.vy = 0;
      }
    }

    advance(now) {
      const dt = Math.max(0, now - this.time) / 1000;
      this.time = Math.max(this.time, now);
      if (!this.moving) return false;
      let settled = true;
      for (const p of this.points) {
        const ex = p.x - p.tx;
        const ey = p.y - p.ty;
        const bx = p.vx + p.omega * ex;
        const by = p.vy + p.omega * ey;
        const decay = Math.exp(-p.omega * dt);
        p.x = p.tx + (ex + bx * dt) * decay;
        p.y = p.ty + (ey + by * dt) * decay;
        p.vx = (p.vx - p.omega * bx * dt) * decay;
        p.vy = (p.vy - p.omega * by * dt) * decay;
        this.limit(p);
        if (Math.hypot(p.x - p.tx, p.y - p.ty) > 0.08 || Math.hypot(p.vx, p.vy) > 0.4) settled = false;
      }
      if (settled) this.reset(this.rect, now);
      return this.moving;
    }
  }

  // The same pure model can be exercised with Node, without a DOM or the adapter.
  if (typeof document === "undefined") {
    if (typeof module !== "undefined") module.exports = { Motion, DEFAULTS };
    return;
  }

  const KEY = "__neovideCursorRebuilt";
  const MARK = "data-nc-rebuilt";
  const SURFACE = "data-nc-surface";
  const NS = "http://www.w3.org/2000/svg";
  const colorValue = color => color === "theme" ? "var(--vscode-editorCursor-background, #C8D3F5)" : color;
  const config = { ...DEFAULTS, ...window.NEOVIDE_REBUILT_OPTIONS };
  for (const [key, low, high] of [
    ["opacity", 0, 1], ["glow", 0, 30], ["response", 0.005, 1],
    ["shortResponse", 0.005, 1], ["trail", 0, 1], ["maxStretch", 1, 2000],
    ["maxJump", 1, 10000], ["discoveryMs", 200, 10000],
  ]) config[key] = Number.isFinite(config[key]) ? Math.max(low, Math.min(high, config[key])) : DEFAULTS[key];
  if (config.color !== "theme" && !CSS.supports("color", config.color)) config.color = DEFAULTS.color;
  if (config.glowColor !== "same" && !CSS.supports("color", config.glowColor)) config.glowColor = "same";
  Object.freeze(config);

  function svg(name, attrs = {}) {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  function ownMutation(record) {
    const owned = node => node.nodeType === 1 && (node.hasAttribute(SURFACE) || !!node.closest(`[${SURFACE}]`));
    if (owned(record.target)) return true;
    return record.type === "childList" && [...record.addedNodes, ...record.removedNodes].every(owned);
  }

  function findOwned(root, selector) {
    return [...root.querySelectorAll(selector)].find(node => node.closest(".monaco-editor") === root);
  }

  class Driver {
    constructor() {
      this.roots = new Map();
      this.abort = new AbortController();
      this.preference = matchMedia("(prefers-reduced-motion: reduce)");
      this.dirty = true;
      this.snap = true;
      this.frame = 0;
      this.timer = 0;
      this.sequence = 0;
      this.composing = false;
      this.disposed = false;
      this.primary = null;
      this.activeRoot = null;
      this.stats = { frames: 0, scans: 0, geometryReads: 0, svgWrites: 0 };
      this.style = document.createElement("style");
      this.style.textContent = `.monaco-editor .cursors-layer > .cursor[${MARK}] {
        background: transparent !important; border-color: transparent !important;
        color: transparent !important; box-shadow: none !important; transition: none !important;
      }`;
      document.head.appendChild(this.style);
      this.bind();
      this.scan();
      this.timer = setInterval(() => this.scan(), config.discoveryMs);
    }

    enabled() {
      return !this.disposed && !document.hidden && document.hasFocus() && !this.composing &&
        !(config.respectReducedMotion && this.preference.matches);
    }

    on(target, event, handler, options = {}) {
      target.addEventListener(event, handler, { ...options, signal: this.abort.signal });
    }

    bind() {
      const refresh = () => this.invalidate();
      const reposition = event => {
        // Focusing Monaco's tiny hidden textarea may scroll its own contents.
        // That does not move the editor viewport or its visible carets.
        if (event?.type === "scroll" && event.target instanceof Element &&
            event.target.matches("textarea, input")) return;
        this.invalidate(true);
      };
      this.on(document, "focusin", () => this.scan(), { capture: true });
      this.on(document, "focusout", refresh, { capture: true });
      for (const event of ["keydown", "input", "pointerdown", "pointerup"])
        this.on(document, event, refresh, { capture: true, passive: true });
      for (const event of ["scroll", "wheel"])
        this.on(document, event, reposition, { capture: true, passive: true });
      this.on(window, "resize", reposition);
      this.on(window, "blur", () => this.pause());
      this.on(window, "focus", () => { this.snap = true; this.scan(); });
      this.on(document, "visibilitychange", () => document.hidden ? this.pause() : this.scan());
      this.on(document, "compositionstart", () => { this.composing = true; this.pause(); }, { capture: true });
      this.on(document, "compositionend", () => { this.composing = false; this.scan(); }, { capture: true });
      this.on(this.preference, "change", () => { this.pause(); this.scan(); });
      this.on(window, "pagehide", () => this.destroy());
    }

    request() {
      if (!this.frame && this.enabled()) this.frame = requestAnimationFrame(now => this.render(now));
    }

    invalidate(snap = false) {
      this.dirty = true;
      this.snap ||= snap;
      this.request();
    }

    scan() {
      if (!this.enabled()) return;
      this.stats.scans++;
      for (const [root, entry] of this.roots) {
        if (!root.isConnected || !entry.viewport.isConnected) {
          this.removeRoot(entry);
          this.roots.delete(root);
        }
      }
      for (const root of document.querySelectorAll(".monaco-editor")) {
        if (this.roots.has(root)) continue;
        const viewport = findOwned(root, ".monaco-scrollable-element");
        if (!viewport) continue;
        const entry = { root, viewport, surfaces: new Map(), bounds: null };
        entry.observer = new MutationObserver(records => {
          const relevant = records.filter(record => !ownMutation(record));
          if (!relevant.length) return;
          const scrolling = relevant.some(record => record.type === "attributes" &&
            record.attributeName === "style" && record.target.matches(".view-lines, .lines-content"));
          this.invalidate(scrolling);
        });
        entry.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
        entry.resize = new ResizeObserver(() => this.invalidate(true));
        entry.resize.observe(root);
        entry.resize.observe(viewport);
        this.roots.set(root, entry);
      }
      this.invalidate();
    }

    rect(node) {
      this.stats.geometryReads++;
      return node.getBoundingClientRect();
    }

    read(entry) {
      const focused = document.activeElement?.closest(".monaco-editor") === entry.root;
      const viewport = this.rect(entry.viewport);
      const signature = [viewport.left, viewport.top, viewport.width, viewport.height].join(",");
      const layout = entry.bounds !== null && entry.bounds !== signature;
      const layers = [];
      if (focused) for (const layer of entry.root.querySelectorAll(".cursors-layer")) {
        if (layer.closest(".monaco-editor") !== entry.root) continue;
        const bounds = this.rect(layer);
        const expanded = layer.classList.contains("cursor-expand");
        const samples = [];
        for (const target of layer.children) {
          if (!target.classList.contains("cursor")) continue;
          const style = getComputedStyle(target);
          const box = this.rect(target);
          const valid = !expanded && style.display !== "none" && style.visibility === "visible" &&
            box.width > 0 && box.height > 0 && viewport.width > 0 && viewport.height > 0 &&
            box.right > viewport.left && box.left < viewport.right && box.bottom > viewport.top && box.top < viewport.bottom &&
            box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight;
          let h = box.height;
          let top = box.top;
          const underline = layer.classList.contains("cursor-underline-style") || layer.classList.contains("cursor-underline-thin-style");
          if (underline) {
            h = Math.min(box.height, parseFloat(style.borderBottomWidth) || 1);
            top = box.bottom - h;
          }
          samples.push({ target, valid, opacity: parseFloat(style.opacity),
            outline: layer.classList.contains("cursor-block-outline-style"),
            rect: { x: box.left - bounds.left, y: top - bounds.top, w: box.width, h },
            screen: { x: box.left, y: top, w: box.width, h },
          });
        }
        layers.push({ layer, bounds, samples, clip: {
          x: viewport.left - bounds.left, y: viewport.top - bounds.top,
          width: viewport.width, height: viewport.height,
        } });
      }
      return { entry, focused, signature, layout, layers };
    }

    surface(entry, layer) {
      let surface = entry.surfaces.get(layer);
      if (surface && surface.svg.parentNode === layer) return surface;
      if (surface) this.removeSurface(surface);
      const id = `nc-rebuilt-clip-${++this.sequence}`;
      const element = svg("svg", { [SURFACE]: "", width: "1", height: "1", "aria-hidden": "true" });
      element.style.cssText = "position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:1;";
      const defs = svg("defs");
      const clipping = svg("clipPath", { id, clipPathUnits: "userSpaceOnUse" });
      const clip = svg("rect");
      const group = svg("g", { "clip-path": `url(#${id})` });
      clipping.appendChild(clip);
      defs.appendChild(clipping);
      element.append(defs, group);
      layer.appendChild(element);
      surface = { svg: element, clip, group, items: new Map() };
      entry.surfaces.set(layer, surface);
      return surface;
    }

    attr(node, key, value) {
      const text = String(value);
      if (node.getAttribute(key) !== text) {
        node.setAttribute(key, text);
        this.stats.svgWrites++;
      }
    }

    release(surface, target) {
      const item = surface.items.get(target);
      if (!item) return;
      target.removeAttribute(MARK);
      item.shape.remove();
      surface.items.delete(target);
    }

    apply(batches, now, immediate) {
      const active = batches.find(batch => batch.focused);
      const visible = active?.layers.flatMap(layer => layer.samples.filter(sample => sample.valid)) || [];
      const inherited = config.crossEditor && !immediate && active && active.entry.root !== this.activeRoot &&
        visible.length === 1 && this.primary && this.roots.has(this.activeRoot) ? this.primary : null;
      for (const batch of batches) {
        const { entry, layers } = batch;
        entry.bounds = batch.signature;
        const present = new Set(layers.map(layer => layer.layer));
        for (const [layer, surface] of entry.surfaces) if (!present.has(layer)) {
          this.removeSurface(surface);
          entry.surfaces.delete(layer);
        }
        for (const data of layers) {
          const surface = this.surface(entry, data.layer);
          for (const [key, value] of Object.entries(data.clip)) this.attr(surface.clip, key, value);
          const seen = new Set();
          for (const sample of data.samples) {
            if (!sample.valid) { this.release(surface, sample.target); continue; }
            seen.add(sample.target);
            let item = surface.items.get(sample.target);
            if (!item) {
              const shape = svg("polygon");
              if (config.glow) shape.style.filter = `drop-shadow(0px 0px ${config.glow}px ${colorValue(config.glowColor === "same" ? config.color : config.glowColor)})`;
              const origin = inherited ? {
                x: inherited.x - data.bounds.left, y: inherited.y - data.bounds.top,
                w: sample.rect.w, h: sample.rect.h,
              } : sample.rect;
              item = { shape, motion: new Motion(origin, now, config), outline: sample.outline };
              surface.group.appendChild(shape);
              surface.items.set(sample.target, item);
              sample.target.setAttribute(MARK, "");
              // Scoped CSS may stop an existing native transition; resample once.
              this.dirty = true;
            }
            item.motion.target(sample.rect, now, immediate || batch.layout || item.outline !== sample.outline);
            item.outline = sample.outline;
            this.attr(item.shape, "fill", sample.outline ? "none" : colorValue(config.color));
            this.attr(item.shape, "stroke", sample.outline ? colorValue(config.color) : "none");
            this.attr(item.shape, "stroke-width", sample.outline ? 1 : 0);
            this.attr(item.shape, "opacity", config.opacity * (Number.isFinite(sample.opacity) ? sample.opacity : 1));
          }
          for (const target of surface.items.keys()) if (!seen.has(target)) this.release(surface, target);
        }
      }
      this.activeRoot = active?.entry.root || null;
      this.primary = visible.length === 1 ? visible[0].screen : null;
    }

    render(now) {
      this.frame = 0;
      if (!this.enabled()) { this.pause(); return; }
      this.stats.frames++;
      try {
        if (this.dirty) {
          const immediate = this.snap;
          this.dirty = this.snap = false;
          // All geometry reads precede ownership, SVG and stylesheet-related writes.
          const batches = [...this.roots.values()].map(entry => this.read(entry));
          this.apply(batches, now, immediate);
        }
        let moving = false;
        for (const entry of this.roots.values()) for (const surface of entry.surfaces.values()) {
          for (const item of surface.items.values()) {
            moving = item.motion.advance(now) || moving;
            const points = item.motion.points.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(" ");
            this.attr(item.shape, "points", points);
          }
        }
        if (moving || this.dirty) this.request();
      } catch (error) {
        // Fail open to the native caret if the private platform contract changes.
        console.warn("Neovide cursor rebuilt stopped; native cursors restored.", error);
        this.destroy();
      }
    }

    removeSurface(surface) {
      for (const target of [...surface.items.keys()]) this.release(surface, target);
      surface.svg.remove();
    }

    removeRoot(entry) {
      entry.observer.disconnect();
      entry.resize.disconnect();
      for (const surface of entry.surfaces.values()) this.removeSurface(surface);
      entry.surfaces.clear();
    }

    pause() {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.dirty = this.snap = true;
      this.primary = this.activeRoot = null;
      for (const entry of this.roots.values()) {
        for (const surface of entry.surfaces.values()) this.removeSurface(surface);
        entry.surfaces.clear();
      }
    }

    destroy() {
      if (this.disposed) return;
      this.disposed = true;
      this.abort.abort();
      clearInterval(this.timer);
      this.pause();
      for (const entry of this.roots.values()) this.removeRoot(entry);
      this.roots.clear();
      this.style.remove();
    }
  }

  window[KEY]?.destroy();
  let driver = null;
  let cancelled = false;
  const start = () => {
    if (!cancelled) driver = new Driver();
  };
  const api = {
    config,
    getStats: () => ({ ...driver?.stats, editors: driver?.roots.size || 0 }),
    destroy() {
      cancelled = true;
      document.removeEventListener("DOMContentLoaded", start);
      driver?.destroy();
      if (window[KEY] === api) delete window[KEY];
    },
  };
  window[KEY] = api;
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
