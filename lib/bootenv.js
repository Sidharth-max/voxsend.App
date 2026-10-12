// Bootstrap settings. The only configuration outside the database is:
//   DATABASE_URL             postgres://user:pass@host:port/db?schema=<schema>
//   VOXSEND_MASTER_KEY_FILE  32-byte hex key for the encrypted secrets
//   PORT                     (optional)
// The schema travels inside DATABASE_URL as "?schema=…" (PGSCHEMA still works for tests/CLI).
// There is no default schema. apply() is idempotent: it moves the schema parameter into
// process.env.PGSCHEMA and strips it from DATABASE_URL before pg sees the URL.
const BOOTSTRAP_KEYS = ['DATABASE_URL', 'VOXSEND_MASTER_KEY_FILE', 'VOXSEND_MASTER_KEY', 'PORT', 'PGSCHEMA', 'VOXSEND_PROD_DIR'];

function apply() {
    const raw = process.env.DATABASE_URL;
    if (!raw || !/[?&]schema=/.test(raw)) return;
    let u;
    try { u = new URL(raw); } catch (e) { throw new Error('DATABASE_URL is not a valid URL.'); }
    const s = u.searchParams.get('schema');
    u.searchParams.delete('schema');
    if (s) {
        if (process.env.PGSCHEMA && process.env.PGSCHEMA !== s) {
            throw new Error(`PGSCHEMA (${process.env.PGSCHEMA}) and DATABASE_URL ?schema=${s} disagree.`);
        }
        process.env.PGSCHEMA = s;
    }
    process.env.DATABASE_URL = u.toString();
}

module.exports = { apply, BOOTSTRAP_KEYS };
