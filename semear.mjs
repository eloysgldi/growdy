// Popula o banco do protótipo com duas campanhas de demonstração já cheias:
// uma vaquinha perto da meta e uma rifa quase esgotada. Rode com: node semear.mjs
// Só mexe em dados/dados.json — não fala com a BassPago e não move dinheiro.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = dirname(fileURLToPath(import.meta.url));
const ARQUIVO = join(raiz, 'dados', 'dados.json');

const NOMES = ['Marina S.', 'Cleber A.', 'Dona Zélia', 'Beto do mercado', 'Paula R.', 'Seu Nilton', 'Tia Rosa',
  'Juliana M.', 'Rafael T.', 'Camila O.', 'Vanderlei', 'Bruna L.', 'Seu Zé', 'Débora F.', 'Anderson P.',
  'Luciana B.', 'Marcos V.', 'Fernanda C.', 'Wesley', 'Patrícia N.', 'Edson R.', 'Amanda G.', 'Rogério',
  'Simone A.', 'Thiago H.', 'Renata D.', 'Carlinhos', 'Elaine S.', 'Douglas M.', 'Sandra', 'Vitor H.',
  'Priscila', 'Alexandre L.', 'Joana P.', 'Maurício', 'Letícia', 'Gilberto', 'Késia', 'Nando', 'Cris',
  'Eliane', 'Robson', 'Tatiane', 'Márcia', 'Fábio', 'Jussara', 'Leandro', 'Neide', 'Osvaldo', 'Bia'];
const RECADOS = ['Vai dar certo!', 'Conta comigo', 'Que Deus abençoe', 'Toda ajuda conta', 'Tamo junto',
  'Pela molecada', 'Força aí', 'Merece demais', 'Já compartilhei no grupo', 'Sucesso!', 'Quero ver pronto',
  '', '', '', '', ''];
const sorteie = l => l[Math.floor(Math.random() * l.length)];
const svg = arte => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="320" viewBox="0 0 400 320">' + arte + '</svg>');

const FOTOS = {
  quadra: svg('<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#BFEAD3"/><stop offset="1" stop-color="#6FCB9B"/></linearGradient></defs>' +
    '<rect width="400" height="320" fill="url(#a)"/><circle cx="318" cy="62" r="34" fill="#FFF0C9"/>' +
    '<rect x="0" y="196" width="400" height="124" fill="#2E8A5E"/>' +
    '<rect x="44" y="214" width="312" height="92" rx="6" fill="none" stroke="#DFF6E9" stroke-width="3"/>' +
    '<line x1="200" y1="214" x2="200" y2="306" stroke="#DFF6E9" stroke-width="3"/>' +
    '<circle cx="200" cy="260" r="26" fill="none" stroke="#DFF6E9" stroke-width="3"/>' +
    '<rect x="36" y="118" width="16" height="80" fill="#0E5B3A"/><rect x="26" y="106" width="36" height="24" rx="4" fill="#0E5B3A"/>' +
    '<rect x="348" y="118" width="16" height="80" fill="#0E5B3A"/><rect x="338" y="106" width="36" height="24" rx="4" fill="#0E5B3A"/>' +
    '<circle cx="258" cy="240" r="13" fill="#FFF8E7" stroke="#0E5B3A" stroke-width="2"/>'),
  gente: svg('<rect width="400" height="320" fill="#EAF7F0"/>' +
    '<circle cx="110" cy="128" r="46" fill="#00A15C" opacity=".22"/><circle cx="200" cy="108" r="54" fill="#00A15C" opacity=".34"/><circle cx="292" cy="130" r="44" fill="#00A15C" opacity=".2"/>' +
    '<path d="M40 300c8-58 36-88 70-88s62 30 70 88z" fill="#06623B" opacity=".55"/>' +
    '<path d="M122 306c9-66 41-100 78-100s69 34 78 100z" fill="#06623B" opacity=".8"/>' +
    '<path d="M236 300c8-58 36-88 70-88s62 30 70 88z" fill="#06623B" opacity=".55"/>'),
  premio: svg('<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE9C6"/><stop offset="1" stop-color="#F6C377"/></linearGradient></defs>' +
    '<rect width="400" height="320" fill="url(#b)"/>' +
    '<rect x="128" y="86" width="150" height="168" rx="22" fill="#3B2A16"/>' +
    '<rect x="146" y="112" width="114" height="74" rx="12" fill="#F7A53B"/>' +
    '<circle cx="203" cy="216" r="18" fill="none" stroke="#F7A53B" stroke-width="6"/>' +
    '<path d="M203 204v12l8 6" stroke="#3B2A16" stroke-width="4" stroke-linecap="round" fill="none"/>' +
    '<path d="M74 78l9 22 22 9-22 9-9 22-9-22-22-9 22-9z" fill="#fff" opacity=".85"/>' +
    '<path d="M326 196l7 17 17 7-17 7-7 17-7-17-17-7 17-7z" fill="#fff" opacity=".7"/>'),
  churrasco: svg('<rect width="400" height="320" fill="#FFF3E0"/>' +
    '<circle cx="200" cy="150" r="96" fill="#E2891B" opacity=".18"/>' +
    '<rect x="92" y="188" width="216" height="26" rx="13" fill="#4A3418"/>' +
    '<rect x="112" y="150" width="176" height="14" rx="7" fill="#C56A2E"/>' +
    '<rect x="112" y="124" width="176" height="14" rx="7" fill="#C56A2E"/>' +
    '<path d="M140 108c-10-14 6-22-2-36M200 104c-10-14 6-22-2-36M260 108c-10-14 6-22-2-36" stroke="#E2891B" stroke-width="7" stroke-linecap="round" fill="none" opacity=".6"/>' +
    '<rect x="122" y="214" width="20" height="66" rx="6" fill="#4A3418"/><rect x="258" y="214" width="20" height="66" rx="6" fill="#4A3418"/>'),
};

