// sokoban-solver-01: a push-optimal Sokoban solver.
//
// The contest scores pushes, not moves: an instance pays in full only at its push optimum P*, and a single
// push over P* already halves it. So this program searches over pushes, not steps. A state is the sorted
// box squares plus the player's reachable region, named by its lowest square; walking between pushes is
// free and is filled in afterwards by a breadth-first walk for each push.
//
// Two ideas do the work:
//
// 1. Rooms. The drawn levels are a hallway with small rooms off it, and a box can never leave its room:
//    the only way out is a door onto the hallway, and a box in the hallway can be pushed along it but never
//    back through a door (the square the player would have to stand on is wall), so it reaches no goal.
//    Cutting the dead squares of the player's own row (the hallway) out of the floor therefore splits a
//    level into its rooms, each room is an independent problem, and the rooms' push optima add up to the
//    level's. A level that does not split cleanly is searched whole instead.
//
// 2. Matching heuristic. For one goal, a reverse breadth search over the push graph gives the exact number
//    of pushes a lone box needs from every square. The heuristic of a position is the cheapest matching of
//    boxes to goals under those distances (Hungarian algorithm): every push moves one box one square, so
//    it can lower the matching by at most one, which makes the matching a lower bound on the pushes still
//    needed and A* over pushes settles on a push-optimal solution. Boxes on dead squares (no goal reachable
//    at all) and frozen 2x2 blocks with a box off its goal are pruned on sight.
//
// Everything is budgeted by work, never by the clock: each search has an expansion cap, a plain
// breadth-first push search stands behind A* as a second engine, and the program reads no clock, no
// randomness and nothing outside /input and /output, so two executions write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four directions: [dx, dy, the walk's letter, the push's letter]. */
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];
/** A cost no real matching can reach: marks a box that cannot reach a goal. */
const BIG = 1_000_000;
/** Expansion caps, by work alone: generous heads above what these small rooms ever need. */
const ROOM_ASTAR_CAP = 500_000;
const ROOM_BFS_CAP = 1_000_000;
const LEVEL_ASTAR_CAP = 1_500_000;
const LEVEL_BFS_CAP = 1_500_000;

/** A level in XSB text: width, height, walls, goals, sorted boxes and the player's square. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever the text shows: nothing leaves the board.
  for (let x = 0; x < w; x++) {
    wall[x] = 1;
    wall[(h - 1) * w + x] = 1;
  }
  for (let y = 0; y < h; y++) {
    wall[y * w] = 1;
    wall[y * w + w - 1] = 1;
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, size: w * h, wall, goals, boxes, player };
}

/**
 * The push distance from every square to `goal`: how many pushes a lone box on that square needs to reach
 * the goal, walls alone in the way (-1 when it can never get there). A reverse breadth search over the push
 * graph: a box on y is pushed by direction k onto x = y + k, with the player standing on y - k.
 */
function pushDistances(board, goal) {
  const { w, wall, size } = board;
  const dist = new Int32Array(size).fill(-1);
  dist[goal] = 0;
  const queue = [goal];
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const y = x - d;
      if (dist[y] >= 0 || wall[y] || wall[y - d]) continue;
      dist[y] = dist[x] + 1;
      queue.push(y);
    }
  }
  return dist;
}

/** The squares from which some goal is reachable at all (the complement is the dead squares). */
function liveSquares(dists, size) {
  const live = new Uint8Array(size);
  for (const dist of dists) {
    for (let i = 0; i < size; i++) if (dist[i] >= 0) live[i] = 1;
  }
  return live;
}

/** The cheapest assignment of rows to columns (Hungarian algorithm); costs are small integers or BIG. */
function hungarian(a) {
  const n = a.length;
  const m = a[0].length;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Infinity);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  let total = 0;
  for (let j = 1; j <= m; j++) if (p[j] > 0) total += a[p[j] - 1][j - 1];
  return total;
}

/** The matching lower bound on the pushes still needed; BIG when some box reaches no goal. */
function heuristic(boxes, dists) {
  const n = boxes.length;
  if (n === 0 || n !== dists.length) return 0;
  const a = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(n);
    for (let j = 0; j < n; j++) {
      const d = dists[j][boxes[i]];
      row[j] = d < 0 ? BIG : d;
    }
    a[i] = row;
  }
  const total = hungarian(a);
  return total >= BIG ? BIG : total;
}

/**
 * Marks the squares the player reaches from `from` around walls and the boxes in `occ` into `seen` under
 * `stamp`, and returns the region's lowest square, its canonical name.
 */
function flood(board, occ, from, seen, stamp) {
  const { w, wall } = board;
  let low = from;
  const stack = [from];
  seen[from] = stamp;
  while (stack.length > 0) {
    const p = stack.pop();
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (!wall[q] && !occ[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack.push(q);
      }
    }
  }
  return low;
}

