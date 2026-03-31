// Catalog Income/Expense Manager - app.js

const METRIC_META = {
    income: {
        key: 'income',
        noteKey: 'incomeNote',
        label: '収入',
        className: 'income',
        icon: 'fa-arrow-trend-up',
        color: '#48BB78',
        inactiveColor: 'rgba(72, 187, 120, 0.26)'
    },
    expense: {
        key: 'expense',
        noteKey: 'expenseNote',
        label: '支出',
        className: 'expense',
        icon: 'fa-arrow-trend-down',
        color: '#F56565',
        inactiveColor: 'rgba(245, 101, 101, 0.24)'
    }
};

const state = {
    entries: [],
    selectedProject: null,
    selectedMetric: null,
};

let editingId = null;
let chart = null;
let currentImportProject = null;
let unsubscribeEntries = null;
let renderTimeout;
const projectCharts = new Map();

const STORAGE_KEY = 'caremax-catalog';
const currencyFormatter = new Intl.NumberFormat('ja-JP');

// Firebase Configuration is loaded from ../auth.js
if (typeof firebaseConfig === 'undefined') {
    console.error('firebaseConfig not found. Make sure auth.js is loaded.');
}

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
                console.warn('Persistence error:', err.code);
            });
    } else {
        console.warn('Firebase SDK not loaded. Using local storage.');
    }
} catch (error) {
    console.warn('Firebase initialization failed. Falling back to local storage:', error);
}

function debounceRender() {
    clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => render(), 80);
}

function normalizeCurrencyInput(value) {
    return Math.abs(parseInt(String(value ?? '0').replace(/,/g, '').trim(), 10) || 0);
}

function parseDateValue(value) {
    const timestamp = new Date(value).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
}

function formatCurrency(value) {
    return `¥${currencyFormatter.format(Math.abs(Number(value) || 0))}`;
}

function formatSignedCurrency(value) {
    const amount = Number(value) || 0;
    return `${amount < 0 ? '-¥' : '¥'}${currencyFormatter.format(Math.abs(amount))}`;
}

function formatDate(value) {
    if (!value) return '日付未設定';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString('ja-JP');
}

function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function persistLocalData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
}

function loadLocalData() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        state.entries = saved ? JSON.parse(saved) : [];
    } catch (error) {
        console.warn('Failed to load local catalog data:', error);
        state.entries = [];
    }
    debounceRender();
}

function init() {
    if (unsubscribeEntries) {
        unsubscribeEntries();
        unsubscribeEntries = null;
    }

    if (!db) {
        loadLocalData();
        return;
    }

    unsubscribeEntries = db.collection('catalog_entries').onSnapshot((snapshot) => {
        state.entries = [];
        snapshot.forEach((doc) => {
            state.entries.push({ id: doc.id, ...doc.data() });
        });
        persistLocalData();
        debounceRender();
    }, (error) => {
        console.error('Error fetching catalog entries:', error);
        loadLocalData();
    });
}

async function syncEntry(action, payload) {
    if (action === 'add') {
        state.entries.push(payload);
    } else if (action === 'update') {
        const index = state.entries.findIndex((entry) => String(entry.id) === String(payload.id));
        if (index > -1) state.entries[index] = payload;
    } else if (action === 'delete') {
        state.entries = state.entries.filter((entry) => String(entry.id) !== String(payload));
    } else if (action === 'delete_project') {
        state.entries = state.entries.filter((entry) => entry.item !== payload);
        if (state.selectedProject === payload) {
            state.selectedProject = null;
            state.selectedMetric = null;
        }
    }

    persistLocalData();
    debounceRender();

    if (!db) return;

    try {
        if (action === 'add') {
            await db.collection('catalog_entries').doc(String(payload.id)).set(payload);
        } else if (action === 'update') {
            await db.collection('catalog_entries').doc(String(payload.id)).set(payload);
        } else if (action === 'delete') {
            await db.collection('catalog_entries').doc(String(payload)).delete();
        } else if (action === 'delete_project') {
            const snapshot = await db.collection('catalog_entries').where('item', '==', payload).get();
            const batch = db.batch();
            snapshot.forEach((doc) => batch.delete(doc.ref));
            await batch.commit();
        }
    } catch (error) {
        console.error('Background sync error:', error);
    }
}