const CAMPANHAS = [
  {
    id: 'demo-vaquinha',
    tipo: 'doacao',
    titulo: 'Reforma da quadra do Jardim União',
    descricao: 'A quadra é o único lugar do bairro onde as crianças jogam à tarde. O piso rachou no inverno e duas traves estão soltas.\n\nOrçamos com o pedreiro da rua: R$ 8.000 cobrem o piso novo, a pintura das linhas e as duas traves. Tudo que passar disso vira rede e bolas.',
    fotos: [FOTOS.quadra, FOTOS.gente],
    organizador: 'Ana Ferraz',
    pix: 'ana.ferraz@email.com',
    meta: 8000,
    valores: [25, 50, 100, 200],
    livre: true,
    anonimoPermitido: true,
    premio: '', preco: 0, cotas: 0, promos: [], sorteio: '', mostrarRestantes: true,
  },
  {
    id: 'demo-rifa',
    tipo: 'rifa',
    titulo: 'Rifa da Air Fryer — churrasco do Zé',
    descricao: 'Rifa para bancar o churrasco de fim de ano do time. Sorteio pela Loteria Federal, pelo primeiro prêmio.\n\nA foto do bilhete vai pro grupo assim que o Pix cair. Quem levar 10 cotas entra também no sorteio de uma caixa de cerveja.',
    fotos: [FOTOS.premio, FOTOS.churrasco],
    organizador: 'Zé do Campo',
    pix: '+5511988142200',
    meta: 0, valores: [], livre: true, anonimoPermitido: true,
    premio: 'Air Fryer 12L + 5 kg de picanha',
    preco: 10,
    cotas: 200,
    promos: [{ qtd: 3, preco: 25 }, { qtd: 5, preco: 35 }, { qtd: 10, preco: 60 }],
    sorteio: '',
    mostrarRestantes: true,
  },
];

function precoDasCotas(campanha, qtd) {
  const promos = (campanha.promos || []).filter(p => p.qtd > 0 && p.preco > 0).sort((a, b) => b.qtd - a.qtd);
  let resto = qtd, total = 0;
  for (const p of promos) {
    const n = Math.floor(resto / p.qtd);
    if (n > 0) { total += n * p.preco; resto -= n * p.qtd; }
  }
  return Math.round((total + resto * campanha.preco) * 100) / 100;
}

