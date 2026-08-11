const camera = document.getElementById('camera');
const captureCanvas = document.getElementById('captureCanvas');
const resultCanvas = document.getElementById('resultCanvas');
const startBtn = document.getElementById('startBtn');
const captureBtn = document.getElementById('captureBtn');
const retakeBtn = document.getElementById('retakeBtn');
const saveBtn = document.getElementById('saveBtn');
const reprocessBtn = document.getElementById('reprocessBtn');
const enhanceControls = document.getElementById('enhanceControls');
const emptyState = document.getElementById('emptyState');
const guide = document.getElementById('guide');
const message = document.getElementById('message');
const cvState = document.getElementById('cvState');
const modeSelect = document.getElementById('modeSelect');
const strengthRange = document.getElementById('strengthRange');

let stream = null;
let cvReady = false;
let lastCapture = null;

function setMessage(text) { message.textContent = text; }

function markCvReady() {
  cvReady = true;
  cvState.textContent = 'Scanner ready';
  cvState.style.color = '#f5f5f5';
}

window.addEventListener('opencv-ready', markCvReady);
if (window.cv && window.cv.Mat) markCvReady();

async function startCamera() {
  try {
    stopCamera();
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 2560 },
        height: { ideal: 1920 }
      },
      audio: false
    });
    camera.srcObject = stream;
    await camera.play();
    camera.hidden = false;
    resultCanvas.hidden = true;
    guide.hidden = false;
    emptyState.hidden = true;
    captureBtn.disabled = false;
    retakeBtn.hidden = true;
    saveBtn.hidden = true;
    enhanceControls.hidden = true;
    setMessage('Place the full sheet inside the frame, then tap Scan.');
  } catch (err) {
    setMessage(`Camera unavailable: ${err.message}`);
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
}

function captureFrame() {
  const w = camera.videoWidth;
  const h = camera.videoHeight;
  if (!w || !h) throw new Error('Camera is not ready.');

  captureCanvas.width = w;
  captureCanvas.height = h;
  const ctx = captureCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(camera, 0, 0, w, h);
  lastCapture = ctx.getImageData(0, 0, w, h);
}

function orderPoints(points) {
  const sums = points.map(p => p.x + p.y);
  const diffs = points.map(p => p.y - p.x);
  return {
    tl: points[sums.indexOf(Math.min(...sums))],
    br: points[sums.indexOf(Math.max(...sums))],
    tr: points[diffs.indexOf(Math.min(...diffs))],
    bl: points[diffs.indexOf(Math.max(...diffs))]
  };
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function findDocumentQuad(src) {
  const maxDetectionSide = 1200;
  const scale = Math.min(1, maxDetectionSide / Math.max(src.cols, src.rows));
  const small = new cv.Mat();
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const dilated = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);

  try {
    if (scale < 1) {
      cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    } else {
      src.copyTo(small);
    }

    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, 60, 180);
    cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), 1);
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let best = null;
    let bestArea = 0;
    const imageArea = small.cols * small.rows;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = Math.abs(cv.contourArea(contour));
      if (area < imageArea * 0.12 || area <= bestArea) {
        contour.delete();
        continue;
      }

      const peri = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.02 * peri, true);

      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const pts = [];
        for (let r = 0; r < 4; r++) {
          pts.push({ x: approx.intPtr(r, 0)[0] / scale, y: approx.intPtr(r, 0)[1] / scale });
        }
        best = pts;
        bestArea = area;
      }

      approx.delete();
      contour.delete();
    }

    return best;
  } finally {
    small.delete(); gray.delete(); blur.delete(); edges.delete(); dilated.delete();
    contours.delete(); hierarchy.delete(); kernel.delete();
  }
}

function fallbackQuad(src) {
  // Conservative fallback: trim a small camera margin instead of failing completely.
  const mx = src.cols * 0.035;
  const my = src.rows * 0.035;
  return [
    { x: mx, y: my },
    { x: src.cols - mx, y: my },
    { x: src.cols - mx, y: src.rows - my },
    { x: mx, y: src.rows - my }
  ];
}

