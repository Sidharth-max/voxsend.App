let libraryData = [];

window.loadMessages = async function() {
    try {
        const res = await fetch('/api/messages');
        if (res.ok) {
            libraryData = await res.json();
            localStorage.setItem('msg_lib', JSON.stringify(libraryData)); // sync local for fallback
        } else {
            throw new Error('API failure');
        }
    } catch (e) {
        libraryData = JSON.parse(localStorage.getItem('msg_lib') || '[]');
    }
    window.renderLibrary();
};

window.saveToLibrary = async function() {
    const msgEl = document.getElementById('msg');
    if (!msgEl || !msgEl.value.trim()) {
        alert('Please enter a message to save.');
        return;
    }

    const text = msgEl.value.trim();
    if (libraryData.includes(text)) {
        alert('This message is already in your library.');
        return;
    }

    libraryData.unshift(text);
    localStorage.setItem('msg_lib', JSON.stringify(libraryData));
    
    try {
        const res = await fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(libraryData)
        });
        if (res.ok) {
            alert('Message saved to library!');
        }
    } catch (e) {
        console.error('Failed to save message to server:', e);
        alert('Message saved to library (Local Browser Cache). Please restart server for full persistence.');
    }
};

window.openLibrary = function() {
    window.renderLibrary();
    document.getElementById('lib-modal').style.display = 'flex';
};

window.closeLibrary = function() {
    document.getElementById('lib-modal').style.display = 'none';
};

window.renderLibrary = function() {
    const list = document.getElementById('lib-list');
    if (!list) return;

    if (!libraryData.length) {
        list.innerHTML = '<div class="empty">No saved messages yet.</div>';
        return;
    }

    list.innerHTML = libraryData.map((msg, i) => {
        return `
        <div class="hist-card" style="padding: 12px; cursor: pointer; display: flex; flex-direction: column; gap: 8px;">
            <div onclick="useLibraryMessage(${i})" style="flex: 1; font-size: 0.9286rem; line-height: 1.4; color: var(--text);">
                ${msg}
            </div>
            <div style="display: flex; justify-content: flex-end;">
                <button class="btn btn-secondary btn-sm" onclick="deleteLibraryMessage(${i})" 
                    style="width: auto; height: 24px; font-size: 9px; padding: 0 8px; color: var(--error); border-radius: 4px;">
                    DELETE
                </button>
            </div>
        </div>
        `;
    }).join('');
};

window.useLibraryMessage = function(index) {
    const msg = libraryData[index];
    const msgEl = document.getElementById('msg');
    if (msgEl) {
        msgEl.value = msg;
        if (window.preview) window.preview();
    }
    window.closeLibrary();
};

window.deleteLibraryMessage = async function(index) {
    if (!confirm('Are you sure you want to delete this message?')) return;
    
    libraryData.splice(index, 1);
    
    try {
        await fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(libraryData)
        });
        window.renderLibrary();
    } catch (e) {
        console.error('Failed to delete message:', e);
    }
};

document.addEventListener('DOMContentLoaded', () => {
    window.loadMessages();
});
