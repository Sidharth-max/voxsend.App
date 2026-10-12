// Safety rails that keep dev/test instances away from prod data and real phones.
// "Prod" means: code running from VOXSEND_PROD_DIR (/home/box/voxsend.App), schema
// `voxsend`, database `voxsend`. Anything else is a dev/test instance and:
//   - may not use the `voxsend` database or the `voxsend` schema;
//   - may not load an env file from the prod directory;
//   - may only talk to a Sarvam API on localhost (a stub), and never to Twilio/Vobiz.
const fs = require('fs');
const path = require('path');

// VOXSEND_PROD_DIR lets a deployed copy (e.g. /app in the Fly.io image) be the prod app.
const PROD_DIR = process.env.VOXSEND_PROD_DIR || '/home/box/voxsend.App';
const APP_DIR = path.resolve(__dirname, '..');
const real = p => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };

function dbName(url) {
    bootenv.apply();
    url = url || process.env.DATABASE_URL;
    try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || null; } catch (e) { return null; }
}
const bootenv = require('./bootenv');
const schema = () => { bootenv.apply(); return process.env.PGSCHEMA || null; };
const fromProdDir = () => real(APP_DIR) === PROD_DIR;
const isProd = () => fromProdDir() && schema() === 'voxsend' && dbName() === 'voxsend';

// Throws unless this process may use the configured database/schema.
function assertDbAllowed() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    if (!schema()) throw new Error('PGSCHEMA is not set (no default: put ?schema=voxsend in DATABASE_URL for prod, voxsend_test for tests).');
    if (isProd()) return 'prod';
    if (dbName() === 'voxsend' || schema() === 'voxsend') {
        throw new Error(`Refusing to use the prod database/schema from ${APP_DIR}: only ${PROD_DIR} with PGSCHEMA=voxsend may. Use the test database.`);
    }
    return 'dev';
}

function assertEnvFileAllowed(file) {
    if (!fromProdDir() && real(file).startsWith(PROD_DIR + path.sep)) {
        throw new Error(`Refusing to load ${file}: dev/test instances may not read the prod .env.`);
    }
}

const localUrl = u => { try { return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname); } catch (e) { return false; } };

// null when this provider may be called, else the reason it may not.
function dialBlockedReason(provider) {
    if (isProd()) return null;
    if (provider !== 'sarvam') return `${provider} calls are disabled outside prod (dev/test instance).`;
    if (!process.env.SARVAM_BASE_URL || !localUrl(process.env.SARVAM_BASE_URL)) return 'Real Sarvam is disabled outside prod: set SARVAM_BASE_URL to a local stub.';
    return null;
}
const sarvamHttpBlockedReason = () => dialBlockedReason('sarvam');

module.exports = { PROD_DIR, APP_DIR, isProd, dbName, assertDbAllowed, assertEnvFileAllowed, dialBlockedReason, sarvamHttpBlockedReason, localUrl };
