// Import Firebase SDKs
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, collection, onSnapshot, addDoc, doc, updateDoc, deleteDoc, query, orderBy, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// --- FIREBASE CONFIGURATION ---
// TODO: User must paste their config here
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};
// ------------------------------

// Initialize Firebase
// Initialize Firebase
let app, auth, db;
try {
    // Check if config is filled
    if (firebaseConfig.apiKey === "YOUR_API_KEY") {
        throw new Error("Config not set");
    }
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    console.log("Firebase initialized successfully");
} catch (e) {
    console.warn("Firebase Init Skipped/Failed (Running in Demo Mode):", e);
    // auth/db remain undefined, triggering Demo Mode logic
}

// STATE
const state = {
    isAdmin: false,
    currentFilter: '',
    config: {
        email: 'y.goto@g.caremax.co.jp', // Admin Email
    },
    inventory: [], // Synced with Firestore
    requests: [],   // Synced with Firestore
    user: null      // Auth User
};

// DOM Elements
const grid = document.getElementById('inventory-grid');
const requestListEl = document.getElementById('requests-list');
const modeBtn = document.getElementById('mode-toggle');
const body = document.body;
const sendBtn = document.getElementById('send-btn');
const settingsNav = document.getElementById('settings-nav');
const userProfile = document.getElementById('user-profile');
const userAvatar = document.getElementById('user-avatar');
const userName = document.getElementById('user-name');
const loginContainer = document.getElementById('login-container');
const manualModeToggle = document.getElementById('manual-mode-toggle');

// Modals
const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const itemModal = document.getElementById('item-modal');
const itemModalTitle = document.getElementById('item-modal-title');
const itemNameInput = document.getElementById('item-name-input');
const itemCategorySelect = document.getElementById('item-category-select');
const itemImageUrlInput = document.getElementById('item-image-url-input'); // New Input
const modalDeleteBtn = document.getElementById('modal-delete-btn');
const settingsModal = document.getElementById('settings-modal');
const adminEmailInput = document.getElementById('admin-email-input');

let activeItemId = null;

const CATEGORY_ORDER = {
    '事務用品': 1,
    '清掃・衛生': 2,
    '飲食': 3,
    'その他': 4
};

// --- AUTHENTICATION ---

window.loginWithGoogle = async () => {
    if (!auth) {
        // DEMO MODE
        console.log("Running in Demo Mode");
        state.user = {
            name: "Demo User",
            picture: "",
            email: "demo@example.com",
            uid: "demo-123"
        };
        // Demo Admin Toggle logic is handled in toggleMode for UI, but let's set initial
        state.isAdmin = true;
        showToast("デモモードでログインしました");
        render();
        return;
    }
    const provider = new GoogleAuthProvider();
    try {
        await signInWithPopup(auth, provider);
    } catch (error) {
        console.error("Login Failed", error);
        showToast("ログインに失敗しました");
    }
};

window.handleSignout = async () => {
    if (!auth) {
        // DEMO MODE
        state.user = null;
        state.isAdmin = false;
        showToast("ログアウトしました (Demo)");
        render();
        return;
    }
    try {
        await signOut(auth);
        showToast("ログアウトしました");
    } catch (error) {
        console.error("Logout error", error);
    }
}

// Auth Listener
if (auth) {
    onAuthStateChanged(auth, (user) => {
        if (user) {
            state.user = {
                name: user.displayName,
                picture: user.photoURL,
                email: user.email,
                uid: user.uid
            };
            // Admin Check
            state.isAdmin = (state.user.email === state.config.email);
            if (state.isAdmin) showToast(`管理者としてログイン: ${state.user.name}`);
            else showToast(`ログインしました: ${state.user.name}`);
        } else {
            state.user = null;
            state.isAdmin = false;
        }
        render(); // Re-render UI based on auth state
    });
}

// --- FIRESTORE LISTENERS ---

