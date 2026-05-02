// Lesson definitions. Each lesson is a small piece authored in beats; we
// convert it into the same { midi, extracted } shape the MIDI parser produces
// so the existing staff renderer and playback engine work unchanged.

const major = [0, 2, 4, 5, 7, 9, 11, 12]; // semitone offsets for major scale

function steady(midi, count, dur = 1, startBeat = 0) {
  return Array.from({ length: count }, (_, i) => ({
    midi, beat: startBeat + i * dur, duration: dur,
  }));
}

export const LESSONS = [
  {
    id: 'rh-steady',
    title: '1. Steady Quarter Notes',
    description:
      'Play middle C on each beat with your right hand. Focus on staying with the metronome.',
    hand: 'right',
    bpm: 60,
    timeSig: { numerator: 4, denominator: 4 },
    notes: steady(60, 8, 1),
  },
  {
    id: 'rh-mixed-durations',
    title: '2. Mixed Note Lengths',
    description:
      'Same pitch, varying durations. Listen for when each note ends — release on the next beat.',
    hand: 'right',
    bpm: 60,
    timeSig: { numerator: 4, denominator: 4 },
    notes: [
      { midi: 60, beat: 0,  duration: 2 },
      { midi: 60, beat: 2,  duration: 2 },
      { midi: 60, beat: 4,  duration: 4 },
      { midi: 60, beat: 8,  duration: 1 },
      { midi: 60, beat: 9,  duration: 1 },
      { midi: 60, beat: 10, duration: 2 },
      { midi: 60, beat: 12, duration: 4 },
    ],
  },
  {
    id: 'rh-cmajor-up',
    title: '3. C Major Scale Up',
    description:
      'Right hand: C, D, E, F, G, A, B, C ascending. One note per beat.',
    hand: 'right',
    bpm: 60,
    timeSig: { numerator: 4, denominator: 4 },
    notes: major.map((iv, i) => ({ midi: 60 + iv, beat: i, duration: 1 })),
  },
  {
    id: 'rh-cmajor-updown',
    title: '4. C Major Scale Up & Down',
    description: 'Same scale, ascending then descending without stopping.',
    hand: 'right',
    bpm: 60,
    timeSig: { numerator: 4, denominator: 4 },
    notes: [
      ...major.map((iv, i) => ({ midi: 60 + iv, beat: i, duration: 1 })),
      ...major.slice(0, -1).reverse().map((iv, i) => ({
        midi: 60 + iv, beat: 8 + i, duration: 1,
      })),
    ],
  },
  {
    id: 'lh-steady',
    title: '5. Left Hand: Steady Beat',
    description:
      'Play C below middle C on each beat. Get your left hand reading the bass clef.',
    hand: 'left',
    bpm: 60,
    timeSig: { numerator: 4, denominator: 4 },
    notes: steady(48, 8, 1),
  },
  {
    id: 'lh-bass-walk',
    title: '6. Left Hand: Bass Progression',
    description:
      'Whole notes: C, F, G, C — common chord roots played by the left hand.',
    hand: 'left',
    bpm: 60,
    timeSig: { numerator: 4, denominator: 4 },
    notes: [
      { midi: 48, beat: 0,  duration: 4 },
      { midi: 53, beat: 4,  duration: 4 },
      { midi: 55, beat: 8,  duration: 4 },
      { midi: 48, beat: 12, duration: 4 },
    ],
  },
  {
    id: 'both-together',
    title: '7. Both Hands Together',
    description:
      'RH on middle C, LH on C below. Press both keys at the same instant on every beat.',
    hand: 'both',
    bpm: 60,
    timeSig: { numerator: 4, denominator: 4 },
    notes: [
      ...steady(60, 8, 1).map(n => ({ ...n, hand: 'right' })),
      ...steady(48, 8, 1).map(n => ({ ...n, hand: 'left' })),
    ],
  },
  {
    id: 'both-alternating',
    title: '8. Alternating Hands',
    description:
      'Right hand on beats 1 and 3, left hand on 2 and 4. Build independence between the hands.',
    hand: 'both',
    bpm: 60,
    timeSig: { numerator: 4, denominator: 4 },
    notes: [
      { midi: 60, beat: 0, duration: 1, hand: 'right' },
      { midi: 48, beat: 1, duration: 1, hand: 'left'  },
      { midi: 60, beat: 2, duration: 1, hand: 'right' },
      { midi: 48, beat: 3, duration: 1, hand: 'left'  },
      { midi: 60, beat: 4, duration: 1, hand: 'right' },
      { midi: 48, beat: 5, duration: 1, hand: 'left'  },
      { midi: 60, beat: 6, duration: 1, hand: 'right' },
      { midi: 48, beat: 7, duration: 1, hand: 'left'  },
    ],
  },
];

const TPQ = 480;

function inferHand(note, lessonHand) {
  if (note.hand) return note.hand;
  if (lessonHand === 'left' || lessonHand === 'right') return lessonHand;
  return note.midi >= 60 ? 'right' : 'left';
}

export function lessonToSong(lesson) {
  const denom = lesson.timeSig.denominator;
  const ticksPerBeat = TPQ * (4 / denom);
  const beatSec = (60 / lesson.bpm) * (4 / denom);

  const notes = lesson.notes
    .map(n => ({
      midi: n.midi,
      track: 0,
      channel: 0,
      velocity: 80,
      hand: inferHand(n, lesson.hand),
      startTick: Math.round(n.beat * ticksPerBeat),
      endTick:   Math.round((n.beat + n.duration) * ticksPerBeat),
      startSec:  n.beat * beatSec,
      endSec:    (n.beat + n.duration) * beatSec,
    }))
    .sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);

  return {
    midi: { format: 0, numTracks: 1, ticksPerQuarter: TPQ, tracks: [] },
    extracted: {
      notes,
      initialBpm: lesson.bpm,
      timeSig: lesson.timeSig,
      duration: notes.length ? Math.max(...notes.map(n => n.endSec)) : 0,
    },
  };
}

export const HAND_LABELS = {
  right: 'Right hand',
  left: 'Left hand',
  both: 'Both hands',
};
