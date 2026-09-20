// TaskBridge — Agent (task planner + orchestrator)
//
//   understand page → ask → interpret → validate (app code) → execute → verify → next
//
// The model only proposes values. Application code checks the target field, the value and
// the action type before anything touches the page. Final submission always needs a
// spoken or clicked "yes".

import { chatJSON } from './llm.js';
import * as P from './prompts.js';
import { validateValue } from './validator.js';
import { parseYesNo, parseCommand, hasBangla, displayOf, bnToEnDigits } from './normalize.js';
import { loadSession, saveSession, clearSession } from './session.js';
import { T } from './i18n.js';

const CONTENT_FILES = chrome.runtime.getManifest().content_scripts[0].js;
const CHUNK = 15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isManual = (f) => f.sensitive || f.kind === 'file' || f.kind === 'password';

// ---------------------------------------------------------------- accuracy helpers
// Fields where a mis-heard word is expensive to discover later, so they are always read
// back to the user before the form is filled.
const CRITICAL_LABEL = /name|নাম|nid|জাতীয়|id\b|আইডি|roll|রোল|registration|রেজি|account|হিসাব|transaction|ট্রানজ্যাকশন|trx|email|ইমেইল|phone|mobile|ফোন|মোবাইল|নম্বর|number|amount|টাকা|date|তারিখ|gpa|জিপিএ/i;
const CRITICAL_KIND = new Set(['email', 'tel', 'number', 'date']);
const isCritical = (f) => CRITICAL_KIND.has(f.kind) || (f.kind === 'text' && CRITICAL_LABEL.test(f.label || ''));

/** Makes TTS read digits and emails one piece at a time: "01712" → "0 1 7 1 2". */
export function spellOut(value, kind) {
  let v = String(value ?? '');
  if (kind === 'email') return v.replace(/@/g, ' at ').replace(/\./g, ' dot ').split('').join(' ').replace(/\s+/g, ' ');
  if (/^[\d+\-/ ]+$/.test(v)) return v.replace(/\d/g, (d) => d + ' ').trim();
  return v;
}

