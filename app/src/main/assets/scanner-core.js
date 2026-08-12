(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ScannerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createInitialState() {
    return {
      scanMode: 'single',
      pages: [],
      selectedPage: 0,
      filename: 'Scanned Document.pdf',
      saved: false,
      sessionStartedAt: Date.now()
    };
  }

  function ensurePdfExtension(name) {
    const trimmed = String(name || 'Scanned Document').trim() || 'Scanned Document';
    return /\.pdf$/i.test(trimmed) ? trimmed : `${trimmed}.pdf`;
  }

  function sanitizeFilename(name) {
    const withExt = ensurePdfExtension(name);
    const clean = withExt.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
    return clean || 'Scanned Document.pdf';
  }

  function formatBytes(bytes) {
    const n = Math.max(0, Number(bytes) || 0);
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function estimateDataUrlBytes(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return 0;
    const comma = dataUrl.indexOf(',');
    const payload = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
    const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(payload * 3 / 4) - padding);
  }

  function moveItem(items, from, to) {
    if (!Array.isArray(items)) throw new TypeError('items must be an array');
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return false;
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    return true;
  }

  function polygonArea(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      area += a.x * b.y - b.x * a.y;
    }
    return Math.abs(area) / 2;
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function orderPoints(points) {
    if (!Array.isArray(points) || points.length !== 4) throw new Error('Exactly four points are required.');
    const sums = points.map(p => p.x + p.y);
    const diffs = points.map(p => p.y - p.x);
    return {
      tl: points[sums.indexOf(Math.min(...sums))],
      br: points[sums.indexOf(Math.max(...sums))],
      tr: points[diffs.indexOf(Math.min(...diffs))],
      bl: points[diffs.indexOf(Math.max(...diffs))]
    };
  }

  function cornerCosine(a, b, c) {
    const ux = a.x - b.x;
    const uy = a.y - b.y;
    const vx = c.x - b.x;
    const vy = c.y - b.y;
    const denom = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (!denom) return 1;
    return Math.abs((ux * vx + uy * vy) / denom);
  }

  function scoreQuad(points, imageWidth, imageHeight) {
    if (!Array.isArray(points) || points.length !== 4 || !imageWidth || !imageHeight) {
      return { score: 0, areaRatio: 0, rectangularity: 0, ratio: 0, centerScore: 0, marginScore: 0 };
    }
    const p = orderPoints(points);
    const ordered = [p.tl, p.tr, p.br, p.bl];
    const areaRatio = polygonArea(ordered) / (imageWidth * imageHeight);
    const cosines = [
      cornerCosine(p.bl, p.tl, p.tr),
      cornerCosine(p.tl, p.tr, p.br),
      cornerCosine(p.tr, p.br, p.bl),
      cornerCosine(p.br, p.bl, p.tl)
    ];
    const rectangularity = Math.max(0, 1 - cosines.reduce((a, b) => a + b, 0) / cosines.length);
    const width = (distance(p.tl, p.tr) + distance(p.bl, p.br)) / 2;
    const height = (distance(p.tl, p.bl) + distance(p.tr, p.br)) / 2;
    const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
    const ratioScore = ratio > 6.5 ? 0 : ratio > 4.8 ? 0.35 : ratio > 3.5 ? 0.72 : 1;

    // Large is useful, but "largest rectangle wins" is deliberately avoided.
    // A page occupying roughly 22-88% of the visible preview receives full credit;
    // candidates that nearly fill the sensor frame are penalized because they are
    // frequently desks, folders, backing sheets or screen edges.
    let areaScore = 0;
    if (areaRatio >= 0.22 && areaRatio <= 0.88) areaScore = 1;
    else if (areaRatio < 0.22) areaScore = Math.max(0, areaRatio / 0.22);
    else areaScore = Math.max(0.35, 1 - (areaRatio - 0.88) / 0.12 * 0.65);

    const cx = ordered.reduce((sum, q) => sum + q.x, 0) / 4;
    const cy = ordered.reduce((sum, q) => sum + q.y, 0) / 4;
    const dx = Math.abs(cx - imageWidth / 2) / (imageWidth / 2);
    const dy = Math.abs(cy - imageHeight / 2) / (imageHeight / 2);
    const centerScore = Math.max(0, 1 - Math.hypot(dx, dy) / 1.2);

    const minMargin = Math.min(...ordered.map(q => Math.min(q.x, imageWidth - q.x, q.y, imageHeight - q.y)));
    const marginRatio = minMargin / Math.max(1, Math.min(imageWidth, imageHeight));
    const marginScore = Math.max(0, Math.min(1, marginRatio / 0.035));

    const score = Math.max(0, Math.min(1,
      rectangularity * 0.40 +
      areaScore * 0.22 +
      ratioScore * 0.10 +
      centerScore * 0.16 +
      marginScore * 0.12
    ));
    return { score, areaRatio, rectangularity, ratio, centerScore, marginScore };
  }

  function coverCrop(sourceWidth, sourceHeight, viewWidth, viewHeight) {
    const sw = Math.max(1, Number(sourceWidth) || 1);
    const sh = Math.max(1, Number(sourceHeight) || 1);
    const vw = Math.max(1, Number(viewWidth) || 1);
    const vh = Math.max(1, Number(viewHeight) || 1);
    const sourceAspect = sw / sh;
    const viewAspect = vw / vh;
    if (sourceAspect > viewAspect) {
      const width = sh * viewAspect;
      return { x: (sw - width) / 2, y: 0, width, height: sh };
    }
    const height = sw / viewAspect;
    return { x: 0, y: (sh - height) / 2, width: sw, height };
  }

  function percentileFromHistogram(histogram, percentile, total) {
    const target = Math.max(0, Math.min(total - 1, Math.floor(total * percentile)));
    let seen = 0;
    for (let i = 0; i < histogram.length; i++) {
      seen += histogram[i];
      if (seen > target) return i;
    }
    return histogram.length - 1;
  }

  function analyzeGrayPixels(data, width, height) {
    if (!data || !data.length || !width || !height) {
      return { mean: 0, stddev: 0, p05: 0, p50: 0, p95: 0, clippedLow: 0, clippedHigh: 0, edgeEnergy: 0 };
    }
    const histogram = new Uint32Array(256);
    let sum = 0;
    let sumSq = 0;
    const total = Math.min(data.length, width * height);
    for (let i = 0; i < total; i++) {
      const v = data[i];
      histogram[v]++;
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / total;
    const variance = Math.max(0, sumSq / total - mean * mean);
    let low = 0;
    let high = 0;
    for (let i = 0; i <= 4; i++) low += histogram[i];
    for (let i = 251; i < 256; i++) high += histogram[i];

    let edgeSum = 0;
    let edgeCount = 0;
    const step = width > 900 ? 2 : 1;
    for (let y = step; y < height - step; y += step) {
      const row = y * width;
      for (let x = step; x < width - step; x += step) {
        const i = row + x;
        const gx = Math.abs(data[i + step] - data[i - step]);
        const gy = Math.abs(data[i + step * width] - data[i - step * width]);
        edgeSum += gx + gy;
        edgeCount++;
      }
    }

    return {
      mean,
      stddev: Math.sqrt(variance),
      p05: percentileFromHistogram(histogram, 0.05, total),
      p50: percentileFromHistogram(histogram, 0.50, total),
      p95: percentileFromHistogram(histogram, 0.95, total),
      clippedLow: low / total,
      clippedHigh: high / total,
      edgeEnergy: edgeCount ? edgeSum / edgeCount : 0
    };
  }

  function qualityDecision(metrics) {
    const warnings = [];
    let blocking = false;
    if (metrics.p95 < 105 || metrics.mean < 62) warnings.push('More light needed');
    if (metrics.p05 > 175 && metrics.stddev < 30) warnings.push('Document may be overexposed');
    if (metrics.edgeEnergy < 4.0) {
      warnings.push('Hold phone steady for a sharper scan');
      blocking = true;
    }
    const score = Math.max(0, Math.min(1,
      (Math.min(1, metrics.edgeEnergy / 16) * 0.45) +
      (Math.min(1, metrics.stddev / 65) * 0.25) +
      (metrics.mean >= 55 && metrics.mean <= 235 ? 0.30 : 0.12)
    ));
    return { score, blocking, warnings };
  }

  function pageGeometry(page) {
    const width = Math.max(1, Number(page.width) || 1);
    const height = Math.max(1, Number(page.height) || 1);
    const imageRatio = width / height;
    const isLandscape = imageRatio > 1;
    const a4PortraitRatio = 595.28 / 841.89;
    const normalizedRatio = isLandscape ? 1 / imageRatio : imageRatio;
    let pageW;
    let pageH;

    // Use true A4 when the captured document is close to A-series proportions.
    // Otherwise make the PDF page match the physical-looking document ratio (receipts, cards, etc.).
    if (Math.abs(normalizedRatio - a4PortraitRatio) < 0.07) {
      pageW = isLandscape ? 841.89 : 595.28;
      pageH = isLandscape ? 595.28 : 841.89;
    } else if (isLandscape) {
      pageW = 841.89;
      pageH = Math.max(180, pageW / imageRatio);
    } else {
      pageH = 841.89;
      pageW = Math.max(180, pageH * imageRatio);
    }
    return { pageW, pageH, drawW: pageW, drawH: pageH, x: 0, y: 0 };
  }

  function dataUrlToBytes(dataUrl) {
    const base64 = String(dataUrl || '').split(',')[1];
    if (!base64) throw new Error('Invalid image data.');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function asciiBytes(text) { return new TextEncoder().encode(text); }

  function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    chunks.forEach(chunk => { out.set(chunk, offset); offset += chunk.length; });
    return out;
  }

  function buildPdfFromPages(pages) {
    if (!Array.isArray(pages) || !pages.length) throw new Error('No pages are available.');
    const chunks = [];
    const offsets = [0];
    let length = 0;
    const push = chunk => { chunks.push(chunk); length += chunk.length; };
    const pushAscii = text => push(asciiBytes(text));
    const beginObject = n => { offsets[n] = length; pushAscii(`${n} 0 obj\n`); };

    push(new Uint8Array([0x25,0x50,0x44,0x46,0x2D,0x31,0x2E,0x34,0x0A,0x25,0xE2,0xE3,0xCF,0xD3,0x0A]));
    beginObject(1);
    pushAscii('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    beginObject(2);
    pushAscii(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

    pages.forEach((page, i) => {
      const pageObj = 3 + i * 3;
      const imageObj = pageObj + 1;
      const contentObj = pageObj + 2;
      const jpegBytes = dataUrlToBytes(page.dataUrl);
      const g = pageGeometry(page);
      const content = `q\n${g.drawW.toFixed(2)} 0 0 ${g.drawH.toFixed(2)} ${g.x.toFixed(2)} ${g.y.toFixed(2)} cm\n/Im0 Do\nQ\n`;
      const contentBytes = asciiBytes(content);

      beginObject(pageObj);
      pushAscii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${g.pageW.toFixed(2)} ${g.pageH.toFixed(2)}] /Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);
      beginObject(imageObj);
      pushAscii(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
      push(jpegBytes);
      pushAscii('\nendstream\nendobj\n');
      beginObject(contentObj);
      pushAscii(`<< /Length ${contentBytes.length} >>\nstream\n`);
      push(contentBytes);
      pushAscii('endstream\nendobj\n');
    });

    const lastObject = 2 + pages.length * 3;
    const xrefOffset = length;
    pushAscii(`xref\n0 ${lastObject + 1}\n`);
    pushAscii('0000000000 65535 f \n');
    for (let i = 1; i <= lastObject; i++) pushAscii(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    pushAscii(`trailer\n<< /Size ${lastObject + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    return new Blob([concatBytes(chunks)], { type: 'application/pdf' });
  }

  function backTarget(screenId, state) {
    switch (screenId) {
      case 'cameraScreen': return state && state.scanMode === 'multi' && state.pages && state.pages.length ? 'reviewScreen' : 'homeScreen';
      case 'editScreen': return state && state.scanMode === 'multi' && state.pages && state.pages.length ? 'reviewScreen' : 'cameraScreen';
      case 'reviewScreen': return 'confirm-discard';
      case 'exportScreen': return state && state.scanMode === 'multi' ? 'reviewScreen' : 'editScreen';
      default: return 'exit';
    }
  }

  return {
    createInitialState,
    ensurePdfExtension,
    sanitizeFilename,
    formatBytes,
    estimateDataUrlBytes,
    moveItem,
    polygonArea,
    orderPoints,
    scoreQuad,
    coverCrop,
    analyzeGrayPixels,
    qualityDecision,
    pageGeometry,
    buildPdfFromPages,
    backTarget
  };
});
