/**
 * Family Tree Builder - browser-side export of the canvas to PNG, JPG or PDF.
 *
 * The on-screen SVG is cloned into a standalone document with resolved theme colours,
 * embedded photos (as data URLs) and, where possible, the embedded web font, then rasterised
 * through an <img> + <canvas>. PDF wraps the raster with jsPDF, loaded on demand.
 */
'use strict';

const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const MAX_CANVAS_PIXELS = 24_000_000;
const EXPORT_PADDING = 48;

const GOOGLE_FONTS = ['Inter', 'Poppins', 'Noto Sans Devanagari', 'Noto Sans', 'Mukta', 'Hind'];

const Exporter = {
    fontCssCache: new Map(),
    jsPdfPromise: null,

    init() {
        const modal = $('export-modal');
        modal.querySelectorAll('input[name="export-format"]').forEach(r => r.addEventListener('change', () => this.syncOptions()));
        $('export-scale').addEventListener('change', () => this.updateSizeHint());
        $('export-save-btn').addEventListener('click', withBusy($('export-save-btn'), () => this.run()));
    },

    open() {
        if (personCount() === 0) { showToast('Add some people first', 'info'); return; }
        this.syncOptions();
        Modal.open('export-modal');
    },

    format() {
        return radioValue($('export-modal'), 'export-format', 'png');
    },

    syncOptions() {
        const f = this.format();
        $('pdf-options').classList.toggle('hidden', f !== 'pdf');
        const transparent = $('export-bg-transparent');
        transparent.disabled = f !== 'png';
        transparent.parentElement.style.opacity = f !== 'png' ? 0.45 : 1;
        if (f !== 'png' && transparent.checked) setRadio($('export-modal'), 'export-bg', 'solid');
        this.updateSizeHint();
    },

    updateSizeHint() {
        const b = TreeRenderer.contentBounds();
        if (!b) return;
        const scale = this.effectiveScale(b);
        const w = Math.round((b.width + EXPORT_PADDING * 2) * scale);
        const h = Math.round((b.height + EXPORT_PADDING * 2) * scale);
        $('export-size-hint').textContent = `${w} × ${h} px`;
    },

    effectiveScale(bounds) {
        const requested = parseFloat($('export-scale').value) || 2;
        const w = bounds.width + EXPORT_PADDING * 2, h = bounds.height + EXPORT_PADDING * 2;
        const maxScale = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
        return Math.min(requested, maxScale);
    },

    // ------------------------------------------------------------------ build
    async buildSvg({ background }) {
        const b = TreeRenderer.contentBounds();
        const minX = b.minX - EXPORT_PADDING, minY = b.minY - EXPORT_PADDING;
        const width = b.width + EXPORT_PADDING * 2, height = b.height + EXPORT_PADDING * 2;

        const svg = svgEl('svg', {
            xmlns: 'http://www.w3.org/2000/svg',
            'xmlns:xlink': 'http://www.w3.org/1999/xlink',
            width, height, viewBox: `${minX} ${minY} ${width} ${height}`
        });

        const style = svgEl('style');
        style.textContent = (await this.fontCss()) + this.nodeCss();
        svg.append(style);

        if (background) svg.append(svgEl('rect', { x: minX, y: minY, width, height, fill: background }));

        const lines = TreeRenderer.linesLayer.cloneNode(true);
        const nodes = TreeRenderer.nodesLayer.cloneNode(true);
        lines.removeAttribute('id');
        nodes.removeAttribute('id');
        nodes.querySelectorAll('title').forEach(t => t.remove());
        await this.inlineImages(nodes);
        svg.append(lines, nodes);

        return { svg, width, height };
    },

    async inlineImages(root) {
        const images = [...root.querySelectorAll('image')];
        await Promise.all(images.map(async (img) => {
            const href = img.getAttribute('href');
            try {
                const dataUrl = await this.toDataUrl(href);
                img.setAttribute('href', dataUrl);
                img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', dataUrl);
            } catch (e) {
                img.remove();
            }
        }));
    },

    async toDataUrl(url) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`fetch ${url}`);
        const blob = await res.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    },

    /** The subset of styles.css that applies to SVG content, with theme tokens resolved. */
    nodeCss() {
        const v = (name) => cssVar(name);
        const font = AppState.settings.fontFamily;
        const size = AppState.settings.fontSize;
        return `
            text { font-family: ${font}; }
            .node-card { fill: ${v('--node-bg')}; stroke: ${v('--unknown-ring')}; stroke-width: 1.5; }
            .node.male .node-card { fill: ${v('--male')}; stroke: ${v('--male-ring')}; }
            .node.female .node-card { fill: ${v('--female')}; stroke: ${v('--female-ring')}; }
            .node.unknown .node-card { fill: ${v('--unknown')}; stroke: ${v('--unknown-ring')}; }
            .node-ring { fill: ${v('--node-bg')}; stroke: ${v('--unknown-ring')}; stroke-width: 2; }
            .node.male .node-ring { stroke: ${v('--male-ring')}; }
            .node.female .node-ring { stroke: ${v('--female-ring')}; }
            .node-initials { font-size: 14px; font-weight: 600; fill: ${v('--unknown-ring')}; text-anchor: middle; dominant-baseline: central; }
            .node.male .node-initials { fill: ${v('--male-ring')}; }
            .node.female .node-initials { fill: ${v('--female-ring')}; }
            .node-name { font-size: ${size}px; font-weight: 600; fill: ${v('--node-text')}; text-anchor: middle; }
            .node-dates { font-size: ${size - 2}px; fill: ${v('--node-text-2')}; text-anchor: middle; }
            .marriage-line { stroke: ${v('--marriage-line')}; stroke-width: 2.5; }
            .marriage-hit { stroke: none; } .marriage-line { pointer-events: none; }
            .marriage-badge rect { fill: ${v('--surface')}; stroke: ${v('--border-strong')}; stroke-width: 1; }
            .marriage-badge text { font-size: 10.5px; fill: ${v('--text-2')}; text-anchor: middle; dominant-baseline: central; }
            .child-line { stroke: ${v('--line')}; stroke-width: 1.6; fill: none; }
        `;
    },

    /** Embed the selected Google font as data-URL @font-face rules so it renders inside the export. */
    async fontCss() {
        const family = GOOGLE_FONTS.find(f => AppState.settings.fontFamily.includes(f));
        if (!family) return '';
        if (this.fontCssCache.has(family)) return this.fontCssCache.get(family);

        const promise = (async () => {
            try {
                const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;600&display=swap`;
                const css = await (await fetch(cssUrl)).text();
                const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))];
                const replacements = await Promise.all(urls.map(async (u) => [u, await this.toDataUrl(u)]));
                let out = css;
                for (const [u, data] of replacements) out = out.split(u).join(data);
                return out;
            } catch (e) {
                console.warn('Font embedding skipped:', e);
                return '';
            }
        })();
        this.fontCssCache.set(family, promise);
        return promise;
    },

    // ------------------------------------------------------------- rasterise
    async rasterise(svg, width, height, scale, fill = null) {
        const xml = new XMLSerializer().serializeToString(svg);
        const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        try {
            const img = await new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error('The browser could not render the drawing'));
                image.src = url;
            });
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(width * scale);
            canvas.height = Math.round(height * scale);
            const ctx = canvas.getContext('2d');
            if (fill) {
                ctx.fillStyle = fill;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return canvas;
        } finally {
            URL.revokeObjectURL(url);
        }
    },

    canvasToBlob(canvas, type, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('Image encoding failed')), type, quality);
        });
    },

    loadJsPdf() {
        if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
        if (!this.jsPdfPromise) {
            this.jsPdfPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = JSPDF_URL;
                script.async = true;
                script.onload = () => window.jspdf?.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error('PDF library failed to load'));
                script.onerror = () => { this.jsPdfPromise = null; reject(new Error('Could not load the PDF library (offline?)')); };
                document.head.append(script);
            });
        }
        return this.jsPdfPromise;
    },

    // ------------------------------------------------------------------- run
    async run() {
        const format = this.format();
        const transparent = radioValue($('export-modal'), 'export-bg', 'solid') === 'transparent' && format === 'png';
        const bg = transparent ? null : cssVar('--bg');
        const stamp = todayStamp();

        try {
            updateStatus('Exporting…');
            const { svg, width, height } = await this.buildSvg({ background: bg });
            const b = TreeRenderer.contentBounds();
            const scale = this.effectiveScale(b);

            if (format === 'pdf') {
                const jsPDF = await this.loadJsPdf();
                const orientation = radioValue($('export-modal'), 'pdf-orientation', 'landscape');
                const doc = new jsPDF({ orientation, unit: 'pt', format: $('pdf-size').value, compress: true });
                const pageW = doc.internal.pageSize.getWidth();
                const pageH = doc.internal.pageSize.getHeight();
                const margin = 28;
                const fit = Math.min((pageW - margin * 2) / width, (pageH - margin * 2) / height);
                const drawW = width * fit, drawH = height * fit;
                // Render at roughly 2 device pixels per PDF point for crisp output, within the canvas budget
                const pdfScale = Math.min(scale, Math.max(1, (drawW * 2) / width));
                const canvas = await this.rasterise(svg, width, height, pdfScale, bg || '#ffffff');
                doc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG',
                    (pageW - drawW) / 2, (pageH - drawH) / 2, drawW, drawH, undefined, 'FAST');
                doc.save(`family-tree-${stamp}.pdf`);
            } else {
                const canvas = await this.rasterise(svg, width, height, scale, format === 'jpg' ? (bg || '#ffffff') : null);
                const blob = format === 'jpg'
                    ? await this.canvasToBlob(canvas, 'image/jpeg', 0.92)
                    : await this.canvasToBlob(canvas, 'image/png');
                downloadBlob(blob, `family-tree-${stamp}.${format}`);
            }
            Modal.close('export-modal');
            showToast(`Exported as ${format.toUpperCase()}`, 'success');
        } catch (error) {
            console.error('Export failed:', error);
            showToast(error.message || 'Export failed', 'error');
        } finally {
            updateStatus('Ready');
        }
    }
};

window.Exporter = Exporter;
