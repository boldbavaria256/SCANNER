'use strict';

const $ = id => document.getElementById(id);
const Core = window.ScannerCore;
if (!Core) throw new Error('Scanner core failed to load.');

const screens = [...document.querySelectorAll('.screen')];
const camera = $('camera');
const captureCanvas = $('captureCanvas');
const analysisCanvas = $('analysisCanvas');
const resultCanvas = $('resultCanvas');
const warpedCanvas = $('warpedCanvas');
const editCanvas = $('editCanvas');
const filePicker = $('filePicker');
const toast = $('toast');
const guide = $('guide');
const guidePolygon = $('guidePolygon');

const MAX_CAPTURE_SIDE = 4800;
const MAX_MASTER_SIDE = 3200;
const ANALYSIS_SIDE = 640;
const ANALYSIS_INTERVAL_MS = 320;
const STABLE_FRAMES_FOR_CAPTURE = 5;

let stream = null;
let cvReady = false;
let captureBusy = false;
let torchEnabled = false;
let activeFilter = 'clean';
let editRotation = 0;
let currentInputKind = 'camera';
let currentScreenId = 'homeScreen';
let reorderMode = false;
let recentsExpanded = false;
let toastTimer = null;
let analysisTimer = null;
let analysisRunning = false;
let stableFrames = 0;
let lastLiveQuad = null;
let lastCapture = null;
let lastCaptureQuality = null;
let autoCaptureEnabled = true;
let cropRect = { left: 0, top: 0, right: 1, bottom: 1 };
let pendingDiscardAction = null;

const state = Core.createInitialState();

function showToast(text, duration = 2200) {
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

function showScreen(id) {
  currentScreenId = id;
  screens.forEach(screen => screen.classList.toggle('active', screen.id === id));
}

function resetDocument() {
  state.scanMode = 'single';
  state.pages = [];
  state.selectedPage = 0;
  state.filename = 'Scanned Document.pdf';
  state.saved = false;
  state.sessionStartedAt = Date.now();
  lastCapture = null;
  lastCaptureQuality = null;
  activeFilter = 'clean';
  editRotation = 0;
  reorderMode = false;
  cropRect = { left: 0, top: 0, right: 1, bottom: 1 };
}

function markCvReady() {
  cvReady = true;
  if ($('cameraHint') && stream) $('cameraHint').textContent = 'Place the full page inside the frame';
}
window.addEventListener('opencv-ready', markCvReady);
if (window.cv && window.cv.Mat) markCvReady();

function setScanMode(mode) {
  if (!['single', 'multi'].includes(mode)) return;
  if (mode === 'single' && state.pages.length > 0 && state.scanMode === 'multi') {
    showToast('Finish or discard the current multi-page scan first.');
    return;
  }
  state.scanMode = mode;
  $('singleModeBtn').classList.toggle('active', mode === 'single');
  $('multiModeBtn').classList.toggle('active', mode === 'multi');
  $('finishMultiBtn').hidden = !(mode === 'multi' && state.pages.length > 0);
  $('multiCount').textContent = state.pages.length;
}

async function beginNewScan(mode) {
  resetDocument();
  setScanMode(mode);
  currentInputKind = 'camera';
  showScreen('cameraScreen');
  await startCamera();
}

async function enterCameraForAdditionalPage() {
  setScanMode('multi');
  currentInputKind = 'camera';
  showScreen('cameraScreen');
  await startCamera();
}

async function startCamera() {
  stopCamera();
  resetGuide();
  stableFrames = 0;
  lastLiveQuad = null;
  try {
    $('cameraEmpty').hidden = false;
    $('cameraEmpty').textContent = 'Camera is starting…';
    $('captureBtn').disabled = true;
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 3840 },
        height: { ideal: 2160 }
      },
      audio: false
    });
    camera.srcObject = stream;
    await camera.play();
    $('cameraEmpty').hidden = true;
    $('captureBtn').disabled = false;
    torchEnabled = false;
    updateFlashUi();
    updateAutoUi();
    $('cameraHint').textContent = cvReady ? 'Finding document…' : 'Preparing document detection…';
    startLiveAnalysis();
  } catch (err) {
    $('cameraEmpty').hidden = false;
    $('cameraEmpty').textContent = 'Camera unavailable';
    $('captureBtn').disabled = true;
    showToast(`Camera unavailable: ${err.message || 'permission denied'}`, 3400);
  }
}

function stopCamera() {
  stopLiveAnalysis();
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  camera.srcObject = null;
  torchEnabled = false;
  updateFlashUi();
}

function startLiveAnalysis() {
  stopLiveAnalysis();
  if (!cvReady || !stream) return;
  analysisTimer = setTimeout(analyzeLiveFrame, 120);
}

function stopLiveAnalysis() {
  if (analysisTimer) clearTimeout(analysisTimer);
  analysisTimer = null;
  analysisRunning = false;
}

function resetGuide() {
  guide.classList.remove('detected', 'good', 'warning');
  guidePolygon.setAttribute('points', '8,15 92,15 92,70 8,70');
}

