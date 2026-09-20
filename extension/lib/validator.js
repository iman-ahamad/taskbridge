// TaskBridge — application-side guard.
// The language model only *proposes* a value. This module checks the target field,
// normalises the value for the control type, and rejects anything unsafe or invalid
// before the executor touches the page.

import { bnToEnDigits, hasBangla, displayOf } from './normalize.js';

const MANUAL_KINDS = new Set(['password', 'file']);

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s._\-()/,]+/g, ' ')
    .trim();

export function matchOption(options = [], value) {
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

export function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = norm(bnToEnDigits(v));
  if (/^(true|yes|y|1|on|checked|agree|agreed|i agree|হ্যাঁ|হ্যা|জি|সম্মত|ঠিক আছে|রাজি)$/.test(s)) return true;
  if (/^(false|no|n|0|off|unchecked|disagree|না|নাহ|অসম্মত)$/.test(s)) return false;
  return null;
}

const ok = (value, display) => ({ ok: true, value, display: display ?? displayOf(value) });
const fail = (code, bn, en, extra = {}) => ({ ok: false, code, error_bn: bn, error_en: en, ...extra });

function listOptions(field, n = 5) {
  return (field.options || []).slice(0, n).map((o) => o.label).join(', ');
}

function normalisePhone(s) {
  let d = s.replace(/\D/g, '');
  if (d.startsWith('880') && d.length === 13) d = d.slice(2);
  else if (d.startsWith('88') && d.length === 13) d = d.slice(2);
  if (d.length === 10 && d.startsWith('1')) d = '0' + d;
  return d;
}

function normaliseDate(s) {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  let m = t.match(/^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4})$/); // DD/MM/YYYY (Bangladesh convention)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{4})[/\-. ](\d{1,2})[/\-. ](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return t;
}

