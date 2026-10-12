#!/usr/bin/env node
// Encrypted backup of the old .env file(s) for cutover/rollback. Never writes plaintext
// anywhere except back into the app directory on restore (mode 600).
//   envvault.js seal   --key <master.key> --dir <app dir> --out <vault>   (.env and .env.* except .env.example)
//   envvault.js unseal --key <master.key> --in <vault> --dir <app dir>    restore the files (mode 600)
//   envvault.js cat    --key <master.key> --in <vault> [--name .env]      plaintext to stdout (for a pipe only)
//   envvault.js list   --key <master.key> --in <vault>                    file names in the vault
// Format: "VOXSEND-ENV-VAULT-1\n" + JSON {key_id, iv, tag, data}; AES-256-GCM, key = 64 hex chars.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const MAGIC = 'VOXSEND-ENV-VAULT-1\n';
const args = process.argv.slice(2);
const cmd = args[0];
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const die = m => { console.error('envvault: ' + m); process.exit(1); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function key() {
    const f = opt('key') || die('--key required');
    const hex = fs.readFileSync(f, 'utf8').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) die(`${f} must hold 64 hex characters`);
    return Buffer.from(hex, 'hex');
}
const keyId = k => sha(k).slice(0, 16);
const envFiles = dir => fs.readdirSync(dir).filter(n => /^\.env(\..+)?$/.test(n) && n !== '.env.example' && fs.statSync(path.join(dir, n)).isFile()).sort();

function open(file, k) {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.startsWith(MAGIC)) die(`${file} is not an env vault`);
    const v = JSON.parse(raw.slice(MAGIC.length));
    if (v.key_id !== keyId(k)) die(`${file} was sealed with another key (${v.key_id})`);
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(v.iv, 'base64'));
    d.setAuthTag(Buffer.from(v.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(v.data, 'base64')), d.final()]).toString('utf8'));
}

if (cmd === 'seal') {
    const k = key(), dir = opt('dir') || die('--dir required'), out = opt('out') || die('--out required');
    if (fs.existsSync(out)) die(`${out} already exists`);
    const names = envFiles(dir);
    if (!names.includes('.env')) die(`no .env in ${dir}`);
    const files = names.map(name => {
        const p = path.join(dir, name);
        return { name, mode: fs.statSync(p).mode & 0o777, b64: fs.readFileSync(p).toString('base64') };
    });
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', k, iv);
    const data = Buffer.concat([c.update(JSON.stringify({ sealed_at: new Date().toISOString(), files }), 'utf8'), c.final()]);
    const body = MAGIC + JSON.stringify({ key_id: keyId(k), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }) + '\n';
    fs.writeFileSync(out, body, { mode: 0o600, flag: 'wx' });
    // read back and compare every file before reporting success
    const back = open(out, k);
    for (const f of files) {
        const g = back.files.find(x => x.name === f.name);
        if (!g || sha(Buffer.from(g.b64, 'base64')) !== sha(fs.readFileSync(path.join(dir, f.name)))) die(`verification failed for ${f.name}`);
    }
    console.log(`sealed ${files.length} file(s) into ${out} (aes-256-gcm, key ${keyId(k)}), verified: ${names.join(' ')}`);
} else if (cmd === 'unseal') {
    const k = key(), file = opt('in') || die('--in required'), dir = opt('dir') || die('--dir required');
    const v = open(file, k);
    for (const f of v.files) {
        const p = path.join(dir, f.name), tmp = p + '.restore-tmp';
        fs.writeFileSync(tmp, Buffer.from(f.b64, 'base64'), { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, p);
    }
    console.log(`restored ${v.files.map(f => f.name).join(' ')} into ${dir} (mode 600)`);
} else if (cmd === 'cat') {
    const k = key(), file = opt('in') || die('--in required'), name = opt('name') || '.env';
    if (process.stdout.isTTY) die('refusing to print secrets to a terminal; pipe it into a command');
    const f = open(file, k).files.find(x => x.name === name) || die(`${name} not in vault`);
    process.stdout.write(Buffer.from(f.b64, 'base64'));
} else if (cmd === 'list') {
    const k = key(), file = opt('in') || die('--in required');
    const v = open(file, k);
    console.log(`sealed ${v.sealed_at}: ${v.files.map(f => f.name).join(' ')}`);
} else {
    die('usage: seal|unseal|cat|list (see the header of this file)');
}
