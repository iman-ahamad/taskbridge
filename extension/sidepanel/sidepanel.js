// TaskBridge — side panel controller.
// Wires the Agent (planner), speech in/out and the page to the UI:
// conversation, progress checklist, change history with undo, documents, review and settings.

import { Agent } from '../lib/agent.js';
import { SpeechIn, SpeechOut } from '../lib/speech.js';
import { loadSettings, saveSettings, hasApiKey } from '../lib/config.js';
import { T } from '../lib/i18n.js';
import { listModels, chatJSON } from '../lib/llm.js';
import { PING } from '../lib/prompts.js';
import { clearAllSessions } from '../lib/session.js';

// ------------------------------------------------------------------ state
let settings = await loadSettings();
const getSettings = async () => settings;

const speechOut = new SpeechOut(getSettings);
const speechIn = new SpeechIn(getSettings);
const agent = new Agent({ speechIn, speechOut, getSettings });

const CONTENT_FILES = chrome.runtime.getManifest().content_scripts[0].js;
const UNSUPPORTED_RE = /^(chrome|edge|about|brave|opera|vivaldi|chrome-extension|devtools|view-source):|chromewebstore\.google\.com|chrome\.google\.com\/webstore/i;

const ui = {
  tab: 'chat',
  activeTab: null, // { id, url, title, supported, count }
  micState: 'unknown',
  appliedLang: null,
  renderedMsgs: [],
  sigs: {},
  reviewOpen: false,
  settingsOpen: false,
};

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'),
  statusText: $('statusText'),
  progressStrip: $('progressStrip'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),
  otherTab: $('otherTab'),
  setupKey: $('setupKey'),
  setupMic: $('setupMic'),
  hero: $('hero'),
  heroPage: $('heroPage'),
  heroKicker: $('heroKicker'),
  heroTitle: $('heroTitle'),
  heroHint: $('heroHint'),
  btnStart: $('btnStart'),
  sayChips: $('sayChips'),
  tabs: $('tabs'),
  panes: $('panes'),
  nowCard: $('nowCard'),
  nowSection: $('nowSection'),
  nowField: $('nowField'),
  errorsBox: $('errorsBox'),
  errorsList: $('errorsList'),
  log: $('log'),
  docsNeeded: $('docsNeeded'),
  docsNeededList: $('docsNeededList'),
  progressList: $('progressList'),
  historyEmpty: $('historyEmpty'),
  historyList: $('historyList'),
  historyCount: $('historyCount'),
  docsCount: $('docsCount'),
  drop: $('drop'),
  docInput: $('docInput'),
  candHead: $('candHead'),
  candList: $('candList'),
  dock: $('dock'),
  interim: $('interim'),
  btnMic: $('btnMic'),
  micRing: $('micRing'),
  pauseLabel: $('pauseLabel'),
  typeForm: $('typeForm'),
  typeInput: $('typeInput'),
  review: $('review'),
  reviewList: $('reviewList'),
  reviewWarn: $('reviewWarn'),
  btnSubmit: $('btnSubmit'),
  settings: $('settings'),
  testResult: $('testResult'),
  toast: $('toast'),
};

// ------------------------------------------------------------------ helpers
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lang = () => (agent.running ? agent.lang : settings.userLang || 'bn');
const t = (key, vars) => T(lang(), key, vars);
const isManualKnown = (k) => !!(agent.knownFields[k] && agent.knownFields[k].manual);
const inSession = () => agent.tabId != null && (agent.running || agent.mode === 'done');
const timeOf = (ts) => new Date(ts).toLocaleTimeString(lang() === 'bn' ? 'bn-BD' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

let toastTimer;
function toast(text, ms = 2600) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}

function badge(source) {
  if (!source) return '';
  const icon = { voice: '🎙', typed: '⌨', document: '📄', manual: '✋', restored: '↺', skipped: '–' }[source] || '';
  return `<span class="badge ${esc(source)}" title="${esc(t('src_' + source))}">${icon} ${esc(t('src_' + source))}</span>`;
}

function displayValue(v) {
  if (Array.isArray(v)) return v.join(', ');
  if (v === true) return lang() === 'bn' ? 'হ্যাঁ' : 'Yes';
  if (v === false) return lang() === 'bn' ? 'না' : 'No';
  return String(v ?? '');
}

/** Rebuild a region only when its data actually changed (keeps focus/scroll stable). */
function changed(name, data) {
  const sig = JSON.stringify(data);
  if (ui.sigs[name] === sig) return false;
  ui.sigs[name] = sig;
  return true;
}

function isEditingInside(node) {
  const a = document.activeElement;
  return !!(a && node.contains(a) && a.closest('.edit-row'));
}

