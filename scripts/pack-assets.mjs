import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress, weld, resample } from '@gltf-transform/functions';
import sharp from 'sharp';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const [, , src, dst, keep] = process.argv;
const doc = await io.read(src);
if (keep) {
  const names = new Set(keep.split(','));
  for (const a of doc.getRoot().listAnimations()) if (!names.has(a.getName())) a.dispose();
  for (const m of doc.getRoot().listMeshes()) m.dispose();
}
await doc.transform(
  dedup(),
  prune(),
  weld(),
  resample(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 92, resize: [2048, 2048] }),
);
await io.write(dst, doc);
console.log(
  dst,
  doc
    .getRoot()
    .listAnimations()
    .map((a) => a.getName())
    .join(','),
  doc
    .getRoot()
    .listTextures()
    .map((t) => t.getMimeType() + ' ' + t.getSize())
    .join(' | '),
);
