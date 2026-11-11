// Exercise the actual inline texture repair without a browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../site/index.html'), 'utf8');
const start = source.indexOf('    async function healDroppedTextures(');
const end = source.indexOf('    const load = async', start);
assert.ok(start >= 0 && end > start, 'texture repair exists');
class Texture {
  constructor(image) { this.image = image; this.offset = { set: (...v) => { this.offsetValue = v; } }; this.repeat = { set: (...v) => { this.repeatValue = v; } }; }
  clone() { return new Texture(this.image); }
}
const THREE = { Texture, SRGBColorSpace: 'srgb', NoColorSpace: 'linear', LinearFilter: 1, LinearMipmapLinearFilter: 2, RepeatWrapping: 3 };
let decoded = 0;
const createImageBitmap = async blob => { decoded++; return { size: blob.size }; };
const heal = new Function('THREE', 'createImageBitmap', source.slice(start, end) + '\nreturn healDroppedTextures;')(THREE, createImageBitmap);
const json = {
  textures: [{ source: 0 }, { source: 1 }],
  images: [{ bufferView: 0, mimeType: 'image/png' }, { bufferView: 1, mimeType: 'image/png' }],
  bufferViews: [{ byteOffset: 0, byteLength: 2 }, { byteOffset: 2, byteLength: 3 }],
  materials: [
    { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
    { pbrMetallicRoughness: { baseColorTexture: { index: 1, extensions: { KHR_texture_transform: { offset: [0.2, 0.3], repeat: [0.5, 0.6], rotation: 0.4 } } } } }
  ]
};
const text = Buffer.from(JSON.stringify(json));
const bytes = Buffer.alloc(20 + text.length + 8 + 5);
bytes.writeUInt32LE(text.length, 12); text.copy(bytes, 20);
const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const existing = { map: { original: true } }, missing = { map: null };
const gltf = { parser: { associations: new Map([[existing, { materials: 0 }], [missing, { materials: 1 }]]) } };
(async () => {
  await heal(gltf, ab);
  assert.equal(decoded, 1, 'only the missing image is decoded');
  assert.deepEqual(existing.map, { original: true }, 'existing texture is preserved');
  assert.equal(missing.map.image.size, 3);
  assert.equal(missing.map.colorSpace, 'srgb');
  assert.deepEqual(missing.map.offsetValue, [0.2, 0.3]);
  assert.deepEqual(missing.map.repeatValue, [0.5, 0.6]);
  assert.equal(missing.map.rotation, 0.4);
  await heal(gltf, ab);
  assert.equal(decoded, 1, 'a second repair does not decode again');
  console.log('Texture repair: existing maps preserved; missing image restored once.');
})().catch(error => { console.error(error); process.exitCode = 1; });
