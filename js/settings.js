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
    localStorage.setItem('trust_name', name);
    window.applyTrustName();
    alert("Trust name saved!");
};

window.applyTrustName = function() {
    const name = localStorage.getItem('trust_name') || 'Call Broadcast';
    const input = document.getElementById('trust-name-input');
    if (input) input.value = name;
    
    const display = document.getElementById('display-trust-name');
    if (display) display.textContent = name;
};

document.addEventListener('DOMContentLoaded', () => {
    // init theme
    window.applyTrustName();
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
