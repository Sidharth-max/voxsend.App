// Small shared helpers (phones, schedule rules, time zones).
const sanitizePhoneNumber = (value = '') => {
    if (!value) return '';
    let n = String(value).trim().replace(/\s+/g, '');
    n = n.replace(/(?!^)\+/g, '').replace(/[^0-9+]/g, '');
    if (!n) return '';
    if (!n.startsWith('+')) n = '+' + n.replace(/^\++/, '');
    return n;
};
const normalizePhoneKey = (value = '') => sanitizePhoneNumber(value).replace(/[^0-9]/g, '');
const dedupeRecipients = (numbers = []) => {
    const seen = new Set();
    const unique = [];
    let duplicates = 0;
    (Array.isArray(numbers) ? numbers : []).forEach(num => {
        const cleaned = sanitizePhoneNumber(num);
        const key = normalizePhoneKey(cleaned);
        if (!key) return;
        if (seen.has(key)) { duplicates++; return; }
        seen.add(key);
        unique.push(cleaned);
    });
    return { unique, duplicates };
};

const PROVIDERS = ['twilio', 'vobiz', 'sarvam'];
const MAX_SCHEDULE_OCCURRENCES = 200;
const SCHEDULE_MODES = ['once', 'dates', 'daily', 'weekly', 'custom'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^\d{2}:\d{2}$/;

// Keeps only well-formed rule fields from the browser/CLI.
function cleanScheduleRule(rule, times) {
    const r = rule && typeof rule === 'object' ? rule : {};
    const mode = SCHEDULE_MODES.includes(r.mode) ? r.mode : (times.length > 1 ? 'dates' : 'once');
    const list = (v, re) => (Array.isArray(v) ? [...new Set(v.map(String).filter(x => re.test(x)))].sort() : []);
    const weekdays = Array.isArray(r.weekdays) ? [...new Set(r.weekdays.map(Number).filter(d => d >= 0 && d <= 6))].sort() : [];
    const endAfter = parseInt(r.endAfter, 10);
    return {
        mode,
        dates: list(r.dates, YMD),
        startDate: YMD.test(r.startDate || '') ? r.startDate : null,
        endDate: YMD.test(r.endDate || '') ? r.endDate : null,
        endAfter: endAfter > 0 ? Math.min(endAfter, MAX_SCHEDULE_OCCURRENCES) : null,
        weekdays,
        skipWeekends: !!r.skipWeekends,
        times: list(r.times, HM),
        timezone: typeof r.timezone === 'string' ? r.timezone.slice(0, 64) : null
    };
}

function localParts(iso, tz) {
    const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    let fmt;
    try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata', ...opts }); }
    catch (e) { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', ...opts }); }
    const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const iso = v => (v instanceof Date ? v.toISOString() : v);
const httpError = (status, message) => Object.assign(new Error(message), { status });

module.exports = {
    sanitizePhoneNumber, normalizePhoneKey, dedupeRecipients, PROVIDERS, MAX_SCHEDULE_OCCURRENCES,
    cleanScheduleRule, localParts, iso, httpError, YMD, HM
};

// UTC instant for a wall-clock date/time in a time zone ("2027-01-05", "10:30", "Asia/Kolkata").
function zonedToUtc(date, time, tz = 'Asia/Kolkata') {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    const want = Date.UTC(y, mo - 1, d, h, mi);
    let guess = want;
    for (let i = 0; i < 3; i++) {
        const p = localParts(new Date(guess).toISOString(), tz);
        const [py, pmo, pd] = p.date.split('-').map(Number);
        const [ph, pmi] = p.time.split(':').map(Number);
        guess += want - Date.UTC(py, pmo - 1, pd, ph, pmi);
    }
    return new Date(guess);
}

// Expands a repeat rule into run times (same rules as the browser's schedule picker).
// rule: { mode, dates[], startDate, endDate, endAfter, weekdays[], skipWeekends, times[], timezone }
function expandRule(rule) {
    const r = cleanScheduleRule(rule, []);
    const tz = r.timezone || 'Asia/Kolkata';
    if (!r.times.length) throw httpError(400, 'Give at least one time (HH:MM).');
    let days = [];
    if (r.mode === 'once' || r.mode === 'dates' || r.mode === 'custom') {
        days = r.dates.length ? r.dates : (r.startDate ? [r.startDate] : []);
        if (!days.length) throw httpError(400, 'Give at least one date (YYYY-MM-DD).');
    } else {
        if (!r.startDate) throw httpError(400, 'A repeating schedule needs a start date.');
        if (!r.endDate && !r.endAfter) throw httpError(400, 'A repeating schedule needs an end date or a number of times.');
        const cur = new Date(r.startDate + 'T00:00:00Z');
        const stop = r.endDate ? new Date(r.endDate + 'T00:00:00Z') : new Date(cur.getTime() + 400 * 86400000);
        for (; cur <= stop && days.length < MAX_SCHEDULE_OCCURRENCES; cur.setUTCDate(cur.getUTCDate() + 1)) {
            const dow = cur.getUTCDay();
            if (r.mode === 'weekly' && r.weekdays.length && !r.weekdays.includes(dow)) continue;
            if (r.skipWeekends && (dow === 0 || dow === 6)) continue;
            days.push(cur.toISOString().slice(0, 10));
        }
    }
    let out = [];
    for (const d of days) for (const t of r.times) out.push(zonedToUtc(d, t, tz).toISOString());
    out = [...new Set(out)].sort();
    if (r.endAfter) out = out.slice(0, r.endAfter);
    return { times: out, rule: { ...r, timezone: tz } };
}

module.exports.zonedToUtc = zonedToUtc;
module.exports.expandRule = expandRule;
