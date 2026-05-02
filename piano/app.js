import { parseMidi, extractNotes, midiNoteName } from './midi-parser.js';
import { SynthPlayer, INSTRUMENTS } from './synth.js';
import { Playback } from './playback.js';
import { LESSONS, lessonToSong, HAND_LABELS } from './lessons.js';

const synth = new SynthPlayer();
let currentSong = null;        // { midi, extracted, source } — last loaded piece
const playback = new Playback({
  synth,
  onTick: (t) => onPlaybackTick(t),
  onCountStart:    () => resetScore(),
  onSongStart:     () => startScoring(),
  onSongComplete:  () => onSongComplete(),
});

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DIATONIC_STEP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const IS_SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];

const SVG_NS = 'http://www.w3.org/2000/svg';
const STAFF_LEFT = 90;
const SONG_START_X = 140;     // first note's x position (after clef + opening bar)
const SONG_END_PAD = 30;
const PX_PER_QUARTER = 80;
const NOTE_X = 110;           // live keyboard input position (between clef and song)
const REF_STEP = 38;          // F5 totalDiatonicSteps
const STAFF_TOP_Y = 50;       // y of F5 (top treble line)
const STEP_Y = 5;             // px per diatonic step

let totalWidth = 800;
let songLoaded = false;

const staff = document.getElementById('staff');
const statusEl = document.getElementById('midi-status');
const pressedListEl = document.getElementById('pressed-notes');
const deviceListEl = document.getElementById('device-list');

const pressed = new Map();        // midi -> velocity
const noteElements = new Map();   // midi -> SVG group

function midiToInfo(midi) {
  const n = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return {
    name: NOTE_NAMES[n] + octave,
    totalSteps: octave * 7 + DIATONIC_STEP[n],
    sharp: IS_SHARP[n],
  };
}

function stepToY(totalSteps) {
  return STAFF_TOP_Y + (REF_STEP - totalSteps) * STEP_Y;
}

function getLedgerSteps(s) {
  const lines = [];
  if (s >= 40) {
    for (let l = 40; l <= s; l += 2) lines.push(l);
  } else if (s === 28) {
    lines.push(28);
  } else if (s <= 16) {
    for (let l = 16; l >= s; l -= 2) lines.push(l);
  }
  return lines;
}

