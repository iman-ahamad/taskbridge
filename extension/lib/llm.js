// TaskBridge — model provider layer (all free-tier friendly).
//  • Groq      — OpenAI-compatible, free key, very fast (Llama 3.3 70B, Llama 4 vision, Whisper).
//  • Gemini    — Google AI Studio free key (text + images + PDF).
//  • OpenAI-compatible — OpenRouter ":free" models, or a local Ollama / LM Studio server.

import { loadSettings, saveSettings, isLocalUrl } from './config.js';

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class LLMError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}

function parseJSON(text) {
  if (!text) throw new LLMError('EMPTY_RESPONSE');
  const t = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(t.slice(s, e + 1));
      } catch {
        /* fall through */
      }
    }
  }
  throw new LLMError('BAD_JSON');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const retryable = e.status === 429 || e.status >= 500 || e.message === 'BAD_JSON';
      if (!retryable || i === tries - 1) throw e;
      const wait = e.retryAfter ? e.retryAfter * 1000 : 1200 * (i + 1) ** 2;
      await sleep(Math.min(wait, 15000));
    }
  }
  throw last;
}

async function httpJSON(url, opts, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    throw new LLMError(e.name === 'AbortError' ? 'TIMEOUT' : `Failed to fetch: ${e.message}`, 0);
  } finally {
    clearTimeout(timer);
  }
  const txt = await res.text();
  if (!res.ok) {
    let msg = txt;
    try {
      const j = JSON.parse(txt);
      msg = (j.error && (j.error.message || j.error)) || j.message || txt;
    } catch {
      /* keep raw text */
    }
    const err = new LLMError(`${res.status}: ${String(msg).slice(0, 300)}`, res.status);
    err.retryAfter = Number(res.headers.get('retry-after')) || 0;
    throw err;
  }
  return txt ? JSON.parse(txt) : {};
}

function providerConfig(s) {
  if (s.provider === 'gemini') return { kind: 'gemini', key: s.geminiKey, model: s.geminiModel };
  if (s.provider === 'openai_compat') {
    return {
      kind: 'openai',
      base: String(s.compatBaseUrl || '').replace(/\/+$/, ''),
      key: s.compatKey,
      model: s.compatModel,
      keyOptional: isLocalUrl(s.compatBaseUrl),
    };
  }
  return { kind: 'openai', base: GROQ_BASE, key: s.groqKey, model: s.groqModel, visionModel: s.groqVisionModel };
}

// ---------------------------------------------------------------- model auto-recovery
// Free providers retire models often (e.g. Groq shut down Llama 3.3 70B in 2026).
// When the saved model is gone, pick a current one from the provider's own list,
// save it, and retry — the user never has to know model names.

const NOT_CHAT = /whisper|guard|safeguard|tts|orpheus|playai|compound|embed|moderation|distil|audio|transcri/i;
const PREFS = {
  groqText: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'],
  groqVision: ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct'],
};

function isModelGone(e) {
  const m = String((e && e.message) || '');
  return !!e && [400, 404, 410].includes(e.status) && /model/i.test(m) && /does not exist|not found|decommission|deprecat|no longer|not available|unknown|invalid|not supported|do not have access/i.test(m);
}