function warpDocument(src, quad) {
  const p = orderPoints(quad);
  const width = Math.max(dist(p.br, p.bl), dist(p.tr, p.tl));
  const height = Math.max(dist(p.tr, p.br), dist(p.tl, p.bl));
  const outW = Math.max(1, Math.round(width));
  const outH = Math.max(1, Math.round(height));

  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    p.tl.x, p.tl.y,
    p.tr.x, p.tr.y,
    p.br.x, p.br.y,
    p.bl.x, p.bl.y
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    outW - 1, 0,
    outW - 1, outH - 1,
    0, outH - 1
  ]);
  const matrix = cv.getPerspectiveTransform(srcPts, dstPts);
  const warped = new cv.Mat();

  cv.warpPerspective(src, warped, matrix, new cv.Size(outW, outH), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  srcPts.delete(); dstPts.delete(); matrix.delete();
  return warped;
}

function enhanceDocument(warped, mode, strength) {
  if (mode === 'clean') {
    const result = new cv.Mat();
    const lab = new cv.Mat();
    const planes = new cv.MatVector();
    try {
      cv.cvtColor(warped, lab, cv.COLOR_RGBA2RGB);
      // Mild local blur subtraction (unsharp mask) to improve text edges without destroying stamps/signatures.
      const blurred = new cv.Mat();
      cv.GaussianBlur(lab, blurred, new cv.Size(0, 0), 1.2 + strength * 0.25);
      cv.addWeighted(lab, 1.45, blurred, -0.45, 0, result);
      blurred.delete();
      return result;
    } finally {
      lab.delete(); planes.delete();
    }
  }

  const gray = new cv.Mat();
  cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);

  if (mode === 'gray') {
    const result = new cv.Mat();
    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(0, 0), 1.0 + strength * 0.2);
    cv.addWeighted(gray, 1.6, blurred, -0.6, 0, result);
    gray.delete(); blurred.delete();
    return result;
  }

  // B&W document mode: locally adapts to shadows and uneven phone-camera lighting.
  const normalized = new cv.Mat();
  const background = new cv.Mat();
  const bw = new cv.Mat();
  const blockSize = [21, 31, 41, 51, 61][strength - 1];
  const c = [8, 10, 12, 14, 16][strength - 1];

  cv.GaussianBlur(gray, background, new cv.Size(0, 0), 9 + strength * 2);
  cv.divide(gray, background, normalized, 255);
  cv.adaptiveThreshold(normalized, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, c);

  gray.delete(); background.delete(); normalized.delete();
  return bw;
}

function processCapture() {
  if (!cvReady) throw new Error('The image-processing engine is still loading.');
  if (!lastCapture) throw new Error('No captured image is available.');

  captureCanvas.width = lastCapture.width;
  captureCanvas.height = lastCapture.height;
  captureCanvas.getContext('2d').putImageData(lastCapture, 0, 0);

  const src = cv.imread(captureCanvas);
  let warped = null;
  let enhanced = null;

  try {
    let quad = findDocumentQuad(src);
    const found = Boolean(quad);
    if (!quad) quad = fallbackQuad(src);

    warped = warpDocument(src, quad);
    enhanced = enhanceDocument(warped, modeSelect.value, Number(strengthRange.value));

    resultCanvas.width = enhanced.cols;
    resultCanvas.height = enhanced.rows;
    cv.imshow(resultCanvas, enhanced);

    camera.hidden = true;
    resultCanvas.hidden = false;
    guide.hidden = true;
    retakeBtn.hidden = false;
    saveBtn.hidden = false;
    enhanceControls.hidden = false;
    captureBtn.disabled = true;
    setMessage(found ? 'Page detected, straightened and cropped.' : 'Page edge was unclear; used a conservative crop. Retake on a contrasting background for better border detection.');
  } finally {
    src.delete();
    if (warped) warped.delete();
    if (enhanced) enhanced.delete();
  }
}

