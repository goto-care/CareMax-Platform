// Catalog Income/Expense Manager - app.js

const state = {
    entries: [],
    sortField: 'date',
    sortAsc: true,
};

let editingId = null;
let chart = null;
let currentImportProject = null;

// Firebase Configuration (Same as Supply Manager)
// Firebase Configuration is loaded from ../auth.js
if (typeof firebaseConfig === 'undefined') {
    console.error("firebaseConfig not found. Make sure auth.js is loaded.");
}

// Initialize Firebase
let db;
let auth; // Declare auth globally
let persistencePromise = Promise.resolve(); // Default resolved
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

// Debounce helper for render
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
        // Real-time listener
        db.collection('catalog_entries').onSnapshot(snapshot => {
            state.entries = [];
            snapshot.forEach(doc => {
                state.entries.push({ id: doc.id, ...doc.data() });
            });
            // Persist remote changes to local storage for offline robustness
            localStorage.setItem('caremax-catalog', JSON.stringify(state.entries));
            debounceRender();
        }, error => {
            console.error("Error fetching catalog entries:", error);
            // Fallback to local data if permission denied (e.g. logged out) or offline
            loadLocalData();
        });
    } else {
        loadLocalData();
    }
}

function loadLocalData() {
    const saved = localStorage.getItem('caremax-catalog');
    if (saved) {
        state.entries = JSON.parse(saved);
        debounceRender();
    }
}

// Helper to save to Firestore or LocalStorage
// Helper to save to Firestore or LocalStorage (Optimistic Update)
async function syncEntry(action, data) {
    // 1. Optimistic Local Update
    if (action === 'add') {
        state.entries.push(data);
    } else if (action === 'update') {
        const idx = state.entries.findIndex(e => e.id === data.id);
        if (idx > -1) state.entries[idx] = data;
    } else if (action === 'delete') {
        state.entries = state.entries.filter(e => e.id !== data);
    } else if (action === 'delete_project') {
        state.entries = state.entries.filter(e => e.item !== data);
    }

    // 2. Persist to LocalStorage & Render immediately
    localStorage.setItem('caremax-catalog', JSON.stringify(state.entries));
    debounceRender();

    // 3. Background Sync to Firebase
    if (db) {
        try {
            if (action === 'add') {
                await db.collection('catalog_entries').doc(String(data.id)).set(data);
            } else if (action === 'update') {
                await db.collection('catalog_entries').doc(String(data.id)).update(data);
            } else if (action === 'delete') {
                await db.collection('catalog_entries').doc(String(data)).delete();
            } else if (action === 'delete_project') {
                const batch = db.batch();
                // Note: We need to query Firestore for these IDs because they might not be in state if we just deleted them locally?
                // Actually, we should have the IDs from the 'data' (itemName) but we need the specific doc IDs.
                // Since we just deleted them from local state, we can't find them there anymore!
                // FIX: We need to find them *before* deleting locally if we want to delete them from DB efficiently, 
                // OR query DB for items with that name. Querying DB is safer.
                const snapshot = await db.collection('catalog_entries').where('item', '==', data).get();
                snapshot.forEach(doc => {
                    batch.delete(doc.ref);
                });
                await batch.commit();
            }
        } catch (e) {
            console.error("Background Sync error:", e);
            // Optionally notify user, but keeping it silent for "offline" feel is often better unless critical.
            // alert("サーバーへの保存に失敗しましたが、端末には保存されました: " + e.message);
        }
    }
}

// Modal handling (Unchanged part)
function openModal(mode, data = null) {
    // ... (Use original implementation)
    const modal = document.getElementById('entry-modal');
    const title = document.getElementById('modal-title');
    const inputs = modal.querySelectorAll('input');
    inputs.forEach(i => { i.value = ''; i.disabled = false; i.style.background = 'white'; });

    modal.dataset.mode = mode;
    editingId = (mode === 'edit' && data) ? data.id : null;

    if (mode === 'project-new') {
        title.textContent = '新規プロジェクト作成';
        document.getElementById('entry-date').value = new Date().toISOString().split('T')[0];
        toggleTransactionFields(false);
    } else if (mode === 'transaction-add') {
        title.textContent = '明細を追加';
        document.getElementById('entry-date').value = data.date;
        document.getElementById('entry-item').value = data.item;
        document.getElementById('entry-item').disabled = true;
        document.getElementById('entry-item').style.background = '#f1f5f9';
        toggleTransactionFields(true);
    } else if (mode === 'edit') {
        title.textContent = '編集';
        const e = state.entries.find(x => x.id === data.id);
        if (e) {
            document.getElementById('entry-date').value = e.date;
            document.getElementById('entry-item').value = e.item;
            document.getElementById('entry-manufacturer').value = e.manufacturer || '';
            document.getElementById('entry-income').value = e.income || '';
            document.getElementById('entry-income-note').value = e.incomeNote || '';
            document.getElementById('entry-expense').value = e.expense || '';
            document.getElementById('entry-expense-note').value = e.expenseNote || '';
        }
        toggleTransactionFields(true);
    }
    modal.classList.remove('hidden');
}

