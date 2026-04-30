/**
 * Synthetic cursor overlay injected into the page when `--video` is on.
 *
 * Playwright's `recordVideo` captures page content but NOT the OS cursor (the cursor lives
 * outside the page in browser chrome). To make videos legible, we inject a small JS overlay
 * that listens for dispatched mousemove/mousedown/mouseup events and renders a synthetic
 * cursor that tracks every move/click the test makes.
 *
 * Independent reimplementation — no source code is borrowed from FSL-licensed projects.
 * Vanilla JS, Shadow DOM isolation, ~300 lines, ~1ms attach cost.
 *
 * Public API on `window.__skepticCursor`:
 *   - hide()                 Toggle visibility off (used before screenshots).
 *   - show()                 Toggle visibility on.
 *   - isVisible()            Boolean — current visibility.
 *   - setCommandLabel(name, opts?) Show a tooltip near the cursor with the command name.
 *                            Tooltip auto-fades after ~1.5 s by default. Pass
 *                            `{ persistent: true }` to pin until cleared (used for
 *                            long-running ops like accessibility audits). Pass commandName
 *                            ONLY — never args — PII safety.
 *   - clearCommandLabel()    Hide the tooltip immediately and cancel any pending fade
 *                            timer. Paired with setCommandLabel inside runAction's
 *                            try/finally so the tooltip never gets stuck on a thrown step.
 *   - recordAction(name, x?, y?)
 *                            Drop a numbered action marker at (x, y). Coords default to
 *                            page center if omitted. Action log capped at 50 entries (FIFO).
 *
 * Five cursor shapes are switched dynamically based on the underlying element's computed
 * `cursor` style (pointer / text / grab / move / not-allowed). Shape detection is
 * debounced ~50 ms; cursor position is persisted to sessionStorage (debounced ~500 ms)
 * so it survives same-origin navigations.
 */
// Module-scope mirrors of constants the inline CSS template needs at host-time
// substitution (the inner IIFE redeclares them so the browser-side code keeps a
// stable reference). Without these, `String.raw` would dereference an undefined
// host symbol when the engine imports this file.
const MARKER_FADE_MS = 2000;

