// Assistive Device Manager (Jijogu) - app.js

// Firebase Configuration
// Firebase Configuration is loaded from ../auth.js
if (typeof firebaseConfig === 'undefined') {
    console.error("firebaseConfig not found. Make sure auth.js is loaded.");
}

// Initialize Firebase
let db;
let auth;
let persistencePromise = Promise.resolve();
try {
    if (typeof firebase !== 'undefined' && firebase.apps) {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        db = firebase.firestore();
        auth = firebase.auth();

        persistencePromise = db.enablePersistence({ synchronizeTabs: true })
            .catch((err) => {
                console.warn("Persistence error:", err.code);
            });
    } else {
        console.warn("Firebase SDK not loaded. Using local storage.");
    }
} catch (e) {
    console.warn("Firebase initialization failed, falling back to local storage:", e);
}

const state = {
    records: [],
    statusFilter: '',
    setFilter: ''
};

let editingId = null;

function stripNotifyEmail(record) {
    if (!record || typeof record !== 'object') return record;
    const { notifyEmail, ...rest } = record;
    return rest;
}

// Debounce helper
let renderTimeout;
function debounceRender() {
    if (renderTimeout) clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => {
        render();
    }, 100);
}
// Init
function init() {
    if (db) {
        db.collection('jijogu_records').onSnapshot(snapshot => {
            state.records = [];
            snapshot.forEach(doc => {
                state.records.push(stripNotifyEmail({ id: doc.id, ...doc.data() }));
            });
            // Persist remote changes to local storage for offline robustness
            localStorage.setItem('caremax-jijogu', JSON.stringify(state.records));
            debounceRender();
        }, error => {
            console.error("Error fetching jijogu records:", error);
            loadLocalData();
        });
    } else {
        loadLocalData();
    }
}

function loadLocalData() {
    const saved = localStorage.getItem('caremax-jijogu');
    if (saved) {
        state.records = JSON.parse(saved).map(stripNotifyEmail);
        debounceRender();
    }
}

// Sync Helper
// Sync Helper (Optimistic Update)
async function syncRecord(action, data) {
    const payload = action === 'save' ? stripNotifyEmail(data) : data;

    if (action === 'save') {
        const idx = state.records.findIndex(r => r.id === payload.id);
        if (idx > -1) state.records[idx] = payload;
        else state.records.push(payload);
    } else if (action === 'delete') {
        state.records = state.records.filter(r => r.id !== payload);
    }

    localStorage.setItem('caremax-jijogu', JSON.stringify(state.records));
    debounceRender();

    if (db) {
        try {
            if (action === 'save') {
                await db.collection('jijogu_records').doc(String(payload.id)).set(payload);
            } else if (action === 'delete') {
                await db.collection('jijogu_records').doc(String(payload)).delete();
            }
        } catch (e) {
            console.error("Background Sync error:", e);
        }
    }
}

// Filters
// Filters
function setFilter(status) {
    state.statusFilter = status;
    document.querySelectorAll('.filter-section:first-of-type .filter-btn').forEach(btn => btn.classList.remove('active'));
    const id = status === '' ? 'filter-all' :
        status === '発送待' ? 'filter-waiting' :
            status === '貸出中' ? 'filter-lending' : 'filter-returned';
    document.getElementById(id).classList.add('active');
    debounceRender();
}

function setSetFilter(setName) {
    state.setFilter = setName;
    document.querySelectorAll('.filter-section:nth-of-type(2) .filter-btn').forEach(btn => btn.classList.remove('active'));
    const id = setName === '' ? 'set-all' : 'set-' + setName.toLowerCase();
    document.getElementById(id).classList.add('active');
    debounceRender();
}