function getOrderedEntries() {
    return [...state.entries].sort((a, b) => {
        const dateDiff = parseDateValue(b.date) - parseDateValue(a.date);
        if (dateDiff !== 0) return dateDiff;
        return String(b.id).localeCompare(String(a.id));
    });
}

function buildProjectGroups() {
    const groups = new Map();

    getOrderedEntries().forEach((entry) => {
        const itemName = String(entry.item || '').trim();
        if (!itemName) return;

        if (!groups.has(itemName)) {
            groups.set(itemName, {
                name: itemName,
                date: entry.date || '',
                latest: parseDateValue(entry.date),
                totalIncome: 0,
                totalExpense: 0,
                items: [],
                chartImage: '',
                rootEntryId: null,
                transactionCount: 0,
            });
        }

        const group = groups.get(itemName);
        const income = normalizeCurrencyInput(entry.income);
        const expense = normalizeCurrencyInput(entry.expense);
        const timestamp = parseDateValue(entry.date);

        group.totalIncome += income;
        group.totalExpense += expense;

        if (timestamp >= group.latest) {
            group.latest = timestamp;
            group.date = entry.date || group.date;
        }

        if (entry.isProjectRoot) {
            group.rootEntryId = String(entry.id);
            group.chartImage = entry.chartImage || group.chartImage;
        }

        const hasTransactionContent = Boolean(
            !entry.isProjectRoot || income || expense || entry.manufacturer || entry.incomeNote || entry.expenseNote
        );

        if (hasTransactionContent) {
            group.items.push({
                ...entry,
                income,
                expense,
            });

            if (!entry.isProjectRoot) {
                group.transactionCount += 1;
            }
        }
    });

    return [...groups.values()].sort((a, b) => {
        const diff = b.latest - a.latest;
        if (diff !== 0) return diff;
        return a.name.localeCompare(b.name, 'ja');
    });
}

function ensureSelection(groups) {
    const selectedGroup = groups.find((group) => group.name === state.selectedProject) || null;
    if (!selectedGroup) {
        state.selectedProject = null;
        state.selectedMetric = null;
        return null;
    }
    return selectedGroup;
}

function render() {
    const groups = buildProjectGroups();
    const selectedGroup = ensureSelection(groups);

    const totalIncome = groups.reduce((sum, group) => sum + group.totalIncome, 0);
    const totalExpense = groups.reduce((sum, group) => sum + group.totalExpense, 0);
    const balance = totalIncome - totalExpense;

    document.getElementById('total-income').textContent = formatCurrency(totalIncome);
    document.getElementById('total-expense').textContent = formatCurrency(totalExpense);

    const balanceEl = document.getElementById('total-balance');
    balanceEl.textContent = formatSignedCurrency(balance);
    balanceEl.style.color = balance >= 0 ? METRIC_META.income.color : METRIC_META.expense.color;

    renderProjectBoard(groups);
    renderDetailSection(groups, selectedGroup);
}