function updateGuideFromQuad(quad, sourceW, sourceH, status = 'detected') {
  if (!quad || !sourceW || !sourceH) return resetGuide();
  const rect = camera.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scale = Math.max(rect.width / sourceW, rect.height / sourceH);
  const renderedW = sourceW * scale;
  const renderedH = sourceH * scale;
  const cropX = (renderedW - rect.width) / 2;
  const cropY = (renderedH - rect.height) / 2;
  const points = Core.orderPoints(quad);
  const ordered = [points.tl, points.tr, points.br, points.bl].map(p => {
    const x = Math.max(0, Math.min(100, ((p.x * scale - cropX) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((p.y * scale - cropY) / rect.height) * 100));
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  guidePolygon.setAttribute('points', ordered.join(' '));
  guide.classList.add('detected');
  guide.classList.toggle('good', status === 'good');
  guide.classList.toggle('warning', status === 'warning');
}

function quadDistance(a, b, width, height) {
  if (!a || !b) return Infinity;
  const pa = Core.orderPoints(a);
  const pb = Core.orderPoints(b);
  const aa = [pa.tl, pa.tr, pa.br, pa.bl];
  const bb = [pb.tl, pb.tr, pb.br, pb.bl];
  const diag = Math.hypot(width, height) || 1;
  return aa.reduce((sum, p, i) => sum + Math.hypot(p.x - bb[i].x, p.y - bb[i].y), 0) / 4 / diag;
}

async function analyzeLiveFrame() {
  if (!stream || !cvReady || captureBusy || analysisRunning || currentScreenId !== 'cameraScreen') return;
  analysisRunning = true;
  let src = null;
  try {
    const vw = camera.videoWidth;
    const vh = camera.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(1, ANALYSIS_SIDE / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    analysisCanvas.width = w;
    analysisCanvas.height = h;
    analysisCanvas.getContext('2d', { willReadFrequently: true }).drawImage(camera, 0, 0, w, h);
    src = cv.imread(analysisCanvas);
    const detected = findDocumentQuad(src);
    const quality = measureQualityMat(src);

    if (!detected) {
      stableFrames = 0;
      lastLiveQuad = null;
      resetGuide();
      $('cameraHint').textContent = quality.decision.warnings[0] || 'Move closer and include all four corners';
      return;
    }

    const movement = quadDistance(detected.quad, lastLiveQuad, w, h);
    const stable = movement < 0.016;
    lastLiveQuad = detected.quad;
    stableFrames = stable ? stableFrames + 1 : 1;

    const qualityGood = !quality.decision.blocking && quality.metrics.mean > 48 && detected.confidence >= 0.62;
    updateGuideFromQuad(detected.quad, w, h, qualityGood ? 'good' : 'warning');

    if (!qualityGood) {
      $('cameraHint').textContent = quality.decision.warnings[0] || 'Hold steady and improve lighting';
      stableFrames = Math.min(stableFrames, 2);
      return;
    }

    if (stableFrames < STABLE_FRAMES_FOR_CAPTURE) {
      $('cameraHint').textContent = 'Document detected • Hold steady';
      return;
    }

    if (autoCaptureEnabled) {
      $('cameraHint').textContent = 'Capturing…';
      await performCapture('auto');
    } else {
      $('cameraHint').textContent = 'Ready to capture';
    }
  } catch (err) {
    // Live analysis must never break manual capture.
    $('cameraHint').textContent = 'Align the page and tap capture';
  } finally {
    if (src) src.delete();
    analysisRunning = false;
    if (stream && currentScreenId === 'cameraScreen' && !captureBusy) {
      analysisTimer = setTimeout(analyzeLiveFrame, ANALYSIS_INTERVAL_MS);
    }
  }
}

function captureFrame() {
  const w = camera.videoWidth;
  const h = camera.videoHeight;
  if (!w || !h) throw new Error('Camera is not ready.');
  const scale = Math.min(1, MAX_CAPTURE_SIDE / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  captureCanvas.width = outW;
  captureCanvas.height = outH;
  const ctx = captureCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(camera, 0, 0, outW, outH);
  lastCapture = ctx.getImageData(0, 0, outW, outH);
}

async function performCapture(source = 'manual') {
  if (captureBusy) return;
  captureBusy = true;
  document.body.classList.add('processing');
  $('captureBtn').disabled = true;
  stopLiveAnalysis();
  try {
    if (!cvReady) throw new Error('The scanner is still preparing.');
    captureFrame();
    stopCamera();
    processCaptureToEditor(source);
  } catch (err) {
    showToast(err.message || 'Could not capture the document.', 3200);
    if (currentScreenId === 'cameraScreen') await startCamera();
  } finally {
    captureBusy = false;
    document.body.classList.remove('processing');
    if (currentScreenId === 'cameraScreen' && stream) $('captureBtn').disabled = false;
  }
}

function findDocumentQuad(src) {
  const maxDetectionSide = 1200;
  const scale = Math.min(1, maxDetectionSide / Math.max(src.cols, src.rows));
  const small = new cv.Mat();
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const closed = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);

  try {
    if (scale < 1) cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    else src.copyTo(small);
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    const metrics = Core.analyzeGrayPixels(gray.data, gray.cols, gray.rows);
    const median = metrics.p50 || 128;
    const low = Math.max(28, Math.round(median * 0.55));
    const high = Math.min(220, Math.max(low + 35, Math.round(median * 1.35)));
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, low, high);
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
    cv.dilate(closed, closed, kernel, new cv.Point(-1, -1), 1);
    cv.findContours(closed, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let best = null;
    let bestScore = 0;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = Math.abs(cv.contourArea(contour));
      if (area < small.cols * small.rows * 0.08) { contour.delete(); continue; }
      const peri = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.018 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const pts = [];
        for (let r = 0; r < 4; r++) pts.push({ x: approx.intPtr(r, 0)[0], y: approx.intPtr(r, 0)[1] });
        const scoring = Core.scoreQuad(pts, small.cols, small.rows);
        if (scoring.score > bestScore) {
          bestScore = scoring.score;
          best = pts.map(p => ({ x: p.x / scale, y: p.y / scale }));
        }
      }
      approx.delete();
      contour.delete();
    }
    if (!best || bestScore < 0.42) return null;
    return { quad: best, confidence: bestScore };
  } finally {
    small.delete(); gray.delete(); blur.delete(); edges.delete(); closed.delete(); contours.delete(); hierarchy.delete(); kernel.delete();
  }
}

function fallbackQuad(src) {
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
  const p = Core.orderPoints(quad);
  let width = Math.max(Math.hypot(p.br.x - p.bl.x, p.br.y - p.bl.y), Math.hypot(p.tr.x - p.tl.x, p.tr.y - p.tl.y));
  let height = Math.max(Math.hypot(p.tr.x - p.br.x, p.tr.y - p.br.y), Math.hypot(p.tl.x - p.bl.x, p.tl.y - p.bl.y));
  const resize = Math.min(1, MAX_MASTER_SIDE / Math.max(width, height));
  width = Math.max(1, Math.round(width * resize));
  height = Math.max(1, Math.round(height * resize));
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [p.tl.x,p.tl.y,p.tr.x,p.tr.y,p.br.x,p.br.y,p.bl.x,p.bl.y]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0,width-1,0,width-1,height-1,0,height-1]);
  const matrix = cv.getPerspectiveTransform(srcPts, dstPts);
  const warped = new cv.Mat();
  cv.warpPerspective(src, warped, matrix, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  srcPts.delete(); dstPts.delete(); matrix.delete();
  return warped;
}

function measureQualityMat(src) {
  const scale = Math.min(1, 720 / Math.max(src.cols, src.rows));
  const small = new cv.Mat();
  const gray = new cv.Mat();
  try {
    if (scale < 1) cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    else src.copyTo(small);
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    const metrics = Core.analyzeGrayPixels(gray.data, gray.cols, gray.rows);
    const decision = Core.qualityDecision(metrics);
    return { metrics, decision };
  } finally {
    small.delete(); gray.delete();
  }
}

function normalizeIlluminationGray(gray) {
  const scale = Math.min(1, 760 / Math.max(gray.cols, gray.rows));
  const small = new cv.Mat();
  const backgroundSmall = new cv.Mat();
  const background = new cv.Mat();
  const divided = new cv.Mat();
  const result = new cv.Mat();
  try {
    if (scale < 1) cv.resize(gray, small, new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)), 0, 0, cv.INTER_AREA);
    else gray.copyTo(small);
    const sigma = Math.max(14, Math.min(34, Math.max(small.cols, small.rows) * 0.035));
    cv.GaussianBlur(small, backgroundSmall, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REPLICATE);
    cv.resize(backgroundSmall, background, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_CUBIC);
    cv.divide(gray, background, divided, 255);
    cv.addWeighted(divided, 0.90, gray, 0.10, 0, result);
    return result.clone();
  } finally {
    small.delete(); backgroundSmall.delete(); background.delete(); divided.delete(); result.delete();
  }
}

