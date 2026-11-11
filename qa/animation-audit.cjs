// Exercise the actual inline clip preparation against the checked-in GLBs.
// Run: node qa/animation-audit.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('Missing preparation code');
  return source.slice(a, b);
}
function animations(file) {
  const data = fs.readFileSync(path.join(root, 'site/assets', file));
  const jsonLength = data.readUInt32LE(12);
  const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf8'));
  const bin = 20 + jsonLength + 8;
  function accessor(id) {
    const a = json.accessors[id], view = json.bufferViews[a.bufferView];
    if (a.componentType !== 5126) throw new Error('Expected float track');
    const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
    const start = bin + (view.byteOffset || 0) + (a.byteOffset || 0);
    const stride = view.byteStride || n * 4, values = new Float32Array(a.count * n);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) values[i * n + k] = data.readFloatLE(start + i * stride + k * 4);
    return values;
  }
  return json.animations.map(clip => ({ name: clip.name, tracks: clip.channels.filter(c => c.target.path === 'translation' || c.target.path === 'rotation').map(c => {
    const sampler = clip.samplers[c.sampler], node = json.nodes[c.target.node];
    return {name: node.name.replace(/[^a-zA-Z0-9_]/g, '') + (c.target.path === 'rotation' ? '.quaternion' : '.position'), times: accessor(sampler.input), values: accessor(sampler.output)};
  }) }));
}
const dannyG = {animations: animations('danny-hero-high.glb')};
const neoG = {animations: animations('neo-hero.glb')};
const track = (g, clip, suffix) => g.animations.find(c => c.name === clip).tracks.find(t => t.name.endsWith(suffix));
const walk = track(dannyG, 'Walking', 'Hips.position');
const first = Array.from(walk.values.slice(0, 3)), last = Array.from(walk.values.slice(-3));
const before = Math.hypot(...last.map((v, i) => v - first[i]));
const cat = track(neoG, 'Walk', 'root.position');
const span = t => { const a = []; for (let i = 1; i < t.values.length; i += 3) a.push(t.values[i]); return Math.max(...a) - Math.min(...a); };
const catBefore = span(cat);
const hind = track(neoG, 'Walk', 'shinHL.quaternion');
function lastRotationJump(t) {
  const v = t.values, n = v.length, dot = Math.abs(v[n-8]*v[n-4] + v[n-7]*v[n-3] + v[n-6]*v[n-2] + v[n-5]*v[n-1]);
  return 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
}
const catJumpBefore = lastRotationJump(hind);
vm.runInNewContext(section('    function hipsTrack(name)', '    const dMixer ='), {dannyG, Math});
vm.runInNewContext(section("      const trot = neoG.animations.find", '      neoRoot = new THREE.Group()'), {neoG, Math});
const walkEnd = Array.from(walk.values.slice(-3));
const after = Math.hypot(...walkEnd.map((v, i) => v - walk.values[i]));
const stand = track(dannyG, 'StandUp', 'Hips.position');
const typing = track(dannyG, 'Typing', 'Hips.position');
const sit = track(dannyG, 'SitDown', 'Hips.position');
const seatMismatch = Math.abs(stand.values[2] - typing.values[2]);
let sitDrift = 0; for (let i = 1; i < sit.values.length; i += 3) sitDrift = Math.max(sitDrift, Math.abs(sit.values[i] - 0.106));
const catAfter = span(cat);
const catJumpAfter = lastRotationJump(hind);
console.log(JSON.stringify({walkDisplacementBefore:before,walkDisplacementAfter:after,standSeatMismatch:seatMismatch,sitHorizontalDrift:sitDrift,catVerticalSpanBefore:catBefore,catVerticalSpanAfter:catAfter,catLastLegJumpBefore:catJumpBefore,catLastLegJumpAfter:catJumpAfter}, null, 2));
if (before < 1 || after > 0.0001 || seatMismatch > 0.005 || sitDrift > 0.0001 || catAfter > catBefore * 0.26 || catJumpAfter > 15 || catJumpAfter > catJumpBefore * 0.5) process.exitCode = 1;