/** Whether the box just pushed onto `t` froze a 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(board, occ, goalSet, t) {
  const { w, wall, size } = board;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0 || a % w === w - 1) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (d >= size) continue;
    const solid = (i) => wall[i] === 1 || occ[i] === 1;
    if (!solid(a) || !solid(b) || !solid(c) || !solid(d)) continue;
    if ((occ[a] && !goalSet[a]) || (occ[b] && !goalSet[b]) || (occ[c] && !goalSet[c]) || (occ[d] && !goalSet[d])) return true;
  }
  return false;
}

/**
 * A push-optimal solution of one (sub)problem: the list of pushes {from, dir} that puts every box on a
 * goal, or null when the expansion cap runs out first. A* (astar = true) orders the frontier by pushes
 * made plus the matching bound; breadth-first search (astar = false) by pushes made alone. Both are
 * push-optimal when they answer; the caller picks the caps.
 */
function searchPushes(board, startBoxes, startPlayer, goalSet, dists, cap, astar) {
  const { w, wall, size } = board;
  const live = liveSquares(dists, size);
  const solved = (boxes) => boxes.every((b) => goalSet[b] === 1);
  if (startBoxes.some((b) => !live[b])) return null;
  if (solved(startBoxes)) return [];

  const occ = new Uint8Array(size);
  const regionSeen = new Int32Array(size);
  const repSeen = new Int32Array(size);
  let regionStamp = 0;
  let repStamp = 0;
  const keyOf = (boxes, rep) => String.fromCharCode(rep, ...boxes);
  const regionRep = (boxes, player, seenArr, stampRef) => {
    occ.fill(0);
    for (const b of boxes) occ[b] = 1;
    return flood(board, occ, player, seenArr, stampRef);
  };

  // The states, in the order found: boxes, the player's square, pushes made, parent, and the push made.
  const nBoxes = [startBoxes];
  const nPlayer = [startPlayer];
  const nG = [0];
  const nParent = [-1];
  const nFrom = [-1];
  const nDir = [-1];
  const nKey = [''];
  const rootRep = regionRep(startBoxes, startPlayer, repSeen, ++repStamp);
  nKey[0] = keyOf(startBoxes, rootRep);
  if (heuristic(startBoxes, dists) >= BIG) return null;
  const best = new Map([[nKey[0], 0]]);

  // The frontier: a binary heap on (f, deeper first, insertion order) for A*, a plain queue for BFS.
  const heap = [];
  const queue = [0];
  let head = 0;
  let counter = 0;
  const less = (x, y) => x[0] < y[0] || (x[0] === y[0] && (x[1] > y[1] || (x[1] === y[1] && x[2] < y[2])));
  const heapPush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };
  if (astar) heapPush([heuristic(startBoxes, dists), 0, counter++, 0]);

  let expansions = 0;
  for (;;) {
    let idx;
    if (astar) {
      if (heap.length === 0) return null;
      idx = heapPop()[3];
      if (nG[idx] !== best.get(nKey[idx])) continue; // a stale heap entry
    } else {
      if (head >= queue.length) return null;
      idx = queue[head++];
    }
    const boxes = nBoxes[idx];
    if (solved(boxes)) {
      const pushes = [];
      for (let s = idx; s > 0; s = nParent[s]) pushes.push({ from: nFrom[s], dir: nDir[s] });
      pushes.reverse();
      return pushes;
    }
    if (++expansions > cap) return null;

    occ.fill(0);
    for (const b of boxes) occ[b] = 1;
    const stamp = ++regionStamp;
    flood(board, occ, nPlayer[idx], regionSeen, stamp);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const stand = b - d;
        const tgt = b + d;
        if (regionSeen[stand] !== stamp || wall[tgt] || occ[tgt] || !live[tgt]) continue;
        const nb = boxes.slice();
        nb[bi] = tgt;
        nb.sort((x, y) => x - y);
        occ[b] = 0;
        occ[tgt] = 1;
        const frozen = frozenBlock(board, occ, goalSet, tgt);
        let rep = -1;
        if (!frozen) rep = flood(board, occ, b, repSeen, ++repStamp);
        occ[tgt] = 0;
        occ[b] = 1;
        if (frozen) continue;
        const h = heuristic(nb, dists);
        if (h >= BIG) continue;
        const key = keyOf(nb, rep);
        const g2 = nG[idx] + 1;
        const seenG = best.get(key);
        if (seenG !== undefined && seenG <= g2) continue;
        best.set(key, g2);
        const t = nBoxes.length;
        nBoxes.push(nb);
        nPlayer.push(b);
        nG.push(g2);
        nParent.push(idx);
        nFrom.push(b);
        nDir.push(k);
        nKey.push(key);
        if (astar) heapPush([g2 + h, g2, counter++, t]);
        else queue.push(t);
      }
    }
  }
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkString(board, occ, from, to) {
  const { w, wall } = board;
  if (from === to) return '';
  const prev = new Int32Array(board.size).fill(-1);
  const how = new Array(board.size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k][2];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkString: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** Plays a push list on the real board: the move string, and where the player and the boxes end. */
function applyPushes(board, allBoxes, player, pushes) {
  const { w } = board;
  let boxes = allBoxes.slice();
  let p = player;
  let moves = '';
  const occ = new Uint8Array(board.size);
  for (const { from, dir } of pushes) {
    const d = DIRS[dir][1] * w + DIRS[dir][0];
    occ.fill(0);
    for (const b of boxes) occ[b] = 1;
    moves += walkString(board, occ, p, from - d);
    moves += DIRS[dir][3];
    boxes = boxes.map((b) => (b === from ? from + d : b)).sort((x, y) => x - y);
    p = from;
  }
  return { moves, player: p, boxes };
}

/**
 * The level's rooms: cut the dead squares of the player's row out of the floor; each part left that holds
 * boxes is a room, with its squares, boxes and goals. Null when the level is no clean set of rooms (a box
 * or a goal on a cut square, a part whose boxes and goals differ in number).
 */
function decompose(level) {
  const { w, wall, goals, boxes, player, size } = level;
  const dists = goals.map((g) => pushDistances(level, g));
  const live = liveSquares(dists, size);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b] === 1)) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i] + DIRS[k][1] * w + DIRS[k][0];
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  const withBoxes = rooms.filter((r) => r.boxes.length > 0);
  if (withBoxes.some((r) => r.boxes.length !== r.goals.length)) return null;
  if (withBoxes.reduce((a, r) => a + r.boxes.length, 0) !== boxes.length) return null;
  return withBoxes;
}