function initListeners() {
    if (!db) {
        // DEMO DATA with Images
        state.inventory = [
            { id: '1', name: 'ボールペン (黒)', category: '事務用品', imageUrl: './ballpoint_pen.png' },
            { id: '2', name: 'コピー用紙 A4', category: '事務用品', imageUrl: './clear_file.png' },
            { id: '3', name: 'ハンドソープ', category: '清掃・衛生' },
            { id: '4', name: '紙コップ', category: '飲食' },
            { id: '5', name: '単三電池', category: 'その他' },
            { id: '6', name: '付箋 (75x75)', category: '事務用品' },
            { id: '7', name: 'クリアファイル', category: '事務用品', imageUrl: './clear_file.png' },
            { id: '8', name: '修正テープ', category: '事務用品', imageUrl: './ballpoint_pen.png' },
            { id: '9', name: 'ボックスティッシュ', category: '清掃・衛生', imageUrl: './paper_towel.png' },
            { id: '10', name: 'ペーパータオル', category: '清掃・衛生', imageUrl: './paper_towel.png' },
            { id: '11', name: 'ゴミ袋 (45L)', category: '清掃・衛生' },
            { id: '12', name: 'コーヒー (粉)', category: '飲食' },
            { id: '13', name: 'スティックシュガー', category: '飲食' },
            { id: '14', name: '割り箸', category: '飲食' },
            { id: '15', name: 'セロハンテープ', category: '事務用品', imageUrl: './ballpoint_pen.png' }
        ];
        state.requests = [];
        render();
        return;
    }

    // Inventory Listener
    const inventoryQ = query(collection(db, "inventory"));
    onSnapshot(inventoryQ, (snapshot) => {
        state.inventory = [];
        snapshot.forEach((doc) => {
            state.inventory.push({ id: doc.id, ...doc.data() });
        });
        render();
    }, (error) => {
        console.error("Inventory sync error:", error);
    });

    // Requests Listener
    const requestsQ = query(collection(db, "requests"));
    onSnapshot(requestsQ, (snapshot) => {
        state.requests = [];
        snapshot.forEach((doc) => {
            state.requests.push({ id: doc.id, ...doc.data() });
        });
        render(); // Updates cart and badges
    }, (error) => {
        console.error("Requests sync error:", error);
    });
}

// --- HELPER FUNC: Pictogram ---
function getPictogram(name) {
    const text = name.toLowerCase();
    if (text.includes('コップ') || text.includes('カップ') || text.includes('コーヒー')) return 'fa-mug-hot';
    if (text.includes('箸') || text.includes('スプーン') || text.includes('器')) return 'fa-utensils';
    if (text.includes('ハンドソープ') || text.includes('石鹸')) return 'fa-soap';
    if (text.includes('紙')) return 'fa-file-lines';
    if (text.includes('電池')) return 'fa-battery-half';
    if (text.includes('袋') || text.includes('ゴミ')) return 'fa-trash-can';
    if (text.includes('ペン') || text.includes('文具')) return 'fa-pen-nib';
    if (text.includes('付箋')) return 'fa-note-sticky';
    if (text.includes('テープ')) return 'fa-tape';
    if (text.includes('ファイル')) return 'fa-folder-open';
    if (text.includes('ティッシュ') || text.includes('タオル')) return 'fa-box-tissue';
    return 'fa-box-archive';
}

// --- ACTIONS (Now using Firestore) ---

window.setCategoryFilter = (cat) => {
    state.currentFilter = cat;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const ids = { '': 'nav-all', '事務用品': 'nav-office', '清掃・衛生': 'nav-cleaning', '飲食': 'nav-food', 'その他': 'nav-other' };
    const activeId = ids[cat];
    if (activeId) document.getElementById(activeId).classList.add('active');
    render();
}

window.toggleMode = () => {
    // Admin mode is now primarily determined by Auth, but keep toggle for manual override if user is Admin
    state.isAdmin = !state.isAdmin;
    render();
}

window.toggleHistory = () => {
    const isHidden = historyModal.classList.contains('hidden');
    if (isHidden) { renderHistory(); historyModal.classList.remove('hidden'); }
    else { historyModal.classList.add('hidden'); }
}

// Settings
window.openSettingsModal = () => {
    adminEmailInput.value = state.config.email;
    settingsModal.classList.remove('hidden');
}
window.closeSettingsModal = () => settingsModal.classList.add('hidden');
window.saveSettings = () => {
    const email = adminEmailInput.value.trim();
    if (email) {
        state.config.email = email;
        showToast('設定を保存しました (※ブラウザ更新でリセットされます/Configを編集してください)');
        closeSettingsModal();
        // Note: Ideally Config is also stored in Firestore or Env
        render();
    }
}

// Items
window.openItemModal = (id = null) => {
    if (!state.user) { showToast("ログインが必要です"); return; }
    if (id) {
        const item = state.inventory.find(i => i.id === id);
        if (!item) return;
        activeItemId = id;
        itemModalTitle.textContent = '備品を編集';
        itemNameInput.value = item.name;
        itemCategorySelect.value = item.category || 'その他';
        if (itemImageUrlInput) itemImageUrlInput.value = item.imageUrl || ''; // Populate URL
        if (state.isAdmin) modalDeleteBtn.classList.remove('hidden');
        else modalDeleteBtn.classList.add('hidden');
    } else {
        activeItemId = null;
        itemModalTitle.textContent = '備品を登録';
        itemNameInput.value = '';
        itemCategorySelect.value = '事務用品';
        if (itemImageUrlInput) itemImageUrlInput.value = ''; // Reset URL
        modalDeleteBtn.classList.add('hidden');
    }
    itemModal.classList.remove('hidden');
}
window.closeItemModal = () => itemModal.classList.add('hidden');