function svg(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

function setupStaff() {
  staff.innerHTML = '';
  staff.appendChild(svg('g', { id: 'base-layer' }));
  staff.appendChild(svg('g', { id: 'song-layer' }));
  staff.appendChild(svg('g', { id: 'played-layer' }));
  const phLayer = svg('g', { id: 'playhead-layer' });
  phLayer.appendChild(svg('line', {
    id: 'playhead',
    x1: 0, x2: 0, y1: 30, y2: 170,
    class: 'playhead', display: 'none',
  }));
  staff.appendChild(phLayer);
  staff.appendChild(svg('g', { id: 'live-layer' }));
}

function setPlayheadX(x) {
  const ph = document.getElementById('playhead');
  if (!ph) return;
  if (x == null) {
    ph.setAttribute('display', 'none');
    return;
  }
  ph.setAttribute('display', 'inline');
  ph.setAttribute('x1', x);
  ph.setAttribute('x2', x);

  // Auto-scroll the staff to keep the playhead at ~30% from the left edge.
  const section = document.getElementById('staff-section');
  const target = Math.max(0, x - section.clientWidth * 0.3);
  section.scrollLeft = target;
}

function onPlaybackTick(t) {
  if (t == null || !currentSong) {
    setPlayheadX(null);
    updatePlayButton();
    return;
  }
  const bpm = currentSong.extracted.initialBpm;
  const pxPerSec = PX_PER_QUARTER * bpm / 60;
  setPlayheadX(SONG_START_X + t * pxPerSec);
  if (scoreState.active) updateScoreDisplay(computeScore());
}

function setStaffWidth(w) {
  totalWidth = w;
  staff.setAttribute('viewBox', `0 0 ${w} 200`);
  staff.setAttribute('width', w);
  staff.setAttribute('height', 200);
}

function drawStaffBase() {
  const layer = document.getElementById('base-layer');
  layer.innerHTML = '';
  const endX = totalWidth - SONG_END_PAD;

  // Treble lines y = 50..90, bass lines y = 110..150
  for (let i = 0; i < 5; i++) {
    layer.appendChild(svg('line', {
      x1: STAFF_LEFT, x2: endX, y1: 50 + i * 10, y2: 50 + i * 10, class: 'staff-line',
    }));
    layer.appendChild(svg('line', {
      x1: STAFF_LEFT, x2: endX, y1: 110 + i * 10, y2: 110 + i * 10, class: 'staff-line',
    }));
  }

  layer.appendChild(svg('line', {
    x1: STAFF_LEFT, x2: STAFF_LEFT, y1: 50, y2: 150, class: 'bar-line',
  }));
  layer.appendChild(svg('line', {
    x1: endX, x2: endX, y1: 50, y2: 150, class: 'bar-line',
  }));

  // SMuFL convention: treble-clef baseline at the G line, bass-clef baseline at
  // the F line. Font-size 40 = 4 staff spaces so each clef fits its own staff.
  layer.appendChild(svg('text', { x: 57, y: 82,  class: 'clef treble' }, '\u{1D11E}'));
  layer.appendChild(svg('text', { x: 53, y: 150, class: 'clef bass'   }, '\u{1D122}'));
}

function addNote(midi) {
  if (noteElements.has(midi)) return;
  const { totalSteps, sharp } = midiToInfo(midi);
  const y = stepToY(totalSteps);

  const g = svg('g', { class: 'note', 'data-midi': midi });

  for (const ls of getLedgerSteps(totalSteps)) {
    const ly = stepToY(ls);
    g.appendChild(svg('line', {
      x1: NOTE_X - 11, x2: NOTE_X + 11,
      y1: ly, y2: ly, class: 'ledger-line',
    }));
  }

  g.appendChild(svg('ellipse', {
    cx: NOTE_X, cy: y, rx: 8, ry: 6,
    class: 'notehead',
    transform: `rotate(-20 ${NOTE_X} ${y})`,
  }));

  if (sharp) {
    g.appendChild(svg('text', {
      x: NOTE_X - 22, y: y + 5, class: 'accidental',
    }, '♯'));
  }

  document.getElementById('live-layer').appendChild(g);
  noteElements.set(midi, g);
}

function removeNote(midi) {
  const g = noteElements.get(midi);
  if (g) {
    g.remove();
    noteElements.delete(midi);
  }
}

function renderPressedList() {
  pressedListEl.innerHTML = '';
  if (pressed.size === 0) {
    pressedListEl.appendChild(Object.assign(document.createElement('li'), {
      className: 'empty', textContent: '–',
    }));
    return;
  }
  const sorted = [...pressed.keys()].sort((a, b) => a - b);
  for (const midi of sorted) {
    const { name } = midiToInfo(midi);
    const li = document.createElement('li');
    li.textContent = `${name.padEnd(4)} midi=${midi} vel=${pressed.get(midi)}`;
    pressedListEl.appendChild(li);
  }
}

function handleMidiMessage(e) {
  const [statusByte, data1, data2] = e.data;
  const cmd = statusByte & 0xF0;

  // Note on with velocity > 0 = press; note off OR note-on velocity 0 = release.
  if (cmd === 0x90 && data2 > 0) {
    pressed.set(data1, data2);
    addNote(data1);
    renderPressedList();
    synth.noteOn(data1, data2);
    recordUserPlay(data1);
  } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
    pressed.delete(data1);
    removeNote(data1);
    renderPressedList();
    synth.noteOff(data1);
  }
}

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + kind;
}

function refreshDevices(access) {
  const inputs = [...access.inputs.values()];
  deviceListEl.innerHTML = '';
  if (inputs.length === 0) {
    deviceListEl.appendChild(Object.assign(document.createElement('li'), {
      className: 'empty', textContent: 'No MIDI inputs',
    }));
    setStatus('No MIDI keyboard detected — plug one in', 'disconnected');
    return;
  }
  for (const input of inputs) {
    input.onmidimessage = handleMidiMessage;
    const li = document.createElement('li');
    li.textContent = `${input.name} (${input.manufacturer || 'unknown'})`;
    deviceListEl.appendChild(li);
  }
  setStatus(`Connected: ${inputs.length} device${inputs.length > 1 ? 's' : ''}`, 'connected');
}

// ---------- Song rendering ----------

