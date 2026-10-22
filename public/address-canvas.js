// Renders a legally-required postal address as a <canvas> drawing instead of DOM text, so the
// string never sits in the page as selectable/copyable text or as a plain grep-able literal in
// this file. This raises the bar against naive scrapers and copy-paste harvesting — it is NOT
// airtight (anyone willing to run OCR on a screenshot can still recover it), so don't treat it as
// a substitute for consent/authorization when disclosing someone's private address.
(function () {
    'use strict';

    function decodeLine(b64) {
        // atob() only understands Latin-1 bytes, so this reverses the classic
        // escape(atob(x)) -> decodeURIComponent trick to get the original UTF-8 (Polish
        // diacritics included) string back out.
        return decodeURIComponent(escape(window.atob(b64)));
    }

    function renderProtectedAddress(containerId, encodedLines, opts) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const options = opts || {};
        const lines = encodedLines.map(decodeLine);

        const paddingX = 22;
        const paddingY = 18;
        const lineHeight = 26;
        const font = '600 16px "Segoe UI", sans-serif';
        const dpr = window.devicePixelRatio || 1;

        const measureCanvas = document.createElement('canvas');
        const measureCtx = measureCanvas.getContext('2d');
        measureCtx.font = font;
        let maxWidth = 0;
        lines.forEach((line) => {
            const w = measureCtx.measureText(line).width;
            if (w > maxWidth) maxWidth = w;
        });

        const width = Math.ceil(maxWidth) + paddingX * 2;
        const height = lines.length * lineHeight + paddingY * 2;

        const canvas = document.createElement('canvas');
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        canvas.style.display = 'block';
        canvas.style.userSelect = 'none';
        canvas.style.webkitUserSelect = 'none';
        canvas.style.msUserSelect = 'none';
        canvas.style.borderRadius = '10px';
        canvas.setAttribute('aria-label', options.ariaLabel || 'Adres siedziby (obraz)');
        canvas.draggable = false;

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        // Card background matching the site's dark-navy/gold panel style.
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, 'rgba(18, 27, 48, 0.96)');
        gradient.addColorStop(1, 'rgba(10, 16, 33, 0.98)');
        ctx.fillStyle = gradient;
        roundRect(ctx, 0, 0, width, height, 10);
        ctx.fill();
        ctx.strokeStyle = 'rgba(212, 175, 55, 0.45)';
        ctx.lineWidth = 1;
        roundRect(ctx, 0.5, 0.5, width - 1, height - 1, 10);
        ctx.stroke();

        ctx.font = font;
        ctx.fillStyle = '#f0d78c';
        ctx.textBaseline = 'middle';
        lines.forEach((line, i) => {
            ctx.fillText(line, paddingX, paddingY + lineHeight * i + lineHeight / 2);
        });

        // Belt-and-braces against right-click "save image" / drag-out and text-selection attempts
        // on the wrapping container.
        container.style.userSelect = 'none';
        container.style.webkitUserSelect = 'none';
        container.oncontextmenu = () => false;
        canvas.oncontextmenu = () => false;
        canvas.ondragstart = () => false;

        container.innerHTML = '';
        container.appendChild(canvas);
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    window.WoLSecureAddress = { render: renderProtectedAddress };
})();
