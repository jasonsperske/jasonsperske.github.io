// Song transport: 3-beat count-in (first note played 3×), then a tempo-driven
// playhead with optional metronome ticks aligned to the time signature's beats.

export class Playback {
  constructor({ synth, onTick, onCountStart, onSongStart, onSongComplete }) {
    this.synth = synth;
    this.onTick = onTick;                          // (timeSec | null) — null = stopped
    this.onCountStart    = onCountStart    || (() => {});
    this.onSongStart     = onSongStart     || (() => {});
    this.onSongComplete  = onSongComplete  || (() => {});
    this.song = null;
    this.midi = null;
    this.beatsPerMeasure = 4;
    this.beatDurationSec = 0.5;       // per-beat (denominator-aware) duration
    this.metronome = false;
    this.state = 'idle';              // 'idle' | 'counting' | 'playing'
    this._timers = [];
    this._rafId = null;
    this._startPerf = 0;
  }

  load(midi, extracted) {
    this.song = extracted;
    this.midi = midi;
    const ts = extracted.timeSig;
    // Quarter-note-relative beats per measure (so 6/8 → 3 quarters per measure).
    this.beatsPerMeasure = ts ? ts.numerator * (4 / ts.denominator) : 4;
    // Beat duration matches the time-signature denominator.
    const denom = ts?.denominator ?? 4;
    this.beatDurationSec = (60 / extracted.initialBpm) * (4 / denom);
  }

  setMetronome(on) { this.metronome = on; }

  isPlaying() { return this.state !== 'idle'; }

  start() {
    if (!this.song || this.song.notes.length === 0) return;
    if (this.state !== 'idle') return;

    this.synth.ensureCtx();
    this.synth.resume();

    this.state = 'counting';
    this.onCountStart();
    const firstNote = this.song.notes[0];
    const beatMs = this.beatDurationSec * 1000;
    const noteDurSec = this.beatDurationSec * 0.6;

    // Count-in beats are scheduled on the AudioContext clock so each beat
    // lands exactly `beatDurationSec` apart, regardless of setTimeout jitter
    // — they stay locked to the song's tempo. The lookahead leaves the audio
    // engine a few ms to schedule the first beat reliably.
    const LOOKAHEAD = 0.1;
    const startCtx = this.synth.ctx.currentTime + LOOKAHEAD;
    for (let i = 0; i < 3; i++) {
      this.synth.playFor(
        firstNote.midi, noteDurSec, 100,
        startCtx + i * this.beatDurationSec,
      );
    }

    // The song's tick=0 is one beat after the third count-in note.
    this._songStartCtx = startCtx + 3 * this.beatDurationSec;

    const totalCountInMs = (3 * this.beatDurationSec + LOOKAHEAD) * 1000;
    this._timers.push(setTimeout(() => this._beginSong(), totalCountInMs));
  }

  _beginSong() {
    this.state = 'playing';

    // Anchor the song's perf-time clock to the audio clock's planned start.
    // setTimeout jitter could push _beginSong a few ms late; without this,
    // the playhead and scoring would drift from the audio.
    const offsetMs = performance.now() - this.synth.ctx.currentTime * 1000;
    this._startPerf = this._songStartCtx * 1000 + offsetMs;

    this.onSongStart();

    const beatMs = this.beatDurationSec * 1000;
    const totalSec = this.song.duration;
    const totalBeats = Math.ceil(totalSec / this.beatDurationSec) + 1;
    const elapsedMs = performance.now() - this._startPerf;

    // Schedule each beat at its absolute target (relative to song start),
    // not relative to "now" — so a slightly-late _beginSong doesn't push
    // every metronome tick the same amount late.
    for (let b = 0; b < totalBeats; b++) {
      const beatIndex = b;
      const targetDelay = b * beatMs - elapsedMs;
      if (targetDelay < 0) continue;
      this._timers.push(setTimeout(() => {
        if (this.state === 'playing' && this.metronome) {
          this.synth.click(beatIndex % this.beatsPerMeasure === 0);
        }
      }, targetDelay));
    }

    const tick = () => {
      if (this.state !== 'playing') return;
      const t = (performance.now() - this._startPerf) / 1000;
      this.onTick(t);
      if (t >= totalSec + 0.3) {
        this.stop(true);
        return;
      }
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  stop(natural = false) {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    this.synth.allNotesOff();
    this.state = 'idle';
    this.onTick(null);
    if (natural) this.onSongComplete();
  }
}
