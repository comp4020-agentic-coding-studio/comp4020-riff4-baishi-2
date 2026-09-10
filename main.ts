// Drift: an eight-pad pentatonic instrument. Every note lives in the same
// scale, so any combination of pads — one finger or five — sounds
// consonant. Vertical position sweeps a shared filter and delay, so the
// same notes feel brighter or darker depending on where you touch — and
// bends every sounding pitch slightly sharp or flat along with it.

const MIN_CUTOFF = 350;
const MAX_CUTOFF = 6000;
const ATTACK = 0.012;
const RELEASE = 0.35;

const instrument = document.querySelector<HTMLElement>("#instrument");
const hint = document.querySelector<HTMLElement>("#hint");
const pitchDisplay = document.querySelector<HTMLElement>("#pitch-display");
const pads = Array.from(document.querySelectorAll<HTMLButtonElement>(".pad"));

let audioContext: AudioContext | null = null;
let masterFilter: BiquadFilterNode | null = null;
let brightness = 0.5; // 0 = dark, 1 = bright — also drives the CSS backdrop.

type Voice = { oscillator: OscillatorNode; gain: GainNode };
const voices = new Map<string, Voice>();

// Each pad's resting colour, keyed to its own pitch — read once from the
// --hue set in the markup rather than hard-coded again here.
const baseHue = new Map<HTMLElement, number>();
for (const pad of pads) {
  baseHue.set(pad, Number.parseFloat(getComputedStyle(pad).getPropertyValue("--hue")) || 310);
}

const HUE_BEND_RANGE = 40; // degrees of hue swing across the full up/down travel
const PITCH_BEND_CENTS_RANGE = 200; // a full tone of bend across the full up/down travel

function currentBendCents(): number {
  return (brightness - 0.5) * PITCH_BEND_CENTS_RANGE;
}

// Every currently sounding oscillator bends by the same amount, live, as you
// move up or down — the same gesture that already brightens the filter and
// bends each pad's hue, so pitch, timbre and colour all drift together.
function applyPitchBendForBrightness() {
  if (!audioContext) return;
  const cents = currentBendCents();
  const now = audioContext.currentTime;
  for (const { oscillator } of voices.values()) {
    oscillator.detune.setTargetAtTime(cents, now, 0.05);
  }
}

// A held pad's colour bends away from its resting hue as you move up or
// down, the same gesture that already brightens or darkens the sound —
// so a note playing sounds and looks like it's being bent at once.
function applyHueForBrightness() {
  const offset = (brightness - 0.5) * HUE_BEND_RANGE;
  for (const pad of pads) {
    if (!pad.classList.contains("active")) continue;
    const base = baseHue.get(pad) ?? 310;
    pad.style.setProperty("--hue", String(base + offset));
  }
}

function markPlayed() {
  hint?.classList.add("played");
}

function setBrightness(value: number) {
  brightness = Math.min(1, Math.max(0, value));
  document.documentElement.style.setProperty("--brightness", brightness.toFixed(3));
  if (masterFilter && audioContext) {
    const cutoff = MIN_CUTOFF * (MAX_CUTOFF / MIN_CUTOFF) ** brightness;
    masterFilter.frequency.setTargetAtTime(cutoff, audioContext.currentTime, 0.05);
  }
  applyHueForBrightness();
  applyPitchBendForBrightness();
  updatePitchDisplay();
}

function ensureAudio(): AudioContext {
  if (audioContext) return audioContext;

  const context = new AudioContext();
  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.7;
  filter.frequency.value = MIN_CUTOFF * (MAX_CUTOFF / MIN_CUTOFF) ** brightness;

  const compressor = context.createDynamicsCompressor();

  const delay = context.createDelay(1);
  delay.delayTime.value = 0.28;
  const feedback = context.createGain();
  feedback.gain.value = 0.32;
  const wet = context.createGain();
  wet.gain.value = 0.22;

  filter.connect(compressor);
  filter.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(wet);
  wet.connect(compressor);
  compressor.connect(context.destination);

  audioContext = context;
  masterFilter = filter;
  return context;
}

