// Audit the inline routing and logical travel functions at a fixed 1/60 s.
// Run: node qa/motion-audit.cjs [path-to-index.html]
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const input = process.argv[2] || path.join(__dirname, '../site/index.html');
const src = fs.readFileSync(input, 'utf8');
const section = (a, b) => {
  const start = src.indexOf(a), end = src.indexOf(b, start);
  if (start < 0 || end < 0) throw new Error(`Missing source markers: ${a} / ${b}`);
  return src.slice(start, end);
};
class Vec3 {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, {x, y, z}); }
  clone() { return new Vec3(this.x, this.y, this.z); }
  copy(v) { Object.assign(this, {x:v.x, y:v.y, z:v.z}); return this; }
}
const code = [
  section('    const ANCHORS = {', '    /* Sleeping ON the bed:'),
  section('    const BLOCK = [', '    dannyRoot.position.copy(ANCHORS.desk.pos)'),
  'const D = { travel: null, yawTgt: null, at: null };',
  'const walkAnchor = new THREE.Vector3();',
  'const dannyRoot = {position: new THREE.Vector3(), rotation: {y:0}};',
  "const CLIPMAP = {walk:'Walking'}, dAct = {Walking:{timeScale:1}};",
  'function dPlay() {}',
  section('    function yawLerp(', '    function cancelTimers()'),
  section('    function travelUpdate(dt)', '    const _hv = new THREE.Vector3();'),
  `globalThis.audit = { ANCHORS, BLOCK, pathPts, segBlocked, inBlock, D, walkAnchor, dannyRoot, travelUpdate };`
].join('\n');
const context = {THREE:{Vector3:Vec3}, Math};
vm.createContext(context);
vm.runInContext(code, context);
const {ANCHORS, BLOCK, pathPts, segBlocked, inBlock, D, walkAnchor, dannyRoot, travelUpdate} = context.audit;
const names = ['desk', 'bed', 'guitar', 'board', 'papers', 'window'];
const routes = [];
for (const a of names) for (const b of names) {
  if (a === b) continue;
  const start = ANCHORS[a], end = ANCHORS[b], pts = pathPts(start.pos, end.pos);
  let prev = start.pos;
  const badLegs = [];
  pts.forEach((p, i) => { if (segBlocked(prev, p)) badLegs.push(i); prev = p; });
  dannyRoot.position.copy(start.pos); dannyRoot.rotation.y = start.yaw;
  walkAnchor.copy(start.pos);
  if (!pts) { routes.push({from:a, to:b, noRoute:true}); continue; }
  D.travel = {pts, i:0, pos:start.pos.clone(), yawT:end.yaw, keyName:b, done:null, phase:'turn', speed:0};
  let maxStep = 0, maxYawRate = 0, blockedSteps = 0, frames = 0, firstStep = null;
  while (D.travel && frames < 3600) {
    const p = dannyRoot.position.clone(), yaw = dannyRoot.rotation.y;
    travelUpdate(1 / 60); frames++;
    const step = Math.hypot(dannyRoot.position.x - p.x, dannyRoot.position.z - p.z);
    let dy = (dannyRoot.rotation.y - yaw + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    maxStep = Math.max(maxStep, step); maxYawRate = Math.max(maxYawRate, Math.abs(dy) * 60 * 180 / Math.PI);
    if (firstStep === null) firstStep = step;
    if (inBlock(dannyRoot.position, 0.22)) blockedSteps++;
  }
  routes.push({from:a, to:b, points:pts.map(p => [p.x,p.z]), badLegs, blockedSteps, frames,
    firstStep:+firstStep.toFixed(5), maxStep:+maxStep.toFixed(5), maxYawDegPerSec:+maxYawRate.toFixed(2), completed:!D.travel});
}
let seed = 2811;
function random() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
const randomPoints = [];
while (randomPoints.length < 80) {
  const p = new Vec3(-3.28 + random() * 6.56, 0, -2.38 + random() * 4.76);
  if (!inBlock(p, 0.22)) randomPoints.push(p);
}
let randomNoRoute = 0, randomUnsafe = 0;
for (let i = 0; i < randomPoints.length; i++) {
  const from = randomPoints[i], to = randomPoints[(i * 37 + 9) % randomPoints.length];
  const pts = pathPts(from, to);
  if (!pts) { randomNoRoute++; continue; }
  let p = from;
  for (const q of pts) { if (segBlocked(p, q)) randomUnsafe++; p = q; }
}
const catPoints = [[0.95,-0.50],[1.75,-1.55],[-2.50,-1.15],[-2.05,-0.05],[-2.05,1.25]].map(p => new Vec3(p[0],0,p[1]));
let catNoRoute = 0, catUnsafe = 0;
for (const from of catPoints) for (const to of catPoints) {
  if (from === to) continue;
  const pts = pathPts(from, to, 0.05);
  if (!pts) { catNoRoute++; continue; }
  let p = from; for (const q of pts) { if (segBlocked(p, q, 0.05)) catUnsafe++; p = q; }
}
const summary = {source:input, dt:1/60, routeCount:routes.length,
  unsafeRoutes:routes.filter(r => r.badLegs && r.badLegs.length).length,
  routesWithBlockedSteps:routes.filter(r => r.blockedSteps).length,
  noRoute:routes.filter(r => r.noRoute || !r.completed).length,
  randomNoRoute, randomUnsafe, catNoRoute, catUnsafe,
  worstYaw:routes.reduce((a,b)=>(a.maxYawDegPerSec || 0)>(b.maxYawDegPerSec || 0)?a:b),
  maxStep:Math.max(...routes.map(r => r.maxStep || 0)), routes};
console.log(JSON.stringify(summary, null, 2));
// Some random points are isolated by furniture or the wall; rejecting those
// routes is the intended safe result. All named anchors must be reachable.
if (summary.unsafeRoutes || summary.routesWithBlockedSteps || summary.noRoute || randomUnsafe || catNoRoute || catUnsafe || summary.worstYaw.maxYawDegPerSec > 180 || summary.maxStep > 0.03) process.exitCode = 1;