function selectMetric(projectName, metric) {
    const isSameSelection = state.selectedProject === projectName && state.selectedMetric === metric;
    state.selectedProject = isSameSelection ? null : projectName;
    state.selectedMetric = isSameSelection ? null : metric;
    render();

    if (!isSameSelection) {
        setTimeout(() => {
            document.getElementById('detail-accordion')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 140);
    }
}

function syncDetailAccordion(isOpen) {
    const accordion = document.getElementById('detail-accordion');
    const panel = accordion?.firstElementChild;
    if (!accordion || !panel) return;

    if (isOpen) {
        accordion.classList.add('open');
        requestAnimationFrame(() => {
            accordion.style.maxHeight = `${panel.scrollHeight}px`;
        });
    } else {
        accordion.style.maxHeight = '0px';
        accordion.classList.remove('open');
    }
}

function destroyProjectCharts() {
    projectCharts.forEach((projectChart) => projectChart.destroy());
    projectCharts.clear();
}

function renderProjectBoard(groups) {
    const grid = document.getElementById('project-chart-grid');
    const noEntries = document.getElementById('no-entries');
    if (!grid) return;

    destroyProjectCharts();

    if (!groups.length) {
        grid.innerHTML = '';
        noEntries?.classList.remove('hidden');
        return;
    }

    noEntries?.classList.add('hidden');

    grid.innerHTML = groups.map((group, index) => {
        const balance = group.totalIncome - group.totalExpense;
        const balanceClass = balance < 0 ? 'negative' : '';
        const projectToken = encodeURIComponent(group.name);
        const inputId = 'project-image-input-' + index;
        const isSelected = state.selectedProject === group.name ? ' selected' : '';
        const chartImage = group.chartImage
            ? `<img src="${group.chartImage}" alt="${escapeHtml(group.name)}">`
            : '<div class="project-image-placeholder"><i class="fa-solid fa-image"></i><span>画像未登録</span></div>';
        const imageActions = group.chartImage
            ? '<button class="project-image-remove" type="button" data-remove-image>画像削除</button>'
            : '';

        return `<article class="project-card${isSelected}" data-project-card>
            <div class="project-card-head">
                <div class="project-copy">
                    <div class="project-chip"><i class="fa-solid fa-folder-open"></i><span>PROJECT</span></div>
                    <h3 class="project-title">${escapeHtml(group.name)}</h3>
                    <div class="project-meta-row">
                        <span class="project-date">更新日 ${escapeHtml(formatDate(group.date))}</span>
                        <span class="balance-pill ${balanceClass}">${formatSignedCurrency(balance)}</span>
                    </div>
                </div>
                <div class="project-media">
                    <div class="project-image-box">${chartImage}</div>
                    <div class="project-image-actions">
                        <button class="project-image-btn" type="button" data-image-trigger="${inputId}"><i class="fa-solid fa-camera"></i><span>${group.chartImage ? '画像変更' : '画像登録'}</span></button>
                        ${imageActions}
                    </div>
                    <input id="${inputId}" class="hidden" type="file" accept="image/*" data-image-input data-project-token="${projectToken}">
                </div>
            </div>
            <div class="project-chart-wrap">
                <canvas id="project-chart-${index}"></canvas>
            </div>
            <div class="project-stats">
                <div class="project-stat">
                    <div class="project-stat-label">収入</div>
                    <div class="project-stat-value income">${formatCurrency(group.totalIncome)}</div>
                </div>
                <div class="project-stat">
                    <div class="project-stat-label">支出</div>
                    <div class="project-stat-value expense">${formatCurrency(group.totalExpense)}</div>
                </div>
                <div class="project-stat">
                    <div class="project-stat-label">明細件数</div>
                    <div class="project-stat-value">${group.transactionCount}件</div>
                </div>
            </div>
            <div class="project-card-foot">収入バーと支出バーをクリックすると、このプロジェクトの明細が下に開きます。</div>
        </article>`;
    }).join('');

    bindProjectCardActions(grid);
    groups.forEach((group, index) => createProjectChart(group, index));
}

function bindProjectCardActions(grid) {
    grid.querySelectorAll('[data-image-trigger]').forEach((button) => {
        button.addEventListener('click', () => {
            document.getElementById(button.dataset.imageTrigger)?.click();
        });
    });

    grid.querySelectorAll('[data-image-input]').forEach((input) => {
        input.addEventListener('change', (event) => {
            handleProjectImageSelected(event, input.dataset.projectToken);
        });
    });

    grid.querySelectorAll('[data-remove-image]').forEach((button) => {
        button.addEventListener('click', () => {
            const token = button.closest('[data-project-card]')?.querySelector('[data-image-input]')?.dataset.projectToken;
            if (token) removeProjectImage(token);
        });
    });
}

function createProjectChart(group, index) {
    const canvas = document.getElementById('project-chart-' + index);
    if (!canvas) return;

    const activeMetric = state.selectedProject === group.name ? state.selectedMetric : null;
    const incomeColor = activeMetric === 'expense' ? 'rgba(72, 187, 120, 0.28)' : METRIC_META.income.color;
    const expenseColor = activeMetric === 'income' ? 'rgba(245, 101, 101, 0.28)' : METRIC_META.expense.color;
    const maxValue = Math.max(group.totalIncome, group.totalExpense, 1);
    const suggestedMax = Math.max(10000, Math.ceil((maxValue * 1.18) / 10000) * 10000);

    const projectChart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: [''],
            datasets: [
                {
                    label: '収入',
                    data: [group.totalIncome],
                    backgroundColor: incomeColor,
                    borderColor: METRIC_META.income.color,
                    borderWidth: activeMetric === 'income' ? 2 : 1,
                    borderRadius: 10,
                    categoryPercentage: 0.3,
                    barPercentage: 0.98,
                    maxBarThickness: 34,
                },
                {
                    label: '支出',
                    data: [group.totalExpense],
                    backgroundColor: expenseColor,
                    borderColor: METRIC_META.expense.color,
                    borderWidth: activeMetric === 'expense' ? 2 : 1,
                    borderRadius: 10,
                    categoryPercentage: 0.3,
                    barPercentage: 0.98,
                    maxBarThickness: 34,
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 320 },
            interaction: { mode: 'nearest', intersect: true },
            onHover: (_event, elements, chartInstance) => {
                chartInstance.canvas.style.cursor = elements.length ? 'pointer' : 'default';
            },
            onClick: (event, _elements, chartInstance) => {
                const points = chartInstance.getElementsAtEventForMode(event, 'nearest', { intersect: true }, true);
                if (!points.length) return;
                selectMetric(group.name, points[0].datasetIndex === 0 ? 'income' : 'expense');
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    padding: 12,
                    backgroundColor: 'rgba(22, 49, 39, 0.92)',
                    callbacks: {
                        title: () => group.name,
                        label: (context) => `${context.dataset.label}: ${formatCurrency(context.raw)}`
                    }
                }
            },
            scales: {
                x: { display: false, grid: { display: false } },
                y: {
                    beginAtZero: true,
                    suggestedMax,
                    grid: { color: 'rgba(148, 163, 184, 0.14)' },
                    ticks: {
                        color: '#668277',
                        maxTicksLimit: 4,
                        callback: (value) => formatCurrency(value)
                    }
                }
            }
        }
    });

    projectCharts.set(group.name, projectChart);
}
function buildProjectRootPayload(projectName, baseEntry = {}, patch = {}) {
    const today = new Date().toISOString().split('T')[0];
    const fallbackDate = [...state.entries]
        .filter((entry) => entry.item === projectName)
        .sort((a, b) => parseDateValue(b.date) - parseDateValue(a.date))[0]?.date || today;
    return {
        ...baseEntry,
        ...patch,
        id: String(baseEntry.id || patch.id || Date.now()),
        date: patch.date || baseEntry.date || fallbackDate,
        item: projectName,
        manufacturer: patch.manufacturer ?? baseEntry.manufacturer ?? '',
        income: normalizeCurrencyInput(patch.income ?? baseEntry.income),
        incomeNote: patch.incomeNote ?? baseEntry.incomeNote ?? '',
        expense: normalizeCurrencyInput(patch.expense ?? baseEntry.expense),
        expenseNote: patch.expenseNote ?? baseEntry.expenseNote ?? '',
        isProjectRoot: true,
        chartImage: patch.chartImage ?? baseEntry.chartImage ?? '',
    };
}