if (!db) {
    // DEMO SAVE
    if (activeItemId) {
        const idx = state.inventory.findIndex(i => i.id === activeItemId);
        if (idx > -1) state.inventory[idx] = { ...state.inventory[idx], name, category, imageUrl };
    } else {
        state.inventory.push({ id: 'demo-' + Date.now(), name, category, imageUrl, createdAt: new Date().toISOString() });
    }
    closeItemModal();
    render();
    showToast("保存しました (Demo)");
    return;
}

try {
    if (activeItemId) {
        // Update
        const itemRef = doc(db, "inventory", activeItemId);
        await updateDoc(itemRef, { name, category, imageUrl });
    } else {
        // Create
        await addDoc(collection(db, "inventory"), {
            name, category, imageUrl, createdAt: new Date().toISOString()
        });
    }
    closeItemModal();
} catch (e) {
    console.error("Save Error", e);
    showToast("保存に失敗しました");
}

window.deleteItemFromModal = async () => {
    if (!activeItemId) return;
    if (!confirm('削除しますか？')) return;

    if (!db) {
        // DEMO DELETE
        state.inventory = state.inventory.filter(i => i.id !== activeItemId);
        closeItemModal();
        render();
        showToast("削除しました (Demo)");
        return;
    }

    try {
        await deleteDoc(doc(db, "inventory", activeItemId));
        closeItemModal();
    } catch (e) {
        console.error("Delete Error", e);
        showToast("削除に失敗しました");
    }
}

// Requests
window.toggleRequest = async (itemId) => {
    if (!state.user) { showToast("ログインが必要です"); return; }

    const existingReq = state.requests.find(r => r.itemId === itemId && r.userId === state.user.uid && (r.status === 'Draft' || r.status === 'Pending'));

    if (!db) {
        // DEMO TOGGLE
        if (existingReq) {
            if (existingReq.status === 'Draft' || confirm('申請を取り消しますか？')) {
                state.requests = state.requests.filter(r => r.id !== existingReq.id);
            }
        } else {
            state.requests.push({
                id: 'req-' + Date.now(),
                itemId: itemId,
                userId: state.user.uid,
                userName: state.user.name,
                timestamp: new Date().toISOString(),
                status: 'Draft',
                comment: ''
            });
        }
        render();
        return;
    }

    try {
        if (existingReq) {
            if (existingReq.status === 'Draft') {
                await deleteDoc(doc(db, "requests", existingReq.id));
            } else if (confirm('申請を取り消しますか？')) {
                await deleteDoc(doc(db, "requests", existingReq.id));
            }
        } else {
            // Create Draft
            await addDoc(collection(db, "requests"), {
                itemId: itemId,
                userId: state.user.uid,
                userName: state.user.name,
                timestamp: new Date().toISOString(),
                status: 'Draft',
                comment: ''
            });
        }
    } catch (e) {
        console.error("Toggle Request Error", e);
    }
}

window.updateComment = async (reqId, text) => {
    if (!db) {
        // DEMO COMMENT
        const req = state.requests.find(r => r.id === reqId);
        if (req) req.comment = text;
        // No render needed usually for input, but fine
        return;
    }
    try {
        const reqRef = doc(db, "requests", reqId);
        await updateDoc(reqRef, { comment: text });
    } catch (e) { console.error(e); }
}

