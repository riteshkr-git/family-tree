/**
 * Family Tree Builder - application state, API client, shell UI (toolbar, panel, menus, settings).
 */
'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
    colors: null,                 // {male, female, unknown} or null for theme defaults
    nodeWidth: 160,
    photoSize: 44,
    fontSize: 13,
    fontFamily: 'Inter, system-ui, sans-serif'
};

const PALETTES = {
    classic: { label: 'Classic', male: '#dbeafe', female: '#fce7f3', unknown: '#eef1f6' },
    pastel: { label: 'Pastel', male: '#dcfce7', female: '#fef3c7', unknown: '#ede9fe' },
    earth: { label: 'Earth', male: '#e7e5d3', female: '#f3e3d3', unknown: '#e5e7eb' },
    mono: { label: 'Mono', male: '#e5e7eb', female: '#d1d5db', unknown: '#f3f4f6' }
};

const AppState = {
    tree: { persons: {}, marriages: {}, parent_child: [] },
    selectedPersonId: null,
    selectedPersonIds: new Set(),
    canUndo: false,
    canRedo: false,
    settings: { ...DEFAULT_SETTINGS }
};

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
const API = {
    baseUrl: '/api',

    async request(method, endpoint, data = null) {
        const options = { method, headers: {}, credentials: 'same-origin' };
        if (data !== null) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(data);
        }
        const response = await fetch(`${this.baseUrl}${endpoint}`, options);
        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: response.statusText }));
            const detail = Array.isArray(error.detail)
                ? error.detail.map(d => d.msg || JSON.stringify(d)).join('; ')
                : (error.detail || 'Request failed');
            throw new Error(detail);
        }
        const type = response.headers.get('content-type') || '';
        return type.includes('application/json') ? response.json() : response;
    },

    getTree() { return this.request('GET', '/tree'); },
    newTree() { return this.request('POST', '/tree/new'); },
    undo() { return this.request('POST', '/tree/undo'); },
    redo() { return this.request('POST', '/tree/redo'); },
    exportJson() { return this.request('GET', '/tree/export-json'); },
    importJson(data) { return this.request('POST', '/tree/import-json', data); },
    autoLayout(rootPersonId, direction, spacingX, spacingY) {
        return this.request('POST', '/tree/layout', {
            root_person_id: rootPersonId, direction, spacing_x: spacingX, spacing_y: spacingY
        });
    },

    createPerson(data) { return this.request('POST', '/persons', data); },
    updatePerson(id, data) { return this.request('PUT', `/persons/${encodeURIComponent(id)}`, data); },
    updatePositions(positions) { return this.request('PATCH', '/persons/positions', positions); },
    deletePerson(id) { return this.request('DELETE', `/persons/${encodeURIComponent(id)}`); },

    createMarriage(spouse1Id, spouse2Id, marriageDate) {
        return this.request('POST', '/marriages', {
            spouse1_id: spouse1Id, spouse2_id: spouse2Id, marriage_date: marriageDate || null
        });
    },
    updateMarriage(id, data) { return this.request('PUT', `/marriages/${encodeURIComponent(id)}`, data); },
    deleteMarriage(id) { return this.request('DELETE', `/marriages/${encodeURIComponent(id)}`); },
    addChild(parentId, childId, marriageId) {
        return this.request('POST', '/children', {
            parent_id: parentId, child_id: childId, marriage_id: marriageId || null
        });
    },
    removeChild(parentId, childId) {
        return this.request('DELETE', `/children/${encodeURIComponent(parentId)}/${encodeURIComponent(childId)}`);
    },

    async uploadPhoto(blob, filename = 'photo.jpg') {
        const formData = new FormData();
        formData.append('file', blob, filename);
        const response = await fetch(`${this.baseUrl}/tree/upload-photo`, {
            method: 'POST', body: formData, credentials: 'same-origin'
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || 'Upload failed');
        }
        return response.json();
    }
};

