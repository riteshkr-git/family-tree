/**
 * Family Tree Builder - SVG renderer, pan/zoom and drag (pointer events).
 *
 * Geometry: (person.x, person.y) is the centre of the card. The avatar circle sits on the
 * card's top edge, half overlapping it. All sizes derive from nodeWidth and avatarSize.
 */
'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const DRAG_THRESHOLD = 4;

function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    return node;
}

const TreeRenderer = {
    svg: null,
    group: null,
    linesLayer: null,
    nodesLayer: null,
    container: null,

    transform: { x: 0, y: 0, scale: 1 },
    nodeWidth: 160,
    avatarSize: 44,
    nodeEls: new Map(),

    // interaction state
    pointers: new Map(),
    pan: null,
    drag: null,
    pinch: null,
    rafPending: false,
    lastClick: null,

    get avatarR() { return this.avatarSize / 2; },
    get cardHeight() { return this.avatarR + 52; },

    // ------------------------------------------------------------------ setup
    init() {
        this.svg = document.getElementById('tree-canvas');
        this.group = document.getElementById('canvas-group');
        this.linesLayer = document.getElementById('lines-layer');
        this.nodesLayer = document.getElementById('nodes-layer');
        this.container = document.getElementById('canvas-container');
        this.initPointer();
        this.centerView();
    },

    // --------------------------------------------------------------- geometry
    cardTop(p) { return p.y - this.cardHeight / 2; },
    cardBottom(p) { return p.y + this.cardHeight / 2; },
    nodeTop(p) { return this.cardTop(p) - this.avatarR; },

    nodeBox(p) {
        return {
            x: p.x - this.nodeWidth / 2,
            y: this.nodeTop(p),
            w: this.nodeWidth,
            h: this.cardHeight + this.avatarR
        };
    },

    contentBounds(ids = null) {
        const persons = ids ? ids.map(id => AppState.tree.persons[id]).filter(Boolean) : Object.values(AppState.tree.persons);
        if (persons.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of persons) {
            const b = this.nodeBox(p);
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.w);
            maxY = Math.max(maxY, b.y + b.h + 16); // room for marriage date badges
        }
        return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    },

    screenToWorld(clientX, clientY) {
        const rect = this.svg.getBoundingClientRect();
        return {
            x: (clientX - rect.left - this.transform.x) / this.transform.scale,
            y: (clientY - rect.top - this.transform.y) / this.transform.scale
        };
    },

    viewportCenterWorld() {
        const rect = this.container.getBoundingClientRect();
        return this.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    },

    /** Find a free spot near (x, y) that does not overlap existing cards. */
    findFreeSpot(x, y) {
        const w = this.nodeWidth + 24, h = this.cardHeight + this.avatarR + 24;
        const occupied = Object.values(AppState.tree.persons);
        const collides = (cx, cy) => occupied.some(p => Math.abs(p.x - cx) < w && Math.abs(p.y - cy) < h);
        if (!collides(x, y)) return { x, y };
        for (let ring = 1; ring < 20; ring++) {
            for (let i = -ring; i <= ring; i++) {
                for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
                    const cx = x + dx * w, cy = y + dy * h;
                    if (!collides(cx, cy)) return { x: cx, y: cy };
                }
            }
        }
        return { x: x + w * 20, y };
    },

    // ------------------------------------------------------------- transform
    applyTransform() {
        const t = this.transform;
        this.group.setAttribute('transform', `translate(${t.x} ${t.y}) scale(${t.scale})`);
        if (typeof updateZoomLabel === 'function') updateZoomLabel(t.scale);
    },

    setZoom(scale, clientX = null, clientY = null) {
        const rect = this.container.getBoundingClientRect();
        const px = clientX === null ? rect.width / 2 : clientX - rect.left;
        const py = clientY === null ? rect.height / 2 : clientY - rect.top;
        const next = Math.min(Math.max(scale, MIN_ZOOM), MAX_ZOOM);
        const ratio = next / this.transform.scale;
        this.transform.x = px - (px - this.transform.x) * ratio;
        this.transform.y = py - (py - this.transform.y) * ratio;
        this.transform.scale = next;
        this.applyTransform();
    },

    zoomBy(factor) {
        this.setZoom(this.transform.scale * factor);
    },

    centerView() {
        const rect = this.container.getBoundingClientRect();
        this.transform = { x: rect.width / 2, y: Math.min(160, rect.height / 3), scale: 1 };
        this.applyTransform();
    },

    fitToContent(padding = 60) {
        const b = this.contentBounds();
        if (!b) { this.centerView(); return; }
        const rect = this.container.getBoundingClientRect();
        const scale = Math.min(
            (rect.width - padding * 2) / b.width,
            (rect.height - padding * 2) / b.height,
            1.25
        );
        const s = Math.max(MIN_ZOOM, scale);
        this.transform = {
            scale: s,
            x: (rect.width - b.width * s) / 2 - b.minX * s,
            y: (rect.height - b.height * s) / 2 - b.minY * s
        };
        this.applyTransform();
    },

    panTo(personId) {
        const p = AppState.tree.persons[personId];
        if (!p) return;
        const rect = this.container.getBoundingClientRect();
        const s = this.transform.scale;
        this.transform.x = rect.width / 2 - p.x * s;
        this.transform.y = rect.height / 2 - p.y * s;
        this.applyTransform();
    },

    // ---------------------------------------------------------------- render
    render() {
        if (!this.nodesLayer) return;
        const persons = AppState.tree.persons;
        this.nodesLayer.replaceChildren();
        this.nodeEls.clear();
        for (const person of Object.values(persons)) this.drawNode(person);
        this.renderLines();
    },

    renderLines() {
        const { persons, marriages, parent_child } = AppState.tree;
        const frag = document.createDocumentFragment();
        const STEM = 22;

        // Group children by their anchor (a marriage, or a single parent) so each family shares one stem
        const families = new Map();
        for (const pc of parent_child) {
            const child = persons[pc.child_id];
            const parent = persons[pc.parent_id];
            if (!child || !parent) continue;
            const m = pc.marriage_id ? marriages[pc.marriage_id] : null;
            const a = m && persons[m.spouse1_id], b = m && persons[m.spouse2_id];
            let key, anchor;
            if (m && a && b) {
                key = `m:${m.id}`;
                anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, bottom: Math.max(this.cardBottom(a), this.cardBottom(b)), couple: 2 };
            } else {
                key = `p:${parent.id}`;
                anchor = { x: parent.x, y: parent.y, bottom: this.cardBottom(parent), couple: 1 };
            }
            if (!families.has(key)) families.set(key, { anchor, children: new Map() });
            families.get(key).children.set(child.id, child);
        }

        for (const { anchor, children } of families.values()) {
            const sideways = [...children.values()].every(c => Math.abs(c.x - anchor.x) > Math.abs(c.y - anchor.y) + this.cardHeight);
            if (sideways) {
                for (const child of children.values()) frag.append(this.sidePath(anchor, child));
                continue;
            }
            // Vertical stem from the couple's connector (or the parent's card) down to a branch point
            const stemTop = anchor.couple === 2 ? anchor.y : anchor.bottom;
            const branchY = anchor.bottom + STEM;
            frag.append(svgEl('path', { d: `M ${anchor.x} ${stemTop} L ${anchor.x} ${branchY}`, class: 'child-line' }));
            for (const child of children.values()) {
                const ex = child.x, ey = this.nodeTop(child) - 2;
                const my = (branchY + ey) / 2;
                frag.append(svgEl('path', { d: `M ${anchor.x} ${branchY} C ${anchor.x} ${my}, ${ex} ${my}, ${ex} ${ey}`, class: 'child-line' }));
            }
        }

        for (const m of Object.values(marriages)) {
            const a = persons[m.spouse1_id], b = persons[m.spouse2_id];
            if (!a || !b) continue;
            const attrs = { x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'data-marriage-id': m.id };
            const hit = svgEl('line', { ...attrs, class: 'marriage-hit' });
            const line = svgEl('line', { ...attrs, class: 'marriage-line' });
            hit.addEventListener('click', () => Forms.openEditMarriageModal(m.id));
            frag.append(hit, line);

            if (m.marriage_date) {
                const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
                const label = `⚭ ${m.marriage_date}`;
                const w = Math.max(34, label.length * 6.2 + 12);
                const badge = svgEl('g', { class: 'marriage-badge', transform: `translate(${midX} ${midY})` });
                badge.append(
                    svgEl('rect', { x: -w / 2, y: -9, width: w, height: 18, rx: 9 }),
                    svgEl('text', { x: 0, y: 0.5 })
                );
                badge.lastChild.textContent = label;
                badge.addEventListener('click', () => Forms.openEditMarriageModal(m.id));
                frag.append(badge);
            }
        }

        this.linesLayer.replaceChildren(frag);
    },

    /** Left-right layouts: leave from the side of the anchor and enter the side of the child. */
    sidePath(anchor, child) {
        const dir = Math.sign(child.x - anchor.x) || 1;
        const sx = anchor.couple === 2 ? anchor.x : anchor.x + dir * this.nodeWidth / 2;
        const sy = anchor.y;
        const ex = child.x - dir * this.nodeWidth / 2;
        const ey = child.y;
        const mx = (sx + ex) / 2;
        return svgEl('path', { d: `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`, class: 'child-line' });
    },

    nodeTransform(p) {
        const b = this.nodeBox(p);
        return `translate(${b.x} ${b.y})`;
    },

    maxNameChars() {
        const fontSize = AppState.settings?.fontSize || 13;
        return Math.max(6, Math.floor((this.nodeWidth - 20) / (fontSize * 0.56)));
    },

    truncate(text, max) {
        const chars = [...String(text)];
        return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…';
    },

    drawNode(person) {
        const w = this.nodeWidth, R = this.avatarR, h = this.cardHeight;
        const selected = AppState.selectedPersonIds.has(person.id);

        const g = svgEl('g', {
            class: `node ${person.gender || 'unknown'}${selected ? ' selected' : ''}`,
            'data-person-id': person.id,
            transform: this.nodeTransform(person)
        });

        const title = svgEl('title');
        title.textContent = [person.name, lifeSpan(person)].filter(Boolean).join('\n');
        g.append(title);

        g.append(svgEl('rect', { class: 'node-card', x: 0, y: R, width: w, height: h, rx: 12 }));
        g.append(svgEl('circle', { class: 'node-ring', cx: w / 2, cy: R, r: R }));

        const url = photoUrl(person);
        if (url) {
            const clipId = `clip-${person.id}`;
            const clip = svgEl('clipPath', { id: clipId });
            clip.append(svgEl('circle', { cx: w / 2, cy: R, r: R - 2 }));
            g.append(clip);
            const img = svgEl('image', {
                x: w / 2 - R, y: 0, width: 2 * R, height: 2 * R,
                href: url, preserveAspectRatio: 'xMidYMid slice', 'clip-path': `url(#${clipId})`
            });
            img.addEventListener('error', () => {
                img.remove();
                this.appendInitials(g, person);
            });
            g.append(img);
        } else {
            this.appendInitials(g, person);
        }

        const name = svgEl('text', { class: 'node-name', x: w / 2, y: 2 * R + 22 });
        name.textContent = this.truncate(person.name, this.maxNameChars());
        g.append(name);

        const span = lifeSpan(person);
        if (span) {
            const dates = svgEl('text', { class: 'node-dates', x: w / 2, y: 2 * R + 40 });
            dates.textContent = this.truncate(span, this.maxNameChars() + 4);
            g.append(dates);
        }

        this.nodesLayer.append(g);
        this.nodeEls.set(person.id, g);
    },

    appendInitials(g, person) {
        const t = svgEl('text', { class: 'node-initials', x: this.nodeWidth / 2, y: this.avatarR });
        t.textContent = initials(person.name);
        t.style.fontSize = `${Math.max(10, Math.round(this.avatarR * 0.72))}px`;
        g.append(t);
    },

    updateSelection() {
        for (const [id, g] of this.nodeEls) {
            g.classList.toggle('selected', AppState.selectedPersonIds.has(id));
        }
    },

    /** Cheap in-place update used during drag: move node groups and redraw connectors. */
    moveNodes(ids) {
        for (const id of ids) {
            const p = AppState.tree.persons[id];
            const g = this.nodeEls.get(id);
            if (p && g) g.setAttribute('transform', this.nodeTransform(p));
        }
        this.renderLines();
    },

    // ----------------------------------------------------------- interaction
    initPointer() {
        const svg = this.svg;

        this.container.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
            this.setZoom(this.transform.scale * factor, e.clientX, e.clientY);
        }, { passive: false });

        svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
        svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
        svg.addEventListener('pointercancel', (e) => this.onPointerUp(e));

        svg.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const node = e.target.closest('.node');
            if (!node) return;
            const id = node.dataset.personId;
            if (!AppState.selectedPersonIds.has(id)) setSelection([id], id);
            showContextMenu(e.clientX, e.clientY, id);
        });

        window.addEventListener('resize', () => this.applyTransform());
    },

    onPointerDown(e) {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        hideContextMenu();
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this.pointers.size === 2) {
            this.svg.setPointerCapture(e.pointerId);
            // Second finger: switch to pinch, abandon any pan/drag in progress
            if (this.drag) this.cancelDrag();
            this.pan = null;
            const [a, b] = [...this.pointers.values()];
            this.pinch = {
                startDist: Math.hypot(a.x - b.x, a.y - b.y),
                startScale: this.transform.scale,
                lastMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
            };
            this.svg.classList.remove('panning');
            return;
        }
        if (this.pointers.size > 2) return;

        // Marriage lines and badges rely on ordinary click events, so no capture for them.
        // Capturing the pointer retargets the click/dblclick to the <svg>, which is why
        // double-click is detected manually in finishDrag() instead of via a dblclick listener.
        if (e.target.closest('.marriage-hit, .marriage-badge')) {
            this.pointers.delete(e.pointerId);
            return;
        }
        this.svg.setPointerCapture(e.pointerId);

        const nodeEl = e.target.closest('.node');
        if (nodeEl) {
            this.beginDrag(nodeEl.dataset.personId, e);
            return;
        }

        // Background: pan (and clear selection unless extending it)
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) clearSelection();
        this.pan = { startX: e.clientX - this.transform.x, startY: e.clientY - this.transform.y };
        this.svg.classList.add('panning');
    },

    onPointerMove(e) {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (this.pinch && this.pointers.size >= 2) {
            const [a, b] = [...this.pointers.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            // Pan by the midpoint movement, then zoom about the midpoint
            this.transform.x += mid.x - this.pinch.lastMid.x;
            this.transform.y += mid.y - this.pinch.lastMid.y;
            this.pinch.lastMid = mid;
            this.setZoom(this.pinch.startScale * (dist / this.pinch.startDist), mid.x, mid.y);
            return;
        }

        if (this.drag) {
            this.updateDrag(e);
            return;
        }

        if (this.pan) {
            this.transform.x = e.clientX - this.pan.startX;
            this.transform.y = e.clientY - this.pan.startY;
            this.applyTransform();
        }
    },

    onPointerUp(e) {
        this.pointers.delete(e.pointerId);
        if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);

        if (this.pinch) {
            if (this.pointers.size < 2) this.pinch = null;
            return;
        }
        if (this.drag) {
            this.finishDrag(e);
            return;
        }
        if (this.pan) {
            this.pan = null;
            this.svg.classList.remove('panning');
        }
    },

    // ------------------------------------------------------------------ drag
    beginDrag(personId, e) {
        const additive = e.ctrlKey || e.metaKey || e.shiftKey;
        if (additive) {
            const ids = new Set(AppState.selectedPersonIds);
            if (ids.has(personId)) ids.delete(personId); else ids.add(personId);
            setSelection([...ids], personId);
        } else if (!AppState.selectedPersonIds.has(personId)) {
            setSelection([personId], personId);
        }

        const start = this.screenToWorld(e.clientX, e.clientY);
        const ids = AppState.selectedPersonIds.has(personId) ? [...AppState.selectedPersonIds] : [personId];
        this.drag = {
            personId,
            additive,
            moved: false,
            start,
            ids,
            origin: new Map(ids.map(id => [id, { x: AppState.tree.persons[id].x, y: AppState.tree.persons[id].y }])),
            last: null
        };
    },

    updateDrag(e) {
        const d = this.drag;
        const now = this.screenToWorld(e.clientX, e.clientY);
        const dx = now.x - d.start.x, dy = now.y - d.start.y;
        if (!d.moved && Math.hypot(dx, dy) * this.transform.scale < DRAG_THRESHOLD) return;
        d.moved = true;
        d.last = { dx, dy };
        if (this.rafPending) return;
        this.rafPending = true;
        requestAnimationFrame(() => {
            this.rafPending = false;
            if (!this.drag || !this.drag.last) return;
            for (const id of this.drag.ids) {
                const p = AppState.tree.persons[id];
                const o = this.drag.origin.get(id);
                if (p && o) { p.x = o.x + this.drag.last.dx; p.y = o.y + this.drag.last.dy; }
            }
            this.moveNodes(this.drag.ids);
        });
    },

    cancelDrag() {
        const d = this.drag;
        if (!d) return;
        for (const [id, o] of d.origin) {
            const p = AppState.tree.persons[id];
            if (p) { p.x = o.x; p.y = o.y; }
        }
        this.moveNodes(d.ids);
        this.drag = null;
    },

    async finishDrag(e) {
        const d = this.drag;
        this.drag = null;
        if (!d) return;

        if (!d.moved) {
            if (d.additive) return;
            const now = performance.now();
            const last = this.lastClick;
            this.lastClick = { id: d.personId, t: now };
            if (last && last.id === d.personId && now - last.t < 350) {
                this.lastClick = null;
                Forms.openPersonModal(d.personId);
            } else {
                showPersonDetails(d.personId);
            }
            return;
        }

        // Apply the final delta synchronously in case the last frame has not run
        if (d.last) {
            for (const id of d.ids) {
                const p = AppState.tree.persons[id];
                const o = d.origin.get(id);
                if (p && o) { p.x = o.x + d.last.dx; p.y = o.y + d.last.dy; }
            }
            this.moveNodes(d.ids);
        }
        const updates = d.ids.map(id => AppState.tree.persons[id]).filter(Boolean).map(p => ({ id: p.id, x: p.x, y: p.y }));
        if (updates.length === 0) return;
        try {
            await API.updatePositions(updates);
        } catch (error) {
            console.error('Failed to save positions:', error);
            showToast('Could not save the new positions', 'error');
        }
    }
};

window.TreeRenderer = TreeRenderer;
