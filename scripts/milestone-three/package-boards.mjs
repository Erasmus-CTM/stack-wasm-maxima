// SPDX-License-Identifier: AGPL-3.0-or-later
// Package the pinned renderer's documents; never rewrite upstream vendor code.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, posix} from 'node:path';

const marker = /@@CTM_NATIVE_([A-Za-z0-9_]+)@@/g;
const inert = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safeId = id => assert.match(id, /^[A-Za-z0-9_-]+$/, 'Unsafe board identifier');

export function boardProgram(board, tokens) {
  const ids = [...new Set(Array.from(board.code.matchAll(marker), row => row[1]))];
  // This adapter currently admits prepared finite coordinate scalars, not a JS
  // source evaluator. Reject other authored contexts before generating a file.
  for (const row of board.code.matchAll(inert)) assert.ok(!row[0].match(marker), 'Board tokens inside strings/comments are unsupported');
  const code = board.code.replace(marker, (whole, id, offset) => {
    const spec = tokens.find(token => token.id === id);
    assert.ok(spec?.format === 'source' && spec.context === 'javascript', 'Board token needs native numeric source format');
    const lineStart=board.code.lastIndexOf('\n',offset)+1;
    const lineEnd=board.code.indexOf('\n',offset);
    assert.ok(!board.code.slice(lineStart,lineEnd<0?undefined:lineEnd).includes('/'), 'Board token lines cannot contain regex/division/comment syntax');
    assert.match(board.code.slice(0, offset), /[\[,]\s*$/, 'Board tokens require standalone numeric array elements');
    assert.match(board.code.slice(offset + whole.length), /^\s*[,\]]/, 'Board tokens require standalone numeric array elements');
    return 'ctm_board_values[' + JSON.stringify(id) + ']';
  });
  return {code, ids};
}

export function boardValues(ids, variant) {
  return Object.fromEntries(ids.map(id => {
    const token = variant.tokenValues[id];
    assert.ok(token && token.string === false && typeof token.value === 'string' &&
      /^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token.value), 'Board token must be a finite native numeric literal: ' + id);
    const value = Number(token.value);
    assert.ok(Number.isFinite(value) && !Object.is(value,-0), 'Nonfinite or signed-zero native board token: ' + id);
    return [id, value];
  }));
}

// assetMap receives the renderer's exact original external URL and returns a
// staged site-root-relative path. The staging producer owns pins and closure.
export async function packageBoard({iframe, id, site, assetMap, mathjax}) {
  safeId(id);
  const match = /\bsrc="data:text\/html;base64,([A-Za-z0-9+/=]+)"/.exec(iframe);
  assert.ok(match, 'Expected the pinned Quarto data-URL iframe');
  let document = Buffer.from(match[1], 'base64').toString('utf8');
  const originalSha256 = sha256(Buffer.from(document));
  const assets = [];
  if (mathjax) {
    const relativePath = path => {
      assert.ok(typeof path === 'string' && /^[A-Za-z0-9_@./-]+$/.test(path) && !path.split('/').includes('..') && !path.startsWith('/'), 'Unsafe local MathJax path');
      return posix.relative('native/boards',path);
    };
    const config = {
      loader:{paths:Object.fromEntries(Object.entries(mathjax.config.loader.paths).map(([key,path])=>[key,relativePath(path)]))},
      svg:{fontPath:relativePath(mathjax.config.svg.fontPath)},
      chtml:{fontPath:relativePath(mathjax.config.chtml.fontPath),fontURL:relativePath(mathjax.config.chtml.fontURL)}
    };
    const json=JSON.stringify(config).replace(/</g,'\\u003c');
    // Configure the unchanged vendor loader before the canonical CTM pre-loader
    // installs its supported startup adaptor. Every local base is absolute at
    // runtime, including imports from an opaque speech worker.
    const setup='<script>(function(){const c='+json+';for(const key of Object.keys(c.loader.paths))c.loader.paths[key]=new URL(c.loader.paths[key],document.baseURI).href;for(const part of [c.svg,c.chtml])for(const key of Object.keys(part))part[key]=new URL(part[key],document.baseURI).href;window.MathJax=c;})();</script>\n'+
      '<script src="'+relativePath(mathjax.preloader)+'" crossorigin="anonymous"></script>\n';
    assert.equal((document.match(/<script id="MathJax-script"/g)||[]).length,1,'Expected exactly one stock MathJax entry point');
    document=document.replace('<script id="MathJax-script"',setup+'<script id="MathJax-script"');
  }
  await mkdir(join(site, 'native/boards/assets'), {recursive:true});
  // Only move whole embedded resources. Their decoded bytes remain identical.
  for (const row of [...document.matchAll(/data:(text\/javascript|text\/css);base64,([A-Za-z0-9+/=]+)/g)]) {
    const bytes = Buffer.from(row[2], 'base64'), digest = sha256(bytes);
    const path = 'native/boards/assets/' + digest + (row[1] === 'text/css' ? '.css' : '.js');
    await writeFile(join(site, path), bytes);
    document = document.split(row[0]).join('./assets/' + posix.basename(path));
    assets.push({path, bytes:bytes.length, sha256:digest});
  }
  // Use CORS for opaque sandbox subresources, retaining the sandbox and COEP.
  document = document.replace(/<script([^>]*\bsrc=")([^"]+)("[^>]*)>/g, (whole, before, url, after) => {
    if (/^https?:/.test(url)) {
      const path = assetMap(url);
      assert.ok(typeof path === 'string' && /^[A-Za-z0-9_@./-]+$/.test(path) && !path.split('/').includes('..') && !path.startsWith('/'), 'Unmapped or unsafe board asset: ' + url);
      url = posix.relative('native/boards', path);
      assets.push({originalURL:whole.match(/src="([^"]+)/)[1], path});
    }
    return '<script' + before + url + after + (/\bcrossorigin=/.test(after) ? '' : ' crossorigin="anonymous"') + '>';
  });
  // Stylesheet @import has no crossorigin flag; use an equivalent CORS link.
  document = document.replace(/<style>@import url\("(\.\/assets\/[^"\n]+\.css)"\);<\/style>/g,
    '<link rel="stylesheet" href="$1" crossorigin="anonymous">');
  assert.ok(!/<(?:script|link)[^>]*(?:src|href)="https?:/.test(document), 'Board has an unstaged external resource');
  const path = 'native/boards/' + id + '.html';
  await writeFile(join(site, path), document);
  // The parent fetches this same-origin URL once and mounts explicit-base
  // srcdoc, preserving the existing opaque sandbox on headerless static hosts.
  const html = iframe.replace(match[0], 'src="about:blank" data-stack-jsxgraph-template="../' + path + '"');
  return {html, path, bytes:Buffer.byteLength(document), sha256:sha256(Buffer.from(document)), originalSha256, assets};
}