function isRealDate(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function testPattern(pattern, s) {
  for (const flags of ['v', 'u', '']) {
    try {
      return new RegExp(`^(?:${pattern})$`, flags).test(s);
    } catch {
      /* try next flag set */
    }
  }
  return true; // un-parseable pattern: let the page decide
}

/**
 * @param field  field from the page snapshot
 * @param raw    value proposed by the model / user / document
 * @param hints  { answer_language } from the form analysis
 */
export function validateValue(field, raw, hints = {}) {
  if (!field) return fail('FIELD_NOT_FOUND', 'ঘরটি পেজে পাওয়া যায়নি।', 'That field is not on the page.');
  if (field.sensitive || MANUAL_KINDS.has(field.kind)) {
    return fail('MANUAL_ONLY', 'নিরাপত্তার জন্য এই ঘরটি আপনাকে নিজে পূরণ করতে হবে।', 'For your safety, please fill this field yourself.');
  }
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim()) || (Array.isArray(raw) && !raw.length)) {
    return fail('EMPTY', 'কোনো উত্তর পাইনি।', 'I did not get an answer.');
  }

  switch (field.kind) {
    case 'select':
    case 'radio': {
      const v = Array.isArray(raw) ? raw[0] : raw;
      const o = matchOption(field.options, v);
      if (!o) {
        return fail('NO_OPTION', `এই অপশনগুলোর একটি বলুন: ${listOptions(field)}।`, `Please choose one of: ${listOptions(field)}.`);
      }
      return ok(o.label);
    }
    case 'multiselect':
    case 'checkbox-group': {
      const arr = Array.isArray(raw) ? raw : String(raw).split(/\s*(?:,|;|\band\b|এবং|আর)\s*/);
      const hits = [...new Set(arr.map((x) => matchOption(field.options, x)).filter(Boolean).map((o) => o.label))];
      if (!hits.length) {
        return fail('NO_OPTION', `এগুলোর মধ্য থেকে বলুন: ${listOptions(field, 8)}।`, `Please choose from: ${listOptions(field, 8)}.`);
      }
      return ok(hits);
    }
    case 'checkbox': {
      const b = toBool(raw);
      if (b === null) return fail('BOOL', '"হ্যাঁ" অথবা "না" বলুন।', 'Please say yes or no.');
      return ok(b, b ? 'Yes' : 'No');
    }
    default:
      break;
  }

  const wantsBangla = hints.answer_language === 'bn';
  let s = String(Array.isArray(raw) ? raw.join(', ') : raw).trim();
  if (!wantsBangla) s = bnToEnDigits(s);
  if (hints.answer_language === 'en' && hasBangla(s)) {
    return fail('NEEDS_ENGLISH', 'এই ঘরটি ইংরেজিতে লিখতে হবে।', 'This field must be in English.', { value: s });
  }

  switch (field.kind) {
    case 'email':
      s = s.replace(/\s+/g, '').toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)) {
        return fail('EMAIL', 'ইমেইলটি ঠিক মনে হচ্ছে না। যেমন: name@gmail.com — আবার বলুন।', 'That email does not look right (e.g. name@gmail.com). Please say it again.');
      }
      break;
    case 'tel': {
      const p = normalisePhone(s);
      if (p.length < 6) return fail('PHONE', 'ফোন নম্বরটি অসম্পূর্ণ। আবার বলুন।', 'The phone number looks incomplete. Please say it again.');
      s = p;
      break;
    }
    case 'number': {
      s = s.replace(/[^\d.\-]/g, '');
      const n = Number(s);
      if (!s || Number.isNaN(n)) return fail('NUMBER', 'একটি সংখ্যা বলুন।', 'Please say a number.');
      if (field.min !== undefined && field.min !== '' && n < Number(field.min)) {
        return fail('MIN', `সংখ্যাটি ${field.min} এর কম হতে পারবে না।`, `The number can't be less than ${field.min}.`);
      }
      if (field.max !== undefined && field.max !== '' && n > Number(field.max)) {
        return fail('MAX', `সংখ্যাটি ${field.max} এর বেশি হতে পারবে না।`, `The number can't be more than ${field.max}.`);
      }
      break;
    }
    case 'date': {
      s = normaliseDate(s);
      if (!isRealDate(s)) return fail('DATE', 'তারিখটি বুঝতে পারিনি। দিন, মাস আর বছর বলুন।', 'I could not understand the date. Please say day, month and year.');
      if (field.min && s < field.min) return fail('DATE_MIN', `তারিখটি ${field.min} এর আগে হতে পারবে না।`, `The date can't be before ${field.min}.`);
      if (field.max && s > field.max) return fail('DATE_MAX', `তারিখটি ${field.max} এর পরে হতে পারবে না।`, `The date can't be after ${field.max}.`);
      break;
    }
    case 'month':
      if (!/^\d{4}-\d{2}$/.test(s)) return fail('MONTH', 'মাস ও বছর বলুন।', 'Please say the month and year.');
      break;
    case 'time':
      if (!/^\d{2}:\d{2}$/.test(s)) return fail('TIME', 'সময়টি বুঝতে পারিনি।', 'I could not understand the time.');
      break;
    case 'url':
      s = s.replace(/\s+/g, '');
      if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
      break;
    default:
      break;
  }

  if (field.maxLength > 0 && s.length > field.maxLength) {
    return fail('TOO_LONG', `সর্বোচ্চ ${field.maxLength} অক্ষর লেখা যাবে। একটু ছোট করে বলুন।`, `Maximum ${field.maxLength} characters. Please say it shorter.`);
  }
  if (field.minLength > 0 && s.length < field.minLength) {
    return fail('TOO_SHORT', `কমপক্ষে ${field.minLength} অক্ষর লাগবে।`, `At least ${field.minLength} characters are needed.`);
  }
  if (field.pattern && !testPattern(field.pattern, s)) {
    const hint = field.placeholder || field.help || '';
    return fail(
      'PATTERN',
      `এই ঘরের নির্দিষ্ট ফরম্যাট আছে${hint ? ` (${hint})` : ''}। আবার বলুন।`,
      `This field needs a specific format${hint ? ` (${hint})` : ''}. Please say it again.`
    );
  }
  return ok(s);
}
