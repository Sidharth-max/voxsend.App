// One phone validator for the browser (window.VxPhone) and the server (require('../js/phonecheck')).
// normalize(): bare 10 digits -> +<cc>, trunk 0s dropped, '+' kept. check(): E.164 plus per-country
// national-length rules for the countries we call most; others get the generic 8-15 digit rule.
(function (root) {
    // ISO + dial code. Kept in sync with the country-code dropdown (js/countries.js reads it).
    const RAW = 'AF93,AL355,DZ213,AS1684,AD376,AO244,AI1264,AG1268,AR54,AM374,AW297,AU61,AT43,AZ994,BS1242,BH973,BD880,BB1246,BY375,BE32,BZ501,BJ229,BM1441,BT975,BO591,BA387,BW267,BR55,IO246,VG1284,BN673,BG359,BF226,BI257,KH855,CM237,CA1,CV238,KY1345,CF236,TD235,CL56,CN86,CO57,KM269,CG242,CD243,CK682,CR506,CI225,HR385,CU53,CW599,CY357,CZ420,DK45,DJ253,DM1767,DO1809,EC593,EG20,SV503,GQ240,ER291,EE372,SZ268,ET251,FK500,FO298,FJ679,FI358,FR33,GF594,PF689,GA241,GM220,GE995,DE49,GH233,GI350,GR30,GL299,GD1473,GP590,GU1671,GT502,GG44,GN224,GW245,GY592,HT509,HN504,HK852,HU36,IS354,IN91,ID62,IR98,IQ964,IE353,IM44,IL972,IT39,JM1876,JP81,JE44,JO962,KZ7,KE254,KI686,XK383,KW965,KG996,LA856,LV371,LB961,LS266,LR231,LY218,LI423,LT370,LU352,MO853,MG261,MW265,MY60,MV960,ML223,MT356,MH692,MQ596,MR222,MU230,YT262,MX52,FM691,MD373,MC377,MN976,ME382,MS1664,MA212,MZ258,MM95,NA264,NR674,NP977,NL31,NC687,NZ64,NI505,NE227,NG234,NU683,KP850,MK389,MP1670,NO47,OM968,PK92,PW680,PS970,PA507,PG675,PY595,PE51,PH63,PL48,PT351,PR1787,QA974,RE262,RO40,RU7,RW250,KN1869,LC1758,PM508,VC1784,WS685,SM378,ST239,SA966,SN221,RS381,SC248,SL232,SG65,SX1721,SK421,SI386,SB677,SO252,ZA27,KR82,SS211,ES34,LK94,SD249,SR597,SE46,CH41,SY963,TW886,TJ992,TZ255,TH66,TL670,TG228,TO676,TT1868,TN216,TR90,TM993,TC1649,TV688,UG256,UA380,AE971,GB44,US1,UY598,VI1340,UZ998,VU678,VA39,VE58,VN84,WF681,YE967,ZM260,ZW263';
    const COUNTRIES = RAW.split(',').map(s => ({ iso: s.slice(0, 2), dial: s.slice(2) }));
    const DIALS = Array.from(new Set(COUNTRIES.map(c => c.dial))).sort((a, b) => b.length - a.length);
    // National number rules: [min, max, leading-digit regex, hint].
    const RULES = {
        91: [10, 10, /^[2-9]/, 'Indian numbers are 10 digits after +91, starting 2-9'],
        1: [10, 10, /^[2-9]/, 'US/Canada numbers are 10 digits'],
        44: [10, 10, /^[1-9]/, 'UK numbers are 10 digits after +44'],
        971: [8, 9, /^[2-9]/, 'UAE numbers are 8-9 digits after +971'],
        966: [9, 9, /^[1-9]/, 'Saudi numbers are 9 digits after +966'],
        974: [8, 8, /^[3-7]/, 'Qatar numbers are 8 digits after +974'],
        968: [8, 8, /^[2-9]/, 'Oman numbers are 8 digits after +968'],
        965: [8, 8, /^[1-9]/, 'Kuwait numbers are 8 digits after +965'],
        973: [8, 8, /^[1-9]/, 'Bahrain numbers are 8 digits after +973'],
        65: [8, 8, /^[3689]/, 'Singapore numbers are 8 digits after +65'],
        61: [9, 9, /^[2-478]/, 'Australian numbers are 9 digits after +61'],
        977: [8, 10, /^[1-9]/, 'Nepal numbers are 8-10 digits after +977'],
        880: [10, 10, /^1/, 'Bangladesh mobiles are 10 digits after +880'],
        94: [9, 9, /^[1-9]/, 'Sri Lankan numbers are 9 digits after +94'],
        92: [10, 10, /^[1-9]/, 'Pakistan numbers are 10 digits after +92'],
        54: [10, 11, /^[1-9]/, 'Argentine numbers are 10 digits after +54 (11 with the mobile 9)'],
        49: [6, 13, /^[1-9]/, 'German numbers are 6-13 digits after +49'],
        33: [9, 9, /^[1-9]/, 'French numbers are 9 digits after +33'],
        86: [10, 11, /^[1-9]/, 'Chinese numbers are 10-11 digits after +86'],
        7: [10, 10, /^[3-9]/, 'Russia/Kazakhstan numbers are 10 digits after +7']
    };
    const clean = (v = '') => String(v || '').trim().replace(/\s+/g, '').replace(/(?!^)\+/g, '').replace(/[^0-9+]/g, '');
    function normalize(v = '', cc = '91') {
        const c = clean(v);
        if (!c) return '';
        if (c.startsWith('+')) return '+' + c.slice(1).replace(/^0+/, '');
        let d = c.replace(/^00/, '');
        if (c.startsWith('00')) return '+' + d;
        d = d.replace(/^0+/, '');
        if (d.length === 10) return '+' + String(cc || '91') + d;
        return '+' + d;
    }
    // { ok, e164, reason, fix, cc }
    function check(v = '', cc = '91') {
        const raw = String(v || '').trim();
        if (!raw) return { ok: false, e164: '', reason: 'Empty number', fix: null };
        if (/[a-z]/i.test(raw.replace(/^(tel:)/i, ''))) return { ok: false, e164: '', reason: 'Contains letters', fix: null };
        const e164 = normalize(raw, cc);
        const d = e164.slice(1);
        if (d.length < 8) return { ok: false, e164, reason: 'Missing digits', fix: null };
        if (d.length > 15) return { ok: false, e164, reason: 'Too many digits', fix: null };
        const dial = DIALS.find(x => d.startsWith(x));
        if (!dial) return { ok: false, e164, reason: `Unknown country code +${d.slice(0, 3)}?`, fix: null };
        const nat = d.slice(dial.length);
        const r = RULES[dial];
        if (r) {
            if (nat.length < r[0]) {
                return { ok: false, e164, cc: dial, reason: 'Missing digits', hint: r[3],
                    fix: d.length === 10 && /^[6-9]/.test(d) ? '+91' + d : null };
            }
            if (nat.length > r[1]) return { ok: false, e164, cc: dial, reason: 'Too many digits', hint: r[3], fix: null };
            if (!r[2].test(nat)) return { ok: false, e164, cc: dial, reason: 'Invalid start digit', hint: r[3], fix: null };
        } else if (nat.length < 4) {
            return { ok: false, e164, cc: dial, reason: 'Missing digits', fix: null };
        }
        return { ok: true, e164, cc: dial, reason: '', fix: null };
    }
    const api = { RAW, COUNTRIES, clean, normalize, check };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.VxPhone = api;
})(typeof window !== 'undefined' ? window : this);