function noteOn(voiceId: string, frequency: number, pad: HTMLElement | null, fromLoop = false) {
  const context = ensureAudio();
  if (context.state === "suspended") void context.resume();
  if (!masterFilter) return;
  if (voices.has(voiceId)) return;

  const oscillator = context.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.value = frequency;
  oscillator.detune.setValueAtTime(currentBendCents(), context.currentTime);

  const gain = context.createGain();
  gain.gain.setValueAtTime(0, context.currentTime);
  gain.gain.linearRampToValueAtTime(0.22, context.currentTime + ATTACK);

  oscillator.connect(gain);
  gain.connect(masterFilter);
  oscillator.start();

  voices.set(voiceId, { oscillator, gain });
  if (fromLoop) {
    padRefs(pad, "loop-echo").add();
  } else {
    padRefs(pad, "active").add();
    if (loopState === "recording") recordNoteOn(voiceId, frequency, pad);
    markPlayed();
  }
  applyHueForBrightness();
  updatePitchDisplay();
}

function noteOff(voiceId: string, pad: HTMLElement | null, fromLoop = false) {
  const voice = voices.get(voiceId);
  if (fromLoop) {
    padRefs(pad, "loop-echo").release();
  } else {
    padRefs(pad, "active").release();
    if (loopState === "recording") recordNoteOff(voiceId);
    if (pad) pad.style.setProperty("--hue", String(baseHue.get(pad) ?? 310));
  }
  updatePitchDisplay();
  if (!voice || !audioContext) return;

  const { oscillator, gain } = voice;
  const now = audioContext.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(0, now + RELEASE);
  oscillator.stop(now + RELEASE + 0.05);
  voices.delete(voiceId);
}

// Live play and the looped echo can both light the same pad at once, so each
// class is refcounted independently — releasing one held note must not blank
// out a still-sounding class-mate on the same pad.
const padClassRefs = new Map<string, number>();

function padRefs(pad: HTMLElement | null, className: string) {
  const key = pad ? `${className}:${(pads as HTMLElement[]).indexOf(pad)}` : "";
  return {
    add() {
      if (!pad) return;
      padClassRefs.set(key, (padClassRefs.get(key) ?? 0) + 1);
      pad.classList.add(className);
    },
    release() {
      if (!pad) return;
      const next = (padClassRefs.get(key) ?? 1) - 1;
      if (next <= 0) {
        padClassRefs.delete(key);
        pad.classList.remove(className);
      } else {
        padClassRefs.set(key, next);
      }
    },
  };
}

function frequencyOf(pad: HTMLElement): number {
  return Number(pad.dataset.freq);
}

// Shows every pitch currently sounding, low to high — a sighted readout of
// what's already audible, including the live bend from the brightness
// gesture, not a new source of truth.
function updatePitchDisplay() {
  if (!pitchDisplay) return;
  const bendFactor = 2 ** (currentBendCents() / 1200);
  const sounding = pads
    .filter((pad) => pad.classList.contains("active"))
    .map((pad) => ({ note: pad.dataset.note ?? "?", freq: frequencyOf(pad) * bendFactor }))
    .sort((a, b) => a.freq - b.freq);

  pitchDisplay.textContent =
    sounding.length === 0 ? "—" : sounding.map(({ note, freq }) => `${note} · ${freq.toFixed(1)} Hz`).join("   ");
}

function updateBrightnessFromClientY(clientY: number) {
  const ratio = 1 - clientY / window.innerHeight;
  setBrightness(ratio);
}

// Pointer events unify mouse and touch, and each pointerId is its own
// voice, so a mouse drag glides between pads (glissando) while several
// simultaneous touches play a chord.
type PointerDrag = { pad: HTMLElement; startX: number; startY: number };
const pointerPads = new Map<number, PointerDrag>();

const STRETCH_RANGE = 90; // px of drag needed to reach full lean
const STRETCH_MAX = 22; // percentage points the edge leans, at full drag