const norm = (s) =>
  bnToEnDigits(String(s ?? ''))
    .toLowerCase()
    .replace(/[\s\u200c\u200d.,!?'"()\-_/]+/g, '')
    .trim();

/**
 * Matches what was heard against a field's own options, in application code.
 * Exact or contained matches only — no fuzzy guessing — so a mis-heard word falls
 * through to the model instead of silently selecting the wrong option.
 */
export function matchOption(options, texts) {
  const cands = (texts || []).map(norm).filter(Boolean);
  if (!cands.length) return null;
  const opts = (options || []).map((o) => ({ o, n: norm(o.label), v: norm(o.value) }));
  for (const c of cands) {
    const exact = opts.find((x) => x.n === c || x.v === c);
    if (exact) return exact.o;
  }
  for (const c of cands) {
    if (c.length < 3) continue;
    const hits = opts.filter((x) => x.n.includes(c) || c.includes(x.n) || x.v === c);
    if (hits.length === 1) return hits[0].o; // ambiguous matches are rejected on purpose
  }
  return null;
}

export class Agent extends EventTarget {
  constructor({ speechIn, speechOut, getSettings }) {
    super();
    this.speechIn = speechIn;
    this.speechOut = speechOut;
    this.getSettings = getSettings;
    this.reset();
  }

  reset() {
    this.tabId = null;
    this.origin = '';
    this.snapshot = null;
    this.meta = null;
    this.questions = {}; // fieldKey -> { question_bn, question_en, explain_bn, explain_en, answer_language, expected_format, idx }
    this.answers = {}; // fieldKey -> { value, display, source, label, section, status: 'filled'|'skipped', verified, ts }
    this.knownFields = {}; // fieldKey -> { label, section, required, kind, manual } across all steps
    this.history = []; // change log for undo
    this.messages = [];
    this.errors = [];
    this.candidates = [];
    this.errorAttempts = {};
    this.mode = 'idle';
    this.currentKey = null;
    this.pending = null; // { type: 'value' | 'submit', ... }
    this.lang = 'bn';
    this.running = false;
    this.interim = '';
    this.ackPrefix = '';
    this.navigating = false;
    this.submitButtonId = null;
    this.gen = 0; // bumps whenever the conversation moves on; stale async work checks it
  }

  // ---------- small helpers ----------
  t(key, vars) {
    return T(this.lang, key, vars);
  }
  emit() {
    this.dispatchEvent(new Event('change'));
  }
  setMode(m) {
    this.mode = m;
    this.emit();
  }
  pushMsg(role, text, extra = {}) {
    if (!text) return;
    this.messages.push({ role, text, ts: Date.now(), ...extra });
    if (this.messages.length > 200) this.messages.splice(0, this.messages.length - 200);
    this.emit();
  }
  async speak(text) {
    await this.speechOut.speak(text, this.lang);
  }
  async say(text) {
    if (!text) return;
    this.pushMsg('assistant', text);
    await this.speak(text);
  }
  fieldByKey(key) {
    return this.snapshot ? this.snapshot.fields.find((f) => f.key === key) : null;
  }
  currentField() {
    return this.currentKey ? this.fieldByKey(this.currentKey) : null;
  }
  questionText(f) {
    const q = this.questions[f.key];
    const text = q && (this.lang === 'bn' ? q.question_bn : q.question_en);
    return text || this.t('askFallback', { label: f.label });
  }

  async send(msg) {
    if (this.tabId == null) throw new Error('NO_TAB');
    try {
      return await chrome.tabs.sendMessage(this.tabId, msg);
    } catch (e) {
      // Content script missing (page opened before install, or extension reloaded) → inject it.
      await chrome.scripting.executeScript({ target: { tabId: this.tabId }, files: CONTENT_FILES });
      await sleep(150);
      return chrome.tabs.sendMessage(this.tabId, msg);
    }
  }

  persist() {
    if (!this.origin) return;
    saveSession(this.origin, {
      meta: this.meta,
      questions: this.questions,
      answers: this.answers,
      knownFields: this.knownFields,
      messages: this.messages.slice(-40),
    }).catch(() => {});
  }

  // ---------- page understanding ----------
  async rescan() {
    const r = await this.send({ type: 'TB_SCAN' });
    if (!r || !r.ok) throw new Error((r && r.error) || 'SCAN_FAILED');
    this.snapshot = r.snapshot;
    for (const f of r.snapshot.fields) {
      this.knownFields[f.key] = {
        label: f.label,
        section: f.section || '',
        required: !!f.required,
        kind: f.kind,
        manual: isManual(f),
      };
      // Something the user typed directly on the page counts as answered.
      if (!isManual(f) && !f.empty && !this.answers[f.key]) {
        this.answers[f.key] = {
          value: f.value,
          display: displayOf(f.value),
          source: 'manual',
          label: f.label,
          section: f.section,
          status: 'filled',
          verified: true,
          ts: Date.now(),
        };
      }
    }
    this.emit();
    return this.snapshot;
  }

  absorbQuestions(list, fields, base) {
    const byId = new Map(fields.map((f) => [f.id, f]));
    (Array.isArray(list) ? list : []).forEach((q, i) => {
      const f = q && byId.get(q.id);
      if (!f) return;
      this.questions[f.key] = {
        question_bn: q.question_bn || '',
        question_en: q.question_en || '',
        explain_bn: q.explain_bn || '',
        explain_en: q.explain_en || '',
        answer_language: ['en', 'bn', 'any'].includes(q.answer_language) ? q.answer_language : 'any',
        expected_format: q.expected_format || '',
        idx: base + i,
      };
      byId.delete(f.id);
    });
    // Anything the model forgot still gets a simple fallback question.
    let j = 0;
    for (const f of byId.values()) this.questions[f.key] = { answer_language: 'any', idx: base + 500 + j++ };
  }

  /** Makes sure every visible field has a question; analyses the form the first time. */
  async ensureQuestions() {
    const need = this.snapshot.fields.filter((f) => !isManual(f) && !this.questions[f.key]);
    if (!this.meta) {
      const first = need.splice(0, CHUNK);
      const r = await chatJSON(P.analyze(this.snapshot, first));
      this.meta = {
        form_title: r.form_title || this.snapshot.page.heading || this.snapshot.page.title,
        form_purpose: r.form_purpose || '',
        form_language: r.form_language === 'bn' ? 'bn' : 'en',
        summary_bn: r.summary_bn || '',
        summary_en: r.summary_en || '',
        required_documents: Array.isArray(r.required_documents) ? r.required_documents : [],
      };
      this.absorbQuestions(r.fields, first, Object.keys(this.questions).length * 10);
    }
    while (need.length) {
      const chunk = need.splice(0, CHUNK);
      const r = await chatJSON(P.analyze(this.snapshot, chunk, { questionsOnly: true, formPurpose: this.meta.form_purpose }));
      this.absorbQuestions(r.fields, chunk, Object.keys(this.questions).length * 10);
    }
    this.emit();
  }

  nextField() {
    if (!this.snapshot) return null;
    const pos = new Map(this.snapshot.fields.map((f, i) => [f.key, i]));
    return (
      this.snapshot.fields
        .filter((f) => !isManual(f) && !this.answers[f.key])
        .sort((a, b) => {
          const qa = this.questions[a.key]?.idx ?? 9999;
          const qb = this.questions[b.key]?.idx ?? 9999;
          return qa - qb || pos.get(a.key) - pos.get(b.key);
        })[0] || null
    );
  }

  // ---------- lifecycle ----------
  async start(tabId) {
    const s = await this.getSettings();
    this.speechIn.cancel();
    this.speechOut.stop();
    this.reset();
    this.tabId = tabId;
    this.lang = s.userLang || 'bn';
    this.running = true;
    this.setMode('analyzing');

    try {
      const tab = await chrome.tabs.get(tabId);
      this.origin = new URL(tab.url).origin;
      await this.rescan();
    } catch (e) {
      this.running = false;
      return this.fail(e);
    }

    if (!this.snapshot.fields.length) {
      this.running = false;
      this.setMode('idle');
      return this.say(this.t('noForm'));
    }

    const saved = await loadSession(this.origin).catch(() => null);
    const savedAnswers = saved && saved.answers ? saved.answers : null;
    if (saved) {
      this.meta = saved.meta || null;
      this.questions = saved.questions || {};
      this.knownFields = { ...(saved.knownFields || {}), ...this.knownFields };
    }

    try {
      await this.ensureQuestions();
    } catch (e) {
      this.running = false;
      return this.fail(e);
    }

    this.send({ type: 'TB_SESSION_STATE', active: true }).catch(() => {});

    const intro = [];
    if (savedAnswers) {
      const n = await this.restoreSaved(savedAnswers);
      if (n) intro.push(this.t('restored', { n }));
    }
    intro.push(this.lang === 'bn' ? this.meta.summary_bn : this.meta.summary_en);
    const docs = (this.meta.required_documents || []).map((d) => (this.lang === 'bn' ? d.bn : d.en)).filter(Boolean);
    if (docs.length) intro.push(this.t('docsNeeded', { list: docs.join(', ') }));
    const manual = this.snapshot.fields.filter(isManual);
    if (manual.length) intro.push(this.t('manualFields', { list: manual.map((f) => f.label).join(', ') }));
    intro.push(this.t('letsBegin'));

    this.pushMsg('assistant', intro.filter(Boolean).join(' '), { intro: true });
    await this.speak(intro.filter(Boolean).join(' '));
    this.persist();
    if (!this.running) return;
    return this.next();
  }

  async restoreSaved(saved) {
    let n = 0;
    for (const [key, a] of Object.entries(saved)) {
      if (!a || a.status !== 'filled') continue;
      const f = this.fieldByKey(key);
      if (f && f.empty && !isManual(f)) {
        const ok = await this.fillField(f, a.value, 'restored', { quiet: true });
        if (ok) n++;
      } else if (!f) {
        // Answer belongs to another step — keep it for the review and for when that step appears.
        this.answers[key] = { ...a };
      }
    }
    return n;
  }

  stop() {
    this.gen++;
    this.running = false;
    this.pending = null;
    this.currentKey = null;
    this.speechIn.cancel();
    this.speechOut.stop();
    this.send({ type: 'TB_SESSION_STATE', active: false }).catch(() => {});
    this.setMode('idle');
  }

  pause() {
    this.gen++;
    this.speechIn.cancel();
    this.speechOut.stop();
    this.setMode('paused');
    this.pushMsg('system', this.t('paused'));
  }

  resume() {
    if (!this.running) return;
    this.pushMsg('system', this.t('resumed'));
    if (this.pending && this.pending.type === 'submit') {
      this.setMode('reviewing');
      return this.relisten(++this.gen);
    }
    return this.next();
  }

  async setLang(lang) {
    this.lang = lang;
    this.emit();
    const f = this.currentField();
    if (this.running && f && ['asking', 'listening', 'waiting'].includes(this.mode)) {
      this.speechIn.cancel();
      return this.ask(f, ++this.gen);
    }
  }

  // ---------- conversation loop ----------
  async next() {
    if (!this.running) return;
    const gen = ++this.gen;
    const f = this.nextField();
    if (f) return this.ask(f, gen);

    // Nothing left on this page/step.
    this.currentKey = null;
    this.send({ type: 'TB_CLEAR' }).catch(() => {});
    const v = await this.send({ type: 'TB_VALIDATE' }).catch(() => null);
    if (gen !== this.gen) return;
    this.errors = (v && v.errors) || [];
    this.emit();
    if (this.errors.length) return this.handleValidationErrors(gen);

    const s = await this.getSettings();
    const nextBtn = this.snapshot.buttons.find((b) => b.role === 'next');
    const submitBtn = this.snapshot.buttons.find((b) => b.role === 'submit');
    if (nextBtn && s.autoNext) return this.goNext(nextBtn, gen);
    return this.review(submitBtn || null, gen);
  }

  async ask(f, gen, { prefix = '' } = {}) {
    if (!this.running) return;
    this.currentKey = f.key;
    this.pending = null;
    this.setMode('asking');
    this.send({ type: 'TB_HIGHLIGHT', fieldId: f.id }).catch(() => {});
    const q = this.questionText(f);
    const lead = [this.ackPrefix, prefix].filter(Boolean).join(' ');
    this.ackPrefix = '';
    if (lead) this.pushMsg('assistant', lead, { small: true });
    this.pushMsg('assistant', q, { fieldKey: f.key, question: true });
    await this.speak([lead, q].filter(Boolean).join(' '));
    if (gen !== this.gen || !this.running) return;
    return this.relisten(gen);
  }

  async relisten(gen) {
    if (gen !== this.gen || !this.running) return;
    const s = await this.getSettings();
    if (s.autoListen) return this.listen();
    this.setMode(this.pending && this.pending.type === 'submit' ? 'reviewing' : 'waiting');
  }

  async listen() {
    if (!this.running || this.mode === 'listening') return;
    this.speechOut.stop();
    const gen = this.gen;
    const prevMode = this.pending && this.pending.type === 'submit' ? 'reviewing' : 'waiting';
    this.setMode('listening');
    this.interim = '';
    let text = '';
    let alternatives = [];
    try {
      const f0 = this.currentField();
      const heard = await this.speechIn.listen({
        lang: this.lang,
        hint: f0
          ? [f0.label, (f0.options || []).slice(0, 12).map((o) => o.label).join(', '), (this.questions[f0.key] || {}).expected_format || '']
              .filter(Boolean)
              .join('. ')
          : '',
        onInterim: (t) => {
          this.interim = t;
          this.emit();
        },
        onLevel: (l) => this.dispatchEvent(new CustomEvent('level', { detail: l })),
      });
      text = heard.text;
      alternatives = heard.alternatives || [];
    } catch (e) {
      this.interim = '';
      if (gen === this.gen) this.setMode(prevMode);
      this.pushMsg('error', this.t('micError', { err: e.message }));
      this.dispatchEvent(new CustomEvent('micerror', { detail: e.message }));
      return;
    }
    this.interim = '';
    if (gen !== this.gen || !this.running) return;
    if (!text) {
      this.setMode(prevMode);
      return;
    }
    return this.handleUtterance(text, 'voice', alternatives);
  }

  /** Entry point for anything the user says or types. */
  async handleUtterance(text, source = 'typed', alternatives = []) {
    text = String(text || '').trim();
    if (!text) return;
    if (!this.running) {
      this.pushMsg('system', this.t('startFirst'));
      return;
    }
    this.speechIn.cancel();
    this.speechOut.stop();
    const gen = ++this.gen;
    this.pushMsg('user', text, { source });
    return this.processText(text, source, gen, alternatives);
  }

  async processText(text, source, gen, alternatives = []) {
    if (this.pending) return this.handlePending(text, source, gen);

    const cmd = parseCommand(text);
    if (cmd === 'stop') return this.pause();
    if (cmd === 'undo') return this.undoLast();

    const f = this.currentField();
    // Waiting for the user to fix something by hand (file upload, CAPTCHA…): any reply means "check again".
    if (this.mode === 'blocked' && (!f || isManual(f))) return this.recheck();
    if (!f) {
      if (this.mode === 'paused') return this.next();
      return this.say(this.t('notAsking'));
    }
    if (cmd === 'repeat') return this.ask(f, gen);
    if (cmd === 'skip') return this.skip(f, gen);
    if (cmd === 'explain') return this.explain(f, gen);
    if (cmd === 'back') return this.back(gen);

    // Dropdowns and radios: if what was heard IS one of the options, use it directly.
    // No model call means no chance of a hallucinated option.
    if (['select', 'radio'].includes(f.kind) && f.options && f.options.length) {
      const hit = matchOption(f.options, [text, ...alternatives]);
      if (hit) return this.commit(f, hit.label, source, gen, [], this.t('ack'));
    }

    this.setMode('thinking');
    let r;
    try {
      r = await chatJSON(P.interpret(this.contextFor(f, text, alternatives)));
    } catch (e) {
      if (gen === this.gen) await this.fail(e);
      return;
    }
    if (gen !== this.gen) return;

    switch (r.intent) {
      case 'skip':
        return this.skip(f, gen);
      case 'explain':
        return this.explain(f, gen);
      case 'repeat':
        return this.ask(f, gen);
      case 'back':
        return this.back(gen);
      case 'answer':
        return this.applyAnswer(f, r, source, gen);
      default:
        await this.say(r.reply || this.t('didntUnderstand'));
        return this.relisten(gen);
    }
  }

  contextFor(f, text, alternatives = []) {
    const q = this.questions[f.key] || {};
    return {
      form_purpose: this.meta?.form_purpose || '',
      form_language: this.meta?.form_language || 'en',
      user_language: this.lang,
      field: { ...P.compactField(f), answer_language: q.answer_language || 'any', expected_format: q.expected_format || '' },
      question_asked: this.questionText(f),
      user_said: text,
      other_possible_transcripts: alternatives.slice(0, 4),
      other_pending_fields: this.snapshot.fields
        .filter((x) => x.key !== f.key && !isManual(x) && !this.answers[x.key])
        .slice(0, 12)
        .map((x) => ({ ...P.compactField(x), answer_language: this.questions[x.key]?.answer_language || 'any' })),
      recent_answers: Object.values(this.answers)
        .filter((a) => a.status === 'filled')
        .slice(-6)
        .map((a) => ({ label: a.label, value: a.display })),
    };
  }

  async applyAnswer(f, r, source, gen) {
    const hints = this.questions[f.key] || {};
    let v = validateValue(f, r.value, hints);

    // Model left Bangla in an English-only field → one focused conversion call.
    if (!v.ok && v.code === 'NEEDS_ENGLISH') {
      try {
        const tr = await chatJSON(P.toEnglish(f, v.value));
        if (gen !== this.gen) return;
        v = validateValue(f, tr.value, { ...hints, answer_language: 'any' });
        if (v.ok && hasBangla(v.value)) v = { ok: false, error_bn: this.t('didntUnderstand'), error_en: this.t('didntUnderstand') };
      } catch {
        /* keep the validation error */
      }
    }
    if (!v.ok) {
      await this.say(this.lang === 'bn' ? v.error_bn : v.error_en);
      return this.relisten(gen);
    }

    const extras = (Array.isArray(r.extra_answers) ? r.extra_answers : [])
      .map((x) => ({ f: this.snapshot.fields.find((ff) => ff.id === x.id), value: x.value }))
      .filter((x) => x.f && x.f.key !== f.key && !isManual(x.f) && !this.answers[x.f.key])
      .map((x) => ({ f: x.f, v: validateValue(x.f, x.value, this.questions[x.f.key] || {}) }))
      .filter((x) => x.v.ok);

    const s = await this.getSettings();
    const confidence = typeof r.confidence === 'number' ? r.confidence : 1;
    // Read the value back before filling when it was spoken and either the model is unsure
    // or the field is one where a single wrong character matters (names, numbers, email, IDs).
    const mustConfirm =
      source === 'voice' &&
      ((s.confirmLowConfidence && (r.needs_confirmation || confidence < 0.8)) || (s.confirmCritical && isCritical(f)));
    if (mustConfirm) {
      this.pending = { type: 'value', field: f, value: v.value, source, extras, reply: r.reply };
      this.setMode('confirming');
      await this.say(this.t('confirmValue', { label: f.label, value: spellOut(v.display, f.kind) }));
      return this.relisten(gen);
    }
    return this.commit(f, v.value, source, gen, extras, r.reply);
  }

  async commit(f, value, source, gen, extras = [], reply = '') {
    const ok = await this.fillField(f, value, source);
    if (!ok) return this.relisten(gen);
    let filledExtras = 0;
    for (const x of extras) if (await this.fillField(x.f, x.v.value, source)) filledExtras++;
    this.errorAttempts[f.key] = 0;
    const ack = String(reply || '').trim();
    this.ackPrefix = ack && ack.length <= 60 ? ack : this.t('ack');
    if (filledExtras) this.ackPrefix += ' ' + this.t('extraFilled', { n: filledExtras });
    this.persist();
    // An answer can reveal or hide other fields (e.g. "Yes" → "Which scholarship?").
    // Re-read the page before choosing the next question.
    try {
      await sleep(120);
      await this.rescan();
      await this.ensureQuestions();
    } catch {
      /* keep the previous snapshot */
    }
    if (gen !== this.gen) return;
    return this.next();
  }

  /** Executes a validated fill on the page, verifies it and records history. */
  async fillField(f, value, source, { quiet = false, retried = false } = {}) {
    let res;
    try {
      res = await this.send({ type: 'TB_FILL', fieldId: f.id, value });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res || !res.ok) {
      if (!retried && res && res.error === 'FIELD_NOT_FOUND') {
        await this.rescan().catch(() => {});
        const nf = this.fieldByKey(f.key);
        if (nf) return this.fillField(nf, value, source, { quiet, retried: true });
      }
      if (!quiet) await this.say(this.t('fillFailed', { label: f.label }));
      return false;
    }
    const display = displayOf(value);
    this.history.push({
      id: crypto.randomUUID(),
      key: f.key,
      fieldId: f.id,
      label: f.label,
      prev: res.previous,
      value,
      display,
      source,
      verified: res.verified,
      ts: Date.now(),
    });
    this.answers[f.key] = {
      value,
      display,
      source,
      label: f.label,
      section: f.section,
      status: 'filled',
      verified: res.verified,
      ts: Date.now(),
    };
    f.empty = false;
    f.value = res.actual;
    this.errors = this.errors.filter((e) => e.fieldId !== f.id);
    this.pushMsg('fill', `${f.label}: ${display}`, { source, verified: res.verified, key: f.key });
    if (!res.verified) this.pushMsg('warn', this.t('verifyFailed', { label: f.label }));
    this.emit();
    return true;
  }

  async handlePending(text, source, gen) {
    const p = this.pending;
    const yn = parseYesNo(text);
    if (p.type === 'value') {
      if (yn === true) {
        this.pending = null;
        return this.commit(p.field, p.value, p.source, gen, p.extras, p.reply);
      }
      this.pending = null;
      if (yn === false) {
        await this.say(this.t('sayAgain'));
        return this.relisten(gen);
      }
      // Anything else is treated as a corrected answer for the same field.
      return this.processText(text, source, gen, alternatives);
    }
    if (p.type === 'submit') {
      if (yn === true) return this.submit(gen);
      if (yn === false) {
        this.pending = null;
        this.setMode('reviewing');
        return this.say(this.t('submitDeclined'));
      }
      await this.say(this.t('sayYesNo'));
      return this.relisten(gen);
    }
    this.pending = null;
    return this.processText(text, source, gen, alternatives);
  }

  async skip(f, gen) {
    this.answers[f.key] = { value: '', display: '', source: 'skipped', label: f.label, section: f.section, status: 'skipped', ts: Date.now() };
    this.pushMsg('skip', f.label, { key: f.key });
    this.ackPrefix = this.t('skipped') + (f.required ? ' ' + this.t('requiredLater') : '');
    this.persist();
    if (gen !== this.gen) return;
    return this.next();
  }

  async explain(f, gen) {
    const q = this.questions[f.key] || {};
    let text = (this.lang === 'bn' ? q.explain_bn : q.explain_en) || this.t('noExplain', { label: f.label });
    if (f.options && f.options.length && f.options.length <= 8) {
      text += ' ' + this.t('optionsAre', { list: f.options.map((o) => o.label).join(', ') });
    }
    await this.say(text);
    return this.relisten(gen);
  }

  async back(gen) {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (h.undone) continue;
      const f = this.fieldByKey(h.key);
      if (f && f.key !== this.currentKey) {
        delete this.answers[f.key];
        return this.ask(f, gen);
      }
    }
    const f = this.currentField();
    if (f) return this.ask(f, gen);
  }

  // ---------- undo / edit ----------
  async undoLast() {
    const h = [...this.history].reverse().find((x) => !x.undone);
    if (!h) return this.say(this.t('nothingToUndo'));
    return this.undo(h.id);
  }

  async undo(entryId) {
    const h = this.history.find((x) => x.id === entryId);
    if (!h || h.undone) return;
    const f = this.fieldByKey(h.key);
    if (!f) {
      this.pushMsg('warn', this.t('notOnPage'));
      return;
    }
    const gen = ++this.gen;
    this.speechIn.cancel();
    await this.send({ type: 'TB_RESTORE', fieldId: f.id, state: h.prev }).catch(() => null);
    h.undone = true;
    const earlier = [...this.history].reverse().find((x) => x.key === h.key && !x.undone);
    if (earlier) {
      this.answers[h.key] = { ...this.answers[h.key], value: earlier.value, display: earlier.display, source: earlier.source, status: 'filled' };
    } else {
      delete this.answers[h.key];
    }
    this.pushMsg('undo', this.t('undone', { label: h.label }));
    await this.rescan().catch(() => {});
    this.persist();
    if (!this.running || ['reviewing', 'done', 'paused'].includes(this.mode)) return;
    const nf = this.fieldByKey(h.key);
    if (nf && !this.answers[nf.key]) return this.ask(nf, gen);
  }

  /** Typed correction from the review/progress screen. */
  async editAnswer(key, text) {
    const f = this.fieldByKey(key);
    if (!f) {
      this.pushMsg('warn', this.t('notOnPage'));
      return false;
    }
    let v = validateValue(f, text, this.questions[key] || {});
    if (!v.ok && v.code === 'NEEDS_ENGLISH') {
      try {
        const tr = await chatJSON(P.toEnglish(f, v.value));
        v = validateValue(f, tr.value, { answer_language: 'any' });
      } catch {
        /* show original error */
      }
    }
    if (!v.ok) {
      this.pushMsg('error', this.lang === 'bn' ? v.error_bn : v.error_en);
      return false;
    }
    const ok = await this.fillField(f, v.value, 'typed');
    this.persist();
    return ok;
  }

  async askAgain(key) {
    const f = this.fieldByKey(key);
    if (!f) {
      this.pushMsg('warn', this.t('notOnPage'));
      return;
    }
    if (!this.running) return;
    this.speechIn.cancel();
    this.speechOut.stop();
    delete this.answers[key];
    this.pending = null;
    return this.ask(f, ++this.gen);
  }

  // ---------- validation & navigation ----------
  async handleValidationErrors(gen) {
    const e = this.errors[0];
    const f = this.snapshot.fields.find((x) => x.id === e.fieldId);
    let msg = e.message || '';
    if (this.lang === 'bn' && msg && !hasBangla(msg)) {
      try {
        msg = (await chatJSON(P.translate(msg, 'bn'))).translation || msg;
      } catch {
        /* keep English message */
      }
    }
    if (gen !== this.gen) return;
    const label = f ? f.label : e.label;
    const attempts = (this.errorAttempts[f ? f.key : e.fieldId] || 0) + 1;
    this.errorAttempts[f ? f.key : e.fieldId] = attempts;

    if (f && !isManual(f) && attempts <= 2) {
      delete this.answers[f.key];
      return this.ask(f, gen, { prefix: this.t('fieldError', { label, msg }) });
    }
    this.currentKey = f ? f.key : null;
    if (f) this.send({ type: 'TB_HIGHLIGHT', fieldId: f.id }).catch(() => {});
    this.setMode('blocked');
    await this.say(f && !isManual(f) ? this.t('blockedRepeat', { label }) : this.t('manualFix', { label, msg }));
  }

  /** Re-reads the page and continues — used after the user fixed something by hand. */
  async recheck() {
    if (!this.running) return;
    this.speechIn.cancel();
    this.speechOut.stop();
    this.pending = null;
    this.gen++;
    try {
      await this.rescan();
      await this.ensureQuestions();
    } catch (e) {
      return this.fail(e);
    }
    this.errorAttempts = {};
    return this.next();
  }

  async waitForChange(before, timeout = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await sleep(450);
      try {
        await this.rescan();
        if (this.snapshot.signature !== before) return true;
      } catch {
        /* page is loading */
      }
    }
    return false;
  }

  async goNext(btn, gen) {
    this.setMode('navigating');
    const lead = [this.ackPrefix, this.t('goingNext')].filter(Boolean).join(' ');
    this.ackPrefix = '';
    await this.say(lead);
    if (gen !== this.gen) return;
    const before = this.snapshot.signature;
    this.navigating = true;
    await this.send({ type: 'TB_CLICK', buttonId: btn.id }).catch(() => {});
    const changed = await this.waitForChange(before);
    this.navigating = false;
    if (gen !== this.gen || !this.running) return;

    if (!changed) {
      const v = await this.send({ type: 'TB_VALIDATE' }).catch(() => null);
      this.errors = (v && v.errors) || [];
      this.emit();
      if (this.errors.length) return this.handleValidationErrors(gen);
      this.setMode('blocked');
      return this.say(this.t('navStuck'));
    }
    try {
      await this.ensureQuestions();
    } catch (e) {
      return this.fail(e);
    }
    this.errors = [];
    this.persist();
    return this.next();
  }

  /** Called by the UI when the page changed without us (user clicked, SPA update, reload). */
  onPageChanged() {
    if (!this.running || this.navigating) return;
    clearTimeout(this._pcTimer);
    this._pcTimer = setTimeout(async () => {
      if (!this.running || this.navigating) return;
      const cur = this.currentKey;
      try {
        await this.rescan();
        await this.ensureQuestions();
      } catch {
        return;
      }
      const lost = cur && !this.fieldByKey(cur);
      const waitingForPage = ['reviewing', 'blocked', 'done'].includes(this.mode);
      if ((lost || waitingForPage) && this.mode !== 'done' && this.nextField()) {
        this.speechIn.cancel();
        this.speechOut.stop();
        this.pending = null;
        this.next();
      }
      this.emit();
    }, 700);
  }

  // ---------- review & submit ----------
  async review(submitBtn, gen) {
    this.currentKey = null;
    this.submitButtonId = submitBtn ? submitBtn.id : null;
    this.setMode('reviewing');
    this.dispatchEvent(new Event('review'));
    const filled = Object.values(this.answers).filter((a) => a.status === 'filled').length;
    const skipped = Object.values(this.answers).filter((a) => a.status === 'skipped').length;
    const parts = [this.ackPrefix, this.t('reviewIntro', { n: filled })];
    this.ackPrefix = '';
    if (skipped) parts.push(this.t('reviewSkipped', { n: skipped }));
    parts.push(submitBtn ? this.t('askSubmit') : this.t('noSubmitBtn'));
    if (submitBtn) this.pending = { type: 'submit' };
    await this.say(parts.filter(Boolean).join(' '));
    if (submitBtn) return this.relisten(gen);
  }

  /** Explicit confirmation from the UI button. */
  async confirmSubmit() {
    if (!this.running || !this.submitButtonId) return;
    this.speechIn.cancel();
    this.speechOut.stop();
    return this.submit(++this.gen);
  }

  async submit(gen) {
    this.pending = null;
    const btnId = this.submitButtonId;
    if (!btnId) return;
    this.setMode('submitting');
    await this.say(this.t('submitting'));
    this.navigating = true;
    const before = this.snapshot.signature;
    const r = await this.send({ type: 'TB_CLICK', buttonId: btnId }).catch(() => null);
    if (!r || !r.ok) {
      this.navigating = false;
      this.setMode('reviewing');
      return this.say(this.t('submitFailed'));
    }
    await this.waitForChange(before, 5000);
    this.navigating = false;
    const v = await this.send({ type: 'TB_VALIDATE' }).catch(() => null);
    const errors = (v && v.errors) || [];
    if (errors.length) {
      this.errors = errors;
      return this.handleValidationErrors(gen);
    }
    this.running = false;
    this.currentKey = null;
    this.setMode('done');
    await this.say(this.t('submitted'));
    await clearSession(this.origin).catch(() => {});
    this.send({ type: 'TB_SESSION_STATE', active: false }).catch(() => {});
  }

  // ---------- documents ----------
  async extractFromDocument(images) {
    if (!this.running || !this.snapshot) {
      this.pushMsg('system', this.t('startFirst'));
      return [];
    }
    const s = await this.getSettings();
    if (s.provider !== 'gemini' && images.some((i) => i.mimeType === 'application/pdf')) {
      this.pushMsg('error', this.t('docPdfNeedsGemini'));
      return [];
    }
    const fields = this.snapshot.fields.filter((f) => !isManual(f));
    const prevMode = this.mode;
    this.speechIn.cancel();
    this.setMode('thinking');
    let r;
    try {
      r = await chatJSON({
        ...P.extractDocument({
          form_purpose: this.meta?.form_purpose || '',
          form_language: this.meta?.form_language || 'en',
          fields: fields.map((f) => ({ ...P.compactField(f), answer_language: this.questions[f.key]?.answer_language || 'any' })),
        }),
        images,
      });
    } catch (e) {
      this.setMode(prevMode === 'listening' ? 'waiting' : prevMode);
      await this.fail(e);
      return [];
    } finally {
      images.length = 0; // drop document data from memory
    }
    this.candidates = (Array.isArray(r.candidates) ? r.candidates : [])
      .map((c) => {
        const f = fields.find((x) => x.id === c.id);
        if (!f) return null;
        const v = validateValue(f, c.value, this.questions[f.key] || {});
        if (!v.ok) return null;
        return {
          id: crypto.randomUUID(),
          key: f.key,
          label: f.label,
          value: v.value,
          display: v.display,
          evidence: String(c.evidence || '').slice(0, 120),
          confidence: typeof c.confidence === 'number' ? c.confidence : 0.8,
          docType: r.document_type || '',
          already: !!(this.answers[f.key] && this.answers[f.key].status === 'filled'),
        };
      })
      .filter(Boolean);
    this.setMode(prevMode === 'listening' ? 'waiting' : prevMode);
    await this.say(this.candidates.length ? this.t('docFound', { n: this.candidates.length }) : this.t('docNone'));
    return this.candidates;
  }

  async acceptCandidate(id) {
    const c = this.candidates.find((x) => x.id === id);
    if (!c) return;
    const f = this.fieldByKey(c.key);
    this.candidates = this.candidates.filter((x) => x.id !== id);
    if (!f) {
      this.pushMsg('warn', this.t('notOnPage'));
      return this.emit();
    }
    await this.fillField(f, c.value, 'document');
    this.persist();
    if (this.currentKey === c.key && this.running) {
      this.speechIn.cancel();
      this.speechOut.stop();
      return this.next();
    }
  }

  rejectCandidate(id) {
    this.candidates = this.candidates.filter((x) => x.id !== id);
    this.emit();
  }

  async acceptAllCandidates() {
    const ids = this.candidates.map((c) => c.id);
    const cur = this.currentKey;
    for (const id of ids) {
      const c = this.candidates.find((x) => x.id === id);
      if (!c) continue;
      const f = this.fieldByKey(c.key);
      this.candidates = this.candidates.filter((x) => x.id !== id);
      if (f) await this.fillField(f, c.value, 'document');
    }
    this.persist();
    if (this.running && cur && this.answers[cur]) {
      this.speechIn.cancel();
      this.speechOut.stop();
      return this.next();
    }
    this.emit();
  }

  // ---------- errors ----------
  async fail(e) {
    console.error('[TaskBridge]', e);
    const m = String((e && e.message) || e);
    let key = 'genericError';
    if (/NO_VISION_MODEL/.test(m)) key = 'docNoVision';
    else if (/NO_API_KEY|NO_MODEL/.test(m)) key = 'needKey';
    else if (e && (e.status === 401 || e.status === 403)) key = 'badKey';
    else if (/api key|invalid.*key|unauthori[sz]ed/i.test(m)) key = 'badKey';
    else if (e && e.status === 429) key = 'rateLimit';
    else if (/Failed to fetch|NetworkError|TIMEOUT/i.test(m)) key = 'network';
    else if (/Could not establish connection|Receiving end|NO_TAB|Cannot access|cannot be scripted|chrome:\/\//i.test(m)) key = 'pageAccess';
    const text = this.t(key) + (key === 'genericError' ? ` (${m.slice(0, 140)})` : '');
    this.pushMsg('error', text);
    this.setMode(this.running ? 'waiting' : 'idle');
    this.dispatchEvent(new CustomEvent('failure', { detail: { key } }));
    if (key !== 'genericError') await this.speak(this.t(key));
  }
}