function toggleTransactionFields(show) {
    const transDivs = document.querySelectorAll('.transaction-field');
    transDivs.forEach(d => {
        d.style.display = show ? 'block' : 'none';
    });
}

function closeModal() {
    document.getElementById('entry-modal').classList.add('hidden');
    editingId = null;
}

function render() {
    const groups = {};
    state.entries.sort((a, b) => new Date(b.date) - new Date(a.date));

    state.entries.forEach(e => {
        if (!groups[e.item]) {
            groups[e.item] = {
                name: e.item,
                date: e.date,
                totalIncome: 0,
                totalExpense: 0,
                items: []
            };
        }
        groups[e.item].totalIncome += (e.income || 0);
        groups[e.item].totalExpense += (e.expense || 0);

        if (e.manufacturer || e.income || e.expense || e.incomeNote || e.expenseNote || !e.isProjectRoot) {
            if (!e.isProjectRoot || (e.manufacturer || e.income || e.expense)) {
                groups[e.item].items.push(e);
            }
        }
    });

    const sortedGroups = Object.values(groups).sort((a, b) => new Date(b.date) - new Date(a.date));
    const grid = document.getElementById('entries-grid');
    const noEntries = document.getElementById('no-entries');

    let globalIncome = 0;
    let globalExpense = 0;

    if (grid) {
        grid.innerHTML = '';
        if (sortedGroups.length === 0) {
            if (noEntries) noEntries.classList.remove('hidden');
        } else {
            if (noEntries) noEntries.classList.add('hidden');

            sortedGroups.forEach(group => {
                const balance = group.totalIncome - group.totalExpense;
                globalIncome += group.totalIncome;
                globalExpense += group.totalExpense;

                const card = document.createElement('div');
                card.className = 'entry-card';
                card.style.borderLeft = `4px solid ${balance >= 0 ? '#10b981' : '#ef4444'}`;

                let transHtml = '';
                if (group.items.length > 0) {
                    transHtml = `<div class="transaction-list" style="margin-top:12px; border-top:1px solid #f1f5f9; padding-top:8px;">`;
                    group.items.forEach(t => {
                        transHtml += `
                            <div class="trans-row" style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; font-size:0.85rem;">
                                <div style="flex:1;">
                                    <div style="font-weight:600;">${t.manufacturer || '(メーカー未登録)'}</div>
                                    <div style="color:#64748b; font-size:0.75rem;">${t.incomeNote || ''} ${t.expenseNote || ''}</div>
                                </div>
                                <div style="text-align:right;">
                                    ${t.income ? `<div style="color:#10b981;">+¥${t.income.toLocaleString()}</div>` : ''}
                                    ${t.expense ? `<div style="color:#ef4444;">-¥${t.expense.toLocaleString()}</div>` : ''}
                                    <div style="margin-top:2px;">
                                        <i class="fa-solid fa-pen" style="cursor:pointer; color:#cbd5e1; margin-right:4px;" onclick="openModal('edit', {id:${t.id}})"></i>
                                        <i class="fa-solid fa-trash" style="cursor:pointer; color:#cbd5e1;" onclick="deleteEntry(${t.id})"></i>
                                    </div>
                                </div>
                            </div>
                        `;
                    });
                    transHtml += `</div>`;
                } else {
                    transHtml = `<div style="color:#94a3b8; font-size:0.8rem; margin:12px 0;">明細なし</div>`;
                }

                card.innerHTML = `
                    <div class="card-header" style="border-bottom:none; padding-bottom:0;">
                        <div>
                            <div class="item-title" style="font-size:1.1rem;">${group.name}</div>
                            <div class="item-date">${group.date}</div>
                        </div>
                        <div class="card-actions">
                            <button class="action-icon" onclick="triggerImport('${group.name}')" title="CSV取り込み"><i class="fa-solid fa-file-import"></i></button>
                            <button class="action-icon" onclick="exportCSVProject('${group.name}')" title="CSV出力"><i class="fa-solid fa-file-export"></i></button>
                            <button class="action-icon delete" onclick="deleteProject('${group.name}')" title="プロジェクト削除"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>

                    ${transHtml}

                    <button onclick="openModal('transaction-add', {date:'${group.date}', item:'${group.name}'})" style="width:100%; border:1px dashed #cbd5e1; background:#f8fafc; padding:8px; border-radius:8px; color:#64748b; font-size:0.8rem; cursor:pointer; margin-top:8px;">
                        <i class="fa-solid fa-plus"></i> 明細を追加
                    </button>

                    <div class="card-footer" style="border-top:2px solid #f1f5f9; margin-top:16px;">
                        <span class="card-label">収支合計</span>
                        <span class="balance-val" style="color: ${balance >= 0 ? '#10b981' : '#ef4444'}">
                            ${balance >= 0 ? '¥' : '-¥'}${Math.abs(balance).toLocaleString()}
                        </span>
                    </div>
                `;
                grid.appendChild(card);
            });
        }
    }

    const globalBalance = globalIncome - globalExpense;
    document.getElementById('total-income').textContent = '¥' + globalIncome.toLocaleString();
    document.getElementById('total-expense').textContent = '¥' + globalExpense.toLocaleString();

    const balEl = document.getElementById('total-balance');
    balEl.textContent = (globalBalance >= 0 ? '¥' : '-¥') + Math.abs(globalBalance).toLocaleString();
    balEl.style.color = globalBalance >= 0 ? '#10b981' : '#ef4444';

    renderChart(sortedGroups);
}

