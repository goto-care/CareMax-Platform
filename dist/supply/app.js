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

// ?demo=1 : お試しモード。Firestore につながず、このブラウザの中だけで動く（画面の確認用）。
const DEMO_MODE = new URLSearchParams(location.search).has('demo');

// Initialize Firebase
let app, auth, db;
if (DEMO_MODE) {
    db = null;
} else {
    try {
        app = firebase.initializeApp(firebaseConfig);
        auth = firebase.auth();
        db = firebase.firestore();
        console.log("Firebase initialized successfully");
    } catch (e) {
        console.warn("Firebase Init Skipped/Failed (Running in Demo Mode):", e);
        db = null; // Fallback to localStorage mode
    }
}

const LOCAL_KEY_PREFIX = DEMO_MODE ? 'caremax-supply-demo' : 'caremax-supply';
const REQUESTER_NAME_KEY = 'caremax-supply-requester-name';

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
    viewMode: 'medium' // 'list', 'small', 'medium', 'large'
};

// DOM Elements
const grid = document.getElementById('inventory-grid');
const inventoryEmpty = document.getElementById('inventory-empty');
const requestListEl = document.getElementById('requests-list');
const sendBtn = document.getElementById('send-btn');
const cartSidebar = document.getElementById('cart-sidebar');
const cartHeader = document.getElementById('cart-header');
const cartCount = document.getElementById('cart-count');

// Modals
const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const itemModal = document.getElementById('item-modal');
const itemModalTitle = document.getElementById('item-modal-title');
const itemNameInput = document.getElementById('item-name-input');
const itemCategorySelect = document.getElementById('item-category-select');
const itemImageUrlInput = document.getElementById('item-image-url-input');
const itemImageFileInput = document.getElementById('item-image-file-input');
const itemImagePreview = document.getElementById('item-image-preview');
const itemImagePickerBtn = document.getElementById('item-image-picker-btn');
const modalDeleteBtn = document.getElementById('modal-delete-btn');

// Request Modal
const requestModal = document.getElementById('request-modal');
const requestModalTitle = document.getElementById('request-modal-title');
const requestItemName = document.getElementById('request-item-name');
const requestCommentInput = document.getElementById('request-comment-input');
const requestQuantityInput = document.getElementById('request-quantity-input');
const requestUnitInput = document.getElementById('request-unit-input');
const requestNameInput = document.getElementById('request-name-input');
const requestConfirmBtn = document.getElementById('request-confirm-btn');

let activeItemId = null;
let pendingRequestItemId = null;
let sortableInstance = null; // SortableJS Instance
let isSending = false;

const CATEGORY_ORDER = {
    '事務用品': 1,
    '清掃・衛生': 2,
    '飲食': 3,
    'その他': 4
};

const CATEGORY_NAV = [
    { category: '', navId: 'nav-all', countId: 'count-all' },
    { category: '事務用品', navId: 'nav-office', countId: 'count-office' },
    { category: '清掃・衛生', navId: 'nav-cleaning', countId: 'count-cleaning' },
    { category: '飲食', navId: 'nav-food', countId: 'count-food' },
    { category: 'その他', navId: 'nav-other', countId: 'count-other' }
];

const URGENCY = {
    urgent: { label: '急ぎ', rank: 0 },
    normal: { label: 'ふつう', rank: 1 },
    later: { label: '次回でOK', rank: 2 }
};

// 名前が分からない申請（匿名ログインなど）は、申請者を空欄で表示する。
const UNKNOWN_REQUESTER_NAMES = new Set(['', 'ゲストユーザー', 'Staff', '担当者']);

const IMAGE_MAX_DIMENSION = 640;
const IMAGE_OUTPUT_QUALITY = 0.82;
const IMAGE_MAX_DATA_URL_LENGTH = 380000;

// --- SMALL HELPERS ---

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function readStorage(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
}

function writeStorage(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode etc. */ }
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

// ISO の日時を、このPCの日付で表示する（以前は UTC の日付だったので朝9時前の申請が前日になっていた）。
function formatDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function formatShortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return sameYear ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatQuantity(req) {
    if (!req || !req.quantity) return '';
    return `${req.quantity}${req.unit || ''}`;
}

function getRequesterName(req) {
    const name = String((req && req.userName) || '').trim();
    return UNKNOWN_REQUESTER_NAMES.has(name) ? '' : name;
}

function findItem(itemId) {
    return state.inventory.find(i => i.id === itemId) || null;
}

// 備品が削除されていても、申請のときに残した名前で表示する。
function getRequestItemName(req) {
    const item = findItem(req.itemId);
    return item ? item.name : (req.itemName || '');
}

function getRequestItemCategory(req) {
    const item = findItem(req.itemId);
    return item ? (item.category || '') : (req.itemCategory || '');
}

function itemSnapshot(req) {
    return {
        itemName: getRequestItemName(req),
        itemCategory: getRequestItemCategory(req)
    };
}

function findDraftForItem(itemId) {
    return state.requests.find(r => r.itemId === itemId && r.status === 'Draft') || null;
}

function getUrgencyLabel(urgency) {
    return (URGENCY[urgency] || URGENCY.normal).label;
}

