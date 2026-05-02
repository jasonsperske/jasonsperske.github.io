// Standard MIDI File parser. Decodes the binary format into a tempo-aware
// list of notes with start/end times in seconds.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiNoteName(midi) {
  const n = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[n] + octave;
}

class Reader {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.pos = 0;
  }
  u8()  { return this.view.getUint8(this.pos++); }
  u16() { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  bytes(n) {
    const arr = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n);
    this.pos += n;
    return arr;
  }
  ascii(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7F);
      if (!(b & 0x80)) return v;
    }
    throw new Error('VLQ exceeds 4 bytes');
  }
}

export function parseMidi(buffer) {
  const r = new Reader(buffer);

  if (r.ascii(4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd)');
  const headerLen = r.u32();
  const format = r.u16();
  const numTracks = r.u16();
  const division = r.u16();
  if (division & 0x8000) throw new Error('SMPTE timing not supported');
  const ticksPerQuarter = division;
  if (headerLen > 6) r.pos += headerLen - 6;

  const tracks = [];
  for (let i = 0; i < numTracks; i++) {
    if (r.ascii(4) !== 'MTrk') throw new Error(`Expected MTrk in track ${i}`);
    const trackLen = r.u32();
    const trackEnd = r.pos + trackLen;

    const events = [];
    let absTick = 0;
    let runningStatus = 0;
    let trackName = null;

    while (r.pos < trackEnd) {
      absTick += r.vlq();
      let statusByte = r.u8();
      if (statusByte < 0x80) {
        // Running status: reuse previous status, this byte is data.
        r.pos--;
        statusByte = runningStatus;
      } else {
        runningStatus = statusByte;
      }

      if (statusByte === 0xFF) {
        const type = r.u8();
        const len = r.vlq();
        const data = r.bytes(len);
        if (type === 0x51 && len === 3) {
          const us = (data[0] << 16) | (data[1] << 8) | data[2];
          events.push({ tick: absTick, type: 'tempo', usPerQuarter: us });
        } else if (type === 0x58 && len >= 4) {
          events.push({
            tick: absTick, type: 'timeSig',
            numerator: data[0],
            denominator: 1 << data[1],
          });
        } else if (type === 0x03 && trackName == null) {
          trackName = new TextDecoder().decode(data);
        }
        // 0x2F end-of-track: trackEnd terminates the loop naturally
      } else if (statusByte === 0xF0 || statusByte === 0xF7) {
        const len = r.vlq();
        r.pos += len;
      } else {
        const cmd = statusByte & 0xF0;
        const channel = statusByte & 0x0F;
        if (cmd === 0x80 || cmd === 0x90) {
          const note = r.u8();
          const vel = r.u8();
          if (cmd === 0x90 && vel > 0) {
            events.push({ tick: absTick, type: 'noteOn', channel, note, velocity: vel });
          } else {
            events.push({ tick: absTick, type: 'noteOff', channel, note });
          }
        } else if (cmd === 0xC0 || cmd === 0xD0) {
          r.pos += 1;
        } else if (cmd === 0xA0 || cmd === 0xB0 || cmd === 0xE0) {
          r.pos += 2;
        } else {
          throw new Error(`Unknown status byte 0x${statusByte.toString(16)} at ${r.pos}`);
        }
      }
    }

    r.pos = trackEnd;
    tracks.push({ name: trackName, events });
  }

  return { format, numTracks, ticksPerQuarter, tracks };
}

export function extractNotes(midi) {
  const all = [];
  midi.tracks.forEach((track, ti) => {
    for (const e of track.events) all.push({ ...e, track: ti });
  });
  // Stable sort by tick (Array.prototype.sort is stable in modern engines)
  all.sort((a, b) => a.tick - b.tick);

  // Tempo segments: each has the cumulative seconds at its start tick.
  const segs = [{ tick: 0, sec: 0, us: 500000 }];
  for (const e of all) {
    if (e.type === 'tempo') {
      const last = segs[segs.length - 1];
      const ds = (e.tick - last.tick) * last.us / midi.ticksPerQuarter / 1e6;
      segs.push({ tick: e.tick, sec: last.sec + ds, us: e.usPerQuarter });
    }
  }

  function tickToSec(tick) {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (segs[m].tick <= tick) lo = m;
      else hi = m - 1;
    }
    const s = segs[lo];
    return s.sec + (tick - s.tick) * s.us / midi.ticksPerQuarter / 1e6;
  }

  // FIFO pair noteOn → noteOff per (track, channel, note) so retriggers work.
  const open = new Map();
  const notes = [];
  for (const e of all) {
    if (e.type !== 'noteOn' && e.type !== 'noteOff') continue;
    const key = `${e.track}-${e.channel}-${e.note}`;
    if (e.type === 'noteOn') {
      if (!open.has(key)) open.set(key, []);
      open.get(key).push(e);
    } else {
      const stack = open.get(key);
      if (stack && stack.length) {
        const start = stack.shift();
        notes.push({
          midi: e.note,
          track: e.track,
          channel: e.channel,
          velocity: start.velocity,
          startTick: start.tick,
          endTick: e.tick,
          startSec: tickToSec(start.tick),
          endSec: tickToSec(e.tick),
        });
      }
    }
  }

  notes.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);

  let initialUs = 500000;
  for (const e of all) {
    if (e.type === 'tempo') { initialUs = e.usPerQuarter; break; }
  }
  let timeSig = null;
  for (const e of all) {
    if (e.type === 'timeSig') { timeSig = e; break; }
  }

  return {
    notes,
    initialBpm: 60000000 / initialUs,
    timeSig,
    duration: notes.length ? Math.max(...notes.map(n => n.endSec)) : 0,
  };
}
