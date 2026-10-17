// .tools/check-identifiers.mjs — 静态检查：所有被调用的函数/标识符都必须有定义
// 用于捕获 “xxx is not defined” 这类运行时 ReferenceError
import fs from 'node:fs';

const files = process.argv.slice(2);
const GLOBALS = new Set([
  'window', 'document', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'fetch', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData', 'Request', 'Response',
  'AbortController', 'AbortSignal', 'DOMException', 'Uint8Array', 'Uint32Array', 'Uint16Array', 'Int32Array',
  'DataView', 'ArrayBuffer', 'TextEncoder', 'TextDecoder', 'MutationObserver', 'HTMLElement', 'Element',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError',
  'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'btoa', 'atob',
  'chrome', 'self', 'globalThis', 'location', 'navigator', 'history', 'performance',
  'TextDecoderStream', 'ReadableStream', 'TransformStream', 'structuredClone',
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'delete', 'void',
  'in', 'of', 'do', 'else', 'try', 'finally', 'throw', 'async', 'await', 'yield', 'super', 'this',
  'BDGMuxer', 'MP4Box'
]);

function stripCommentsAndStrings(src) {
  // 去掉 /* */ 注释、// 行注释、字符串/模板字面量（避免注释与文案里的误报）
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

let problems = 0;
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripCommentsAndStrings(raw);
  const defined = new Set();
  for (const m of src.matchAll(/function\*?\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  for (const m of src.matchAll(/class\s+([A-Za-z_$][\w$]*)\s*[{ ]/g)) defined.add(m[1]);
  // class 方法定义（行首的 name(...) {）
  for (const m of src.matchAll(/(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) defined.add(m[1]);
  // 函数参数（普通函数与箭头函数）
  for (const m of src.matchAll(/(?:function\*?\s*[A-Za-z_$\w$]*\s*|)\(([^()]*)\)\s*(?:=>|\{)/g)) {
    m[1].split(',').forEach((p) => {
      const n = p.trim().split(/[=:\s]/)[0].replace(/^\.\.\./, '');
      if (n && /^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
    });
  }
  // for...of / for...in 循环变量
  for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  // catch 变量
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);

  const called = new Map();
  const callRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const name = m[2];
    called.set(name, (called.get(name) || 0) + 1);
  }
  const bad = [];
  for (const name of called.keys()) {
    if (defined.has(name) || GLOBALS.has(name)) continue;
    if (/^[A-Z]/.test(name)) continue;  // 构造器调用
    bad.push(name);
  }
  console.log('--- ' + file + ' ---');
  if (bad.length === 0) {
    console.log('  ✓ 所有被调用标识符均已定义');
  } else {
    problems += bad.length;
    for (const name of bad) console.log('  ✗ 未定义的调用: ' + name + '()  (出现 ' + called.get(name) + ' 次)');
  }
}
process.exit(problems ? 1 : 0);
