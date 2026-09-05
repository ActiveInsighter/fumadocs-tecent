import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outputRoot = path.resolve('.static-docs');
const destination = path.join(outputRoot, 'docs', 'index.html');
const target = '/docs/politics/';

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0;url=${target}" />
    <meta name="robots" content="noindex" />
    <title>正在进入考研学习</title>
    <script>window.location.replace(${JSON.stringify(target)});</script>
  </head>
  <body>
    <p>正在进入默认学习模块。<a href="${target}">如果没有自动跳转，请点击这里。</a></p>
  </body>
</html>
`;

await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, html, 'utf8');
console.log(`[static-docs] Wrote /docs/ entry redirect -> ${target}`);
