/* TaskBridge — Action executor
 * Fills supported controls in a framework-safe way (React/Vue/Angular see real input events),
 * verifies the result, captures the previous state for undo, and clicks navigation buttons.
 */
(() => {
  const TB = (window.TB = window.TB || {});
  if (TB.fill) return;

  const norm = (s) =>
    String(s ?? '')
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[\s._\-()/,]+/g, ' ')
      .trim();

  function matchOption(options, value) {
    const v = norm(value);
    if (!v) return null;
    return (
      options.find((o) => norm(o.label) === v) ||
      options.find((o) => norm(o.value) === v) ||
      options.find((o) => v.length >= 2 && norm(o.label).startsWith(v)) ||
      options.find((o) => v.length >= 3 && norm(o.label).includes(v)) ||
      options.find((o) => norm(o.label).length >= 3 && v.includes(norm(o.label))) ||
      null
    );
  }
  TB.matchOption = matchOption;

  function setNative(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

  function commitText(el, value) {
    el.focus({ preventScroll: true });
    setNative(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
    fire(el, 'change');
    el.blur();
  }

  function toBool(v) {
    if (typeof v === 'boolean') return v;
    const s = norm(v);
    if (/^(true|yes|y|1|on|checked|agree|agreed|i agree|হ্যাঁ|হ্যা|জি|সম্মত|ঠিক আছে)$/.test(s)) return true;
    if (/^(false|no|n|0|off|unchecked|disagree|না|নাহ|অসম্মত)$/.test(s)) return false;
    return null;
  }

  function choiceOptions(entry) {
    return entry.els.map((c) => ({ value: c.value, label: TB.labelText(c) || c.value, el: c }));
  }

  function setCheck(c, want) {
    if (c.checked === want) return;
    c.click();
    if (c.checked !== want) {
      c.checked = want;
      fire(c, 'input');
      fire(c, 'change');
    }
  }

  function getEntry(fieldId) {
    let entry = TB.registry.get(fieldId);
    if (!entry || !entry.els[0].isConnected) {
      TB.scan();
      entry = TB.registry.get(fieldId);
    }
    return entry || null;
  }

  function verify(kind, expected, actual) {
    if (kind === 'checkbox') return actual === toBool(expected);
    if (Array.isArray(actual)) {
      const exp = [].concat(expected).map(norm);
      return exp.length > 0 && exp.every((e) => actual.some((a) => norm(a) === e || norm(a).includes(e)));
    }
    const a = norm(actual);
    const e = norm(expected);
    if (!a) return false;
    return a === e || a.includes(e) || e.includes(a);
  }

  TB.captureState = function (fieldId) {
    const e = TB.registry.get(fieldId);
    if (!e) return null;
    const el = e.els[0];
    switch (e.kind) {
      case 'radio': {
        const c = e.els.find((r) => r.checked);
        return { kind: e.kind, value: c ? c.value : null };
      }
      case 'checkbox':
        return { kind: e.kind, value: el.checked };
      case 'checkbox-group':
        return { kind: e.kind, value: e.els.filter((c) => c.checked).map((c) => c.value) };
      case 'multiselect':
        return { kind: e.kind, value: [...el.selectedOptions].map((o) => o.value) };
      default:
        return { kind: e.kind, value: el.value };
    }
  };

  TB.restore = function (fieldId, state) {
    const e = getEntry(fieldId);
    if (!e || !state) return { ok: false, error: 'FIELD_NOT_FOUND' };
    const el = e.els[0];
    switch (e.kind) {
      case 'radio':
        e.els.forEach((r) => {
          const want = state.value !== null && r.value === state.value;
          if (want) setCheck(r, true);
          else if (r.checked) {
            r.checked = false;
            fire(r, 'change');
          }
        });
        break;
      case 'checkbox':
        setCheck(el, !!state.value);
        break;
      case 'checkbox-group':
        e.els.forEach((c) => setCheck(c, (state.value || []).includes(c.value)));
        break;
      case 'multiselect':
        [...el.options].forEach((o) => (o.selected = (state.value || []).includes(o.value)));
        fire(el, 'input');
        fire(el, 'change');
        break;
      case 'select':
        setNative(el, state.value ?? '');
        fire(el, 'input');
        fire(el, 'change');
        break;
      default:
        commitText(el, state.value ?? '');
    }
    TB.unmark && TB.unmark(fieldId);
    return { ok: true, actual: TB.readValue(fieldId) };
  };

  TB.fill = function (fieldId, value) {
    const entry = getEntry(fieldId);
    if (!entry) return { ok: false, error: 'FIELD_NOT_FOUND' };
    if (entry.sensitive || entry.kind === 'file' || entry.kind === 'password') return { ok: false, error: 'MANUAL_ONLY' };
    const el = entry.els[0];
    const previous = TB.captureState(fieldId);

    try {
      switch (entry.kind) {
        case 'select': {
          const opts = [...el.options].filter((o) => !o.disabled && o.value !== '').map((o) => ({ value: o.value, label: o.text.trim() }));
          const m = matchOption(opts, value);
          if (!m) return { ok: false, error: 'NO_MATCHING_OPTION' };
          el.focus({ preventScroll: true });
          setNative(el, m.value);
          fire(el, 'input');
          fire(el, 'change');
          el.blur();
          break;
        }
        case 'multiselect': {
          const opts = [...el.options].map((o) => ({ value: o.value, label: o.text.trim(), o }));
          const hits = new Set([].concat(value).map((w) => matchOption(opts, w)).filter(Boolean).map((m) => m.o));
          if (!hits.size) return { ok: false, error: 'NO_MATCHING_OPTION' };
          opts.forEach(({ o }) => (o.selected = hits.has(o)));
          fire(el, 'input');
          fire(el, 'change');
          break;
        }
        case 'radio': {
          const m = matchOption(choiceOptions(entry), Array.isArray(value) ? value[0] : value);
          if (!m) return { ok: false, error: 'NO_MATCHING_OPTION' };
          setCheck(m.el, true);
          break;
        }
        case 'checkbox': {
          const want = toBool(value);
          if (want === null) return { ok: false, error: 'NOT_BOOLEAN' };
          setCheck(el, want);
          break;
        }
        case 'checkbox-group': {
          const wanted = Array.isArray(value) ? value : String(value).split(/\s*(?:,|;|\band\b|এবং)\s*/);
          const opts = choiceOptions(entry);
          const hits = new Set(wanted.map((w) => matchOption(opts, w)).filter(Boolean).map((m) => m.el));
          if (!hits.size) return { ok: false, error: 'NO_MATCHING_OPTION' };
          entry.els.forEach((c) => setCheck(c, hits.has(c)));
          break;
        }
        default:
          commitText(el, String(value ?? ''));
      }
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }

    const actual = TB.readValue(fieldId);
    const verified = verify(entry.kind, value, actual);
    TB.markFilled && TB.markFilled(fieldId, verified);
    return { ok: true, previous, actual, verified };
  };

  TB.clickButton = function (buttonId) {
    const b = document.querySelector(`[data-tb-btn="${CSS.escape(buttonId)}"]`);
    if (!b) return { ok: false, error: 'BUTTON_NOT_FOUND' };
    b.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Click slightly later so the response reaches the side panel before any navigation.
    setTimeout(() => b.click(), 60);
    return { ok: true };
  };
})();
