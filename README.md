# TaskBridge — Bangla Voice Assistant for Online Forms

Talk in Bangla (or English). TaskBridge reads the form, explains it, asks one question at a
time, translates and transliterates your answer into what the form expects (usually English),
fills the field, checks it, and lets you review everything before anything is submitted.

Free to run: no paid APIs. You bring a free key from **Groq** or **Google Gemini**
(or use OpenRouter `:free` models / a local Ollama server).

```
taskbridge/
├── extension/            Chrome extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js     opens the side panel, toolbar badge, first-run page
│   ├── content/          runs inside web pages
│   │   ├── page-reader.js   finds fields, labels, sections, options, buttons, errors
│   │   ├── executor.js      fills fields safely, verifies, undo snapshots, clicks buttons
│   │   ├── overlay.js       field highlights + floating "fill by voice" launcher
│   │   └── content.js       detection, page-change watcher, message router
│   ├── lib/              runs in the side panel
│   │   ├── agent.js         task planner: ask → interpret → validate → fill → verify → next
│   │   ├── llm.js           Groq / Gemini / OpenAI-compatible client (JSON, retries, vision, Whisper)
│   │   ├── prompts.js       form analysis, answer interpretation, translation, document extraction
│   │   ├── validator.js     app-side checks before anything touches the page
│   │   ├── speech.js        voice in (Chrome speech / Whisper) and voice out (system / online Bangla)
│   │   ├── normalize.js     Bangla digits, yes/no, spoken commands
│   │   ├── session.js       resume unfinished forms (local only, 7 days)
│   │   ├── i18n.js          all Bangla / English text
│   │   └── config.js        settings
│   ├── sidepanel/        the assistant UI
│   ├── permission/       first-run microphone + key setup
│   └── icons/
└── demo-portal/          fake e-service portal with 3 workflows (nothing is sent anywhere)
```

---

## 1. Run the demo portal

```bash
cd demo-portal
python -m http.server 8080        # or: npx http-server -p 8080
```

Open <http://localhost:8080>. Three workflows:

| Workflow | Steps | Tests |
|---|---|---|
| National Merit Scholarship | 5 | dropdowns, radios, date, decimals, conditional field, hidden field, age rule, "guardian phone ≠ your phone" conflict, file uploads, declaration |
| Semester Course Registration | 3 | ID format, 2–5 course checklist, retake rule, mobile-banking payment, passwords left to user |
| Citizen Service Request | 3 | "Other" reveals a field, no-Friday date rule, email required if Email updates, CAPTCHA left to user |

Opening the HTML files directly (`file://`) also works if you enable **Allow access to file URLs**
for the extension, but a local server is more reliable.

## 2. Load the extension

1. Chrome (116+) or Edge → `chrome://extensions`
2. Turn on **Developer mode** → **Load unpacked** → choose the `extension` folder.
3. A setup tab opens:
   - **Allow microphone** — do this here once; the side panel can't show the permission prompt itself.
   - **Paste a free key** → *Save & test*.
4. Pin TaskBridge from the 🧩 menu.

### Free keys
- **Groq** (recommended, very fast; also enables Whisper speech recognition):
  <https://console.groq.com/keys> → Create API Key → starts with `gsk_`
- **Google Gemini** (best for reading PDFs / photos of documents):
  <https://aistudio.google.com/apikey> → starts with `AIza`
- **OpenRouter** free models: <https://openrouter.ai/keys>, pick a model ending in `:free`.
- **Local**: Ollama → Base URL `http://localhost:11434/v1`, no key, model e.g. `llama3.1`.

Model names change over time (Groq shut down Llama 3.3 70B in 2026). TaskBridge handles this
itself: if the saved model no longer exists, it asks the provider for its current list, picks the
best one (Groq: `openai/gpt-oss-120b`, Gemini: newest Flash), saves it and retries. You can still
choose manually in **Settings → Load models**.

## 3. Use it

Open a form page → click the green **কথা বলে পূরণ করুন** button (or the toolbar icon) →
**Start**. Answer in Bangla. At any time you can say:

