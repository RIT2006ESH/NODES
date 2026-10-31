/**
 * Client: connection, state reduction, input, HUD.
 *
 * The client never invents state. Snapshots replace; deltas apply engine events.
 * Optimistic links are drawn as dashed lines and reconcile on `action_result`.
 */

import {
  REJECTION_COPY,
  type ClientMessage,
  type DeltaMessage,
  type LinkRequestView,
  type LinkView,
  type NodeView,
  type Phase,
  type PublicConfig,
  type ReasonCode,
  type ScoreView,
  type ServerMessage,
  type SnapshotMessage,
  type StatsView,
  type PacketMissionView,
  type YouView,
  type TeamView,
} from '@mng/protocol';
import { drawBoard, fitCamera, pickNode, toWorld, type Camera, type PendingLink } from './render';
import { Fx, Sfx } from './fx';
import {
  ACHIEVEMENTS,
  analyseNetwork,
  applyProgress,
  gradeFor,
  loadProgress,
  rankFor,
  saveProgress,
  STRIKE_NAME,
  type Analysis,
  type ProgressEvent,
} from './insight';
import {
  buildLeaderboard,
  RELATION_LABEL,
  searchPlayers,
  STATUS_LABEL,
  type PlayerEntry,
} from './community';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const el = {
  phase: document.getElementById('phase') as HTMLElement,
  countdown: document.getElementById('countdown') as HTMLElement,
  score: document.getElementById('score') as HTMLElement,
  health: document.getElementById('health') as HTMLElement,
  tokenPips: [...document.querySelectorAll<HTMLElement>('#tokens i')],
  tokenTimer: document.getElementById('tokenTimer') as HTMLElement,
  hint: document.getElementById('hint') as HTMLElement,
  findMe: document.getElementById('findMe') as HTMLButtonElement,
  pingNetwork: document.getElementById('pingNetwork') as HTMLButtonElement,
  pulseResult: document.getElementById('pulseResult') as HTMLElement,
  failurePreview: document.getElementById('failurePreview') as HTMLElement,
  banner: document.getElementById('banner') as HTMLElement,
  toasts: document.getElementById('toasts') as HTMLElement,
  join: document.getElementById('join') as HTMLElement,
  name: document.getElementById('name') as HTMLInputElement,
  nameWarning: document.getElementById('nameWarning') as HTMLElement,
  play: document.getElementById('play') as HTMLButtonElement,
  requests: document.getElementById('requests') as HTMLElement,
  outgoing: document.getElementById('outgoing') as HTMLElement,
  requestBar: document.getElementById('requestBar') as HTMLElement,
  requestText: document.getElementById('requestText') as HTMLElement,
  requestStatus: document.getElementById('requestStatus') as HTMLElement,
  requestSend: document.getElementById('requestSend') as HTMLButtonElement,
  requestCancel: document.getElementById('requestCancel') as HTMLButtonElement,
  searchPanel: document.getElementById('searchPanel') as HTMLElement,
  searchInput: document.getElementById('playerSearch') as HTMLInputElement,
  searchClear: document.getElementById('searchClear') as HTMLButtonElement,
  searchResults: document.getElementById('searchResults') as HTMLElement,
  leaderboard: document.getElementById('leaderboard') as HTMLElement,
  lbToggle: document.getElementById('lbToggle') as HTMLButtonElement,
  lbCount: document.getElementById('lbCount') as HTMLElement,
  lbBody: document.getElementById('lbBody') as HTMLElement,
  lbList: document.getElementById('lbList') as HTMLOListElement,
  teamList: document.getElementById('teamList') as HTMLElement,
  teamGroupCount: document.getElementById('teamGroupCount') as HTMLElement,
  smokeRoomStatus: document.getElementById('smokeRoomStatus') as HTMLElement,
  smokeRoomDetails: document.getElementById('smokeRoomDetails') as HTMLElement,
  openSmokeRoom: document.getElementById('openSmokeRoom') as HTMLButtonElement,
  inviteSmokeMembers: document.getElementById('inviteSmokeMembers') as HTMLButtonElement,
  viewSmokeMembers: document.getElementById('viewSmokeMembers') as HTMLButtonElement,
  teamNameDialog: document.getElementById('teamNameDialog') as HTMLElement,
  teamNameInput: document.getElementById('teamNameInput') as HTMLInputElement,
  teamDescriptionInput: document.getElementById('teamDescriptionInput') as HTMLTextAreaElement,
  teamNameSave: document.getElementById('teamNameSave') as HTMLButtonElement,
  teamNameLater: document.getElementById('teamNameLater') as HTMLButtonElement,
  worldCount: document.getElementById('worldCount') as HTMLElement,
  playerCard: document.getElementById('playerCard') as HTMLElement,
  learnLibp2p: document.getElementById('learnLibp2p') as HTMLButtonElement,
  learnPanel: document.getElementById('learnPanel') as HTMLElement,
  learnClose: document.getElementById('learnClose') as HTMLButtonElement,
  packetMission: document.getElementById('packetMission') as HTMLElement,
  packetDot: document.getElementById('packetDot') as HTMLElement,
  activityItems: document.getElementById('activityItems') as HTMLElement,
  libp2pPopup: document.getElementById('libp2pPopup') as HTMLElement,
  integrity: document.getElementById('integrity') as HTMLElement,
  weakChip: document.getElementById('weakChip') as HTMLButtonElement,
  toggleWeak: document.getElementById('toggleWeak') as HTMLButtonElement,
  toggleSound: document.getElementById('toggleSound') as HTMLButtonElement,
  operator: document.getElementById('operator') as HTMLButtonElement,
  opLevel: document.getElementById('opLevel') as HTMLElement,
  opTitle: document.getElementById('opTitle') as HTMLElement,
  opXp: document.getElementById('opXp') as HTMLElement,
  opBar: document.getElementById('opBar') as HTMLElement,
  resultCard: document.getElementById('resultCard') as HTMLElement,
  achievements: document.getElementById('achievements') as HTMLElement,
};

const spectator =
  location.pathname.startsWith('/screen') || new URLSearchParams(location.search).get('spectate') === '1';
if (spectator) document.body.classList.add('screen');

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

interface Model {
  me: YouView | null;
  phase: Phase;
  endsAt: number;
  roundNo: number;
  nodes: Map<string, NodeView>;
  links: Map<string, LinkView>;
  /** Pending server-owned requests, never active edges. */
  incoming: Map<string, LinkRequestView>;
  outgoing: Map<string, LinkRequestView>;
  /** Smooth display positions, eased toward the authoritative node positions. */
  visual: Map<string, { x: number; y: number }>;
  lastScore: ScoreView | null;
  history: number[];
  stats: StatsView | null;
  config: PublicConfig | null;
  offset: number; // server clock - local clock
  packetMission: PacketMissionView | null;
  teams: TeamView[];
}

const model: Model = {
  me: null,
  phase: 'seeding',
  endsAt: 0,
  roundNo: 0,
  nodes: new Map(),
  links: new Map(),
  incoming: new Map(),
  outgoing: new Map(),
  visual: new Map(),
  lastScore: null,
  history: [],
  stats: null,
  config: null,
  offset: 0,
  packetMission: null,
  teams: [],
};
let promptedTeamId: string | null = null;

// Gameplay layer (cosmetic + strategic; never changes a rule).
const fx = new Fx();
const sfx = new Sfx();
let radarOn = (() => { try { return localStorage.getItem('mng.radar') !== '0'; } catch { return true; } })();
let analysis: Analysis = analyseNetwork(new Map(), new Map());
let progress = loadProgress();
let prevPhase: Phase | null = null;
let weakCursor = 0;
let resultTimer = 0;
let recoverFlashUntil = 0;
let resilientRound = -1;

const pending = new Map<string, PendingLink & { requestId: string }>();
let camera: Camera = { scale: 1, ox: 0, oy: 0 };
let pulseUntil = 0;
let youAt = 0;
let readOnly = false;
/** Selected target for an explicit connection request. */
let selectedTargetId: string | null = null;
/** True between sending a request and receiving the initial server answer. */
let requestSending = false;
let requestSendTimer = 0;
const responsePending = new Set<string>();
const responseTimers = new Map<string, number>();
let highlightId: string | null = null;
let highlightUntil = 0;
let focusNodeId: string | null = null;
let focusUntil = 0;
let focusScale = 1.2;
let searchOpen = false;
let searchActiveIndex = -1;
let searchMatches: PlayerEntry[] = [];
let hoveredNodeId: string | null = null;
let cardHideTimer = 0;
let welcomeUntil = 0;
let firstConnectionSeen = false;
let packetCardKey = '';
let packetAnnouncementKey = '';
let libp2pPopupTimer = 0;
const educationalShown = new Set<string>();
const linkPulses = new Map<string, number>();
let outageFlashUntil = 0;
interface PulseSegment { a: string; b: string; at: number; }
let networkPulse: { startedAt: number; segments: PulseSegment[]; reachable: Set<string>; unreachable: Set<string>; doneAt: number } | null = null;
let pulseResultTimer = 0;
let failurePreview: { removedId: string; components: Map<string, number>; groups: number; unreachable: number } | null = null;

function activity(text: string, kind = ''): void {
  const item = document.createElement('div'); item.className = `activityItem ${kind}`; item.textContent = text;
  el.activityItems.prepend(item);
  while (el.activityItems.children.length > 4) el.activityItems.lastElementChild?.remove();
}

const LEADERBOARD_KEY = 'mng.leaderboard.collapsed.v1';
function initialLeaderboardCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(LEADERBOARD_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    // ignore storage restrictions
  }
  return window.matchMedia('(max-width: 720px)').matches;
}
let leaderboardCollapsed = initialLeaderboardCollapsed();

const MOVE_SEND_MS = 45;
const KEY_SPEED = 420; // world units per second
const heldKeys = new Set<string>();
let lastMoveSentAt = 0;
let lastSent = { x: 0, y: 0 };
let cameraReady = false;
let lastFrameAt = 0;

interface DragState {
  pointerId: number;
  startSX: number;
  startSY: number;
  camera: Camera;
  moved: boolean;
}
let drag: DragState | null = null;

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'mng.token.v1';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function saveToken(value: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, value);
  } catch {
    // Private mode or a full quota: play continues without resume.
  }
}
function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

let token: string | null = readToken();
let socket: WebSocket | null = null;
let joined = false;
let lastSeen = 0;
let retry = 0;
let reconnectTimer: number | null = null;

function wsUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams();
  if (spectator) params.set('spectate', '1');
  else if (token) params.set('token', token);
  const query = params.toString();
  return `${protocol}://${location.host}/ws${query ? `?${query}` : ''}`;
}