function renderSong(midi, extracted) {
  const songLayer = document.getElementById('song-layer');
  songLayer.innerHTML = '';

  const { notes, timeSig } = extracted;
  if (notes.length === 0) {
    setStaffWidth(800);
    drawStaffBase();
    songLoaded = false;
    return;
  }

  // Beats-per-measure in quarter-note units (so PX_PER_QUARTER converts cleanly).
  const beatsPerMeasure = timeSig
    ? timeSig.numerator * (4 / timeSig.denominator)
    : 4;

  const lastTick = Math.max(...notes.map(n => n.endTick));
  const totalQuarters = lastTick / midi.ticksPerQuarter;
  const songPxWidth = Math.max(totalQuarters * PX_PER_QUARTER, 200);

  // Round song width up to a full measure so the closing bar lines up.
  const measurePx = beatsPerMeasure * PX_PER_QUARTER;
  const paddedSongPx = Math.ceil(songPxWidth / measurePx) * measurePx;

  setStaffWidth(SONG_START_X + paddedSongPx + SONG_END_PAD);
  drawStaffBase();

  // Measure 1 number, then bar lines at every measure boundary.
  songLayer.appendChild(svg('text', {
    x: SONG_START_X + 4, y: 42, class: 'measure-number',
  }, '1'));

  const totalMeasures = Math.ceil(totalQuarters / beatsPerMeasure);
  for (let m = 1; m <= totalMeasures; m++) {
    const x = SONG_START_X + m * measurePx;
    songLayer.appendChild(svg('line', {
      x1: x, x2: x, y1: 50, y2: 150, class: 'measure-line',
    }));
    if (m < totalMeasures) {
      songLayer.appendChild(svg('text', {
        x: x + 4, y: 42, class: 'measure-number',
      }, String(m + 1)));
    }
  }

  for (const n of notes) addSongNote(songLayer, midi, n);

  songLoaded = true;
}

function addSongNote(layer, midi, n) {
  const { totalSteps, sharp } = midiToInfo(n.midi);
  const y = stepToY(totalSteps);
  const x = SONG_START_X + (n.startTick / midi.ticksPerQuarter) * PX_PER_QUARTER;
  const fullW = ((n.endTick - n.startTick) / midi.ticksPerQuarter) * PX_PER_QUARTER;
  const barW = Math.max(fullW - 8, 0);
  const handClass = n.hand ? `hand-${n.hand}` : '';

  const g = svg('g', { class: 'song-note', 'data-midi': n.midi });

  for (const ls of getLedgerSteps(totalSteps)) {
    const ly = stepToY(ls);
    g.appendChild(svg('line', {
      x1: x - 8, x2: x + 8, y1: ly, y2: ly, class: 'ledger-line',
    }));
  }

  if (barW > 6) {
    g.appendChild(svg('rect', {
      x: x + 4, y: y - 2.5,
      width: barW, height: 5,
      rx: 2, ry: 2,
      class: `duration-bar ${handClass}`.trim(),
    }));
  }

  g.appendChild(svg('ellipse', {
    cx: x, cy: y, rx: 6, ry: 4.5,
    class: `song-notehead ${handClass}`.trim(),
    transform: `rotate(-20 ${x} ${y})`,
  }));

  if (sharp) {
    g.appendChild(svg('text', {
      x: x - 16, y: y + 5, class: 'accidental',
    }, '♯'));
  }

  layer.appendChild(g);
}

// ---------- MIDI file loading ----------

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileInfoEl = document.getElementById('file-info');
const fileSummaryEl = document.getElementById('file-summary');
const notePreviewEl = document.getElementById('note-preview');

function renderLessonInfo(lesson, extracted) {
  document.getElementById('info-heading').textContent = 'Lesson';
  document.getElementById('note-preview-container').style.display = 'none';

  const rows = [
    ['Lesson',   lesson.title.replace(/^\d+\.\s*/, '')],
    ['Hand',     HAND_LABELS[lesson.hand]],
    ['Tempo',    `${lesson.bpm} BPM`],
    ['Time sig', `${lesson.timeSig.numerator}/${lesson.timeSig.denominator}`],
    ['Notes',    String(extracted.notes.length)],
    ['Duration', `${extracted.duration.toFixed(1)} s`],
  ];

  fileSummaryEl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    fileSummaryEl.appendChild(dt);
    fileSummaryEl.appendChild(dd);
  }
  fileInfoEl.classList.remove('hidden');
}

