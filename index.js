import { chromium } from '@playwright/test';
import { request as undiciRequest } from 'undici';
import { createHash } from 'node:crypto';

const BASE         = process.env.WU_BASE_URL;      // np. https://wu.varsovia.study
const USER         = process.env.WU_USERNAME;
const PASS         = process.env.WU_PASSWORD;
const HREF         = process.env.HARMONOGRAM_URL;  // XHR do spersonalizowanego harmonogramu (z Network)
const GIST_ID      = process.env.GIST_ID;
const GIST_TOKEN   = process.env.GIST_TOKEN;
const TZ           = 'Europe/Warsaw';

// ─── helpers ──────────────────────────────────────────────────────────────────
const pad2 = n => String(n).padStart(2,'0');
const esc  = s => (s||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n').trim();
const dtstr = (d,h,m) => `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}T${pad2(h)}${pad2(m)}00`;

function parseDate(s){
  s=(s||'').trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m) return new Date(+m[1],+m[2]-1,+m[3]);
  m=s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if(m) return new Date(+m[3],+m[2]-1,+m[1]);
  return null;
}
function parseTime(s){ const m=(s||'').match(/(\d{1,2}):(\d{2})/); return m?{h:+m[1],mi:+m[2]}:null; }

// usuń warianty "niestacjonarne" z tytułu/formatu
function stripNiestacjonarne(s) {
  return (s || '')
    .replace(/\s*[-–—]?\s*\(\s*niestacjonarne\s*\)/ig, ' ') // "(niestacjonarne)" z/bez myślnika
    .replace(/\bniestacjonarne\b/ig, ' ')                    // sam wyraz
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—]\s*$/g, '')
    .trim();
}

// ─── główne kroki ─────────────────────────────────────────────────────────────
async function loginAndFetchJSON(){
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  // typowe pola logowania
  const userSel = 'input[type="text"], input[type="email"], input[name*="user" i], input[name*="login" i]';
  const passSel = 'input[type="password"]';
  await page.waitForSelector(passSel, { timeout: 15000 });
  const u = await page.$(userSel); const p = await page.$(passSel);
  if(!u || !p) throw new Error('Nie znaleziono pól logowania na WU.');
  await u.fill(USER); await p.fill(PASS);
  await Promise.all([ page.keyboard.press('Enter'), page.waitForLoadState('domcontentloaded') ]);

  // pobierz JSON z Twojego endpointu (z autoryzacją z sesji)
  const resp = await page.request.get(HREF, { timeout: 30000 });
  if(!resp.ok()) throw new Error(`Błąd JSON: ${resp.status()} ${resp.statusText()}`);
  const data = await resp.json();

  await browser.close();
  return data;
}

// bezpieczne wydobycie tablicy rekordów z payloadu (różne wdrożenia różnie zwracają)
function pickRows(payload){
  const seen = new Set();
  function findArray(obj){
    if (!obj || typeof obj !== 'object') return [];
    if (seen.has(obj)) return [];
    seen.add(obj);
    for (const key of ['data','rows','items','result','records']) {
      if (Array.isArray(obj?.[key])) return obj[key];
    }
    if (Array.isArray(obj)) return obj;
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') {
        const inner = findArray(v);
        if (inner.length) return inner;
      }
    }
    return [];
  }
  return findArray(payload);
}

// mapowanie rekordów → eventy
function toEvents(payload){
  const rows = pickRows(payload);
  const out = [];
  for(const r of rows){
    const rawId =
      r.idZajec || r.idHarmonogramu || r.id || r.identyfikator || r.uuid || null;

    const dRaw = r.termin || r.data || r.dataZajec || r.date;
    const sRaw = r.godzOd || r.od || r.start || r.godzinaOd;
    const eRaw = r.godzDo || r.do || r.end   || r.godzinaDo;

    const title= r.nazwa || r.przedmiot || r.tytul || r.title || 'Zajęcia';
    const room = r.sala || r.salaNazwa || '';
    const city = r.lokalizacja || r.miasto || '';
    const form = r.forma || r.typ || '';
    const teach= r.dydaktyk || r.prowadzacy || r.nauczyciel || '';

    const d  = parseDate(dRaw);
    const st = parseTime(sRaw);
    const en = parseTime(eRaw);
    if(!d || !st || !en) continue;

    out.push({ rawId, d, st, en,
      title: stripNiestacjonarne(title),
      room, city,
      form: stripNiestacjonarne(form),
      teach
    });
  }
  return out;
}

// stabilny UID: preferuj ID z WU, w przeciwnym razie hash z pól
function stableUid(e) {
  if (e.rawId) {
    const d = e.d.toISOString().slice(0,10);
    return `wu-${e.rawId}-${d}-${pad2(e.st.h)}${pad2(e.st.mi)}@wu`;
  }
  const key = [
    e.title, e.room, e.city, e.form,
    e.d.toISOString().slice(0,10),
    `${e.st.h}:${e.st.mi}`, `${e.en.h}:${e.en.mi}`
  ].join('|');
  const h = createHash('sha1').update(key).digest('hex').slice(0,16);
  return `wu-${h}@wu`;
}

function buildICS(events){
  const lines = [
    'BEGIN:VCALENDAR','VERSION:2.0','CALSCALE:GREGORIAN',
    'PRODID:-//WU Varsovia//auto-ics//PL','METHOD:PUBLISH',
    'X-WR-CALNAME:Plan studiów (auto)', 'X-WR-TIMEZONE:Europe/Warsaw'
  ];
  for(const e of events){
    const loc=[e.room,e.city].filter(Boolean).join(', ');

    // nie dopisujemy formy, jeśli to niestacjonarne; inne formy (np. online) zostawiamy
    const formRaw = (e.form || '').trim();
    const shouldAppendForm = formRaw && !/niestacjon/i.test(formRaw);
    const title = e.title + (shouldAppendForm ? ` (${formRaw})` : '');

    const desc  = e.teach ? `Prowadzący: ${e.teach}` : '';

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${stableUid(e)}`);
    lines.push(`SUMMARY:${esc(title)}`);
    if(loc)  lines.push(`LOCATION:${esc(loc)}`);
    if(desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    lines.push(`DTSTART;TZID=${TZ}:${dtstr(e.d, e.st.h, e.st.mi)}`);
    lines.push(`DTEND;TZID=${TZ}:${dtstr(e.d, e.en.h, e.en.mi)}`);
    lines.push('BEGIN:VALARM','TRIGGER:-PT15M','ACTION:DISPLAY','DESCRIPTION:Przypomnienie','END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

async function updateGist(content){
  const url = `https://api.github.com/gists/${GIST_ID}`;
  const res = await undiciRequest(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${GIST_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'wu-ics/1.0 (+https://github.com/smuutny/wu-ics)'
    },
    body: JSON.stringify({ files: { 'varsovia-plan.ics': { content } } })
  });
  if(res.statusCode >= 300){
    const txt = await res.body.text();
    throw new Error(`Gist update failed: ${res.statusCode} ${txt}`);
  }
}

(async () => {
  const payload = await loginAndFetchJSON();
  const events = toEvents(payload);
  if(!events.length) throw new Error('Brak wydarzeń – sprawdź czy HARMONOGRAM_URL zwraca dane.');
  const ics = buildICS(events);
  await updateGist(ics);
  console.log(`OK – wygenerowano ${events.length} wydarzeń.`);
})();