// ---------------------------------------------------------------------------
// Small DOM / formatting helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined) continue;
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value; // only ever used with trusted markup (icons)
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'style') node.style.cssText = value;
        else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

function icon(name, cls = 'icon') {
    return el('svg', { className: cls, html: `<use href="#i-${name}"/>` });
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    const first = [...parts[0]][0] || '';
    const last = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : '';
    return (first + last).toUpperCase();
}

function photoUrl(person) {
    if (!person || !person.photo_path) return null;
    const name = person.photo_path.split('/').pop();
    return name ? `/uploads/${encodeURIComponent(name)}` : null;
}

function lifeSpan(person) {
    const b = person.date_of_birth, d = person.date_of_death;
    if (b && d) return `${b} – ${d}`;
    if (b) return `b. ${b}`;
    if (d) return `d. ${d}`;
    return '';
}

function avatarEl(person, cls = 'avatar') {
    const node = el('div', { className: `${cls} ${person.gender || 'unknown'}` });
    const url = photoUrl(person);
    if (url) node.append(el('img', { src: url, alt: '' }));
    else node.textContent = initials(person.name);
    return node;
}

function personCount() {
    return Object.keys(AppState.tree.persons).length;
}

function isTyping() {
    const a = document.activeElement;
    if (!a) return false;
    return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function todayStamp() {
    return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Toasts and status
// ---------------------------------------------------------------------------
function showToast(message, type = 'info', duration = 2600) {
    const container = $('toast-container');
    const iconName = type === 'success' ? 'check' : type === 'error' ? 'alert' : null;
    const toast = el('div', { className: `toast ${type}` }, iconName && icon(iconName), el('span', { text: message }));
    container.append(toast);
    while (container.children.length > 3) container.firstElementChild.remove();
    setTimeout(() => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 220);
    }, duration);
}

function updateStatus(text) {
    $('status-text').textContent = text;
}

function updateCounts() {
    const n = personCount();
    $('person-count').textContent = `${n} ${n === 1 ? 'person' : 'people'}`;
    const s = AppState.selectedPersonIds.size;
    $('selection-count').textContent = s > 1 ? `${s} selected` : '';
}

function updateUndoRedoButtons() {
    $('undo-btn').disabled = !AppState.canUndo;
    $('redo-btn').disabled = !AppState.canRedo;
}

function updateZoomLabel(scale) {
    $('zoom-level').textContent = `${Math.round(scale * 100)}%`;
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
const Modal = {
    stack: [],

    open(id) {
        const overlay = $(id);
        overlay.classList.add('active');
        this.stack = this.stack.filter(x => x !== id);
        this.stack.push(id);
        const focusTarget = overlay.querySelector('input:not([type=hidden]):not([type=file]):not([type=radio]), textarea, select, button.btn-primary');
        if (focusTarget) setTimeout(() => focusTarget.focus(), 30);
    },

    close(id) {
        $(id).classList.remove('active');
        this.stack = this.stack.filter(x => x !== id);
    },

    closeTop() {
        const id = this.stack[this.stack.length - 1];
        if (id) this.close(id);
        return Boolean(id);
    },

    isOpen() {
        return this.stack.length > 0;
    },

    init() {
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.querySelectorAll('[data-close]').forEach(btn => {
                btn.addEventListener('click', () => this.close(overlay.id));
            });
            overlay.addEventListener('pointerdown', (e) => {
                if (e.target === overlay) this.close(overlay.id);
            });
        });
    }
};

