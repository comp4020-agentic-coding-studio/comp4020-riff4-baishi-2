// Drift: an eight-pad pentatonic instrument. Every note lives in the same
// scale, so any combination of pads — one finger or five — sounds
// consonant. Vertical position sweeps a shared filter and delay, so the
// same notes feel brighter or darker depending on where you touch.

const MIN_CUTOFF = 350;
const MAX_CUTOFF = 6000;
const ATTACK = 0.012;
const RELEASE = 0.35;

const instrument = document.querySelector<HTMLElement>("#instrument");
const hint = document.querySelector<HTMLElement>("#hint");
const pads = Array.from(document.querySelectorAll<HTMLButtonElement>(".pad"));

let audioContext: AudioContext | null = null;
let masterFilter: BiquadFilterNode | null = null;
let brightness = 0.5; // 0 = dark, 1 = bright — also drives the CSS backdrop.

type Voice = { oscillator: OscillatorNode; gain: GainNode };
const voices = new Map<string, Voice>();

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
}

function noteOff(voiceId: string, pad: HTMLElement | null, fromLoop = false) {
  const voice = voices.get(voiceId);
  if (fromLoop) {
    padRefs(pad, "loop-echo").release();
  } else {
    padRefs(pad, "active").release();
    if (loopState === "recording") recordNoteOff(voiceId);
  }
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

function updateBrightnessFromClientY(clientY: number) {
  const ratio = 1 - clientY / window.innerHeight;
  setBrightness(ratio);
}

// Pointer events unify mouse and touch, and each pointerId is its own
// voice, so a mouse drag glides between pads (glissando) while several
// simultaneous touches play a chord.
const pointerPads = new Map<number, HTMLElement>();

function padUnderPoint(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  return el?.closest<HTMLElement>(".pad") ?? null;
}

instrument?.addEventListener("pointerdown", (event) => {
  const pad = (event.target as HTMLElement).closest<HTMLElement>(".pad");
  if (!pad) return;
  event.preventDefault();
  pointerPads.set(event.pointerId, pad);
  noteOn(`pointer-${event.pointerId}`, frequencyOf(pad), pad);
  updateBrightnessFromClientY(event.clientY);
});

document.addEventListener("pointermove", (event) => {
  updateBrightnessFromClientY(event.clientY);

  const currentPad = pointerPads.get(event.pointerId);
  if (!currentPad) return;

  const pad = padUnderPoint(event.clientX, event.clientY);
  if (pad && pad !== currentPad) {
    noteOff(`pointer-${event.pointerId}`, currentPad);
    pointerPads.set(event.pointerId, pad);
    noteOn(`pointer-${event.pointerId}`, frequencyOf(pad), pad);
  }
});

function releasePointer(event: PointerEvent) {
  const pad = pointerPads.get(event.pointerId);
  if (!pad) return;
  noteOff(`pointer-${event.pointerId}`, pad);
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
  for (const voiceId of Array.from(voices.keys())) {
    noteOff(voiceId, null, voiceId.startsWith("loop-"));
  }
  pointerPads.clear();
  for (const pad of pads) pad.classList.remove("active", "loop-echo");
  padClassRefs.clear();
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