window.sendRequests = async () => {
    const myDrafts = state.requests.filter(r => r.userId === state.user.uid && r.status === 'Draft');
    if (myDrafts.length === 0) return;
    if (!confirm(`${myDrafts.length}件の申請を送信します。よろしいですか？`)) return;

    if (!db) {
        // DEMO SEND
        myDrafts.forEach(r => r.status = 'Pending');
        render();
        showToast("送信しました (Demo)");

        // Mailto Logic (Same as real)
        const itemList = myDrafts.map(r => {
            const item = state.inventory.find(i => i.id === r.itemId);
            return `・${item ? item.name : 'Unknown'}${r.comment ? ' (' + r.comment + ')' : ''}`;
        }).join('\n');
        const subject = `【備品発注依頼】${new Date().toLocaleDateString()}`;
        const rawBody = `お疲れ様です。\n以下の備品の発注をお願い致します。\n（申請者: ${state.user.name}）\n\n${itemList}\n\nよろしくお願いいたします。`;
        window.location.href = `mailto:${state.config.email}?subject=${subject}\u0026body=${encodeURIComponent(rawBody)}`;
        return;
    }

    try {
        const batchPromises = myDrafts.map(r => {
            return updateDoc(doc(db, "requests", r.id), { status: 'Pending' });
        });
        await Promise.all(batchPromises);
        showToast("送信しました");

        // Notification (Email/Teams) - This would typically be done by a Cloud Function trigger, 
        // but can be client-side triggered here if we keep the "mailto" logic.
        const itemList = myDrafts.map(r => {
            const item = state.inventory.find(i => i.id === r.itemId);
            return `・${item ? item.name : 'Unknown'}${r.comment ? ' (' + r.comment + ')' : ''}`;
        }).join('\n');
        const subject = `【備品発注依頼】${new Date().toLocaleDateString()}`;
        const rawBody = `お疲れ様です。\n以下の備品の発注をお願い致します。\n（申請者: ${state.user.name}）\n\n${itemList}\n\nよろしくお願いいたします。`;

        // Open Mail Client
        window.location.href = `mailto:${state.config.email}?subject=${subject}\u0026body=${encodeURIComponent(rawBody)}`;

    } catch (e) {
        console.error("Send Error", e);
        showToast("エラーが発生しました");
    }
}

window.completeRequest = async (reqId) => {
    if (!db) {
        // DEMO COMPLETE
        const req = state.requests.find(r => r.id === reqId);
        if (req) {
            req.status = 'Ordered';
            req.orderedAt = new Date().toISOString();
        }
        render();
        return;
    }
    try {
        await updateDoc(doc(db, "requests", reqId), {
            status: 'Ordered',
            orderedAt: new Date().toISOString()
        });
    } catch (e) { console.error(e); }
}

// --- RENDERING ---

function render() {
    const loginScreen = document.getElementById('login-screen');
    const appDiv = document.getElementById('app');

    // Auth UI
    if (state.user) {
        // Logged In
        loginScreen.classList.add('hidden');
        appDiv.classList.remove('hidden');

        userProfile.classList.remove('hidden');
        // loginContainer.classList.add('hidden'); // Removed from DOM
        userAvatar.src = state.user.picture || 'https://via.placeholder.com/40';
        userName.textContent = state.user.name;

        // Ensure manual toggle is visible if it's "Demo User" or if we want to allow admins to test User view
        // Ideally, only Admin (or Demo Admin) sees this.
        if (state.user.name === "Demo User" || state.isAdmin) {
            manualModeToggle.classList.remove('hidden');
        } else {
            manualModeToggle.classList.add('hidden');
        }
    } else {
        // Not Logged In
        loginScreen.classList.remove('hidden');
        appDiv.classList.add('hidden');
        // No need to hide profile manually if parent app is hidden, but good for safety
        userProfile.classList.add('hidden');
    }

    // Admin UI
    if (state.isAdmin) {
        body.classList.add('is-admin');
        modeBtn.innerHTML = '<i class="fa-solid fa-user-shield"></i> Admin Mode';
        settingsNav.classList.remove('hidden');
    } else {
        body.classList.remove('is-admin');
        modeBtn.innerHTML = '<i class="fa-solid fa-user"></i> User Mode';
        settingsNav.classList.add('hidden');
    }

    // Filter & Sort Items
    const searchText = document.getElementById('search-input').value.toLowerCase();
    let items = [...state.inventory];
    if (searchText) items = items.filter(i => i.name.toLowerCase().includes(searchText));
    if (state.currentFilter) items = items.filter(i => i.category === state.currentFilter);
    items.sort((a, b) => (CATEGORY_ORDER[a.category] || 99) - (CATEGORY_ORDER[b.category] || 99) || a.name.localeCompare(b.name, 'ja'));

    // Render Grid
    grid.innerHTML = '';
    items.forEach(item => {
        // Find MY request for this item
        let req = null;
        if (state.user) {
            req = state.requests.find(r => r.itemId === item.id && r.userId === state.user.uid && (r.status === 'Draft' || r.status === 'Pending'));
        }

        const isDraft = req?.status === 'Draft';
        const isPending = req?.status === 'Pending';

        const card = document.createElement('div');
        card.className = `item-card cat-${item.category || 'その他'}`;
        card.innerHTML = `
            <div class="item-card-image-container">
                ${item.imageUrl ? `<img src="${item.imageUrl}" class="item-card-image" alt="${item.name}">` : `<i class="fa-solid ${getPictogram(item.name)}" style="font-size: 3rem; opacity: 0.3;"></i>`}
            </div>
            <div class="card-name">${item.name}</div>
            <div style="display:flex; align-items:center; gap:12px; margin-bottom: 8px;">
                <div class="card-icon-wrapper">
                    <i class="fa-solid ${getPictogram(item.name)}"></i>
                </div>
                <div class="card-category">${item.category || 'その他'}</div>
            </div>
            <div class="card-footer">
                <button class="request-toggle-btn ${isDraft ? 'active' : ''} ${isPending ? 'pending' : ''}" onclick="toggleRequest('${item.id}')">
                    ${isPending ? '<i class="fa-solid fa-check"></i> 申請中' : (isDraft ? '<i class="fa-solid fa-check"></i> 選択済み' : '選択する')}
                </button>
                <button class="card-edit-btn" onclick="openItemModal('${item.id}')"><i class="fa-solid fa-ellipsis-v"></i></button>
            </div>
        `;
        grid.appendChild(card);
    });

    renderSidebar();
}

