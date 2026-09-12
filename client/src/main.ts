import { Game, LAPS, type Standing } from './game';
import { HandTracker } from './hands';
import { Hud, fmt } from './hud';
import { Net, type PlayerInfo } from './net';
import { Commentator } from './commentator';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const COLORS = [0xff3b3b, 0x3d7bff, 0x3dff8a, 0xffd23d, 0xff7ae0, 0x8a3dff];

const video = $<HTMLVideoElement>('video');
const hands = new HandTracker(video);
const hud = new Hud();
const game = new Game($<HTMLCanvasElement>('game'), hands, hud);

const lobby = $('lobby');
const lobbyMsg = $('lobbyMsg');
const nameInput = $<HTMLInputElement>('name');
const roomInput = $<HTMLInputElement>('room');
const trackSelect = $<HTMLSelectElement>('track');
const roomPanel = $('roomPanel');
const playersList = $('players');
const results = $('results');

let net: Net | null = null;
let players: PlayerInfo[] = [];

nameInput.value = localStorage.getItem('gw:name') ?? '';

const commentator = new Commentator(
  () => {
    const st = game.standings();
    const events = game.pendingEvents.splice(0);
    return {
      driver: game.local.name,
      lap: game.lap + 1,
      laps: LAPS,
      place: st.findIndex((s) => s.id === game.local.id) + 1,
      total: st.length,
      elapsedSec: Math.round((Date.now() - game.startAt) / 1000),
      speedKmh: Math.round(game.car.speed * 3.6),
      standings: st.map((s) => ({ name: s.name, lap: s.lap, progress: Math.round(s.progress * 100) / 100, finished: s.finished })),
      events,
      phase: game.phase,
    };
  },
  () => hands.snapshot(),
  (line) => hud.say(line),
);

// ---------- commentator settings ----------
const settingsPanel = $('settings');
const voiceSel = $<HTMLSelectElement>('voiceSel');
const toneSel = $<HTMLSelectElement>('toneSel');
const customToneWrap = $('customToneWrap');
const customTone = $<HTMLTextAreaElement>('customTone');
const settingsMsg = $('settingsMsg');
let usingElevenLabs = false;

function loadSettings(): void {
  try {
    const saved = JSON.parse(localStorage.getItem('gw:commentator') ?? '{}');
    Object.assign(commentator.settings, saved);
  } catch { /* ignore */ }
}
function saveSettings(): void {
  localStorage.setItem('gw:commentator', JSON.stringify(commentator.settings));
}
function fillSelect(sel: HTMLSelectElement, items: { id: string; name: string }[], selected: string): void {
  sel.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = it.name;
    sel.appendChild(o);
  }
  if (items.some((i) => i.id === selected)) sel.value = selected;
}
function fillBrowserVoices(): void {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  fillSelect(voiceSel, voices.map((v) => ({ id: v.name, name: `${v.name} (browser)` })), commentator.settings.browserVoice);
  if (!voices.some((v) => v.name === commentator.settings.browserVoice)) commentator.settings.browserVoice = voiceSel.value;
}

async function initSettings(): Promise<void> {
  loadSettings();
  try {
    const res = await fetch('/api/voices');
    const data = (await res.json()) as { voices: { id: string; name: string; description: string }[]; personas: { id: string; name: string }[]; elevenlabs: boolean };
    fillSelect(toneSel, [...data.personas, { id: 'custom', name: 'Custom…' }], commentator.settings.tone);
    usingElevenLabs = data.elevenlabs && data.voices.length > 0;
    if (usingElevenLabs) {
      fillSelect(voiceSel, data.voices.map((v) => ({ id: v.id, name: v.description ? `${v.name} — ${v.description}` : v.name })), commentator.settings.voiceId);
      commentator.settings.voiceId = voiceSel.value;
    } else {
      settingsMsg.textContent = data.elevenlabs ? 'No ElevenLabs voices found; using browser speech.' : 'No ElevenLabs key; using browser speech.';
      fillBrowserVoices();
      speechSynthesis.addEventListener('voiceschanged', fillBrowserVoices);
    }
  } catch {
    settingsMsg.textContent = 'Server not reachable; commentator settings unavailable.';
  }
  customToneWrap.hidden = commentator.settings.tone !== 'custom';
  customTone.value = commentator.settings.customTone;
}
void initSettings();

$('settingsBtn').addEventListener('click', () => { settingsPanel.hidden = !settingsPanel.hidden; });
$('closeSettings').addEventListener('click', () => { settingsPanel.hidden = true; });
voiceSel.addEventListener('change', () => {
  if (usingElevenLabs) commentator.settings.voiceId = voiceSel.value;
  else commentator.settings.browserVoice = voiceSel.value;
  saveSettings();
});
toneSel.addEventListener('change', () => {
  commentator.settings.tone = toneSel.value;
  customToneWrap.hidden = toneSel.value !== 'custom';
  saveSettings();
});
customTone.addEventListener('input', () => {
  commentator.settings.customTone = customTone.value;
  saveSettings();
});
$('testVoice').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  settingsMsg.textContent = 'Asking the commentator…';
  await commentator.sayNow();
  settingsMsg.textContent = '';
  btn.disabled = false;
});