function renderFileInfo(filename, midi, extracted) {
  document.getElementById('info-heading').textContent = 'File';
  document.getElementById('note-preview-container').style.display = '';

  const { notes, initialBpm, timeSig, duration } = extracted;
  const pitches = notes.map(n => n.midi);
  const lo = pitches.length ? Math.min(...pitches) : null;
  const hi = pitches.length ? Math.max(...pitches) : null;

  const rows = [
    ['File',     filename],
    ['Format',   String(midi.format)],
    ['Tracks',   String(midi.numTracks)],
    ['PPQ',      String(midi.ticksPerQuarter)],
    ['Tempo',    `${initialBpm.toFixed(1)} BPM`],
    ['Time sig', timeSig ? `${timeSig.numerator}/${timeSig.denominator}` : '—'],
    ['Notes',    String(notes.length)],
    ['Duration', `${duration.toFixed(2)} s`],
    ['Range',    lo != null ? `${midiNoteName(lo)}–${midiNoteName(hi)} (${lo}–${hi})` : '—'],
  ];

  fileSummaryEl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    fileSummaryEl.appendChild(dt);
    fileSummaryEl.appendChild(dd);
  }

  notePreviewEl.innerHTML = '';
  for (const n of notes.slice(0, 20)) {
    const li = document.createElement('li');
    const dur = (n.endSec - n.startSec).toFixed(2);
    li.textContent =
      `${n.startSec.toFixed(2).padStart(6)}s  ${midiNoteName(n.midi).padEnd(4)}` +
      `  dur=${dur}s  trk=${n.track}  vel=${n.velocity}`;
    notePreviewEl.appendChild(li);
  }

  fileInfoEl.classList.remove('hidden');
}

function loadSong({ midi, extracted, source }) {
  playback.stop();
  currentSong = { midi, extracted, source };
  clearPlayedNotes();
  renderSong(midi, extracted);
  playback.load(midi, extracted);

  if (source.kind === 'lesson') {
    renderLessonInfo(source.lesson, extracted);
  } else {
    renderFileInfo(source.filename, midi, extracted);
  }

  document.getElementById('transport').classList.remove('hidden');
  resetScore();
  updatePlayButton();
}

async function loadMidiFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const midi = parseMidi(buf);
    const extracted = extractNotes(midi);
    loadSong({ midi, extracted, source: { kind: 'file', filename: file.name } });
    console.log('Parsed MIDI:', { midi, extracted });
  } catch (err) {
    fileSummaryEl.innerHTML = '';
    notePreviewEl.innerHTML = '';
    const dt = document.createElement('dt'); dt.textContent = 'Error';
    const dd = document.createElement('dd'); dd.textContent = err.message;
    fileSummaryEl.appendChild(dt);
    fileSummaryEl.appendChild(dd);
    fileInfoEl.classList.remove('hidden');
    console.error(err);
  }
}

function attachDropZone() {
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadMidiFile(fileInput.files[0]);
  });

  ['dragenter', 'dragover'].forEach(ev =>
    dropZone.addEventListener(ev, e => {
      e.preventDefault();
      dropZone.classList.add('dragging');
    }));

  ['dragleave', 'drop'].forEach(ev =>
    dropZone.addEventListener(ev, e => {
      e.preventDefault();
      dropZone.classList.remove('dragging');
    }));

  dropZone.addEventListener('drop', e => {
    const file = e.dataTransfer?.files?.[0];
    if (file) loadMidiFile(file);
  });
}

// ---------- Scoring & history ----------

const HISTORY_KEY = 'piano-score-history-v1';
const SCORE_WINDOW = 0.3;          // ±300ms — outside this, a note is missed
const PERFECT_SEC  = 0.05;         //  ≤50ms  → 100 pts
const GOOD_SEC     = 0.15;         //  ≤150ms →  70 pts
                                   //  ≤300ms →  40 pts (OK)

let scoreHistory = [];
try {
  scoreHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
} catch { scoreHistory = []; }

const scoreState = {
  active: false,
  played: [],          // { midi, time } — time = sec since song start
  songStartPerf: 0,
};

// Persistent played-note visualizations on the staff timeline.
// Each entry: { element: SVGGElement, loopIndex }.
// loopIndex = which song iteration the note was played in (0 for first run).
const playedNotes = [];
let currentLoopIndex = 0;
let songStartedOnce = false;

