// NEXA Cloudflare Worker - background reminder service
// Cron -> Firestore -> OneSignal
// Time zone used by NEXA: Asia/Ho_Chi_Minh

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const FIRESTORE_AUD = 'https://oauth2.googleapis.com/token';
const ONESIGNAL_URL = 'https://api.onesignal.com/notifications';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminderCheck(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({ ok: true, service: 'NEXA reminder worker' });
    }
    if (url.pathname === '/run') {
      // Optional manual test endpoint protected by a secret.
      if (env.RUN_SECRET && request.headers.get('x-run-secret') !== env.RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const result = await runReminderCheck(env);
      return json(result);
    }
    return new Response('NEXA reminder worker is running.', { status: 200 });
  }
};

async function runReminderCheck(env) {
  const now = vnNow();
  const today = vnDate(now);
  const hhmm = vnTime(now);

  const token = await googleAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID || JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON).project_id;

  let pageToken = '';
  let users = 0, checked = 0, sent = 0, errors = [];

  do {
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users?pageSize=100${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Firestore list users failed: ${res.status} ${await res.text()}`);
    const payload = await res.json();

    for (const doc of payload.documents || []) {
      users++;
      try {
        const data = firestoreFieldsToJs(doc.fields || {});
        const appData = data.appData || {};
        const tasks = Array.isArray(appData.tasks) ? appData.tasks : [];
        if (!tasks.length) continue;

        const reminderState = (data.reminderState && typeof data.reminderState === 'object') ? data.reminderState : {};
        let changed = false;

        for (const task of tasks) {
          checked++;
          if (!task || !task.id || task.done || !task.time || !taskOccursOn(task, today)) continue;
          if (String(task.time).slice(0,5) > hhmm) continue;

          const state = reminderState[task.id] || {};
          const interval = reminderMinutes(task.reminderInterval);

          // One notification per occurrence window. The state date resets automatically on a new day.
          const lastDate = state.lastDate || '';
          const lastMinute = Number(state.lastMinute || -999999);
          const minuteOfDay = Number(hhmm.slice(0,2)) * 60 + Number(hhmm.slice(3,5));

          let due = false;
          if (lastDate !== today) due = true;
          else if (interval > 0 && minuteOfDay - lastMinute >= interval) due = true;
          else if (interval === 0) due = false;

          if (!due) continue;

          await sendOneSignal(env, doc.name.split('/').pop(), task, today, hhmm);
          reminderState[task.id] = {
            lastDate: today,
            lastMinute: minuteOfDay,
            lastNotifiedAt: now.toISOString(),
            title: String(task.title || '')
          };
          changed = true;
          sent++;
        }

        if (changed) {
          await updateReminderState(token, projectId, doc.name, reminderState);
        }
      } catch (err) {
        console.error('User reminder error:', err);
        errors.push(String(err.message || err));
      }
    }

    pageToken = payload.nextPageToken || '';
  } while (pageToken);

  const result = { ok: true, users, checked, sent, errors, at: now.toISOString() };
  console.log(JSON.stringify(result));
  return result;
}

async function sendOneSignal(env, uid, task, date, time) {
  const interval = reminderMinutes(task.reminderInterval);
  const isRepeat = interval > 0;
  const body = isRepeat
    ? `⏰ ${task.title || 'Bạn còn một công việc chưa hoàn thành'} — vẫn chưa được tick. NEXA sẽ tiếp tục nhắc sau ${interval} phút.`
    : `⏰ ${task.title || 'Bạn có một công việc đến giờ'} — hãy đánh dấu hoàn thành khi đã xong.`;

  const payload = {
    app_id: env.ONESIGNAL_APP_ID,
    include_aliases: { external_id: [String(uid)] },
    target_channel: 'push',
    headings: { en: 'NEXA nhắc việc 🌱' },
    contents: { en: body },
    data: {
      type: 'nexa_task_reminder',
      taskId: String(task.id),
      date,
      time
    }
  };

  const res = await fetch(ONESIGNAL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Key ${env.ONESIGNAL_REST_API_KEY}`
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`OneSignal failed: ${res.status} ${await res.text()}`);
}