// A pad leans toward wherever it's being dragged — only its edges reshape
// (via border-radius), the overall size stays put — smoothed by the same
// transition that already handles its lift and glow.
function applyStretch(pad: HTMLElement, dx: number, dy: number) {
  const leanX = (Math.max(-1, Math.min(1, dx / STRETCH_RANGE)) * STRETCH_MAX).toFixed(1);
  const leanY = (Math.max(-1, Math.min(1, dy / STRETCH_RANGE)) * STRETCH_MAX).toFixed(1);
  pad.style.borderRadius =
    `calc(50% - ${leanX}%) calc(50% + ${leanX}%) calc(50% + ${leanX}%) calc(50% - ${leanX}%) / ` +
    `calc(50% - ${leanY}%) calc(50% - ${leanY}%) calc(50% + ${leanY}%) calc(50% + ${leanY}%)`;
}

function resetStretch(pad: HTMLElement) {
  pad.style.borderRadius = "";
}

function padUnderPoint(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  return el?.closest<HTMLElement>(".pad") ?? null;
}

instrument?.addEventListener("pointerdown", (event) => {
  const pad = (event.target as HTMLElement).closest<HTMLElement>(".pad");
  if (!pad) return;
  event.preventDefault();
  pointerPads.set(event.pointerId, { pad, startX: event.clientX, startY: event.clientY });
  noteOn(`pointer-${event.pointerId}`, frequencyOf(pad), pad);
  updateBrightnessFromClientY(event.clientY);
});

document.addEventListener("pointermove", (event) => {
  updateBrightnessFromClientY(event.clientY);

  const drag = pointerPads.get(event.pointerId);
  if (!drag) return;

  const pad = padUnderPoint(event.clientX, event.clientY);
  if (pad && pad !== drag.pad) {
    noteOff(`pointer-${event.pointerId}`, drag.pad);
    resetStretch(drag.pad);
    drag.pad = pad;
    drag.startX = event.clientX;
    drag.startY = event.clientY;
    noteOn(`pointer-${event.pointerId}`, frequencyOf(pad), pad);
  }

  applyStretch(drag.pad, event.clientX - drag.startX, event.clientY - drag.startY);
});

function releasePointer(event: PointerEvent) {
  const drag = pointerPads.get(event.pointerId);
  if (!drag) return;
  noteOff(`pointer-${event.pointerId}`, drag.pad);
  resetStretch(drag.pad);
  pointerPads.delete(event.pointerId);
}

document.addEventListener("pointerup", releasePointer);
document.addEventListener("pointercancel", releasePointer);

// A pad reached by Tab (not the letter keys) needs the same press-and-hold
// expressiveness as every other input path, not a fixed blip: holding
// Enter/Space sustains the note for as long as it's held, exactly like a
// held pointer or a held home-row key. preventDefault on keydown stops the
// button's own default activation from also firing a click for the same
// press, which would otherwise double-trigger noteOn.
instrument?.addEventListener("keydown", (event) => {
  const pad = (event.target as HTMLElement).closest<HTMLElement>(".pad");
  if (!pad || (event.key !== " " && event.key !== "Enter")) return;
  event.preventDefault();
  if (event.repeat) return;
  noteOn(`focus-${pad.dataset.key}`, frequencyOf(pad), pad);
});

instrument?.addEventListener("keyup", (event) => {
  const pad = (event.target as HTMLElement).closest<HTMLElement>(".pad");
  if (!pad || (event.key !== " " && event.key !== "Enter")) return;
  noteOff(`focus-${pad.dataset.key}`, pad);
});

// Tabbing away mid-hold moves focus before the physical key comes back up, so
// the eventual keyup lands on whatever now has focus, not the pad that
// started the note — without this, that pad drones forever. focusout fires
// the instant focus actually leaves the pad (Tab, Shift+Tab, a click
// elsewhere), which is exactly when the hold should end.
instrument?.addEventListener("focusout", (event) => {
  const pad = (event.target as HTMLElement).closest<HTMLElement>(".pad");
  if (!pad) return;
  noteOff(`focus-${pad.dataset.key}`, pad);
});

