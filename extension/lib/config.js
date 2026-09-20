// TaskBridge — settings (stored locally in chrome.storage.local, never synced)

export const DEFAULTS = Object.freeze({
  // AI provider: 'groq' (free, fast), 'gemini' (free tier), 'openai_compat' (OpenRouter / local Ollama / LM Studio)
  provider: 'groq',
  groqKey: '',
  groqModel: 'openai/gpt-oss-120b',
  groqVisionModel: 'qwen/qwen3.8-27b',
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  compatBaseUrl: 'https://openrouter.ai/api/v1',
  compatKey: '',
  compatModel: '',

  // Speech-to-text: 'browser' (Chrome Web Speech, free, no key) or 'whisper' (Groq Whisper, free key)
  sttEngine: 'browser',
  whisperModel: 'whisper-large-v3',

  userLang: 'bn', // language the assistant speaks: 'bn' | 'en'
  tts: true,
  onlineBanglaVoice: true, // fallback voice when the computer has no Bangla voice installed
  speechRate: 1.0,
  autoListen: true, // start listening after each question
  autoNext: true, // press "Next" automatically when a step is complete
  confirmLowConfidence: true,
  confirmCritical: true, // always read back names, numbers, emails and dates before filling // read back uncertain answers (e.g. transliterated names)
});

// Models the providers have shut down. Saved settings that still point at them are
// moved to the current default (llm.js also auto-recovers from any future retirement).
const RETIRED = new Set([
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama3-70b-8192',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3.6-27b',
]);

export async function loadSettings() {
  const { tbSettings } = await chrome.storage.local.get('tbSettings');
  const s = { ...DEFAULTS, ...(tbSettings || {}) };
  if (RETIRED.has(s.groqModel)) s.groqModel = DEFAULTS.groqModel;
  if (RETIRED.has(s.groqVisionModel)) s.groqVisionModel = DEFAULTS.groqVisionModel;
  return s;
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ tbSettings: next });
  return next;
}

export function hasApiKey(s) {
  if (s.provider === 'gemini') return !!s.geminiKey;
  if (s.provider === 'openai_compat') return (!!s.compatKey || isLocalUrl(s.compatBaseUrl)) && !!s.compatModel;
  return !!s.groqKey;
}

export function isLocalUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(String(url || ''));
}
