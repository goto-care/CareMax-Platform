// Firebase Auth Check - Include this in all sub-apps
const firebaseConfig = {
    apiKey: "AIzaSyDFoI20EpiXp6VV8N0SyJdmkEcK2_cZLLA",
    authDomain: "kikakubu-portal.firebaseapp.com",
    projectId: "kikakubu-portal",
    storageBucket: "kikakubu-portal.firebasestorage.app",
    messagingSenderId: "165113957756",
    appId: "1:165113957756:web:1043443ba7c3b32395a8f9"
};

// Check if user is logged in
function checkAuth() {
    const user = localStorage.getItem('caremax-user');
    if (!user) {
        // Redirect to login
        window.location.href = '../index.html';
        return null;
    }
    return JSON.parse(user);
}

// Get current user
function getCurrentUser() {
    const user = localStorage.getItem('caremax-user');
    return user ? JSON.parse(user) : null;
}
