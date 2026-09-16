/**
 * Audio-mode cover helpers: data-URL checks, resize, JPEG quality steps,
 * and the one-time move off settings.audio.imageUrl. Pure — no chrome.
 */

import {
  AUDIO_COVER_KEY,
  COVER_MAX_INPUT_BYTES,
  COVER_MAX_STORED_BYTES,
  COVER_MAX_SIDE,
  COVER_JPEG_QUALITY,
  isCoverDataUrl,
  coverOutputSize,
  nextCoverJpegQuality,
  planAudioCoverMigration,
} from '../src/lib/cover.js';

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default async function run(t) {
  t.section('isCoverDataUrl');

  t.check('a jpeg data URL is kept', isCoverDataUrl('data:image/jpeg;base64,aaa') === true);
  t.check('a png data URL is kept', isCoverDataUrl('data:image/png;base64,aaa') === true);
  t.check('https is refused', isCoverDataUrl('https://example.com/bg.jpg') === false);
  t.check('http is refused', isCoverDataUrl('http://example.com/bg.jpg') === false);
  t.check('javascript is refused', isCoverDataUrl('javascript:alert(1)') === false);
  t.check('data:text is refused', isCoverDataUrl('data:text/html,hi') === false);
  t.check('a quote is refused', isCoverDataUrl('data:image/png;base64,aa"aa') === false);
  t.check('a backslash is refused', isCoverDataUrl('data:image/png;base64,aa\\aa') === false);
  t.check('empty is refused', isCoverDataUrl('') === false);
  t.check('whitespace is refused', isCoverDataUrl('   ') === false);
  t.check('non-string is refused', isCoverDataUrl(1) === false);
  t.check('null is refused', isCoverDataUrl(null) === false);

  t.section('coverOutputSize');

  t.check(
    'a 1280 square is unchanged',
    same(coverOutputSize(1280, 1280), { width: 1280, height: 1280 }),
  );
  t.check(
    'a smaller picture is unchanged',
    same(coverOutputSize(800, 600), { width: 800, height: 600 }),
  );
  t.check(
    'a 2560×1440 scales to 1280 on the long side',
    same(coverOutputSize(2560, 1440), { width: 1280, height: 720 }),
  );
  t.check(
    'a tall picture scales on height',
    same(coverOutputSize(900, 2000), { width: 576, height: 1280 }),
  );
  t.check('the long-side cap is 1280', COVER_MAX_SIDE === 1280);

  t.section('JPEG quality steps');

  t.check('start quality is ~0.82', COVER_JPEG_QUALITY === 0.82);
  t.check('stored cap is 600 KB', COVER_MAX_STORED_BYTES === 600 * 1024);
  t.check('input cap is 10 MB', COVER_MAX_INPUT_BYTES === 10 * 1024 * 1024);
  t.check(
    'a 500 KB blob is accepted',
    nextCoverJpegQuality(0.82, 500 * 1024) === null,
  );
  t.check(
    'exactly 600 KB is accepted',
    nextCoverJpegQuality(0.82, COVER_MAX_STORED_BYTES) === null,
  );
  t.check(
    'a 601 KB blob steps quality down',
    nextCoverJpegQuality(0.82, COVER_MAX_STORED_BYTES + 1) === 0.74,
  );
  t.check(
    'a second step goes to 0.66',
    nextCoverJpegQuality(0.74, COVER_MAX_STORED_BYTES + 1) === 0.66,
  );
  t.check(
    'quality at the floor still too big gives up',
    nextCoverJpegQuality(0.5, COVER_MAX_STORED_BYTES + 1) === false,
  );
  t.check(
    'a non-number quality gives up',
    nextCoverJpegQuality('nope', COVER_MAX_STORED_BYTES + 1) === false,
  );

  t.section('migration plan');

  const data = 'data:image/jpeg;base64,aaa';
  const https = 'https://example.com/bg.jpg';

  const fromData = planAudioCoverMigration({ audio: { imageUrl: data } }, '');
  t.check('a data imageUrl moves when the cover key is empty', fromData.writeCover === true);
  t.check('the moved cover is the data URL', fromData.cover === data);
  t.check('the settings field is stripped after a move', fromData.stripImageUrl === true);

  const fromHttps = planAudioCoverMigration({ audio: { imageUrl: https } }, '');
  t.check('an https imageUrl is not written to the cover key', fromHttps.writeCover === false);
  t.check('an https imageUrl leaves the cover empty', fromHttps.cover === '');
  t.check('an https imageUrl is still stripped from settings', fromHttps.stripImageUrl === true);

  const keep = planAudioCoverMigration({ audio: { imageUrl: data } }, data);
  t.check('an existing cover is not overwritten', keep.writeCover === false && keep.cover === data);
  t.check('settings still lose imageUrl when a cover already exists', keep.stripImageUrl === true);

  const noop = planAudioCoverMigration({ audio: { preset: 'midnight' } }, '');
  t.check('no imageUrl is a no-op', noop.writeCover === false && noop.stripImageUrl === false);

  const emptyField = planAudioCoverMigration({ audio: { imageUrl: '' } }, '');
  t.check('an empty imageUrl still strips the field', emptyField.stripImageUrl === true && emptyField.writeCover === false);

  t.check('the storage key is audioCover', AUDIO_COVER_KEY === 'audioCover');
}