function getProjectRootEntry(projectName) {
    return state.entries.find((entry) => entry.item === projectName && entry.isProjectRoot) || null;
}

async function upsertProjectMeta(projectName, patch) {
    const currentRoot = getProjectRootEntry(projectName);
    const payload = buildProjectRootPayload(projectName, currentRoot || {}, patch);
    await syncEntry(currentRoot ? 'update' : 'add', payload);
}

function optimizeProjectImage(file) {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith('image/')) {
            reject(new Error('画像ファイルを選択してください。'));
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            const image = new Image();
            image.onload = () => {
                const maxWidth = 480;
                const maxHeight = 320;
                const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
                const width = Math.max(1, Math.round(image.width * scale));
                const height = Math.max(1, Math.round(image.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const context = canvas.getContext('2d');
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, width, height);
                context.drawImage(image, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.78));
            };
            image.onerror = () => reject(new Error('画像を読み込めませんでした。'));
            image.src = reader.result;
        };
        reader.onerror = () => reject(new Error('画像ファイルの読み込みに失敗しました。'));
        reader.readAsDataURL(file);
    });
}

async function handleProjectImageSelected(event, projectToken) {
    const file = event.target.files?.[0];
    const projectName = decodeURIComponent(projectToken || '');
    if (!file || !projectName) return;

    try {
        const chartImage = await optimizeProjectImage(file);
        await upsertProjectMeta(projectName, { chartImage });
    } catch (error) {
        console.error('Image upload error:', error);
        alert(error.message || '画像登録に失敗しました。');
    } finally {
        event.target.value = '';
    }
}

