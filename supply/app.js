// Firebase Compat SDK (loaded via <script> tags in HTML)
// No import statements needed - Firebase is available globally

// --- FIREBASE CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyDFoI20EpiXp6VV8N0SyJdmkEcK2_cZLLA",
    authDomain: "kikakubu-portal.firebaseapp.com",
    projectId: "kikakubu-portal",
    storageBucket: "kikakubu-portal.firebasestorage.app",
    messagingSenderId: "165113957756",
    appId: "1:165113957756:web:1043443ba7c3b32395a8f9"
};
// ------------------------------

// Initialize Firebase
let app, auth, db;
try {
    app = firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore();
    console.log("Firebase initialized successfully");
} catch (e) {
    console.warn("Firebase Init Skipped/Failed (Running in Demo Mode):", e);
    db = null; // Fallback to localStorage mode
}

// STATE
const state = {
    isAdmin: true, // Always true strictly to allow all actions
    currentFilter: '',
    config: {
        email: 'admin@caremax.local',
    },
    inventory: [],
    requests: [],
    user: { // Dummy user for records
        name: '担当者',
        uid: 'user-common',
        email: 'staff@caremax.local'
    },
    viewMode: 'medium' // 'list', 'medium', 'large'
};

// DOM Elements
const grid = document.getElementById('inventory-grid');
const requestListEl = document.getElementById('requests-list');
const sendBtn = document.getElementById('send-btn');
const settingsNav = document.getElementById('settings-nav');

// Modals
const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const itemModal = document.getElementById('item-modal');
const itemModalTitle = document.getElementById('item-modal-title');
const itemNameInput = document.getElementById('item-name-input');
const itemCategorySelect = document.getElementById('item-category-select');
const itemImageUrlInput = document.getElementById('item-image-url-input');
const modalDeleteBtn = document.getElementById('modal-delete-btn');
const settingsModal = document.getElementById('settings-modal');
const adminEmailInput = document.getElementById('admin-email-input');

// New Request Modal
const requestModal = document.getElementById('request-modal');
const requestItemName = document.getElementById('request-item-name');
const requestCommentInput = document.getElementById('request-comment-input');

let activeItemId = null;
let pendingRequestItemId = null;
let sortableInstance = null; // SortableJS Instance

const CATEGORY_ORDER = {
    '事務用品': 1,
    '清掃・衛生': 2,
    '飲食': 3,
    'その他': 4
};

// --- INIT ---

// Debounced render for search performance
let renderTimeout = null;
function scheduleRender() {
    if (renderTimeout) clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => {
        requestAnimationFrame(render);
    }, 100);
}

function init() {
    // Set up debounced search input
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', scheduleRender);
    }

    // Connect Data Source
    if (!db) {
        loadLocalData();
        render();
    } else {
        // Anonymous Login for Collaborative Editing
        // Auth Logic: Check if already logged in (e.g. from Top Page), otherwise Anon
        auth.onAuthStateChanged((user) => {
            if (user) {
                console.log("Connected as:", user.uid);
                // Update state with real user info
                state.user = {
                    name: user.displayName || 'ゲストユーザー',
                    email: user.email || '',
                    uid: user.uid,
                    picture: user.photoURL || ''
                };

                // Admin check
                if (state.config && state.config.email && state.user.email === state.config.email) {
                    state.isAdmin = true;
                }

                initFirebaseListeners();
                render();
            } else {
                // No user found -> Fallback to Anonymous
                console.log("No user found, signing in anonymously...");
                auth.signInAnonymously().catch((error) => {
                    console.error("Anonymous login failed:", error);
                });
            }
        });



        render(); // Render empty state initially
    }
}

function initFirebaseListeners() {
    db.collection("inventory").onSnapshot((snapshot) => {
        state.inventory = [];
        snapshot.forEach((doc) => {
            state.inventory.push({ id: doc.id, ...doc.data() });
        });
        scheduleRender();
    });

    db.collection("requests").onSnapshot((snapshot) => {
        state.requests = [];
        snapshot.forEach((doc) => {
            state.requests.push({ id: doc.id, ...doc.data() });
        });
        scheduleRender();
    });
}

