// Portal login gate - load this in the <head> of every app page inside the platform.
// The page stays hidden until a company Google login (made on the portal's TOP page) is confirmed;
// without one, the page goes back to the portal.
const firebaseConfig = {
    apiKey: "AIzaSyDFoI20EpiXp6VV8N0SyJdmkEcK2_cZLLA",
    authDomain: "kikakubu-portal.firebaseapp.com",
    projectId: "kikakubu-portal",
    storageBucket: "kikakubu-portal.firebasestorage.app",
    messagingSenderId: "165113957756",
    appId: "1:165113957756:web:1043443ba7c3b32395a8f9"
};

const PORTAL_URL = '../index.html';

// Only company Google accounts can use the apps (same list as the portal's index.html).
const ALLOWED_EMAIL_DOMAINS = ['caremax.co.jp', 'g.caremax.co.jp'];

function isCompanyEmail(email) {
    if (!email) return false;
    const domain = String(email).split('@').pop().toLowerCase();
    return ALLOWED_EMAIL_DOMAINS.includes(domain);
}

function clearStoredUser() {
    try { localStorage.removeItem('caremax-user'); } catch (e) { }
}

// Get current user. A leftover login from the portal's old demo button (now removed),
// or from a Google account outside the company, counts as signed out.
function getCurrentUser() {
    let raw = null;
    try { raw = localStorage.getItem('caremax-user'); } catch (e) { }
    if (!raw) return null;
    try {
        const user = JSON.parse(raw);
        if (!user || user.isDemo || !isCompanyEmail(user.email)) {
            clearStoredUser();
            return null;
        }
        return user;
    } catch (e) {
        return null;
    }
}

// The made-up demo data (?demo=1) opens without a login only on this PC's local server (for checking screens).
function isLocalDemo() {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    return local && /[?&]demo=1(&|$)/.test(location.search);
}

(function portalLoginGate() {
    if (isLocalDemo()) return;

    // Hide the page until the login is confirmed.
    const hide = document.createElement('style');
    hide.textContent = 'body { visibility: hidden !important; }';
    document.head.appendChild(hide);

    function goToPortal() {
        clearStoredUser();
        location.replace(PORTAL_URL);
    }

    // No login recorded by the portal in this browser: go back right away.
    if (!getCurrentUser()) {
        goToPortal();
        return;
    }

    // Then confirm the real Google login once the page's Firebase scripts have loaded.
    document.addEventListener('DOMContentLoaded', function () {
        if (typeof firebase === 'undefined' || !firebase.auth) {
            goToPortal();
            return;
        }
        if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
        const unsubscribe = firebase.auth().onAuthStateChanged(function (user) {
            unsubscribe();
            if (user && !user.isAnonymous && isCompanyEmail(user.email)) {
                hide.remove();
            } else {
                goToPortal();
            }
        });
    });
})();