function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  setBanner(retry > 0 ? 'Reconnecting…' : null, 'info');

  const ws = new WebSocket(wsUrl());
  socket = ws;

  ws.addEventListener('open', () => {
    lastSeen = Date.now();
    if (token) {
      // A stale token after a server restart is silent: fall back to joining.
      window.setTimeout(() => {
        if (!joined && socket === ws && !spectator) {
          token = null;
          clearToken();
          showJoin();
          setBanner(null);
        }
      }, 3000);
    }
  });

  ws.addEventListener('message', (event) => {
    lastSeen = Date.now();
    let message: ServerMessage;
    try {
      message = JSON.parse(String(event.data)) as ServerMessage;
    } catch {
      return;
    }
    handleMessage(message);
  });

  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    el.play.disabled = false;
    if (spectator && !joined) return;
    if (!readOnly) setBanner('Reconnecting…', 'info');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // close fires afterwards and handles backoff
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = Math.min(8000, 500 * 2 ** retry++);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(message: ClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function handleMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'welcome':
      el.play.disabled = false;
      if (message.token) {
        token = message.token;
        saveToken(token);
      }
      break;

    case 'snapshot':
      applySnapshot(message);
      onJoined();
      break;

    case 'delta':
      applyDelta(message);
      onJoined();
      break;

    case 'action_result': {
      // Kept for compatibility with older event clients. The consent flow uses
      // request_result and never creates an edge from a local action.
      pending.delete(message.requestId);
      if (!message.ok) {
        const retryMs = message.retryAfterMs ?? 0;
        let seconds = Math.max(1, Math.ceil(retryMs / 1000));
        if (message.reason === 'NO_TOKENS' && model.me) {
          seconds = Math.max(1, Math.ceil(model.me.nextTokenInMs / 1000));
        }
        const copy = REJECTION_COPY[message.reason as ReasonCode] ?? 'Could not confirm, try again';
        toast(copy.replace('{N}', String(seconds)), 'bad');
      }
      break;
    }

    case 'link_request':
      model.incoming.set(message.request.requestId, message.request);
      toast(`${message.request.fromName} wants to connect`, 'info');
      sfx.request();
      renderRequests();
      renderTargetBar();
      if (searchOpen) renderSearchResults();
      renderLeaderboard();
      break;

    case 'request_result':
      applyRequestResult(message);
      break;

    case 'mesh_event':
      if (message.event.type === 'node.offline') {
        toast(`Player ${message.event.name} has gone offline and has been removed from the active mesh.`, 'info');
      } else if (message.event.type === 'mesh.leader_changed') {
        toast(`Player ${message.event.previousLeaderName} has gone offline. ${message.event.leaderName} is now the new Mesh Leader.`, 'info');
      }
      break;

    case 'smoke_invite':
      window.dispatchEvent(new CustomEvent('smoke-invite', { detail: message }));
      break;

    case 'error':
      handleError(message.code);
      break;

    case 'pong':
      model.offset = message.serverNow - Date.now();
      break;
  }
}


function showNameWarning(text: string): void {
  if (el.nameWarning) {
    el.nameWarning.textContent = text;
    el.nameWarning.hidden = false;
  }
}

function clearNameWarning(): void {
  if (el.nameWarning) {
    el.nameWarning.textContent = '';
    el.nameWarning.hidden = true;
  }
}

function handleError(code: string): void {
  el.play.disabled = false;
  if (code === 'RESET') {
    token = null;
    clearToken();
    joined = false;
    readOnly = false;
    pending.clear();
    model.nodes.clear();
    model.links.clear();
    model.incoming.clear();
    model.outgoing.clear();
    model.me = null;
    selectedTargetId = null;
    requestSending = false;
    highlightId = null;
    focusNodeId = null;
    delete canvas.dataset.focusNode;
    closeSearch();
    renderRequests();
    renderTargetBar();
    renderLeaderboard();
    el.join.hidden = false;
    setBanner('The network was reset by the organizers.', 'info');
    return;
  }
  if (code === 'INVALID_TOKEN') {
    token = null;
    clearToken();
    showJoin();
    setBanner(null);
    return;
  }
  if (code === 'NOT_JOINED') {
    showJoin();
    return;
  }
  if (code === 'SESSION_BANNED') {
    readOnly = true;
    setBanner('This session was closed by the organizers.', 'error');
    return;
  }
  if (code === 'SPECTATOR_READ_ONLY') {
    setBanner('Spectator view is read-only.', 'info');
    return;
  }
  if (code === 'BAD_TEAM_NAME') {
    toast('Team names must be 3-24 valid characters', 'bad');
    el.teamNameDialog.hidden = false;
    return;
  }
  if (code === 'TEAM_NAME_TAKEN') {
    toast('That team name is already in use', 'bad');
    el.teamNameDialog.hidden = false;
    return;
  }
  if (code === 'NOT_TEAM_LEADER') {
    toast('Only the mesh leader can set or rename the team', 'bad');
    return;
  }
  if (code === 'TEAM_NAME_LOOKUP_FAILED') {
    toast('Could not verify team name availability, please try again', 'bad');
    el.teamNameDialog.hidden = false;
    return;
  }
  if (code === 'TEAM_NOT_FOUND') {
    toast('That team changed — refresh the network view', 'bad');
    return;
  }
  if (code === 'USERNAME_TAKEN') {
    showJoin();
    showNameWarning('⚠️ That username is already taken. Please choose another.');
    toast('That username is already taken. Please choose another.', 'bad');
    el.name.focus();
    return;
  }
  if (code === 'INVALID_USERNAME') {
    showJoin();
    showNameWarning('⚠️ Usernames must be 3-20 letters, numbers, or underscores.');
    toast('Usernames must be 3-20 letters, numbers, or underscores.', 'bad');
    el.name.focus();
    return;
  }
  toast('Could not confirm, try again', 'bad');
}

function onJoined(): void {
  joined = true;
  if (el.operator.hidden) renderOperator();
  retry = 0;
  readOnly = false;
  el.play.disabled = false;
  el.join.hidden = true;
  setBanner(null);
  if (!localStorage.getItem('mng.onboarding.v1')) {
    welcomeUntil = Date.now() + 6500;
    localStorage.setItem('mng.onboarding.v1', '1');
  }
  if (!educationalShown.has('identity')) {
    educationalShown.add('identity');
    showEducationalConcept('identity', 'A new peer joined the shared world.', 'Peer identity & discovery', 'Real libp2p peers have unique Peer IDs, and discovery helps applications find peers and their addresses.', 'This player list comes from the game server. It is an illustration, not genuine libp2p discovery, and this app does not create real Peer IDs.');
  }
}

// ---------------------------------------------------------------------------
// State application
// ---------------------------------------------------------------------------