// ------------------------------------------------------------------ i18n
function applyI18n() {
  const l = lang();
  if (ui.appliedLang === l) return;
  ui.appliedLang = l;
  document.documentElement.lang = l;
  document.querySelectorAll('[data-i18n]').forEach((n) => (n.textContent = T(l, n.dataset.i18n)));
  document.querySelectorAll('[data-i18n-ph]').forEach((n) => (n.placeholder = T(l, n.dataset.i18nPh)));
  document.querySelectorAll('.lang button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === l)));
  const say =
    l === 'bn'
      ? ['আবার বলুন', 'বুঝিয়ে বলুন', 'বাদ দিন', 'আগের প্রশ্ন', 'মুছে দিন', 'থামুন']
      : ['Repeat', 'Explain', 'Skip', 'Go back', 'Undo', 'Stop'];
  el.sayChips.innerHTML = say.map((s) => `<span class="chip">“${esc(s)}”</span>`).join('');
  ui.sigs = {}; // force every region to re-render in the new language
  ui.renderedMsgs = [];
}

// ------------------------------------------------------------------ render
let rafId = 0;
function schedule() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    render();
  });
}

function render() {
  applyI18n();
  const mode = agent.mode;
  el.app.dataset.mode = mode;
  el.statusText.textContent = t('ui_' + mode);

  const session = inSession();
  el.setupKey.hidden = hasApiKey(settings);
  el.setupMic.hidden = ui.micState === 'granted' || ui.micState === 'unknown';
  el.hero.hidden = session;
  el.tabs.hidden = !session;
  el.panes.hidden = !session;
  el.dock.hidden = !session;
  el.otherTab.hidden = !(agent.running && ui.activeTab && ui.activeTab.id !== agent.tabId);

  if (!session) renderHero();
  renderProgressStrip(session);
  if (!session) return;

  el.pauseLabel.textContent = t(mode === 'paused' ? 'ui_resume' : 'ui_pause');
  el.interim.textContent = mode === 'listening' ? agent.interim || '…' : '';
  el.btnMic.disabled = ['analyzing', 'thinking', 'navigating', 'submitting'].includes(mode);

  renderNowCard();
  $('blockedBar').hidden = mode !== 'blocked';
  renderErrors();
  renderLog();
  if (ui.tab === 'progress') renderProgress();
  if (ui.tab === 'history') renderHistory();
  if (ui.tab === 'docs') renderDocs();
  const active = agent.history.filter((h) => !h.undone).length;
  el.historyCount.textContent = active ? String(active) : '';
  el.docsCount.textContent = agent.candidates.length ? String(agent.candidates.length) : '';
  if (ui.reviewOpen) renderReview();
}

function renderHero() {
  const a = ui.activeTab;
  el.heroPage.classList.toggle('found', !!(a && a.count > 0));
  if (!a) {
    el.heroKicker.textContent = '';
    el.heroTitle.textContent = '—';
    el.heroHint.textContent = t('ui_noForm');
    el.btnStart.disabled = true;
    return;
  }
  el.heroTitle.textContent = a.title || a.url || '—';
  if (!a.supported) {
    el.heroKicker.textContent = '';
    el.heroHint.textContent = t('ui_unsupported');
    el.btnStart.disabled = true;
  } else if (a.count > 0) {
    el.heroKicker.textContent = `● ${t('ui_formFound')} · ${t('ui_fieldsCount', { n: a.count })}`;
    el.heroHint.textContent = t('ui_startHint');
    el.btnStart.disabled = false;
  } else {
    el.heroKicker.textContent = '';
    el.heroHint.textContent = t('ui_noForm');
    el.btnStart.disabled = true;
  }
}

function progressNumbers() {
  const keys = Object.keys(agent.knownFields).filter((k) => !isManualKnown(k));
  const done = keys.filter((k) => agent.answers[k] && agent.answers[k].status === 'filled').length;
  return { done, total: keys.length };
}

function renderProgressStrip(session) {
  const { done, total } = progressNumbers();
  el.progressStrip.hidden = !session || !total;
  if (!total) return;
  el.progressFill.style.width = `${Math.round((done / total) * 100)}%`;
  el.progressText.textContent = t('ui_progress', { done, total });
}

function renderNowCard() {
  const f = agent.currentField();
  const show = !!f && !['reviewing', 'done'].includes(agent.mode);
  el.nowCard.hidden = !show;
  if (!show) return;
  if (!changed('now', [f.key, f.label, f.section, f.required, lang()])) return;
  el.nowSection.textContent = f.section || '';
  el.nowField.innerHTML = `${esc(f.label)}${f.required ? '<span class="req" title="required">*</span>' : ''}`;
}

function errorsWithLabels() {
  return agent.errors.map((e) => {
    const f = agent.snapshot && agent.snapshot.fields.find((x) => x.id === e.fieldId);
    return { label: f ? f.label : e.label, message: e.message, key: f ? f.key : null };
  });
}

function renderErrors() {
  const list = errorsWithLabels();
  el.errorsBox.hidden = !list.length;
  if (!changed('errors', list)) return;
  el.errorsList.innerHTML = list.map((e) => `<li><b>${esc(e.label)}:</b> ${esc(e.message)}</li>`).join('');
}