async function removeProjectImage(projectToken) {
    const projectName = decodeURIComponent(projectToken || '');
    if (!projectName) return;
    if (!confirm(`「${projectName}」の画像を削除しますか？`)) return;
    await upsertProjectMeta(projectName, { chartImage: '' });
}
function renderDetailSection(groups, selectedGroup) {
    const emptyState = document.getElementById('detail-empty-state');
    const accordion = document.getElementById('detail-accordion');
    const noEntries = document.getElementById('no-entries');
    const detailKicker = document.getElementById('detail-kicker');
    const detailTitle = document.getElementById('detail-title');
    const detailSubtitle = document.getElementById('detail-subtitle');
    const detailOverview = document.getElementById('detail-overview');
    const entriesGrid = document.getElementById('entries-grid');

    if (!groups.length) {
        emptyState.classList.add('hidden');
        noEntries.classList.remove('hidden');
        detailTitle.textContent = 'プロジェクト明細';
        detailSubtitle.textContent = '';
        detailOverview.innerHTML = '';
        entriesGrid.innerHTML = '';
        syncDetailAccordion(false);
        return;
    }

    noEntries.classList.add('hidden');

    if (!selectedGroup || !state.selectedMetric) {
        emptyState.classList.remove('hidden');
        detailOverview.innerHTML = '';
        entriesGrid.innerHTML = '';
        syncDetailAccordion(false);
        return;
    }

    emptyState.classList.add('hidden');

    const metric = METRIC_META[state.selectedMetric];
    const oppositeMetric = state.selectedMetric === 'income' ? METRIC_META.expense : METRIC_META.income;
    const metricTotal = state.selectedMetric === 'income' ? selectedGroup.totalIncome : selectedGroup.totalExpense;
    const oppositeTotal = state.selectedMetric === 'income' ? selectedGroup.totalExpense : selectedGroup.totalIncome;
    const projectBalance = selectedGroup.totalIncome - selectedGroup.totalExpense;

    const detailItems = [...selectedGroup.items]
        .filter((item) => normalizeCurrencyInput(item[metric.key]) > 0)
        .sort((a, b) => {
            const dateDiff = parseDateValue(b.date) - parseDateValue(a.date);
            if (dateDiff !== 0) return dateDiff;
            return normalizeCurrencyInput(b[metric.key]) - normalizeCurrencyInput(a[metric.key]);
        });

    detailKicker.className = `detail-kicker ${metric.className}`;
    detailKicker.innerHTML = `<i class="fa-solid ${metric.icon}"></i><span>${metric.label}明細</span>`;
    detailTitle.textContent = selectedGroup.name;
    detailSubtitle.textContent = `${formatDate(selectedGroup.date)} 更新 ・ ${detailItems.length}件の${metric.label}取引`;

    detailOverview.innerHTML = `
        <div class="detail-stat">
            <div class="detail-stat-label">選択バー合計</div>
            <div class="detail-stat-value ${metric.className}">${formatCurrency(metricTotal)}</div>
        </div>
        <div class="detail-stat">
            <div class="detail-stat-label">${oppositeMetric.label}合計</div>
            <div class="detail-stat-value ${oppositeMetric.className}">${formatCurrency(oppositeTotal)}</div>
        </div>
        <div class="detail-stat">
            <div class="detail-stat-label">収支バランス</div>
            <div class="detail-stat-value ${projectBalance < 0 ? 'balance-negative' : 'income'}">${formatSignedCurrency(projectBalance)}</div>
        </div>
        <div class="detail-stat">
            <div class="detail-stat-label">明細件数</div>
            <div class="detail-stat-value">${detailItems.length}件</div>
        </div>
    `;

    if (!detailItems.length) {
        entriesGrid.innerHTML = `
            <div class="empty-detail-card">
                この${metric.label}に紐づく取引はまだありません。上のボタンから取引を追加できます。
            </div>
        `;
    } else {
        entriesGrid.innerHTML = detailItems.map((item) => renderDetailCard(item, metric)).join('');
    }

    bindDetailActions(selectedGroup);
    syncDetailAccordion(true);
}

