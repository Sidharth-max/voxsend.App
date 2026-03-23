window.toggleThemePop = function() {
    const pop = document.getElementById('theme-pop');
    if (pop.style.display === 'none') {
        pop.style.display = 'block';
    } else {
        pop.style.display = 'none';
    }
};

window.setThemeMode = function(isLight) {
    if (isLight) {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('theme', 'light');
    } else {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('theme', 'dark');
    }
};

window.setFontSize = function(size) {
    document.documentElement.style.fontSize = size + 'px';
    localStorage.setItem('font-size', size);
};

window.saveTrustName = function() {
    const name = document.getElementById('trust-name-input').value.trim();
    if (!name) return alert("Name cannot be empty");
    window.applyTrustName(name);
    window.saveAppSettings();
};

window.applyTrustName = function(name) {
    const display = document.getElementById('display-trust-name');
    if (display) display.textContent = name;
};

window.saveAppSettings = function() {
    const settings = {
        trust_name: document.getElementById('trust-name-input').value.trim(),
        parallel_calls: document.getElementById('parallel-calls').value,
        retry_toggle: document.getElementById('retry-toggle').checked,
        default_lang: document.getElementById('default-lang').value,
        call_delay: document.getElementById('call-delay').value
    };

    fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
    }).then(res => res.json()).then(res => {
        if (res.success) {
            alert("Settings saved successfully!");
        }
    }).catch(e => console.error("Error saving settings:", e));
};

window.loadAppSettings = function() {
    fetch('/api/settings').then(res => res.json()).then(s => {
        if (s.trust_name) {
            document.getElementById('trust-name-input').value = s.trust_name;
            window.applyTrustName(s.trust_name);
        }
        if (s.parallel_calls) document.getElementById('parallel-calls').value = s.parallel_calls;
        if (s.retry_toggle !== undefined) document.getElementById('retry-toggle').checked = s.retry_toggle;
        if (s.default_lang) document.getElementById('default-lang').value = s.default_lang;
        if (s.call_delay) document.getElementById('call-delay').value = s.call_delay;
    }).catch(e => console.error("Error loading settings:", e));
};

document.addEventListener('DOMContentLoaded', () => {
    // init server settings
    window.loadAppSettings();
    const theme = localStorage.getItem('theme');
    if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        const tog = document.getElementById('theme-toggle');
        if(tog) tog.checked = true;
    }
    
    // init font
    const fs = localStorage.getItem('font-size') || 14;
    document.documentElement.style.fontSize = fs + 'px';
    const sld = document.getElementById('font-slider');
    if(sld) sld.value = fs;
    
    // click outside theme pop to close
    document.addEventListener('click', (e) => {
        const pop = document.getElementById('theme-pop');
        const fab = document.getElementById('settings-fab');
        if (pop && pop.style.display === 'block') {
            if (!pop.contains(e.target) && !fab.contains(e.target)) {
                pop.style.display = 'none';
            }
        }
    });
});