// ---------- conversation log (append-only rendering) ----------
function msgNode(m) {
  const li = document.createElement('li');
  li.className = 'msg';
  switch (m.role) {
    case 'assistant': {
      li.classList.add('assistant');
      if (m.question) li.classList.add('question');
      if (m.small) li.classList.add('small');
      if (m.intro) li.classList.add('intro');
      li.innerHTML = `${esc(m.text)}${m.small ? '' : '<button type="button" class="replay" title="Play" aria-label="Play">🔊</button>'}`;
      const b = li.querySelector('.replay');
      if (b) b.addEventListener('click', () => speechOut.speak(m.text, lang()));
      break;
    }
    case 'user':
      li.classList.add('user');
      li.innerHTML = `${esc(m.text)}<span class="src">${m.source === 'voice' ? '🎙' : '⌨'} ${esc(t('src_' + (m.source || 'typed')))}</span>`;
      break;
    case 'fill':
      li.classList.add('line', 'fill');
      if (!m.verified) li.classList.add('unverified');
      li.innerHTML = `<span class="tick">${m.verified ? '✓' : '!'}</span><span class="txt">${esc(m.text)}</span>${badge(m.source)}`;
      break;
    case 'skip':
      li.classList.add('line', 'skip');
      li.innerHTML = `<span>↷</span><span class="txt">${esc(m.text)} — ${esc(t('ui_status_skipped'))}</span>`;
      break;
    case 'undo':
      li.classList.add('line', 'undo');
      li.innerHTML = `<span>↺</span><span class="txt">${esc(m.text)}</span>`;
      break;
    case 'error':
    case 'warn':
    case 'system':
    default:
      li.classList.add(m.role || 'system');
      li.textContent = m.text;
  }
  return li;
}

function renderLog() {
  const msgs = agent.messages;
  const pane = el.log.parentElement;
  const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
  const r = ui.renderedMsgs;
  const consistent = r.length <= msgs.length && (r.length === 0 || (msgs[0] === r[0] && msgs[r.length - 1] === r[r.length - 1]));
  if (!consistent) {
    el.log.innerHTML = '';
    ui.renderedMsgs = [];
  }
  if (ui.renderedMsgs.length === msgs.length) return;
  const frag = document.createDocumentFragment();
  for (let i = ui.renderedMsgs.length; i < msgs.length; i++) frag.appendChild(msgNode(msgs[i]));
  el.log.appendChild(frag);
  ui.renderedMsgs = msgs.slice();
  if (nearBottom || !consistent) requestAnimationFrame(() => (pane.scrollTop = pane.scrollHeight));
}

// ---------- progress checklist ----------
function statusOf(key, errorKeys) {
  if (errorKeys.has(key)) return 'error';
  if (key === agent.currentKey && agent.running) return 'current';
  const a = agent.answers[key];
  if (a && a.status === 'filled') return 'filled';
  if (a && a.status === 'skipped') return 'skipped';
  if (isManualKnown(key)) return 'manual';
  return 'pending';
}

function groupedFields() {
  const errorKeys = new Set(errorsWithLabels().map((e) => e.key).filter(Boolean));
  const groups = new Map();
  for (const [key, k] of Object.entries(agent.knownFields)) {
    const sec = k.section || t('ui_sectionOther');
    if (!groups.has(sec)) groups.set(sec, []);
    const a = agent.answers[key];
    groups.get(sec).push({
      key,
      label: k.label,
      required: k.required,
      status: statusOf(key, errorKeys),
      value: a && a.status === 'filled' ? displayValue(a.display ?? a.value) : '',
      source: a && a.status === 'filled' ? a.source : '',
      onPage: !!agent.fieldByKey(key),
    });
  }
  return groups;
}

function itemHTML(it, { reviewMode = false } = {}) {
  const canAct = it.onPage && it.status !== 'manual';
  const acts = [];
  if (canAct && it.status === 'filled') acts.push(`<button type="button" class="act" data-edit="${esc(it.key)}">${esc(t('ui_edit'))}</button>`);
  if (canAct && agent.running && it.status !== 'current') acts.push(`<button type="button" class="act" data-ask="${esc(it.key)}">${esc(t('ui_askAgain'))}</button>`);
  const statusText = reviewMode && it.status === 'filled' ? '' : `<span class="muted small">${esc(t('ui_status_' + it.status))}</span>`;
  return `<li class="item ${it.status}" data-key="${esc(it.key)}">
      <span class="ic" aria-hidden="true"></span>
      <span class="lbl"><span class="name">${esc(it.label)}${it.required ? '<span class="req"> *</span>' : ''}</span>
        ${it.value ? `<span class="val">${esc(it.value)}</span>` : ''}</span>
      <span class="side">${it.source ? badge(it.source) : statusText}${acts.join('')}</span>
    </li>`;
}