function renderDetailCard(item, metric) {
    const amount = normalizeCurrencyInput(item[metric.key]);
    const oppositeMetric = metric.key === 'income' ? METRIC_META.expense : METRIC_META.income;
    const oppositeAmount = normalizeCurrencyInput(item[oppositeMetric.key]);
    const note = String(item[metric.noteKey] || '').trim() || `${metric.label}備考はありません`;
    const manufacturer = String(item.manufacturer || '').trim() || 'メーカー名未設定';

    return `
        <div class="detail-line-card">
            <div class="detail-line-top">
                <div>
                    <div class="detail-line-company">${escapeHtml(manufacturer)}</div>
                    <div class="detail-line-date">${escapeHtml(formatDate(item.date))}</div>
                </div>
                <div class="detail-line-amount ${metric.className}">${formatCurrency(amount)}</div>
            </div>
            <div class="detail-note">${escapeHtml(note)}</div>
            <div class="detail-line-meta">
                <span class="detail-line-badge ${metric.className === 'expense' ? 'expense' : ''}">
                    <i class="fa-solid ${metric.icon}"></i>
                    <span>${metric.label}</span>
                </span>
                ${oppositeAmount ? `<span class="detail-line-badge ${oppositeMetric.className === 'expense' ? 'expense' : ''}">${oppositeMetric.label} ${formatCurrency(oppositeAmount)}</span>` : ''}
            </div>
            <div class="detail-line-footer">
                <span class="detail-line-date">${escapeHtml(item.item || '')}</span>
                <div class="detail-line-actions">
                    <button class="action-icon" type="button" title="編集" onclick='openModal("edit", { id: ${JSON.stringify(String(item.id))} })'>
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="action-icon delete" type="button" title="削除" onclick='deleteEntry(${JSON.stringify(String(item.id))})'>
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        </div>
    `;
}

function bindDetailActions(group) {
    const defaultDate = group.date || new Date().toISOString().split('T')[0];

    document.getElementById('detail-add-btn').onclick = () => openModal('transaction-add', {
        date: defaultDate,
        item: group.name,
    });
    document.getElementById('detail-import-btn').onclick = () => triggerImport(group.name);
    document.getElementById('detail-export-btn').onclick = () => exportCSVProject(group.name);
    document.getElementById('detail-delete-btn').onclick = () => deleteProject(group.name);
    document.getElementById('detail-close-btn').onclick = () => closeDetailAccordion();
}

function closeDetailAccordion() {
    state.selectedProject = null;
    state.selectedMetric = null;
    render();
}

function openModal(mode, data = null) {
    const modal = document.getElementById('entry-modal');
    const title = document.getElementById('modal-title');
    const inputs = modal.querySelectorAll('input');

    inputs.forEach((input) => {
        input.value = '';
        input.disabled = false;
        input.style.background = 'white';
    });

    modal.dataset.mode = mode;
    editingId = mode === 'edit' && data ? String(data.id) : null;

    if (mode === 'project-new') {
        title.textContent = '新規プロジェクト作成';
        document.getElementById('entry-date').value = new Date().toISOString().split('T')[0];
        toggleTransactionFields(false);
    } else if (mode === 'transaction-add') {
        title.textContent = '取引を追加';
        document.getElementById('entry-date').value = data?.date || new Date().toISOString().split('T')[0];
        document.getElementById('entry-item').value = data?.item || '';
        document.getElementById('entry-item').disabled = true;
        document.getElementById('entry-item').style.background = '#f1f5f9';
        toggleTransactionFields(true);
    } else if (mode === 'edit') {
        title.textContent = '明細を編集';
        const entry = state.entries.find((item) => String(item.id) === String(data?.id));
        if (entry) {
            document.getElementById('entry-date').value = entry.date || '';
            document.getElementById('entry-item').value = entry.item || '';
            document.getElementById('entry-manufacturer').value = entry.manufacturer || '';
            document.getElementById('entry-income').value = normalizeCurrencyInput(entry.income) || '';
            document.getElementById('entry-income-note').value = entry.incomeNote || '';
            document.getElementById('entry-expense').value = normalizeCurrencyInput(entry.expense) || '';
            document.getElementById('entry-expense-note').value = entry.expenseNote || '';
        }
        toggleTransactionFields(true);
    }

    modal.classList.remove('hidden');
}