function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', danger = false } = {}) {
    return new Promise(resolve => {
        $('confirm-title').textContent = title;
        $('confirm-message').textContent = message;
        const ok = $('confirm-ok-btn');
        const cancel = $('confirm-cancel-btn');
        ok.textContent = confirmText;
        ok.classList.toggle('btn-danger', danger);

        const cleanup = (result) => {
            ok.onclick = null;
            cancel.onclick = null;
            Modal.close('confirm-modal');
            resolve(result);
        };
        ok.onclick = () => cleanup(true);
        cancel.onclick = () => cleanup(false);
        Modal.open('confirm-modal');
        ok.focus();
    });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadTreeData({ fit = false } = {}) {
    try {
        const data = await API.getTree();
        AppState.tree = data.tree;
        AppState.canUndo = data.can_undo;
        AppState.canRedo = data.can_redo;

        // Drop selections that no longer exist
        for (const id of [...AppState.selectedPersonIds]) {
            if (!AppState.tree.persons[id]) AppState.selectedPersonIds.delete(id);
        }
        if (AppState.selectedPersonId && !AppState.tree.persons[AppState.selectedPersonId]) {
            AppState.selectedPersonId = null;
            hidePanel();
        }

        TreeRenderer.render();
        if (fit) TreeRenderer.fitToContent();
        $('empty-state').classList.toggle('hidden', personCount() > 0);
        updateCounts();
        updateUndoRedoButtons();
        if (AppState.selectedPersonId && !$('side-panel').classList.contains('collapsed')) {
            renderPanel(AppState.selectedPersonId);
        }
        updateStatus('Ready');
    } catch (error) {
        console.error('Failed to load tree:', error);
        showToast('Could not load the tree', 'error');
        updateStatus('Connection problem');
    }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
function setSelection(ids, primary = null) {
    AppState.selectedPersonIds = new Set(ids);
    AppState.selectedPersonId = primary ?? (ids.length === 1 ? ids[0] : null);
    TreeRenderer.updateSelection();
    updateCounts();
}

function clearSelection() {
    if (AppState.selectedPersonIds.size === 0 && !AppState.selectedPersonId) return;
    setSelection([]);
    hidePanel();
}

function selectBranch(rootId) {
    const ids = new Set();
    const queue = [rootId];
    while (queue.length) {
        const pid = queue.shift();
        if (ids.has(pid)) continue;
        ids.add(pid);
        for (const m of Object.values(AppState.tree.marriages)) {
            if (m.spouse1_id === pid) ids.add(m.spouse2_id);
            if (m.spouse2_id === pid) ids.add(m.spouse1_id);
        }
        for (const pc of AppState.tree.parent_child) {
            if (pc.parent_id === pid) queue.push(pc.child_id);
        }
    }
    setSelection([...ids].filter(id => AppState.tree.persons[id]), rootId);
    showToast(`${ids.size} people selected`, 'info');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function doUndo() {
    if (!AppState.canUndo) return;
    try {
        await API.undo();
        await loadTreeData();
        showToast('Undone', 'info', 1400);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function doRedo() {
    if (!AppState.canRedo) return;
    try {
        await API.redo();
        await loadTreeData();
        showToast('Redone', 'info', 1400);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function deletePersons(ids) {
    ids = ids.filter(id => AppState.tree.persons[id]);
    if (ids.length === 0) return;
    const names = ids.map(id => AppState.tree.persons[id].name);
    const ok = await confirmDialog({
        title: ids.length === 1 ? `Delete ${names[0]}?` : `Delete ${ids.length} people?`,
        message: ids.length === 1
            ? 'Their marriages and parent links will be removed too. You can undo this.'
            : `${names.slice(0, 3).join(', ')}${ids.length > 3 ? ` and ${ids.length - 3} more` : ''} will be removed along with their relationships. You can undo this.`,
        confirmText: 'Delete',
        danger: true
    });
    if (!ok) return;
    try {
        for (const id of ids) await API.deletePerson(id);
        setSelection([]);
        hidePanel();
        await loadTreeData();
        showToast(ids.length === 1 ? 'Person deleted' : `${ids.length} people deleted`, 'success');
    } catch (error) {
        showToast(error.message, 'error');
        await loadTreeData();
    }
}

async function newTree() {
    if (personCount() > 0) {
        const ok = await confirmDialog({
            title: 'Start a new tree?',
            message: 'The current tree will be cleared. Save it as JSON first if you want to keep it. You can undo this.',
            confirmText: 'New tree'
        });
        if (!ok) return;
    }
    try {
        await API.newTree();
        setSelection([]);
        hidePanel();
        await loadTreeData();
        TreeRenderer.centerView();
        showToast('New tree created', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function exportJson() {
    try {
        updateStatus('Saving…');
        const data = await API.exportJson();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        downloadBlob(blob, `family-tree-${todayStamp()}.json`);
        showToast('Saved as JSON', 'success');
    } catch (error) {
        showToast(`Save failed: ${error.message}`, 'error');
    } finally {
        updateStatus('Ready');
    }
}

function importJson() {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        try {
            updateStatus('Opening…');
            const data = JSON.parse(await file.text());
            if (!data || typeof data.persons !== 'object' || data.persons === null) {
                throw new Error('This file does not look like a family tree export');
            }
            data.marriages = data.marriages || {};
            data.parent_child = data.parent_child || [];
            if (personCount() > 0) {
                const ok = await confirmDialog({
                    title: 'Replace the current tree?',
                    message: `Opening "${file.name}" replaces what is on the canvas. You can undo this.`,
                    confirmText: 'Open'
                });
                if (!ok) { updateStatus('Ready'); return; }
            }
            const result = await API.importJson(data);
            setSelection([]);
            hidePanel();
            await loadTreeData({ fit: true });
            showToast(`Opened ${result.persons} ${result.persons === 1 ? 'person' : 'people'}`, 'success');
        } catch (error) {
            console.error('Import failed:', error);
            showToast(`Open failed: ${error.message}`, 'error');
            updateStatus('Ready');
        }
    };
    input.click();
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
function hidePanel() {
    $('side-panel').classList.add('collapsed');
}

function showPersonDetails(personId) {
    if (!AppState.tree.persons[personId]) return;
    setSelection([personId], personId);
    renderPanel(personId);
    $('side-panel').classList.remove('collapsed');
}

function relationRow(person, subtitle, extra = null) {
    const row = el('button', { className: 'relation', type: 'button', onclick: () => {
        showPersonDetails(person.id);
        TreeRenderer.panTo(person.id);
    } },
        avatarEl(person),
        el('div', { className: 'relation-text' },
            el('div', { className: 'relation-name', text: person.name }),
            subtitle ? el('div', { className: 'relation-sub', text: subtitle }) : null
        ),
        extra
    );
    return row;
}

function renderPanel(personId) {
    const tree = AppState.tree;
    const person = tree.persons[personId];
    const content = $('panel-content');
    if (!person) { content.replaceChildren(); return; }

    const marriages = Object.values(tree.marriages).filter(m => m.spouse1_id === personId || m.spouse2_id === personId);
    const children = tree.parent_child.filter(pc => pc.parent_id === personId).map(pc => tree.persons[pc.child_id]).filter(Boolean);
    const parents = tree.parent_child.filter(pc => pc.child_id === personId).map(pc => tree.persons[pc.parent_id]).filter(Boolean);
    const span = lifeSpan(person);

    const fragments = [
        el('div', { className: 'profile' },
            avatarEl(person),
            el('h2', { text: person.name }),
            span ? el('div', { className: 'dates', text: span }) : null,
            el('div', { className: 'profile-actions' },
                el('button', { className: 'btn btn-outline btn-sm', onclick: () => Forms.openSpouseModal(personId) }, icon('heart'), 'Spouse'),
                el('button', { className: 'btn btn-outline btn-sm', onclick: () => Forms.openChildModal(personId) }, icon('user-plus'), 'Child'),
                el('button', { className: 'btn btn-outline btn-sm', onclick: () => Forms.openPersonModal(personId) }, icon('edit'), 'Edit'),
                el('button', { className: 'btn btn-sm btn-danger', title: 'Delete', onclick: () => deletePersons([personId]) }, icon('trash'))
            )
        )
    ];

    if (person.notes) {
        fragments.push(el('div', { className: 'section' },
            el('div', { className: 'section-title', text: 'Notes' }),
            el('div', { className: 'notes', text: person.notes })
        ));
    }

    if (marriages.length) {
        fragments.push(el('div', { className: 'section' },
            el('div', { className: 'section-title', text: marriages.length > 1 ? 'Spouses' : 'Spouse' }),
            ...marriages.map(m => {
                const spouse = tree.persons[m.spouse1_id === personId ? m.spouse2_id : m.spouse1_id];
                if (!spouse) return null;
                const editBtn = el('button', { className: 'btn btn-icon btn-sm', title: 'Edit marriage', onclick: (e) => {
                    e.stopPropagation();
                    Forms.openEditMarriageModal(m.id);
                } }, icon('edit'));
                return relationRow(spouse, m.marriage_date ? `Married ${m.marriage_date}` : 'Married', editBtn);
            })
        ));
    }

    if (parents.length) {
        fragments.push(el('div', { className: 'section' },
            el('div', { className: 'section-title', text: 'Parents' }),
            ...parents.map(p => relationRow(p, lifeSpan(p)))
        ));
    }

    if (children.length) {
        fragments.push(el('div', { className: 'section' },
            el('div', { className: 'section-title', text: 'Children' }),
            ...children.map(c => relationRow(c, lifeSpan(c)))
        ));
    }

    content.replaceChildren(...fragments);
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
function showContextMenu(x, y, personId) {
    AppState.selectedPersonId = personId;
    const menu = $('context-menu');
    menu.classList.add('active');
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
}

function hideContextMenu() {
    $('context-menu').classList.remove('active');
}

function initContextMenu() {
    document.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('#context-menu')) hideContextMenu();
    });
    window.addEventListener('blur', hideContextMenu);

    const withSelected = (fn) => () => {
        hideContextMenu();
        if (AppState.selectedPersonId) fn(AppState.selectedPersonId);
    };
    $('ctx-add-spouse').addEventListener('click', withSelected(id => Forms.openSpouseModal(id)));
    $('ctx-add-child').addEventListener('click', withSelected(id => Forms.openChildModal(id)));
    $('ctx-edit').addEventListener('click', withSelected(id => Forms.openPersonModal(id)));
    $('ctx-select-branch').addEventListener('click', withSelected(id => selectBranch(id)));
    $('ctx-delete').addEventListener('click', withSelected(id => {
        const ids = AppState.selectedPersonIds.has(id) && AppState.selectedPersonIds.size > 1
            ? [...AppState.selectedPersonIds] : [id];
        deletePersons(ids);
    }));
}

// ---------------------------------------------------------------------------
// Dropdown menus
// ---------------------------------------------------------------------------
function initMenus() {
    document.querySelectorAll('.menu').forEach(menu => {
        const btn = menu.querySelector('button');
        const list = menu.querySelector('.menu-list');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = list.classList.toggle('active');
            btn.setAttribute('aria-expanded', String(open));
        });
        list.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', () => {
                list.classList.remove('active');
                btn.setAttribute('aria-expanded', 'false');
            });
        });
    });
    document.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.menu')) return;
        document.querySelectorAll('.menu-list.active').forEach(l => l.classList.remove('active'));
    });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch (e) { /* private mode */ }
    const sun = document.querySelector('#theme-btn .theme-sun');
    const moon = document.querySelector('#theme-btn .theme-moon');
    sun.classList.toggle('hidden', theme === 'light');
    moon.classList.toggle('hidden', theme === 'dark');
    $('theme-btn').title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