function renderProgress() {
  if (isEditingInside(el.progressList)) return;
  const groups = groupedFields();
  const docs = ((agent.meta && agent.meta.required_documents) || []).map((d) => (lang() === 'bn' ? d.bn || d.en : d.en || d.bn)).filter(Boolean);
  const data = { g: [...groups.entries()], docs, running: agent.running };
  if (!changed('progress', data)) return;

  el.docsNeeded.hidden = !docs.length;
  el.docsNeededList.innerHTML = docs.map((d) => `<li>${esc(d)}</li>`).join('');

  let html = '';
  for (const [sec, items] of groups) {
    const fillable = items.filter((i) => i.status !== 'manual');
    const done = fillable.filter((i) => i.status === 'filled').length;
    const blocked = items.some((i) => i.status === 'error');
    const complete = fillable.length > 0 && done === fillable.length;
    html += `<div class="sec">
      <div class="sec-head"><h3>${esc(sec)}</h3>
        <span class="state ${blocked ? 'blocked' : complete ? 'complete' : ''}">${blocked ? '⚠ ' : complete ? '✓ ' : ''}${esc(
      t('ui_progress', { done, total: fillable.length })
    )}</span></div>
      <ul class="items">${items.map((i) => itemHTML(i)).join('')}</ul></div>`;
  }
  el.progressList.innerHTML = html;
}