function toggleTransactionFields(show) {
    document.querySelectorAll('.transaction-field').forEach((field) => {
        field.style.display = show ? 'block' : 'none';
    });
}

function closeModal() {
    document.getElementById('entry-modal').classList.add('hidden');
    editingId = null;
}

function saveEntry() {
    const modal = document.getElementById('entry-modal');
    const mode = modal.dataset.mode;

    const date = document.getElementById('entry-date').value;
    const item = document.getElementById('entry-item').value.trim();
    const manufacturer = document.getElementById('entry-manufacturer').value.trim();
    const income = normalizeCurrencyInput(document.getElementById('entry-income').value);
    const incomeNote = document.getElementById('entry-income-note').value.trim();
    const expense = normalizeCurrencyInput(document.getElementById('entry-expense').value);
    const expenseNote = document.getElementById('entry-expense-note').value.trim();

    if (!date || !item) {
        alert('作成日と作成項目は必須です。');
        return;
    }

    let entryData;

    if (mode === 'project-new') {
        entryData = {
            id: String(Date.now()),
            date,
            item,
            manufacturer: '',
            income: 0,
            incomeNote: '',
            expense: 0,
            expenseNote: '',
            chartImage: '',
            isProjectRoot: true,
        };
        syncEntry('add', entryData);
    } else if (mode === 'transaction-add') {
        entryData = {
            id: String(Date.now()),
            date,
            item,
            manufacturer,
            income,
            incomeNote,
            expense,
            expenseNote,
        };
        syncEntry('add', entryData);
        state.selectedProject = item;
        state.selectedMetric = income > 0 ? 'income' : expense > 0 ? 'expense' : null;
    } else if (mode === 'edit') {
        const existing = state.entries.find((entry) => String(entry.id) === String(editingId));
        if (!existing) return;
        entryData = {
            ...existing,
            date,
            item,
            manufacturer,
            income,
            incomeNote,
            expense,
            expenseNote,
        };
        syncEntry('update', entryData);
        state.selectedProject = item;
        if (income > 0) {
            state.selectedMetric = 'income';
        } else if (expense > 0) {
            state.selectedMetric = 'expense';
        }
    }

    closeModal();
}

function deleteEntry(id) {
    if (!confirm('この明細を削除しますか？')) return;
    syncEntry('delete', String(id));
}

function deleteProject(itemName) {
    if (!confirm(`「${itemName}」に紐づくすべての明細を削除しますか？`)) return;
    syncEntry('delete_project', itemName);
}

function buildCsvRows(entries) {
    return entries.map((entry) => {
        const income = normalizeCurrencyInput(entry.income);
        const expense = normalizeCurrencyInput(entry.expense);
        return `${entry.date || ''},"${String(entry.item || '').replace(/"/g, '""')}","${String(entry.manufacturer || '').replace(/"/g, '""')}",${income},"${String(entry.incomeNote || '').replace(/"/g, '""')}",${expense},"${String(entry.expenseNote || '').replace(/"/g, '""')}"`;
    }).join('\n');
}