/** Solves one room as its own problem on the board where the other rooms' boxes stand as walls. */
function solveRoom(level, room, inRoom, curBoxes, curPlayer) {
  const { w, wall, size } = level;
  const subWall = wall.slice();
  for (const b of curBoxes) if (!inRoom.has(b)) subWall[b] = 1;
  const board = { w, h: level.h, size, wall: subWall };
  const goalSet = new Uint8Array(size);
  for (const g of room.goals) goalSet[g] = 1;
  const startBoxes = curBoxes.filter((b) => inRoom.has(b)).sort((a, b) => a - b);
  const dists = room.goals.map((g) => pushDistances(board, g));
  const pushes =
    searchPushes(board, startBoxes, curPlayer, goalSet, dists, ROOM_ASTAR_CAP, true) ??
    searchPushes(board, startBoxes, curPlayer, goalSet, dists, ROOM_BFS_CAP, false);
  if (pushes === null) return null;
  return applyPushes(level, curBoxes, curPlayer, pushes);
}

/** The moves that solve one level text, or '' when no search answers it. */
function solveLevel(text) {
  const level = parseLevel(text);
  const { goals, boxes, player, size } = level;
  if (boxes.length === 0) return '';
  if (player < 0) return '';
  const board = { w: level.w, h: level.h, size, wall: level.wall };

  const rooms = decompose(level);
  if (rooms !== null && rooms.length > 0) {
    let curBoxes = boxes.slice();
    let curPlayer = player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const inRoom = new Set(room.squares);
      const startBoxes = curBoxes.filter((b) => inRoom.has(b));
      if (startBoxes.length !== room.boxes.length) {
        ok = false;
        break;
      }
      if (startBoxes.every((b) => room.goals.includes(b))) continue; // already solved
      const done = solveRoom(level, room, inRoom, curBoxes, curPlayer);
      if (done === null) {
        ok = false;
        break;
      }
      moves += done.moves;
      curPlayer = done.player;
      curBoxes = done.boxes;
    }
    if (ok) return moves;
  }

  // The whole level at once: the fallback for a level that is no clean set of rooms.
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const dists = goals.map((g) => pushDistances(board, g));
  const pushes =
    searchPushes(board, boxes, player, goalSet, dists, LEVEL_ASTAR_CAP, true) ??
    searchPushes(board, boxes, player, goalSet, dists, LEVEL_BFS_CAP, false);
  if (pushes === null) return '';
  return applyPushes(board, boxes, player, pushes).moves;
}

for (const id of readdirSync(I).sort()) {
  const dir = join(I, id);
  let moves = '';
  try {
    if (lstatSync(dir).isDirectory()) moves = solveLevel(readFileSync(join(dir, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