function applyGentleClahe(gray) {
  const output = new cv.Mat();
  if (typeof cv.CLAHE !== 'function') {
    gray.copyTo(output);
    return output;
  }
  let clahe = null;
  const enhanced = new cv.Mat();
  try {
    clahe = new cv.CLAHE(1.7, new cv.Size(8, 8));
    clahe.apply(gray, enhanced);
    cv.addWeighted(gray, 0.82, enhanced, 0.18, 0, output);
    return output.clone();
  } catch (_) {
    gray.copyTo(output);
    return output.clone();
  } finally {
    if (clahe && clahe.delete) clahe.delete();
    enhanced.delete(); output.delete();
  }
}

function sharpenGray(gray, amount = 0.12) {
  const blur = new cv.Mat();
  const out = new cv.Mat();
  try {
    cv.GaussianBlur(gray, blur, new cv.Size(0, 0), 0.85, 0.85, cv.BORDER_REPLICATE);
    cv.addWeighted(gray, 1 + amount, blur, -amount, 0, out);
    return out.clone();
  } finally { blur.delete(); out.delete(); }
}

function cleanGray(warped) {
  const gray = new cv.Mat();
  let normalized = null;
  let local = null;
  let sharp = null;
  try {
    cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);
    normalized = normalizeIlluminationGray(gray);
    local = applyGentleClahe(normalized);
    sharp = sharpenGray(local, 0.10);
    return sharp.clone();
  } finally {
    gray.delete();
    if (normalized) normalized.delete();
    if (local) local.delete();
    if (sharp) sharp.delete();
  }
}