function downloadCsv(filename, body) {
    const blob = new Blob([body], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
}

function exportCSVProject(projectName) {
    const projectEntries = state.entries
        .filter((entry) => entry.item === projectName && (!entry.isProjectRoot || normalizeCurrencyInput(entry.income) || normalizeCurrencyInput(entry.expense)))
        .sort((a, b) => parseDateValue(a.date) - parseDateValue(b.date));

    if (!projectEntries.length) {
        alert('出力するデータがありません。');
        return;
    }

    const csv = `\ufeff作成日,作成項目,メーカー名,収入,収入備考,支出,支出備考\n${buildCsvRows(projectEntries)}\n`;
    downloadCsv(`catalog_${projectName}.csv`, csv);
}

function exportCSV() {
    if (!state.entries.length) return;
    const entries = state.entries
        .filter((entry) => !entry.isProjectRoot || normalizeCurrencyInput(entry.income) || normalizeCurrencyInput(entry.expense))
        .sort((a, b) => parseDateValue(a.date) - parseDateValue(b.date));
    const csv = `\ufeff作成日,作成項目,メーカー名,収入,収入備考,支出,支出備考\n${buildCsvRows(entries)}\n`;
    downloadCsv('catalog_all_export.csv', csv);
}

function downloadCSVFormat() {
    const template = '\ufeff作成日,作成項目,メーカー名,収入,収入備考,支出,支出備考\n2026-01-01,防災備蓄カタログ,メーカー名A,10000,掲載料,5000,印刷費\n';
    downloadCsv('template.csv', template);
}

function parseCSVLine(text) {
    const result = [];
    let current = '';
    let inQuote = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (inQuote) {
            if (char === '"') {
                if (text[index + 1] === '"') {
                    current += '"';
                    index += 1;
                } else {
                    inQuote = false;
                }
            } else {
                current += char;
            }
        } else if (char === '"') {
            inQuote = true;
        } else if (char === ',') {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }

    result.push(current);
    return result;
}

function triggerImport(projectName) {
    currentImportProject = projectName;
    document.getElementById('csv-import-project').click();
}

function importCSVProject(input) {
    const file = input.files?.[0];
    if (!file || !currentImportProject) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
        const text = String(event.target?.result || '');
        const lines = text.split(/\r?\n/).filter((line) => line.trim());
        const newEntries = [];

        for (let index = 1; index < lines.length; index += 1) {
            const parts = parseCSVLine(lines[index]);
            const date = String(parts[0] || '').trim();
            if (!date) continue;

            newEntries.push({
                id: String(Date.now() + index),
                date,
                item: currentImportProject,
                manufacturer: String(parts[2] || '').trim(),
                income: normalizeCurrencyInput(parts[3]),
                incomeNote: String(parts[4] || '').trim(),
                expense: normalizeCurrencyInput(parts[5]),
                expenseNote: String(parts[6] || '').trim(),
            });
        }

        if (!newEntries.length) {
            input.value = '';
            return;
        }

        state.entries.push(...newEntries);
        persistLocalData();
        state.selectedProject = currentImportProject;
        state.selectedMetric = newEntries.some((entry) => normalizeCurrencyInput(entry.income) > 0) ? 'income' : (newEntries.some((entry) => normalizeCurrencyInput(entry.expense) > 0) ? 'expense' : null);
        debounceRender();
        alert(`${newEntries.length}件の取引を読み込みました。`);
        input.value = '';

        if (!db) return;

        try {
            let batch = db.batch();
            let batchCount = 0;
            for (const entry of newEntries) {
                const ref = db.collection('catalog_entries').doc(String(entry.id));
                batch.set(ref, entry);
                batchCount += 1;
                if (batchCount >= 450) {
                    await batch.commit();
                    batch = db.batch();
                    batchCount = 0;
                }
            }
            if (batchCount > 0) {
                await batch.commit();
            }
        } catch (error) {
            console.error('Import sync error:', error);
        }
    };

    reader.readAsText(file);
}

window.openModal = openModal;
window.closeModal = closeModal;
window.saveEntry = saveEntry;
window.deleteEntry = deleteEntry;
window.deleteProject = deleteProject;
window.triggerImport = triggerImport;
window.exportCSVProject = exportCSVProject;
window.exportCSV = exportCSV;
window.downloadCSVFormat = downloadCSVFormat;
window.importCSVProject = importCSVProject;
window.closeDetailAccordion = closeDetailAccordion;

window.addEventListener('resize', () => {
    if (state.selectedProject && state.selectedMetric) {
        syncDetailAccordion(true);
    }
});

persistencePromise.finally(() => {
    if (auth) {
        auth.onAuthStateChanged((user) => {
            if (user) {
                init();
            } else {
                if (unsubscribeEntries) {
                    unsubscribeEntries();
                    unsubscribeEntries = null;
                }
                loadLocalData();
            }
        });
    } else {
        init();
    }
});

render();





