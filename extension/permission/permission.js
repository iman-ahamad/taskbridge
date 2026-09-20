// TaskBridge — first-run setup: microphone permission + free API key.
// The side panel cannot show Chrome's permission prompt reliably, so the microphone is
// granted here once (for the whole extension) and the side panel inherits it.
import { loadSettings, saveSettings } from '../lib/config.js';
import { chatJSON } from '../lib/llm.js';
import { PING } from '../lib/prompts.js';

const $ = (id) => document.getElementById(id);
let provider = 'groq';

const HINTS = {
  groq: 'Free key: <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a> → Sign in → <b>Create API Key</b> → copy (starts with <code>gsk_</code>).',
  gemini: 'Free key: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> → <b>Create API key</b> → copy (starts with <code>AIza</code>).',
};

function setState(id, text, ok) {
  const n = $(id);
  n.textContent = text;
  n.className = `state ${ok === undefined ? '' : ok ? 'ok' : 'bad'}`;
}

// ---------- microphone ----------
async function micStatus() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    return p.state;
  } catch {
    return 'prompt';
  }
}

async function showMicStatus() {
  const s = await micStatus();
  if (s === 'granted') {
    $('stepMic').classList.add('done');
    setState('micState', '✓ মাইক্রোফোন চালু আছে · Microphone is allowed', true);
  } else if (s === 'denied') {
    setState('micState', '✕ ব্লক করা আছে। ঠিকানার বারের 🔒 আইকনে ক্লিক করে Microphone → Allow করুন, তারপর পেজটি রিলোড করুন।', false);
  }
}

$('btnMic').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Short level preview so the user sees the mic works.
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const t0 = performance.now();
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      $('meter').style.width = `${Math.min(100, Math.sqrt(sum / buf.length) * 400)}%`;
      if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
      else {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
        $('meter').style.width = '0';
      }
    };
    tick();
    chrome.runtime.sendMessage({ type: 'TB_MIC_GRANTED' }).catch(() => {});
    await showMicStatus();
    setState('micState', '✓ মাইক্রোফোন চালু হয়েছে — কিছু বলে দেখুন, সবুজ দাগ নড়বে। · Microphone allowed', true);
  } catch (e) {
    setState(
      'micState',
      e && e.name === 'NotFoundError'
        ? '✕ কোনো মাইক্রোফোন পাওয়া যায়নি · No microphone found'
        : '✕ অনুমতি দেওয়া হয়নি। ঠিকানার বারের 🔒 আইকন থেকে Microphone → Allow করুন। · Permission was not given',
      false
    );
  }
});

// ---------- API key ----------
function showProvider(p) {
  provider = p;
  document.querySelectorAll('#providerSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.provider === p)));
  $('keyHint').innerHTML = HINTS[p];
  loadSettings().then((s) => ($('apiKey').value = (p === 'gemini' ? s.geminiKey : s.groqKey) || ''));
}
$('providerSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-provider]');
  if (b) showProvider(b.dataset.provider);
});

$('btnSaveKey').addEventListener('click', async () => {
  const key = $('apiKey').value.trim();
  if (!key) return setState('keyState', 'কী পেস্ট করুন · Paste a key first', false);
  const btn = $('btnSaveKey');
  btn.disabled = true;
  setState('keyState', 'পরীক্ষা করা হচ্ছে… · Testing…');
  await saveSettings(provider === 'gemini' ? { provider, geminiKey: key } : { provider, groqKey: key });
  try {
    await chatJSON(PING);
    const s = await loadSettings();
    const model = provider === 'gemini' ? s.geminiModel : s.groqModel;
    $('stepKey').classList.add('done');
    setState('keyState', `✓ কাজ করছে! · Key works (model: ${model})`, true);
  } catch (e) {
    const msg = String((e && e.message) || e);
    const m =
      e && (e.status === 401 || e.status === 403)
        ? '✕ কী সঠিক নয় · The key was rejected — copy it again'
        : e && e.status === 429
          ? '✕ লিমিট শেষ, একটু পরে চেষ্টা করুন · Rate limited, try again shortly'
          : /model/i.test(msg)
            ? '✕ কোনো চালু মডেল পাওয়া যায়নি · No working model found — open Settings → Load models'
            : `✕ ${msg.slice(0, 160)}`;
    setState('keyState', m, false);
  } finally {
    btn.disabled = false;
  }
});

$('btnClose').addEventListener('click', () => window.close());

// ---------- boot ----------
(async () => {
  const s = await loadSettings();
  showProvider(s.provider === 'gemini' ? 'gemini' : 'groq');
  if ((s.provider === 'gemini' && s.geminiKey) || (s.provider !== 'gemini' && s.groqKey)) $('stepKey').classList.add('done');
  showMicStatus();
})();
