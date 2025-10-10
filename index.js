import { chromium } from '@playwright/test';
import { request as undiciRequest } from 'undici';

const BASE         = process.env.WU_BASE_URL;      // np. https://wu.varsovia.study
const USER         = process.env.WU_USERNAME;
const PASS         = process.env.WU_PASSWORD;
const HREF         = process.env.HARMONOGRAM_URL;  // Twój XHR do spersonalizowanego harmonogramu
const GIST_ID      = process.env.GIST_ID;
const GIST_TOKEN   = process.env.GIST_TOKEN;
const TZ           = 'Europe/Warsaw';

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

async function loginAndFetchJSON(){
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  // typowe pola logowania
  const userSel = 'input[type="text"], input[type="email"], input[name*="user" i], input[name*="login" i]';
  const passSel = 'input[type="password"]';
  await page.waitForSelector(passSel, { timeout: 15000 });
  const u = await page.$(userSel); const p = await page.$(passSel);
  if(!u || !p) throw new Error('Nie znaleziono pól logowania.');
  await u.fill(USER); await p.fill(PASS);
  await Promise.all([ page.keyboard.press('Enter'), page.waitForLoadState('domcontentloaded') ]);

  // pobierz JSON z Twojego endpointu (działa z aktualną sesją)
  const resp = await page.request.get(HREF, { timeout: 30000 });
  if(!resp.ok()) throw new Error(`Błąd JSON: ${resp.status()} ${resp.statusText()}`);
  const data = await resp.json();

  await browser.close();
  return data;
}

function toEvents(payload){
  const rows = payload?.data || payload?.rows || payload || [];
  const out = [];
  for(const r of rows){
    const dRaw = r.termin || r.data || r.dataZajec || r.date;
    const sRaw = r.godzOd || r.od || r.start || r.godzinaOd;
    const eRaw = r.godzDo || r.do || r.end   || r.godzinaDo;
    const title= r.nazwa || r.przedmiot || r.tytul || r.title || 'Zajęcia';
    const room = r.sala || r.salaNazwa || '';
    const city = r.lokalizacja || r.miasto || '';
    const form = r.forma || r.typ || '';
    const teach= r.dydaktyk || r.prowadzacy || r.nauczyciel || '';

    const d = parseDate(dRaw), st = parseTime(sRaw), en = parseTime(eRaw);
    if(!d || !st || !en) continue;
    out.push({ d, st, en, title, room, city, form, teach });
  }
  return out;
}

function buildICS(events){
  const lines = [
    'BEGIN:VCALENDAR','VERSION:2.0','CALSCALE:GREGORIAN',
    'PRODID:-//WU Varsovia//auto-ics//PL','METHOD:PUBLISH',
    'X-WR-CALNAME:Plan studiów (auto)', 'X-WR-TIMEZONE:Europe/Warsaw'
  ];
  let i=0;
  for(const e of events){
    const loc=[e.room,e.city].filter(Boolean).join(', ');
    const title = e.title + (e.form?` (${e.form})`:'');
    const desc  = e.teach ? `Prowadzący: ${e.teach}` : '';
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:wu-${e.d.toISOString().slice(0,10)}-${pad2(e.st.h)}${pad2(e.st.mi)}-${i++}@gist`);
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
    headers: { 'Authorization': `Bearer ${GIST_TOKEN}`, 'Accept': 'application/vnd.github+json' },
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
  console.log(`OK – wydarzeń: ${events.length}`);
})();