function applySnapshot(message: SnapshotMessage): void {
  for (const node of message.nodes) {
    const previous = model.nodes.get(node.id);
    if (previous?.presence === 'online' && node.presence === 'offline') activity(`${node.name} disconnected`, 'warn');
    if (previous?.presence === 'offline' && node.presence === 'online') activity(`${node.name} reconnected`, 'good');
  }
  model.nodes = new Map(message.nodes.map((node) => [node.id, node]));
  model.links = new Map(message.links.map((link) => [link.id, link]));
  model.incoming = new Map(
    (message.incomingRequests ?? []).map((request) => [request.requestId, request]),
  );
  model.outgoing = new Map(
    (message.outgoingRequests ?? []).map((request) => [request.requestId, request]),
  );
  model.visual = new Map(message.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  model.me = message.you;
  model.phase = message.phase;
  prevPhase = message.phase;
  model.endsAt = message.phaseEndsAt;
  model.roundNo = message.roundNo;
  model.lastScore = message.lastScore;
  model.history = [...message.history];
  model.stats = message.stats;
  model.config = message.config;
  model.packetMission = message.packetMission ?? null;
  model.teams = [...message.teams];
  model.offset = message.serverNow - Date.now();
  youAt = Date.now();
  pending.clear();
  for (const request of model.outgoing.values()) {
    pending.set(request.requestId, {
      a: request.fromNodeId,
      b: request.toNodeId,
      at: Date.now(),
      requestId: request.requestId,
    });
  }
  if (selectedTargetId && !model.nodes.has(selectedTargetId)) selectedTargetId = null;
  if (selectedTargetId === model.me?.nodeId) selectedTargetId = null;
  requestSending = false;
  cameraReady = false;
  const mine = model.me?.nodeId ? model.nodes.get(model.me.nodeId) : undefined;
  if (mine) {
    lastSent = { x: mine.x, y: mine.y };
    lastMoveSentAt = Date.now();
  }
  renderRequests();
  renderTargetBar();
  renderLeaderboard();
  if (searchOpen) renderSearchResults();
}

function applyDelta(message: DeltaMessage): void {
  let panelsDirty = false;
  model.offset = message.serverNow - Date.now();
  const phaseBefore = prevPhase;
  model.phase = message.phase;
  model.endsAt = message.phaseEndsAt;
  model.roundNo = message.roundNo;
  prevPhase = message.phase;
  model.me = message.you;
  model.lastScore = message.lastScore;
  model.stats = message.stats;
  model.packetMission = message.packetMission ?? model.packetMission;
  model.teams = [...message.teams];
  youAt = Date.now();
  if (phaseBefore !== null && phaseBefore !== message.phase) onPhaseChange(message.phase);

  for (const event of message.events) {
    switch (event.type) {
      case 'node.joined':
        model.nodes.set(String(event.nodeId), {
          id: String(event.nodeId),
          x: Number(event.x),
          y: Number(event.y),
          name: String(event.name),
           status: 'active',
           restoredRoutes: 0,
           joinedAt: Number(event.at) || Date.now() + model.offset,
           presence: 'online',
        });
        model.visual.set(String(event.nodeId), { x: Number(event.x), y: Number(event.y) });
        panelsDirty = true;
        activity(`${String(event.name)} joined the shared world`);
        break;

      case 'node.moved': {
        const id = String(event.nodeId);
        const existing = model.nodes.get(id);
        if (!existing) break;
        const x = Number(event.x);
        const y = Number(event.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) break;
        model.nodes.set(id, { ...existing, x, y });
        if (id === model.me?.nodeId && isLocallyMoving()) {
          // Keep the local prediction; the next authoritative event reconciles.
          break;
        }
        break;
      }

      case 'link.created': {
        model.links.set(String(event.linkId), {
          id: String(event.linkId),
          a: String(event.a),
          b: String(event.b),
          active: true,
          starter: false,
        });
        linkPulses.set(String(event.linkId), Date.now() + 900);
        linkFx(event);
        const byNodeId = String(event.byNodeId ?? '');
        const author = byNodeId ? model.nodes.get(byNodeId) : undefined;
        if (event.restoredRoute && author) {
          model.nodes.set(byNodeId, {
            ...author,
            restoredRoutes: author.restoredRoutes + 1,
          });
        }
        panelsDirty = true;
        const aName = model.nodes.get(String(event.a))?.name ?? String(event.a);
        const bName = model.nodes.get(String(event.b))?.name ?? String(event.b);
        activity(`${aName} and ${bName} connected`, 'good');
        if (!firstConnectionSeen && (String(event.a) === model.me?.nodeId || String(event.b) === model.me?.nodeId)) {
          firstConnectionSeen = true; toast('Connection established — your link is part of the shared network.', 'good');
        }
        break;
      }

      case 'outage.applied': {
        outageFlashUntil = Date.now() + 1200;
        const strike = event.strike as { nodes?: string[]; links?: string[] } | undefined;
        outageFx(strike);
        for (const id of strike?.nodes ?? []) {
          const node = model.nodes.get(id);
          if (node) model.nodes.set(id, { ...node, status: 'disabled' });
        }
        for (const id of strike?.links ?? []) {
          const link = model.links.get(id);
          if (link) model.links.set(id, { ...link, active: false });
        }
        panelsDirty = true;
        activity(`Network outage: ${strike?.nodes?.length ?? 0} node${(strike?.nodes?.length ?? 0) === 1 ? '' : 's'} affected`, 'warn');
        toast('Outage started — build alternate routes through active peers.', 'info');
        if (!educationalShown.has('resilience')) { educationalShown.add('resilience'); showEducationalConcept('resilience', 'An outage affected the simulated network.', 'Resilience & connectivity', 'Alternate paths can preserve reachability when a peer or link becomes unavailable.', 'This is a game simulation. It does not perform libp2p recovery or routing.'); }
        break;
      }

      case 'round.recovered':
        recoveryFx();
        outageFlashUntil = Date.now() + 900;
        for (const [id, node] of model.nodes) model.nodes.set(id, { ...node, status: 'active' });
        for (const [id, link] of model.links) model.links.set(id, { ...link, active: true });
        panelsDirty = true;
        activity('Connectivity restored after the outage', 'good');
        break;

      case 'tokens.granted':
        if (model.me && String(event.nodeId) === model.me.nodeId) {
          model.me = { ...model.me, tokens: Number(event.tokens) };
        }
        break;


      case 'round.scored': {
        const result = event.result as ResultPayload | undefined;
        if (result) {
          model.lastScore = {
            roundNo: result.roundNo,
            score: result.score,
            c: result.c,
            b: result.b,
            s2: result.s2,
            strikeType: result.strike.type,
          };
          model.history = [...model.history.slice(-59), result.score];
          activity(`Round ${result.roundNo} complete · network score ${result.score}`, 'good');
          const gained = awardProgress({ kind: 'round', score: result.score });
          showResultCard(result, gained);
        }
        break;
      }
    }
  }

  renderRequests();
  renderTargetBar();
  if (panelsDirty) {
    renderLeaderboard();
    if (searchOpen) renderSearchResults();
  }
}


// ---------------------------------------------------------------------------
// Gameplay layer: effects, weak-point radar, result card, rank
// ---------------------------------------------------------------------------

interface ResultPayload {
  roundNo: number;
  score: number;
  c: ScoreView['c'];
  b: ScoreView['b'];
  s2: 0 | 1 | 2;
  strike: { type: 'A' | 'B' | 'C' };
}

let lastRestoredSfxAt = 0;

function nodePoint(id: string): { x: number; y: number } | null {
  const visual = model.visual.get(id);
  if (visual) return visual;
  const node = model.nodes.get(id);
  return node ? { x: node.x, y: node.y } : null;
}

function awardProgress(event: ProgressEvent): number {
  if (spectator || !model.me?.nodeId) return 0;
  const result = applyProgress(progress, event);
  progress = result.progress;
  saveProgress(progress);
  renderOperator();
  for (const def of result.unlocked) {
    sfx.achievement();
    toast(`Achievement unlocked: ${def.title}`, 'good');
    activity(`Achievement unlocked · ${def.title}`, 'good');
  }
  return result.gained;
}

function linkFx(event: Readonly<Record<string, unknown>>): void {
  const aId = String(event.a);
  const bId = String(event.b);
  const a = nodePoint(aId);
  const b = nodePoint(bId);
  if (!a || !b) return;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const restored = Boolean(event.restoredRoute);
  const colour = restored ? '#ffe08a' : '#82e8cc';
  const mine = aId === model.me?.nodeId || bId === model.me?.nodeId;
  fx.burst(mx, my, colour, restored ? 28 : 14, restored ? 130 : 80);
  fx.ring(a.x, a.y, colour, 34, 600, 1.5);
  fx.ring(b.x, b.y, colour, 34, 600, 1.5);
  if (restored) {
    fx.ring(mx, my, colour, 90, 950, 2.5);
    fx.float(mx, my, 'ROUTE RESTORED', colour);
    const now = Date.now();
    if (mine || now - lastRestoredSfxAt > 1500) {
      lastRestoredSfxAt = now;
      sfx.restored();
    }
  } else if (mine) {
    sfx.link();
  }
  if (mine) {
    awardProgress({ kind: 'link', restored: restored && String(event.byNodeId) === model.me?.nodeId });
  }
}

function outageFx(strike: { nodes?: string[]; links?: string[] } | undefined): void {
  let hits = 0;
  for (const id of strike?.nodes ?? []) {
    const p = nodePoint(id);
    if (!p) continue;
    hits++;
    fx.burst(p.x, p.y, '#ff667d', 36, 160, 950);
    fx.ring(p.x, p.y, '#ff667d', 96, 950, 3);
    fx.ring(p.x, p.y, '#ffc66d', 58, 700, 1.5);
    fx.float(p.x, p.y, model.nodes.get(id)?.name ?? 'DOWN', '#ffb3bf');
  }
  for (const id of strike?.links ?? []) {
    const link = model.links.get(id);
    const a = link ? nodePoint(link.a) : null;
    const b = link ? nodePoint(link.b) : null;
    if (!a || !b) continue;
    fx.burst((a.x + b.x) / 2, (a.y + b.y) / 2, '#ffc66d', 20, 110, 800);
    fx.ring((a.x + b.x) / 2, (a.y + b.y) / 2, '#ffc66d', 50, 650, 2);
  }
  fx.shake(Math.min(16, 6 + hits * 2), 650);
  sfx.strike();
  const meId = model.me?.nodeId;
  if (meId && (strike?.nodes ?? []).includes(meId)) {
    toast('Your node was knocked out until Results.', 'bad');
    awardProgress({ kind: 'hit' });
  }
}

function recoveryFx(): void {
  let any = false;
  for (const node of model.nodes.values()) {
    if (node.status !== 'disabled') continue;
    const p = nodePoint(node.id);
    if (!p) continue;
    any = true;
    fx.ring(p.x, p.y, '#82e8cc', 80, 900, 2.5);
    fx.burst(p.x, p.y, '#82e8cc', 18, 100, 800);
  }
  if (any) sfx.recover();
  recoverFlashUntil = Date.now() + 900;
}

function onPhaseChange(next: Phase): void {
  if (next === 'warning') {
    sfx.warning();
    activity('Warning: an outage is about to hit', 'warn');
    const a = analyseNetwork(model.nodes, model.links);
    if (
      a.activeCount >= 6 &&
      a.componentSize === a.activeCount &&
      a.cutVertices.size === 0 &&
      resilientRound !== model.roundNo
    ) {
      resilientRound = model.roundNo;
      if (awardProgress({ kind: 'resilient' })) {
        toast("No single point of failure: one lost node can't split this network.", 'good');
      }
    }
  }
  if (next === 'build' || next === 'warning') hideResultCard();
}

function hideResultCard(): void {
  window.clearTimeout(resultTimer);
  el.resultCard.hidden = true;
}

function showResultCard(result: ResultPayload, gained: number): void {
  const grade = gradeFor(result.score);
  const pct = (r: { num: number; den: number }): number => (r.den ? Math.round((100 * r.num) / r.den) : 0);
  const reach = pct(result.c);
  const redundancy = pct(result.b);
  const speed = result.s2 * 50;

  let coach = 'Flawless. Nothing to fix.';
  if (reach < 100) coach = 'Reach cost you: some peers ended up cut off. Bridge the split groups during Repair.';
  else if (redundancy < 100) coach = 'Redundancy cost you: single points of failure remained. Give fragile nodes a second path.';
  else if (speed < 100) coach = 'Repair faster to earn the full speed bonus.';
  const xp = gained > 0 ? ` <b>+${gained} XP</b>` : '';
  const streak = progress.streak >= 2 && !spectator ? ` · ${progress.streak}-round streak` : '';

  el.resultCard.innerHTML =
    `<div class="resultEyebrow">Round ${result.roundNo} · ${STRIKE_NAME[result.strike.type]}</div>` +
    `<div class="resultGrade g-${grade}">${grade}</div>` +
    `<div class="resultScore"><span id="resultNum">0</span><small> / 100</small></div>` +
    `<div class="resultBars">` +
    `<div class="resultBar"><span>Reach</span><i><u data-w="${reach}"></u></i><span>${reach}%</span></div>` +
    `<div class="resultBar"><span>Redundancy</span><i><u data-w="${redundancy}"></u></i><span>${redundancy}%</span></div>` +
    `<div class="resultBar"><span>Speed</span><i><u data-w="${speed}"></u></i><span>${speed}%</span></div>` +
    `</div><div class="resultFoot">${coach}${xp}${streak}</div>`;
  el.resultCard.hidden = false;

  requestAnimationFrame(() => {
    el.resultCard.querySelectorAll<HTMLElement>('u[data-w]').forEach((bar) => {
      bar.style.width = `${bar.dataset.w}%`;
    });
  });
  const num = el.resultCard.querySelector<HTMLElement>('#resultNum');
  const started = performance.now();
  const finalText = result.score % 1 ? result.score.toFixed(1) : String(result.score);
  const tick = (t: number): void => {
    if (!num) return;
    const k = Math.min(1, (t - started) / 800);
    num.textContent = k >= 1 ? finalText : String(Math.round(result.score * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  sfx.score(grade);
  if (grade === 'S' || grade === 'A') {
    const ids = [...model.nodes.values()].filter((n) => n.status === 'active').map((n) => n.id);
    for (let i = 0; i < Math.min(7, ids.length); i++) {
      const id = ids[Math.floor(Math.random() * ids.length)] as string;
      const p = nodePoint(id);
      if (p) window.setTimeout(() => {
        fx.burst(p.x, p.y, grade === 'S' ? '#ffe08a' : '#82e8cc', 22, 130, 900);
        fx.ring(p.x, p.y, grade === 'S' ? '#ffe08a' : '#82e8cc', 70, 800, 2);
      }, i * 130);
    }
  } else if (grade === 'D') {
    fx.shake(4, 300);
  }

  window.clearTimeout(resultTimer);
  resultTimer = window.setTimeout(hideResultCard, 9000);
}

function renderOperator(): void {
  if (spectator || !model.me?.nodeId) {
    el.operator.hidden = true;
    return;
  }
  const rank = rankFor(progress.xp);
  el.operator.hidden = false;
  el.opLevel.textContent = String(rank.level);
  el.opTitle.textContent = rank.title;
  el.opXp.textContent = rank.toNext === null ? `${progress.xp} XP · top rank` : `${progress.xp} XP · ${rank.toNext} to next`;
  el.opBar.style.width = `${Math.round(rank.fraction * 100)}%`;
  if (!el.achievements.hidden) renderAchievements();
}

function renderAchievements(): void {
  const done = new Set(progress.unlocked);
  el.achievements.innerHTML =
    `<div class="achHead"><b>ACHIEVEMENTS</b><span>${done.size}/${ACHIEVEMENTS.length} · saved on this device</span></div>` +
    ACHIEVEMENTS.map(
      (a) =>
        `<div class="achRow ${done.has(a.id) ? 'done' : ''}"><span class="achMark">${done.has(a.id) ? '✓' : ''}</span><div><b>${a.title}</b><small>${a.text}</small></div></div>`,
    ).join('');
}

el.operator.addEventListener('click', () => {
  el.achievements.hidden = !el.achievements.hidden;
  if (!el.achievements.hidden) renderAchievements();
});

function refreshIntegrity(): void {
  analysis = analyseNetwork(model.nodes, model.links);
  const a = analysis;
  if (a.activeCount < 2) {
    el.integrity.textContent = '—';
    el.integrity.className = '';
    el.weakChip.hidden = true;
    return;
  }
  const pct = Math.round(((2 * a.reach + a.redundancy) / 3) * 100);
  const text = `${pct}%`;
  if (el.integrity.textContent !== text) el.integrity.textContent = text;
  el.integrity.className = pct < 35 ? 'crit' : pct < 60 ? 'low' : '';
  const tip = `Reach ${Math.round(a.reach * 100)}% · Redundancy ${Math.round(a.redundancy * 100)}% · base score ${a.baseScore}/90 before the speed bonus`;
  if (el.integrity.parentElement && el.integrity.parentElement.title !== tip) el.integrity.parentElement.title = tip;

  if (spectator || a.componentSize < 3) {
    el.weakChip.hidden = true;
    return;
  }
  const meId = model.me?.nodeId ?? null;
  const weak = a.cutVertices.size;
  let cls = 'weakChip';
  let label: string;
  if (weak === 0) {
    cls += ' safe';
    label = '✓ no weak points';
  } else if (meId && a.cutVertices.has(meId)) {
    cls += ' me';
    label = "⚠ you're a weak point";
  } else {
    label = `⚠ ${weak} weak point${weak === 1 ? '' : 's'}`;
  }
  el.weakChip.hidden = false;
  if (el.weakChip.className !== cls) el.weakChip.className = cls;
  if (el.weakChip.textContent !== label) el.weakChip.textContent = label;
}

el.weakChip.addEventListener('click', () => {
  const ids = [...analysis.cutVertices];
  if (ids.length === 0) return;
  const meId = model.me?.nodeId;
  if (meId && analysis.cutVertices.has(meId)) {
    toast('If you drop, the network splits. Link to a peer on the other side to add a second path.', 'info');
    return;
  }
  weakCursor = (weakCursor + 1) % ids.length;
  const id = ids[weakCursor] as string;
  focusPlayerNode(id);
  toast(`${model.nodes.get(id)?.name ?? 'This node'} is a weak point: if it drops, the network splits.`, 'info');
});

function syncToggles(): void {
  el.toggleWeak.classList.toggle('on', radarOn);
  el.toggleWeak.setAttribute('aria-pressed', String(radarOn));
  el.toggleSound.classList.toggle('on', !sfx.isMuted);
  el.toggleSound.setAttribute('aria-pressed', String(!sfx.isMuted));
}
el.toggleWeak.addEventListener('click', () => {
  radarOn = !radarOn;
  try { localStorage.setItem('mng.radar', radarOn ? '1' : '0'); } catch { /* cosmetic */ }
  syncToggles();
});
el.toggleSound.addEventListener('click', () => {
  sfx.unlock();
  sfx.setMuted(!sfx.isMuted);
  syncToggles();
  if (!sfx.isMuted) sfx.link();
});
window.addEventListener('pointerdown', () => sfx.unlock(), { passive: true });
window.addEventListener('keydown', () => sfx.unlock(), { passive: true });
syncToggles();

// ---------------------------------------------------------------------------
// Request UI
// ---------------------------------------------------------------------------

function applyRequestResult(
  message: Extract<ServerMessage, { type: 'request_result' }>,
): void {
  const request = message.request;
  requestSending = false;
  if (requestSendTimer) {
    window.clearTimeout(requestSendTimer);
    requestSendTimer = 0;
  }
  const responseTimer = responseTimers.get(request.requestId);
  if (responseTimer !== undefined) {
    window.clearTimeout(responseTimer);
    responseTimers.delete(request.requestId);
    responsePending.delete(request.requestId);
  }
  if (message.status === 'pending') {
    model.outgoing.set(request.requestId, request);
    pending.set(request.requestId, {
      a: request.fromNodeId,
      b: request.toNodeId,
      at: Date.now(),
      requestId: request.requestId,
    });
    toast(`Request sent — awaiting response from ${request.toName}`, 'info');
    showDialingEducation(request.toName);
  } else {
    model.outgoing.delete(request.requestId);
    model.incoming.delete(request.requestId);
    pending.delete(request.requestId);
    const meId = model.me?.nodeId ?? null;
    const iAmTarget = meId !== null && request.toNodeId === meId;
    const other = iAmTarget ? request.fromName : request.toName;

    if (message.status === 'accepted') {
      toast(`Connected with ${other}`, 'good');
      if (!educationalShown.has('connections')) { educationalShown.add('connections'); showEducationalConcept('connections', `Your request was accepted by ${other}.`, 'Peer connections', 'Established peer connections can enable communication between participants.', 'This accepted edge is a simulated gameplay relationship, not a real libp2p transport connection.'); }
    } else if (message.status === 'declined') {
      toast(
        iAmTarget ? `Declined ${other}` : `${other} declined your request`,
        'bad',
      );
    } else if (message.status === 'expired') {
      toast(
        iAmTarget ? `Request from ${other} expired` : `Request to ${other} expired`,
        'info',
      );
    } else {
      const retryMs = message.retryAfterMs ?? 0;
      const seconds = Math.max(1, Math.ceil(retryMs / 1000));
      const copy = message.reason ? REJECTION_COPY[message.reason] : REJECTION_COPY.SERVER_ERROR;
      toast(copy.replace('{N}', String(seconds)), 'bad');
    }
    if (selectedTargetId === request.toNodeId) selectedTargetId = null;
  }
  renderRequests();
  renderTargetBar();
  if (searchOpen) renderSearchResults();
  renderLeaderboard();
}

function respondToRequest(request: LinkRequestView, accept: boolean): void {
  if (responsePending.has(request.requestId)) return;
  responsePending.add(request.requestId);
  const timer = window.setTimeout(() => {
    responseTimers.delete(request.requestId);
    responsePending.delete(request.requestId);
    renderRequests();
    toast('Could not confirm, try again', 'bad');
  }, 8000);
  responseTimers.set(request.requestId, timer);
  if (!send({ type: 'respond_link', requestId: request.requestId, accept })) {
    window.clearTimeout(timer);
    responseTimers.delete(request.requestId);
    responsePending.delete(request.requestId);
    renderRequests();
    toast('Reconnecting — try again when the network resumes', 'bad');
  }
}

function renderRequests(): void {
  el.requests.replaceChildren();
  const incoming = [...model.incoming.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const request of incoming) {
    const card = document.createElement('div');
    card.className = 'requestCard';
    card.dataset.requestId = request.requestId;
    const eyebrow = document.createElement('div');
    eyebrow.className = 'requestCardEyebrow';
    eyebrow.textContent = 'Connection Request';
    const text = document.createElement('p');
    const who = document.createElement('strong');
    who.textContent = request.fromName;
    text.append(who, document.createTextNode(' wants to connect with you.'));
    const id = document.createElement('div');
    id.className = 'requestId';
    id.textContent = `Request ${request.requestId}`;
    id.title = request.requestId;
    const actions = document.createElement('div');
    actions.className = 'requestActions';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'accept';
    accept.textContent = 'Accept';
    accept.addEventListener('click', () => {
      if (responsePending.has(request.requestId)) return;
      accept.disabled = true;
      decline.disabled = true;
      respondToRequest(request, true);
    });
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'decline';
    decline.textContent = 'Decline';
    decline.addEventListener('click', () => {
      if (responsePending.has(request.requestId)) return;
      accept.disabled = true;
      decline.disabled = true;
      respondToRequest(request, false);
    });
    actions.append(accept, decline);
    card.append(eyebrow, text, id, actions);
    el.requests.append(card);
  }

  el.outgoing.replaceChildren();
  for (const request of model.outgoing.values()) {
    const item = document.createElement('div');
    item.className = 'outgoingItem';
    item.dataset.requestId = request.requestId;
    item.title = `Request ${request.requestId}`;
    const label = document.createElement('span');
    label.className = 'outgoingLabel';
    label.textContent = 'Request sent — awaiting response';
    const name = document.createElement('strong');
    name.className = 'outgoingName';
    name.textContent = request.toName;
    item.append(label, name);
    el.outgoing.append(item);
  }
}

function selectedTarget(): NodeView | undefined {
  return selectedTargetId ? model.nodes.get(selectedTargetId) : undefined;
}

function hasOutgoingTo(nodeId: string): boolean {
  for (const request of model.outgoing.values()) {
    if (request.toNodeId === nodeId) return true;
  }
  return false;
}

function renderTargetBar(): void {
  const target = selectedTarget();
  if (!target || !joined || readOnly || spectator) {
    el.requestBar.hidden = true;
    return;
  }
  el.requestBar.hidden = false;
  el.requestText.textContent = `Connect to ${target.name}`;

  const entry = playerEntries().find((item) => item.nodeId === target.id);
  if (entry) {
    const links = `${entry.activeLinks} active link${entry.activeLinks === 1 ? '' : 's'}`;
    el.requestStatus.textContent = `${STATUS_LABEL[entry.status]} · ${RELATION_LABEL[entry.relation]} · ${links}`;
  } else {
    el.requestStatus.textContent = '';
  }

  const meId = model.me?.nodeId;
  const reason = meId ? rejectionFor(meId, target.id) : 'STALE_STATE';
  const alreadyPending = hasOutgoingTo(target.id);
  let label = 'Request Connection';
  let unavailable = requestSending;
  if (requestSending) {
    label = 'Sending...';
  } else if (alreadyPending) {
    label = 'Request Pending';
    unavailable = true;
  } else if (reason === 'ALREADY_LINKED') {
    label = 'Connected';
    unavailable = true;
  } else if (reason === 'NODE_OFFLINE') {
    label = 'Offline';
    unavailable = true;
  } else if (reason === 'NODE_FULL') {
    label = 'Node Full';
    unavailable = true;
  } else if (reason === 'PHASE_LOCKED') {
    label = 'Linking Locked';
    unavailable = true;
  } else if (reason === 'NO_TOKENS') {
    label = 'Out of Tokens';
    unavailable = true;
  } else if (reason !== null && reason !== 'REQUEST_PENDING') {
    label = 'Unavailable';
    unavailable = true;
  }
  el.requestSend.disabled = unavailable;
  el.requestSend.textContent = label;
}

function playerEntries(): PlayerEntry[] {
  return buildLeaderboard(
    model.nodes.values(),
    model.links.values(),
    model.incoming.values(),
    model.outgoing.values(),
    model.me?.nodeId ?? null,
  );
}

function teamMetrics(team: TeamView): { restored: number; links: number } {
  const members = new Set(team.memberNodeIds);
  let restored = 0; let links = 0;
  for (const id of members) restored += model.nodes.get(id)?.restoredRoutes ?? 0;
  for (const link of model.links.values()) {
    if (link.active && !link.starter && members.has(link.a) && members.has(link.b)) links++;
  }
  return { restored, links };
}

function renderTeamLeaderboard(): void {
  el.teamList.replaceChildren();
  const teams = [...model.teams]
    .map((team) => ({ team, metrics: teamMetrics(team) }))
    .sort((a, b) => Number(b.team.qualification !== 'ineligible') - Number(a.team.qualification !== 'ineligible') || b.team.memberNodeIds.length - a.team.memberNodeIds.length || b.team.recoveries - a.team.recoveries || b.metrics.links - a.metrics.links || a.team.teamId.localeCompare(b.team.teamId));
  el.teamGroupCount.textContent = String(teams.length);
  const myTeam = teams.find(({ team }) => team.memberNodeIds.includes(model.me?.nodeId ?? ''))?.team;
  if (!teams.length) {
    const empty = document.createElement('div'); empty.className = 'teamEmpty'; empty.textContent = 'Connect two active players to form a team.'; el.teamList.append(empty);
  }
  teams.forEach(({ team, metrics }, index) => {
    const row = document.createElement('div'); row.className = 'teamRow'; row.tabIndex = 0; row.setAttribute('role', 'button');
    if (team.teamId === myTeam?.teamId) row.classList.add('is-me');
    const rank = document.createElement('span'); rank.className = 'teamRank'; rank.textContent = String(index + 1);
    const body = document.createElement('span'); body.className = 'teamRowBody';
    const name = document.createElement('span'); name.className = 'teamRowName'; name.textContent = `${team.name ?? 'Unnamed team'}${team.leaderNodeId === model.me?.nodeId ? '  ♛' : ''}`;
    const isLeader = team.leaderNodeId === model.me?.nodeId;
    const meta = document.createElement('span'); meta.className = 'teamRowMeta'; meta.textContent = `${team.memberNodeIds.length} members · ${metrics.links} active links · ${team.leaderNodeId ? `leader ${model.nodes.get(team.leaderNodeId)?.name ?? team.leaderNodeId} · ` : ''}${isLeader ? 'RENAME TEAM · ' : ''}${team.qualification === 'entered' ? 'Surprise Zone' : team.qualification === 'qualified' ? 'Qualified' : 'Not qualified'}`;
    const count = document.createElement('span'); count.className = 'teamRowCount'; count.textContent = `${metrics.restored} repairs`; count.title = 'Repair-phase links that merged disconnected components';
    body.append(name, meta); row.append(rank, body, count);
    row.addEventListener('click', () => {
      if (isLeader) {
        promptedTeamId = team.teamId;
        el.teamNameDialog.querySelector('.eyebrow')!.textContent = 'Mesh leadership';
        (document.getElementById('teamNameTitle') as HTMLElement).textContent = team.name === null ? 'Create your team' : 'Rename your team';
        el.teamNameInput.value = team.name ?? '';
        el.teamDescriptionInput.value = team.description ?? '';
        el.teamNameSave.textContent = team.name === null ? 'Create team' : 'Update team name';
        el.teamNameDialog.hidden = false;
        el.teamNameInput.focus();
        return;
      }
      const first = team.memberNodeIds[0]; if (first) focusPlayerNode(first);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        row.click();
      }
    });
    el.teamList.append(row);
  });
  renderSmokeRoom(myTeam);
  if (myTeam && myTeam.name === null && myTeam.leaderNodeId === model.me?.nodeId && promptedTeamId !== myTeam.teamId && model.phase !== 'warning' && model.phase !== 'result' && model.incoming.size === 0) {
    promptedTeamId = myTeam.teamId;
    el.teamNameDialog.hidden = false;
    el.teamNameInput.value = '';
    el.teamDescriptionInput.value = '';
    el.teamNameDialog.querySelector('.eyebrow')!.textContent = 'Mesh leadership assigned';
    (document.getElementById('teamNameTitle') as HTMLElement).textContent = 'Create your team';
    el.teamNameSave.textContent = 'Create team';
    window.setTimeout(() => el.teamNameInput.focus(), 0);
  }

  function renderSmokeRoom(team: TeamView | undefined): void {
    const member = Boolean(team?.memberNodeIds.includes(model.me?.nodeId ?? ''));
    const connected = model.me?.networkStatus === 'connected';
    el.openSmokeRoom.disabled = !(member && connected);
    el.inviteSmokeMembers.disabled = !(member && connected);
    el.viewSmokeMembers.disabled = !Boolean(team);
    if (!team) {
      el.smokeRoomStatus.textContent = 'NO ACTIVE TEAM';
      el.smokeRoomDetails.textContent = model.me?.offline
        ? 'Your game node is under repair, but network access is still being monitored. Connect two players to create a private room.'
        : 'Connect two active players to create a team and unlock your private communication room.';
      return;
    }
    const name = team.name ?? 'Unnamed team';
    const state = !member ? 'MEMBERSHIP REQUIRED' : !connected ? 'NODE DISCONNECTED' : 'ROOM AVAILABLE';
    el.smokeRoomStatus.textContent = state;
    el.smokeRoomDetails.textContent = `Team: ${name} · Members: ${team.memberNodeIds.length} · Leader: ${model.nodes.get(team.leaderNodeId ?? '')?.name ?? 'unassigned'} · Room: ${team.roomId}`;
    el.openSmokeRoom.onclick = () => openSmokeRoom(team);
    el.inviteSmokeMembers.onclick = () => inviteSmokeMembers(team);
    el.viewSmokeMembers.onclick = () => toast(team.memberNodeIds.map((id) => model.nodes.get(id)?.name ?? id).join(', '), 'info');
  }

  async function inviteSmokeMembers(team: TeamView): Promise<void> {
    if (!send({ type: 'smoke_invite', teamId: team.teamId })) {
      toast('Reconnect before inviting team members', 'bad');
      return;
    }
    toast('Smoke Room invite sent to connected team members', 'good');
  }

  function showSmokeInvite(message: Extract<ServerMessage, { type: 'smoke_invite' }>): void {
    const popup = document.getElementById('smokeInvitePopup');
    if (!popup) return;
    popup.replaceChildren();
    const body = document.createElement('div');
    body.innerHTML = `<strong>SMOKE ROOM INVITE</strong><p>${message.fromName} invited you to ${message.teamName}.</p>`;
    const actions = document.createElement('div');
    actions.className = 'smokeInviteActions';
    const join = document.createElement('button');
    join.type = 'button';
    join.textContent = 'OPEN SMOKE ROOM';
    join.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('smoke-invite-open', { detail: message }));
      popup.hidden = true;
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Later';
    dismiss.addEventListener('click', () => { popup.hidden = true; });
    actions.append(join, dismiss);
    popup.append(body, actions);
    popup.hidden = false;
  }

  window.addEventListener('smoke-invite', (event) => {
    showSmokeInvite((event as CustomEvent<Extract<ServerMessage, { type: 'smoke_invite' }>>).detail);
  });
  window.addEventListener('smoke-invite-open', (event) => {
    const message = (event as CustomEvent<Extract<ServerMessage, { type: 'smoke_invite' }>>).detail;
    const team = model.teams.find((entry) => entry.teamId === message.teamId);
    if (team) openSmokeRoom(team);
  });

  function openSmokeRoom(team: TeamView): void {
    const sessionToken = readToken();
    if (!sessionToken || !model.me?.nodeId) {
      toast('Reconnect before opening the Smoke Room.', 'bad');
      return;
    }
    el.openSmokeRoom.disabled = true;
    fetch('/api/integration/rooms/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ roomId: team.roomId }),
    }).then(async (response) => {
      const result = await response.json() as { accessToken?: string; error?: string };
      if (!response.ok || !result.accessToken) throw new Error(result.error ?? 'Smoke Room authorization failed');
      const smokeBase = import.meta.env.VITE_SMOKE_BASE_URL ?? 'http://localhost:10001';
      window.open(`${smokeBase}/?roomId=${encodeURIComponent(team.roomId)}&token=${encodeURIComponent(result.accessToken)}`, '_blank', 'noopener');
    }).catch((error: unknown) => toast(error instanceof Error ? error.message : 'Smoke Room authorization failed', 'bad'))
      .finally(() => renderSmokeRoom(team));
  }
}

function renderLeaderboard(): void {
  el.leaderboard.classList.toggle('collapsed', leaderboardCollapsed);
  el.lbToggle.setAttribute('aria-expanded', String(!leaderboardCollapsed));
  el.lbBody.hidden = leaderboardCollapsed;
  renderTeamLeaderboard();

  const entries = playerEntries();
  el.lbCount.textContent = `${entries.length} player${entries.length === 1 ? '' : 's'}`;
  el.lbList.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'lbEmpty';
    empty.textContent = 'No players in this Line yet.';
    el.lbList.append(empty);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'lbRow';
    row.dataset.nodeId = entry.nodeId;
    if (entry.isMe) row.classList.add('is-me');
    if (entry.presence === 'offline') row.classList.add('is-offline');
    row.setAttribute(
      'aria-label',
      `Rank ${entry.rank}, ${entry.name}${entry.isMe ? ', you' : ''}, ${entry.restoredRoutes} restored routes, ${entry.activeLinks} active links`,
    );

    const rank = document.createElement('span');
    rank.className = `lbRank rank-${entry.rank <= 3 ? entry.rank : 'standard'}`;
    rank.textContent = String(entry.rank);
    rank.title =
      entry.rank === 1
        ? 'First place'
        : entry.rank === 2
          ? 'Second place'
          : entry.rank === 3
            ? 'Third place'
            : `Rank ${entry.rank}`;

    const name = document.createElement('span');
    name.className = 'lbName';
    name.textContent = entry.name;
    if (entry.isMe) {
      const you = document.createElement('small');
      you.textContent = 'you';
      name.append(you);
    }

    const restored = document.createElement('span');
    restored.className = 'lbMetric';
      restored.textContent = String(entry.restoredRoutes);
      restored.title = 'Repair-phase links that merged disconnected components';

    const links = document.createElement('span');
    links.className = 'lbMetric';
    links.textContent = String(entry.activeLinks);
    links.title = 'Active accepted links';

    row.append(rank, name, restored, links);
    row.addEventListener('click', () => {
      focusPlayerNode(entry.nodeId);
    });
    item.append(row);
    el.lbList.append(item);
  }
}

