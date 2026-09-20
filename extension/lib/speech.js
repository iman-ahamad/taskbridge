// TaskBridge — voice in / voice out.
//  Input : Chrome Web Speech API (free, no key; bn-BD / en-US)  or  Groq Whisper (free key, strong Bangla).
//  Output: system speechSynthesis voices; if the computer has no Bangla voice, an optional
//          online Bangla voice is used so the assistant can still talk.

import { transcribeWhisper } from './llm.js';

function splitText(text, max = 180) {
  const parts = String(text).split(/(?<=[।.!?\n])\s+/);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + ' ' + p).length > max) {
      out.push(cur);
      cur = p;
    } else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) out.push(cur);
  return out.flatMap((c) => (c.length <= max ? [c] : c.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g')) || [c]));
}

export class SpeechOut extends EventTarget {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.voices = [];
    this.audio = null;
    this._cancel = null;
    this.speaking = false;
    const load = () => (this.voices = window.speechSynthesis ? speechSynthesis.getVoices() : []);
    load();
    if (window.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', load);
  }

  pickVoice(lang) {
    const cands = this.voices.filter((v) => (v.lang || '').toLowerCase().startsWith(lang));
    return (
      cands.find((v) => /natural|online|neural/i.test(v.name)) ||
      cands.find((v) => /google/i.test(v.name)) ||
      cands.find((v) => /bd|in|us|gb/i.test(v.lang)) ||
      cands[0] ||
      null
    );
  }

  hasVoice(lang) {
    return !!this.pickVoice(lang);
  }

  stop() {
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    if (this._cancel) this._cancel();
    this._setSpeaking(false);
  }

  _setSpeaking(v) {
    if (this.speaking === v) return;
    this.speaking = v;
    this.dispatchEvent(new Event('state'));
  }

  /** Resolves when speech finishes (or is interrupted). */
  async speak(text, lang = 'bn') {
    const s = await this.getSettings();
    if (!s.tts || !text) return;
    this.stop();
    const chunks = splitText(text);
    const voice = this.pickVoice(lang);
    this._setSpeaking(true);
    try {
      if (voice) {
        for (const c of chunks) if (!(await this._utter(c, voice, s.speechRate))) return;
        return;
      }
      if (lang === 'bn' && s.onlineBanglaVoice) {
        for (const c of chunks) if (!(await this._playOnline(c, 'bn', s.speechRate))) return;
        return;
      }
      this.dispatchEvent(new CustomEvent('novoice', { detail: { lang } }));
    } finally {
      this._setSpeaking(false);
    }
  }

  _utter(text, voice, rate) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = rate || 1;
      let done = false;
      const fin = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        this._cancel = null;
        resolve(ok);
      };
      u.onend = () => fin(true);
      u.onerror = (e) => fin(!['interrupted', 'canceled'].includes(e.error));
      this._cancel = () => fin(false);
      // Chrome sometimes never fires onend; don't hang the conversation.
      const watchdog = setTimeout(() => fin(true), 6000 + text.length * 170);
      speechSynthesis.speak(u);
    });
  }

  _playOnline(text, lang, rate) {
    return new Promise((resolve) => {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(text)}`;
      const a = new Audio(url);
      a.playbackRate = Math.min(Math.max(rate || 1, 0.7), 1.5);
      this.audio = a;
      let done = false;
      const fin = (ok) => {
        if (done) return;
        done = true;
        this._cancel = null;
        resolve(ok);
      };
      a.onended = () => fin(true);
      a.onerror = () => fin(true);
      this._cancel = () => fin(false);
      a.play().catch(() => fin(true));
    });
  }
}

export class SpeechIn {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.active = null;
  }

  get browserSupported() {
    return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  }

  /** Resolves with the final transcript ('' if nothing was heard or it was cancelled). */
  /**
   * Listens once.
   * @param {{lang?:string, hint?:string, onInterim?:Function, onLevel?:Function}} o
   *   hint: words the recogniser should expect (field label, option names) — improves accuracy a lot.
   * @returns {Promise<{text:string, alternatives:string[]}>}
   */
  async listen({ lang = 'bn', hint = '', onInterim, onLevel } = {}) {
    this.cancel();
    const s = await this.getSettings();
    if (s.sttEngine === 'whisper' && s.groqKey) return this._whisper(lang, onInterim, onLevel, hint);
    return this._browser(lang, onInterim);
  }

  stop() {
    if (this.active) this.active.stop();
  }

  cancel() {
    if (this.active) this.active.cancel();
  }

  _browser(lang, onInterim) {
    return new Promise((resolve, reject) => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return reject(new Error('STT_UNSUPPORTED'));
      const r = new SR();
      r.lang = lang === 'bn' ? 'bn-BD' : 'en-US';
      r.interimResults = true;
      r.continuous = false;
      r.maxAlternatives = 5; // keep the runner-up readings; the interpreter picks the one that fits the field
      let finalText = '';
      const alts = [];
      let cancelled = false;
      let settled = false;
      r.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) {
            finalText += res[0].transcript + ' ';
            for (let k = 1; k < res.length && k < 5; k++) alts.push(String(res[k].transcript || '').trim());
          }
          else interim += res[0].transcript;
        }
        onInterim && onInterim(`${finalText}${interim}`.trim());
      };
      r.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        settled = true;
        this.active = null;
        reject(new Error(e.error === 'not-allowed' ? 'MIC_BLOCKED' : `STT_${e.error}`));
      };
      r.onend = () => {
        if (settled) return;
        settled = true;
        this.active = null;
        resolve({ text: cancelled ? '' : finalText.trim(), alternatives: cancelled ? [] : [...new Set(alts.filter(Boolean))].slice(0, 4) });
      };
      this.active = {
        stop: () => r.stop(),
        cancel: () => {
          cancelled = true;
          try {
            r.abort();
          } catch {
            /* ignore */
          }
        },
      };
      try {
        r.start();
      } catch (err) {
        this.active = null;
        reject(err);
      }
    });
  }

  async _whisper(lang, onInterim, onLevel, hint = '') {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      throw new Error('MIC_BLOCKED');
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);

    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    let spoke = false;
    let silenceStart = 0;
    let cancelled = false;
    const t0 = performance.now();
    const stopped = new Promise((res) => (rec.onstop = res));

    const tick = () => {
      if (rec.state !== 'recording') return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      onLevel && onLevel(Math.min(1, rms * 9));
      const now = performance.now();
      if (rms > 0.02) {
        spoke = true;
        silenceStart = 0;
      } else if (spoke) {
        silenceStart = silenceStart || now;
        if (now - silenceStart > 1500) rec.stop(); // end of utterance
      }
      if (!spoke && now - t0 > 9000) {
        cancelled = true;
        rec.stop();
      }
      if (now - t0 > 30000) rec.stop();
    };

    this.active = {
      stop: () => rec.state === 'recording' && rec.stop(),
      cancel: () => {
        cancelled = true;
        if (rec.state === 'recording') rec.stop();
      },
    };
    rec.start(250);
    const timer = setInterval(tick, 60);
    await stopped;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    this.active = null;
    onLevel && onLevel(0);
    if (cancelled || !chunks.length) return '';
    onInterim && onInterim(lang === 'bn' ? 'লেখায় রূপান্তর হচ্ছে…' : 'Transcribing…');
    const text = await transcribeWhisper(new Blob(chunks, { type: mime }), lang === 'bn' ? 'bn' : 'en', hint);
    return { text, alternatives: [] };
  }
}