function historico(campanha) {
  const agora = Date.now(), dia = 24 * 3600 * 1000;
  const usados = new Set();
  const nome = () => {
    let n = sorteie(NOMES), volta = 0;
    while (usados.has(n) && volta++ < 60) n = sorteie(NOMES);
    usados.add(n);
    return n;
  };
  const base = extra => ({
    txid: 'DEMO' + Math.random().toString(36).slice(2, 12).toUpperCase(),
    campanhaId: campanha.id,
    tipo: campanha.tipo,
    nome: nome(),
    msg: sorteie(RECADOS),
    anonimo: Math.random() < 0.07,
    valor: 0, cotas: 0, numeros: [],
    status: 'PAGO',
    demo: true,
    criadaEm: agora,
    // metade do movimento nos últimos dois dias, para a página parecer viva
    pagaEm: agora - Math.floor(Math.random() * (Math.random() < 0.5 ? 2 : 12) * dia),
    ...extra,
  });

  const saida = [];
  if (campanha.tipo === 'doacao') {
    const alvo = campanha.meta * (0.87 + Math.random() * 0.05); // entre 87% e 92% da meta
    const miudo = [10, 15, 20, 25, 25, 50, 50];
    const gordo = [100, 150, 200, 300, 500];
    let soma = 0, guarda = 0;
    while (soma < alvo && guarda++ < 500) {
      const falta = alvo - soma;
      let valor = Math.random() < 0.8 ? sorteie(miudo) : sorteie(gordo);
      if (valor > falta) valor = Math.max(10, Math.round(falta));
      soma += valor;
      saida.push(base({ valor }));
    }
  } else {
    const total = campanha.cotas;
    const largura = String(total).length;
    const alvo = Math.floor(total * (0.9 + Math.random() * 0.04)); // deixa de 6% a 10% na mesa
    const livres = [];
    for (let n = 1; n <= total; n++) livres.push(String(n).padStart(largura, '0'));
    let vendidas = 0, guarda = 0;
    while (vendidas < alvo && guarda++ < 500) {
      const combos = campanha.promos.map(p => p.qtd);
      let qtd = Math.random() < 0.55 ? sorteie(combos) : sorteie([1, 1, 2, 3]);
      qtd = Math.min(qtd, alvo - vendidas);
      if (qtd < 1) break;
      const numeros = [];
      for (let i = 0; i < qtd; i++) numeros.push(livres.splice(Math.floor(Math.random() * livres.length), 1)[0]);
      vendidas += qtd;
      saida.push(base({ cotas: qtd, valor: precoDasCotas(campanha, qtd), numeros: numeros.sort() }));
    }
  }
  return saida;
}

const db = await readFile(ARQUIVO, 'utf8').then(JSON.parse).catch(() => ({ campanhas: {}, contribuicoes: [] }));
const refazer = process.argv.includes('--refazer');

for (const campanha of CAMPANHAS) {
  const jaTem = db.contribuicoes.some(c => c.campanhaId === campanha.id);
  if (jaTem && !refazer) {
    console.log(`  ${campanha.id}: já tem histórico (use --refazer para trocar)`);
    continue;
  }
  if (refazer) db.contribuicoes = db.contribuicoes.filter(c => c.campanhaId !== campanha.id || !c.demo);
  db.campanhas[campanha.id] = { ...campanha, criadaEm: db.campanhas[campanha.id]?.criadaEm || Date.now() };
  const novas = historico(campanha);
  db.contribuicoes.push(...novas);

  const pagas = db.contribuicoes.filter(c => c.campanhaId === campanha.id && c.status === 'PAGO');
  const soma = pagas.reduce((s, c) => s + c.valor, 0);
  const cotas = pagas.reduce((s, c) => s + c.cotas, 0);
  console.log(`  ${campanha.id}: ${pagas.length} apoios · R$ ${soma.toFixed(2)}` +
    (campanha.tipo === 'rifa'
      ? ` · ${cotas}/${campanha.cotas} cotas (${campanha.cotas - cotas} livres)`
      : ` · ${Math.round(soma / campanha.meta * 100)}% da meta`));
}

await mkdir(join(raiz, 'dados'), { recursive: true });
await writeFile(ARQUIVO, JSON.stringify(db, null, 2), 'utf8');
console.log('\n  pronto. abra:');
console.log('  http://localhost:4180/?c=demo-vaquinha');
console.log('  http://localhost:4180/?c=demo-rifa\n');