function searchMessage(text: string): void {
  searchMatches = [];
  searchActiveIndex = -1;
  const message = document.createElement('div');
  message.className = 'searchMessage';
  message.textContent = text;
  el.searchResults.append(message);
  el.searchInput.removeAttribute('aria-activedescendant');
}

function renderSearchResults(): void {
  if (!searchOpen) {
    el.searchResults.hidden = true;
    el.searchInput.setAttribute('aria-expanded', 'false');
    return;
  }

  el.searchResults.hidden = false;
  el.searchInput.setAttribute('aria-expanded', 'true');
  el.searchResults.replaceChildren();
  const query = el.searchInput.value.trim();
  el.searchClear.hidden = query.length === 0;

  if (!joined || model.nodes.size === 0) {
    searchMessage('Loading players…');
    return;
  }
  if (!query) {
    searchMessage('Type a name or node ID.');
    return;
  }

  searchMatches = searchPlayers(playerEntries(), query);
  if (searchMatches.length === 0) {
    searchMessage(`No players match “${query}”.`);
    return;
  }

  if (searchActiveIndex >= searchMatches.length) searchActiveIndex = searchMatches.length - 1;
  searchMatches.forEach((entry, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.id = `searchOption${index}`;
    option.className = 'searchResult';
    option.setAttribute('role', 'option');
    option.dataset.nodeId = entry.nodeId;
    if (entry.presence === 'offline') option.classList.add('is-offline');

    const rank = document.createElement('span');
    rank.className = 'searchRank';
    rank.textContent = `#${entry.rank}`;

    const body = document.createElement('span');
    body.className = 'searchBody';
    const name = document.createElement('span');
    name.className = 'searchName';
    name.textContent = entry.name;
    if (entry.isMe) {
      const you = document.createElement('small');
      you.textContent = 'you';
      name.append(you);
    }
    const meta = document.createElement('span');
    meta.className = 'searchMeta';
    meta.textContent = `${STATUS_LABEL[entry.status]} · ${RELATION_LABEL[entry.relation]} · ${entry.activeLinks} link${entry.activeLinks === 1 ? '' : 's'}`;
    body.append(name, meta);

    option.append(rank, body);
    option.addEventListener('pointerenter', () => setSearchActive(index));
    option.addEventListener('click', () => {
      focusPlayerNode(entry.nodeId);
    });
    el.searchResults.append(option);
  });
  updateSearchActive();
}

