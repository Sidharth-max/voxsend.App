let libraryData = [];

window.loadMessages = async function () {
    try {
        const res = await fetch('/api/messages');
        if (res.ok) {
            let data = await res.json();
            // Convert any old strings from local fallback or weird formats
            libraryData = data.map(msg => {
                if (typeof msg === 'string') return { name: 'Saved Message', content: msg };
                return msg;
            });
            localStorage.setItem('msg_lib', JSON.stringify(libraryData)); // sync local for fallback
        } else {
            throw new Error('API failure');
        }
    } catch (e) {
        let localData = JSON.parse(localStorage.getItem('msg_lib') || '[]');
        libraryData = localData.map(msg => {
            if (typeof msg === 'string') return { name: 'Saved Message', content: msg };
            return msg;
        });
    }
    window.renderLibrary();
};

window.saveToLibrary = async function () {
    const msgEl = document.getElementById('msg');
    if (!msgEl || !msgEl.value.trim()) {
        alert('Please enter a message to save.');
        return;
    }

    const text = msgEl.value.trim();
    if (libraryData.some(m => m.content === text)) {
        alert('This message is already in your library.');
        return;
    }

    const title = prompt('Enter a name for this saved message:');
    if (title === null) {
        return; // User cancelled
    }

    const msgObj = {
        name: title.trim() || 'Untitled Message',
        content: text,
        language: document.querySelector('.lang-pill.active')?.innerText || 'Unknown'
    };

    // Optimistic UI update
    libraryData.unshift(msgObj);
    localStorage.setItem('msg_lib', JSON.stringify(libraryData));
    window.renderLibrary();

    try {
        const res = await fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msgObj)
        });
        if (res.ok) {
            alert('Message saved to library!');
            window.loadMessages(); // Sync with server for real ID
        }
    } catch (e) {
        console.error('Failed to save message to server:', e);
        alert('Message saved to library (Local Browser Cache). Please restart server for full persistence.');
    }
};

window.openLibrary = function () {
    window.renderLibrary();
    document.getElementById('lib-modal').style.display = 'flex';
};

window.closeLibrary = function () {
    document.getElementById('lib-modal').style.display = 'none';
};

window.renderLibrary = function (filtered) {
    const list = document.getElementById('lib-items');
    if (!list) return;

    const data = filtered || libraryData;

    if (!data.length) {
        list.innerHTML = '<div class="empty">No messages found.</div>';
        return;
    }

    list.innerHTML = data.map((msgObj, i) => {
        // Find original index if filtered
        const originalIndex = filtered ? libraryData.indexOf(msgObj) : i;
        const displayName = msgObj.name || msgObj.title || 'Saved Message';
        const displayContent = msgObj.content || msgObj.text || '';
        return `
        <div class="hist-card" style="padding: 12px; cursor: pointer; display: flex; flex-direction: column; gap: 8px; margin-bottom:12px; border-radius:12px;">
            <div onclick="useLibraryMessage(${originalIndex})" style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
                <strong style="font-size: 1rem; color: var(--text);">${displayName}</strong>
                <span style="font-size: 0.9286rem; line-height: 1.4; color: var(--text2);">${displayContent}</span>
            </div>
            <div style="display: flex; justify-content: flex-end;">
                <button class="btn btn-secondary btn-sm" onclick="deleteLibraryMessage(${originalIndex})" 
                    style="width: auto; height: 24px; font-size: 9px; padding: 0 8px; color: var(--error); border-radius: 2rem;">
                    DELETE
                </button>
            </div>
        </div>
        `;
    }).join('');
};

window.filterLibrary = function (query) {
    if (!query) {
        window.renderLibrary();
        return;
    }
    const filtered = libraryData.filter(m => {
        const nameMatch = (m.name || m.title || '').toLowerCase().includes(query.toLowerCase());
        const contentMatch = (m.content || m.text || '').toLowerCase().includes(query.toLowerCase());
        return nameMatch || contentMatch;
    });
    window.renderLibrary(filtered);
};

window.useLibraryMessage = function (index) {
    const msgObj = libraryData[index];
    const msgEl = document.getElementById('msg');
    if (msgEl) {
        msgEl.value = msgObj.content || msgObj.text || '';
        if (window.preview) window.preview();
    }
    window.closeLibrary();
};

window.deleteLibraryMessage = async function (index) {
    if (!confirm('Are you sure you want to delete this message?')) return;

    const msgObj = libraryData[index];
    libraryData.splice(index, 1);
    window.renderLibrary();

    try {
        if (msgObj.id) {
            await fetch('/api/messages', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: msgObj.id })
            });
        }
    } catch (e) {
        console.error('Failed to delete message:', e);
    }
};

document.addEventListener('DOMContentLoaded', () => {
    window.loadMessages();
});