function versionScore(id) {
  const m = id.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

/** Chooses the best currently available model id, or '' if none fits. */
export function pickModel(provider, ids, { vision = false } = {}) {
  const list = (ids || []).filter((id) => !NOT_CHAT.test(id));
  if (provider === 'gemini') {
    const g = list.filter((id) => /^gemini/i.test(id) && !/image|live|tts|embedding|aqa|learnlm|robotics|computer/i.test(id));
    const rank = (id) =>
      versionScore(id) * 10 + (/flash/.test(id) ? 3 : 0) - (/lite/.test(id) ? 2 : 0) - (/preview|exp/.test(id) ? 1 : 0);
    return g.sort((a, b) => rank(b) - rank(a))[0] || '';
  }
  if (provider === 'groq') {
    const prefs = vision ? PREFS.groqVision : PREFS.groqText;
    const hit = prefs.find((p) => list.includes(p));
    if (hit) return hit;
    if (vision) return list.find((id) => /vision|scout|maverick|vl\b|qwen3\.\d/i.test(id)) || '';
    // Largest general model left.
    const size = (id) => {
      const m = id.match(/(\d+)b\b/i);
      return m ? +m[1] : 0;
    };
    return list.sort((a, b) => size(b) - size(a))[0] || '';
  }
  // OpenAI-compatible (OpenRouter / local): prefer free models on OpenRouter.
  return list.find((id) => /:free$/.test(id)) || list[0] || '';
}

async function recoverModel(s, p, { vision }) {
  if (p.kind === 'openai' && s.provider === 'openai_compat' && !/openrouter/i.test(p.base)) return '';
  const ids = await listModels({ provider: s.provider, key: p.key, baseUrl: p.base });
  const current = vision ? p.visionModel : p.model;
  const id = pickModel(s.provider, ids.filter((x) => x !== current), { vision });
  if (!id) return '';
  const field = s.provider === 'gemini' ? 'geminiModel' : s.provider === 'openai_compat' ? 'compatModel' : vision ? 'groqVisionModel' : 'groqModel';
  await saveSettings({ [field]: id });
  console.info(`[TaskBridge] model "${vision ? p.visionModel : p.model}" is unavailable → switched to "${id}"`);
  return id;
}

/** Reasoning models need a larger token budget and a hint to keep thinking short. */
function reasoningExtras(model) {
  if (/gpt-oss/i.test(model)) return { reasoning_effort: 'low' };
  if (/qwen3/i.test(model)) return { reasoning_format: 'hidden' };
  return {};
}

/**
 * Ask the model for a JSON object.
 * @param {{system:string,user:string,images?:{mimeType:string,base64:string}[],temperature?:number,maxTokens?:number}} p
 */
export async function chatJSON(req) {
  const s = await loadSettings();
  const p = providerConfig(s);
  if (!p.key && !p.keyOptional) throw new LLMError('NO_API_KEY');
  if (!p.model) throw new LLMError('NO_MODEL');
  const vision = !!(req.images && req.images.length) && p.kind === 'openai' && s.provider === 'groq';

  try {
    return await callModel(p, req, { vision });
  } catch (e) {
    if (!isModelGone(e)) throw e;
    const id = await recoverModel(s, p, { vision }).catch(() => '');
    if (!id) throw vision ? new LLMError('NO_VISION_MODEL', e.status) : e;
    const p2 = vision ? { ...p, visionModel: id } : { ...p, model: id };
    return callModel(p2, req, { vision });
  }
}

async function callModel(p, { system, user, images = [], temperature = 0.2, maxTokens = 2048 }, { vision }) {
  let useExtras = true;
  return withRetry(async () => {
    if (p.kind === 'gemini') {
      const parts = [{ text: user }, ...images.map((img) => ({ inline_data: { mime_type: img.mimeType, data: img.base64 } }))];
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature, maxOutputTokens: Math.max(maxTokens, 4096), responseMimeType: 'application/json' },
      };
      const j = await httpJSON(`${GEMINI_BASE}/models/${encodeURIComponent(p.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
        body: JSON.stringify(body),
      });
      const text = (j.candidates?.[0]?.content?.parts || []).filter((x) => !x.thought).map((x) => x.text || '').join('');
      if (!text && j.promptFeedback?.blockReason) throw new LLMError(`BLOCKED: ${j.promptFeedback.blockReason}`);
      return parseJSON(text);
    }

    if (vision && !p.visionModel) throw new LLMError('NO_VISION_MODEL');
    const model = images.length && p.visionModel ? p.visionModel : p.model;
    const extras = useExtras ? reasoningExtras(model) : {};
    const content = images.length
      ? [{ type: 'text', text: user }, ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } }))]
      : user;
    const body = {
      model,
      temperature,
      max_tokens: Object.keys(extras).length ? Math.max(maxTokens, 4096) : maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
      ...extras,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (p.key) headers.Authorization = `Bearer ${p.key}`;
    try {
      const j = await httpJSON(`${p.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
      return parseJSON(j.choices?.[0]?.message?.content);
    } catch (e) {
      // Some servers reject the reasoning hints — retry once without them.
      if (useExtras && Object.keys(extras).length && e.status === 400 && /reasoning/i.test(e.message)) {
        useExtras = false;
        e.status = 503; // make withRetry try again
      }
      throw e;
    }
  });
}

/** Lists model ids so the user can pick a current free model (names change over time). */
export async function listModels({ provider, key, baseUrl }) {
  if (provider === 'gemini') {
    const j = await httpJSON(`${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .sort();
  }
  const base = provider === 'groq' ? GROQ_BASE : String(baseUrl || '').replace(/\/+$/, '');
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const j = await httpJSON(`${base}/models`, { headers });
  return (j.data || []).map((m) => m.id).sort();
}

/** Speech-to-text with Groq Whisper (free key). Bangla: language "bn". */
export async function transcribeWhisper(blob, lang, prompt = '') {
  const s = await loadSettings();
  if (!s.groqKey) throw new LLMError('NO_GROQ_KEY');
  return withRetry(async () => {
    const fd = new FormData();
    fd.append('file', blob, blob.type.includes('ogg') ? 'speech.ogg' : 'speech.webm');
    fd.append('model', s.whisperModel || 'whisper-large-v3');
    if (lang) fd.append('language', lang);
    // Biases Whisper towards the words this field expects (names of options, the label, formats).
    if (prompt) fd.append('prompt', String(prompt).slice(0, 800));
    fd.append('temperature', '0');
    fd.append('response_format', 'json');
    const j = await httpJSON(`${GROQ_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.groqKey}` },
      body: fd,
    });
    return String(j.text || '').trim();
  });
}
