<div align="center">

# 🌉 TaskBridge

### কথা বলে অনলাইন ফর্ম পূরণ করুন — Fill online forms just by talking

**A Chrome extension that reads any online form, asks you questions in Bangla, understands your spoken answers, and fills the form in English — with your permission at every step.**

[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![No build step](https://img.shields.io/badge/build-none%20required-success)](#-install-in-2-minutes)
[![Free APIs](https://img.shields.io/badge/AI-free%20tier%20only-00A67E)](#-get-a-free-ai-key)
[![Languages](https://img.shields.io/badge/languages-বাংলা%20%7C%20English-C98A00)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Install](#-install-in-2-minutes) · [Try the demo portal](#-try-it-on-the-demo-portal) · [How it works](#-how-it-works) · [Voice commands](#-what-you-can-say) · [FAQ](#-faq)

</div>

---

## 🎯 The problem

Millions of people in Bangladesh speak and read Bangla comfortably, but online forms — scholarship applications, university registration, government e-services — are written in English, full of unfamiliar words like *Upazila*, *NID*, *GPA out of 5.00*, and strict formats like `YYYY-MM-DD`.

So people ask someone at a computer shop to fill the form for them — paying money and handing over private information. Or they give up.

**TaskBridge is the helpful person sitting beside you** — except it runs on your own computer, keeps nothing afterwards, and costs nothing.

## ✨ What it does

| | |
|---|---|
| 🔍 **Reads any form** | Finds every field, its label, section, options and rules — on any website, without that website doing anything |
| 🗣️ **Asks in Bangla** | One simple question at a time, spoken aloud: *"আপনার এসএসসি জিপিএ কত ছিল?"* |
| 🌐 **Translates as you speak** | You answer in Bangla — it writes English. Names are transliterated (নুসরাত জাহান → `Nusrat Jahan`), spoken dates become `2005-03-15`, Bangla digits become `01712345678` |
| ✅ **Checks before typing** | Every value is validated against the field's real type, options, pattern and length before it touches the page |
| 🔒 **Never touches secrets** | Passwords, OTP, CAPTCHA and file uploads are always left to you |
| ↩️ **Undo anything** | Every change is listed with its old value and a one-click undo |
| 📄 **Reads your documents** | Photograph your NID or mark sheet and it offers the values it found — you accept or reject each one |
| 🛑 **Never submits alone** | Final submission happens only after you say *"হ্যাঁ"* or press the button |

## 🖼️ Screenshots

| Starting a form | Filling by voice | Submitted |
|---|---|---|
| ![Starting a form](docs/Screenshot%20start.png) | ![Filling by voice](docs/Screenshot%20Filling%20Info.png) | ![Submitted by voice](docs/Screenshot%20Submitted%20form%20by%20Voice%20Control.png) |

---

## 🚀 Install in 2 minutes

**Requirements:** Chrome or Edge 116+, a microphone, and a free AI key (below). No Node.js, no build step, no `npm install`.

```bash
git clone https://github.com/iman-ahamad/taskbridge.git
```

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension` folder
4. A setup tab opens → **Allow microphone** → paste your free key → **Save & test**
5. Pin TaskBridge from the 🧩 menu

Done. Open any form and a green **কথা বলে পূরণ করুন** button appears in the corner.

### 🔑 Get a free AI key

Pick **one**. Groq is the fastest; Gemini is the best at reading documents.

| Provider | Where | Looks like | Notes |
|---|---|---|---|
| **Groq** *(recommended)* | [console.groq.com/keys](https://console.groq.com/keys) | `gsk_…` | Also powers Whisper speech recognition |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `AIza…` | Best for photos and PDFs of documents |
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) | `sk-or-…` | Use any model ending in `:free` |
| **Local (Ollama)** | — | no key needed | Base URL `http://localhost:11434/v1` |

Your key is stored only in your own browser (`chrome.storage.local`) and is sent nowhere except the provider you chose.

> **Model names change.** If a provider retires a model, TaskBridge fetches the current model list, picks a working one, saves it and carries on. You don't have to do anything.

---

## 🧪 Try it on the demo portal

The repo includes a realistic fake e-service portal so you can test everything safely.

```bash
cd demo-portal
python -m http.server 8080     # or: npx http-server -p 8080
```

Open <http://localhost:8080> and pick a workflow:

| Workflow | Steps | What it demonstrates |
|---|---|---|
| 🎓 **National Merit Scholarship** | 5 | Dropdowns, radios, dates, GPA decimals, a question that reveals a new field, an age rule, a "guardian phone ≠ your phone" conflict, file uploads |
| 📚 **Semester Course Registration** | 3 | Student-ID format, choosing 2–5 courses from a checklist, mobile-banking payment, passwords left to you |
| 🏛️ **Citizen Service Request** | 3 | "Other" reveals a field, no-Friday date rule, conditional email requirement, CAPTCHA left to you |

> ⚠️ Use made-up information. Nothing is sent anywhere, but don't practise with your real NID.

<details>
<summary><b>📋 A good 2-minute demo script</b></summary>

1. Open the scholarship form, press **Start**, answer in Bangla.
2. Say **"হ্যাঁ"** to *other scholarship* → a new question appears automatically.
3. Give the guardian the same phone number as your own → the portal rejects it → TaskBridge explains the error in Bangla and asks again.
4. At step 5 it stops at the file uploads: attach any image yourself, then press **I fixed it — check again**.
5. Open **Changes** → undo a value. Open **Review** → edit an answer by typing.
6. Close the side panel, reopen it, press Start → your earlier answers are restored.

</details>

---

## 🗣️ What you can say

At any moment, in the middle of anything:

| বাংলা | English | Does |
|---|---|---|
| আবার বলুন | Repeat | Say the question again |
| বুঝিয়ে বলুন | Explain | Explain what the field means and list the options |
| বাদ দিন | Skip | Skip for now (required fields come back at the end) |
| আগের প্রশ্ন | Go back | Return to the previous field |
| মুছে দিন | Undo | Undo the last thing it filled |
| থামুন | Stop | Pause |

You can also **type** any answer, press **Space** to talk, and switch the whole interface between বাংলা and English at any time.

---

## 🧠 How it works

```
┌──────────────┐   snapshot   ┌──────────────┐   question   ┌──────────────┐
│  Page Reader │ ───────────▶ │ Task Planner │ ───────────▶ │    Speech    │
│ (in the page)│              │ (side panel) │              │   in / out   │
└──────────────┘              └──────┬───────┘              └──────┬───────┘
       ▲                             │ proposed value              │ transcript
       │ verify                      ▼                             │
┌──────┴───────┐   safe write ┌──────────────┐ ◀───────────────────┘
│   Executor   │ ◀────────────│  Validator   │   the AI only ever *proposes*;
│ (in the page)│              │  (app code)  │   application code decides
└──────────────┘              └──────────────┘
```

1. **Page Reader** — walks every input and works out its label (`aria-labelledby` → `<label for>` → nearby text), section, required flag, options and any visible error text. Groups radios and checkboxes. Flags passwords, OTP and CAPTCHA as *never fill*.
2. **Task Planner** — a state machine: `analyzing → asking → listening → thinking → filling → next`, plus pause, review, undo, multi-step navigation and session resume.
3. **Speech** — Chrome's Web Speech API (free, no key) or Groq Whisper (better Bangla); speaks with the system voice, or an online Bangla voice if none is installed.
4. **Validator** — checks the proposed value against the field's real rules. This is what stops wrong values reaching the page.
5. **Executor** — writes using the *native value setter* plus real `input`/`change` events, so React and Vue forms notice. Snapshots the old value for undo, then reads the field back to verify.

<details>
<summary><b>🛡️ Why it doesn't hallucinate into your form</b></summary>

- The model **only proposes JSON**. It never touches the page.
- Every proposal is checked by application code against the field's own rules; anything that doesn't fit is rejected and the question is asked again.
- Dropdowns and radio buttons are matched **in code** against the field's real options — if what you said isn't clearly one of them, no AI call is made and nothing is selected.
- The recogniser's alternative readings are all passed to the interpreter, which picks the one that fits the field.
- Names, numbers, emails and dates are **read back to you digit by digit** before being filled.
- The model is instructed to say "I didn't catch that" rather than repair a garbled transcript — it must never add or drop digits to make a number fit.

</details>

<details>
<summary><b>🔐 Privacy</b></summary>

- Your API key and unfinished sessions live in `chrome.storage.local`, on your machine only.
- Unfinished answers are kept per website for 7 days so you can resume, and can be deleted any time from Settings.
- Documents you add are sent to *your* AI provider to be read, then dropped. The extension never saves them.
- No server, no analytics, no account.
- Passwords, OTP codes, CAPTCHA and file uploads are never read or filled.

</details>

<details>
<summary><b>🗂️ Project structure</b></summary>

```
taskbridge/
├── extension/                 # load this folder in chrome://extensions
│   ├── manifest.json
│   ├── background.js          # side panel, toolbar badge, first-run page
│   ├── content/               # runs inside web pages
│   │   ├── page-reader.js     # finds fields, labels, sections, options, errors
│   │   ├── executor.js        # framework-safe filling, undo snapshots, verify
│   │   ├── overlay.js         # highlights + floating launcher (Shadow DOM)
│   │   └── content.js         # detection, page-change watcher, messaging
│   ├── lib/                   # runs in the side panel
│   │   ├── agent.js           # the task planner / state machine
│   │   ├── llm.js             # Groq / Gemini / OpenAI-compatible + auto model recovery
│   │   ├── prompts.js         # analyse form, interpret answer, translate, read documents
│   │   ├── validator.js       # the safety gate
│   │   ├── speech.js          # speech in and out
│   │   ├── normalize.js       # Bangla digits, yes/no, spoken commands
│   │   ├── session.js         # resume unfinished forms
│   │   ├── i18n.js            # every Bangla / English string
│   │   └── config.js          # settings
│   ├── sidepanel/             # the assistant UI
│   ├── permission/            # first-run microphone + key setup
│   └── icons/
├── demo-portal/               # fake e-service portal, 3 workflows
└── docs/DEVELOPER.md          # deeper notes, test script, build plan
```

**Stack:** vanilla JavaScript (ES modules), Chrome Manifest V3, Web Speech API, CSS custom properties, Shadow DOM. No framework, no bundler, no dependencies.

</details>

---

## ⚙️ Settings worth knowing

| Setting | Why you'd change it |
|---|---|
| **Speech recognition → Groq Whisper** | Noticeably better Bangla than Chrome's built-in recogniser. Recommended |
| **Online Bangla voice** | Turn on if your computer has no Bangla voice installed |
| **Always read back names, numbers, emails and dates** | On by default; turn off for speed once you trust it |
| **Listen automatically after each question** | Off = press the mic each time (better in noisy rooms) |
| **Press "Next" automatically** | Off = you control page-to-page movement |

---

## ❓ FAQ

<details>
<summary><b>Isn't this just browser autofill?</b></summary>

Autofill matches saved values to field names it already knows. TaskBridge understands a form it has never seen, asks about it in Bangla, converts your spoken answer into the format the field needs, validates it against that page's rules, and explains the site's error messages.
</details>

<details>
<summary><b>Does it cost money?</b></summary>

No. It runs on free API tiers, or on a local model through Ollama. You bring your own key.
</details>

<details>
<summary><b>What if it fills something wrong?</b></summary>

Every change is highlighted on the page, listed in the Changes tab with its old value, and undoable with one click. Nothing is submitted until you agree.
</details>

<details>
<summary><b>Which sites does it work on?</b></summary>

Any ordinary HTML form. Sites that draw their own controls on a `<canvas>`, or bury inputs in closed custom elements, are harder. Browser pages such as `chrome://` and the Web Store are blocked by Chrome itself.
</details>

<details>
<summary><b>Can it speak other languages?</b></summary>

The architecture is language-neutral — every string lives in `lib/i18n.js` and the prompts take the language as a parameter. Bangla and English ship today; adding Hindi or Urdu is mostly translation work.
</details>

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| Microphone does nothing | Reopen the setup page from the side panel and allow the microphone |
| Bangla recognised badly | Settings → **Groq Whisper**; use a headset mic; say digits one by one |
| No voice / silent | Settings → turn on **Online Bangla voice**, or install a Bangla voice in your OS |
| "Free limit reached" (429) | Wait a minute, or switch provider |
| "Model not found" | Usually fixed automatically; otherwise Settings → **Load models** → pick one |
| Nothing detected on a page | Reload the page (it was open before the extension was installed) |
| PDF upload rejected | PDFs need the Gemini provider; photos work with Groq too |

## 🗺️ Roadmap

- [ ] Letter-by-letter spelling mode for names
- [ ] Bangladeshi name dictionary for better transliteration
- [ ] More languages (Hindi, Urdu, Arabic)
- [ ] On-device speech and models for a fully offline mode
- [ ] Firefox and Safari support
- [ ] Screen-reader-grade accessibility

## 🤝 Contributing

Issues and pull requests are welcome — especially Bangla wording improvements, transliteration fixes, and reports of forms TaskBridge reads badly (please include the URL or a copy of the HTML).

## 📄 License

[MIT](LICENSE) © [Iman Ahamad](https://github.com/iman-ahamad)

<div align="center">

**Built so that nobody has to pay a stranger to fill in their own form.**

</div>