function reminderMinutes(v) {
  const s = String(v || '15 phút');
  if (s === 'Không nhắc lại') return 0;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : 15;
}

function taskOccursOn(t, date) {
  if (!t.date) return false;
  if (t.date === date) return true;
  if (date < t.date) return false;
  const dt = new Date(date + 'T12:00:00+07:00');
  const start = new Date(t.date + 'T12:00:00+07:00');
  const r = t.repeat || 'Không lặp';
  if (r === 'Hàng ngày' || r === 'Hằng ngày') return true;
  if (r === 'Hàng tuần' || r === 'Hằng tuần') return dt.getUTCDay() === start.getUTCDay();
  if (r === 'Ngày đầu tiên mỗi tháng') return Number(date.slice(8,10)) === 1;
  if (r === 'Ngày cuối cùng mỗi tháng') {
    const d = new Date(date + 'T12:00:00+07:00');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.getUTCDate() === 1;
  }
  const lunar = lunarDayForSolar(date);
  if (r === 'Ngày 1 âm lịch') return lunar.day === 1;
  if (r === 'Ngày 14 âm lịch') return lunar.day === 14;
  if (r === 'Ngày 15 âm lịch') return lunar.day === 15;
  if (r === 'Ngày cuối tháng âm lịch') return lunar.last;
  return false;
}

// Same Vietnamese lunar-day algorithm used by the uploaded NEXA index.html.
function lunarDayForSolar(dateStr) {
  const [yy, mm, dd] = dateStr.split('-').map(Number);
  const PI = Math.PI;
  function jdFromDate(d,m,y){let a=Math.floor((14-m)/12),yy=y+4800-a,mm=m+12*a-3;let jd=d+Math.floor((153*mm+2)/5)+365*yy+Math.floor(yy/4)-Math.floor(yy/100)+Math.floor(yy/400)-32045;if(jd<2299161)jd=d+Math.floor((153*mm+2)/5)+365*yy+Math.floor(yy/4)-32083;return jd}
  function newMoon(k){let T=k/1236.85,T2=T*T,T3=T2*T,dr=PI/180;let jd=2415020.75933+29.53058868*k+0.0001178*T2-0.000000155*T3+0.00033*Math.sin((166.56+132.87*T-0.009173*T2)*dr);let M=359.2242+29.10535608*k-0.0000333*T2-0.00000347*T3;let Mpr=306.0253+385.81691806*k+0.0107306*T2+0.00001236*T3;let F=21.2964+390.67050646*k-0.0016528*T2-0.00000239*T3;let C=(0.1734-0.000393*T)*Math.sin(M*dr)+0.0021*Math.sin(2*M*dr)-0.4068*Math.sin(Mpr*dr)+0.0161*Math.sin(2*Mpr*dr)-0.0004*Math.sin(3*Mpr*dr)+0.0104*Math.sin(2*F*dr)-0.0051*Math.sin((M+Mpr)*dr)-0.0074*Math.sin((M-Mpr)*dr)+0.0004*Math.sin((2*F+M)*dr)-0.0004*Math.sin((2*F-M)*dr)-0.0006*Math.sin((2*F+Mpr)*dr)+0.0010*Math.sin(2*dr*Mpr)+0.0005*Math.sin((2*Mpr)*dr);let dt=T<-11?0.001+0.000839*T+0.0002261*T2-0.00000845*T3-0.000000081*T*T3:-0.000278+0.000265*T+0.000262*T2;return jd+C-dt}
  function sunLongitude(jdn){let T=(jdn-2451545.0)/36525,T2=T*T,dr=PI/180;let M=357.52910+35999.05030*T-0.0001559*T2-0.00000048*T*T2;let L0=280.46645+36000.76983*T+0.0003032*T2;let DL=(1.914600-0.004817*T-0.000014*T2)*Math.sin(dr*M)+(0.019993-0.000101*T)*Math.sin(2*dr*M)+0.000290*Math.sin(3*dr*M);let L=(L0+DL)*dr;L=L-PI*2*Math.floor(L/(PI*2));return L}
  function getNewMoonDay(k,tz){return Math.floor(newMoon(k)+0.5+tz/24)}
  function getSunLongitude(day,tz){return Math.floor(sunLongitude(day-0.5-tz/24)/PI*6)}
  function getLunarMonth11(y,tz){let off=jdFromDate(31,12,y)-2415021,k=Math.floor(off/29.530588853),nm=getNewMoonDay(k,tz);if(getSunLongitude(nm,tz)>=9)nm=getNewMoonDay(k-1,tz);return nm}
  function getLeapMonthOffset(a11,tz){let k=Math.floor(0.5+(a11-2415021.076998695)/29.530588853),last=0,i=1,arc=getSunLongitude(getNewMoonDay(k+i,tz),tz);do{last=arc;i++;arc=getSunLongitude(getNewMoonDay(k+i,tz),tz)}while(arc!==last&&i<14);return i-1}
  let jd=jdFromDate(dd,mm,yy),k=Math.floor((jd-2415021.076998695)/29.530588853),monthStart=getNewMoonDay(k+1,7);if(monthStart>jd)monthStart=getNewMoonDay(k,7);let a11=getLunarMonth11(yy,7),b11=a11,lunarYear;if(a11>=monthStart){lunarYear=yy;a11=getLunarMonth11(yy-1,7)}else{lunarYear=yy+1;b11=getLunarMonth11(yy+1,7)}let lunarDay=jd-monthStart+1;let diff=Math.floor((monthStart-a11)/29),lunarMonth=diff+11;if(b11-a11>365){let leap=getLeapMonthOffset(a11,7);if(diff>=leap){lunarMonth=diff+10}}if(lunarMonth>12)lunarMonth-=12;if(lunarMonth>=11&&diff<4)lunarYear--;let nextStart=getNewMoonDay(k+1,7);if(nextStart<=monthStart)nextStart=getNewMoonDay(k,7);let lastDay=nextStart-monthStart;return {day:lunarDay,month:lunarMonth,year:lunarYear,last:lunarDay===lastDay}
}