// ---------------------------------------------------------------------------
// Settings (appearance)
// ---------------------------------------------------------------------------
function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem('ftb.settings') || 'null');
        if (saved && typeof saved === 'object') AppState.settings = { ...DEFAULT_SETTINGS, ...saved };
    } catch (e) { /* ignore corrupt storage */ }
    applySettings(AppState.settings, false);
}

function applySettings(settings, persist = true) {
    AppState.settings = { ...DEFAULT_SETTINGS, ...settings };
    const s = AppState.settings;
    const root = document.documentElement.style;

    if (s.colors) {
        root.setProperty('--male', s.colors.male);
        root.setProperty('--female', s.colors.female);
        root.setProperty('--unknown', s.colors.unknown);
    } else {
        root.removeProperty('--male');
        root.removeProperty('--female');
        root.removeProperty('--unknown');
    }
    root.setProperty('--node-font-size', `${s.fontSize}px`);
    root.setProperty('--node-font-family', s.fontFamily);

    TreeRenderer.nodeWidth = s.nodeWidth;
    TreeRenderer.avatarSize = s.photoSize;
    if (TreeRenderer.svg) TreeRenderer.render();

    if (persist) {
        try { localStorage.setItem('ftb.settings', JSON.stringify(s)); } catch (e) { /* ignore */ }
    }
}

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function openSettingsModal() {
    const s = AppState.settings;
    const colors = s.colors || { male: cssVar('--male'), female: cssVar('--female'), unknown: cssVar('--unknown') };
    $('color-male').value = colors.male;
    $('color-female').value = colors.female;
    $('color-unknown').value = colors.unknown;
    $('node-size').value = s.nodeWidth;
    $('node-size-value').textContent = s.nodeWidth;
    $('photo-size').value = s.photoSize;
    $('photo-size-value').textContent = s.photoSize;
    $('font-size').value = s.fontSize;
    $('font-size-value').textContent = s.fontSize;
    $('font-family').value = s.fontFamily;
    if ($('font-family').value !== s.fontFamily) $('font-family').selectedIndex = 0;
    Modal.open('settings-modal');
}