function renderChart(groups) {
    const canvas = document.getElementById('balanceChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (chart) chart.destroy();

    const targetGroups = groups.slice(0, 15);
    const labels = targetGroups.map(g => g.name);
    const data = targetGroups.map(g => g.totalIncome - g.totalExpense);

    chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'プロジェクト収支',
                data: data,
                backgroundColor: data.map(v => v >= 0 ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)'),
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const val = ctx.raw;
                            return (val >= 0 ? '余剰: ¥' : '不足: -¥') + Math.abs(val).toLocaleString();
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { maxRotation: 45, autoSkip: false } },
                y: { beginAtZero: true }
            }
        }
    });

    const hint = document.querySelector('.chart-click-hint');
    if (hint) hint.style.display = 'none';
}

// CSV Parser Helper
function parseCSVLine(text) {
    const result = [];
    let current = '';
    let inQuote = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inQuote) {
            if (char === '"') {
                if (i + 1 < text.length && text[i + 1] === '"') {
                    // Escaped quote
                    current += '"';
                    i++;
                } else {
                    inQuote = false;
                }
            } else {
                current += char;
            }
        } else {
            if (char === '"') {
                inQuote = true;
            } else if (char === ',') {
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        }
    }
    result.push(current);
    return result;
}

function saveEntry() {
    const modal = document.getElementById('entry-modal');
    const mode = modal.dataset.mode;

    const date = document.getElementById('entry-date').value;
    const item = document.getElementById('entry-item').value.trim();
    const manufacturer = document.getElementById('entry-manufacturer').value.trim();
    const income = parseInt(document.getElementById('entry-income').value) || 0;
    const incomeNote = document.getElementById('entry-income-note').value.trim();
    const expense = parseInt(document.getElementById('entry-expense').value) || 0;
    const expenseNote = document.getElementById('entry-expense-note').value.trim();

    if (!date || !item) {
        alert('作成日と作成項目は必須です');
        return;
    }

    let entryData = {};

    if (mode === 'project-new') {
        entryData = {
            id: Date.now(),
            date, item,
            manufacturer: '', income: 0, incomeNote: '', expense: 0, expenseNote: '',
            isProjectRoot: true
        };
        syncEntry('add', entryData);
    } else if (mode === 'transaction-add') {
        entryData = {
            id: Date.now(), date, item,
            manufacturer, income, incomeNote, expense, expenseNote
        };
        syncEntry('add', entryData);
    } else if (mode === 'edit') {
        const existing = state.entries.find(x => x.id === editingId);
        if (existing) {
            entryData = { ...existing, date, item, manufacturer, income, incomeNote, expense, expenseNote };
            syncEntry('update', entryData);
        }
    }

    closeModal();
}

function deleteEntry(id) {
    if (!confirm('この明細を削除しますか？')) return;
    syncEntry('delete', id);
}

function deleteProject(itemName) {
    if (!confirm(`プロジェクト『${itemName}』と、そこに含まれる全ての明細を削除しますか？`)) return;
    syncEntry('delete_project', itemName);
}