function clearPlayedNotes() {
  for (const pn of playedNotes) pn.element.remove();
  playedNotes.length = 0;
  currentLoopIndex = 0;
  songStartedOnce = false;
}

function advancePlayedLoop() {
  currentLoopIndex++;
  for (let i = playedNotes.length - 1; i >= 0; i--) {
    const pn = playedNotes[i];
    const age = currentLoopIndex - pn.loopIndex;
    if (age >= 2) {
      pn.element.remove();
      playedNotes.splice(i, 1);
    } else if (age === 1) {
      pn.element.classList.add('faded');
    }
  }
}

function classifyPlayedAccuracy(midi, time) {
  if (!currentSong) return 'wrong';
  let bestErr = Infinity;
  for (const exp of currentSong.extracted.notes) {
    if (exp.midi !== midi) continue;
    const err = Math.abs(exp.startSec - time);
    if (err < bestErr) bestErr = err;
  }
  if (bestErr > SCORE_WINDOW)  return 'wrong';
  if (bestErr <= PERFECT_SEC)  return 'perfect';
  if (bestErr <= GOOD_SEC)     return 'good';
  return 'ok';
}

function addPlayedNote(midi, time) {
  if (!currentSong) return;
  const bpm = currentSong.extracted.initialBpm;
  const pxPerSec = PX_PER_QUARTER * bpm / 60;
  const x = SONG_START_X + time * pxPerSec;

  const { totalSteps, sharp } = midiToInfo(midi);
  const y = stepToY(totalSteps);
  const accuracy = classifyPlayedAccuracy(midi, time);

  const g = svg('g', { class: `played-note accuracy-${accuracy}` });

  for (const ls of getLedgerSteps(totalSteps)) {
    const ly = stepToY(ls);
    g.appendChild(svg('line', {
      x1: x - 8, x2: x + 8, y1: ly, y2: ly, class: 'ledger-line played-ledger',
    }));
  }

  g.appendChild(svg('ellipse', {
    cx: x, cy: y, rx: 6, ry: 4.5,
    class: `played-notehead accuracy-${accuracy}`,
    transform: `rotate(-20 ${x} ${y})`,
  }));

  if (sharp) {
    g.appendChild(svg('text', {
      x: x - 16, y: y + 5, class: `played-accidental accuracy-${accuracy}`,
    }, '♯'));
  }

  document.getElementById('played-layer').appendChild(g);
  playedNotes.push({ element: g, loopIndex: currentLoopIndex });
}

function resetScore() {
  scoreState.active = false;
  scoreState.played = [];
  scoreState.songStartPerf = 0;
  updateScoreDisplay(null);
}

function startScoring() {
  if (songStartedOnce) advancePlayedLoop();
  songStartedOnce = true;
  scoreState.active = true;
  scoreState.played = [];
  scoreState.songStartPerf = performance.now();
  updateScoreDisplay(computeScore());
}

function recordUserPlay(midi) {
  if (!scoreState.active) return;
  const time = (performance.now() - scoreState.songStartPerf) / 1000;
  scoreState.played.push({ midi, time });
  addPlayedNote(midi, time);
  updateScoreDisplay(computeScore());
}