function initSettings() {
    const swatches = $('palette-swatches');
    for (const [key, p] of Object.entries(PALETTES)) {
        const btn = el('button', { className: 'swatch', type: 'button', dataset: { palette: key } },
            el('i', { style: `background:${p.male}` }), el('i', { style: `background:${p.female}` }), el('i', { style: `background:${p.unknown}` }),
            p.label
        );
        btn.addEventListener('click', () => {
            $('color-male').value = p.male;
            $('color-female').value = p.female;
            $('color-unknown').value = p.unknown;
        });
        swatches.append(btn);
    }

    for (const [slider, label] of [['node-size', 'node-size-value'], ['photo-size', 'photo-size-value'], ['font-size', 'font-size-value']]) {
        $(slider).addEventListener('input', (e) => { $(label).textContent = e.target.value; });
    }

    $('settings-save-btn').addEventListener('click', () => {
        applySettings({
            colors: { male: $('color-male').value, female: $('color-female').value, unknown: $('color-unknown').value },
            nodeWidth: parseInt($('node-size').value, 10),
            photoSize: parseInt($('photo-size').value, 10),
            fontSize: parseInt($('font-size').value, 10),
            fontFamily: $('font-family').value
        });
        Modal.close('settings-modal');
        showToast('Appearance updated', 'success');
    });

    $('settings-reset-btn').addEventListener('click', () => {
        applySettings({ ...DEFAULT_SETTINGS });
        Modal.close('settings-modal');
        showToast('Appearance reset', 'info');
    });
}

