import fs from 'node:fs/promises';

await fs.rm('dist', { recursive: true, force: true });
await fs.mkdir('dist', { recursive: true });
await fs.copyFile('src/index.js', 'dist/index.js');
await fs.copyFile('data/harnesses.json', 'dist/harnesses.json');
await fs.copyFile('data/compatibility.json', 'dist/compatibility.json');

console.log('Built dist/');