function computeScore() {
  if (!currentSong) return null;
  const expected = currentSong.extracted.notes;
  if (expected.length === 0) return null;

  // During playback, only consider notes whose timing window has begun.
  const liveT = scoreState.active
    ? (performance.now() - scoreState.songStartPerf) / 1000
    : Infinity;
  const visibleCutoff = liveT + SCORE_WINDOW;

  const used = new Set();
  let totalPoints = 0;
  let considered = 0;
  let perfect = 0, good = 0, ok = 0, miss = 0;

  for (const exp of expected) {
    if (exp.startSec > visibleCutoff) continue;
    considered++;

    let bestIdx = -1;
    let bestErr = Infinity;
    for (let i = 0; i < scoreState.played.length; i++) {
      if (used.has(i)) continue;
      const p = scoreState.played[i];
      if (p.midi !== exp.midi) continue;
      const err = Math.abs(p.time - exp.startSec);
      if (err < bestErr && err <= SCORE_WINDOW) {
        bestErr = err;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      used.add(bestIdx);
      if      (bestErr <= PERFECT_SEC) { totalPoints += 100; perfect++; }
      else if (bestErr <= GOOD_SEC)    { totalPoints +=  70; good++;    }
      else                             { totalPoints +=  40; ok++;      }
    } else {
      // Only count as a miss once the *full* window has elapsed for this note.
      if (exp.startSec + SCORE_WINDOW <= liveT) miss++;
      else considered--;
    }
  }

  if (considered === 0) return { considered: 0 };
  const percentage = Math.round(totalPoints / (considered * 100) * 100);
  return {
    percentage,
    considered,
    perfect, good, ok, miss,
    total: expected.length,
    hits: perfect + good + ok,
  };
}

function tierClass(pct) {
  if (pct >= 90) return 'tier-great';
  if (pct >= 70) return 'tier-ok';
  return 'tier-poor';
}

function updateScoreDisplay(result) {
  const el = document.getElementById('current-score');
  if (!result || !result.considered) {
    el.innerHTML = '<div class="score-empty">—</div>';
    return;
  }
  el.innerHTML = `
    <div class="score-percent ${tierClass(result.percentage)}">${result.percentage}%</div>
    <div class="score-breakdown">
      ${result.hits}/${result.total} ·
      <span class="tag perfect" title="Perfect (≤50ms)">${result.perfect}</span>
      <span class="tag good" title="Good (≤150ms)">${result.good}</span>
      <span class="tag ok" title="OK (≤300ms)">${result.ok}</span>
      <span class="tag miss" title="Missed">${result.miss}</span>
    </div>
  `;
}

function onSongComplete() {
  scoreState.active = false;
  const result = computeScore();
  if (result && result.considered) {
    updateScoreDisplay(result);
    if (currentSong?.source?.kind === 'lesson') {
      logToHistory(result, currentSong.source.lesson);
    }
  }
  updatePlayButton();

  const loopEl = document.getElementById('loop-toggle');
  if (loopEl?.checked && currentSong) {
    setTimeout(() => {
      if (!playback.isPlaying() && currentSong) {
        playback.start();
        updatePlayButton();
      }
    }, 600);
  }
}

function logToHistory(result, lesson) {
  scoreHistory.unshift({
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    percentage: result.percentage,
    hits: result.hits,
    total: result.total,
    timestamp: Date.now(),
  });
  if (scoreHistory.length > 50) scoreHistory.length = 50;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(scoreHistory));
  } catch { /* private mode etc — ignore */ }
  renderScoreHistory();
}

function renderScoreHistory() {
  const list = document.getElementById('score-history');
  const clearBtn = document.getElementById('clear-history');
  list.innerHTML = '';
  if (clearBtn) clearBtn.hidden = scoreHistory.length === 0;
  if (scoreHistory.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No scores yet';
    list.appendChild(li);
    return;
  }
  for (const entry of scoreHistory.slice(0, 25)) {
    const li = document.createElement('li');
    li.className = 'history-entry';

    const pct = document.createElement('span');
    pct.className = `history-percent ${tierClass(entry.percentage)}`;
    pct.textContent = `${entry.percentage}%`;

    const meta = document.createElement('div');
    meta.className = 'history-meta';

    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = entry.lessonTitle;

    const sub = document.createElement('span');
    sub.className = 'history-sub';
    const time = new Date(entry.timestamp).toLocaleTimeString([], {
      hour: 'numeric', minute: '2-digit',
    });
    sub.textContent = `${time} · ${entry.hits}/${entry.total}`;

    meta.appendChild(title);
    meta.appendChild(sub);
    li.appendChild(pct);
    li.appendChild(meta);
    list.appendChild(li);
  }
}

// ---------- Lesson list & mode ----------

