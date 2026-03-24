const fs = require('fs');
const Database = require('better-sqlite3');
const db = new Database('voxsend.db');

console.log("🚀 Starting data migration...");

// 1. Migrate Contacts
if (fs.existsSync('contacts.json')) {
    try {
        const contacts = JSON.parse(fs.readFileSync('contacts.json', 'utf8'));
        const insert = db.prepare('INSERT OR IGNORE INTO contacts (name, phone, group_name) VALUES (?, ?, ?)');
        const insertMany = db.transaction((list) => {
            for (const c of list) {
                if (c.phone) {
                    insert.run(c.name || '', c.phone, c.group_name || '');
                }
            }
        });
        insertMany(Array.isArray(contacts) ? contacts : [contacts]);
        console.log(`✅ Migrated ${Array.isArray(contacts) ? contacts.length : 1} contacts.`);
    } catch (e) { console.error("❌ Error migrating contacts:", e.message); }
}

// 2. Migrate History
if (fs.existsSync('history.json')) {
    try {
        const history = JSON.parse(fs.readFileSync('history.json', 'utf8'));
        const insert = db.prepare('INSERT INTO history (message, language, total, successful, results, created_at) VALUES (?, ?, ?, ?, ?, ?)');
        const insertMany = db.transaction((list) => {
            for (const h of list) {
                insert.run(
                    h.message || '', 
                    h.language || 'hi-IN', 
                    h.total || 0, 
                    h.successful || 0, 
                    JSON.stringify(h.results || []), 
                    h.created_at || h.date || new Date().toISOString()
                );
            }
        });
        insertMany(Array.isArray(history) ? history : [history]);
        console.log(`✅ Migrated ${Array.isArray(history) ? history.length : 1} history records.`);
    } catch (e) { console.error("❌ Error migrating history:", e.message); }
}

// 3. Migrate Messages
if (fs.existsSync('messages.json')) {
    try {
        const messages = JSON.parse(fs.readFileSync('messages.json', 'utf8'));
        const insert = db.prepare('INSERT INTO messages (content, language) VALUES (?, ?)');
        const insertMany = db.transaction((list) => {
            for (const m of list) {
                insert.run(m.content || '', m.language || 'hi-IN');
            }
        });
        insertMany(Array.isArray(messages) ? messages : [messages]);
        console.log(`✅ Migrated ${Array.isArray(messages) ? messages.length : 1} message templates.`);
    } catch (e) { console.error("❌ Error migrating messages:", e.message); }
}

// 4. Migrate Settings
if (fs.existsSync('settings.json')) {
    try {
        const s = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
        db.prepare(`UPDATE settings SET parallel_calls=?, retry_failed=?, default_language=?, delay_ms=?, org_name=? WHERE id=1`)
          .run(
              s.parallel_calls || 10, 
              s.retry_failed || 0, 
              s.default_language || 'hi-IN', 
              s.delay_ms || 200, 
              s.org_name || ''
          );
        console.log(`✅ Migrated settings.`);
    } catch (e) { console.error("❌ Error migrating settings:", e.message); }
}

console.log("🎉 Migration complete! You can now delete the .json files or keep them as backups.");
process.exit(0);