function renderSidebar() {
    requestListEl.innerHTML = '';

    // Filter requests to show
    // Admin sees ALL drafts/pending? Or just Pending? Usually Admin needs to see Pending.
    // User sees MY drafts and MY Pending.

    let visibleReqs = [];
    if (state.user) {
        if (state.isAdmin) {
            // Admin sees all Pending + My Drafts
            visibleReqs = state.requests.filter(r => r.status === 'Pending' || (r.userId === state.user.uid && r.status === 'Draft'));
        } else {
            // User sees own Draft/Pending
            visibleReqs = state.requests.filter(r => r.userId === state.user.uid && (r.status === 'Draft' || r.status === 'Pending'));
        }
    }

    if (visibleReqs.length === 0) {
        requestListEl.innerHTML = `<div class="cart-empty"><i class="fa-solid fa-clipboard-list"></i><p>リストは空です。<br>備品を選んでください。</p></div>`;
        sendBtn.disabled = true;
        return;
    }

    visibleReqs.forEach(req => {
        const item = state.inventory.find(i => i.id === req.itemId);
        if (!item) return;
        const isDraft = req.status === 'Draft';

        const el = document.createElement('div');
        el.className = 'cart-item';
        // Add User Name badge if Admin looking at others
        const userBadge = (state.isAdmin && req.userId !== state.user.uid) ? `<span style="font-size:0.7rem; background:#eee; padding:2px 4px; border-radius:4px; margin-left:6px;">${req.userName}</span>` : '';

        el.innerHTML = `
            <div class="cart-item-header">
                <span class="cart-item-name">${item.name} ${userBadge}</span>
                <span class="cart-item-badge ${isDraft ? 'hidden' : 'badge-pending'}">${isDraft ? '' : '申請中'}</span>
            </div>
            <input class="comment-input" style="width:100%; padding:8px; border:1px solid rgba(0,0,0,0.1); border-radius:6px; font-size:0.8rem;" placeholder="備考..." value="${req.comment || ''}" ${(!isDraft && !state.isAdmin) ? 'disabled' : ''} onchange="updateComment('${req.id}', this.value)">
            ${state.isAdmin && !isDraft ? `<button class="primary-button" style="margin-top:12px; padding:8px; font-size:0.8rem;" onclick="completeRequest('${req.id}')">承認・完了済</button>` : ''}
        `;
        requestListEl.appendChild(el);
    });

    // Enable send button if I have drafts
    const myDrafts = state.requests.filter(r => state.user && r.userId === state.user.uid && r.status === 'Draft');
    sendBtn.disabled = myDrafts.length === 0;
}

function renderHistory() {
    historyList.innerHTML = '';
    const ordered = state.requests.filter(r => r.status === 'Ordered').sort((a, b) => new Date(b.orderedAt) - new Date(a.orderedAt));
    ordered.forEach(req => {
        const item = state.inventory.find(i => i.id === req.itemId);
        const row = document.createElement('tr');
        row.innerHTML = `<td>${item?.name || '削除済み'}</td><td>${item?.category || '-'}</td><td>${new Date(req.timestamp).toLocaleDateString()}</td><td>${new Date(req.orderedAt).toLocaleDateString()}</td><td>${req.comment || '-'}</td>`;
        historyList.appendChild(row);
    });
}

function showToast(msg) {
    const box = document.createElement('div'); box.className = 'toast'; box.textContent = msg;
    document.getElementById('toast-container').appendChild(box);
    setTimeout(() => box.remove(), 3000);
}

// Start
initListeners();
render();