function cleanColor(warped) {
  const rgb = new cv.Mat();
  const lab = new cv.Mat();
  const channels = new cv.MatVector();
  const mergedChannels = new cv.MatVector();
  const mergedLab = new cv.Mat();
  const result = new cv.Mat();
  let normalized = null;
  let local = null;
  let sharp = null;
  let aSoft = null;
  let bSoft = null;
  try {
    cv.cvtColor(warped, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    cv.split(lab, channels);
    const l = channels.get(0);
    const a = channels.get(1);
    const b = channels.get(2);
    normalized = normalizeIlluminationGray(l);
    local = applyGentleClahe(normalized);
    sharp = sharpenGray(local, 0.09);
    aSoft = new cv.Mat();
    bSoft = new cv.Mat();
    a.convertTo(aSoft, -1, 0.96, 5.12);
    b.convertTo(bSoft, -1, 0.96, 5.12);
    mergedChannels.push_back(sharp);
    mergedChannels.push_back(aSoft);
    mergedChannels.push_back(bSoft);
    cv.merge(mergedChannels, mergedLab);
    cv.cvtColor(mergedLab, result, cv.COLOR_Lab2RGB);
    l.delete(); a.delete(); b.delete();
    return result.clone();
  } finally {
    rgb.delete(); lab.delete(); channels.delete(); mergedChannels.delete(); mergedLab.delete(); result.delete();
    if (normalized) normalized.delete();
    if (local) local.delete();
    if (sharp) sharp.delete();
    if (aSoft) aSoft.delete();
    if (bSoft) bSoft.delete();
  }
}

function enhanceDocument(warped, mode) {
  if (mode === 'original') {
    const original = new cv.Mat();
    cv.cvtColor(warped, original, cv.COLOR_RGBA2RGB);
    return original;
  }
  if (mode === 'clean') return cleanColor(warped);
  if (mode === 'gray') return cleanGray(warped);

  const gray = cleanGray(warped);
  const bw = new cv.Mat();
  try {
    let blockSize = Math.round(Math.min(gray.cols, gray.rows) * 0.025);
    blockSize = Math.max(31, Math.min(81, blockSize));
    if (blockSize % 2 === 0) blockSize += 1;
    cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, 11);
    return bw.clone();
  } finally { gray.delete(); bw.delete(); }
}

function putLastCaptureOnCanvas() {
  if (!lastCapture) throw new Error('No image is available.');
  captureCanvas.width = lastCapture.width;
  captureCanvas.height = lastCapture.height;
  captureCanvas.getContext('2d').putImageData(lastCapture, 0, 0);
}

function processCaptureToEditor(source = 'manual') {
  if (!cvReady) throw new Error('The scanner is still loading.');
  putLastCaptureOnCanvas();
  const src = cv.imread(captureCanvas);
  let warped = null;
  try {
    lastCaptureQuality = measureQualityMat(src);
    const detected = findDocumentQuad(src);
    const quad = detected ? detected.quad : fallbackQuad(src);
    warped = warpDocument(src, quad);
    warpedCanvas.width = warped.cols;
    warpedCanvas.height = warped.rows;
    cv.imshow(warpedCanvas, warped);
    activeFilter = 'clean';
    editRotation = 0;
    cropRect = { left: 0, top: 0, right: 1, bottom: 1 };
    renderCropFrame();
    renderFilterButtons();
    renderCurrentFilter();
    renderFilterPreviews();
    showScreen('editScreen');

    const warning = lastCaptureQuality.decision.warnings[0];
    if (!detected) showToast('Border detection was uncertain — adjust the crop if needed.', 3000);
    else if (warning) showToast(warning, 2800);
    else showToast(source === 'auto' ? 'Captured automatically' : 'Page detected and cleaned');
  } finally {
    src.delete();
    if (warped) warped.delete();
  }
}

function renderCurrentFilter() {
  if (!cvReady || !warpedCanvas.width) return;
  const warped = cv.imread(warpedCanvas);
  let enhanced = null;
  try {
    enhanced = enhanceDocument(warped, activeFilter);
    resultCanvas.width = enhanced.cols;
    resultCanvas.height = enhanced.rows;
    cv.imshow(resultCanvas, enhanced);
    drawCanvasRotated(resultCanvas, editCanvas, editRotation);
    renderCropFrame();
  } finally {
    warped.delete();
    if (enhanced) enhanced.delete();
  }
}

function renderFilterPreviews() {
  if (!cvReady || !warpedCanvas.width) return;
  const targets = [
    ['original', $('filterOriginal')],
    ['clean', $('filterBright')],
    ['gray', $('filterGray')],
    ['bw', $('filterBw')]
  ];
  const src = cv.imread(warpedCanvas);
  const small = new cv.Mat();
  try {
    const scale = Math.min(1, 260 / Math.max(src.cols, src.rows));
    if (scale < 1) cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    else src.copyTo(small);
    for (const [mode, canvas] of targets) {
      let out = null;
      try {
        out = enhanceDocument(small, mode);
        canvas.width = out.cols;
        canvas.height = out.rows;
        cv.imshow(canvas, out);
      } finally { if (out) out.delete(); }
    }
  } finally { src.delete(); small.delete(); }
}

function renderFilterButtons() {
  document.querySelectorAll('.filter-card').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === activeFilter));
}