// ---------------------------------------------------------------------------
// Toolbar and keyboard
// ---------------------------------------------------------------------------
function initToolbar() {
    $('new-tree-btn').addEventListener('click', newTree);
    $('export-json-btn').addEventListener('click', exportJson);
    $('import-json-btn').addEventListener('click', importJson);
    $('empty-import-btn').addEventListener('click', importJson);
    $('clear-btn').addEventListener('click', async () => {
        if (personCount() === 0) { showToast('The canvas is already empty', 'info'); return; }
        const ok = await confirmDialog({
            title: 'Clear the canvas?',
            message: `All ${personCount()} people and their relationships will be removed. You can undo this.`,
            confirmText: 'Clear',
            danger: true
        });
        if (!ok) return;
        await API.newTree();
        setSelection([]);
        hidePanel();
        await loadTreeData();
        showToast('Canvas cleared', 'success');
    });

    $('add-person-btn').addEventListener('click', () => Forms.openPersonModal());
    $('empty-add-btn').addEventListener('click', () => Forms.openPersonModal());
    $('undo-btn').addEventListener('click', doUndo);
    $('redo-btn').addEventListener('click', doRedo);

    $('auto-layout-btn').addEventListener('click', () => {
        if (personCount() === 0) { showToast('Add some people first', 'info'); return; }
        Forms.openLayoutModal();
    });
    $('export-btn').addEventListener('click', () => Exporter.open());
    $('export-btn-top').addEventListener('click', () => Exporter.open());
    $('settings-btn').addEventListener('click', openSettingsModal);
    $('theme-btn').addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
    $('close-panel').addEventListener('click', () => { hidePanel(); });

    $('zoom-in-btn').addEventListener('click', () => TreeRenderer.zoomBy(1.25));
    $('zoom-out-btn').addEventListener('click', () => TreeRenderer.zoomBy(1 / 1.25));
    $('fit-btn').addEventListener('click', () => TreeRenderer.fitToContent());
    $('zoom-level').addEventListener('click', () => TreeRenderer.setZoom(1));
}