function getUrgencyRank(urgency) {
    return (URGENCY[urgency] || URGENCY.normal).rank;
}

function renderRequestChips(req) {
    const chips = [];
    const quantity = formatQuantity(req);
    if (quantity) chips.push(`<span class="chip chip-quantity">${escapeHtml(quantity)}</span>`);
    if (req.urgency === 'urgent' || req.urgency === 'later') {
        chips.push(`<span class="chip chip-${req.urgency}">${escapeHtml(getUrgencyLabel(req.urgency))}</span>`);
    }
    return chips.length ? `<div class="chip-row">${chips.join('')}</div>` : '';
}

function getDefaultRequesterName() {
    const saved = readStorage(REQUESTER_NAME_KEY).trim();
    if (saved) return saved;
    const name = String((state.user && state.user.name) || '').trim();
    if (state.user && state.user.email && !UNKNOWN_REQUESTER_NAMES.has(name)) return name;
    return '';
}

function getLastUnit(itemId) {
    const withUnit = state.requests
        .filter(r => r.itemId === itemId && r.unit)
        .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
    return withUnit.length ? withUnit[0].unit : '';
}

// --- INIT ---

// Debounced render for search performance
let renderTimeout = null;
function scheduleRender() {
    if (renderTimeout) clearTimeout(renderTimeout);
    // requestAnimationFrame は画面が見えていないと動かないので、時間だけで描き直す。
    renderTimeout = setTimeout(render, 100);
}

function init() {
    // Set up debounced search input
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', scheduleRender);
    }

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!requestModal.classList.contains('hidden')) closeRequestModal();
        else if (!itemModal.classList.contains('hidden')) closeItemModal();
        else if (!historyModal.classList.contains('hidden')) toggleHistory();
        else if (cartSidebar.classList.contains('sheet-open')) toggleCartSheet(false);
    });

    if (DEMO_MODE) {
        document.getElementById('demo-banner')?.classList.remove('hidden');
        document.body.classList.add('demo-mode');
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

function getDemoSeed() {
    const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    const inventory = [
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
    if (!DEMO_MODE) return { inventory, requests: [] };

    const requests = [
        { id: 'demo-h1', itemId: '4', itemName: '紙コップ', itemCategory: '飲食', quantity: 2, unit: '袋', urgency: 'normal', userName: '石原', comment: 'いつものカップ', status: 'Ordered', timestamp: daysAgo(20), orderedAt: daysAgo(18) },
        { id: 'demo-h2', itemId: '2', itemName: 'コピー用紙 A4', itemCategory: '事務用品', quantity: 1, unit: '箱', urgency: 'urgent', userName: '後藤', comment: '', status: 'Ordered', timestamp: daysAgo(9), orderedAt: daysAgo(8) },
        { id: 'demo-h3', itemId: 'deleted-1', itemName: 'クリアファイル A4', itemCategory: '事務用品', quantity: 1, unit: 'パック', urgency: 'later', userName: '宇原', comment: '', status: 'Ordered', timestamp: daysAgo(40), orderedAt: daysAgo(35) },
        { id: 'demo-h4', itemId: 'deleted-2', userName: 'ゲストユーザー', comment: '残り2巻', status: 'Ordered', timestamp: daysAgo(60), orderedAt: daysAgo(58) }
    ];
    return { inventory, requests };
}

function loadLocalData() {
    const localInv = readStorage(`${LOCAL_KEY_PREFIX}-inventory`);
    const seed = getDemoSeed();
    if (localInv) {
        state.inventory = JSON.parse(localInv);
        // Ensure order exists
        state.inventory.forEach((item, index) => {
            if (item.order === undefined) item.order = index;
        });
    } else {
        state.inventory = seed.inventory;
        saveLocalInventory();
    }

    const localReq = readStorage(`${LOCAL_KEY_PREFIX}-requests`);
    if (localReq) {
        state.requests = JSON.parse(localReq);
    } else if (seed.requests.length) {
        state.requests = seed.requests;
        saveLocalRequests();
    }
}

function saveLocalInventory() {
    if (!db) writeStorage(`${LOCAL_KEY_PREFIX}-inventory`, JSON.stringify(state.inventory));
}
function saveLocalRequests() {
    if (!db) writeStorage(`${LOCAL_KEY_PREFIX}-requests`, JSON.stringify(state.requests));
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
    const text = String(name || '').toLowerCase();
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

function getItemImagePlaceholderMarkup() {
    return `
        <div class="item-modal-image-empty">
            <i class="fa-regular fa-image"></i>
            <span>画像をまだ登録していません</span>
            <small>クリックして画像を選択できます</small>
        </div>
    `;
}

function renderItemImagePreview(imageUrl = '', itemName = '') {
    if (!itemImagePreview) return;

    if (imageUrl) {
        itemImagePreview.classList.remove('item-modal-image-placeholder');
        itemImagePreview.innerHTML = '<img src="' + escapeHtml(imageUrl) + '" class="item-modal-preview-image" alt="">';

        if (itemImagePickerBtn) {
            const label = itemName ? itemName + 'の画像を変更' : '画像を変更';
            itemImagePickerBtn.setAttribute('aria-label', label);
            itemImagePickerBtn.title = label;
        }
        return;
    }

    itemImagePreview.classList.add('item-modal-image-placeholder');
    itemImagePreview.innerHTML = getItemImagePlaceholderMarkup();

    if (itemImagePickerBtn) {
        itemImagePickerBtn.setAttribute('aria-label', '画像を登録');
        itemImagePickerBtn.title = '画像を登録';
    }
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
        reader.readAsDataURL(file);
    });
}

function loadImageElement(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
        image.src = src;
    });
}