// Global assignments (Make sure these are available immediately)
window.openModal = openModal;
window.closeModal = closeModal;
window.saveEntry = saveEntry;
window.deleteEntry = deleteEntry;
window.deleteProject = deleteProject;
window.triggerImport = (projectName) => {
    currentImportProject = projectName;
    document.getElementById('csv-import-project').click();
};
window.exportCSVProject = (projectName) => {
    // ... logic ...
    const projectEntries = state.entries.filter(e => e.item === projectName && (!e.isProjectRoot || e.income || e.expense));
    if (projectEntries.length === 0) {
        alert('出力するデータがありません。');
        return;
    }
    const entries = projectEntries.sort((a, b) => new Date(a.date) - new Date(b.date));
    let csv = '\ufeff作成日,作成項目,メーカー名,収入,収入備考,支出,支出備考\n';
    entries.forEach(e => {
        csv += `${e.date},"${e.item}","${e.manufacturer || ''}",${e.income || 0},"${e.incomeNote || ''}",${e.expense || 0},"${e.expenseNote || ''}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `catalog_${projectName}.csv`;
    link.click();
};
window.exportCSV = () => {
    if (state.entries.length === 0) return;
    const sorted = [...state.entries].sort((a, b) => new Date(a.date) - new Date(b.date));
    let csv = '\ufeff作成日,作成項目,メーカー名,収入,収入備考,支出,支出備考\n';
    sorted.forEach(e => {
        if (!e.isProjectRoot || e.income || e.expense) {
            csv += `${e.date},"${e.item}","${e.manufacturer || ''}",${e.income || 0},"${e.incomeNote || ''}",${e.expense || 0},"${e.expenseNote || ''}"\n`;
        }
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `catalog_all_export.csv`;
    link.click();
};
window.downloadCSVFormat = () => {
    const template = '\ufeff作成日,作成項目,メーカー名,収入,収入備考,支出,支出備考\n2026-01-01,防災カタログ,メーカ名A,10000,掲載料,5000,印刷費\n';
    const blob = new Blob([template], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'template.csv';
    link.click();
};

window.importCSVProject = (input) => {
    const file = input.files[0];
    if (!file || !currentImportProject) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        const text = e.target.result;
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        let count = 0;

        const newEntries = [];

        for (let i = 1; i < lines.length; i++) {
            const parts = parseCSVLine(lines[i]);
            if (parts.length >= 1) {
                const date = (parts[0] || '').trim();
                if (!date) continue;

                const manufacturer = (parts[2] || '').trim();
                const income = parseInt((parts[3] || '0').replace(/,/g, '').trim()) || 0;
                const incomeNote = (parts[4] || '').trim();
                const expense = parseInt((parts[5] || '0').replace(/,/g, '').trim()) || 0;
                const expenseNote = (parts[6] || '').trim();

                const newEntry = {
                    id: Date.now() + i,
                    date,
                    item: currentImportProject,
                    manufacturer,
                    income,
                    incomeNote,
                    expense,
                    expenseNote
                };
                newEntries.push(newEntry);
                count++;
            }
        }

        // 1. Optimistic Local Update
        state.entries.push(...newEntries);

        // 2. Persist to LocalStorage & Render immediately
        localStorage.setItem('caremax-catalog', JSON.stringify(state.entries));
        debounceRender();
        alert(`${count}件の明細を取り込みました（保存中...）`);
        input.value = '';

        // 3. Background Sync to Firebase
        if (db && newEntries.length > 0) {
            try {
                let batch = db.batch();
                let batchCount = 0;

                for (const entry of newEntries) {
                    const ref = db.collection('catalog_entries').doc(String(entry.id));
                    batch.set(ref, entry);
                    batchCount++;
                    if (batchCount >= 450) {
                        await batch.commit();
                        batch = db.batch();
                        batchCount = 0;
                    }
                }
                if (batchCount > 0) {
                    await batch.commit();
                }
                console.log("Accessory import synced to Firestore");
            } catch (err) {
                console.error("Import sync error:", err);
                // alert("サーバーへの同期に失敗しましたが、端末には保存されました。");
            }
        }
    };
    reader.readAsText(file);
};


// Start
persistencePromise.finally(() => {
    // Wait for Auth to be ready before initializing DB listeners
    if (auth) {
        auth.onAuthStateChanged((user) => {
            if (user) {
                console.log("Catalog: Authenticated as", user.email);
                // We can optionally store user info in state if needed
                init();
            } else {
                console.warn("Catalog: No user logged in. Using local data.");
                loadLocalData();
            }
        });
    } else {
        // Fallback for when Firebase isn't loaded or configured (Demo/Offline)
        try {
            init();
            console.log("Catalog App Initialized (Local Mode)");
        } catch (e) {
            console.error("Initialization error:", e);
            loadLocalData();
        }
    }
});