// ---- Firestore REST helpers ----
async function googleAccessToken(env) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: FIRESTORE_SCOPE,
    aud: FIRESTORE_AUD,
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const keyPem = sa.private_key;
  const signature = await signRs256(keyPem, unsigned);
  const assertion = `${unsigned}.${b64urlBytes(signature)}`;

  const res = await fetch(FIRESTORE_AUD, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!res.ok) throw new Error(`Google token failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.access_token;
}

async function signRs256(pem, data) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data)));
}

function b64url(s) { return b64urlBytes(new TextEncoder().encode(s)); }
function b64urlBytes(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function updateReminderState(token, projectId, docName, reminderState) {
  const url = `https://firestore.googleapis.com/v1/${docName}?updateMask.fieldPaths=reminderState`;
  const body = { fields: { reminderState: jsToFirestoreValue(reminderState) } };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Firestore reminder state update failed: ${res.status} ${await res.text()}`);
}

function firestoreFieldsToJs(fields) {
  const out = {};
  for (const [k,v] of Object.entries(fields)) out[k] = firestoreValueToJs(v);
  return out;
}
function firestoreValueToJs(v) {
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return firestoreFieldsToJs(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(firestoreValueToJs);
  return null;
}
function jsToFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(jsToFirestoreValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k,val] of Object.entries(v)) fields[k] = jsToFirestoreValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function vnNow() {
  // Date itself remains UTC internally; formatting below obtains Vietnam wall-clock parts.
  return new Date();
}
function vnParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type,p.value]));
  return parts;
}
function vnDate(date) {
  const p = vnParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}
function vnTime(date) {
  const p = vnParts(date);
  return `${p.hour}:${p.minute}`;
}
function json(x){ return new Response(JSON.stringify(x,null,2), { headers:{'content-type':'application/json;charset=utf-8'} }); }