export const CURSOR_OVERLAY_SOURCE = String.raw`
(() => {
  if (window.__skepticCursor) return;

  const HOST_ID = '__skeptic-cursor-host';
  const STORAGE_KEY = '__skeptic_cursor_state';
  const PERSIST_DEBOUNCE_MS = 500;
  const SHAPE_DEBOUNCE_MS = 50;
  const TOOLTIP_FADE_MS = 1500;
  const MARKER_FADE_MS = ${MARKER_FADE_MS};
  const MAX_ACTIONS = 50;

  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    if (document.body) document.body.appendChild(host);
    else document.addEventListener('DOMContentLoaded', () => document.body && document.body.appendChild(host), { once: true });
  }

  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = ` + "`" + `
    <style>
      :host { all: initial; }
      #cursor {
        position: fixed; left: 0; top: 0; width: 24px; height: 24px;
        transform: translate(-100px, -100px);
        pointer-events: none;
        will-change: transform;
        filter: drop-shadow(0 0 6px rgba(80, 160, 250, 0.55))
                drop-shadow(0 0 12px rgba(80, 160, 250, 0.25));
      }
      #cursor.glow { animation: __skeptic-glow 2s ease-in-out infinite; }
      #cursor.hidden, #ripple.hidden, #tooltip.hidden { visibility: hidden; }
      #cursor.click > .shape { animation: __skeptic-click 280ms ease-out; }
      .shape { width: 100%; height: 100%; display: block; }
      #ripple {
        position: fixed; left: 0; top: 0; width: 8px; height: 8px;
        border-radius: 50%; pointer-events: none;
        background: radial-gradient(circle, rgba(80,160,250,0.5) 0%, rgba(80,160,250,0) 70%);
        transform: translate(-50%, -50%) scale(0); opacity: 0;
      }
      #ripple.fire { animation: __skeptic-ripple 480ms ease-out; }
      #tooltip {
        position: fixed; left: 0; top: 0;
        padding: 4px 8px; border-radius: 6px;
        background: rgba(20, 28, 48, 0.92); color: #e5f1ff;
        font: 500 11px/1 -apple-system, system-ui, sans-serif;
        white-space: nowrap; pointer-events: none;
        transform: translate(0, 0); opacity: 0;
        transition: opacity 200ms ease-out;
      }
      #tooltip.show { opacity: 1; }
      .marker {
        position: fixed; left: 0; top: 0;
        width: 22px; height: 22px; border-radius: 50%;
        background: rgba(80, 160, 250, 0.92); color: white;
        font: 600 11px/22px -apple-system, system-ui, sans-serif;
        text-align: center; pointer-events: none;
        transform: translate(-50%, -50%) scale(1); opacity: 1;
        animation: __skeptic-marker ${MARKER_FADE_MS}ms ease-out forwards;
        box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85), 0 2px 6px rgba(0, 0, 0, 0.25);
      }
      @keyframes __skeptic-click {
        0% { transform: scale(1); }
        40% { transform: scale(0.78); }
        100% { transform: scale(1); }
      }
      @keyframes __skeptic-ripple {
        0% { transform: translate(-50%, -50%) scale(0.4); opacity: 0.85; }
        100% { transform: translate(-50%, -50%) scale(8); opacity: 0; }
      }
      @keyframes __skeptic-glow {
        0%, 100% {
          filter: drop-shadow(0 0 4px rgba(80, 160, 250, 0.45))
                  drop-shadow(0 0 8px rgba(80, 160, 250, 0.18));
        }
        50% {
          filter: drop-shadow(0 0 9px rgba(80, 160, 250, 0.78))
                  drop-shadow(0 0 18px rgba(80, 160, 250, 0.34));
        }
      }
      @keyframes __skeptic-marker {
        0% { transform: translate(-50%, -50%) scale(0.6); opacity: 0; }
        15% { transform: translate(-50%, -50%) scale(1.05); opacity: 1; }
        70% { opacity: 1; }
        100% { transform: translate(-50%, -50%) scale(1.2); opacity: 0; }
      }
    </style>
    <div id="cursor" class="glow">
      <svg class="shape" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M3 2.5 L3 18 L7.2 14 L9.6 19.5 L12 18.5 L9.7 13 L15 13 Z"
              fill="rgba(80,160,250,0.95)"
              stroke="white" stroke-width="1.2" stroke-linejoin="round"/>
      </svg>
    </div>
    <div id="ripple"></div>
    <div id="tooltip" class="hidden"></div>
  ` + "`" + `;

  const cursorEl = root.getElementById('cursor');
  const rippleEl = root.getElementById('ripple');
  const tooltipEl = root.getElementById('tooltip');

  // Five inline-SVG cursor shapes drawn from scratch. Coords are in a 24x24 viewBox.
  const SHAPES = {
    pointer:
      '<svg class="shape" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M3 2.5 L3 18 L7.2 14 L9.6 19.5 L12 18.5 L9.7 13 L15 13 Z" ' +
              'fill="rgba(80,160,250,0.95)" stroke="white" stroke-width="1.2" stroke-linejoin="round"/>' +
      '</svg>',
    text:
      '<svg class="shape" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M9 4 H15 M12 4 V20 M9 20 H15" ' +
              'stroke="rgba(80,160,250,0.95)" stroke-width="2" stroke-linecap="round" fill="none"/>' +
        '<path d="M9 4 H15 M12 4 V20 M9 20 H15" ' +
              'stroke="white" stroke-width="0.6" stroke-linecap="round" fill="none"/>' +
      '</svg>',
    grab:
      '<svg class="shape" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M7 12 V8 a1.4 1.4 0 0 1 2.8 0 V12 ' +
                 'M9.8 12 V6.5 a1.4 1.4 0 0 1 2.8 0 V12 ' +
                 'M12.6 12 V7 a1.4 1.4 0 0 1 2.8 0 V13 ' +
                 'M15.4 13 V9 a1.4 1.4 0 0 1 2.6 0 V15 ' +
                 'a5 5 0 0 1 -10 0 V11" ' +
              'fill="rgba(80,160,250,0.95)" stroke="white" stroke-width="1" stroke-linejoin="round"/>' +
      '</svg>',
    move:
      '<svg class="shape" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M12 2 L9 6 H11 V11 H6 V9 L2 12 L6 15 V13 H11 V18 H9 L12 22 L15 18 H13 V13 H18 V15 L22 12 L18 9 V11 H13 V6 H15 Z" ' +
              'fill="rgba(80,160,250,0.95)" stroke="white" stroke-width="1" stroke-linejoin="round"/>' +
      '</svg>',
    'not-allowed':
      '<svg class="shape" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="8" fill="none" stroke="rgba(80,160,250,0.95)" stroke-width="2.4"/>' +
        '<line x1="6.5" y1="6.5" x2="17.5" y2="17.5" stroke="rgba(80,160,250,0.95)" stroke-width="2.4" stroke-linecap="round"/>' +
        '<circle cx="12" cy="12" r="8" fill="none" stroke="white" stroke-width="0.6"/>' +
      '</svg>',
  };

  let visible = true;
  let lastX = -100, lastY = -100;
  let pending = false;
  let currentShape = 'pointer';

  // Try to restore last cursor position from sessionStorage. Coordinates are normalized
  // to [0,1] relative to viewport so they scale on resize/zoom across navigations.
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.relativeX === 'number' && typeof parsed.relativeY === 'number') {
        lastX = Math.max(0, Math.min(1, parsed.relativeX)) * window.innerWidth;
        lastY = Math.max(0, Math.min(1, parsed.relativeY)) * window.innerHeight;
        cursorEl.style.transform = 'translate(' + (lastX - 2) + 'px, ' + (lastY - 2) + 'px)';
      }
    }
  } catch { /* sessionStorage may be disabled in sandboxed iframes */ }

  const moveCursor = () => {
    pending = false;
    cursorEl.style.transform = 'translate(' + (lastX - 2) + 'px, ' + (lastY - 2) + 'px)';
    // Tooltip default: above-and-right of the cursor. When the tooltip would clip the
    // viewport's right edge, render to the LEFT of the cursor; when it would clip the
    // bottom (cursor near top of viewport), render BELOW the cursor instead. Independent
    // design — common UI flip-pattern, not derived from any reference codebase. Keeps
    // the persistent narration tooltip readable when the cursor is near a screen edge.
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const tw = tooltipEl.offsetWidth || 200;
    const th = tooltipEl.offsetHeight || 22;
    let tx = lastX + 14;
    if (tx + tw > vw - 4) tx = lastX - 14 - tw;
    if (tx < 2) tx = 2;
    let ty = lastY - th - 4;
    if (ty < 2) ty = lastY + 18;
    if (ty + th > vh - 2) ty = Math.max(2, vh - th - 2);
    tooltipEl.style.transform = 'translate(' + tx + 'px, ' + ty + 'px)';
  };

  let persistTimer = 0;
  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = window.setTimeout(() => {
      persistTimer = 0;
      try {
        const w = window.innerWidth || 1;
        const h = window.innerHeight || 1;
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
          relativeX: lastX / w,
          relativeY: lastY / h,
        }));
      } catch { /* swallow — storage may be denied */ }
    }, PERSIST_DEBOUNCE_MS);
  };

  const setShape = (shape) => {
    if (shape === currentShape) return;
    if (!SHAPES[shape]) shape = 'pointer';
    currentShape = shape;
    // Replace inline SVG; preserve existing classes (glow, click).
    const existing = cursorEl.querySelector('.shape');
    if (existing) existing.remove();
    cursorEl.insertAdjacentHTML('afterbegin', SHAPES[shape]);
  };

  const computedToShape = (computed) => {
    if (!computed) return 'pointer';
    const v = computed.split(',')[0].trim();
    if (v === 'pointer') return 'pointer';
    if (v === 'text' || v === 'vertical-text') return 'text';
    if (v === 'grab' || v === 'grabbing') return 'grab';
    if (v === 'move' || v === 'all-scroll') return 'move';
    if (v === 'not-allowed' || v === 'no-drop') return 'not-allowed';
    return 'pointer';
  };

  let shapeTimer = 0;
  const scheduleShapeDetect = () => {
    if (shapeTimer) return;
    shapeTimer = window.setTimeout(() => {
      shapeTimer = 0;
      try {
        const el = document.elementFromPoint(lastX, lastY);
        if (!el) { setShape('pointer'); return; }
        const c = window.getComputedStyle(el).cursor;
        setShape(computedToShape(c));
      } catch { /* document may not support elementFromPoint in some contexts */ }
    }, SHAPE_DEBOUNCE_MS);
  };

  const onMove = (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (!pending) {
      pending = true;
      requestAnimationFrame(moveCursor);
    }
    schedulePersist();
    scheduleShapeDetect();
  };

  const onDown = () => {
    cursorEl.classList.remove('click');
    void cursorEl.offsetWidth;
    cursorEl.classList.add('click');
    rippleEl.style.left = lastX + 'px';
    rippleEl.style.top = lastY + 'px';
    rippleEl.classList.remove('fire');
    void rippleEl.offsetWidth;
    rippleEl.classList.add('fire');
  };

  document.addEventListener('mousemove', onMove, { capture: true, passive: true });
  document.addEventListener('mousedown', onDown, { capture: true, passive: true });

  // Action log: numbered markers at (x, y). FIFO cap at MAX_ACTIONS so a runaway loop
  // never balloons the DOM.
  const actionLog = [];
  let actionCounter = 0;

  const recordAction = (commandName, x, y) => {
    if (typeof commandName !== 'string' || commandName.length === 0) return;
    actionCounter += 1;
    if (actionLog.length >= MAX_ACTIONS) actionLog.shift();
    const entry = {
      n: actionCounter,
      command: commandName,
      x: typeof x === 'number' && isFinite(x) ? x : Math.round(window.innerWidth / 2),
      y: typeof y === 'number' && isFinite(y) ? y : Math.round(window.innerHeight / 2),
    };
    actionLog.push(entry);
    const marker = document.createElement('div');
    marker.className = 'marker';
    marker.style.transform = 'translate(' + entry.x + 'px, ' + entry.y + 'px)';
    marker.textContent = String(entry.n);
    root.appendChild(marker);
    window.setTimeout(() => marker.remove(), MARKER_FADE_MS + 50);
  };

  let tooltipTimer = 0;
  const setCommandLabel = (commandName, opts) => {
    if (typeof commandName !== 'string') return;
    // PII safety: caller is responsible for passing only the command NAME, never args.
    // Sentence-form labels (e.g. "Running accessibility audit") run longer than terse
    // command names, so cap at 80 chars.
    const safe = commandName.length > 80 ? commandName.slice(0, 80) : commandName;
    tooltipEl.textContent = safe;
    tooltipEl.classList.remove('hidden');
    tooltipEl.classList.add('show');
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = 0; }
    // Re-position immediately so the new text width feeds into the viewport-edge flip.
    if (!pending) { pending = true; requestAnimationFrame(moveCursor); }
    const persistent = !!(opts && opts.persistent === true);
    if (!persistent) {
      tooltipTimer = window.setTimeout(() => {
        tooltipTimer = 0;
        tooltipEl.classList.remove('show');
      }, TOOLTIP_FADE_MS);
    }
  };

  const clearCommandLabel = () => {
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = 0; }
    tooltipEl.classList.remove('show');
    tooltipEl.textContent = '';
  };

  window.__skepticCursor = {
    hide: () => {
      visible = false;
      cursorEl.classList.add('hidden');
      cursorEl.classList.remove('glow');
      rippleEl.classList.add('hidden');
      tooltipEl.classList.add('hidden');
    },
    show: () => {
      visible = true;
      cursorEl.classList.remove('hidden');
      cursorEl.classList.add('glow');
      rippleEl.classList.remove('hidden');
      tooltipEl.classList.remove('hidden');
    },
    isVisible: () => visible,
    setCommandLabel,
    clearCommandLabel,
    recordAction,
    // Internal: exposed for tests so they can introspect the action log without
    // scraping the DOM. Not part of the documented public API.
    __actionLog: actionLog,
  };
})();
`;
