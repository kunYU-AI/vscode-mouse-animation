/*
 * Neovide-style cursor trail for Custom CSS and JS Loader.
 * Load this file INSTEAD OF the original, then reload Custom CSS and JS
 * and restart the VS Code window. This file does not edit editor settings.
 *
 * Native cursors remain visible. Only the moving trail is drawn; at rest,
 * VS Code owns cursor blinking, selection, IME and accessibility behavior.
 * Depends on private Monaco DOM classes: recheck after VS Code updates.
 * Console cleanup: window.__neovideCursorOptimized?.destroy()
 */
(() => {
  "use strict";

  const CONFIG = Object.freeze({
    color: "#C8D3F5", // "default" follows the editor cursor theme color
    animationLength: 0.10, // spring response in seconds, NOT total settle time
    shortAnimationLength: 0.04,
    trailSize: 0.75, // 0..1; original used 1
    opacity: 0.65, // translucent overlay; native cursor marks the exact endpoint
    shadowBlur: 4, // 0 disables glow; original used 10
    maxJump: 400, // CSS px; longer jumps snap instead of stretching across text
    maxDpr: 2, // cap memory cost; raise for displays above 200% scale if wanted
    discoveryInterval: 1500, // fallback for newly created editor DOM
    respectReducedMotion: true,
  });

  const KEY = "__neovideCursorOptimized";
  window[KEY]?.destroy();
  const controller = new AbortController();
  const editors = new Map();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  let frameId = 0;
  let timerId = 0;
  let disposed = false;
  let composing = false;
  let forceSnap = true;
  let metricsDirty = true;

  function enabled() {
    return !document.hidden && document.hasFocus() && !composing &&
      !(CONFIG.respectReducedMotion && reducedMotion.matches);
  }

  function requestFrame() {
    if (!disposed && !frameId && enabled()) frameId = requestAnimationFrame(render);
  }

  function invalidate(snap = false) {
    metricsDirty = true;
    forceSnap ||= snap;
    requestFrame();
  }

  function clear(editor) {
    if (editor.painted) {
      editor.ctx.clearRect(0, 0, editor.width, editor.height);
      editor.painted = false;
    }
  }

  function pause() {
    cancelAnimationFrame(frameId);
    frameId = 0;
    forceSnap = true;
    metricsDirty = true;
    for (const editor of editors.values()) {
      clear(editor);
      editor.cursors.clear();
    }
  }

  function listen(target, event, handler, options = {}) {
    target.addEventListener(event, handler, { ...options, signal: controller.signal });
  }

  function discover() {
    if (disposed || !enabled()) return;
    for (const [element, editor] of editors) {
      if (!element.isConnected || !editor.host.isConnected ||
          !editor.viewport.isConnected || !editor.canvas.isConnected) {
        editor.observer.disconnect();
        editor.resizeObserver.disconnect();
        editor.canvas.remove();
        editors.delete(element);
      }
    }
    for (const element of document.querySelectorAll(".monaco-editor")) {
      if (editors.has(element)) continue;
      const host = element.querySelector(".overflow-guard");
      const viewport = host?.querySelector(".monaco-scrollable-element");
      if (!host || !viewport || host.closest(".monaco-editor") !== element) continue;
      const canvas = document.createElement("canvas");
      canvas.dataset.neovideOptimized = "true";
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:5;";
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      host.appendChild(canvas);
      const editor = {
        element, host, viewport, canvas, ctx, cursors: new Map(),
        width: 0, height: 0, dpr: 0, painted: false, clip: null,
      };
      editor.observer = new MutationObserver(records => {
        // Ignore our own canvas sizing; never write to Monaco cursor nodes.
        const changes = records.filter(record => record.target !== canvas);
        if (changes.length) invalidate(changes.some(record =>
          record.type === "attributes" && record.attributeName === "style" &&
          record.target.matches(".lines-content, .view-lines")));
      });
      editor.observer.observe(element, {
        subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"],
      });
      editor.resizeObserver = new ResizeObserver(() => invalidate(true));
      editor.resizeObserver.observe(host);
      editor.resizeObserver.observe(viewport);
      editors.set(element, editor);
    }
    // Low-frequency safety net for ancestor layout/focus changes with no cursor mutation.
    invalidate();
  }

  function cssColor(computed) {
    const value = CONFIG.color === "default"
      ? computed.getPropertyValue("--vscode-editorCursor-background").trim()
      : CONFIG.color;
    // Let Canvas parse CSS rgb(), hsl(), #RGBA and #RRGGBBAA correctly.
    return value && CSS.supports("color", value) ? value : "#C8D3F5";
  }

  function readEditor(editor) {
    const rect = editor.host.getBoundingClientRect();
    const view = editor.viewport.getBoundingClientRect();
    const previous = editor.hostRect;
    const layoutMoved = !previous || ["left", "top", "width", "height"].some(k => previous[k] !== rect[k]);
    editor.hostRect = rect;
    const computed = getComputedStyle(editor.element);
    const active = document.activeElement?.closest(".monaco-editor") === editor.element;
    const visible = rect.width > 0 && rect.height > 0 &&
      rect.bottom > 0 && rect.right > 0 && rect.left < innerWidth && rect.top < innerHeight &&
      computed.visibility !== "hidden" && computed.display !== "none";
    const clip = {
      left: Math.max(0, view.left - rect.left), top: Math.max(0, view.top - rect.top),
      right: Math.min(rect.width, view.right - rect.left),
      bottom: Math.min(rect.height, view.bottom - rect.top),
    };
    const samples = [];
    if (visible && active) {
      for (const target of editor.element.querySelectorAll(".cursors-layer .cursor")) {
        if (target.closest(".monaco-editor") !== editor.element) continue;
        const style = getComputedStyle(target);
        const box = target.getBoundingClientRect();
        // An ancestor cursors-layer may be transparent during native blinking.
        // Geometry is still tracked; only actual movement starts a trail.
        if (style.visibility === "hidden" || style.display === "none" ||
            box.width <= 0 || box.height <= 0) continue;
        const x = box.left - rect.left;
        const y = box.top - rect.top;
        if (x + box.width <= clip.left || y + box.height <= clip.top ||
            x >= clip.right || y >= clip.bottom) continue;
        samples.push({ target, x, y, width: box.width, height: box.height });
      }
    }
    return { editor, rect, clip, samples, layoutMoved, color: cssColor(computed) };
  }

  function snap(state, sample) {
    Object.assign(state, sample);
    state.points = corners.map(([x, y]) => ({
      x: sample.x + x * sample.width, y: sample.y + y * sample.height,
    }));
    state.motion = null;
  }

  function retarget(state, sample, now, immediate) {
    const dx = sample.x - state.x;
    const dy = sample.y - state.y;
    const distance = Math.hypot(dx, dy);
    const resized = sample.width !== state.width || sample.height !== state.height;
    if (immediate || resized || distance > CONFIG.maxJump) {
      snap(state, sample);
      return;
    }
    if (distance < 0.01) return;
    const short = Math.abs(dy) < 0.1 && Math.abs(dx) <= Math.max(sample.width * 2, 16);
    const duration = short ? CONFIG.shortAnimationLength : CONFIG.animationLength;
    state.motion = corners.map(([x, y], i) => {
      const alignment = ((x * 2 - 1) * dx + (y * 2 - 1) * dy) / (distance * Math.SQRT2);
      const lag = (1 - alignment) / 2;
      const response = short ? duration : duration * (1 - CONFIG.trailSize * (1 - lag));
      return {
        x: state.points[i].x, y: state.points[i].y,
        tx: sample.x + x * sample.width, ty: sample.y + y * sample.height,
        omega: 4 / Math.max(response, 0.001),
      };
    });
    Object.assign(state, sample);
    state.started = now;
  }

  function advance(state, now) {
    if (!state.motion) return false;
    const elapsed = Math.max(0, (now - state.started) / 1000);
    let remaining = 0;
    state.motion.forEach((motion, i) => {
      // Closed-form critically damped spring: independent of display refresh rate.
      const t = motion.omega * elapsed;
      const decay = (1 + t) * Math.exp(-t);
      const x = (motion.x - motion.tx) * decay;
      const y = (motion.y - motion.ty) * decay;
      state.points[i].x = motion.tx + x;
      state.points[i].y = motion.ty + y;
      remaining = Math.max(remaining, Math.abs(x), Math.abs(y));
    });
    state.fade = Math.min(1, remaining / 2);
    if (remaining < 0.1) {
      snap(state, state);
      return false;
    }
    return true;
  }

  function applySamples(batch, now) {
    const { editor, rect, clip, samples, layoutMoved, color } = batch;
    const dpr = Math.min(devicePixelRatio || 1, CONFIG.maxDpr);
    if (editor.width !== rect.width || editor.height !== rect.height || editor.dpr !== dpr) {
      editor.width = rect.width;
      editor.height = rect.height;
      editor.dpr = dpr;
      editor.canvas.width = Math.max(1, Math.ceil(rect.width * dpr));
      editor.canvas.height = Math.max(1, Math.ceil(rect.height * dpr));
      editor.canvas.style.width = `${rect.width}px`;
      editor.canvas.style.height = `${rect.height}px`;
      editor.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      editor.painted = false;
    }
    editor.clip = clip;
    editor.color = color;
    const seen = new Set();
    for (const sample of samples) {
      seen.add(sample.target);
      let state = editor.cursors.get(sample.target);
      if (!state) {
        state = {};
        snap(state, sample);
        editor.cursors.set(sample.target, state);
      } else {
        advance(state, now); // Retarget from the currently displayed shape.
        retarget(state, sample, now, forceSnap || layoutMoved);
      }
    }
    for (const target of editor.cursors.keys()) {
      if (!seen.has(target)) editor.cursors.delete(target);
    }
  }

  function draw(editor, now) {
    clear(editor);
    const moving = [];
    for (const state of editor.cursors.values()) if (advance(state, now)) moving.push(state);
    if (!moving.length || !editor.clip) return false;
    const { ctx, clip } = editor;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.left, clip.top, Math.max(0, clip.right - clip.left), Math.max(0, clip.bottom - clip.top));
    ctx.clip();
    ctx.fillStyle = editor.color;
    ctx.shadowColor = editor.color;
    ctx.shadowBlur = CONFIG.shadowBlur * editor.dpr;
    for (const state of moving) {
      ctx.globalAlpha = CONFIG.opacity * state.fade;
      ctx.beginPath();
      state.points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    editor.painted = true;
    return true;
  }

  function render(now) {
    frameId = 0;
    if (disposed || !enabled()) { pause(); return; }
    if (metricsDirty) {
      // Read every editor first, then write canvas sizes to avoid read/write interleaving.
      const batches = [...editors.values()].map(readEditor);
      for (const batch of batches) applySamples(batch, now);
      metricsDirty = false;
      forceSnap = false;
    }
    let animating = false;
    for (const editor of editors.values()) animating = draw(editor, now) || animating;
    if (animating) requestFrame();
  }

  function start() {
    if (disposed) return;
    discover();
    timerId = setInterval(discover, CONFIG.discoveryInterval);
    listen(document, "focusin", () => { discover(); invalidate(true); }, { capture: true });
    listen(document, "focusout", () => invalidate(true), { capture: true });
    listen(document, "keydown", () => invalidate(), { capture: true });
    listen(document, "pointerdown", () => invalidate(), { capture: true, passive: true });
    listen(document, "input", () => invalidate(), { capture: true });
    // Monaco often scrolls with transforms rather than native DOM scrolling.
    // Wheel/scroll snap; cursor auto-reveal also triggers observed style changes.
    listen(document, "wheel", () => invalidate(true), { capture: true, passive: true });
    listen(document, "scroll", () => invalidate(true), { capture: true, passive: true });
    listen(window, "resize", () => invalidate(true));
    listen(window, "blur", pause);
    listen(window, "focus", () => { discover(); invalidate(true); });
    listen(document, "visibilitychange", () => document.hidden ? pause() : discover());
    listen(document, "compositionstart", () => { composing = true; pause(); }, { capture: true });
    listen(document, "compositionend", () => { composing = false; invalidate(true); }, { capture: true });
    listen(reducedMotion, "change", () => { pause(); discover(); });
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    clearInterval(timerId);
    pause();
    for (const editor of editors.values()) {
      editor.observer.disconnect();
      editor.resizeObserver.disconnect();
      editor.canvas.remove();
    }
    editors.clear();
    if (window[KEY]?.destroy === destroy) delete window[KEY];
  }

  window[KEY] = { destroy, config: CONFIG };
  if (document.body) start();
  else listen(document, "DOMContentLoaded", start, { once: true });
})();