function drawCanvasRotated(src, dst, degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  const sideways = normalized === 90 || normalized === 270;
  dst.width = sideways ? src.height : src.width;
  dst.height = sideways ? src.width : src.height;
  const ctx = dst.getContext('2d');
  ctx.save();
  ctx.clearRect(0, 0, dst.width, dst.height);
  ctx.translate(dst.width / 2, dst.height / 2);
  ctx.rotate(normalized * Math.PI / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.restore();
}

function rotateEditor(delta) {
  editRotation = (editRotation + delta + 360) % 360;
  cropRect = { left: 0, top: 0, right: 1, bottom: 1 };
  drawCanvasRotated(resultCanvas, editCanvas, editRotation);
  renderCropFrame();
}

function renderCropFrame() {
  const frame = document.querySelector('.crop-frame');
  if (!frame) return;
  frame.style.left = `${cropRect.left * 100}%`;
  frame.style.top = `${cropRect.top * 100}%`;
  frame.style.right = `${(1 - cropRect.right) * 100}%`;
  frame.style.bottom = `${(1 - cropRect.bottom) * 100}%`;
}

function updateCropFromPointer(handleClass, event) {
  const rect = editCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  const minSize = 0.12;
  const next = { ...cropRect };
  if (handleClass.includes('left')) next.left = Math.min(x, next.right - minSize);
  if (handleClass.includes('right')) next.right = Math.max(x, next.left + minSize);
  if (handleClass.includes('top')) next.top = Math.min(y, next.bottom - minSize);
  if (handleClass.includes('bottom')) next.bottom = Math.max(y, next.top + minSize);
  cropRect = next;
  renderCropFrame();
}

function bindCropHandles() {
  document.querySelectorAll('.crop-handle').forEach(handle => {
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const handleClass = [...handle.classList].filter(c => c !== 'crop-handle').join(' ');
      const move = e => updateCropFromPointer(handleClass, e);
      const up = e => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  });
}

function croppedCanvasFromEdit() {
  if (!editCanvas.width || !editCanvas.height) throw new Error('No page is ready.');
  const sx = Math.round(cropRect.left * editCanvas.width);
  const sy = Math.round(cropRect.top * editCanvas.height);
  const sw = Math.max(1, Math.round((cropRect.right - cropRect.left) * editCanvas.width));
  const sh = Math.max(1, Math.round((cropRect.bottom - cropRect.top) * editCanvas.height));
  const scale = Math.min(1, MAX_MASTER_SIDE / Math.max(sw, sh));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sw * scale));
  out.height = Math.max(1, Math.round(sh * scale));
  out.getContext('2d').drawImage(editCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

function commitEditedPage() {
  const out = croppedCanvasFromEdit();
  return {
    dataUrl: out.toDataURL('image/jpeg', 0.91),
    width: out.width,
    height: out.height,
    filter: activeFilter,
    createdAt: Date.now()
  };
}

function continueFromEditor() {
  const page = commitEditedPage();
  state.saved = false;
  if (state.scanMode === 'single') {
    state.pages = [page];
    state.selectedPage = 0;
    prepareExportScreen();
    return;
  }
  state.pages.push(page);
  state.selectedPage = state.pages.length - 1;
  renderReviewScreen();
  showScreen('reviewScreen');
}

function retakeCurrent() {
  if (currentInputKind === 'gallery') {
    openGallery(state.scanMode === 'multi');
    return;
  }
  showScreen('cameraScreen');
  startCamera();
}

function renderReviewScreen() {
  $('reviewCount').textContent = state.pages.length;
  const grid = $('pageGrid');
  grid.innerHTML = '';
  state.pages.forEach((page, index) => {
    const button = document.createElement('button');
    button.className = `page-tile${index === state.selectedPage ? ' selected' : ''}`;
    button.dataset.index = String(index);
    const img = document.createElement('img');
    img.src = page.dataUrl;
    img.alt = `Page ${index + 1}`;
    const number = document.createElement('span');
    number.className = 'page-number';
    number.textContent = String(index + 1);
    button.append(img, number);
    button.addEventListener('click', () => {
      state.selectedPage = index;
      renderReviewScreen();
    });
    grid.appendChild(button);
  });
  $('createPdfBtn').disabled = state.pages.length === 0;
  $('deletePageBtn').disabled = state.pages.length === 0;
  $('rotatePageBtn').disabled = state.pages.length === 0;
  $('reorderBtn').disabled = state.pages.length < 2;
  $('moveEarlierBtn').disabled = state.selectedPage <= 0;
  $('moveLaterBtn').disabled = state.selectedPage >= state.pages.length - 1;
  $('reorderBar').hidden = !reorderMode;
}

async function rotateStoredPage(index, degrees = 90) {
  const page = state.pages[index];
  if (!page) return;
  const img = await loadImage(page.dataUrl);
  const temp = document.createElement('canvas');
  temp.width = img.height;
  temp.height = img.width;
  const ctx = temp.getContext('2d');
  ctx.translate(temp.width / 2, temp.height / 2);
  ctx.rotate(degrees * Math.PI / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  page.dataUrl = temp.toDataURL('image/jpeg', 0.91);
  page.width = temp.width;
  page.height = temp.height;
  state.saved = false;
  renderReviewScreen();
}

function moveSelectedPage(delta) {
  const from = state.selectedPage;
  const to = from + delta;
  if (Core.moveItem(state.pages, from, to)) {
    state.selectedPage = to;
    state.saved = false;
    renderReviewScreen();
  }
}

function prepareExportScreen() {
  if (!state.pages.length) return showToast('Add at least one page first.');
  $('exportPreview').src = state.pages[0].dataUrl;
  $('filenameDisplay').textContent = Core.ensurePdfExtension(state.filename);
  const count = state.pages.length;
  const approxBytes = state.pages.reduce((total, p) => total + Core.estimateDataUrlBytes(p.dataUrl), 0);
  $('fileMeta').textContent = `${count} ${count === 1 ? 'page' : 'pages'}  •  ${Core.formatBytes(approxBytes)}`;
  $('fileDate').textContent = new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }).format(new Date());
  showScreen('exportScreen');
}

