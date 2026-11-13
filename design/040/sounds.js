/*
 * HC-040 section 14: the sound palette. Everything is synthesized; there are no audio files.
 * This table and hcPlay() are what client/src/ui/sound/sounds.ts ships (typed, with one shared
 * AudioContext). The mockup sounds.html draws the table and plays it.
 *
 * A note: at = start in ms, f = frequency in Hz, to = glide to this frequency (optional),
 * dur = length in ms, gain = peak (the whole sound never passes 0.12).
 * A voice is a sine (0.75) and a triangle (0.25) on the same pitch: round, with a little edge.
 * Envelope: 5 ms linear attack, then an exponential fall to silence over the note's length.
 */
(() => {
  const E4 = 329.63, B4 = 493.88, E5 = 659.25, FS5 = 739.99, GS5 = 830.61, B5 = 987.77, E6 = 1318.51;
  const SOUNDS = {
    // You or someone else walks into the voice channel you are in: a fifth, up.
    join:        { notes: [{ at: 0, f: E5, dur: 90, gain: 0.1 }, { at: 90, f: B5, dur: 140, gain: 0.1 }] },
    // Someone walks out, or you do: the same fifth, down.
    leave:       { notes: [{ at: 0, f: B5, dur: 90, gain: 0.09 }, { at: 90, f: E5, dur: 140, gain: 0.09 }] },
    // Mute is a small step down, unmute the same step up. One gliding voice, no second note.
    mute:        { notes: [{ at: 0, f: 440, to: 330, dur: 60, gain: 0.08 }] },
    unmute:      { notes: [{ at: 0, f: 330, to: 440, dur: 60, gain: 0.08 }] },
    // Deafen: the same gesture an octave lower and a little longer, so it is told apart without looking.
    deafen:      { notes: [{ at: 0, f: 220, to: 165, dur: 90, gain: 0.1 }] },
    undeafen:    { notes: [{ at: 0, f: 165, to: 220, dur: 90, gain: 0.1 }] },
    // A stream starts: the triad, rising. It stops: two notes back down.
    streamStart: { notes: [{ at: 0, f: E5, dur: 70, gain: 0.08 }, { at: 70, f: GS5, dur: 70, gain: 0.08 }, { at: 140, f: B5, dur: 160, gain: 0.09 }] },
    streamStop:  { notes: [{ at: 0, f: B5, dur: 70, gain: 0.07 }, { at: 70, f: GS5, dur: 140, gain: 0.07 }] },
    // The call dropped and did not come back: low, slow, unmistakably not "leave".
    callFailed:  { notes: [{ at: 0, f: B4, dur: 130, gain: 0.1 }, { at: 130, f: E4, dur: 260, gain: 0.1 }] },
    // A new device was approved, a recovery key was accepted: one bright step.
    linked:      { notes: [{ at: 0, f: B5, dur: 80, gain: 0.07 }, { at: 80, f: E6, dur: 220, gain: 0.07 }] },
    // Incoming call: a doorbell. The four notes every hall clock plays, each left to ring. Repeats every 2.4 s.
    ringIncoming: { every: 2400, notes: [{ at: 0, f: GS5, dur: 520, gain: 0.07 }, { at: 200, f: FS5, dur: 520, gain: 0.07 }, { at: 400, f: E5, dur: 520, gain: 0.07 }, { at: 600, f: B4, dur: 760, gain: 0.08 }] },
    // Outgoing call: two soft pulses, the sound of a phone ringing somewhere else. Repeats every 3 s.
    ringOutgoing: { every: 3000, soft: true, notes: [{ at: 0, f: 480, dur: 380, gain: 0.05 }, { at: 560, f: 480, dur: 380, gain: 0.05 }] },
  };

  /**
   * Schedules one sound on ctx at time `when` (seconds, default now) into `out` (default the destination).
   * `scale` multiplies every gain (0.6 for other people's joins and leaves). Returns its length in seconds.
   */
  const hcPlay = (ctx, name, when = ctx.currentTime, out = ctx.destination, scale = 1) => {
    const sound = SOUNDS[name];
    let end = 0;
    for (const n of sound.notes) {
      const t = when + n.at / 1000, d = n.dur / 1000;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      if (sound.soft) { // a pulse, not a pluck: 30 ms in, hold, 60 ms out
        env.gain.linearRampToValueAtTime(n.gain * scale, t + 0.03);
        env.gain.setValueAtTime(n.gain * scale, t + d - 0.06);
        env.gain.linearRampToValueAtTime(0, t + d);
      } else {
        env.gain.linearRampToValueAtTime(n.gain * scale, t + 0.005);
        env.gain.exponentialRampToValueAtTime(0.0001, t + d);
      }
      env.connect(out);
      for (const [type, level] of [["sine", 0.75], ["triangle", 0.25]]) {
        const osc = ctx.createOscillator(), mix = ctx.createGain();
        osc.type = type; mix.gain.value = level;
        osc.frequency.setValueAtTime(n.f, t);
        if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, t + d);
        osc.connect(mix).connect(env);
        osc.start(t); osc.stop(t + d + 0.02);
      }
      end = Math.max(end, n.at / 1000 + d);
    }
    return end;
  };

  window.HC_SOUNDS = SOUNDS;
  window.hcPlay = hcPlay;
})();