// Assistive tech that activates a control by calling .click() directly, with
// no keydown/keyup pair at all, never reaches the listeners above — this
// fallback (detail === 0 marks a non-pointer click) gives that path a short
// blip rather than silence.
instrument?.addEventListener("click", (event) => {
  if (event.detail !== 0) return; // real pointer clicks already handled above
  const pad = (event.target as HTMLElement).closest<HTMLElement>(".pad");
  if (!pad) return;
  const voiceId = `click-${pad.dataset.key}`;
  noteOn(voiceId, frequencyOf(pad), pad);
  window.setTimeout(() => noteOff(voiceId, pad), 180);
});

// Home-row keys give a stranger a second, un-pointed-at way to play: press
// and hold any of A S D F G H J K, chords included.
const keyPads = new Map<string, HTMLElement>();
for (const pad of pads) {
  const key = pad.dataset.key;
  if (key) keyPads.set(key, pad);
}

// A melody that only ever touches the eight pads, so it can never play a
// note the instrument itself couldn't — the pentatonic scale means any order
// of these keys stays consonant.
const MELODY: { key: string; duration: number }[] = [
  { key: "a", duration: 320 },
  { key: "d", duration: 320 },
  { key: "g", duration: 320 },
  { key: "j", duration: 480 },
  { key: "g", duration: 320 },
  { key: "d", duration: 320 },
  { key: "a", duration: 480 },
  { key: "f", duration: 320 },
  { key: "h", duration: 320 },
  { key: "k", duration: 480 },
  { key: "h", duration: 320 },
  { key: "f", duration: 320 },
  { key: "d", duration: 320 },
  { key: "g", duration: 320 },
  { key: "a", duration: 640 },
];

const autoplayButton = document.querySelector<HTMLButtonElement>("#autoplay");
let melodyPlaying = false;
let melodyTimeout: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    melodyTimeout = window.setTimeout(resolve, ms);
  });
}

function setAutoplayLabel(playing: boolean) {
  if (!autoplayButton) return;
  autoplayButton.setAttribute("aria-pressed", String(playing));
  autoplayButton.textContent = playing ? "Stop melody" : "Play melody";
}

function stopMelody() {
  melodyPlaying = false;
  if (melodyTimeout !== null) {
    window.clearTimeout(melodyTimeout);
    melodyTimeout = null;
  }
  for (const voiceId of Array.from(voices.keys())) {
    if (voiceId.startsWith("melody-")) noteOff(voiceId, keyPads.get(voiceId.slice(7)) ?? null);
  }
  setAutoplayLabel(false);
}

async function playMelody() {
  melodyPlaying = true;
  setAutoplayLabel(true);
  ensureAudio();

  for (const { key, duration } of MELODY) {
    if (!melodyPlaying) return;
    const pad = keyPads.get(key);
    if (!pad) continue;
    const voiceId = `melody-${key}`;
    noteOn(voiceId, frequencyOf(pad), pad);
    await sleep(duration * 0.85);
    if (!melodyPlaying) return;
    noteOff(voiceId, pad);
    await sleep(duration * 0.15);
  }

  melodyPlaying = false;
  setAutoplayLabel(false);
}

autoplayButton?.addEventListener("click", () => {
  if (melodyPlaying) {
    stopMelody();
  } else {
    void playMelody();
  }
});

const BRIGHTNESS_STEP = 0.08;

document.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  const key = event.key.toLowerCase();

  const pad = keyPads.get(key);
  if (pad) {
    noteOn(`key-${key}`, frequencyOf(pad), pad);
    return;
  }

  if (key === "arrowup") {
    event.preventDefault();
    ensureAudio();
    setBrightness(brightness + BRIGHTNESS_STEP);
  } else if (key === "arrowdown") {
    event.preventDefault();
    ensureAudio();
    setBrightness(brightness - BRIGHTNESS_STEP);
  }
});

document.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  const pad = keyPads.get(key);
  if (pad) noteOff(`key-${key}`, pad);
});

