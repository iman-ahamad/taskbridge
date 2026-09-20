// TaskBridge — language helpers that run locally (no API call)

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

export const bnToEnDigits = (s) => String(s ?? '').replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
export const enToBnDigits = (s) => String(s ?? '').replace(/\d/g, (d) => BN_DIGITS[Number(d)]);
export const hasBangla = (s) => /[\u0980-\u09FF]/.test(String(s || ''));

export function displayOf(v) {
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v ?? '');
}

function tokens(text) {
  return bnToEnDigits(String(text || '').toLowerCase())
    .replace(/[।,.!?;:"'()\-–—]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const YES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'correct', 'right', 'confirm', 'submit', 'go', 'fine', 'absolutely',
  'হ্যাঁ', 'হ্যা', 'হাঁ', 'হা', 'জি', 'জ্বি', 'জী', 'ঠিক', 'অবশ্যই', 'হুম', 'সঠিক', 'করো', 'করুন', 'দাও', 'দিন', 'জমা', 'ওকে', 'আচ্ছা', 'ইয়েস',
]);
const NO = new Set([
  'no', 'nope', 'nah', 'not', 'wrong', 'cancel', 'dont', "don't", 'incorrect',
  'না', 'নাহ', 'নেই', 'ভুল', 'বাতিল', 'থাক', 'নো',
]);

/** Returns true (yes), false (no) or null (not a yes/no reply). Negation wins. */
export function parseYesNo(text) {
  const t = tokens(text);
  if (!t.length || t.length > 8) return null;
  const hasNo = t.some((w) => NO.has(w));
  const hasYes = t.some((w) => YES.has(w));
  // Explicit negation ("দিও না", "জমা দেবেন না", "no") always wins.
  if (t.includes('না') || t.includes('নাহ') || t.includes('no') || t.includes('nope') || t.includes('ভুল') || t.includes('wrong') || t.includes('বাতিল') || t.includes('cancel')) return false;
  if (hasYes && !hasNo) return true;
  if (hasNo && !hasYes) return false;
  return null;
}

const COMMANDS = [
  ['stop', /^(stop|pause|wait|থামো|থামুন|থাম|বন্ধ করো|বন্ধ করুন|বিরতি|একটু দাঁড়াও|দাঁড়াও)$/],
  ['undo', /^(undo|undo that|আনডু|আগেরটা মুছে দাও|আগেরটা মুছুন|মুছে দাও|মুছে দিন|ফিরিয়ে দাও|ফিরিয়ে নাও|আগের উত্তর মুছে দাও)$/],
  ['repeat', /^(repeat|again|say again|say that again|pardon|আবার বলো|আবার বলুন|আরেকবার বলো|আরেকবার বলুন|আরেকবার|কী বললে|কি বললে|কী বললেন|কি বললেন|রিপিট)$/],
  ['explain', /^(explain|what does (this|that|it) mean|what is (this|that)|help|মানে কী|মানে কি|এর মানে কী|এর মানে কি|বুঝিয়ে বলো|বুঝিয়ে বলুন|বুঝিনি|বুঝলাম না|কী লিখব|কি লিখব|এটা কী|এটা কি)$/],
  ['back', /^(go back|back|previous|previous question|আগের প্রশ্ন|আগের প্রশ্নে যাও|পেছনে যাও|পিছনে যাও)$/],
  ['skip', /^(skip|skip it|skip this|pass|later|next|i don'?t know|not sure|বাদ|বাদ দাও|বাদ দিন|স্কিপ|পরে|পরে দেব|পরে দিব|পরে দিচ্ছি|জানি না|জানিনা|জানি না তো|দরকার নেই|এটা বাদ দাও|এটা বাদ দিন)$/],
];

/** Detects short spoken commands. Long utterances are always treated as answers. */
export function parseCommand(text) {
  const t = tokens(text);
  if (!t.length || t.length > 5) return null;
  const s = t.join(' ');
  for (const [name, re] of COMMANDS) if (re.test(s)) return name;
  return null;
}
