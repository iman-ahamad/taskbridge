/* TaskBridge — On-page overlay
 * 1) Field highlights (current field, filled, needs-attention).
 * 2) A floating launcher that appears whenever a form is detected, plus a small
 *    mic bubble next to the field you focus — similar to how Grammarly appears.
 * UI lives in a closed-off Shadow DOM so page CSS can't break it.
 */
(() => {
  const TB = (window.TB = window.TB || {});
  if (TB.overlay) return;

  // ---------- highlight styles ----------
  const STYLE_ID = 'taskbridge-highlight-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      [data-tb-active]{outline:3px solid #0F5B43 !important;outline-offset:3px !important;border-radius:6px;
        box-shadow:0 0 0 7px rgba(15,91,67,.16) !important;transition:box-shadow .3s ease}
      [data-tb-filled="ok"]{outline:2px solid #1F9D6B !important;outline-offset:2px !important}
      [data-tb-filled="warn"]{outline:2px dashed #C98A00 !important;outline-offset:2px !important}
      [data-tb-flash]{animation:tbFlash .9s ease}
      @keyframes tbFlash{0%{background-color:rgba(31,157,107,.28)}100%{background-color:transparent}}
      @media (prefers-reduced-motion: reduce){[data-tb-flash]{animation:none}}
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  function target(fieldId) {
    const e = TB.registry && TB.registry.get(fieldId);
    if (!e) return null;
    if (e.kind === 'radio' || e.kind === 'checkbox-group') {
      const first = e.els[0];
      return first.closest('fieldset,[role="radiogroup"],[role="group"],.field,.form-group') || first.parentElement;
    }
    return e.els[0];
  }

  TB.highlight = function (fieldId) {
    ensureStyle();
    TB.clearHighlights();
    const t = target(fieldId);
    if (!t) return;
    t.setAttribute('data-tb-active', '');
    const r = t.getBoundingClientRect();
    if (r.top < 90 || r.bottom > window.innerHeight - 90) t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  TB.markFilled = function (fieldId, ok = true) {
    ensureStyle();
    const t = target(fieldId);
    if (!t) return;
    t.removeAttribute('data-tb-active');
    t.setAttribute('data-tb-filled', ok ? 'ok' : 'warn');
    t.setAttribute('data-tb-flash', '');
    setTimeout(() => t.removeAttribute('data-tb-flash'), 950);
  };

  TB.unmark = function (fieldId) {
    const t = target(fieldId);
    if (t) t.removeAttribute('data-tb-filled');
  };

  TB.clearHighlights = function () {
    document.querySelectorAll('[data-tb-active]').forEach((n) => n.removeAttribute('data-tb-active'));
  };

  TB.clearAllMarks = function () {
    document.querySelectorAll('[data-tb-active],[data-tb-filled]').forEach((n) => {
      n.removeAttribute('data-tb-active');
      n.removeAttribute('data-tb-filled');
    });
  };

  // ---------- launcher ----------
  const MIC_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/></svg>';
  const toBn = (n) => String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[d]);

  let host = null;
  let root = null;
  let dismissed = false;
  let active = false;
  let count = 0;
  let bubbleTimer = null;

  const CSS_TEXT = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:"Anek Bangla","Hind Siliguri","Noto Sans Bengali","Nirmala UI",system-ui,sans-serif}
    .pill{position:fixed;right:20px;bottom:20px;display:flex;align-items:center;gap:2px;background:#0F5B43;color:#fff;
      border-radius:999px;box-shadow:0 10px 28px rgba(6,40,30,.28),0 2px 6px rgba(6,40,30,.2);padding:4px;max-width:320px}
    .main{all:unset;cursor:pointer;display:flex;align-items:center;gap:10px;padding:6px 12px 6px 6px;border-radius:999px}
    .main:focus-visible,.x:focus-visible,.bubble:focus-visible{outline:2px solid #FFD66B;outline-offset:2px}
    .logo{width:34px;height:34px;border-radius:50%;background:#fff;color:#0F5B43;display:grid;place-items:center;flex:none}
    .pill.on .logo{background:#E4343F;color:#fff}
    .txt{display:flex;flex-direction:column;line-height:1.15}
    .txt b{font-size:14px;font-weight:600;letter-spacing:.1px}
    .txt small{font-size:12px;opacity:.85}
    .x{all:unset;cursor:pointer;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;opacity:.7;font-size:16px;margin-right:4px}
    .x:hover{opacity:1;background:rgba(255,255,255,.12)}
    .bubble{all:unset;position:fixed;width:26px;height:26px;border-radius:50%;background:#0F5B43;color:#fff;display:none;
      place-items:center;cursor:pointer;box-shadow:0 4px 10px rgba(6,40,30,.3)}
    .bubble.show{display:grid}
    .toast{position:fixed;right:20px;bottom:76px;background:#12211C;color:#fff;font-size:13px;padding:8px 12px;border-radius:10px;display:none;max-width:280px}
    .toast.show{display:block}
  `;

  function build() {
    host = document.createElement('div');
    host.id = 'taskbridge-root';
    host.setAttribute('data-tb-ignore', '');
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${CSS_TEXT}</style>
      <div class="pill" role="region" aria-label="TaskBridge">
        <button class="main" type="button" title="Open TaskBridge voice assistant">
          <span class="logo">${MIC_SVG}</span>
          <span class="txt"><b>TaskBridge</b><small class="sub"></small></span>
        </button>
        <button class="x" type="button" aria-label="Hide for this page" title="Hide for this page">×</button>
      </div>
      <button class="bubble" type="button" aria-label="Fill this form by voice" title="Fill this form by voice">${MIC_SVG}</button>
      <div class="toast" role="status"></div>`;
    root.querySelector('.main').addEventListener('click', openPanel);
    root.querySelector('.x').addEventListener('click', () => {
      dismissed = true;
      host.remove();
    });
    const bubble = root.querySelector('.bubble');
    bubble.addEventListener('mousedown', (e) => e.preventDefault());
    bubble.addEventListener('click', openPanel);
    document.documentElement.appendChild(host);
    update();
  }

  function update() {
    if (!root) return;
    const pill = root.querySelector('.pill');
    pill.classList.toggle('on', active);
    root.querySelector('.sub').textContent = active
      ? 'চলছে — সাইড প্যানেলে কথা বলুন'
      : `ভয়েসে ফর্ম পূরণ করুন (${toBn(count)}টি ঘর)`;
  }

  function toast(text) {
    if (!root) return;
    const t = root.querySelector('.toast');
    t.textContent = text;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 4500);
  }

  function openPanel() {
    try {
      chrome.runtime
        .sendMessage({ type: 'TB_OPEN_PANEL' })
        .then((r) => {
          if (!r || !r.ok) toast('টুলবারের TaskBridge আইকনে ক্লিক করুন। (Click the TaskBridge toolbar icon.)');
        })
        .catch(() => toast('এক্সটেনশন রিলোড হয়েছে — পেজটি রিফ্রেশ করুন। (Please refresh this page.)'));
    } catch {
      toast('পেজটি রিফ্রেশ করুন। (Please refresh this page.)');
    }
  }

  // Mic bubble next to the focused field
  document.addEventListener(
    'focusin',
    (e) => {
      if (!root || dismissed || active) return;
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.matches('input,select,textarea')) return;
      const id = el.dataset.tbId || el.getAttribute('data-tb-group');
      const entry = id && TB.registry && TB.registry.get(id);
      if (!entry || entry.sensitive) return;
      const r = el.getBoundingClientRect();
      const bubble = root.querySelector('.bubble');
      const left = r.right + 34 < window.innerWidth ? r.right + 6 : r.right - 32;
      bubble.style.left = `${Math.max(4, left)}px`;
      bubble.style.top = `${Math.max(4, r.top + r.height / 2 - 13)}px`;
      bubble.classList.add('show');
      clearTimeout(bubbleTimer);
    },
    true
  );
  document.addEventListener(
    'focusout',
    () => {
      if (!root) return;
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(() => root.querySelector('.bubble').classList.remove('show'), 250);
    },
    true
  );
  window.addEventListener(
    'scroll',
    () => root && root.querySelector('.bubble').classList.remove('show'),
    { passive: true, capture: true }
  );

  TB.overlay = {
    show(n) {
      count = n;
      if (dismissed) return;
      if (!host || !host.isConnected) build();
      else update();
    },
    hide() {
      if (host) host.remove();
    },
    setActive(v) {
      active = !!v;
      if (!v) TB.clearHighlights();
      update();
    },
    toast,
  };
})();
