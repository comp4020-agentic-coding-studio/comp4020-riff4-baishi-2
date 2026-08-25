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

function noteOn(voiceId: string, frequency: number, pad: HTMLElement | null) {
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
  pad?.classList.add("active");
  markPlayed();
}

function noteOff(voiceId: string, pad: HTMLElement | null) {
  const voice = voices.get(voiceId);
  pad?.classList.remove("active");
  if (!voice || !audioContext) return;

  const { oscillator, gain } = voice;
  const now = audioContext.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(0, now + RELEASE);
  oscillator.stop(now + RELEASE + 0.05);
  voices.delete(voiceId);
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
    noteOff(voiceId, null);
  }
  pointerPads.clear();
  for (const pad of pads) pad.classList.remove("active");
}

window.addEventListener("blur", releaseAllVoices);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAllVoices();
});

setBrightness(brightness);
