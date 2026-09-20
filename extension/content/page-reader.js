/* TaskBridge — Page reader
 * Extracts the visible form structure from the DOM + accessibility attributes:
 * labels, required flags, options, sections, help/error text and navigation buttons.
 * Every control gets a stable data-tb-id so the side panel can address it.
 */
(() => {
  const TB = (window.TB = window.TB || {});
  if (TB.scan) return;

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'color']);
  const SENSITIVE_RE =
    /(pass\s?word|passcode|\botp\b|one[\s-]?time|verification code|captcha|\bcvv\b|\bcvc\b|\bpin\b|security code|পাসওয়ার্ড|ওটিপি|পিন কোড|যাচাই কোড)/i;
  const PLACEHOLDER_OPT_RE = /^(-+|select|choose|pick|please select|--.*--|নির্বাচন|বাছাই)/i;
  const nonce = Math.random().toString(36).slice(2, 8);
  let counter = 0;

  TB.registry = new Map(); // fieldId -> { id, kind, els, label, sensitive }

  // ---------- text helpers ----------
  function clean(s) {
    let t = String(s || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/\(\s*(required|optional|বাধ্যতামূলক|ঐচ্ছিক)\s*\)/gi, '').trim();
    t = t.replace(/^[*\s]+/, '').replace(/[\s*:：]+$/, '').trim();
    return t;
  }
  TB.clean = clean;

  function textOf(n) {
    if (!n) return '';
    return (n.innerText != null && n.innerText !== '' ? n.innerText : n.textContent) || '';
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden]')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  }
  TB.isVisible = isVisible;

  function visibleControl(el) {
    if (isVisible(el)) return true;
    // Custom-styled radios/checkboxes often hide the real input but show the label.
    if ((el.type === 'radio' || el.type === 'checkbox') && el.labels && el.labels[0]) {
      return isVisible(el.labels[0]);
    }
    return false;
  }

  function stripControls(node) {
    const clone = node.cloneNode(true);
    clone
      .querySelectorAll('input,select,textarea,option,button,script,style,small,.error,.hint,.help,[role="alert"]')
      .forEach((n) => n.remove());
    return clean(clone.textContent);
  }

  // ---------- labels ----------
  function labelText(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map(textOf)
        .join(' ');
      if (clean(t)) return clean(t);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && clean(aria)) return clean(aria);
    if (el.labels && el.labels.length) {
      const t = stripControls(el.labels[0]);
      if (t) return t;
    }
    const ph = el.getAttribute('placeholder');
    if (ph && clean(ph)) return clean(ph);
    const title = el.getAttribute('title');
    if (title && clean(title)) return clean(title);
    // Nearby text in a small wrapper that only contains this control.
    let node = el.parentElement;
    for (let i = 0; i < 3 && node && node !== document.body; i++, node = node.parentElement) {
      if (node.querySelectorAll('input,select,textarea').length > 1) break;
      const t = stripControls(node);
      if (t && t.length <= 100) return t;
    }
    return clean((el.name || el.id || '').replace(/[_\-[\]]+/g, ' '));
  }
  TB.labelText = labelText;

  function groupLabel(first) {
    const container = first.closest('fieldset,[role="radiogroup"],[role="group"]');
    if (container) {
      const legend = container.querySelector('legend');
      if (legend && clean(textOf(legend))) return clean(textOf(legend));
      const aria = container.getAttribute('aria-label');
      if (aria) return clean(aria);
      const by = container.getAttribute('aria-labelledby');
      if (by && document.getElementById(by)) return clean(textOf(document.getElementById(by)));
    }
    let wrap = first.parentElement;
    for (let i = 0; i < 4 && wrap && wrap !== document.body; i++, wrap = wrap.parentElement) {
      const prev = wrap.previousElementSibling;
      if (prev && !prev.querySelector('input,select,textarea')) {
        const t = clean(textOf(prev));
        if (t && t.length <= 120) return t;
      }
    }
    return clean((first.name || '').replace(/[_\-[\]]+/g, ' '));
  }

  // ---------- sections ----------
  function legendIsSection(legend) {
    const fs = legend.closest('fieldset');
    if (!fs) return false;
    const names = new Set();
    fs.querySelectorAll('input,select,textarea').forEach((c) => names.add(c.name || c.id || Math.random()));
    return names.size >= 2;
  }

  function buildSectionMap() {
    const map = new Map();
    let current = '';
    const nodes = document.querySelectorAll('h1,h2,h3,h4,legend,[data-section-title],input,select,textarea');
    nodes.forEach((n) => {
      const isHeading =
        /^(H1|H2|H3|H4)$/.test(n.tagName) ||
        n.hasAttribute('data-section-title') ||
        (n.tagName === 'LEGEND' && legendIsSection(n));
      if (isHeading) {
        if (isVisible(n)) current = clean(textOf(n)).slice(0, 80);
      } else if (n.tagName !== 'LEGEND') {
        map.set(n, current);
      }
    });
    return map;
  }

  // ---------- help / error text ----------
  function isErrorEl(n) {
    return /error|invalid|danger/i.test(String(n.className || '')) || n.getAttribute('role') === 'alert';
  }

  function fieldContainer(el) {
    return el.closest('.field,.form-group,.form-field,.form-row,[data-field],fieldset');
  }

  function helpText(el) {
    const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const parts = ids
      .map((id) => document.getElementById(id))
      .filter((n) => n && !isErrorEl(n))
      .map(textOf);
    if (!parts.length) {
      const c = fieldContainer(el);
      const hint = c && c.querySelector('small,.help,.hint,.form-text,.helper');
      if (hint && !isErrorEl(hint)) parts.push(textOf(hint));
    }
    return clean(parts.join(' ')).slice(0, 200);
  }

  function errorText(el) {
    const out = [];
    const errId = el.getAttribute('aria-errormessage');
    if (errId && document.getElementById(errId)) out.push(textOf(document.getElementById(errId)));
    (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter((n) => n && isErrorEl(n) && isVisible(n))
      .forEach((n) => out.push(textOf(n)));
    if (!out.length) {
      const c = fieldContainer(el);
      if (c) {
        c.querySelectorAll('.error,.invalid-feedback,.field-error,.error-message,[role="alert"]').forEach((n) => {
          if (isVisible(n) && clean(textOf(n))) out.push(textOf(n));
        });
      }
    }
    return clean([...new Set(out.map(clean))].join(' ')).slice(0, 200);
  }
  TB.errorText = errorText;

  // ---------- kinds, values ----------
  function kindOf(el) {
    if (el.tagName === 'SELECT') return el.multiple ? 'multiselect' : 'select';
    if (el.tagName === 'TEXTAREA') return 'textarea';
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'range') return 'number';
    const known = ['email', 'tel', 'number', 'date', 'time', 'datetime-local', 'month', 'week', 'url', 'password', 'file', 'checkbox', 'radio'];
    return known.includes(t) ? t : 'text';
  }

  function selectOptions(el) {
    return [...el.options]
      .filter((o, i) => !o.disabled && o.value !== '' && !(i === 0 && PLACEHOLDER_OPT_RE.test(o.text.trim())))
      .slice(0, 300)
      .map((o) => ({ value: o.value, label: clean(o.text) || o.value }));
  }

  function isEmpty(entry) {
    const el = entry.els[0];
    switch (entry.kind) {
      case 'select': {
        const o = el.options[el.selectedIndex];
        return !o || o.value === '' || (el.selectedIndex === 0 && PLACEHOLDER_OPT_RE.test(o.text.trim()));
      }
      case 'multiselect':
        return el.selectedOptions.length === 0;
      case 'radio':
      case 'checkbox-group':
        return !entry.els.some((c) => c.checked);
      case 'checkbox':
        return !el.checked;
      case 'file':
        return !(el.files && el.files.length);
      default:
        return !String(el.value || '').trim();
    }
  }
  TB.isEmpty = isEmpty;

  TB.readValue = function (fieldId) {
    const entry = TB.registry.get(fieldId);
    if (!entry) return '';
    const el = entry.els[0];
    switch (entry.kind) {
      case 'select': {
        if (isEmpty(entry)) return '';
        return clean(el.options[el.selectedIndex].text);
      }
      case 'multiselect':
        return [...el.selectedOptions].map((o) => clean(o.text));
      case 'radio': {
        const c = entry.els.find((r) => r.checked);
        return c ? labelText(c) || c.value : '';
      }
      case 'checkbox':
        return el.checked;
      case 'checkbox-group':
        return entry.els.filter((c) => c.checked).map((c) => labelText(c) || c.value);
      case 'file':
        return el.files ? [...el.files].map((f) => f.name).join(', ') : '';
      case 'password':
        return el.value ? '••••••' : '';
      default:
        return el.value;
    }
  };

  function slug(s) {
    return (
      String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'field'
    );
  }

  function ensureId(el) {
    if (!el.dataset.tbId) el.dataset.tbId = 'tb' + ++counter;
    return el.dataset.tbId;
  }

  // ---------- buttons ----------
  function scanButtons() {
    const btns = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a.btn')]
      .filter((b) => !b.disabled && isVisible(b) && !b.closest('[data-tb-ignore]'));
    const out = [];
    for (const b of btns) {
      const text = clean(textOf(b) || b.value || b.getAttribute('aria-label') || '');
      if (!text || text.length > 60) continue;
      if (!b.dataset.tbBtn) b.dataset.tbBtn = 'b' + ++counter;
      let role = 'other';
      if (/^(back|previous|prev)\b|\b(go back|previous step)\b|পূর্ববর্তী|পেছনে|আগের ধাপ/i.test(text)) role = 'back';
      else if (/\b(next|continue|proceed|save (&|and) continue)\b|পরবর্তী|এগিয়ে/i.test(text)) role = 'next';
      else if (/\b(submit|apply|register|send|finish|confirm|complete)\b|জমা|আবেদন করুন|নিবন্ধন/i.test(text)) role = 'submit';
      else if ((b.type === 'submit' || b.getAttribute('type') === 'submit') && b.form) role = 'submit';
      if (/\b(send otp|resend|get code|search|login|log in|sign in|cancel|reset|clear)\b/i.test(text)) role = 'other';
      out.push({ id: b.dataset.tbBtn, text, role });
    }
    return out;
  }

  function pageMeta() {
    const h = document.querySelector('h1') || document.querySelector('h2');
    const step = document.querySelector('[aria-current="step"], .step.active, .stepper .active');
    const intro = [...document.querySelectorAll('main p, form p, .instructions, .notice, [role="note"]')]
      .filter(isVisible)
      .map(textOf)
      .join(' ');
    return {
      title: document.title,
      url: location.href,
      heading: h ? clean(textOf(h)) : '',
      lang: document.documentElement.lang || '',
      step: step ? clean(textOf(step)) : '',
      instructions: clean(intro).slice(0, 1200),
    };
  }

  // ---------- main scan ----------
  TB.scan = function () {
    const sectionMap = buildSectionMap();
    const registry = new Map();
    const fields = [];
    const seenGroups = new Set();
    const keyCount = new Map();

    const makeKey = (kind, base) => {
      const k = `${kind}:${slug(base)}`;
      const n = (keyCount.get(k) || 0) + 1;
      keyCount.set(k, n);
      return n > 1 ? `${k}_${n}` : k;
    };

    const all = [...document.querySelectorAll('input,select,textarea')];
    for (const el of all) {
      if (el.closest('[data-tb-ignore]')) continue;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (el.tagName === 'INPUT' && SKIP_TYPES.has(type)) continue;
      if (el.disabled || el.readOnly) continue;
      if (!visibleControl(el)) continue;

      let kind = kindOf(el);
      const scope = el.form || document;

      // Radio groups and multi-checkbox groups become one logical field.
      if (kind === 'radio' || kind === 'checkbox') {
        const members = el.name
          ? [...scope.querySelectorAll(`input[type="${kind}"][name="${CSS.escape(el.name)}"]`)].filter(
              (m) => !m.disabled && visibleControl(m)
            )
          : [el];
        if (kind === 'checkbox' && members.length <= 1) {
          // single checkbox handled below
        } else {
          const gkey = kind + ':' + (el.name || ensureId(el));
          if (seenGroups.has(gkey)) continue;
          seenGroups.add(gkey);
          const id = ensureId(el);
          members.forEach((m) => m.setAttribute('data-tb-group', id));
          if (kind === 'checkbox') kind = 'checkbox-group';
          const label = groupLabel(el);
          const entry = { id, kind, els: members, label, sensitive: false };
          registry.set(id, entry);
          fields.push({
            id,
            key: makeKey(kind, el.name || label),
            kind,
            label,
            name: el.name || '',
            required: members.some((m) => m.required || m.getAttribute('aria-required') === 'true'),
            options: members.map((m) => ({ value: m.value, label: labelText(m) || m.value })),
            section: sectionMap.get(el) || '',
            help: helpText(el),
            error: errorText(el),
            value: TB.readValue(id),
            empty: isEmpty(entry),
            sensitive: false,
          });
          continue;
        }
      }

      const id = ensureId(el);
      const label = labelText(el);
      const hay = [label, el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('autocomplete')].join(' ');
      const sensitive = kind === 'password' || el.getAttribute('autocomplete') === 'one-time-code' || SENSITIVE_RE.test(hay);
      const entry = { id, kind, els: [el], label, sensitive };
      registry.set(id, entry);

      const f = {
        id,
        key: makeKey(kind, el.name || el.id || label),
        kind,
        label,
        name: el.name || '',
        required: el.required || el.getAttribute('aria-required') === 'true',
        placeholder: el.getAttribute('placeholder') || '',
        section: sectionMap.get(el) || '',
        help: helpText(el),
        error: errorText(el),
        value: TB.readValue(id),
        empty: isEmpty(entry),
        sensitive,
      };
      if (el.pattern) f.pattern = el.pattern;
      if (el.maxLength > 0) f.maxLength = el.maxLength;
      if (el.minLength > 0) f.minLength = el.minLength;
      if (el.min) f.min = el.min;
      if (el.max) f.max = el.max;
      if (el.step) f.step = el.step;
      if (kind === 'select' || kind === 'multiselect') f.options = selectOptions(el);
      fields.push(f);
    }

    TB.registry = registry;
    const buttons = scanButtons();
    const fillableCount = fields.filter((f) => !f.sensitive && f.kind !== 'file').length;
    const signature = [nonce, location.pathname + location.hash, fields.map((f) => f.id).join(','), buttons.map((b) => b.id + b.role).join(',')].join('|');
    return { page: pageMeta(), fields, buttons, signature, fillableCount };
  };

  // ---------- validation ----------
  TB.validate = function () {
    const out = [];
    for (const [id, e] of TB.registry) {
      const el = e.els[0];
      if (!el.isConnected || !e.els.some(visibleControl)) continue;
      let msg = errorText(el);
      if (!msg && el.willValidate && el.validity && !el.validity.valid) msg = el.validationMessage;
      if (msg) out.push({ fieldId: id, label: e.label, message: clean(msg).slice(0, 200), sensitive: !!e.sensitive, kind: e.kind });
    }
    return out;
  };
})();