// A held key or pointer whose release never reaches the page — the tab loses
// focus mid-note, most commonly an alt-tab away — would otherwise drone
// forever, since keyup/pointerup only fire on the page that's still focused.
// Releasing every voice on blur turns that into an ordinary note-off.
function releaseAllVoices() {
  melodyPlaying = false;
  if (melodyTimeout !== null) {
    window.clearTimeout(melodyTimeout);
    melodyTimeout = null;
  }
  setAutoplayLabel(false);
  for (const voiceId of Array.from(voices.keys())) {
    noteOff(voiceId, null, voiceId.startsWith("loop-"));
  }
  pointerPads.clear();
  for (const pad of pads) {
    pad.classList.remove("active");
    pad.classList.remove("loop-echo");
    pad.style.setProperty("--hue", String(baseHue.get(pad) ?? 310));
    resetStretch(pad);
  }
  padClassRefs.clear();
  updatePitchDisplay();
}

window.addEventListener("blur", releaseAllVoices);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAllVoices();
});

// A one-layer looper: record a phrase, then it plays back on repeat while you
// play live on top — the thing a single-voice-per-touch instrument implies
// (layering a texture) but never itself offers.
type Press = { pad: HTMLElement; freq: number; onAt: number; offAt: number };

const MIN_LOOP_MS = 400;
let loopState: "idle" | "recording" | "playing" = "idle";
let recordedPresses: Press[] = [];
const openPresses = new Map<string, { pad: HTMLElement; freq: number; onAt: number }>();
let loopStartTime = 0;
let loopDurationMs = 0;
let loopTimers: number[] = [];

const loopButton = document.querySelector<HTMLButtonElement>("#loop-button");
const loopLabel = document.querySelector<HTMLElement>("#loop-label");
const loopStatus = document.querySelector<HTMLElement>("#loop-status");

function recordNoteOn(voiceId: string, freq: number, pad: HTMLElement | null) {
  if (!pad) return;
  openPresses.set(voiceId, { pad, freq, onAt: performance.now() - loopStartTime });
}

function recordNoteOff(voiceId: string) {
  const open = openPresses.get(voiceId);
  if (!open) return;
  openPresses.delete(voiceId);
  recordedPresses.push({ ...open, offAt: performance.now() - loopStartTime });
}

function clearLoopTimers() {
  for (const timer of loopTimers) window.clearTimeout(timer);
  loopTimers = [];
}

function scheduleLoopCycle() {
  recordedPresses.forEach((press, index) => {
    const voiceId = `loop-${index}`;
    loopTimers.push(
      window.setTimeout(() => noteOn(voiceId, press.freq, press.pad, true), press.onAt),
      window.setTimeout(
        () => noteOff(voiceId, press.pad, true),
        Math.max(press.offAt, press.onAt + 10),
      ),
    );
  });
  loopTimers.push(window.setTimeout(scheduleLoopCycle, loopDurationMs));
}

function stopLoopPlayback() {
  clearLoopTimers();
  recordedPresses.forEach((press, index) => noteOff(`loop-${index}`, press.pad, true));
}

function setLoopUI(state: typeof loopState) {
  if (!loopButton || !loopLabel || !loopStatus) return;
  loopButton.dataset.state = state;
  loopButton.setAttribute("aria-pressed", String(state !== "idle"));
  if (state === "idle") {
    loopLabel.textContent = "Record a loop";
    loopStatus.textContent = "Loop cleared.";
  } else if (state === "recording") {
    loopLabel.textContent = "Stop recording";
    loopStatus.textContent = "Recording a loop — play some notes.";
  } else {
    loopLabel.textContent = "Clear loop";
    loopStatus.textContent = "Loop playing back. Play along, or clear it.";
  }
}

function cycleLoop() {
  if (loopState === "idle") {
    ensureAudio();
    loopState = "recording";
    recordedPresses = [];
    openPresses.clear();
    loopStartTime = performance.now();
  } else if (loopState === "recording") {
    loopDurationMs = Math.max(MIN_LOOP_MS, performance.now() - loopStartTime);
    openPresses.clear();
    if (recordedPresses.length === 0) {
      loopState = "idle";
    } else {
      loopState = "playing";
      scheduleLoopCycle();
    }
  } else {
    stopLoopPlayback();
    loopState = "idle";
  }
  setLoopUI(loopState);
}

loopButton?.addEventListener("click", cycleLoop);

document.addEventListener("keydown", (event) => {
  if (event.repeat || event.key.toLowerCase() !== "l") return;
  event.preventDefault();
  cycleLoop();
});

setBrightness(brightness);