| Say | Does |
|---|---|
| আবার বলুন / Repeat | repeat the question |
| বুঝিয়ে বলুন / Explain | explain what the field means, list options |
| বাদ দিন / Skip | skip for now (required fields come back at the end) |
| আগের প্রশ্ন / Go back | re-ask the previous field |
| মুছে দিন / Undo | undo the last fill |
| থামুন / Stop | pause |

You can also type answers, press **Space** to talk, and edit or undo any value from the
*Progress*, *Changes* and review screens.

Example: saying **"আমার নাম নুসরাত জাহান"** fills `Nusrat Jahan`; **"শূন্য এক সাত এক দুই…"** fills
`01712…`; **"পনেরো মার্চ দুই হাজার পাঁচ"** fills the date field with `2005-03-15`.

## 4. Safety rules (built in)

- The AI only **proposes** values. `validator.js` checks field type, options, format, length,
  pattern and language before `executor.js` writes anything, then the written value is read back
  and verified.
- **Passwords, OTP, CAPTCHA, card security codes and file uploads are never filled.** You do those.
- Uncertain answers (e.g. transliterated names) are read back for a yes/no first.
- **Final submission only happens after you say "হ্যাঁ" or press Submit** on the review screen.
- Keys and unfinished sessions stay in `chrome.storage.local` on your computer. Documents are sent
  to your AI provider only to read them and are dropped from memory right after; they are never saved.
- Use synthetic data for the demo.

## 5. How it maps to the 5-day plan

| Day | Goal | Where it is |
|---|---|---|
| 1 | Detect forms and read the page (labels, sections, options, required, buttons, errors) | `content/page-reader.js`, `content/content.js`, `overlay.js` launcher, `background.js` |
| 2 | Voice in/out in Bangla + form understanding and questions | `lib/speech.js`, `lib/llm.js`, `lib/prompts.js` (analyze), `agent.start/ensureQuestions/ask/listen` |
| 3 | Interpret answers, translate, validate, fill and verify | `prompts.interpret/toEnglish`, `lib/validator.js`, `content/executor.js`, `agent.applyAnswer/commit/fillField` |
| 4 | Progress, undo, review, resume session, multi-step pages, validation recovery | `sidepanel/*`, `agent.undo/editAnswer/review/submit/goNext/onPageChanged/handleValidationErrors`, `lib/session.js` |
| 5 | Documents, bilingual polish, settings, demo portal, testing | `agent.extractFromDocument`, Documents tab, `lib/i18n.js`, `permission/*`, `demo-portal/*` |

### Suggested test script (demo day)
1. Scholarship: answer everything in Bangla. Say "হ্যাঁ" to *other scholarship* → a new question appears.
2. Give the guardian the same phone number as yours → the portal rejects it → TaskBridge explains in Bangla and re-asks.
3. On step 5 it stops at file uploads: attach any image yourself → press *I fixed it — check again*.
4. Open *Changes* → undo a value. Open *Review* → edit one answer by typing.
5. Close the side panel mid-form, reopen, press Start → earlier answers are restored.
6. Course registration: say "CSE201, Database আর Calculus" for the course checklist.
7. Documents tab (Gemini key recommended): add a photo of a *sample* mark sheet → accept the found values.

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| Mic does nothing / "not-allowed" | Open the setup page again (side panel → *Allow microphone*) and allow. |
| Bangla recognised poorly | Settings → Speech recognition → **Groq Whisper**. |
| No Bangla voice | Settings → *Online Bangla voice* on, or install a Bangla voice in Windows/macOS. |
| "Free limit reached" (429) | Wait a minute, or switch provider (Groq ↔ Gemini). |
| "Model not found" | Usually fixed automatically. If not: Settings → *Load models* → choose one. |
| Nothing detected on a page opened before installing | Reload the page. |
| PDF upload rejected | PDFs need the Gemini provider; photos work with Groq too. |
| Can't run on `chrome://` pages or the Web Store | Browser restriction — use a normal website. |