async function createOptimizedImageDataUrl(file) {
    if (!file || !file.type.startsWith('image/')) {
        throw new Error('画像ファイルを選択してください');
    }

    const originalDataUrl = await readFileAsDataUrl(file);
    const image = await loadImageElement(originalDataUrl);
    const longestSide = Math.max(image.naturalWidth || 1, image.naturalHeight || 1);
    const scale = Math.min(1, IMAGE_MAX_DIMENSION / longestSide);
    const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) {
        return originalDataUrl;
    }

    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const optimizedDataUrl = mimeType === 'image/png'
        ? canvas.toDataURL(mimeType)
        : canvas.toDataURL(mimeType, IMAGE_OUTPUT_QUALITY);

    if (optimizedDataUrl.length > IMAGE_MAX_DATA_URL_LENGTH) {
        throw new Error('画像サイズが大きすぎます。もう少し小さい画像を選択してください');
    }

    return optimizedDataUrl;
}

function triggerItemImagePicker() {
    itemImageFileInput?.click();
}

async function handleItemImageSelection(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
        const imageUrl = await createOptimizedImageDataUrl(file);
        if (itemImageUrlInput) itemImageUrlInput.value = imageUrl;
        renderItemImagePreview(imageUrl, itemNameInput?.value.trim() || '');
        showToast('画像を反映しました');
    } catch (error) {
        console.error(error);
        showToast(error.message || '画像の登録に失敗しました');
    } finally {
        event.target.value = '';
    }
}

function clearItemImage(showFeedback = true) {
    if (itemImageUrlInput) itemImageUrlInput.value = '';
    if (itemImageFileInput) itemImageFileInput.value = '';
    renderItemImagePreview('', itemNameInput?.value.trim() || '');

    if (showFeedback) {
        showToast('画像を削除しました');
    }
}

function getCardImageInput(itemId) {
    return document.getElementById(`card-image-input-${itemId}`);
}

function openCardImagePicker(itemId, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    getCardImageInput(itemId)?.click();
}

async function updateItemImage(itemId, imageUrl) {
    const item = state.inventory.find(entry => entry.id === itemId);
    if (!item) return;

    const previousImageUrl = item.imageUrl || '';
    item.imageUrl = imageUrl;

    if (activeItemId === itemId && itemImageUrlInput) {
        itemImageUrlInput.value = imageUrl;
        renderItemImagePreview(imageUrl, itemNameInput?.value.trim() || item.name || '');
    }

    render();

    if (!db) {
        saveLocalInventory();
        return;
    }

    try {
        await db.collection('inventory').doc(itemId).update({ imageUrl });
    } catch (error) {
        item.imageUrl = previousImageUrl;
        if (activeItemId === itemId && itemImageUrlInput) {
            itemImageUrlInput.value = previousImageUrl;
            renderItemImagePreview(previousImageUrl, itemNameInput?.value.trim() || item.name || '');
        }
        render();
        throw error;
    }
}

async function handleCardImageSelection(itemId, event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
        const imageUrl = await createOptimizedImageDataUrl(file);
        await updateItemImage(itemId, imageUrl);
        showToast('画像を更新しました');
    } catch (error) {
        console.error(error);
        showToast(error.message || '画像の登録に失敗しました');
    } finally {
        event.target.value = '';
    }
}

// --- ACTIONS ---

function setCategoryFilter(cat) {
    state.currentFilter = cat;
    CATEGORY_NAV.forEach(nav => {
        document.getElementById(nav.navId)?.classList.toggle('active', nav.category === cat);
    });
    render();
}

function setViewMode(mode) {
    state.viewMode = mode;
    // Update buttons
    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`view-${mode}-btn`)?.classList.add('active');
    render();
}

