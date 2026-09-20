/* Shikkha Setu demo portal — generic multi-step form engine.
 * Behaves like a real e-service: steps, required fields, pattern checks, server-style
 * custom rules, conditional fields and a success page. Nothing is sent anywhere.
 *
 * Markup conventions:
 *   form.wizard > section.step[data-title]      one page of the form
 *   .field > .error[role=alert]                  error slot for that field
 *   [data-show-if="name=value1|value2"]          shown only when the control matches
 *   [data-hide-if-checked="checkboxName"]        hidden while the checkbox is ticked
 *   window.PORTAL_RULES = [{ step, check(data) -> [{ name, message }] }]
 */
(() => {
  const form = document.querySelector('form.wizard');
  if (!form) return;
  const steps = [...form.querySelectorAll('section.step')];
  const stepper = document.querySelector('.stepper');
  window.PORTAL_RULES = window.PORTAL_RULES || [];
  const rules = window.PORTAL_RULES;
  let current = 0;

  // ---------- helpers ----------
  const visible = (el) => !el.closest('[hidden]');
  const controlsIn = (root) => [...root.querySelectorAll('input, select, textarea')].filter((c) => visible(c) && c.type !== 'hidden');

  function data() {
    const out = {};
    for (const c of form.querySelectorAll('input, select, textarea')) {
      if (!c.name || !visible(c)) continue;
      if (c.type === 'radio') {
        if (c.checked) out[c.name] = c.value;
        else if (!(c.name in out)) out[c.name] = '';
      } else if (c.type === 'checkbox') {
        const group = form.querySelectorAll(`input[type=checkbox][name="${c.name}"]`);
        if (group.length > 1) {
          out[c.name] = out[c.name] || [];
          if (c.checked) out[c.name].push(c.value);
        } else out[c.name] = c.checked;
      } else if (c.type === 'file') {
        out[c.name] = c.files && c.files.length ? c.files[0].name : '';
      } else if (c.type !== 'password') {
        out[c.name] = c.value.trim();
      }
    }
    return out;
  }

  function fieldBox(c) {
    return c.closest('.field');
  }

  function setError(c, message) {
    const box = fieldBox(c);
    if (!box) return;
    const slot = box.querySelector('.error');
    const group = c.type === 'radio' || (c.type === 'checkbox' && form.querySelectorAll(`[name="${c.name}"]`).length > 1)
      ? [...form.querySelectorAll(`[name="${c.name}"]`)]
      : [c];
    if (message) {
      slot.textContent = message;
      slot.hidden = false;
      group.forEach((g) => g.setAttribute('aria-invalid', 'true'));
    } else {
      slot.textContent = '';
      slot.hidden = true;
      group.forEach((g) => g.removeAttribute('aria-invalid'));
    }
  }

  function builtInMessage(c) {
    const v = c.validity;
    const label = (c.labels && c.labels[0] ? c.labels[0].textContent : c.closest('fieldset')?.querySelector('legend')?.textContent || c.name).trim();
    if (v.valueMissing) {
      if (c.type === 'radio') return `Please select an option for "${label}".`;
      if (c.type === 'checkbox') return 'You must tick this box to continue.';
      if (c.type === 'file') return 'Please upload this file.';
      return `"${label}" is required.`;
    }
    if (v.typeMismatch && c.type === 'email') return 'Enter a valid email address, e.g. name@example.com.';
    if (v.patternMismatch) return c.dataset.patternMsg || `"${label}" is not in the correct format.`;
    if (v.tooShort) return `Please write at least ${c.minLength} characters (now ${c.value.length}).`;
    if (v.rangeUnderflow) return `Value must be ${c.min} or more.`;
    if (v.rangeOverflow) return `Value must be ${c.max} or less.`;
    if (v.stepMismatch) return 'Please enter a valid number (up to 2 decimal places).';
    if (v.badInput) return 'Please enter a valid value.';
    return c.validationMessage || 'Invalid value.';
  }

  /** Validates the given step. Returns true when valid; shows errors otherwise. */
  function validateStep(i) {
    const step = steps[i];
    let firstBad = null;
    const seen = new Set();
    for (const c of controlsIn(step)) {
      if (c.type === 'radio' || c.type === 'checkbox') {
        const groupKey = c.type + ':' + c.name;
        if (seen.has(groupKey)) continue;
        seen.add(groupKey);
      }
      const ok = c.checkValidity();
      setError(c, ok ? '' : builtInMessage(c));
      if (!ok && !firstBad) firstBad = c;
    }
    // "Server-side" rules
    const d = data();
    for (const r of rules.filter((r) => r.step === i)) {
      for (const e of r.check(d) || []) {
        const c = form.querySelector(`[name="${e.name}"]`);
        if (!c || !visible(c)) continue;
        setError(c, e.message);
        if (!firstBad) firstBad = c;
      }
    }
    const alert = step.querySelector('.form-alert');
    if (alert) alert.hidden = !firstBad;
    if (firstBad) firstBad.focus({ preventScroll: false });
    return !firstBad;
  }

  // Clear a field's error as soon as the user (or an assistant) changes it.
  form.addEventListener('input', (e) => e.target.name && setError(e.target, ''));
  form.addEventListener('change', (e) => {
    if (e.target.name) setError(e.target, '');
    applyConditions();
  });

  // ---------- conditional fields ----------
  function applyConditions() {
    form.querySelectorAll('[data-show-if]').forEach((n) => {
      const [name, vals] = n.dataset.showIf.split('=');
      const allowed = vals.split('|');
      const c = [...form.querySelectorAll(`[name="${name}"]`)];
      const val = c.length && c[0].type === 'radio' ? (c.find((x) => x.checked) || {}).value : c[0] && c[0].value;
      n.hidden = !allowed.includes(val || '');
    });
    form.querySelectorAll('[data-hide-if-checked]').forEach((n) => {
      const c = form.querySelector(`[name="${n.dataset.hideIfChecked}"]`);
      n.hidden = !!(c && c.checked);
    });
  }

  // ---------- navigation ----------
  function show(i) {
    current = i;
    steps.forEach((s, j) => (s.hidden = j !== i));
    if (stepper) {
      [...stepper.children].forEach((li, j) => {
        if (j === i) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
        li.classList.toggle('done', j < i);
      });
    }
    const summary = steps[i].querySelector('[data-summary]');
    if (summary) renderSummary(summary);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    history.replaceState(null, '', `#step-${i + 1}`);
  }

  function labelFor(name) {
    const c = form.querySelector(`[name="${name}"]`);
    if (!c) return name;
    if (c.type === 'radio' || (c.type === 'checkbox' && form.querySelectorAll(`[name="${name}"]`).length > 1)) {
      return (c.closest('fieldset')?.querySelector('legend')?.textContent || name).trim();
    }
    return (c.labels && c.labels[0] ? c.labels[0].textContent : name).trim();
  }

  function renderSummary(node) {
    const d = data();
    const rows = Object.entries(d)
      .filter(([, v]) => v !== '' && v !== false && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `<dt>${esc(labelFor(k))}</dt><dd>${esc(v === true ? 'Yes' : Array.isArray(v) ? v.join(', ') : v)}</dd>`)
      .join('');
    node.innerHTML = `<dl>${rows}</dl>`;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  form.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-nav]');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.nav === 'back') return show(Math.max(0, current - 1));
    if (validateStep(current)) show(Math.min(steps.length - 1, current + 1));
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    for (let i = 0; i < steps.length; i++) {
      if (!validateStep(i)) {
        if (i !== current) show(i);
        validateStep(i);
        return;
      }
    }
    const ref = (form.dataset.refPrefix || 'REQ') + '-' + new Date().getFullYear() + '-' + String(Math.floor(100000 + Math.random() * 900000));
    const success = document.querySelector('.success');
    success.querySelector('.ref').textContent = ref;
    renderSummary(success.querySelector('[data-summary]'));
    form.hidden = true;
    if (stepper) stepper.hidden = true;
    success.hidden = false;
    window.scrollTo({ top: 0 });
    history.replaceState(null, '', '#submitted');
  });

  // ---------- simple CAPTCHA (to prove the assistant leaves it to the user) ----------
  const cap = document.querySelector('canvas[data-captcha]');
  if (cap) {
    const draw = () => {
      const code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
      cap.dataset.code = code;
      const g = cap.getContext('2d');
      g.clearRect(0, 0, cap.width, cap.height);
      g.fillStyle = '#eef1f4';
      g.fillRect(0, 0, cap.width, cap.height);
      for (let i = 0; i < 6; i++) {
        g.strokeStyle = `hsl(${Math.random() * 360},40%,65%)`;
        g.beginPath();
        g.moveTo(Math.random() * cap.width, Math.random() * cap.height);
        g.lineTo(Math.random() * cap.width, Math.random() * cap.height);
        g.stroke();
      }
      g.font = 'bold 24px monospace';
      [...code].forEach((ch, i) => {
        g.save();
        g.translate(14 + i * 22, 30);
        g.rotate((Math.random() - 0.5) * 0.5);
        g.fillStyle = '#233';
        g.fillText(ch, 0, 0);
        g.restore();
      });
    };
    draw();
    document.querySelector('[data-captcha-refresh]')?.addEventListener('click', (e) => {
      e.preventDefault();
      draw();
    });
    window.PORTAL_RULES.push({
      step: steps.length - 1,
      check: (d) => (d.captcha && d.captcha.toUpperCase() !== cap.dataset.code ? [{ name: 'captcha', message: 'The security code does not match. Try again.' }] : []),
    });
  }

  applyConditions();
  show(0); // a reload always starts again from step 1, like most real portals
})();