function updateSearchActive(): void {
  const options = [...el.searchResults.querySelectorAll<HTMLElement>('.searchResult')];
  options.forEach((option, index) => {
    const active = index === searchActiveIndex;
    option.classList.toggle('active', active);
    option.setAttribute('aria-selected', String(active));
  });
  const activeOption = options[searchActiveIndex];
  if (searchActiveIndex >= 0 && activeOption) {
    el.searchInput.setAttribute('aria-activedescendant', activeOption.id);
    activeOption.scrollIntoView({ block: 'nearest' });
  } else {
    el.searchInput.removeAttribute('aria-activedescendant');
  }
}

function setSearchActive(index: number): void {
  if (searchMatches.length === 0) {
    searchActiveIndex = -1;
  } else if (index < 0) {
    searchActiveIndex = searchMatches.length - 1;
  } else if (index >= searchMatches.length) {
    searchActiveIndex = 0;
  } else {
    searchActiveIndex = index;
  }
  updateSearchActive();
}

function openSearch(): void {
  searchOpen = true;
  el.searchResults.hidden = false;
  el.searchInput.setAttribute('aria-expanded', 'true');
  renderSearchResults();
}

function closeSearch(): void {
  searchOpen = false;
  searchActiveIndex = -1;
  searchMatches = [];
  el.searchResults.hidden = true;
  el.searchInput.setAttribute('aria-expanded', 'false');
  el.searchInput.removeAttribute('aria-activedescendant');
}

function focusPlayerNode(nodeId: string): void {
  const node = model.nodes.get(nodeId);
  if (!node) return;
  closeSearch();
  const now = Date.now();
  highlightId = nodeId;
  highlightUntil = now + 3400;
  focusNodeId = nodeId;
  focusUntil = now + 3400;
  focusScale = Math.min(2.8, Math.max(1.25, camera.scale * 1.15));
  canvas.dataset.focusNode = nodeId;

  if (nodeId === model.me?.nodeId) {
    selectedTargetId = null;
    renderTargetBar();
    return;
  }
  selectedTargetId = nodeId;
  renderTargetBar();
}

el.lbToggle.addEventListener('click', () => {
  closeSearch();
  leaderboardCollapsed = !leaderboardCollapsed;
  try {
    localStorage.setItem(LEADERBOARD_KEY, leaderboardCollapsed ? '1' : '0');
  } catch {
    // ignore storage restrictions
  }
  renderLeaderboard();
});

