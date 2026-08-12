const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../app/src/main/assets/scanner-core.js');

test('filename handling is safe and always produces PDF extension', () => {
  assert.equal(Core.ensurePdfExtension('Contract'), 'Contract.pdf');
  assert.equal(Core.ensurePdfExtension('Contract.PDF'), 'Contract.PDF');
  assert.equal(Core.sanitizeFilename('A/B:*?"<>|'), 'A-B-------.pdf');
});

test('page movement keeps page order deterministic', () => {
  const pages = ['a', 'b', 'c'];
  assert.equal(Core.moveItem(pages, 2, 0), true);
  assert.deepEqual(pages, ['c', 'a', 'b']);
  assert.equal(Core.moveItem(pages, -1, 1), false);
});

test('quad score rewards a large rectangular document', () => {
  const good = Core.scoreQuad([{x:100,y:100},{x:900,y:100},{x:900,y:1300},{x:100,y:1300}], 1000, 1400);
  const tiny = Core.scoreQuad([{x:10,y:10},{x:150,y:10},{x:150,y:120},{x:10,y:120}], 1000, 1400);
  assert.ok(good.score > 0.8, `expected good score, got ${good.score}`);
  assert.ok(good.score > tiny.score);
});

test('quality decision rejects a flat blurry frame and accepts a detailed frame', () => {
  const flat = new Uint8Array(100 * 100).fill(120);
  const bad = Core.qualityDecision(Core.analyzeGrayPixels(flat, 100, 100));
  assert.equal(bad.blocking, true);

  const detailed = new Uint8Array(100 * 100);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) detailed[y * 100 + x] = ((x >> 2) + (y >> 2)) % 2 ? 25 : 240;
  const good = Core.qualityDecision(Core.analyzeGrayPixels(detailed, 100, 100));
  assert.equal(good.blocking, false);
  assert.ok(good.score > bad.score);
});

test('single and multi back navigation is predictable', () => {
  const single = Core.createInitialState();
  assert.equal(Core.backTarget('cameraScreen', single), 'homeScreen');
  assert.equal(Core.backTarget('exportScreen', single), 'editScreen');
  const multi = Core.createInitialState();
  multi.scanMode = 'multi';
  multi.pages.push({});
  assert.equal(Core.backTarget('cameraScreen', multi), 'reviewScreen');
  assert.equal(Core.backTarget('reviewScreen', multi), 'confirm-discard');
});

test('PDF writer produces a structurally valid multi-page PDF header/trailer', async () => {
  // Minimal valid 1x1 white JPEG.
  const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z';
  const page = { dataUrl: `data:image/jpeg;base64,${jpeg}`, width: 1, height: 1 };
  const blob = Core.buildPdfFromPages([page, page]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.includes('/Count 2'));
  assert.ok(text.includes('%%EOF'));
});