captureBtn.addEventListener('click', () => {
  try {
    captureFrame();
    processCapture();
    stopCamera();
  } catch (err) {
    setMessage(err.message);
  }
});

startBtn.addEventListener('click', startCamera);
retakeBtn.addEventListener('click', startCamera);
reprocessBtn.addEventListener('click', () => {
  try { processCapture(); } catch (err) { setMessage(err.message); }
});

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function asciiBytes(text) {
  return new TextEncoder().encode(text);
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function buildPdfFromCanvas(canvas) {
  if (!canvas.width || !canvas.height) throw new Error('No processed scan is available.');

  // Encode the processed page once. JPEG is embedded directly in the PDF as a DCT image stream.
  const jpegBytes = dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.95));
  const isLandscape = canvas.width > canvas.height;

  // Standard A4 page in PDF points, rotating the page dimensions for landscape documents.
  const pageW = isLandscape ? 841.89 : 595.28;
  const pageH = isLandscape ? 595.28 : 841.89;
  const margin = 12;
  const maxW = pageW - margin * 2;
  const maxH = pageH - margin * 2;
  const imageRatio = canvas.width / canvas.height;
  const boxRatio = maxW / maxH;

  let drawW;
  let drawH;
  if (imageRatio > boxRatio) {
    drawW = maxW;
    drawH = drawW / imageRatio;
  } else {
    drawH = maxH;
    drawW = drawH * imageRatio;
  }
  const x = (pageW - drawW) / 2;
  const y = (pageH - drawH) / 2;

  const content = `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`;
  const contentBytes = asciiBytes(content);

  const chunks = [];
  const offsets = [0];
  let length = 0;
  const push = chunk => {
    chunks.push(chunk);
    length += chunk.length;
  };
  const pushAscii = text => push(asciiBytes(text));
  const beginObject = n => {
    offsets[n] = length;
    pushAscii(`${n} 0 obj\n`);
  };

  // Binary marker after the PDF version helps readers recognize a binary PDF file.
  push(new Uint8Array([0x25,0x50,0x44,0x46,0x2D,0x31,0x2E,0x34,0x0A,0x25,0xE2,0xE3,0xCF,0xD3,0x0A]));

  beginObject(1);
  pushAscii('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  pushAscii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  beginObject(3);
  pushAscii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);

  beginObject(4);
  pushAscii(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes);
  pushAscii('\nendstream\nendobj\n');

  beginObject(5);
  pushAscii(`<< /Length ${contentBytes.length} >>\nstream\n`);
  push(contentBytes);
  pushAscii('endstream\nendobj\n');

  const xrefOffset = length;
  pushAscii('xref\n0 6\n');
  pushAscii('0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) {
    pushAscii(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  pushAscii(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob([concatBytes(chunks)], { type: 'application/pdf' });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not encode PDF.'));
    reader.onload = () => {
      const value = String(reader.result || '');
      const comma = value.indexOf(',');
      if (comma < 0) return reject(new Error('Could not encode PDF.'));
      resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

async function downloadPdf() {
  const pdfBlob = buildPdfFromCanvas(resultCanvas);
  const filename = `scan-${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`;

  // Android APK: hand the completed PDF to the native shell, which opens
  // Android's Save As picker. The PDF never needs to leave the phone.
  if (window.AndroidBridge && typeof window.AndroidBridge.savePdf === 'function') {
    setMessage('Preparing PDF…');
    const base64 = await blobToBase64(pdfBlob);
    window.AndroidBridge.savePdf(filename, base64);
    setMessage('Choose where to save the PDF.');
    return;
  }

  // Browser fallback for the web prototype.
  const url = URL.createObjectURL(pdfBlob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  setMessage('PDF downloaded.');
}

saveBtn.addEventListener('click', async () => {
  try { await downloadPdf(); } catch (err) { setMessage(err.message); }
});

window.addEventListener('beforeunload', stopCamera);