// Modal
function openModal(id = null) {
    editingId = id;
    const deleteBtn = document.getElementById('delete-btn');

    if (id) {
        const record = state.records.find(r => r.id === id);
        if (record) {
            document.getElementById('modal-title').textContent = '編集';
            document.getElementById('f-management-no').value = 'No.' + (record.managementNo || '-');
            document.getElementById('f-customer-code').value = record.customerCode || '';
            document.getElementById('f-customer-name').value = record.customerName || '';
            document.getElementById('f-status').value = record.status || '発送待';
            document.getElementById('f-set-name').value = record.setName || 'X';
            document.getElementById('f-support-staff').value = record.supportStaff || '';
            document.getElementById('f-sales-staff').value = record.salesStaff || '';
            document.getElementById('f-request-date').value = record.requestDate || '';
            document.getElementById('f-usage-date').value = record.usageDate || '';
            document.getElementById('f-ship-date').value = record.shipDate || '';
            document.getElementById('f-expected-return').value = record.expectedReturn || '';
            document.getElementById('f-return-date').value = record.returnDate || '';
            document.getElementById('f-last-check').value = record.lastCheck || '';
            document.getElementById('f-notes').value = record.notes || '';
            deleteBtn.classList.remove('hidden');
        }
    } else {
        document.getElementById('modal-title').textContent = '新規登録';
        // Show next management number
        const maxNo = state.records.reduce((max, r) => Math.max(max, r.managementNo || 0), 0);
        document.getElementById('f-management-no').value = 'No.' + (maxNo + 1);
        document.getElementById('f-customer-code').value = '';
        document.getElementById('f-customer-name').value = '';
        document.getElementById('f-status').value = '発送待';
        document.getElementById('f-set-name').value = 'X';
        document.getElementById('f-support-staff').value = '';
        document.getElementById('f-sales-staff').value = '';
        document.getElementById('f-request-date').value = new Date().toISOString().split('T')[0];
        document.getElementById('f-usage-date').value = '';
        document.getElementById('f-ship-date').value = '';
        document.getElementById('f-expected-return').value = '';
        document.getElementById('f-return-date').value = '';
        document.getElementById('f-last-check').value = '';
        document.getElementById('f-notes').value = '';
        deleteBtn.classList.add('hidden');
    }

    document.getElementById('record-modal').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('record-modal').classList.add('hidden');
    editingId = null;
}

function saveRecord() {
    const data = {
        customerCode: document.getElementById('f-customer-code').value.trim(),
        customerName: document.getElementById('f-customer-name').value.trim(),
        status: document.getElementById('f-status').value,
        setName: document.getElementById('f-set-name').value,
        supportStaff: document.getElementById('f-support-staff').value.trim(),
        salesStaff: document.getElementById('f-sales-staff').value.trim(),
        requestDate: document.getElementById('f-request-date').value,
        usageDate: document.getElementById('f-usage-date').value,
        shipDate: document.getElementById('f-ship-date').value,
        expectedReturn: document.getElementById('f-expected-return').value,
        returnDate: document.getElementById('f-return-date').value,
        lastCheck: document.getElementById('f-last-check').value,
        notes: document.getElementById('f-notes').value.trim()
    };

    if (!data.customerCode || !data.customerName) {
        alert('得意先コードと得意先名を入力してください');
        return;
    }

    if (editingId) {
        const existing = state.records.find(r => r.id === editingId) || {};
        const updated = stripNotifyEmail({ ...existing, ...data });
        syncRecord('save', updated);
    } else {
        const maxNo = state.records.reduce((max, r) => Math.max(max, r.managementNo || 0), 0);
        const newItem = {
            id: Date.now(),
            managementNo: maxNo + 1,
            createdAt: new Date().toISOString(),
            ...data
        };
        syncRecord('save', newItem);
    }

    closeModal();
}

function deleteRecord() {
    if (!editingId) return;
    if (!confirm('削除しますか？')) return;
    syncRecord('delete', editingId);
    closeModal();
}