function loadLocalData() {
    const localInv = localStorage.getItem('caremax-supply-inventory');
    if (localInv) {
        state.inventory = JSON.parse(localInv);
        // Ensure order exists
        state.inventory.forEach((item, index) => {
            if (item.order === undefined) item.order = index;
        });
    } else {
        state.inventory = [
            { id: '1', name: 'ボールペン (黒)', category: '事務用品', order: 0 },
            { id: '2', name: 'コピー用紙 A4', category: '事務用品', order: 1 },
            { id: '3', name: 'ハンドソープ', category: '清掃・衛生', order: 2 },
            { id: '4', name: '紙コップ', category: '飲食', order: 3 },
            { id: '5', name: '単三電池', category: 'その他', order: 4 },
            { id: '6', name: '付箋 (75x75)', category: '事務用品', order: 5 },
            { id: '10', name: 'ペーパータオル', category: '清掃・衛生', order: 6 },
            { id: '11', name: 'ゴミ袋 (45L)', category: '清掃・衛生', order: 7 },
            { id: '12', name: 'コーヒー (粉)', category: '飲食', order: 8 }
        ];
        saveLocalInventory();
    }

    const localReq = localStorage.getItem('caremax-supply-requests');
    if (localReq) {
        state.requests = JSON.parse(localReq);
    }
}

function saveLocalInventory() {
    if (!db) localStorage.setItem('caremax-supply-inventory', JSON.stringify(state.inventory));
}
function saveLocalRequests() {
    if (!db) localStorage.setItem('caremax-supply-requests', JSON.stringify(state.requests));
}

// Save inventory order to Firestore (for drag-and-drop sync)
async function saveInventoryOrder() {
    if (!db) {
        saveLocalInventory();
        return;
    }

    try {
        // Batch update all items with new order
        const updatePromises = state.inventory.map(item => {
            return db.collection("inventory").doc(item.id).update({ order: item.order });
        });
        await Promise.all(updatePromises);
        console.log("Order synced to Firestore");
    } catch (e) {
        console.error("Failed to sync order:", e);
        // Fallback to local
        saveLocalInventory();
    }
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
    if (text.includes('付箋') || text.includes('テープ')) return 'fa-note-sticky';
    if (text.includes('ファイル')) return 'fa-folder-open';
    if (text.includes('ティッシュ') || text.includes('タオル')) return 'fa-box-tissue';
    return 'fa-box-archive';
}

// --- ACTIONS ---

function setCategoryFilter(cat) {
    state.currentFilter = cat;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const ids = { '': 'nav-all', '事務用品': 'nav-office', '清掃・衛生': 'nav-cleaning', '飲食': 'nav-food', 'その他': 'nav-other' };
    const activeId = ids[cat];
    if (activeId) document.getElementById(activeId)?.classList.add('active');
    if (activeId) document.getElementById(activeId)?.classList.add('active');
    render();
}

function setViewMode(mode) {
    state.viewMode = mode;
    // Update buttons
    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`view-${mode}-btn`)?.classList.add('active');
    render();
}

function toggleHistory() {
    const isHidden = historyModal.classList.contains('hidden');
    if (isHidden) { renderHistory(); historyModal.classList.remove('hidden'); }
    else { historyModal.classList.add('hidden'); }
}