function initKeyboardShortcuts() {
    document.addEventListener('keydown', async (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();

        if (e.key === 'Escape') {
            hideContextMenu();
            if (Modal.closeTop()) { e.preventDefault(); return; }
            clearSelection();
            return;
        }

        if (mod && key === 's') { e.preventDefault(); exportJson(); return; }
        if (mod && key === 'o') { e.preventDefault(); importJson(); return; }

        if (isTyping() || Modal.isOpen()) return;

        if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
        if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) { e.preventDefault(); doRedo(); return; }
        if (mod && key === 'a') {
            e.preventDefault();
            setSelection(Object.keys(AppState.tree.persons));
            return;
        }
        if (mod) return;

        if (e.key === 'Delete' || e.key === 'Backspace') {
            const ids = AppState.selectedPersonIds.size ? [...AppState.selectedPersonIds]
                : (AppState.selectedPersonId ? [AppState.selectedPersonId] : []);
            if (ids.length) { e.preventDefault(); deletePersons(ids); }
            return;
        }
        if (key === 'n') { e.preventDefault(); Forms.openPersonModal(); return; }
        if (key === 'f') { e.preventDefault(); TreeRenderer.fitToContent(); return; }
        if (key === '+' || key === '=') { e.preventDefault(); TreeRenderer.zoomBy(1.25); return; }
        if (key === '-') { e.preventDefault(); TreeRenderer.zoomBy(1 / 1.25); return; }
        if (key === 'e' && AppState.selectedPersonId) { e.preventDefault(); Forms.openPersonModal(AppState.selectedPersonId); }
    });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    applyTheme(currentTheme());
    Modal.init();
    initMenus();
    initContextMenu();
    initToolbar();
    initKeyboardShortcuts();
    initSettings();

    TreeRenderer.init();
    Forms.init();
    Exporter.init();
    loadSettings();

    loadTreeData({ fit: true });
});

window.AppState = AppState;
window.API = API;
window.showToast = showToast;
window.loadTreeData = loadTreeData;
window.showContextMenu = showContextMenu;
window.showPersonDetails = showPersonDetails;