function openRenameModal() {
  $('filenameInput').value = state.filename.replace(/\.pdf$/i, '');
  $('renameModal').hidden = false;
  setTimeout(() => $('filenameInput').focus(), 50);
}

function closeRenameModal() { $('renameModal').hidden = true; }
function applyRename() {
  state.filename = Core.sanitizeFilename($('filenameInput').value);
  state.saved = false;
  $('filenameDisplay').textContent = state.filename;
  closeRenameModal();
}

function openGallery(asMulti = false) {
  if (!cvReady) return showToast('Scanner is still loading.');
  if (asMulti) setScanMode('multi');
  currentInputKind = 'gallery';
  filePicker.multiple = false;
  filePicker.value = '';
  filePicker.click();
}

async function loadGalleryFile(file) {
  if (!file) return;
  try {
    const img = await imageFromFile(file);
    const naturalW = img.naturalWidth || img.width;
    const naturalH = img.naturalHeight || img.height;
    const scale = Math.min(1, MAX_CAPTURE_SIDE / Math.max(naturalW, naturalH));
    const width = Math.max(1, Math.round(naturalW * scale));
    const height = Math.max(1, Math.round(naturalH * scale));
    captureCanvas.width = width;
    captureCanvas.height = height;
    const ctx = captureCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, width, height);
    lastCapture = ctx.getImageData(0, 0, width, height);
    stopCamera();
    processCaptureToEditor('gallery');
  } catch (err) {
    showToast(`Could not import image: ${err.message}`, 3200);
  }
}

function imageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image could not be opened.')); };
    img.src = url;
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be loaded.'));
    img.src = src;
  });
}

function updateFlashUi() {
  if (!$('flashLabel')) return;
  $('flashLabel').textContent = torchEnabled ? 'ON' : 'A';
  $('flashBtn').style.color = torchEnabled ? '#38e1cd' : '#fff';
}

async function toggleTorch() {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) return showToast('Camera is not active.');
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.torch) return showToast('Torch control is not available on this phone.');
    torchEnabled = !torchEnabled;
    await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
    updateFlashUi();
  } catch (_) {
    torchEnabled = false;
    updateFlashUi();
    showToast('Torch could not be changed.');
  }
}