function renderHistory() {
    historyList.innerHTML = '';
    // Show all completed
    const completed = state.requests.filter(r => r.status === 'Ordered').sort((a, b) => new Date(b.orderedAt) - new Date(a.orderedAt));

    completed.forEach(req => {
        const item = state.inventory.find(i => i.id === req.itemId);
        const name = item ? item.name : '不明な備品';
        const cat = item ? item.category : '-';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${name}</td>
            <td>${cat}</td>
            <td>${req.timestamp.split('T')[0]}</td>
            <td>${req.orderedAt ? req.orderedAt.split('T')[0] : '-'}</td>
            <td>${req.comment || ''}</td>
        `;
        historyList.appendChild(tr);
    });
}

function openSettingsModal() {
    adminEmailInput.value = state.config.email;
    settingsModal.classList.remove('hidden');
}
function closeSettingsModal() { settingsModal.classList.add('hidden'); }
function saveSettings() {
    const email = adminEmailInput.value.trim();
    if (email) {
        state.config.email = email;
        showToast('設定を保存しました');
        closeSettingsModal();
    }
}

// Items Management
function openItemModal(id = null) {
    // Always allowed
    if (id) {
        const item = state.inventory.find(i => i.id === id);
        if (!item) return;
        activeItemId = id;
        itemModalTitle.textContent = '備品を編集';
        itemNameInput.value = item.name;
        itemCategorySelect.value = item.category || 'その他';
        if (itemImageUrlInput) itemImageUrlInput.value = item.imageUrl || '';
        modalDeleteBtn.classList.remove('hidden');
    } else {
        activeItemId = null;
        itemModalTitle.textContent = '備品を登録';
        itemNameInput.value = '';
        itemCategorySelect.value = '事務用品';
        if (itemImageUrlInput) itemImageUrlInput.value = '';
        modalDeleteBtn.classList.add('hidden');
    }
    itemModal.classList.remove('hidden');
}
function closeItemModal() { itemModal.classList.add('hidden'); }

async function saveItem() {
    const name = itemNameInput.value.trim();
    const category = itemCategorySelect.value;
    const imageUrl = itemImageUrlInput ? itemImageUrlInput.value.trim() : '';

    if (!name) { showToast("備品名を入力してください"); return; }

    if (!db) {
        if (activeItemId) {
            const idx = state.inventory.findIndex(i => i.id === activeItemId);
            if (idx > -1) state.inventory[idx] = { ...state.inventory[idx], name, category, imageUrl };
        } else {
            // New item: append to end -> maximize order
            const maxOrder = state.inventory.length > 0 ? Math.max(...state.inventory.map(i => i.order || 0)) : 0;
            state.inventory.push({ id: 'demo-' + Date.now(), name, category, imageUrl, createdAt: new Date().toISOString(), order: maxOrder + 1 });
        }
        saveLocalInventory();
        closeItemModal();
        render();
        showToast("保存しました");
        return;
    }

    try {
        if (activeItemId) {
            await db.collection("inventory").doc(activeItemId).update({ name, category, imageUrl });
        } else {
            await db.collection("inventory").add({ name, category, imageUrl, createdAt: new Date().toISOString() });
        }
        closeItemModal();
        showToast("保存しました");
    } catch (e) { console.error(e); showToast("エラーが発生しました"); }
}

async function deleteItemFromModal() {
    if (!activeItemId || !confirm('削除しますか？')) return;
    if (!db) {
        state.inventory = state.inventory.filter(i => i.id !== activeItemId);
        saveLocalInventory();
        closeItemModal();
        render();
        return;
    }
    try {
        await db.collection("inventory").doc(activeItemId).delete();
        closeItemModal();
    } catch (e) { console.error(e); }
}

// --- NEW REQUEST FLOW ---

function openRequestModal(itemId) {
    const existing = state.requests.find(r => r.itemId === itemId && r.userId === state.user.uid && r.status === 'Draft');
    requestItemName.textContent = state.inventory.find(i => i.id === itemId)?.name;

    if (existing) {
        pendingRequestItemId = itemId;
        requestCommentInput.value = existing.comment || '';
    } else {
        pendingRequestItemId = itemId;
        requestCommentInput.value = '';
    }
    requestModal.classList.remove('hidden');
}

function closeRequestModal() {
    requestModal.classList.add('hidden');
    pendingRequestItemId = null;
}

async function confirmRequest() {
    if (!pendingRequestItemId) return;
    const comment = requestCommentInput.value.trim();
    const itemId = pendingRequestItemId;

    if (!db) {
        const existing = state.requests.find(r => r.itemId === itemId && r.userId === state.user.uid && r.status === 'Draft');
        if (existing) {
            existing.comment = comment;
        } else {
            state.requests.push({
                id: 'req-' + Date.now(),
                itemId: itemId,
                userId: state.user.uid,
                userName: state.user.name,
                timestamp: new Date().toISOString(),
                status: 'Draft',
                comment: comment
            });
        }
        saveLocalRequests();
        closeRequestModal();
        render();
        showToast("カートに追加しました");
    } else {
        try {
            // Simplified for Demo Logic Priority, assume success
            await db.collection("requests").add({
                itemId: itemId,
                userId: state.user.uid,
                userName: state.user.name,
                timestamp: new Date().toISOString(),
                status: 'Draft',
                comment: comment
            });
            closeRequestModal();
            showToast("カートに追加しました");
        } catch (e) { console.error(e); }
    }
}

async function removeRequest(reqId) {
    // Removed confirm dialog for better UX - items can be re-added easily
    if (!db) {
        state.requests = state.requests.filter(r => r.id !== reqId);
        saveLocalRequests();
        render();
        showToast("削除しました");
    } else {
        try {
            await db.collection("requests").doc(reqId).delete();
            showToast("削除しました");
        } catch (e) {
            console.error(e);
            showToast("削除に失敗しました");
        }
    }
}

// Send Cart
async function sendRequests() {
    console.log("sendRequests called");
    const myDrafts = state.requests.filter(r => r.status === 'Draft');
    console.log("Draft count:", myDrafts.length);

    if (myDrafts.length === 0) {
        showToast("申請するアイテムがありません");
        return;
    }

    // Removed confirm dialog for smoother workflow

    if (!db) {
        myDrafts.forEach(r => r.status = 'Pending');
        saveLocalRequests();
        render();
        showToast("申請を送信しました");
    } else {
        try {
            const batch = db.batch();
            myDrafts.forEach(r => {
                const docRef = db.collection("requests").doc(r.id);
                batch.update(docRef, {
                    status: 'Pending',
                    timestamp: new Date().toISOString(),
                    // Update userId/userName to current one used for submission
                    userId: state.user.uid,
                    userName: state.user.name
                });
            });
            await batch.commit();
            showToast("申請を送信しました");
        } catch (e) {
            console.error("Failed to send requests:", e);
            showToast("送信に失敗しました");
        }
    }
}

// Admin Complete
async function completeRequest(reqId) {
    // Admin action, always local for demo
    const req = state.requests.find(r => r.id === reqId);
    if (req) {
        req.status = 'Ordered';
        req.orderedAt = new Date().toISOString();
        if (!db) {
            saveLocalRequests();
            render();
            showToast("完了しました", () => undoCompleteRequest(reqId));
        } else {
            try {
                await db.collection("requests").doc(reqId).update({
                    status: 'Ordered',
                    orderedAt: new Date().toISOString()
                });
                showToast("完了しました", () => undoCompleteRequest(reqId));
            } catch (e) {
                console.error("Failed to complete request:", e);
                showToast("更新に失敗しました");
            }
        }
    }
}


// --- RENDERING ---

function render() {
    const appDiv = document.getElementById('app');
    appDiv.classList.remove('hidden');

    const grid = document.getElementById('inventory-grid');
    grid.className = 'inventory-grid'; // Reset
    grid.classList.add(`view-${state.viewMode}`);

    const searchText = document.getElementById('search-input').value.toLowerCase().trim();
    let items = [...state.inventory];
    const filterCat = state.currentFilter;

    // Sort logic
    if (!searchText && !filterCat) {
        // Normal mode: Sort by 'order'
        items.sort((a, b) => (a.order || 0) - (b.order || 0));
    } else {
        // Filter/Search mode: Default sort (Category -> Name)
        if (searchText) items = items.filter(i => i.name.toLowerCase().includes(searchText));
        if (filterCat) items = items.filter(i => i.category === filterCat);
        items.sort((a, b) => (CATEGORY_ORDER[a.category] || 99) - (CATEGORY_ORDER[b.category] || 99) || a.name.localeCompare(b.name, 'ja'));
    }

    grid.innerHTML = '';
    items.forEach(item => {
        const pendingCount = state.requests.filter(r => r.itemId === item.id && r.status === 'Pending').length;
        const draft = state.requests.find(r => r.itemId === item.id && r.status === 'Draft');

        const card = document.createElement('div');
        card.className = `item-card cat-${item.category || 'その他'}`;
        card.dataset.id = item.id; // For SortableJS

        if (draft) card.classList.add('selected-card');

        const btnText = draft ? '<i class="fa-solid fa-check"></i> 選択済' : '選択する';
        const btnClass = draft ? 'active' : '';

        // Image handling: Use image URL or placeholder icon
        const imgContent = item.imageUrl
            ? `<img src="${item.imageUrl}" class="item-card-image" alt="${item.name}">`
            : `<i class="fa-solid ${getPictogram(item.name)} item-placeholder-icon"></i>`;

        const statusContent = pendingCount > 0
            ? `<div class="cart-item-badge">★ 申請中: ${pendingCount}件</div>`
            : '';

        card.innerHTML = `
            <div class="item-card-image-container">
                ${imgContent}
            </div>
            <div class="card-name">${item.name}</div>
            <div class="card-meta-container">
                <div class="card-category">${item.category || 'その他'}</div>
            </div>
            <div class="card-status-container">
                ${statusContent}
            </div>
            <div class="card-footer">
                <button class="request-toggle-btn ${btnClass}" onclick="openRequestModal('${item.id}')">
                    ${btnText}
                </button>
                <div class="admin-actions">
                    <button class="card-edit-btn" onclick="openItemModal('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                </div>
            </div>
        `;
        grid.appendChild(card);
    });

    renderSidebar();

    // Initialize Sortable only if no filter/search active
    if (!searchText && !filterCat) {
        if (!sortableInstance) {
            sortableInstance = new Sortable(grid, {
                animation: 150,
                ghostClass: 'sortable-ghost',
                delay: 100, // slight delay to prevent accidental drag on click
                delayOnTouchOnly: true,
                onEnd: function (evt) {
                    // Update Order
                    const itemEls = grid.querySelectorAll('.item-card');
                    itemEls.forEach((el, index) => {
                        const id = el.dataset.id;
                        const item = state.inventory.find(i => i.id === id);
                        if (item) item.order = index;
                    });
                    saveInventoryOrder(); // Sync to Firestore or localStorage
                }
            });
        } else {
            sortableInstance.option("disabled", false);
        }
    } else {
        if (sortableInstance) sortableInstance.option("disabled", true);
    }
}

function renderSidebar() {
    requestListEl.innerHTML = '';

    const drafts = state.requests.filter(r => r.status === 'Draft');
    const pendings = state.requests.filter(r => r.status === 'Pending');

    if (drafts.length === 0 && pendings.length === 0) {
        requestListEl.innerHTML = `<div class="cart-empty"><i class="fa-solid fa-clipboard-list"></i><p>リストは空です</p></div>`;
        sendBtn.disabled = true;
        return;
    }

    // 1. Render Drafts
    if (drafts.length > 0) {
        drafts.forEach(req => {
            const item = state.inventory.find(i => i.id === req.itemId);
            if (!item) return;

            const el = document.createElement('div');
            el.className = 'cart-item';
            el.innerHTML = `
                <div class="cart-item-header">
                    <span class="cart-item-name">${item.name}</span>
                </div>
                <div style="font-size:0.8rem; color:#64748b; margin-top:4px;">${req.comment || '(備考なし)'}</div>
                <div style="text-align:right; margin-top:8px;">
                     <button onclick="openRequestModal('${item.id}')" style="font-size:0.75rem; margin-right:8px; cursor:pointer; background:none; border:none; color:#64748b;"><i class="fa-solid fa-pen"></i> 編集</button>
                     <button onclick="removeRequest('${req.id}')" style="font-size:0.75rem; cursor:pointer; background:none; border:none; color:#ef4444;"><i class="fa-solid fa-trash"></i> 削除</button>
                </div>
            `;
            requestListEl.appendChild(el);
        });
    }

    // 2. Render Confirm Button (if drafts exist)
    sendBtn.disabled = drafts.length === 0;

    // 3. Render In Progress (Pending) Group - only if there are items with matching inventory
    if (pendings.length > 0) {
        // First, filter pendings to only those with matching inventory items
        const validPendings = pendings.filter(req => state.inventory.find(i => i.id === req.itemId));

        if (validPendings.length > 0) {
            const pendingGroup = document.createElement('div');
            pendingGroup.className = 'pending-group';
            pendingGroup.innerHTML = `
                <div class="pending-header" style="color: #059669;">
                    <i class="fa-solid fa-circle-check"></i> 申請完了
                </div>
            `;

            validPendings.forEach(req => {
                const item = state.inventory.find(i => i.id === req.itemId);
                // item is guaranteed to exist due to filter above

                const el = document.createElement('div');
                el.className = 'cart-item pending-item';
                el.innerHTML = `
                    <div class="cart-item-header">
                        <span class="cart-item-name">${item.name}</span>
                        <button onclick="removeRequest('${req.id}')" style="font-size:0.8rem; cursor:pointer; background:none; border:none; color:#ef4444; opacity:0.6;" title="申請を取消し"><i class="fa-solid fa-trash"></i></button>
                    </div>
                    <div style="font-size:0.8rem; color:#64748b; margin-top:4px;">${req.comment || '(備考なし)'}</div>
                    <button class="primary-button" style="margin-top:12px; padding:6px; font-size:0.75rem; background:#10b981; width:100%; justify-content:center;" onclick="completeRequest('${req.id}')">
                        <i class="fa-solid fa-check"></i> 完了にする
                    </button>
                `;
                pendingGroup.appendChild(el);
            });
            requestListEl.appendChild(pendingGroup);
        }
    }
}

function showToast(msg, undoCallback = null) {
    const box = document.createElement('div');
    box.className = 'toast';

    if (undoCallback) {
        box.innerHTML = `
            <span>${msg}</span>
            <button class="undo-btn" style="margin-left:12px; background:none; border:none; color:#fca5a5; cursor:pointer; font-weight:bold; text-decoration:underline;">
                元に戻す
            </button>
        `;
        box.querySelector('.undo-btn').addEventListener('click', () => {
            undoCallback();
            box.remove();
            clearTimeout(timeoutId);
        });
    } else {
        box.textContent = msg;
    }

    document.getElementById('toast-container').appendChild(box);
    const timeoutId = setTimeout(() => box.remove(), 4000);
}

// Undo Logic
async function undoCompleteRequest(reqId) {
    const req = state.requests.find(r => r.id === reqId);
    if (!req) return;

    // Revert to Pending
    req.status = 'Pending';
    delete req.orderedAt;

    if (!db) {
        saveLocalRequests();
        render();
        showToast("元に戻しました");
    } else {
        try {
            await db.collection("requests").doc(reqId).update({
                status: 'Pending',
                orderedAt: firebase.firestore.FieldValue.delete()
            });
            showToast("元に戻しました");
        } catch (e) {
            console.error(e);
            showToast("エラー: 元に戻せませんでした");
        }
    }
}

// Global Bindings for HTML access
window.setCategoryFilter = setCategoryFilter;
window.toggleHistory = toggleHistory;
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.saveSettings = saveSettings;
window.openItemModal = openItemModal;
window.closeItemModal = closeItemModal;
window.saveItem = saveItem;
window.deleteItemFromModal = deleteItemFromModal;
window.openRequestModal = openRequestModal;
window.closeRequestModal = closeRequestModal;
window.confirmRequest = confirmRequest;
window.removeRequest = removeRequest;
window.sendRequests = sendRequests;
window.closeRequestModal = closeRequestModal;
window.confirmRequest = confirmRequest;
window.removeRequest = removeRequest;
window.sendRequests = sendRequests;
window.completeRequest = completeRequest;
window.setViewMode = setViewMode;

// Start
init();
