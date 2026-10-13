/**
 * Family Tree Builder - modal forms: person, spouse, child, marriage, auto-arrange.
 */
'use strict';

const PHOTO_MAX_EDGE = 512;

/** Downscale an image file in the browser so uploads and JSON exports stay small. */
async function resizeImage(file, maxEdge = PHOTO_MAX_EDGE, quality = 0.86) {
    let source;
    try {
        source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
        source = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('That file is not a readable image'));
            img.src = URL.createObjectURL(file);
        });
    }
    const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, w, h);
    if (source.close) source.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('Could not process the image');
    return blob;
}

function radioValue(scope, name, fallback = 'unknown') {
    return scope.querySelector(`input[name="${name}"]:checked`)?.value || fallback;
}

function setRadio(scope, name, value) {
    const input = scope.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
}

function withBusy(button, fn) {
    return async (...args) => {
        if (button.disabled) return;
        button.disabled = true;
        try {
            await fn(...args);
        } finally {
            button.disabled = false;
        }
    };
}

const Forms = {
    photoFile: null,
    photoRemoved: false,

    init() {
        this.initPersonModal();
        this.initSpouseModal();
        this.initChildModal();
        this.initLayoutModal();
        this.initEditMarriageModal();
    },

    // ==================== Person ====================

    initPersonModal() {
        const modal = $('person-modal');
        const photoInput = $('person-photo');
        const saveBtn = $('person-save-btn');

        saveBtn.addEventListener('click', withBusy(saveBtn, () => this.savePerson()));
        $('person-form').addEventListener('submit', (e) => { e.preventDefault(); saveBtn.click(); });

        photoInput.addEventListener('change', async () => {
            const file = photoInput.files[0];
            if (!file) return;
            try {
                this.photoFile = await resizeImage(file);
                this.photoRemoved = false;
                const preview = $('photo-preview');
                preview.replaceChildren(el('img', { src: URL.createObjectURL(this.photoFile), alt: '' }));
            } catch (error) {
                showToast(error.message, 'error');
            } finally {
                photoInput.value = '';
            }
        });

        $('photo-remove-btn').addEventListener('click', () => {
            this.photoFile = null;
            this.photoRemoved = true;
            this.renderPhotoPreview(null, $('person-name').value);
        });

        $('person-name').addEventListener('input', (e) => {
            if (!this.photoFile && !$('photo-preview').querySelector('img')) {
                $('photo-preview').textContent = initials(e.target.value) || '?';
            }
        });
        modal.querySelectorAll('input[name="gender"]').forEach(r => r.addEventListener('change', () => {
            $('photo-preview').className = `avatar ${r.value}`;
        }));
    },

    renderPhotoPreview(url, name, gender = 'unknown') {
        const preview = $('photo-preview');
        preview.className = `avatar ${gender}`;
        if (url) preview.replaceChildren(el('img', { src: url, alt: '' }));
        else preview.textContent = initials(name) || '?';
    },

    openPersonModal(personId = null) {
        const modal = $('person-modal');
        const form = $('person-form');
        form.reset();
        this.photoFile = null;
        this.photoRemoved = false;
        $('person-id').value = '';

        const person = personId ? AppState.tree.persons[personId] : null;
        if (person) {
            $('person-modal-title').textContent = 'Edit person';
            $('person-id').value = person.id;
            $('person-name').value = person.name;
            $('person-dob').value = person.date_of_birth || '';
            $('person-dod').value = person.date_of_death || '';
            $('person-notes').value = person.notes || '';
            setRadio(form, 'gender', person.gender || 'unknown');
            this.renderPhotoPreview(photoUrl(person), person.name, person.gender);
        } else {
            $('person-modal-title').textContent = 'Add person';
            setRadio(form, 'gender', 'unknown');
            this.renderPhotoPreview(null, '', 'unknown');
        }
        Modal.open('person-modal');
    },

    async savePerson() {
        const form = $('person-form');
        const personId = $('person-id').value;
        const name = $('person-name').value.trim();
        if (!name) {
            showToast('A name is required', 'error');
            $('person-name').focus();
            return;
        }

        const data = {
            name,
            gender: radioValue(form, 'gender'),
            date_of_birth: $('person-dob').value.trim() || null,
            date_of_death: $('person-dod').value.trim() || null,
            notes: $('person-notes').value.trim() || null
        };

        try {
            if (this.photoFile) {
                const result = await API.uploadPhoto(this.photoFile);
                data.photo_path = result.path;
            } else if (this.photoRemoved || !personId) {
                data.photo_path = null;
            } else {
                data.photo_path = AppState.tree.persons[personId]?.photo_path || null;
            }

            if (personId) {
                await API.updatePerson(personId, data);
                Modal.close('person-modal');
                await loadTreeData();
                showToast('Person updated', 'success');
            } else {
                const centre = personCount() ? TreeRenderer.viewportCenterWorld() : { x: 0, y: 0 };
                const spot = TreeRenderer.findFreeSpot(centre.x, centre.y);
                data.x = spot.x;
                data.y = spot.y;
                const created = await API.createPerson(data);
                Modal.close('person-modal');
                await loadTreeData();
                if (personCount() === 1) TreeRenderer.fitToContent();
                showPersonDetails(created.id);
                showToast('Person added', 'success');
            }
        } catch (error) {
            showToast(error.message || 'Could not save', 'error');
        }
    },

    // ==================== Spouse ====================

    initSpouseModal() {
        const saveBtn = $('spouse-save-btn');
        saveBtn.addEventListener('click', withBusy(saveBtn, () => this.saveSpouse()));
        $('spouse-modal').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); saveBtn.click(); }
        });
    },

    openSpouseModal(personId) {
        const modal = $('spouse-modal');
        const person = AppState.tree.persons[personId];
        if (!person) return;

        $('spouse-for-name').textContent = person.name;
        modal.dataset.personId = personId;
        for (const id of ['new-spouse-name', 'spouse-dob', 'spouse-dod', 'spouse-notes', 'marriage-date']) $(id).value = '';
        const opposite = person.gender === 'male' ? 'female' : person.gender === 'female' ? 'male' : 'unknown';
        setRadio(modal, 'spouse-gender', opposite);
        Modal.open('spouse-modal');
    },

    async saveSpouse() {
        const modal = $('spouse-modal');
        const personId = modal.dataset.personId;
        const person = AppState.tree.persons[personId];
        if (!person) return;

        const name = $('new-spouse-name').value.trim();
        if (!name) {
            showToast('Enter the spouse\'s name', 'error');
            $('new-spouse-name').focus();
            return;
        }

        // Place beside the person (after any existing spouses), then push everything to the right
        // on this row and below out of the way.
        const spacing = TreeRenderer.nodeWidth + 64;
        let baseX = person.x;
        for (const m of Object.values(AppState.tree.marriages)) {
            const other = m.spouse1_id === personId ? m.spouse2_id : m.spouse2_id === personId ? m.spouse1_id : null;
            const s = other && AppState.tree.persons[other];
            if (s && Math.abs(s.y - person.y) < TreeRenderer.cardHeight && s.x > baseX) baseX = s.x;
        }
        const spouseX = baseX + spacing;
        const spouseY = person.y;
        const rowTop = person.y - TreeRenderer.cardHeight / 2;
        const shifted = Object.values(AppState.tree.persons)
            .filter(p => p.x >= spouseX - spacing / 2 && p.y >= rowTop)
            .map(p => ({ id: p.id, x: p.x + spacing, y: p.y }));

        try {
            const spouse = await API.createPerson({
                name,
                gender: radioValue(modal, 'spouse-gender'),
                x: spouseX,
                y: spouseY,
                date_of_birth: $('spouse-dob').value.trim() || null,
                date_of_death: $('spouse-dod').value.trim() || null,
                notes: $('spouse-notes').value.trim() || null
            });
            await API.createMarriage(personId, spouse.id, $('marriage-date').value.trim() || null);
            if (shifted.length) await API.updatePositions(shifted);
            Modal.close('spouse-modal');
            await loadTreeData();
            showToast('Spouse added', 'success');
        } catch (error) {
            showToast(error.message || 'Could not add spouse', 'error');
            await loadTreeData();
        }
    },

    // ==================== Child ====================

    initChildModal() {
        const saveBtn = $('child-save-btn');
        saveBtn.addEventListener('click', withBusy(saveBtn, () => this.saveChild()));
        $('child-modal').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); saveBtn.click(); }
        });
    },

    openChildModal(personId) {
        const modal = $('child-modal');
        const person = AppState.tree.persons[personId];
        if (!person) return;

        $('child-for-name').textContent = person.name;
        modal.dataset.personId = personId;
        for (const id of ['new-child-name', 'child-dob', 'child-dod', 'child-notes']) $(id).value = '';
        setRadio(modal, 'child-gender', 'unknown');

        const select = $('child-marriage');
        select.replaceChildren(el('option', { value: '', text: `${person.name} only` }));
        const marriages = Object.values(AppState.tree.marriages).filter(m => m.spouse1_id === personId || m.spouse2_id === personId);
        for (const m of marriages) {
            const spouse = AppState.tree.persons[m.spouse1_id === personId ? m.spouse2_id : m.spouse1_id];
            if (spouse) select.append(el('option', { value: m.id, text: spouse.name }));
        }
        if (marriages.length >= 1) select.value = marriages[0].id;
        Modal.open('child-modal');
    },

    async saveChild() {
        const modal = $('child-modal');
        const parentId = modal.dataset.personId;
        const parent = AppState.tree.persons[parentId];
        if (!parent) return;

        const name = $('new-child-name').value.trim();
        if (!name) {
            showToast('Enter the child\'s name', 'error');
            $('new-child-name').focus();
            return;
        }
        const marriageId = $('child-marriage').value || null;
        const marriage = marriageId ? AppState.tree.marriages[marriageId] : null;

        // Anchor under the parent (or the couple's midpoint); line up with existing siblings
        let anchorX = parent.x, anchorY = parent.y;
        const parentIds = [parentId];
        if (marriage) {
            const a = AppState.tree.persons[marriage.spouse1_id], b = AppState.tree.persons[marriage.spouse2_id];
            if (a && b) {
                anchorX = (a.x + b.x) / 2;
                anchorY = Math.max(a.y, b.y);
                parentIds.splice(0, 1, marriage.spouse1_id, marriage.spouse2_id);
            }
        }
        const siblings = AppState.tree.parent_child
            .filter(pc => parentIds.includes(pc.parent_id) && (!marriageId || !pc.marriage_id || pc.marriage_id === marriageId))
            .map(pc => AppState.tree.persons[pc.child_id]).filter(Boolean);

        const rowGap = TreeRenderer.cardHeight + TreeRenderer.avatarR + 90;
        let childX, childY;
        if (siblings.length === 0) {
            childX = anchorX;
            childY = anchorY + rowGap;
        } else {
            childX = Math.max(...siblings.map(s => s.x)) + TreeRenderer.nodeWidth + 40;
            childY = siblings[0].y;
        }
        const spot = TreeRenderer.findFreeSpot(childX, childY);

        try {
            const child = await API.createPerson({
                name,
                gender: radioValue(modal, 'child-gender'),
                x: spot.x,
                y: spot.y,
                date_of_birth: $('child-dob').value.trim() || null,
                date_of_death: $('child-dod').value.trim() || null,
                notes: $('child-notes').value.trim() || null
            });
            await API.addChild(parentId, child.id, marriageId);
            if (marriage) {
                const otherId = marriage.spouse1_id === parentId ? marriage.spouse2_id : marriage.spouse1_id;
                try { await API.addChild(otherId, child.id, marriageId); } catch (e) { /* already linked */ }
            }
            Modal.close('child-modal');
            await loadTreeData();
            showToast('Child added', 'success');
        } catch (error) {
            showToast(error.message || 'Could not add child', 'error');
            await loadTreeData();
        }
    },

    // ==================== Auto arrange ====================

    initLayoutModal() {
        const applyBtn = $('layout-apply-btn');
        applyBtn.addEventListener('click', withBusy(applyBtn, () => this.applyLayout()));
        $('layout-search').addEventListener('input', () => this.renderLayoutList());
    },

    layoutRootId: null,

    renderLayoutList() {
        const list = $('layout-person-list');
        const q = $('layout-search').value.trim().toLowerCase();
        const people = Object.values(AppState.tree.persons)
            .filter(p => !q || p.name.toLowerCase().includes(q))
            .sort((a, b) => a.name.localeCompare(b.name));
        list.replaceChildren(...people.map(p => {
            const item = el('button', { className: `pick-item${p.id === this.layoutRootId ? ' selected' : ''}`, type: 'button' },
                avatarEl(p), el('span', { text: p.name }));
            item.addEventListener('click', () => {
                this.layoutRootId = p.id;
                list.querySelectorAll('.pick-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                $('layout-apply-btn').disabled = false;
            });
            return item;
        }));
        if (people.length === 0) list.append(el('div', { className: 'form-hint', style: 'padding: 10px', text: 'No matches' }));
    },

    openLayoutModal() {
        this.layoutRootId = AppState.selectedPersonId && AppState.tree.persons[AppState.selectedPersonId]
            ? AppState.selectedPersonId : null;
        $('layout-search').value = '';
        $('layout-apply-btn').disabled = !this.layoutRootId;
        this.renderLayoutList();
        Modal.open('layout-modal');
    },

    async applyLayout() {
        if (!this.layoutRootId) return;
        const direction = radioValue($('layout-modal'), 'layout-direction', 'top-down');
        const spacingX = TreeRenderer.nodeWidth + 64;
        const spacingY = TreeRenderer.cardHeight + TreeRenderer.avatarR + 90;
        try {
            await API.autoLayout(this.layoutRootId, direction, spacingX, spacingY);
            Modal.close('layout-modal');
            await loadTreeData({ fit: true });
            showToast('Tree arranged', 'success');
        } catch (error) {
            showToast(error.message || 'Could not arrange the tree', 'error');
        }
    },

    // ==================== Marriage ====================

    initEditMarriageModal() {
        const saveBtn = $('edit-marriage-save-btn');
        saveBtn.addEventListener('click', withBusy(saveBtn, () => this.saveMarriage()));
        $('edit-marriage-date').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
        });
        $('edit-marriage-delete-btn').addEventListener('click', () => this.deleteMarriage());
    },

    openEditMarriageModal(marriageId) {
        const modal = $('edit-marriage-modal');
        const m = AppState.tree.marriages[marriageId];
        if (!m) return;
        const a = AppState.tree.persons[m.spouse1_id], b = AppState.tree.persons[m.spouse2_id];
        if (!a || !b) return;
        modal.dataset.marriageId = marriageId;
        $('marriage-spouses').textContent = `${a.name} & ${b.name}`;
        $('edit-marriage-date').value = m.marriage_date || '';
        Modal.open('edit-marriage-modal');
    },

    async saveMarriage() {
        const marriageId = $('edit-marriage-modal').dataset.marriageId;
        try {
            await API.updateMarriage(marriageId, { marriage_date: $('edit-marriage-date').value.trim() || null });
            Modal.close('edit-marriage-modal');
            await loadTreeData();
            showToast('Marriage updated', 'success');
        } catch (error) {
            showToast(error.message || 'Could not update the marriage', 'error');
        }
    },

    async deleteMarriage() {
        const marriageId = $('edit-marriage-modal').dataset.marriageId;
        const ok = await confirmDialog({
            title: 'Remove this marriage?',
            message: 'Both people stay in the tree. Children keep their parent links. You can undo this.',
            confirmText: 'Remove',
            danger: true
        });
        if (!ok) return;
        try {
            await API.deleteMarriage(marriageId);
            Modal.close('edit-marriage-modal');
            await loadTreeData();
            showToast('Marriage removed', 'success');
        } catch (error) {
            showToast(error.message || 'Could not remove the marriage', 'error');
        }
    }
};

window.Forms = Forms;