function updateAutoUi() {
  $('autoBtn').classList.toggle('disabled', !autoCaptureEnabled);
  $('autoBtn').innerHTML = autoCaptureEnabled ? '<span>⚡</span> Auto' : '<span>◉</span> Manual';
  $('autoCaptureToggle').checked = autoCaptureEnabled;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not encode PDF.'));
    reader.onload = () => {
      const value = String(reader.result || '');
      const comma = value.indexOf(',');
      comma < 0 ? reject(new Error('Could not encode PDF.')) : resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

async function savePdfToDevice() {
  if (!state.pages.length) throw new Error('No pages are available.');
  const blob = Core.buildPdfFromPages(state.pages);
  const filename = Core.sanitizeFilename(state.filename);
  if (window.AndroidBridge?.savePdf) {
    const base64 = await blobToBase64(blob);
    window.AndroidBridge.savePdf(filename, base64);
    showToast('Choose where to save your PDF.');
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  state.saved = true;
  rememberRecentScan(filename, blob.size);
  showToast('PDF downloaded.');
}

async function sharePdf() {
  if (!state.pages.length) throw new Error('No pages are available.');
  const blob = Core.buildPdfFromPages(state.pages);
  const filename = Core.sanitizeFilename(state.filename);
  if (window.AndroidBridge?.sharePdf) {
    const base64 = await blobToBase64(blob);
    window.AndroidBridge.sharePdf(filename, base64);
    return;
  }
  if (navigator.share && navigator.canShare) {
    const file = new File([blob], filename, { type:'application/pdf' });
    if (navigator.canShare({ files:[file] })) return navigator.share({ files:[file], title: filename });
  }
  showToast('Sharing is not available here.');
}

function readRecents() {
  try {
    const value = JSON.parse(localStorage.getItem('scanner-recents-v2') || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) { return []; }
}

function rememberRecentScan(filename, bytes = 0) {
  try {
    const current = readRecents();
    const item = {
      name: Core.sanitizeFilename(filename),
      pages: state.pages.length,
      bytes: Number(bytes) || state.pages.reduce((total, p) => total + Core.estimateDataUrlBytes(p.dataUrl), 0),
      date: Date.now()
    };
    const next = [item, ...current.filter(x => x.name !== item.name)].slice(0, 20);
    localStorage.setItem('scanner-recents-v2', JSON.stringify(next));
    renderRecentScans();
  } catch (_) {}
}

function renderRecentScans() {
  const list = $('recentList');
  const all = readRecents();
  const items = recentsExpanded ? all : all.slice(0, 6);
  list.innerHTML = '';
  $('seeAllBtn').textContent = recentsExpanded ? 'Show less' : 'See all';
  $('seeAllBtn').hidden = all.length <= 6;
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.innerHTML = '<div><strong>No scans yet</strong><br><span>Your saved documents will appear here.</span></div>';
    list.appendChild(empty);
    return;
  }
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'recent-item';
    row.tabIndex = 0;
    const img = document.createElement('div');
    img.className = 'recent-thumb recent-pdf-icon';
    img.textContent = 'PDF';
    const copy = document.createElement('div');
    copy.className = 'recent-copy';
    const strong = document.createElement('strong'); strong.textContent = item.name;
    const span = document.createElement('span'); span.textContent = `${item.pages || 1} ${(item.pages || 1) === 1 ? 'page' : 'pages'}${item.bytes ? ` • ${Core.formatBytes(item.bytes)}` : ''}`;
    const small = document.createElement('small'); small.textContent = new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(new Date(item.date));
    copy.append(strong, span, small);
    const more = document.createElement('button');
    more.className = 'recent-more';
    more.textContent = '⋮';
    more.setAttribute('aria-label', `Share ${item.name}`);
    more.addEventListener('click', e => {
      e.stopPropagation();
      if (window.AndroidBridge?.shareSavedPdf) window.AndroidBridge.shareSavedPdf(item.name);
      else showToast('Saved scan sharing is available in the Android app.');
    });
    const open = () => {
      if (window.AndroidBridge?.openSavedPdf) window.AndroidBridge.openSavedPdf(item.name);
      else showToast('Open the saved PDF from your Downloads or Files app.');
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    row.append(img, copy, more);
    list.appendChild(row);
  });
}

function clearRecentHistory() {
  localStorage.removeItem('scanner-recents-v2');
  if (window.AndroidBridge?.clearSavedScans) window.AndroidBridge.clearSavedScans();
  renderRecentScans();
  showToast('Recent scan history cleared.');
}

function openSettings() { $('settingsModal').hidden = false; }
function closeSettings() { $('settingsModal').hidden = true; }
function openInfo() { $('infoModal').hidden = false; }
function closeInfo() { $('infoModal').hidden = true; }

function confirmDiscard(action) {
  if (!state.pages.length && !lastCapture) {
    action();
    return;
  }
  pendingDiscardAction = action;
  $('discardModal').hidden = false;
}

function closeDiscard() {
  pendingDiscardAction = null;
  $('discardModal').hidden = true;
}

function discardAndContinue() {
  const action = pendingDiscardAction;
  pendingDiscardAction = null;
  $('discardModal').hidden = true;
  stopCamera();
  resetDocument();
  if (action) action();
}

function goHomeRespectingUnsaved() {
  if (state.saved || (!state.pages.length && !lastCapture)) {
    stopCamera();
    resetDocument();
    showScreen('homeScreen');
    renderRecentScans();
    return;
  }
  confirmDiscard(() => {
    showScreen('homeScreen');
    renderRecentScans();
  });
}

function handleBack() {
  if (!$('renameModal').hidden) { closeRenameModal(); return true; }
  if (!$('settingsModal').hidden) { closeSettings(); return true; }
  if (!$('infoModal').hidden) { closeInfo(); return true; }
  if (!$('discardModal').hidden) { closeDiscard(); return true; }

  const target = Core.backTarget(currentScreenId, state);
  if (target === 'exit') return false;
  if (target === 'confirm-discard') {
    goHomeRespectingUnsaved();
    return true;
  }
  if (target === 'homeScreen') {
    stopCamera();
    showScreen('homeScreen');
    return true;
  }
  if (target === 'cameraScreen') {
    showScreen('cameraScreen');
    startCamera();
    return true;
  }
  if (target === 'reviewScreen') {
    stopCamera();
    renderReviewScreen();
    showScreen('reviewScreen');
    return true;
  }
  if (target === 'editScreen') {
    showScreen('editScreen');
    return true;
  }
  return false;
}

window.handleNativeBack = handleBack;
window.onNativePause = () => { if (currentScreenId === 'cameraScreen') stopCamera(); };
window.onNativeResume = () => { if (currentScreenId === 'cameraScreen' && !stream) startCamera(); };
window.onNativePdfSaved = function(filename, bytes) {
  state.saved = true;
  state.filename = Core.sanitizeFilename(filename || state.filename);
  rememberRecentScan(state.filename, Number(bytes) || 0);
  showToast('PDF saved.');
};
window.onNativePdfSaveCancelled = () => showToast('Save cancelled.');

// Home
$('singleScanBtn').addEventListener('click', () => beginNewScan('single'));
$('multiScanBtn').addEventListener('click', () => beginNewScan('multi'));
$('importBtn').addEventListener('click', () => { resetDocument(); setScanMode('single'); openGallery(false); });
$('menuBtn').addEventListener('click', openSettings);
$('proBtn').addEventListener('click', openInfo);
$('seeAllBtn').addEventListener('click', () => { recentsExpanded = !recentsExpanded; renderRecentScans(); });

// Camera
$('closeCameraBtn').addEventListener('click', () => {
  if (state.scanMode === 'multi' && state.pages.length) {
    stopCamera(); renderReviewScreen(); showScreen('reviewScreen');
  } else goHomeRespectingUnsaved();
});
$('singleModeBtn').addEventListener('click', () => setScanMode('single'));
$('multiModeBtn').addEventListener('click', () => setScanMode('multi'));
$('cameraGalleryBtn').addEventListener('click', () => openGallery(state.scanMode === 'multi'));
$('flashBtn').addEventListener('click', toggleTorch);
$('cameraSettingsBtn').addEventListener('click', openSettings);
$('autoBtn').addEventListener('click', () => { autoCaptureEnabled = !autoCaptureEnabled; updateAutoUi(); stableFrames = 0; });
$('finishMultiBtn').addEventListener('click', () => { stopCamera(); renderReviewScreen(); showScreen('reviewScreen'); });
$('captureBtn').addEventListener('click', () => performCapture('manual'));

// Crop & Enhance
$('filterStrip').addEventListener('click', event => {
  const btn = event.target.closest('.filter-card');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  renderFilterButtons();
  try { renderCurrentFilter(); } catch (err) { showToast(err.message); }
});
$('rotateLeftBtn').addEventListener('click', () => rotateEditor(-90));
$('rotateRightBtn').addEventListener('click', () => rotateEditor(90));
$('enhanceBtn').addEventListener('click', () => {
  activeFilter = 'clean';
  renderFilterButtons();
  renderCurrentFilter();
  showToast('Auto enhancement applied.');
});
$('retakeBtn').addEventListener('click', retakeCurrent);
$('continueBtn').addEventListener('click', () => { try { continueFromEditor(); } catch (err) { showToast(err.message); } });
$('editConfirmBtn').addEventListener('click', () => { try { continueFromEditor(); } catch (err) { showToast(err.message); } });
$('editBackBtn').addEventListener('click', () => handleBack());

// Review
$('addPageBtn').addEventListener('click', enterCameraForAdditionalPage);
$('reviewBackBtn').addEventListener('click', () => goHomeRespectingUnsaved());
$('deletePageBtn').addEventListener('click', () => {
  if (!state.pages.length) return;
  state.pages.splice(state.selectedPage, 1);
  state.saved = false;
  state.selectedPage = Math.max(0, Math.min(state.selectedPage, state.pages.length - 1));
  if (!state.pages.length) { reorderMode = false; enterCameraForAdditionalPage(); return; }
  renderReviewScreen();
});
$('rotatePageBtn').addEventListener('click', () => rotateStoredPage(state.selectedPage));
$('reorderBtn').addEventListener('click', () => { reorderMode = !reorderMode; renderReviewScreen(); });
$('moveEarlierBtn').addEventListener('click', () => moveSelectedPage(-1));
$('moveLaterBtn').addEventListener('click', () => moveSelectedPage(1));
$('createPdfBtn').addEventListener('click', prepareExportScreen);

// Export
$('exportBackBtn').addEventListener('click', () => handleBack());
$('homeBtn').addEventListener('click', goHomeRespectingUnsaved);
$('editNameBtn').addEventListener('click', openRenameModal);
$('renameBtn').addEventListener('click', openRenameModal);
$('cancelRenameBtn').addEventListener('click', closeRenameModal);
$('applyRenameBtn').addEventListener('click', applyRename);
$('filenameInput').addEventListener('keydown', e => { if (e.key === 'Enter') applyRename(); });
$('saveDeviceBtn').addEventListener('click', async () => { try { await savePdfToDevice(); } catch (err) { showToast(err.message, 3200); } });
$('shareBtn').addEventListener('click', async () => { try { await sharePdf(); } catch (err) { showToast(err.message, 3200); } });

// Modals / settings
$('renameModal').addEventListener('click', e => { if (e.target === $('renameModal')) closeRenameModal(); });
$('settingsModal').addEventListener('click', e => { if (e.target === $('settingsModal')) closeSettings(); });
$('infoModal').addEventListener('click', e => { if (e.target === $('infoModal')) closeInfo(); });
$('discardModal').addEventListener('click', e => { if (e.target === $('discardModal')) closeDiscard(); });
$('closeSettingsBtn').addEventListener('click', closeSettings);
$('closeInfoBtn').addEventListener('click', closeInfo);
$('autoCaptureToggle').addEventListener('change', e => { autoCaptureEnabled = Boolean(e.target.checked); updateAutoUi(); stableFrames = 0; });
$('clearHistoryBtn').addEventListener('click', clearRecentHistory);
$('keepScanBtn').addEventListener('click', closeDiscard);
$('discardScanBtn').addEventListener('click', discardAndContinue);

filePicker.addEventListener('change', () => loadGalleryFile(filePicker.files?.[0]));
window.addEventListener('beforeunload', stopCamera);
window.addEventListener('pagehide', stopCamera);

bindCropHandles();
updateAutoUi();
renderRecentScans();
showScreen('homeScreen');

window.ScannerDebug = {
  getState: () => ({ ...state, pages: state.pages.map(p => ({ width:p.width, height:p.height, filter:p.filter })) }),
  getScreen: () => currentScreenId,
  showScreen,
  setScanMode,
  prepareExportScreen,
  handleBack,
  Core
};