$('muteBtn').addEventListener('click', (e) => {
  commentator.muted = !commentator.muted;
  (e.currentTarget as HTMLElement).textContent = commentator.muted ? '🔇' : '🔊';
  if (commentator.muted) speechSynthesis?.cancel();
});

function driverName(): string {
  const n = nameInput.value.trim() || `Driver${Math.floor(Math.random() * 900 + 100)}`;
  localStorage.setItem('gw:name', n);
  return n;
}

async function ensureCamera(): Promise<boolean> {
  if (hands.ready) return true;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    lobbyMsg.textContent = 'The browser blocks the camera on plain http:// addresses. Open this page over https:// (accept the certificate warning) or use http://localhost:5173 on the host laptop.';
    return false;
  }
  lobbyMsg.textContent = 'Starting camera and loading hand tracker…';
  try {
    await hands.init();
    lobbyMsg.textContent = 'Camera ready. Hold your hands up like you are gripping a wheel.';
    return true;
  } catch (err) {
    lobbyMsg.textContent = `Camera failed: ${(err as Error).message}`;
    return false;
  }
}

function beginRace(at: number, slot: number): void {
  lobby.hidden = true;
  results.hidden = true;
  game.startRace(at, slot);
  commentator.start();
}

game.onFinish = (standings) => showResults(standings);

function showResults(standings: Standing[]): void {
  const ol = $('standings');
  ol.innerHTML = '';
  for (const s of standings) {
    const li = document.createElement('li');
    li.textContent = `${s.name} — ${s.finished !== undefined ? fmt(s.finished) : 'still racing'}`;
    ol.appendChild(li);
  }
  results.hidden = false;
}

$('againBtn').addEventListener('click', () => {
  results.hidden = true;
  lobby.hidden = false;
  commentator.stop();
  hud.show(false);
  game.phase = 'idle';
});

$('soloBtn').addEventListener('click', async () => {
  if (!(await ensureCamera())) return;
  net?.close();
  net = null;
  game.net = null;
  game.setLocal({ id: 'local', name: driverName(), color: COLORS[0] });
  game.syncPlayers([]);
  game.setTrack(trackSelect.value, 1337);
  beginRace(Date.now() + 3500, 0);
});

$('joinBtn').addEventListener('click', async () => {
  const room = roomInput.value.trim().toLowerCase();
  if (!room) { lobbyMsg.textContent = 'Enter a room code first.'; return; }
  if (!(await ensureCamera())) return;
  net?.close();
  net = new Net();
  try {
    await net.connect();
  } catch (err) {
    lobbyMsg.textContent = `${(err as Error).message}. Is the server running?`;
    net = null;
    return;
  }
  game.net = net;
  net.on((msg) => {
    switch (msg.type) {
      case 'welcome': {
        players = msg.players;
        const me = players.find((p) => p.id === msg.id)!;
        game.setLocal(me);
        game.setTrack(trackSelect.value, msg.seed);
        game.syncPlayers(players);
        renderPlayers();
        roomPanel.hidden = false;
        $('roomCode').textContent = room.toUpperCase();
        lobbyMsg.textContent = 'Waiting for the race to start.';
        void showLanHint(room);
        break;
      }
      case 'players':
        players = msg.players;
        game.syncPlayers(players);
        renderPlayers();
        break;
      case 'start': {
        const slot = Math.max(0, players.findIndex((p) => p.id === net!.id));
        if (msg.track && msg.track !== game.trackName) game.setTrack(msg.track, msg.seed);
        beginRace(msg.at, slot);
        break;
      }
      case 'state':
        game.updateRemote(msg.id, msg);
        break;
      case 'event':
        if (msg.id !== net!.id) game.pendingEvents.push(msg.text);
        break;
      case 'finish':
        game.finishRemote(msg.id, msg.time);
        if (msg.id !== net!.id) game.pendingEvents.push(`${msg.name} finished in P${msg.place}`);
        break;
      case 'leave':
        game.removeRemote(msg.id);
        break;
      case 'error':
        lobbyMsg.textContent = msg.message;
        break;
    }
  });
  net.send({ type: 'join', room, name: driverName() });
});

$('startBtn').addEventListener('click', () => net?.send({ type: 'start', track: trackSelect.value }));

async function showLanHint(room: string): Promise<void> {
  const hint = $('lanHint');
  try {
    const res = await fetch('/api/health');
    const { lan } = (await res.json()) as { lan: string[] };
    const port = location.port ? `:${location.port}` : '';
    hint.textContent = lan.length
      ? `Friends on this Wi-Fi: open ${location.protocol}//${lan[0]}${port} (accept the certificate warning) and join room "${room}".`
      : `Share this page's address and room code "${room}".`;
  } catch {
    hint.textContent = '';
  }
}

function renderPlayers(): void {
  playersList.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.textContent = p.name + (p.id === net?.id ? ' (you)' : '');
    li.style.color = `#${p.color.toString(16).padStart(6, '0')}`;
    playersList.appendChild(li);
  }
}