// Inline editing shared by the progress tab and the review sheet.
function openEditor(container, key) {
  const f = agent.fieldByKey(key);
  const row = container.querySelector(`.item[data-key="${CSS.escape(key)}"]`);
  if (!f || !row) return;
  const a = agent.answers[key];
  const cur = a ? a.value : '';
  let control;
  if (['select', 'radio'].includes(f.kind) && f.options && f.options.length) {
    control = `<select>${f.options
      .map((o) => `<option value="${esc(o.label)}" ${o.label === cur ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('')}</select>`;
  } else if (f.kind === 'checkbox') {
    control = `<select><option value="yes" ${cur === true ? 'selected' : ''}>${esc(displayValue(true))}</option><option value="no" ${
      cur === false ? 'selected' : ''
    }>${esc(displayValue(false))}</option></select>`;
  } else {
    const ph = f.options && f.options.length ? f.options.map((o) => o.label).join(', ') : f.placeholder || '';
    control = `<input type="text" value="${esc(Array.isArray(cur) ? cur.join(', ') : cur)}" placeholder="${esc(ph)}" />`;
  }
  row.classList.add('editing');
  row.innerHTML = `<div><strong>${esc(f.label)}</strong>
    <div class="edit-row">${control}
      <button type="button" class="btn small primary" data-save>${esc(t('ui_save'))}</button>
      <button type="button" class="btn small" data-cancel>✕</button></div></div>`;
  const input = row.querySelector('input,select');
  input.focus();
  if (input.select && input.tagName === 'INPUT') input.select();
  const done = async (save) => {
    if (save) {
      row.querySelector('[data-save]').disabled = true;
      const ok = await agent.editAnswer(key, input.value);
      if (!ok) {
        row.querySelector('[data-save]').disabled = false;
        const last = agent.messages[agent.messages.length - 1];
        toast(last && last.role === 'error' ? last.text : t('didntUnderstand'), 3500);
        return;
      }
      toast(`✓ ${f.label}`);
    }
    ui.sigs = {};
    document.activeElement && document.activeElement.blur();
    render();
  };
  row.querySelector('[data-save]').addEventListener('click', () => done(true));
  row.querySelector('[data-cancel]').addEventListener('click', () => done(false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
}

function onListClick(container) {
  return (e) => {
    const edit = e.target.closest('[data-edit]');
    const ask = e.target.closest('[data-ask]');
    if (edit) openEditor(container, edit.dataset.edit);
    if (ask) {
      closeReview();
      switchTab('chat');
      agent.askAgain(ask.dataset.ask);
    }
  };
}
el.progressList.addEventListener('click', onListClick(el.progressList));

// ---------- change history ----------
function renderHistory() {
  const items = [...agent.history].reverse();
  const data = items.map((h) => [h.id, h.undone, h.display, h.verified, !!agent.fieldByKey(h.key)]);
  if (!changed('history', data)) return;
  el.historyEmpty.hidden = items.length > 0;
  el.historyList.innerHTML = items
    .map((h) => {
      const prev = h.prev && h.prev.value !== undefined ? displayValue(h.prev.value) : '';
      const canUndo = !h.undone && !!agent.fieldByKey(h.key);
      return `<li class="hist ${h.undone ? 'undone' : ''}">
        <div><div><b>${esc(h.label)}</b>: <span class="val">${esc(displayValue(h.display))}</span></div>
          <div class="meta">${badge(h.source)}
            <span>${esc(timeOf(h.ts))}</span>
            ${prev ? `<span class="from">${esc(prev)}</span>` : ''}
            ${h.verified ? '' : '<span title="not verified">⚠</span>'}
            ${h.undone ? `<span>${esc(t('ui_undone'))}</span>` : ''}</div></div>
        ${canUndo ? `<button type="button" class="btn small" data-undo="${esc(h.id)}">↺ ${esc(t('ui_undo'))}</button>` : ''}
      </li>`;
    })
    .join('');
}
el.historyList.addEventListener('click', (e) => {
  const b = e.target.closest('[data-undo]');
  if (b) {
    b.disabled = true;
    agent.undo(b.dataset.undo);
  }
});

// ---------- documents ----------
function renderDocs() {
  const data = agent.candidates.map((c) => [c.id, c.display]);
  if (!changed('docs', [data, lang()])) return;
  el.candHead.hidden = agent.candidates.length < 2;
  el.candList.innerHTML = agent.candidates
    .map(
      (c) => `<li class="cand ${c.already ? 'already' : ''}">
        <div class="top-line"><span>${esc(c.label)}</span><span>${esc(c.docType)} · ${Math.round(c.confidence * 100)}%</span></div>
        <div class="v">${esc(displayValue(c.display))}</div>
        ${c.evidence ? `<div class="ev">“${esc(c.evidence)}”</div>` : ''}
        <div class="btns">
          <button type="button" class="btn small primary" data-accept="${esc(c.id)}">${esc(t('ui_accept'))}</button>
          <button type="button" class="btn small" data-reject="${esc(c.id)}">${esc(t('ui_reject'))}</button>
        </div></li>`
    )
    .join('');
}
el.candList.addEventListener('click', (e) => {
  const a = e.target.closest('[data-accept]');
  const r = e.target.closest('[data-reject]');
  if (a) agent.acceptCandidate(a.dataset.accept);
  if (r) agent.rejectCandidate(r.dataset.reject);
});
$('btnAcceptAll').addEventListener('click', () => agent.acceptAllCandidates());

const MAX_DOC_BYTES = 15 * 1024 * 1024;

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Images are downscaled (keeps the request small and inside free-tier limits). */
async function fileToPart(file) {
  if (file.size > MAX_DOC_BYTES) throw new Error('FILE_TOO_BIG');
  if (file.type === 'application/pdf') {
    return { mimeType: 'application/pdf', base64: toBase64(await file.arrayBuffer()) };
  }
  if (!file.type.startsWith('image/')) throw new Error('UNSUPPORTED_FILE');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return { mimeType: 'image/jpeg', base64: toBase64(await blob.arrayBuffer()) };
}

async function handleFiles(files) {
  const list = [...files].slice(0, 4);
  if (!list.length) return;
  if (!agent.running) return toast(t('startFirst'));
  el.drop.classList.add('busy');
  try {
    const parts = [];
    for (const f of list) {
      try {
        parts.push(await fileToPart(f));
      } catch (e) {
        toast(e.message === 'FILE_TOO_BIG' ? `${f.name}: > 15 MB` : `${f.name}: ${lang() === 'bn' ? 'এই ফাইল পড়া যায়নি' : 'could not read this file'}`, 3500);
      }
    }
    if (parts.length) await agent.extractFromDocument(parts); // agent empties `parts` afterwards
  } finally {
    el.drop.classList.remove('busy');
    el.docInput.value = '';
    ui.sigs.docs = null;
    render();
  }
}
el.docInput.addEventListener('change', () => handleFiles(el.docInput.files));
el.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.drop.classList.add('over');
});
el.drop.addEventListener('dragleave', () => el.drop.classList.remove('over'));
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  el.drop.classList.remove('over');
  handleFiles(e.dataTransfer.files);
});

// ---------- review sheet ----------
function openReview() {
  ui.reviewOpen = true;
  el.review.hidden = false;
  ui.sigs.review = null;
  renderReview();
}
function closeReview() {
  ui.reviewOpen = false;
  el.review.hidden = true;
}

function renderReview() {
  if (isEditingInside(el.reviewList)) return;
  const groups = groupedFields();
  const errors = errorsWithLabels();
  const skippedReq = Object.entries(agent.knownFields)
    .filter(([k, f]) => f.required && !f.manual && (!agent.answers[k] || agent.answers[k].status !== 'filled'))
    .map(([, f]) => f.label);
  const canSubmit = agent.running && !!agent.submitButtonId && agent.mode !== 'submitting';
  if (!changed('review', [[...groups.entries()], errors, skippedReq, canSubmit])) return;

  const warns = [];
  if (errors.length) warns.push(`<b>${esc(t('ui_errorsTitle'))}:</b> ${errors.map((e) => esc(`${e.label} — ${e.message}`)).join('; ')}`);
  if (skippedReq.length) warns.push(esc(t('ui_skippedRequired', { list: skippedReq.join(', ') })));
  el.reviewWarn.hidden = !warns.length;
  el.reviewWarn.innerHTML = warns.join('<br>');

  let html = '';
  for (const [sec, items] of groups) {
    html += `<div class="sec"><div class="sec-head"><h3>${esc(sec)}</h3></div>
      <ul class="items">${items.map((i) => itemHTML(i, { reviewMode: true })).join('')}</ul></div>`;
  }
  el.reviewList.innerHTML = html;
  el.btnSubmit.disabled = !canSubmit;
  el.btnSubmit.hidden = agent.mode === 'done';
}
el.reviewList.addEventListener('click', onListClick(el.reviewList));
$('btnCloseReview').addEventListener('click', closeReview);
$('btnReviewTop').addEventListener('click', openReview);
el.btnSubmit.addEventListener('click', async () => {
  el.btnSubmit.disabled = true;
  await agent.confirmSubmit();
  if (agent.mode === 'done') closeReview();
  render();
});
$('btnSubmitSelf').addEventListener('click', () => {
  closeReview();
  agent.stop();
  toast(lang() === 'bn' ? 'ঠিক আছে, সব ঘর পূরণ করা আছে — আপনি নিজে জমা দিন।' : 'All set — you can submit the form yourself.', 4000);
});

// ------------------------------------------------------------------ tabs
function switchTab(name) {
  ui.tab = name;
  document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.pane').forEach((p) => (p.hidden = p.dataset.pane !== name));
  ui.sigs[name] = null;
  render();
}
el.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('[role="tab"]');
  if (b) switchTab(b.dataset.tab);
});

// ------------------------------------------------------------------ active tab / page detection
async function pingTab(tab) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'TB_PING' });
  } catch {
    // Page was open before the extension was installed/reloaded → inject the content scripts.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
      await new Promise((r) => setTimeout(r, 200));
      return await chrome.tabs.sendMessage(tab.id, { type: 'TB_PING' });
    } catch {
      return null;
    }
  }
}

let refreshSeq = 0;
async function refreshActiveTab() {
  const seq = ++refreshSeq;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (seq !== refreshSeq) return;
  if (!tab) {
    ui.activeTab = null;
    return schedule();
  }
  const url = tab.url || tab.pendingUrl || '';
  const info = { id: tab.id, url, title: tab.title || url, supported: !!url && !UNSUPPORTED_RE.test(url), count: 0 };
  ui.activeTab = info;
  schedule();
  if (!info.supported || tab.status === 'loading') return;
  const r = await pingTab(tab);
  if (seq !== refreshSeq) return;
  if (r && r.ok) {
    info.count = r.count;
    info.title = r.title || info.title;
  } else if (/^file:/i.test(url)) {
    info.supported = false; // "Allow access to file URLs" is off
  }
  schedule();
}

chrome.tabs.onActivated.addListener(() => refreshActiveTab());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') {
    if (tabId === agent.tabId && agent.running) agent.onPageChanged(); // full page load on a multi-page form
    if (ui.activeTab && tabId === ui.activeTab.id) refreshActiveTab();
  } else if (info.title && ui.activeTab && tabId === ui.activeTab.id) {
    ui.activeTab.title = info.title;
    schedule();
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === agent.tabId && agent.running) agent.stop();
});
chrome.windows.onFocusChanged.addListener(() => refreshActiveTab());

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== 'string') return;
  const tabId = sender.tab && sender.tab.id;
  if (msg.type === 'TB_PAGE_CHANGED' && tabId === agent.tabId) agent.onPageChanged();
  if ((msg.type === 'TB_PAGE_CHANGED' || msg.type === 'TB_FORM_DETECTED') && ui.activeTab && tabId === ui.activeTab.id && !agent.running) {
    ui.activeTab.count = msg.count || 0;
    schedule();
  }
  if (msg.type === 'TB_MIC_GRANTED') checkMic();
});

// ------------------------------------------------------------------ microphone permission
async function checkMic() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    ui.micState = p.state;
    p.onchange = () => {
      ui.micState = p.state;
      schedule();
    };
  } catch {
    ui.micState = 'unknown';
  }
  schedule();
}
$('btnMicSetup').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('permission/permission.html') }));

// ------------------------------------------------------------------ session controls
async function startSession() {
  if (!hasApiKey(settings)) {
    openSettings();
    return toast(t('needKey'), 3500);
  }
  await refreshActiveTab();
  const a = ui.activeTab;
  if (!a || !a.supported) return toast(t('ui_unsupported'), 3500);
  closeReview();
  switchTab('chat');
  ui.renderedMsgs = [];
  el.log.innerHTML = '';
  agent.start(a.id);
}

el.btnStart.addEventListener('click', startSession);
$('btnSwitchHere').addEventListener('click', () => {
  agent.stop();
  startSession();
});

el.btnMic.addEventListener('click', () => {
  const m = agent.mode;
  if (!agent.running) return startSession();
  if (m === 'listening') return speechIn.stop(); // finish now and use what was heard
  if (m === 'paused') return agent.resume();
  if (['analyzing', 'thinking', 'navigating', 'submitting'].includes(m)) return;
  if (m === 'asking') {
    // Interrupt the question and listen straight away.
    speechOut.stop();
    if (!settings.autoListen) setTimeout(() => agent.listen(), 60);
    return;
  }
  agent.listen();
});

$('btnPause').addEventListener('click', () => {
  if (!agent.running) return;
  if (agent.mode === 'paused') agent.resume();
  else agent.pause();
});
$('btnUndo').addEventListener('click', () => {
  speechIn.cancel();
  agent.undoLast();
});
$('btnStop').addEventListener('click', () => {
  agent.stop();
  closeReview();
  refreshActiveTab();
});

el.typeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.typeInput.value.trim();
  if (!text) return;
  el.typeInput.value = '';
  if (!agent.running) return toast(t('startFirst'));
  agent.handleUtterance(text, 'typed');
});

$('btnRecheck').addEventListener('click', () => agent.recheck());

el.nowCard.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  const f = agent.currentField();
  if (!b || !f || !agent.running) return;
  speechIn.cancel();
  speechOut.stop();
  agent.pending = null;
  const gen = ++agent.gen;
  if (b.dataset.cmd === 'explain') agent.explain(f, gen);
  else if (b.dataset.cmd === 'repeat') agent.ask(f, gen);
  else if (b.dataset.cmd === 'skip') agent.skip(f, gen);
});

document.querySelector('.lang').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-lang]');
  if (!b) return;
  const l = b.dataset.lang;
  settings = await saveSettings({ userLang: l });
  $('userLang').value = l;
  if (agent.running) await agent.setLang(l);
  schedule();
});

// Keyboard: Space = talk / stop talking, Esc = stop speaking or close a sheet.
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable);
  if (e.key === 'Escape') {
    if (ui.settingsOpen) return closeSettings();
    if (ui.reviewOpen) return closeReview();
    speechOut.stop();
  }
  if (e.code === 'Space' && !typing && !e.target.closest('button') && inSession()) {
    e.preventDefault();
    el.btnMic.click();
  }
});

// ------------------------------------------------------------------ agent events
agent.addEventListener('change', schedule);
agent.addEventListener('review', () => openReview());
agent.addEventListener('level', (e) => el.btnMic.style.setProperty('--lvl', Math.min(1, e.detail * 4).toFixed(3)));
agent.addEventListener('micerror', (e) => {
  if (/MIC_BLOCKED|NotAllowed|Permission/i.test(e.detail)) {
    ui.micState = 'denied';
    schedule();
  }
});
agent.addEventListener('failure', (e) => {
  if (e.detail.key === 'needKey' || e.detail.key === 'badKey') openSettings();
});

// ------------------------------------------------------------------ settings
const TEXT_KEYS = ['groqKey', 'groqModel', 'groqVisionModel', 'geminiKey', 'geminiModel', 'compatBaseUrl', 'compatKey', 'compatModel'];
const BOOL_KEYS = ['tts', 'onlineBanglaVoice', 'autoListen', 'autoNext', 'confirmLowConfidence', 'confirmCritical'];

function fillSettingsForm() {
  for (const k of TEXT_KEYS) $(k).value = settings[k] || '';
  $('groqKey2').value = settings.groqKey || '';
  for (const k of BOOL_KEYS) $(k).checked = !!settings[k];
  $('sttEngine').value = settings.sttEngine;
  $('userLang').value = settings.userLang;
  $('speechRate').value = settings.speechRate;
  showProvider(settings.provider);
  updateVoiceInfo();
}

function showProvider(p) {
  document.querySelectorAll('#providerSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.provider === p)));
  document.querySelectorAll('.prov').forEach((d) => d.classList.toggle('on', d.dataset.prov === p));
  $('whisperKeyRow').hidden = !($('sttEngine').value === 'whisper' && p !== 'groq');
  el.testResult.textContent = '';
  el.testResult.className = 'test-result';
}

function updateVoiceInfo() {
  const bn = speechOut.hasVoice('bn');
  const sttOk = speechIn.browserSupported;
  const parts = [];
  parts.push(bn ? '✓ Bangla voice installed on this computer.' : settings.onlineBanglaVoice ? 'No Bangla system voice — the online Bangla voice will be used.' : 'No Bangla system voice installed.');
  if (!sttOk && settings.sttEngine === 'browser') parts.push('This browser has no built-in speech recognition — choose Groq Whisper.');
  $('voiceInfo').textContent = parts.join(' ');
}

function openSettings() {
  fillSettingsForm();
  ui.settingsOpen = true;
  el.settings.hidden = false;
}
function closeSettings() {
  ui.settingsOpen = false;
  el.settings.hidden = true;
  schedule();
}
$('btnSettings').addEventListener('click', openSettings);
$('btnOpenSettings').addEventListener('click', openSettings);
$('btnCloseSettings').addEventListener('click', closeSettings);

let saveTimer;
async function persistPatch(patch, quiet = true) {
  settings = await saveSettings(patch);
  if (!quiet) toast(T(settings.userLang, 'ui_saved'), 1400);
  schedule();
}
for (const k of TEXT_KEYS) {
  $(k).addEventListener('input', () => {
    clearTimeout(saveTimer);
    const v = $(k).value.trim();
    if (k === 'groqKey') $('groqKey2').value = v;
    saveTimer = setTimeout(() => persistPatch({ [k]: v }), 350);
  });
}
$('groqKey2').addEventListener('input', () => {
  clearTimeout(saveTimer);
  const v = $('groqKey2').value.trim();
  $('groqKey').value = v;
  saveTimer = setTimeout(() => persistPatch({ groqKey: v }), 350);
});
for (const k of BOOL_KEYS) {
  $(k).addEventListener('change', () => {
    persistPatch({ [k]: $(k).checked }, false).then(updateVoiceInfo);
  });
}
$('sttEngine').addEventListener('change', async () => {
  await persistPatch({ sttEngine: $('sttEngine').value }, false);
  showProvider(settings.provider);
  updateVoiceInfo();
});
$('userLang').addEventListener('change', async () => {
  const l = $('userLang').value;
  await persistPatch({ userLang: l }, false);
  if (agent.running) await agent.setLang(l);
});
$('speechRate').addEventListener('change', () => persistPatch({ speechRate: Number($('speechRate').value) }, false));
$('providerSeg').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-provider]');
  if (!b) return;
  await persistPatch({ provider: b.dataset.provider });
  showProvider(b.dataset.provider);
  $('modelList').innerHTML = '';
});
document.querySelectorAll('[data-eye]').forEach((b) =>
  b.addEventListener('click', () => {
    const i = $(b.dataset.eye);
    i.type = i.type === 'password' ? 'text' : 'password';
  })
);

async function flushSettingsForm() {
  clearTimeout(saveTimer);
  const patch = {};
  for (const k of TEXT_KEYS) patch[k] = $(k).value.trim();
  settings = await saveSettings(patch);
}

function setTest(text, ok) {
  el.testResult.textContent = text;
  el.testResult.className = `test-result ${ok ? 'ok' : 'bad'}`;
}

function explainError(e) {
  const m = String((e && e.message) || e);
  if (/NO_API_KEY/.test(m)) return 'Add an API key first.';
  if (/NO_MODEL/.test(m)) return 'Choose a model (press "Load models").';
  if (e && (e.status === 401 || e.status === 403)) return 'The key was rejected. Copy it again from the provider website.';
  if (/NO_VISION_MODEL/.test(m)) return 'No image-reading model on this account — use Google Gemini for documents.';
  if (e && [400, 404].includes(e.status) && /model/i.test(m)) return 'This model is not available and no replacement was found. Press "Load models" and pick one.';
  if (e && e.status === 429) return 'Free limit reached for now. Wait a minute or switch provider.';
  if (/Failed to fetch|NetworkError|TIMEOUT/i.test(m)) return 'Could not reach the server. Check the internet (or that the local server is running).';
  return m.slice(0, 200);
}

$('btnTest').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  setTest('…', true);
  try {
    await flushSettingsForm();
    const r = await chatJSON(PING);
    if (!r || typeof r !== 'object') throw new Error('Unexpected reply');
    settings = await loadSettings();
    fillSettingsForm();
    const used = settings.provider === 'gemini' ? settings.geminiModel : settings.provider === 'groq' ? settings.groqModel : settings.compatModel;
    setTest(`✓ ${T(settings.userLang, 'ui_testOk')} — ${used}`, true);
  } catch (err) {
    setTest(`✕ ${explainError(err)}`, false);
  } finally {
    b.disabled = false;
    schedule();
  }
});

$('btnLoadModels').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try {
    await flushSettingsForm();
    const p = settings.provider;
    const key = p === 'gemini' ? settings.geminiKey : p === 'groq' ? settings.groqKey : settings.compatKey;
    const models = await listModels({ provider: p, key, baseUrl: settings.compatBaseUrl });
    const shown = p === 'openai_compat' && /openrouter/i.test(settings.compatBaseUrl) ? models.filter((m) => m.endsWith(':free')) : models;
    $('modelList').innerHTML = shown.map((m) => `<option value="${esc(m)}"></option>`).join('');
    setTest(`✓ ${T(settings.userLang, 'ui_modelsLoaded', { n: shown.length })} — click the model box to choose.`, true);
  } catch (err) {
    setTest(`✕ ${explainError(err)}`, false);
  } finally {
    b.disabled = false;
  }
});

$('btnTestVoice').addEventListener('click', () => {
  const l = settings.userLang;
  speechOut.speak(l === 'bn' ? 'আমি টাস্কব্রিজ। আমি আপনাকে ফর্ম পূরণ করতে সাহায্য করব।' : "I'm TaskBridge. I'll help you fill in forms.", l);
});

$('btnClearData').addEventListener('click', async () => {
  const msg = settings.userLang === 'bn' ? 'সব সংরক্ষিত সেশন মুছে ফেলবেন?' : 'Delete all saved sessions?';
  if (!confirm(msg)) return;
  await clearAllSessions();
  toast(T(settings.userLang, 'ui_cleared'));
});

// Settings may also change from the welcome page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.tbSettings) return;
  loadSettings().then((s) => {
    settings = s;
    if (!agent.running) ui.appliedLang = null;
    schedule();
  });
});

speechOut.addEventListener('state', schedule);
if (window.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', () => ui.settingsOpen && updateVoiceInfo());

// ------------------------------------------------------------------ boot
checkMic();
refreshActiveTab();
render();
