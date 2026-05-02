// Polyphonic Web Audio synth with simple instrument patches.
// Each patch is a stack of oscillators (with optional detune/harmonic ratio),
// an ADSR amp envelope, and an optional low-pass filter.

export const INSTRUMENTS = {
  piano: {
    name: 'Piano',
    oscillators: [
      { type: 'triangle', mult: 1, gain: 0.55 },
      { type: 'sine',     mult: 2, gain: 0.22 },
      { type: 'sine',     mult: 3, gain: 0.10 },
    ],
    envelope: { attack: 0.004, decay: 1.6, sustain: 0.0, release: 0.25 },
  },
  electric_piano: {
    name: 'Electric Piano',
    oscillators: [
      { type: 'sine',     mult: 1, gain: 0.55 },
      { type: 'sine',     mult: 5, gain: 0.18 },
    ],
    envelope: { attack: 0.005, decay: 0.8, sustain: 0.25, release: 0.4 },
  },
  organ: {
    name: 'Organ',
    oscillators: [
      { type: 'sine', mult: 1, gain: 0.45 },
      { type: 'sine', mult: 2, gain: 0.30 },
      { type: 'sine', mult: 4, gain: 0.18 },
      { type: 'sine', mult: 8, gain: 0.10 },
    ],
    envelope: { attack: 0.02, decay: 0.05, sustain: 0.9, release: 0.12 },
  },
  strings: {
    name: 'Strings',
    oscillators: [
      { type: 'sawtooth', mult: 1, gain: 0.32, detune: -7 },
      { type: 'sawtooth', mult: 1, gain: 0.32, detune:  7 },
    ],
    envelope: { attack: 0.25, decay: 0.2, sustain: 0.8, release: 0.45 },
    filter:   { type: 'lowpass', frequency: 2200, Q: 0.8 },
  },
  marimba: {
    name: 'Marimba',
    oscillators: [
      { type: 'sine', mult: 1, gain: 0.55 },
      { type: 'sine', mult: 4, gain: 0.18 },
    ],
    envelope: { attack: 0.001, decay: 0.55, sustain: 0.0, release: 0.1 },
  },
  synth_lead: {
    name: 'Synth Lead',
    oscillators: [
      { type: 'square',   mult: 1, gain: 0.30 },
      { type: 'sawtooth', mult: 1, gain: 0.25, detune: 4 },
    ],
    envelope: { attack: 0.01, decay: 0.15, sustain: 0.7, release: 0.2 },
    filter:   { type: 'lowpass', frequency: 3500, Q: 2 },
  },
  sine: {
    name: 'Sine',
    oscillators: [{ type: 'sine', mult: 1, gain: 0.6 }],
    envelope: { attack: 0.01, decay: 0.05, sustain: 0.85, release: 0.12 },
  },
};

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class SynthPlayer {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.config = INSTRUMENTS.piano;
    this.voices = new Map(); // midi -> { oscs, gain, release }
    this.volume = 0.5;
  }

  ensureCtx() {
    if (this.ctx) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setInstrument(id) {
    if (INSTRUMENTS[id]) this.config = INSTRUMENTS[id];
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  noteOn(midi, velocity = 100) {
    this.ensureCtx();
    this.resume();
    if (this.voices.has(midi)) this.noteOff(midi);

    const { ctx } = this;
    const now = ctx.currentTime;
    const freq = midiToFreq(midi);
    const vol = velocity / 127;
    const env = this.config.envelope;

    const voiceGain = ctx.createGain();
    let inputNode = voiceGain;

    if (this.config.filter) {
      const f = ctx.createBiquadFilter();
      f.type = this.config.filter.type;
      f.frequency.value = this.config.filter.frequency;
      f.Q.value = this.config.filter.Q ?? 1;
      voiceGain.connect(f);
      f.connect(this.master);
    } else {
      voiceGain.connect(this.master);
    }

    const oscs = [];
    for (const osc of this.config.oscillators) {
      const o = ctx.createOscillator();
      o.type = osc.type;
      o.frequency.value = freq * osc.mult;
      if (osc.detune) o.detune.value = osc.detune;
      const oGain = ctx.createGain();
      oGain.gain.value = osc.gain;
      o.connect(oGain);
      oGain.connect(inputNode);
      o.start(now);
      oscs.push(o);
    }

    // ADSR — peak scaled by velocity, then decay to sustain level.
    const peak = vol * 0.5;
    const sustain = peak * env.sustain;
    voiceGain.gain.setValueAtTime(0, now);
    voiceGain.gain.linearRampToValueAtTime(peak, now + env.attack);
    voiceGain.gain.linearRampToValueAtTime(sustain, now + env.attack + env.decay);

    this.voices.set(midi, { oscs, gain: voiceGain, release: env.release });
  }

  noteOff(midi) {
    const v = this.voices.get(midi);
    if (!v) return;
    const { ctx } = this;
    const now = ctx.currentTime;

    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.linearRampToValueAtTime(0, now + v.release);
    for (const o of v.oscs) o.stop(now + v.release + 0.05);
    this.voices.delete(midi);
  }

  allNotesOff() {
    for (const midi of [...this.voices.keys()]) this.noteOff(midi);
  }

  // Plays a note for a fixed duration. Self-contained: doesn't use the shared
  // `voices` map, so it can never be cancelled by a later noteOn/noteOff for
  // the same pitch (e.g. a count-in beat colliding with the user's keypress).
  // `startTime` is an AudioContext currentTime; pass null to play immediately.
  playFor(midi, durationSec, velocity = 100, startTime = null) {
    this.ensureCtx();
    this.resume();
    const { ctx } = this;
    const start = startTime != null ? startTime : ctx.currentTime;
    const freq = midiToFreq(midi);
    const vol = velocity / 127;
    const env = this.config.envelope;

    const voiceGain = ctx.createGain();
    if (this.config.filter) {
      const f = ctx.createBiquadFilter();
      f.type = this.config.filter.type;
      f.frequency.value = this.config.filter.frequency;
      f.Q.value = this.config.filter.Q ?? 1;
      voiceGain.connect(f);
      f.connect(this.master);
    } else {
      voiceGain.connect(this.master);
    }

    const oscs = [];
    for (const osc of this.config.oscillators) {
      const o = ctx.createOscillator();
      o.type = osc.type;
      o.frequency.value = freq * osc.mult;
      if (osc.detune) o.detune.value = osc.detune;
      const oGain = ctx.createGain();
      oGain.gain.value = osc.gain;
      o.connect(oGain);
      oGain.connect(voiceGain);
      o.start(start);
      oscs.push(o);
    }

    const peak = vol * 0.5;
    const sustain = peak * env.sustain;
    const releaseStart = start + durationSec;
    const stopAt = releaseStart + env.release;

    voiceGain.gain.setValueAtTime(0, start);
    voiceGain.gain.linearRampToValueAtTime(peak, start + env.attack);
    voiceGain.gain.linearRampToValueAtTime(sustain, start + env.attack + env.decay);
    if (voiceGain.gain.cancelAndHoldAtTime) {
      voiceGain.gain.cancelAndHoldAtTime(releaseStart);
    }
    voiceGain.gain.linearRampToValueAtTime(0, stopAt);

    for (const o of oscs) o.stop(stopAt + 0.05);
  }

  // Short percussive metronome click. `accent` raises the pitch on bar 1.
  click(accent = false) {
    this.ensureCtx();
    this.resume();
    const { ctx } = this;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = accent ? 1600 : 1000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.25, now + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    osc.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.06);
  }
}