// スマホでは申請リストを画面の下に畳んでおき、見出しを押すと開く。
function toggleCartSheet(force) {
    const open = typeof force === 'boolean' ? force : !cartSidebar.classList.contains('sheet-open');
    cartSidebar.classList.toggle('sheet-open', open);
    cartHeader?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleHistory() {
    const isHidden = historyModal.classList.contains('hidden');
    if (isHidden) { renderHistory(); historyModal.classList.remove('hidden'); }
    else { historyModal.classList.add('hidden'); }
}

function renderHistory() {
    historyList.innerHTML = '';
    // Show all completed
    const completed = state.requests
        .filter(r => r.status === 'Ordered')
        .sort((a, b) => new Date(b.orderedAt || b.timestamp || 0) - new Date(a.orderedAt || a.timestamp || 0));

    if (completed.length === 0) {
        historyList.innerHTML = '<tr><td colspan="6" class="history-empty">まだ注文履歴はありません</td></tr>';
        return;
    }

    completed.forEach(req => {
        const name = getRequestItemName(req);
        const cat = getRequestItemCategory(req);
        const requester = getRequesterName(req);
        const urgency = (req.urgency === 'urgent' || req.urgency === 'later')
            ? `<span class="chip chip-${req.urgency}">${escapeHtml(getUrgencyLabel(req.urgency))}</span>`
            : '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="nowrap">${escapeHtml(formatDate(req.timestamp))}</td>
            <td>
                <div class="history-item-name ${name ? '' : 'is-deleted'}">${escapeHtml(name || '（削除された備品）')}</div>
                ${cat ? `<div class="history-item-category">${escapeHtml(cat)}</div>` : ''}
            </td>
            <td class="nowrap">${escapeHtml(formatQuantity(req) || '-')} ${urgency}</td>
            <td class="nowrap">${escapeHtml(requester || '-')}</td>
            <td class="nowrap">${escapeHtml(formatDate(req.orderedAt))}</td>
            <td class="history-comment">${escapeHtml(req.comment || '')}</td>
        `;
        historyList.appendChild(tr);
    });
}

// Items Management
function openItemModal(id = null) {
    // Always allowed
    let imageUrl = '';
    let itemName = '';

    if (id) {
        const item = state.inventory.find(i => i.id === id);
        if (!item) return;
        activeItemId = id;
        itemModalTitle.textContent = '備品を編集';
        itemNameInput.value = item.name;
        itemCategorySelect.value = item.category || 'その他';
        imageUrl = item.imageUrl || '';
        itemName = item.name || '';
        if (itemImageUrlInput) itemImageUrlInput.value = imageUrl;
        modalDeleteBtn.classList.remove('hidden');
    } else {
        activeItemId = null;
        itemModalTitle.textContent = '備品を登録';
        itemNameInput.value = '';
        itemCategorySelect.value = state.currentFilter || '事務用品';
        if (itemImageUrlInput) itemImageUrlInput.value = '';
        modalDeleteBtn.classList.add('hidden');
    }

    if (itemImageFileInput) itemImageFileInput.value = '';
    renderItemImagePreview(imageUrl, itemName);
    itemModal.classList.remove('hidden');
}
function closeItemModal() {
    if (itemImageFileInput) itemImageFileInput.value = '';
    itemModal.classList.add('hidden');
}

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
    if (!activeItemId) return;
    const item = findItem(activeItemId);
    const label = item ? `「${item.name}」` : 'この備品';
    if (!confirm(`${label}を削除しますか？\n（注文履歴には備品名が残ります）`)) return;

    // 削除する前に、この備品の申請に備品名を書き残す（履歴が「不明な備品」にならないように）。
    const related = state.requests.filter(r => r.itemId === activeItemId && !r.itemName);
    const snapshot = { itemName: item ? item.name : '', itemCategory: item ? (item.category || '') : '' };

    if (!db) {
        related.forEach(r => Object.assign(r, snapshot));
        saveLocalRequests();
        state.inventory = state.inventory.filter(i => i.id !== activeItemId);
        saveLocalInventory();
        closeItemModal();
        render();
        return;
    }
    try {
        for (let i = 0; i < related.length; i += 400) {
            const batch = db.batch();
            related.slice(i, i + 400).forEach(r => batch.update(db.collection("requests").doc(r.id), snapshot));
            await batch.commit();
        }
        await db.collection("inventory").doc(activeItemId).delete();
        closeItemModal();
        showToast("削除しました");
    } catch (e) {
        console.error(e);
        showToast("削除に失敗しました");
    }
}

// --- REQUEST FLOW ---

function getRequestUser() {
    return (state.user && state.user.uid)
        ? state.user
        : { uid: 'user-common', name: 'Staff', email: '' };
}

function getSelectedUrgency() {
    const checked = document.querySelector('input[name="request-urgency"]:checked');
    return checked && URGENCY[checked.value] ? checked.value : 'normal';
}

function setSelectedUrgency(value) {
    const target = URGENCY[value] ? value : 'normal';
    document.querySelectorAll('input[name="request-urgency"]').forEach(input => {
        input.checked = input.value === target;
    });
}

function stepQuantity(delta) {
    const current = parseInt(requestQuantityInput.value, 10);
    const next = Math.min(999, Math.max(1, (Number.isFinite(current) ? current : 1) + delta));
    requestQuantityInput.value = String(next);
}

function openRequestModal(itemId) {
    if (!itemId || !requestModal) return;

    const item = findItem(itemId);
    const existing = findDraftForItem(itemId);

    pendingRequestItemId = itemId;
    requestItemName.textContent = item?.name || existing?.itemName || '';
    requestModalTitle.textContent = existing ? '申請内容を変更' : '申請内容';
    requestConfirmBtn.textContent = existing ? '変更を保存' : '申請リストに追加';
    requestQuantityInput.value = String(existing?.quantity || 1);
    requestUnitInput.value = existing ? (existing.unit || '') : getLastUnit(itemId);
    setSelectedUrgency(existing?.urgency || 'normal');
    requestNameInput.value = (existing && getRequesterName(existing)) || getDefaultRequesterName();
    requestCommentInput.value = existing?.comment || '';

    requestModal.classList.remove('hidden');
    setTimeout(() => {
        (requestNameInput.value ? requestQuantityInput : requestNameInput).focus();
    }, 50);
}

function closeRequestModal() {
    requestModal.classList.add('hidden');
    pendingRequestItemId = null;
}

async function confirmRequest() {
    if (!pendingRequestItemId) return;
    const itemId = pendingRequestItemId;
    const userName = requestNameInput.value.trim();
    const quantity = parseInt(requestQuantityInput.value, 10);

    if (!userName) {
        showToast("申請者のお名前を入力してください");
        requestNameInput.focus();
        return;
    }
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 999) {
        showToast("数量は1〜999の数字で入力してください");
        requestQuantityInput.focus();
        return;
    }
    writeStorage(REQUESTER_NAME_KEY, userName);

    const item = findItem(itemId);
    const existing = findDraftForItem(itemId);
    const fields = {
        quantity,
        unit: requestUnitInput.value.trim() || '個', // 空欄なら見本どおり「個」
        urgency: getSelectedUrgency(),
        comment: requestCommentInput.value.trim(),
        userName,
        itemName: item?.name || existing?.itemName || '',
        itemCategory: item?.category || existing?.itemCategory || ''
    };
    const doneMessage = existing ? "申請内容を変更しました" : "申請リストに追加しました";
    const requestUser = getRequestUser();

    if (!db) {
        if (existing) {
            Object.assign(existing, fields);
        } else {
            state.requests.push({
                id: 'req-' + Date.now(),
                itemId,
                userId: requestUser.uid,
                timestamp: new Date().toISOString(),
                status: 'Draft',
                ...fields
            });
        }
        saveLocalRequests();
        closeRequestModal();
        render();
        showToast(doneMessage);
        return;
    }

    try {
        if (existing) {
            // 同じ備品の申請がもうリストにあれば、新しく足さずに書き換える（以前は2件になっていた）。
            await db.collection("requests").doc(existing.id).update(fields);
        } else {
            await db.collection("requests").add({
                itemId,
                userId: requestUser.uid,
                timestamp: new Date().toISOString(),
                status: 'Draft',
                ...fields
            });
        }
        closeRequestModal();
        showToast(doneMessage);
    } catch (e) {
        console.error(e);
        showToast("保存に失敗しました。もう一度お試しください");
    }
}

// 「選択する」で、名前を覚えていれば数量1のまま申請リストに入れる（初めての人は入力画面を出す）。
async function quickAddRequest(itemId) {
    const userName = getDefaultRequesterName();
    if (!userName || findDraftForItem(itemId)) {
        openRequestModal(itemId);
        return;
    }
    const item = findItem(itemId);
    const requestUser = getRequestUser();
    const data = {
        itemId,
        userId: requestUser.uid,
        timestamp: new Date().toISOString(),
        status: 'Draft',
        quantity: 1,
        unit: getLastUnit(itemId) || '個',
        urgency: 'normal',
        comment: '',
        userName,
        itemName: item?.name || '',
        itemCategory: item?.category || ''
    };
    const message = `${item?.name || ''}を申請リストに入れました（急ぎ・備考は吹き出しボタンから）`;
    if (!db) {
        state.requests.push({ id: 'req-' + Date.now(), ...data });
        saveLocalRequests();
        render();
        showToast(message);
        return;
    }
    try {
        await db.collection("requests").add(data);
        showToast(message);
    } catch (e) {
        console.error(e);
        showToast("保存に失敗しました。もう一度お試しください");
    }
}

async function changeDraftQuantity(itemId, delta) {
    const draft = findDraftForItem(itemId);
    if (!draft) return;
    const next = Math.min(999, (draft.quantity || 1) + delta);
    if (next < 1) {
        await removeRequest(draft.id);
        return;
    }
    if (!db) {
        draft.quantity = next;
        saveLocalRequests();
        render();
        return;
    }
    try {
        await db.collection("requests").doc(draft.id).update({ quantity: next });
    } catch (e) {
        console.error(e);
        showToast("保存に失敗しました");
    }
}

// 注文する人の道具：注文待ちをコピーしたり、まとめて完了にしたりする。
function getSortedPendings() {
    return state.requests
        .filter(r => r.status === 'Pending')
        .sort((a, b) => getUrgencyRank(a.urgency) - getUrgencyRank(b.urgency)
            || String(a.submittedAt || a.timestamp || '').localeCompare(String(b.submittedAt || b.timestamp || '')));
}

async function copyOrderList() {
    const pendings = getSortedPendings();
    if (!pendings.length) return;
    const today = new Date();
    const lines = pendings.map(r => {
        const parts = [`・${getRequestItemName(r) || '（削除された備品）'}`];
        const qty = formatQuantity(r);
        if (qty) parts.push(` ${qty}`);
        if (r.urgency === 'urgent' || r.urgency === 'later') parts.push(`（${getUrgencyLabel(r.urgency)}）`);
        if (r.comment) parts.push(` — ${String(r.comment).replace(/\s*\n\s*/g, ' ')}`);
        return parts.join('');
    });
    const text = [`【備品の注文】${today.getMonth() + 1}/${today.getDate()}`, ...lines].join('\n');
    try {
        await navigator.clipboard.writeText(text);
        showToast(`注文待ち${pendings.length}件をコピーしました`);
    } catch (e) {
        console.error(e);
        window.prompt('コピーしてください', text);
    }
}

async function completeAllPending() {
    const pendings = getSortedPendings();
    if (!pendings.length) return;
    if (!confirm(`注文待ちの${pendings.length}件を、すべて完了にしますか？`)) return;
    const orderedAt = new Date().toISOString();
    const ids = pendings.map(r => r.id);
    pendings.forEach(r => {
        const data = { status: 'Ordered', orderedAt };
        if (!r.itemName) Object.assign(data, itemSnapshot(r));
        Object.assign(r, data);
    });
    const undo = async () => { for (const id of ids) await undoCompleteRequest(id); };
    if (!db) {
        saveLocalRequests();
        render();
        showToast(`${ids.length}件を完了にしました`, undo);
        return;
    }
    try {
        const batch = db.batch();
        pendings.forEach(r => batch.update(db.collection("requests").doc(r.id), { status: 'Ordered', orderedAt, itemName: r.itemName || '', itemCategory: r.itemCategory || '' }));
        await batch.commit();
        showToast(`${ids.length}件を完了にしました`, undo);
    } catch (e) {
        console.error(e);
        showToast("更新に失敗しました");
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
    if (isSending) return;
    const drafts = state.requests.filter(r => r.status === 'Draft');

    if (drafts.length === 0) {
        showToast("申請するアイテムがありません");
        return;
    }

    // 一度に確定した申請は submissionId でまとめる（TaskNote には1件のタスクとして届く）。
    const submittedAt = new Date().toISOString();
    const submissionId = 'sub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const submittedBy = getDefaultRequesterName() || getRequesterName({ userName: state.user.name });
    const updates = drafts.map(r => ({
        id: r.id,
        data: {
            status: 'Pending',
            timestamp: submittedAt,
            submittedAt,
            submissionId,
            submittedBy,
            ...itemSnapshot(r)
        }
    }));

    isSending = true;
    sendBtn.disabled = true;

    if (!db) {
        updates.forEach(u => Object.assign(state.requests.find(r => r.id === u.id), u.data));
        saveLocalRequests();
        isSending = false;
        render();
        showToast("申請しました。注文の担当者に届きます");
        return;
    }

    try {
        const batch = db.batch();
        updates.forEach(u => batch.update(db.collection("requests").doc(u.id), u.data));
        await batch.commit();
        showToast("申請しました。注文の担当者に届きます");
    } catch (e) {
        console.error("Failed to send requests:", e);
        showToast("送信に失敗しました。もう一度お試しください");
    } finally {
        isSending = false;
        renderSidebar();
    }
}

// Admin Complete
async function completeRequest(reqId) {
    const req = state.requests.find(r => r.id === reqId);
    if (!req) return;

    const data = { status: 'Ordered', orderedAt: new Date().toISOString() };
    if (!req.itemName) Object.assign(data, itemSnapshot(req));
    Object.assign(req, data);

    if (!db) {
        saveLocalRequests();
        render();
        showToast("完了しました", () => undoCompleteRequest(reqId));
        return;
    }
    try {
        await db.collection("requests").doc(reqId).update(data);
        showToast("完了しました", () => undoCompleteRequest(reqId));
    } catch (e) {
        console.error("Failed to complete request:", e);
        showToast("更新に失敗しました");
    }
}


// --- RENDERING ---

function getFilteredItems() {
    const searchText = document.getElementById('search-input').value.toLowerCase().trim();
    const filterCat = state.currentFilter;
    let items = [...state.inventory];

    if (!searchText && !filterCat) {
        // Normal mode: Sort by 'order'
        items.sort((a, b) => (a.order || 0) - (b.order || 0));
    } else {
        // Filter/Search mode: Default sort (Category -> Name)
        if (searchText) items = items.filter(i => String(i.name || '').toLowerCase().includes(searchText));
        if (filterCat) items = items.filter(i => (i.category || 'その他') === filterCat);
        items.sort((a, b) => (CATEGORY_ORDER[a.category] || 99) - (CATEGORY_ORDER[b.category] || 99) || String(a.name).localeCompare(String(b.name), 'ja'));
    }
    return { items, searchText, filterCat };
}

function renderCategoryCounts() {
    CATEGORY_NAV.forEach(nav => {
        const count = nav.category
            ? state.inventory.filter(i => (i.category || 'その他') === nav.category).length
            : state.inventory.length;
        const el = document.getElementById(nav.countId);
        if (el) el.textContent = String(count);
    });
}

function getLastOrderedMap() {
    const map = new Map();
    state.requests.forEach(r => {
        if (r.status !== 'Ordered' || !r.orderedAt) return;
        const prev = map.get(r.itemId);
        if (!prev || new Date(r.orderedAt) > new Date(prev)) map.set(r.itemId, r.orderedAt);
    });
    return map;
}

function render() {
    const appDiv = document.getElementById('app');
    appDiv.classList.remove('hidden');

    grid.className = 'inventory-grid'; // Reset
    grid.classList.add(`view-${state.viewMode}`);

    const { items, searchText, filterCat } = getFilteredItems();
    const lastOrdered = getLastOrderedMap();

    renderCategoryCounts();

    grid.innerHTML = '';
    items.forEach(item => {
        const pendings = state.requests.filter(r => r.itemId === item.id && r.status === 'Pending');
        const draft = findDraftForItem(item.id);
        const category = item.category || 'その他';

        const card = document.createElement('div');
        card.className = `item-card cat-${category}`;
        card.dataset.id = item.id; // For SortableJS

        if (draft) card.classList.add('selected-card');

        const draftQuantity = draft ? formatQuantity(draft) : '';
        const stop = 'onpointerdown="event.stopPropagation()"';
        // 選ぶと1つ入り、そのままカードの −／＋ で数を変える。急ぎ・備考は吹き出しボタンから。
        const footerMain = draft
            ? `<div class="card-stepper">
                    <button type="button" class="step-btn" onclick="event.stopPropagation(); changeDraftQuantity('${item.id}', -1)" ${stop} aria-label="${(draft.quantity || 1) <= 1 ? '申請リストから外す' : '1つ減らす'}"><i class="fa-solid ${(draft.quantity || 1) <= 1 ? 'fa-trash-can' : 'fa-minus'}"></i></button>
                    <span class="step-value">${escapeHtml(draftQuantity)}</span>
                    <button type="button" class="step-btn" onclick="event.stopPropagation(); changeDraftQuantity('${item.id}', 1)" ${stop} aria-label="1つ増やす"><i class="fa-solid fa-plus"></i></button>
               </div>
               <button type="button" class="card-detail-btn ${draft.urgency === 'urgent' || draft.comment ? 'has-detail' : ''}" onclick="event.stopPropagation(); openRequestModal('${item.id}')" ${stop} title="急ぎ・備考を入れる" aria-label="急ぎ・備考を入れる"><i class="fa-regular fa-comment-dots"></i></button>`
            : `<button type="button" class="request-toggle-btn" onclick="event.stopPropagation(); quickAddRequest('${item.id}')" ${stop}>
                    <i class="fa-solid fa-plus"></i> 選択する
               </button>`;

        // Image handling: Use image URL or placeholder icon
        const imgContent = item.imageUrl
            ? `<img src="${escapeHtml(item.imageUrl)}" class="item-card-image" alt="${escapeHtml(item.name)}">`
            : `<i class="fa-solid ${getPictogram(item.name)} item-placeholder-icon"></i>`;

        let statusContent = '';
        if (pendings.length === 1) {
            const qty = formatQuantity(pendings[0]);
            statusContent = `<div class="cart-item-badge" title="申請済みで、注文を待っています">申請中${qty ? ` ${escapeHtml(qty)}` : ''}</div>`;
        } else if (pendings.length > 1) {
            statusContent = `<div class="cart-item-badge" title="申請済みで、注文を待っています">申請中 ${pendings.length}件</div>`;
        }

        const lastOrderedAt = lastOrdered.get(item.id);
        const lastOrderedContent = lastOrderedAt
            ? `<span class="card-last-order" title="前回の注文（完了）日：${escapeHtml(formatDate(lastOrderedAt))}"><i class="fa-regular fa-clock"></i> 前回 ${escapeHtml(formatShortDate(lastOrderedAt))}</span>`
            : '';
        const uploadButtonTitle = item.imageUrl ? "画像を変更" : "画像を登録";

        card.innerHTML = `
            <div class="item-card-image-container">
                ${imgContent}
                <input type="file" id="card-image-input-${item.id}" class="card-image-upload-input" accept="image/*" onchange="handleCardImageSelection('${item.id}', event)">
                <button type="button" class="card-image-upload-btn" onclick="openCardImagePicker('${item.id}', event)" onpointerdown="event.stopPropagation()" title="${uploadButtonTitle}" aria-label="${uploadButtonTitle}">
                    <i class="fa-solid fa-camera"></i>
                </button>
            </div>
            <div class="card-name">${escapeHtml(item.name)}</div>
            <div class="card-meta-container">
                <span class="card-category">${escapeHtml(category)}</span>
                ${lastOrderedContent}
            </div>
            <div class="card-status-container">
                ${statusContent}
            </div>
            <div class="card-footer">
                ${footerMain}
                <div class="admin-actions">
                    <button type="button" class="card-edit-btn" onclick="event.stopPropagation(); openItemModal('${item.id}')" onpointerdown="event.stopPropagation()" title="&#21830;&#21697;&#12434;&#32232;&#38598;" aria-label="&#21830;&#21697;&#12434;&#32232;&#38598;"><i class="fa-solid fa-pen"></i></button>
                </div>
            </div>
        `;
        grid.appendChild(card);
    });

    inventoryEmpty?.classList.toggle('hidden', items.length > 0 || state.inventory.length === 0);

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

function renderRequesterLine(req, extra = '') {
    const requester = getRequesterName(req);
    const parts = [];
    if (requester) parts.push(`<i class="fa-regular fa-user"></i> ${escapeHtml(requester)}`);
    if (extra) parts.push(extra);
    return parts.length ? `<div class="cart-item-meta">${parts.join('<span class="dot">・</span>')}</div>` : '';
}

function renderSidebar() {
    requestListEl.innerHTML = '';

    const drafts = state.requests.filter(r => r.status === 'Draft');
    // 申請済みは急ぎを先に、同じ急ぎ度なら申請の古い順に並べる。
    const pendings = state.requests
        .filter(r => r.status === 'Pending')
        .sort((a, b) => getUrgencyRank(a.urgency) - getUrgencyRank(b.urgency)
            || String(a.submittedAt || a.timestamp || '').localeCompare(String(b.submittedAt || b.timestamp || '')));

    if (cartCount) {
        cartCount.textContent = String(drafts.length);
        cartCount.classList.toggle('hidden', drafts.length === 0);
    }
    cartSidebar.classList.toggle('has-drafts', drafts.length > 0);
    sendBtn.disabled = drafts.length === 0 || isSending;
    sendBtn.textContent = drafts.length > 0 ? `申請を確定（${drafts.length}品）` : '申請を確定';

    if (drafts.length === 0 && pendings.length === 0) {
        requestListEl.innerHTML = `<div class="cart-empty"><i class="fa-solid fa-clipboard-list"></i><p>リストは空です</p><p class="cart-empty-hint">備品の「選択する」を押すと、ここに入ります</p></div>`;
        return;
    }

    // 1. Drafts (まだ確定していない申請)
    drafts.forEach(req => {
        const name = getRequestItemName(req) || '（削除された備品）';
        const el = document.createElement('div');
        el.className = 'cart-item';
        el.innerHTML = `
            <div class="cart-item-header">
                <span class="cart-item-name">${escapeHtml(name)}</span>
            </div>
            ${renderRequestChips(req)}
            ${renderRequesterLine(req)}
            <div class="cart-item-comment">${escapeHtml(req.comment || '(備考なし)')}</div>
            <div class="cart-item-actions">
                <button type="button" class="link-btn" onclick="openRequestModal('${req.itemId}')"><i class="fa-solid fa-pen"></i> 変更</button>
                <button type="button" class="link-btn danger" onclick="removeRequest('${req.id}')"><i class="fa-solid fa-trash"></i> 削除</button>
            </div>
        `;
        requestListEl.appendChild(el);
    });

    // 2. Pending (申請済み・注文待ち)
    if (pendings.length > 0) {
        const pendingGroup = document.createElement('div');
        pendingGroup.className = 'pending-group';
        pendingGroup.innerHTML = `
            <div class="pending-header">
                <i class="fa-solid fa-hourglass-half"></i> 申請済み（注文待ち）${pendings.length}件
            </div>
            <div class="orderer-tools">
                <button type="button" class="orderer-btn" onclick="copyOrderList()"><i class="fa-regular fa-copy"></i> リストをコピー</button>
                <button type="button" class="orderer-btn" onclick="completeAllPending()"><i class="fa-solid fa-check-double"></i> まとめて完了</button>
            </div>
        `;

        pendings.forEach(req => {
            const name = getRequestItemName(req) || '（削除された備品）';
            const submitted = formatShortDate(req.submittedAt || req.timestamp);
            const el = document.createElement('div');
            el.className = 'cart-item pending-item';
            el.innerHTML = `
                <div class="cart-item-header">
                    <span class="cart-item-name">${escapeHtml(name)}</span>
                    <button type="button" class="icon-btn danger" onclick="removeRequest('${req.id}')" title="申請を取消し" aria-label="申請を取消し"><i class="fa-solid fa-trash"></i></button>
                </div>
                ${renderRequestChips(req)}
                ${renderRequesterLine(req, submitted ? `${escapeHtml(submitted)} 申請` : '')}
                <div class="cart-item-comment">${escapeHtml(req.comment || '(備考なし)')}</div>
                <button type="button" class="primary-button complete-btn" onclick="completeRequest('${req.id}')">
                    <i class="fa-solid fa-check"></i> 完了にする
                </button>
            `;
            pendingGroup.appendChild(el);
        });
        requestListEl.appendChild(pendingGroup);
    }
}

function showToast(msg, undoCallback = null) {
    const box = document.createElement('div');
    box.className = 'toast';

    if (undoCallback) {
        box.innerHTML = `
            <span>${escapeHtml(msg)}</span>
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
window.toggleCartSheet = toggleCartSheet;
window.openItemModal = openItemModal;
window.closeItemModal = closeItemModal;
window.saveItem = saveItem;
window.deleteItemFromModal = deleteItemFromModal;
window.triggerItemImagePicker = triggerItemImagePicker;
window.handleItemImageSelection = handleItemImageSelection;
window.clearItemImage = clearItemImage;
window.openCardImagePicker = openCardImagePicker;
window.handleCardImageSelection = handleCardImageSelection;
window.openRequestModal = openRequestModal;
window.closeRequestModal = closeRequestModal;
window.confirmRequest = confirmRequest;
window.stepQuantity = stepQuantity;
window.quickAddRequest = quickAddRequest;
window.changeDraftQuantity = changeDraftQuantity;
window.copyOrderList = copyOrderList;
window.completeAllPending = completeAllPending;
window.removeRequest = removeRequest;
window.sendRequests = sendRequests;
window.completeRequest = completeRequest;
window.setViewMode = setViewMode;

// Start
init();
