#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const normalizePhoneKey = (value = '') => String(value).replace(/\D/g, '');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const dbPath = path.join(__dirname, '..', 'voxsend.db');

if (!fs.existsSync(dbPath)) {
    console.error('Database file not found at', dbPath);
    process.exit(1);
}

const db = new Database(dbPath, { readonly: dryRun });

try {
    const rows = db.prepare('SELECT id, name, phone, group_name, created_at FROM contacts ORDER BY created_at ASC, id ASC').all();
    if (!rows.length) {
        console.log('No contacts found to evaluate.');
        process.exit(0);
    }

    const seen = new Map();
    const toDelete = [];

    rows.forEach(row => {
        const key = normalizePhoneKey(row.phone);
        if (!key) return;
        if (seen.has(key)) {
            toDelete.push({ id: row.id, phone: row.phone, name: row.name, group: row.group_name });
        } else {
            seen.set(key, row);
        }
    });

    if (!toDelete.length) {
        console.log('All contacts are already unique.');
        process.exit(0);
    }

    if (dryRun) {
        console.log('Dry-run mode: the following contacts would be removed:');
        toDelete.forEach((entry, idx) => {
            console.log(`${idx + 1}. #${entry.id} ${entry.phone} (${entry.name || 'No name'})`);
        });
        console.log(`Total duplicates detected: ${toDelete.length}`);
        process.exit(0);
    }

    const deleteStmt = db.prepare('DELETE FROM contacts WHERE id = ?');
    const deleteTxn = db.transaction(items => {
        items.forEach(item => deleteStmt.run(item.id));
    });
    deleteTxn(toDelete);

    console.log(`Removed ${toDelete.length} duplicate contact(s).`);
    console.log(`Remaining unique contacts: ${seen.size}`);
} catch (err) {
    console.error('Failed to deduplicate contacts:', err.message);
    process.exit(1);
} finally {
    db.close();
}
