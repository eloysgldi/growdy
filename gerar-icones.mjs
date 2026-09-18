// Gera os ícones do app sem depender de nada: monta os pixels na mão e
// escreve o PNG com o zlib que já vem no Node. Rode com: node gerar-icones.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = dirname(fileURLToPath(import.meta.url));

function crc32(buf) {
  let c, tabela = crc32.tabela;
  if (!tabela) {
    tabela = crc32.tabela = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tabela[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = tabela[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pedaco(tipo, dados) {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const soma = Buffer.alloc(4);
  soma.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, soma]);
}

function png(largura, altura, rgba) {
  const cabeca = Buffer.alloc(13);
  cabeca.writeUInt32BE(largura, 0);
  cabeca.writeUInt32BE(altura, 4);
  cabeca[8] = 8;   // bits por canal
  cabeca[9] = 6;   // RGBA
  const linhas = Buffer.alloc((largura * 4 + 1) * altura);
  for (let y = 0; y < altura; y++) {
    linhas[y * (largura * 4 + 1)] = 0; // filtro nenhum
    rgba.copy(linhas, y * (largura * 4 + 1) + 1, y * largura * 4, (y + 1) * largura * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pedaco('IHDR', cabeca),
    pedaco('IDAT', deflateSync(linhas, { level: 9 })),
    pedaco('IEND', Buffer.alloc(0)),
  ]);
}

// coração pela curva clássica: (x² + y² − 1)³ − x²y³ ≤ 0
const dentroDoCoracao = (x, y) => {
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
};

function desenhar(lado, { margem, raioCanto, fundoDe, fundoPara, corDoCoracao }) {
  const px = Buffer.alloc(lado * lado * 4);
  const centro = lado / 2;
  const escalaCoracao = lado * (margem ? 0.26 : 0.30);
  const amostras = [-0.25, 0.25]; // 2x2 por pixel, para a borda não ficar serrilhada

  for (let y = 0; y < lado; y++) {
    for (let x = 0; x < lado; x++) {
      let dentroFundo = 0, dentroCoracao = 0;
      for (const dy of amostras) {
        for (const dx of amostras) {
          const px2 = x + 0.5 + dx, py2 = y + 0.5 + dy;
          // fundo: quadrado de cantos arredondados
          const bx = Math.max(margem - px2, px2 - (lado - margem), 0);
          const by = Math.max(margem - py2, py2 - (lado - margem), 0);
          const forade = Math.hypot(Math.max(bx - raioCanto + 0, 0), Math.max(by - raioCanto + 0, 0));
          const dentroCaixa = px2 >= margem - raioCanto && px2 <= lado - margem + raioCanto &&
            py2 >= margem - raioCanto && py2 <= lado - margem + raioCanto;
          const cantoOk = (() => {
            const cx = Math.min(Math.max(px2, margem + raioCanto), lado - margem - raioCanto);
            const cy = Math.min(Math.max(py2, margem + raioCanto), lado - margem - raioCanto);
            return Math.hypot(px2 - cx, py2 - cy) <= raioCanto;
          })();
          if (dentroCaixa && cantoOk && forade <= raioCanto + 0.001) dentroFundo++;
          // coração, levemente acima do centro
          const hx = (px2 - centro) / escalaCoracao;
          const hy = -((py2 - centro + lado * 0.035) / escalaCoracao);
          if (dentroDoCoracao(hx, hy * 1.15 - 0.15)) dentroCoracao++;
        }
      }
      const i = (y * lado + x) * 4;
      const t = y / lado; // degradê de cima para baixo
      const fundo = [
        Math.round(fundoDe[0] + (fundoPara[0] - fundoDe[0]) * t),
        Math.round(fundoDe[1] + (fundoPara[1] - fundoDe[1]) * t),
        Math.round(fundoDe[2] + (fundoPara[2] - fundoDe[2]) * t),
      ];
      const aFundo = dentroFundo / 4;
      const aCoracao = (dentroCoracao / 4) * aFundo;
      const mistura = (f, c) => Math.round(f * (1 - aCoracao / Math.max(aFundo, 0.0001)) + c * (aCoracao / Math.max(aFundo, 0.0001)));
      px[i] = aFundo ? mistura(fundo[0], corDoCoracao[0]) : 0;
      px[i + 1] = aFundo ? mistura(fundo[1], corDoCoracao[1]) : 0;
      px[i + 2] = aFundo ? mistura(fundo[2], corDoCoracao[2]) : 0;
      px[i + 3] = Math.round(aFundo * 255);
    }
  }
  return png(lado, lado, px);
}

const VERDE_CLARO = [52, 217, 138];
const VERDE = [0, 161, 92];
const BRANCO = [255, 255, 255];

const saidas = [
  ['icone-192.png', desenhar(192, { margem: 0, raioCanto: 42, fundoDe: VERDE_CLARO, fundoPara: VERDE, corDoCoracao: BRANCO })],
  ['icone-512.png', desenhar(512, { margem: 0, raioCanto: 112, fundoDe: VERDE_CLARO, fundoPara: VERDE, corDoCoracao: BRANCO })],
  // maskable: o sistema corta as bordas, então o desenho vive no miolo
  ['icone-maskable.png', desenhar(512, { margem: 0, raioCanto: 256, fundoDe: VERDE_CLARO, fundoPara: VERDE, corDoCoracao: BRANCO })],
  ['icone-aviso.png', desenhar(96, { margem: 0, raioCanto: 22, fundoDe: VERDE, fundoPara: VERDE, corDoCoracao: BRANCO })],
];

for (const [nome, dados] of saidas) {
  writeFileSync(join(raiz, nome), dados);
  console.log('  ' + nome + ' · ' + (dados.length / 1024).toFixed(1) + ' KB');
}
console.log('\n  pronto\n');