function renderLessonList() {
  const list = document.getElementById('lesson-list');
  list.innerHTML = '';
  for (const lesson of LESSONS) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lesson-button';
    btn.dataset.id = lesson.id;

    const title = document.createElement('span');
    title.className = 'lesson-title';
    title.textContent = lesson.title;
    btn.appendChild(title);

    const desc = document.createElement('span');
    desc.className = 'lesson-desc';
    desc.textContent = lesson.description;
    btn.appendChild(desc);

    const meta = document.createElement('span');
    meta.className = 'lesson-meta';
    meta.textContent =
      `${HAND_LABELS[lesson.hand]} · ${lesson.bpm} BPM · ` +
      `${lesson.timeSig.numerator}/${lesson.timeSig.denominator}`;
    btn.appendChild(meta);

    btn.addEventListener('click', () => loadLesson(lesson));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function loadLesson(lesson) {
  const isAlreadyActive =
    currentSong?.source?.kind === 'lesson' &&
    currentSong.source.lesson.id === lesson.id;

  if (!isAlreadyActive) {
    const { midi, extracted } = lessonToSong(lesson);
    loadSong({ midi, extracted, source: { kind: 'lesson', lesson } });
    document.querySelectorAll('.lesson-button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.id === lesson.id);
    });
  }

  document.getElementById('lessons-mode').classList.add('has-selection');
  document.getElementById('lesson-current-title').textContent = lesson.title;
  document.getElementById('lesson-current-meta').textContent =
    `${HAND_LABELS[lesson.hand]} · ${lesson.bpm} BPM · ` +
    `${lesson.timeSig.numerator}/${lesson.timeSig.denominator}`;
}

function clearLoadedSong() {
  playback.stop();
  currentSong = null;
  clearPlayedNotes();
  document.getElementById('transport').classList.add('hidden');
  fileInfoEl.classList.add('hidden');
  document.getElementById('song-layer').innerHTML = '';
  setStaffWidth(800);
  drawStaffBase();
  setPlayheadX(null);
  document.getElementById('lessons-mode').classList.remove('has-selection');
  document.querySelectorAll('.lesson-button').forEach(btn => {
    btn.classList.remove('active');
  });
}

function attachLessonCollapse() {
  document.getElementById('change-lesson').addEventListener('click', () => {
    document.getElementById('lessons-mode').classList.remove('has-selection');
  });
}

function attachClearHistory() {
  const btn = document.getElementById('clear-history');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (scoreHistory.length === 0) return;
    if (!confirm('Clear all score history?')) return;
    scoreHistory = [];
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
    renderScoreHistory();
  });
}

function setMode(mode) {
  document.getElementById('lessons-mode').classList.toggle('hidden', mode !== 'lessons');
  document.getElementById('advanced-mode').classList.toggle('hidden', mode !== 'advanced');
  document.querySelectorAll('.mode-toggle button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  clearLoadedSong();
}

function attachModeToggle() {
  document.querySelectorAll('.mode-toggle button').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
}

function updatePlayButton() {
  const btn = document.getElementById('play-button');
  if (!btn) return;
  if (playback.isPlaying()) {
    btn.textContent = '■ Stop';
    btn.classList.add('playing');
  } else {
    btn.textContent = '▶ Start';
    btn.classList.remove('playing');
  }
}

function attachTransport() {
  const btn = document.getElementById('play-button');
  const metro = document.getElementById('metronome-toggle');

  btn.addEventListener('click', () => {
    if (playback.isPlaying()) playback.stop();
    else playback.start();
    updatePlayButton();
  });

  metro.addEventListener('change', () => {
    playback.setMetronome(metro.checked);
  });
}

function attachInstrumentControls() {
  const select = document.getElementById('instrument');
  const volume = document.getElementById('volume');

  for (const [id, cfg] of Object.entries(INSTRUMENTS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = cfg.name;
    if (id === 'piano') opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => {
    synth.allNotesOff();
    synth.setInstrument(select.value);
  });

  volume.addEventListener('input', () => {
    synth.setVolume(Number(volume.value) / 100);
  });
  synth.setVolume(Number(volume.value) / 100);

  // Browsers gate AudioContext behind a user gesture. Resume on first interaction.
  const resumeOnce = () => synth.resume();
  document.addEventListener('click', resumeOnce, { once: true });
  document.addEventListener('keydown', resumeOnce, { once: true });
}

async function init() {
  setupStaff();
  setStaffWidth(800);
  drawStaffBase();
  renderPressedList();
  attachDropZone();
  attachInstrumentControls();
  attachTransport();
  renderLessonList();
  attachModeToggle();
  attachLessonCollapse();
  attachClearHistory();
  renderScoreHistory();
  setMode('lessons');

  if (!navigator.requestMIDIAccess) {
    setStatus('Web MIDI not supported in this browser', 'disconnected');
    return;
  }

  try {
    const access = await navigator.requestMIDIAccess();
    refreshDevices(access);
    access.onstatechange = () => refreshDevices(access);
  } catch (err) {
    setStatus('MIDI access denied: ' + err.message, 'disconnected');
  }
}

init();