el.searchInput.addEventListener('focus', () => {
  openSearch();
});
el.searchInput.addEventListener('input', () => {
  searchActiveIndex = -1;
  openSearch();
});
el.searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSearch();
    el.searchInput.blur();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!searchOpen) openSearch();
    setSearchActive(
      event.key === 'ArrowDown'
        ? searchActiveIndex + 1
        : searchActiveIndex - 1,
    );
    return;
  }
  if (event.key === 'Enter' && searchOpen && searchMatches.length > 0) {
    event.preventDefault();
    const index = searchActiveIndex >= 0 ? searchActiveIndex : 0;
    const entry = searchMatches[index];
    if (entry) focusPlayerNode(entry.nodeId);
  }
});
el.searchClear.addEventListener('click', () => {
  el.searchInput.value = '';
  searchActiveIndex = -1;
  openSearch();
  el.searchInput.focus();
});
document.addEventListener('pointerdown', (event) => {
  if (!el.searchPanel.contains(event.target as Node)) closeSearch();
});
document.addEventListener('focusin', (event) => {
  if (!el.searchPanel.contains(event.target as Node)) closeSearch();
});

function cancelSelection(): void {
  selectedTargetId = null;
  renderTargetBar();
}

function requestConnection(targetId: string): void {
  if (readOnly) return toast('Read-only until reconnected', 'bad');
  const meId = model.me?.nodeId;
  if (!meId) return showJoin();
  if (requestSending) return;
  if (hasOutgoingTo(targetId)) return toast(REJECTION_COPY.REQUEST_PENDING, 'info');

  const reason = rejectionFor(meId, targetId);
  if (reason) return toast(rejectionCopy(reason), 'bad');

  requestSending = true;
  renderTargetBar();
  if (requestSendTimer) window.clearTimeout(requestSendTimer);
  requestSendTimer = window.setTimeout(() => {
    requestSending = false;
    requestSendTimer = 0;
    renderTargetBar();
    toast('Could not confirm, try again', 'bad');
  }, 8000);
  sfx.unlock();
  if (!send({ type: 'request_link', targetNodeId: targetId })) {
    window.clearTimeout(requestSendTimer);
    requestSendTimer = 0;
    requestSending = false;
    renderTargetBar();
    toast('Reconnecting — try again when the network resumes', 'bad');
    return;
  }
  renderTargetBar();
}

el.requestSend.addEventListener('click', () => {
  if (selectedTargetId) requestConnection(selectedTargetId);
});
el.requestCancel.addEventListener('click', cancelSelection);
el.learnLibp2p.addEventListener('click', () => { el.learnPanel.hidden = false; el.learnClose.focus(); });
el.learnClose.addEventListener('click', () => { el.learnPanel.hidden = true; });
el.learnPanel.addEventListener('click', (event) => { if (event.target === el.learnPanel) el.learnPanel.hidden = true; });
el.teamNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    el.teamNameSave.click();
  }
});

el.teamNameSave.addEventListener('click', () => {
  const team = model.teams.find((entry) => entry.teamId === promptedTeamId)
    ?? model.teams.find((entry) => entry.memberNodeIds.includes(model.me?.nodeId ?? ''))
    ?? model.teams[0];
  const name = el.teamNameInput.value.trim();
  if (!team || !name) { toast('Choose a team name', 'bad'); return; }
  if (name.length < 3 || name.length > 24) { toast('Team names must be 3-24 characters', 'bad'); return; }
  const description = el.teamDescriptionInput.value.trim();
  if (description.length > 160) { toast('Team descriptions must be 160 characters or fewer', 'bad'); return; }
  if (!send({ type: 'team_name', teamId: team.teamId, name, description })) { toast('Reconnecting — try again when the network resumes', 'bad'); return; }
  el.teamNameDialog.hidden = true;
});
el.teamNameLater.addEventListener('click', () => { el.teamNameDialog.hidden = true; });
el.teamNameDialog.addEventListener('click', (event) => { if (event.target === el.teamNameDialog) el.teamNameDialog.hidden = true; });

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function degreeOf(id: string): number {
  let total = 0;
  for (const link of model.links.values()) {
    if (link.a === id || link.b === id) total += 1;
  }
  return total;
}

function hasLink(a: string, b: string): boolean {
  for (const link of model.links.values()) {
    if ((link.a === a && link.b === b) || (link.a === b && link.b === a)) return true;
  }
  return false;
}

/** Client-side copy of the server validation, only used to explain before sending. */
function rejectionFor(a: string, b: string): ReasonCode | null {
  if (!model.nodes.has(a) || !model.nodes.has(b)) return 'STALE_STATE';
  if (a === b) return 'SELF_LINK';
  if (hasLink(a, b)) return 'ALREADY_LINKED';
  if (model.phase === 'result') return 'PHASE_LOCKED';
  if (model.nodes.get(a)?.status === 'disabled' || model.nodes.get(b)?.status === 'disabled') {
    return 'NODE_OFFLINE';
  }
  const cap = model.config?.degreeCap ?? 5;
  if (degreeOf(a) >= cap || degreeOf(b) >= cap) return 'NODE_FULL';
  if ((model.me?.tokens ?? 0) <= 0) return 'NO_TOKENS';
  if (hasOutgoingTo(b)) return 'REQUEST_PENDING';
  return null;
}

function rejectionCopy(reason: ReasonCode): string {
  const copy = REJECTION_COPY[reason] ?? REJECTION_COPY.SERVER_ERROR;
  const seconds =
    reason === 'PHASE_LOCKED' ? Math.ceil(remainingMs() / 1000) : Math.ceil(tokenRemainingMs() / 1000);
  return copy.replace('{N}', String(seconds));
}

/**
 * Tap behaviour: tapping another node selects it and reveals the explicit
 * "Request Connection" action. It never creates an edge.
 */
function handleTap(node: NodeView): void {
  showPlayerCard(node.id, true);
  if (!model.me?.nodeId) return showJoin();

  if (node.id === model.me.nodeId) {
    if (selectedTargetId) {
      toast('Selection cleared', 'info');
      cancelSelection();
    } else {
      toast('That is your own node — pick another player', 'info');
    }
    return;
  }

  selectedTargetId = node.id;
  pulseUntil = Date.now() + 900;
  renderTargetBar();
}

function showEducationalConcept(key: string, what: string, concept: string, realWorld: string, inGame: string): void {
  window.clearTimeout(libp2pPopupTimer);
  const repeat = educationalShown.has(`popup:${key}`);
  educationalShown.add(`popup:${key}`);
  const safeWhat = escapeHtml(what); const safeConcept = escapeHtml(concept);
  el.libp2pPopup.innerHTML = repeat
    ? `<div class="libp2pPopupIcon">◈</div><div class="libp2pPopupBody"><div class="libp2pPopupTitle">Behind the Network</div><strong>${safeConcept}</strong><p>${safeWhat}</p><div class="libp2pPopupActions"><button class="popupLearn" type="button">Learn more</button><button class="popupDismiss" type="button">Got it</button></div></div>`
    : `<div class="libp2pPopupIcon">◈</div><div class="libp2pPopupBody"><div class="libp2pPopupTitle">Behind the Network</div><strong>WHAT JUST HAPPENED</strong><p>${safeWhat}</p><p class="conceptLabel">LIBP2P CONCEPT: ${safeConcept}</p><p><b>HOW IT WORKS IN REAL LIBP2P</b><br>${escapeHtml(realWorld)}</p><p class="why"><b>IN THIS GAME</b><br>${escapeHtml(inGame)}</p><div class="libp2pPopupActions"><button class="popupLearn" type="button">Learn more</button><button class="popupDismiss" type="button">Got it</button></div></div>`;
  el.libp2pPopup.hidden = false;
  el.libp2pPopup.querySelector('.popupDismiss')?.addEventListener('click', hideDialingEducation);
  el.libp2pPopup.querySelector('.popupLearn')?.addEventListener('click', () => { hideDialingEducation(); el.learnPanel.hidden = false; el.learnClose.focus(); });
  libp2pPopupTimer = window.setTimeout(hideDialingEducation, repeat ? 4500 : 9000);
}

function showDialingEducation(targetName: string): void {
  window.clearTimeout(libp2pPopupTimer);
  let detailed = false;
  try { detailed = localStorage.getItem('mng.libp2p.dialing.v1') !== '1'; localStorage.setItem('mng.libp2p.dialing.v1', '1'); } catch { detailed = true; }
  const safeTarget = escapeHtml(targetName);
  el.libp2pPopup.innerHTML = detailed
    ? `<div class="libp2pPopupIcon">↗</div><div class="libp2pPopupBody"><div class="libp2pPopupTitle">Behind the Network</div><strong>You're reaching out to another peer!</strong><p>You're asking <b>${safeTarget}</b> to establish a connection in the game network. They must accept before the game creates the link.</p><p class="conceptLabel">libp2p concept: Dialing</p><p>In a real JavaScript libp2p application, <code>libp2p.dial(peerId)</code> attempts an outgoing peer connection. This game's request-and-accept workflow is application-level logic; the graph is simulated.</p><p class="why">Peers need connectivity before they can exchange data directly over that connection.</p><div class="libp2pPopupActions"><button class="popupLearn" type="button">Learn more</button><button class="popupDismiss" type="button">Dismiss</button></div></div>`
    : `<div class="libp2pPopupIcon">↗</div><div class="libp2pPopupBody"><div class="libp2pPopupTitle">Behind the Network</div><strong>Request sent to ${safeTarget}</strong><p>Application-level dialing illustrated · acceptance is still required.</p><div class="libp2pPopupActions"><button class="popupLearn" type="button">Learn more</button><button class="popupDismiss" type="button">Dismiss</button></div></div>`;
  el.libp2pPopup.hidden = false;
  el.libp2pPopup.querySelector('.popupDismiss')?.addEventListener('click', hideDialingEducation);
  el.libp2pPopup.querySelector('.popupLearn')?.addEventListener('click', () => { hideDialingEducation(); el.learnPanel.hidden = false; el.learnClose.focus(); });
  libp2pPopupTimer = window.setTimeout(hideDialingEducation, detailed ? 10000 : 4500);
}
function hideDialingEducation(): void { window.clearTimeout(libp2pPopupTimer); el.libp2pPopup.hidden = true; }