// Render
function render() {
    let filtered = [...state.records];

    if (state.statusFilter) {
        filtered = filtered.filter(r => r.status === state.statusFilter);
    }
    if (state.setFilter) {
        filtered = filtered.filter(r => r.setName === state.setFilter);
    }

    // Sort by createdAt descending (newest first), fallback to id for older records
    filtered.sort((a, b) => {
        const aTime = a.createdAt ? new Date(a.createdAt) : new Date(a.id);
        const bTime = b.createdAt ? new Date(b.createdAt) : new Date(b.id);
        return bTime - aTime;
    });

    const tableBody = document.getElementById('records-table');
    tableBody.innerHTML = '';

    filtered.forEach(record => {
        const statusClass = record.status === '発送待' ? 'badge-waiting' :
            record.status === '貸出中' ? 'badge-lending' : 'badge-returned';

        // Check if completed (has lastCheck date)
        const isCompleted = !!record.lastCheck;

        const row = document.createElement('tr');
        row.className = `clickable-row ${isCompleted ? 'completed-row' : ''}`;
        row.style.position = 'relative';

        // Click on row to open edit modal (except for action button cell)
        row.onclick = (e) => {
            if (!e.target.closest('.action-btn')) {
                openModal(record.id);
            }
        };

        row.innerHTML = `
            <td><strong>No.${record.managementNo || '-'}</strong></td>
            <td>${record.customerCode}</td>
            <td>${record.customerName}</td>
            <td><span class="status-badge ${statusClass}">${record.status}</span></td>
            <td>${record.setName}</td>
            <td>${record.supportStaff || '-'}</td>
            <td>${record.salesStaff || '-'}</td>
            <td>${record.requestDate || '-'}</td>
            <td>${record.usageDate || '-'}</td>
            <td>${record.shipDate || '-'}</td>
            <td>${record.expectedReturn || '-'}</td>
            <td>${record.returnDate || '-'}</td>
            <td>${record.lastCheck || '-'}</td>
            <td>${record.notes ? '<i class="fa-solid fa-comment-dots" style="color:var(--text-muted); font-size:1.1rem;" title="備考あり"></i> <span style="font-size:0.7rem; color:var(--text-muted);">あり</span>' : ''}</td>
            <td>
                <button class="action-btn" onclick="openModal(${record.id}); event.stopPropagation();"><i class="fa-solid fa-pen"></i></button>
            </td>
        `;
        tableBody.appendChild(row);
    });
}

// Export CSV
// Export CSV
function exportCSV() {
    const headers = ['得意先コード', '得意先名', '状況', 'セット名', '対応担当', '営業担当', '依頼日', '使用日', '発送日', '返却予定日', '返却日', '最終チェック日', '備考'];
    let csv = '\ufeff' + headers.join(',') + '\n';

    const escapeCSV = (field) => {
        if (field === null || field === undefined) return '';
        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    };

    state.records.forEach(r => {
        const row = [
            escapeCSV(r.customerCode),
            escapeCSV(r.customerName),
            escapeCSV(r.status),
            escapeCSV(r.setName),
            escapeCSV(r.supportStaff),
            escapeCSV(r.salesStaff),
            escapeCSV(r.requestDate),
            escapeCSV(r.usageDate),
            escapeCSV(r.shipDate),
            escapeCSV(r.expectedReturn),
            escapeCSV(r.returnDate),
            escapeCSV(r.lastCheck),
            escapeCSV(r.notes)
        ];
        csv += row.join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `jijogu_${new Date().toISOString().split('T')[0]}`;
    link.download += '.csv';
    link.click();
}

// Global
// Global assignments
window.setFilter = setFilter;
window.setSetFilter = setSetFilter;
window.openModal = openModal;
window.closeModal = closeModal;
window.saveRecord = saveRecord;
window.deleteRecord = deleteRecord;
window.exportCSV = exportCSV;

// Start Init safely
// Start
persistencePromise.finally(() => {
    // Wait for Auth to be ready before initializing DB listeners
    if (auth) {
        auth.onAuthStateChanged((user) => {
            if (user) {
                console.log("Jijogu: Authenticated as", user.email);
                init();
            } else {
                console.warn("Jijogu: No user logged in. Using local data.");
                loadLocalData();
            }
        });
    } else {
        // Fallback for when Firebase isn't loaded or configured (Demo/Offline)
        try {
            init();
            console.log("Jijogu App Initialized (Local Mode)");
        } catch (e) {
            console.error("Jijogu Init Failed:", e);
            loadLocalData();
        }
    }
});