function relativeJoinTime(joinedAt?: number): string {
  if (!joinedAt) return 'Join time unavailable';
  const seconds = Math.max(0, Math.floor(((Date.now() + model.offset) - joinedAt) / 1000));
  if (seconds < 10) return 'Joined just now';
  if (seconds < 60) return `Joined ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Joined ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  return `Joined ${hours} hour${hours === 1 ? '' : 's'} ago`;
}

function playerRelationship(id: string): string {
  if (id === model.me?.nodeId) return 'Your node · local player';
  if (hasLink(id, model.me?.nodeId ?? '')) return 'Connected · accepted game link';
  if ([...model.incoming.values(), ...model.outgoing.values()].some((r) => r.fromNodeId === id || r.toNodeId === id)) return 'Request pending · not an active link';
  return 'Isolated · no accepted game links';
}

function showPlayerCard(id: string, persistent = false): void {
  const node = model.nodes.get(id);
  if (!node) return;
  hoveredNodeId = id;
  window.clearTimeout(cardHideTimer);
  const activeLinks = degreeOf(id);
  const pending = [...model.incoming.values(), ...model.outgoing.values()].some((r) => r.fromNodeId === id || r.toNodeId === id);
  const canRequest = id !== model.me?.nodeId && !rejectionFor(model.me?.nodeId ?? '', id);
  el.playerCard.innerHTML = `<div class="playerCardHead"><span class="presenceDot ${node.presence ?? 'unknown'}"></span><div><strong>${escapeHtml(node.name)}</strong><small>${node.id}</small></div><button class="cardDismiss" type="button" aria-label="Close player information">×</button></div><div class="playerFacts"><span><b>${node.presence === 'online' ? 'Online' : node.presence === 'offline' ? 'Offline' : 'Presence unknown'}</b><small>presence</small></span><span><b>${relativeJoinTime(node.joinedAt)}</b><small>joined this Line</small></span><span><b>${activeLinks} active link${activeLinks === 1 ? '' : 's'}</b><small>game network</small></span></div><p class="playerState">${playerRelationship(id)}${pending ? ' · consent is still required' : ''}</p>${node.status === 'disabled' ? '<p class="playerNotice">Affected by the current outage; this node recovers at results.</p>' : ''}${canRequest ? '<button class="cardConnect" type="button">Request connection</button>' : ''}${id !== model.me?.nodeId && node.status === 'active' ? '<button class="cardSimulate" type="button">Simulate failure</button>' : ''}`;
  el.playerCard.hidden = false;
  el.playerCard.dataset.persistent = persistent ? 'true' : 'false';
  const point = toScreenPoint(id);
  el.playerCard.style.left = `${Math.max(12, Math.min(window.innerWidth - 292, point.x + 18))}px`;
  el.playerCard.style.top = `${Math.max(78, Math.min(window.innerHeight - 210, point.y - 36))}px`;
  el.playerCard.querySelector('.cardDismiss')?.addEventListener('click', hidePlayerCard);
  el.playerCard.querySelector('.cardConnect')?.addEventListener('click', () => { selectedTargetId = id; requestConnection(id); hidePlayerCard(); });
  el.playerCard.querySelector('.cardSimulate')?.addEventListener('click', () => simulateFailure(id));
}

function simulateFailure(removedId: string): void {
  const remaining = [...model.nodes.values()].filter((node) => node.id !== removedId && node.status === 'active');
  const adjacency = new Map<string, string[]>();
  for (const node of remaining) adjacency.set(node.id, []);
  for (const link of model.links.values()) {
    if (!link.active || link.a === removedId || link.b === removedId || !adjacency.has(link.a) || !adjacency.has(link.b)) continue;
    adjacency.get(link.a)!.push(link.b); adjacency.get(link.b)!.push(link.a);
  }
  const components = new Map<string, number>(); let groups = 0;
  for (const node of remaining) {
    if (components.has(node.id)) continue;
    const queue = [node.id]; components.set(node.id, groups);
    while (queue.length) for (const next of adjacency.get(queue.shift()!) ?? []) if (!components.has(next)) { components.set(next, groups); queue.push(next); }
    groups++;
  }
  const mine = model.me?.nodeId;
  const mineGroup = mine && mine !== removedId ? components.get(mine) : undefined;
  const unreachable = mineGroup === undefined ? remaining.length : remaining.filter((node) => components.get(node.id) !== mineGroup).length;
  failurePreview = { removedId, components, groups, unreachable };
  const result = groups <= 1 ? 'The network stays connected.' : `The network splits into ${groups} groups.`;
  const detail = unreachable ? `${unreachable} peer${unreachable === 1 ? '' : 's'} become unreachable from your node.` : 'No other peers become unreachable from your node.';
  el.failurePreview.innerHTML = `<div><b>FAILURE SIMULATION</b><strong>What if ${escapeHtml(model.nodes.get(removedId)?.name ?? removedId)} disappears?</strong><span>${result}</span><small>${detail}</small></div><button type="button">Restore view</button>`;
  el.failurePreview.hidden = false;
  el.failurePreview.querySelector('button')?.addEventListener('click', restoreFailurePreview);
  hidePlayerCard();
}
function restoreFailurePreview(): void { failurePreview = null; el.failurePreview.hidden = true; }

function toScreenPoint(id: string): { x: number; y: number } {
  const node = model.nodes.get(id)!;
  const point = model.visual.get(id) ?? node;
  return { x: point.x * camera.scale + camera.ox, y: point.y * camera.scale + camera.oy };
}
function hidePlayerCard(): void { hoveredNodeId = null; el.playerCard.hidden = true; }
function scheduleCardHide(): void { if (el.playerCard.dataset.persistent === 'true') return; cardHideTimer = window.setTimeout(hidePlayerCard, 180); }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char] ?? char)); }

function clampLocal(x: number, y: number): { x: number; y: number } {
  const radius = model.config?.movement.worldRadius ?? 1400;
  const distance = Math.hypot(x, y);
  if (!Number.isFinite(distance) || distance <= radius) return { x, y };
  return { x: (x / distance) * radius, y: (y / distance) * radius };
}

function localMoveActive(): boolean {
  if (drag?.moved) return true;
  for (const key of heldKeys) {
    if (key.startsWith('Arrow') || ['w', 'a', 's', 'd'].includes(key)) return true;
  }
  return false;
}

function isLocallyMoving(): boolean {
  return localMoveActive();
}

function sendPosition(force = false): void {
  const id = model.me?.nodeId;
  if (!id || readOnly) return;
  const node = model.nodes.get(id);
  if (!node) return;
  const now = Date.now();
  if (!force) {
    if (now - lastMoveSentAt < MOVE_SEND_MS) return;
    if (Math.hypot(node.x - lastSent.x, node.y - lastSent.y) < 0.75) return;
  }
  lastMoveSentAt = now;
  lastSent = { x: node.x, y: node.y };
  send({ type: 'move', x: node.x, y: node.y });
}

function moveOwnNode(x: number, y: number): void {
  const id = model.me?.nodeId;
  if (!id) return;
  const node = model.nodes.get(id);
  if (!node || node.status !== 'active') return;
  const point = clampLocal(x, y);
  if (Math.hypot(node.x - point.x, node.y - point.y) < 0.01) return;
  model.nodes.set(id, { ...node, x: point.x, y: point.y });
  model.visual.set(id, { x: point.x, y: point.y });
}

function updateKeyboardMovement(dtMs: number): void {
  if (!joined || readOnly || spectator || drag?.moved) return;
  if (!model.me?.nodeId) return;
  const left = heldKeys.has('ArrowLeft') || heldKeys.has('a');
  const right = heldKeys.has('ArrowRight') || heldKeys.has('d');
  const up = heldKeys.has('ArrowUp') || heldKeys.has('w');
  const down = heldKeys.has('ArrowDown') || heldKeys.has('s');
  const dx = Number(right) - Number(left);
  const dy = Number(down) - Number(up);
  if (dx === 0 && dy === 0) return;
  const id = model.me.nodeId;
  const node = model.nodes.get(id);
  if (!node) return;
  const length = Math.hypot(dx, dy) || 1;
  const step = (KEY_SPEED * dtMs) / 1000;
  moveOwnNode(node.x + (dx / length) * step, node.y + (dy / length) * step);
  sendPosition(false);
}

canvas.addEventListener('pointerdown', (event) => {
  if (spectator) return;
  const rect = canvas.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  const node = pickNode(model.nodes.values(), camera, sx, sy, 26, model.visual);
  if (!node) return;

  if (!model.me?.nodeId) return showJoin();

  // Dragging your own node moves it; a press without movement is still a tap.
  if (node.id === model.me.nodeId) {
    if (node.status !== 'active') {
      toast(model.me.networkStatus === 'connected' ? 'Your node is under repair; network membership is preserved.' : 'Your node is disconnected.', 'bad');
      return;
    }
    drag = {
      pointerId: event.pointerId,
      startSX: sx,
      startSY: sy,
      camera: { ...camera },
      moved: false,
    };
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    return;
  }

  handleTap(node);
});

canvas.addEventListener('pointermove', (event) => {
  const rect = canvas.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  if (!drag) {
    const node = pickNode(model.nodes.values(), camera, sx, sy, 26, model.visual);
    if (node) showPlayerCard(node.id);
    else scheduleCardHide();
    return;
  }
  if (event.pointerId !== drag.pointerId) return;
  const dx = sx - drag.startSX;
  const dy = sy - drag.startSY;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  drag.moved = true;
  const world = toWorld(drag.camera, sx, sy);
  moveOwnNode(world.x, world.y);
  sendPosition(false);
  event.preventDefault();
});

function endDrag(event: PointerEvent, cancelled = false): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const wasDrag = drag.moved;
  drag = null;
  if (canvas.hasPointerCapture?.(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
  if (wasDrag) {
    sendPosition(true);
    return;
  }
  if (cancelled) return;
  const id = model.me?.nodeId;
  const node = id ? model.nodes.get(id) : undefined;
  if (node) handleTap(node);
}

canvas.addEventListener('pointerup', (event) => endDrag(event));
canvas.addEventListener('pointercancel', (event) => endDrag(event, true));

const MOVE_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'w',
  'a',
  's',
  'd',
]);

function keyName(event: KeyboardEvent): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
  if (!joined || readOnly || spectator || !model.me?.nodeId) return;
  const key = keyName(event);
  if (!MOVE_KEYS.has(key)) return;
  event.preventDefault();
  heldKeys.add(key);
});

function stopKey(event: KeyboardEvent): void {
  const key = keyName(event);
  if (!heldKeys.delete(key)) return;
  if (!localMoveActive()) sendPosition(true);
}
window.addEventListener('keyup', stopKey);
window.addEventListener('blur', () => {
  if (heldKeys.size === 0) return;
  heldKeys.clear();
  sendPosition(true);
});


el.play.addEventListener('click', () => {
  clearNameWarning();
  el.play.disabled = true;
  const name = el.name.value.trim();
  connect();
  const sendJoin = (): void => { send({ type: 'join', name }); };
  if (socket && socket.readyState === WebSocket.OPEN) sendJoin();
  else {
    // connect() is now opening; join as soon as it is ready.
    const wait = window.setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        window.clearInterval(wait);
        sendJoin();
      }
    }, 120);
    window.setTimeout(() => window.clearInterval(wait), 8000);
  }
});

el.name.addEventListener('input', () => { clearNameWarning(); });

el.name.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el.play.click();
});

el.findMe.addEventListener('click', () => {
  const meId = model.me?.nodeId;
  if (!meId) return;
  pulseUntil = Date.now() + 2500;
  focusPlayerNode(meId);
  toast('Your node is ringed in white', 'info');
});

function startNetworkPulse(): void {
  const source = model.me?.nodeId;
  if (!source || networkPulse) return;
  if (model.nodes.get(source)?.status !== 'active') { toast('Your node is offline until results.', 'bad'); return; }
  const reachable = new Set<string>([source]);
  const segments: PulseSegment[] = [];
  const queue = [source];
  const visited = new Set<string>([source]);
  let depth = 0;
  while (queue.length) {
    const current = queue.shift()!;
    for (const link of model.links.values()) {
      if (!link.active) continue;
      const next = link.a === current ? link.b : link.b === current ? link.a : null;
      if (!next || visited.has(next) || model.nodes.get(next)?.status !== 'active') continue;
      visited.add(next); reachable.add(next); queue.push(next);
      segments.push({ a: current, b: next, at: depth * 260 });
      depth += 1;
    }
  }
  const unreachable = new Set([...model.nodes.keys()].filter((id) => !reachable.has(id)));
  const startedAt = Date.now();
  networkPulse = { startedAt, segments, reachable, unreachable, doneAt: startedAt + Math.max(900, segments.length * 260 + 650) };
  el.pingNetwork.disabled = true;
  el.pulseResult.hidden = true;
  window.clearTimeout(pulseResultTimer);
}
function updateNetworkPulse(): void {
  if (!networkPulse) return;
  const now = Date.now();
  if (now < networkPulse.doneAt) return;
  const reached = Math.max(0, networkPulse.reachable.size - 1);
  const unreachable = networkPulse.unreachable.size;
  el.pulseResult.innerHTML = `<strong>Signal reached ${reached} peer${reached === 1 ? '' : 's'}</strong>${unreachable ? `<span>${unreachable} peer${unreachable === 1 ? '' : 's'} unreachable</span>` : '<span>All active peers are reachable</span>'}<button type="button" aria-label="Dismiss network pulse result">×</button>`;
  el.pulseResult.hidden = false;
  el.pulseResult.querySelector('button')?.addEventListener('click', () => { el.pulseResult.hidden = true; });
  pulseResultTimer = window.setTimeout(() => { el.pulseResult.hidden = true; }, 5000);
  el.pingNetwork.disabled = false;
  networkPulse = null;
}
el.pingNetwork.addEventListener('click', startNetworkPulse);

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const PHASE_LABEL: Record<Phase, string> = {
  seeding: 'growing',
  build: 'build',
  warning: 'warning',
  repair: 'repair',
  result: 'results',
};

function setBanner(text: string | null, kind: 'info' | 'error' = 'info'): void {
  if (!text) {
    el.banner.hidden = true;
    return;
  }
  el.banner.hidden = false;
  el.banner.textContent = text;
  el.banner.className = kind;
}

let toastTimer = 0;
function toast(text: string, kind: 'info' | 'bad' | 'good' = 'info'): void {
  const node = document.createElement('div');
  node.className = `toast ${kind === 'info' ? '' : kind}`;
  node.textContent = text;
  el.toasts.append(node);
  window.setTimeout(() => node.remove(), 2800);
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toasts.replaceChildren();
  }, 4000);
}

function showJoin(): void {
  el.join.hidden = false;
  el.name.focus();
}

function remainingMs(): number {
  return Math.max(0, model.endsAt - (Date.now() + model.offset));
}

function tokenRemainingMs(): number {
  if (!model.me) return 0;
  if (model.me.tokens >= 3) return 0;
  return Math.max(0, model.me.nextTokenInMs - (Date.now() - youAt));
}

function updateHud(): void {
  document.body.dataset.phase = model.phase;
  document.body.classList.toggle('warnPulse', model.phase === 'warning');
  document.body.classList.toggle('recoverFlash', Date.now() < recoverFlashUntil);
  refreshIntegrity();
  el.phase.textContent = PHASE_LABEL[model.phase] ?? model.phase;
  el.countdown.textContent = `${(remainingMs() / 1000).toFixed(1)}s`;
  el.score.textContent = model.lastScore ? model.lastScore.score.toFixed(1) : '—';
  const recent = model.history.slice(-10);
  const health = recent.length
    ? (recent.reduce((sum, value) => sum + value, 0) / recent.length).toFixed(1)
    : '—';
  el.health.textContent = health;
  el.worldCount.textContent = `${model.nodes.size} NODE${model.nodes.size === 1 ? '' : 'S'}`;
  const healthValue = Number(health);
  const track = document.querySelector<HTMLElement>('.healthTrack i');
  if (track) track.style.width = Number.isFinite(healthValue) ? `${Math.max(0, Math.min(100, healthValue))}%` : '0%';

  const tokens = model.me?.tokens ?? 0;
  el.tokenPips.forEach((pip, i) => pip.classList.toggle('on', i < tokens));
  el.tokenTimer.textContent =
    model.me && model.me.tokens < 3 ? `${Math.ceil(tokenRemainingMs() / 1000)}s` : '';
  if (hoveredNodeId && !el.playerCard.hidden) showPlayerCard(hoveredNodeId, el.playerCard.dataset.persistent === 'true');
  renderPacketMission();

  if (Date.now() < welcomeUntil) {
    el.hint.textContent = 'Find a peer and request a connection to start building the network.';
  } else if (readOnly) {
    el.hint.textContent = 'Read-only until reconnected';
  } else if (!model.me?.nodeId) {
    el.hint.textContent = 'Join to start connecting';
  } else if (model.phase === 'result') {
    el.hint.textContent = `Results in ${Math.ceil(remainingMs() / 1000)}s`;
  } else if (model.me.offline && model.me.networkStatus === 'connected') {
    el.hint.textContent = 'Your node is under repair; network membership is preserved';
  } else if (model.me.offline) {
    el.hint.textContent = 'Your node is disconnected';
  } else if (tokens === 0) {
    el.hint.textContent = `Out of tokens - next in ${Math.ceil(tokenRemainingMs() / 1000)}s`;
  } else if (selectedTargetId) {
    el.hint.textContent = `Ready to request ${model.nodes.get(selectedTargetId)?.name ?? 'this node'}`;
  } else {
    el.hint.textContent = 'Drag to move - tap another node to request a connection';
  }
}

function renderPacketMission(): void {
  const mission = model.packetMission;
  if (!mission) { el.packetMission.hidden = true; el.packetDot.hidden = true; packetCardKey = ''; return; }
  const source = model.nodes.get(mission.sourceNodeId);
  const destination = model.nodes.get(mission.destinationNodeId);
  if (!source || !destination) return;
  const status = mission.status === 'blocked' ? 'No route available' : mission.status === 'in_transit' ? 'Packet in transit' : mission.status === 'delivered' ? 'Packet delivered!' : 'Route interrupted';
  el.packetMission.hidden = false;
  const key = `${mission.id}:${mission.status}:${mission.sourceNodeId}:${mission.destinationNodeId}`;
  if (key !== packetCardKey) {
    packetCardKey = key;
    el.packetMission.innerHTML = `<div class="packetEyebrow">SIMULATED PACKET RUN <span class="packetCountdown"></span></div><div class="packetRoute"><b>${escapeHtml(source.name)}</b><i>→</i><b>${escapeHtml(destination.name)}</b></div><div class="packetStatus ${mission.status}"><span></span>${status}</div>`;
  }
  const countdown = el.packetMission.querySelector<HTMLElement>('.packetCountdown');
  if (countdown) countdown.textContent = `${Math.max(0, Math.ceil((mission.endsAt - (Date.now() + model.offset)) / 1000))}s`;
  if ((mission.status === 'delivered' || mission.status === 'failed') && packetAnnouncementKey !== key) {
    packetAnnouncementKey = key;
    toast(mission.status === 'delivered' ? 'Packet delivered!' : 'Packet run failed — the route was interrupted.', mission.status === 'delivered' ? 'good' : 'bad');
    if (mission.status === 'delivered' && !educationalShown.has('routing')) {
      educationalShown.add('routing');
      showEducationalConcept('routing', 'The simulated packet followed active accepted edges to its destination.', 'Routing, streams & protocols', 'Real applications can exchange data over streams using agreed protocols and routes.', 'Packet Run is only a visualization. It is not real libp2p traffic and no stream or protocol is used.');
    }
  }
  if (mission.status !== 'in_transit' || mission.route.length < 2) { el.packetDot.hidden = true; return; }
  const positions = mission.route.map((id) => model.visual.get(id) ?? model.nodes.get(id)).filter(Boolean) as Array<{x:number;y:number}>;
  const lengths = positions.slice(1).map((point, i) => Math.hypot(point.x - positions[i]!.x, point.y - positions[i]!.y));
  const total = lengths.reduce((a,b) => a+b, 0); let distance = Math.min(total, ((Date.now() + model.offset) - mission.startedAt) / 2200 * total);
  let segment = 0; while (segment < lengths.length - 1 && distance > lengths[segment]!) distance -= lengths[segment++]!;
  const a = positions[segment]!, b = positions[Math.min(segment + 1, positions.length - 1)]!; const ratio = lengths[segment] ? distance / lengths[segment]! : 1;
  const point = { x: a.x + (b.x-a.x)*ratio, y: a.y + (b.y-a.y)*ratio };
  el.packetDot.hidden = false; el.packetDot.style.left = `${point.x * camera.scale + camera.ox - 6}px`; el.packetDot.style.top = `${point.y * camera.scale + camera.oy - 6}px`;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let dpr = 1;
function resize(): void {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
}
window.addEventListener('resize', resize);
resize();

function smoothPositions(dtMs: number): void {
  const meId = model.me?.nodeId ?? null;
  const local = isLocallyMoving();
  const k = 1 - Math.exp(-dtMs / 70);
  for (const [id, node] of model.nodes) {
    let visual = model.visual.get(id);
    if (!visual) {
      visual = { x: node.x, y: node.y };
      model.visual.set(id, visual);
    }
    if (id === meId && local) {
      visual.x = node.x;
      visual.y = node.y;
      continue;
    }
    visual.x += (node.x - visual.x) * k;
    visual.y += (node.y - visual.y) * k;
    if (Math.abs(node.x - visual.x) < 0.05 && Math.abs(node.y - visual.y) < 0.05) {
      visual.x = node.x;
      visual.y = node.y;
    }
  }
}

function frame(timestamp: number): void {
  const dt = lastFrameAt ? Math.min(50, Math.max(1, timestamp - lastFrameAt)) : 16;
  lastFrameAt = timestamp;

  updateKeyboardMovement(dt);
  smoothPositions(dt);
  fx.update(dt);
  const now = Date.now();
  for (const [id, expiresAt] of linkPulses) if (expiresAt <= now) linkPulses.delete(id);
  document.body.classList.toggle('outageFlash', now < outageFlashUntil);
  updateNetworkPulse();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderPacketMission();

  // Freeze the camera while dragging so the world does not move under the
  // finger. Otherwise ease toward a fit of every current display position.
  if (!drag) {
    const focused = focusNodeId ? model.visual.get(focusNodeId) : undefined;
    let target: Camera;
    if (focused && Date.now() < focusUntil) {
      // Search/leaderboard selection briefly centres the discovered node. Once
      // the hold expires the board eases back to the normal whole-Line fit.
      target = {
        scale: focusScale,
        ox: window.innerWidth / 2 - focused.x * focusScale,
        oy: window.innerHeight / 2 - focused.y * focusScale,
      };
    } else {
      if (focusNodeId) {
        focusNodeId = null;
        delete canvas.dataset.focusNode;
      }
      target = fitCamera(
        model.nodes.values(),
        window.innerWidth,
        window.innerHeight,
        model.visual,
      );
    }
    if (!cameraReady) {
      camera = target;
      cameraReady = true;
    } else {
      const k = 1 - Math.exp(-dt / 140);
      camera.scale += (target.scale - camera.scale) * k;
      camera.ox += (target.ox - camera.ox) * k;
      camera.oy += (target.oy - camera.oy) * k;
      if (Math.abs(target.scale - camera.scale) < 0.0005) camera = target;
    }
  }

  // Dim structurally unavailable targets. Already-linked and pending nodes
  // stay vivid: they are connected or awaiting consent, not offline or full.
  let invalidIds: Set<string> | null = null;
  const meId = model.me?.nodeId ?? null;
  if (meId && !readOnly && joined) {
    invalidIds = new Set<string>();
    for (const id of model.nodes.keys()) {
      if (id === meId) continue;
      const reason = rejectionFor(meId, id);
      if (reason === 'NODE_OFFLINE' || reason === 'NODE_FULL') invalidIds.add(id);
    }
  }

  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  const shake = fx.offset(now);
  ctx.save();
  ctx.translate(shake.x, shake.y);
  drawBoard({
    ctx,
    backdrop: (c) => fx.drawBackdrop(c, window.innerWidth, window.innerHeight),
    weakIds: radarOn && model.phase !== 'result' ? analysis.cutVertices : undefined,
    hubIds: radarOn && model.phase === 'warning' ? analysis.hubIds : undefined,
    flow: true,
    nodes: model.nodes,
    links: model.links,
    positions: model.visual,
    meId,
    targetId: selectedTargetId,
    invalidIds,
    pending: [...pending.values()],
    camera,
    width: window.innerWidth,
    height: window.innerHeight,
    now: Date.now(),
    dimmed: readOnly || !joined,
    pulseUntil,
    pulseLinks: linkPulses,
    pulseSegments: networkPulse?.segments,
    pulseStartedAt: networkPulse?.startedAt,
    pulseUnreachable: networkPulse?.unreachable,
    failurePreviewId: failurePreview?.removedId,
    failurePreviewComponents: failurePreview?.components,
    highlightId,
    highlightUntil,
    worldRadius: model.config?.movement.worldRadius ?? 1400,
  });
  fx.drawOverlay(ctx, camera);
  ctx.restore();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.setInterval(updateHud, 100);
window.setInterval(() => {
  const ghost = readOnly || (Date.now() - lastSeen > 30_000 && joined);
  if (ghost && !readOnly) {
    readOnly = true;
    setBanner('Connection lost — read-only until reconnected', 'error');
  }
}, 1000);

window.setInterval(() => send({ type: 'ping', t: Date.now() }), 3000);

window.addEventListener('beforeunload', () => socket?.close());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (spectator) {
  setBanner(null);
  connect();
} else if (token) {
  setBanner('Reconnecting…', 'info');
  connect();
  el.join.hidden = true;
} else {
  showJoin();
  connect(); // opens the socket, join happens on the button
}
