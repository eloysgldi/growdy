// Growdy — servidor da página de vaquinha e rifa.
// Serve a página e fala com a BassPago (cash-in Pix) do lado de cá, para que
// client_id e client_secret nunca cheguem ao navegador.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { env, tokenCashIn, criarCobranca, consultarCobranca, novoTxid } from './bass.mjs';

const raiz = dirname(fileURLToPath(import.meta.url));
const PORTA = Number(env.PORT || 4180);
const ARQUIVO = join(raiz, 'dados', 'dados.json');

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

/* ---------------- banco de dados de arquivo ---------------- */
let cache = null;
let gravando = Promise.resolve();

async function ler() {
  if (cache) return cache;
  try { cache = JSON.parse(await readFile(ARQUIVO, 'utf8')); }
  catch { cache = { campanhas: {}, contribuicoes: [] }; }
  return cache;
}
function gravar() {
  // serializa as gravações para dois pedidos simultâneos não se atropelarem
  gravando = gravando.then(async () => {
    await mkdir(join(raiz, 'dados'), { recursive: true });
    await writeFile(ARQUIVO, JSON.stringify(cache, null, 2), 'utf8');
  }).catch(e => console.error('[dados] falha ao gravar:', e.message));
  return gravando;
}

/* ---------------- regras da campanha ---------------- */
const pagasDe = (db, id) => db.contribuicoes.filter(c => c.campanhaId === id && c.status === 'PAGO');

function resumo(db, campanha) {
  const pagas = pagasDe(db, campanha.id).sort((a, b) => b.pagaEm - a.pagaEm);
  const arrecadado = pagas.reduce((s, c) => s + c.valor, 0);
  const cotasVendidas = pagas.reduce((s, c) => s + (c.cotas || 0), 0);
  const ordem = pagas.map(c => c.valor).sort((a, b) => a - b);
  const mediana = ordem.length ? ordem[Math.floor(ordem.length / 2)] : 0;
  const ontem = Date.now() - 24 * 3600 * 1000;

  const publico = c => ({
    nome: c.anonimo ? 'Anônimo' : c.nome,
    valor: c.valor,
    cotas: c.cotas || 0,
    msg: c.msg || '',
    pagaEm: c.pagaEm,
  });

  return {
    arrecadado,
    apoiadores: pagas.length,
    cotasVendidas,
    cotasRestantes: Math.max(0, (campanha.cotas || 0) - cotasVendidas),
    ultimas24h: pagas.filter(c => c.pagaEm > ontem).length,
    valorTipico: mediana,
    // a lista fica contida: os maiores apoios e os mais recentes, o resto vira contagem
    destaques: pagas.slice().sort((a, b) => b.valor - a.valor).slice(0, 5).map(publico),
    recentes: pagas.slice(0, 3).map(publico),
  };
}

function numerosLivres(db, campanha, quantos) {
  const usados = new Set();
  for (const c of pagasDe(db, campanha.id)) (c.numeros || []).forEach(n => usados.add(n));
  const total = Math.max(1, campanha.cotas || 0);
  const largura = String(total).length;
  const escolhidos = [];
  let tentativas = 0;
  while (escolhidos.length < quantos && tentativas < total * 20) {
    tentativas++;
    const n = String(1 + Math.floor(Math.random() * total)).padStart(largura, '0');
    if (!usados.has(n)) { usados.add(n); escolhidos.push(n); }
  }
  return escolhidos.sort();
}

async function confirmarPagamento(contrib, e2e) {
  const db = await ler();
  if (contrib.status === 'PAGO') return contrib;
  contrib.status = 'PAGO';
  contrib.pagaEm = Date.now();
  if (e2e) contrib.e2e = e2e;
  const campanha = db.campanhas[contrib.campanhaId];
  if (campanha && campanha.tipo === 'rifa' && contrib.cotas > 0 && !contrib.numeros?.length) {
    contrib.numeros = numerosLivres(db, campanha, contrib.cotas);
  }
  await gravar();
  console.log(`  [pago] ${contrib.txid} · ${contrib.tipo} · R$ ${contrib.valor.toFixed(2)}`);
  return contrib;
}

/* ---------------- semeadura de demonstração ----------------
   Protótipo de venda: a campanha nasce com histórico para a tela abrir cheia —
   perto da meta, rifa quase esgotada, muita gente com doação pequena.
   Tudo marcado com demo:true e só acontece com DEMO=1 no .env.            */
const NOMES = ['Marina S.', 'Cleber A.', 'Dona Zélia', 'Beto do mercado', 'Paula R.', 'Seu Nilton', 'Tia Rosa',
  'Juliana M.', 'Rafael T.', 'Camila O.', 'Vanderlei', 'Bruna L.', 'Seu Zé', 'Débora F.', 'Anderson P.',
  'Luciana B.', 'Marcos V.', 'Fernanda C.', 'Wesley', 'Patrícia N.', 'Edson R.', 'Amanda G.', 'Rogério',
  'Simone A.', 'Thiago H.', 'Renata D.', 'Carlinhos', 'Elaine S.', 'Douglas M.', 'Sandra', 'Vitor H.',
  'Priscila', 'Alexandre L.', 'Joana P.', 'Maurício', 'Letícia', 'Gilberto', 'Késia', 'Nando', 'Cris'];
const RECADOS = ['Vai dar certo!', 'Conta comigo', 'Que Deus abençoe', 'Toda ajuda conta', 'Tamo junto',
  'Pela molecada', 'Força aí', 'Merece demais', 'Já compartilhei no grupo', 'Sucesso!', '', '', '', ''];
const sorteie = lista => lista[Math.floor(Math.random() * lista.length)];

function semearDemo(db, campanha) {
  if (env.DEMO !== '1') return;
  if (db.contribuicoes.some(c => c.campanhaId === campanha.id)) return;

  const agora = Date.now();
  const dia = 24 * 3600 * 1000;
  const usados = new Set();
  const nome = () => {
    let n = sorteie(NOMES), volta = 0;
    while (usados.has(n) && volta++ < 40) n = sorteie(NOMES);
    usados.add(n);
    return n;
  };
  const novo = extra => ({
    txid: 'DEMO' + Math.random().toString(36).slice(2, 12).toUpperCase(),
    campanhaId: campanha.id,
    tipo: campanha.tipo,
    nome: nome(),
    msg: sorteie(RECADOS),
    anonimo: Math.random() < 0.08,
    valor: 0, cotas: 0, numeros: [],
    status: 'PAGO',
    demo: true,
    criadaEm: agora,
    // metade do histórico nos últimos dois dias, para a página ter movimento recente
    pagaEm: agora - Math.floor(Math.random() * (Math.random() < 0.5 ? 2 : 12) * dia),
    ...extra,
  });

  if (campanha.tipo === 'doacao') {
    const alvo = campanha.meta * (0.86 + Math.random() * 0.06); // fica entre 86% e 92% da meta
    const pequenos = campanha.valores?.length ? campanha.valores : [20, 50, 100, 200];
    const miudo = [pequenos[0] || 20, pequenos[0] || 20, pequenos[1] || 50, 10, 15, 25];
    let soma = 0, guarda = 0;
    while (soma < alvo && guarda++ < 400) {
      const falta = alvo - soma;
      // a maioria é doação pequena; de vez em quando entra uma grande
      let valor = Math.random() < 0.78 ? sorteie(miudo) : sorteie([pequenos[2] || 100, pequenos[3] || 200, 300, 500]);
      if (valor > falta) valor = Math.max(10, Math.round(falta));
      soma += valor;
      db.contribuicoes.push(novo({ valor }));
    }
  } else {
    const total = campanha.cotas || 0;
    const alvo = Math.floor(total * (0.88 + Math.random() * 0.06)); // deixa de 6% a 12% das cotas na mesa
    const livres = [];
    for (let n = 1; n <= total; n++) livres.push(String(n).padStart(String(total).length, '0'));
    let vendidas = 0, guarda = 0;
    while (vendidas < alvo && guarda++ < 400) {
      const combos = (campanha.promos || []).map(p => p.qtd).filter(q => q > 0);
      let qtd = Math.random() < 0.55 && combos.length ? sorteie(combos) : sorteie([1, 1, 2, 3]);
      qtd = Math.min(qtd, alvo - vendidas);
      if (qtd < 1) break;
      const numeros = [];
      for (let i = 0; i < qtd; i++) numeros.push(livres.splice(Math.floor(Math.random() * livres.length), 1)[0]);
      vendidas += qtd;
      db.contribuicoes.push(novo({ cotas: qtd, valor: precoDasCotas(campanha, qtd), numeros: numeros.sort() }));
    }
  }
}

/* ---------------- http ---------------- */
const json = (res, status, corpo) => {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(texto);
};
const corpoDe = req => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', p => { d += p; if (d.length > 8e6) { reject(new Error('corpo grande demais')); req.destroy(); } });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('JSON inválido')); } });
  req.on('error', reject);
});

async function api(req, res, url) {
  const p = url.pathname;
  const db = await ler();

  // saúde da integração: só pede token, não cria cobrança nem move dinheiro
  if (p === '/api/saude' && req.method === 'GET') {
    try { await tokenCashIn(); return json(res, 200, { ok: true, bass: 'autenticado', chave: env.BASS_CHAVE_PIX }); }
    catch (e) { return json(res, 200, { ok: false, erro: e.message }); }
  }

  // publica uma campanha (ou atualiza a mesma pelo id)
  if (p === '/api/campanhas' && req.method === 'POST') {
    const c = await corpoDe(req);
    if (!c.titulo?.trim()) return json(res, 400, { erro: 'A campanha precisa de um título.' });
    if (c.tipo !== 'doacao' && c.tipo !== 'rifa') return json(res, 400, { erro: 'Tipo inválido.' });
    const id = (c.id && db.campanhas[c.id]) ? c.id : randomUUID().slice(0, 8);
    db.campanhas[id] = {
      ...db.campanhas[id],
      id,
      tipo: c.tipo,
      titulo: String(c.titulo).slice(0, 80),
      descricao: String(c.descricao || '').slice(0, 4000),
      fotos: Array.isArray(c.fotos) ? c.fotos.slice(0, 6) : [],
      organizador: String(c.organizador || '').slice(0, 60),
      pix: String(c.pix || '').slice(0, 80),
      meta: Number(c.meta) || 0,
      valores: Array.isArray(c.valores) ? c.valores.map(Number).filter(v => v > 0).slice(0, 4) : [],
      livre: c.livre !== false,
      anonimoPermitido: c.anonimo !== false,
      premio: String(c.premio || '').slice(0, 90),
      preco: Number(c.preco) || 0,
      cotas: Number(c.cotas) || 0,
      promos: Array.isArray(c.promos) ? c.promos.filter(x => x.qtd > 0 && x.preco > 0).slice(0, 5) : [],
      sorteio: c.sorteio || '',
      mostrarRestantes: c.restantes !== false,
      criadaEm: db.campanhas[id]?.criadaEm || Date.now(),
    };
    await gravar();
    return json(res, 201, { id, campanha: db.campanhas[id], resumo: resumo(db, db.campanhas[id]) });
  }

  const mCampanha = p.match(/^\/api\/campanhas\/([\w-]+)$/);
  if (mCampanha && req.method === 'GET') {
    const campanha = db.campanhas[mCampanha[1]];
    if (!campanha) return json(res, 404, { erro: 'Campanha não encontrada.' });
    return json(res, 200, { campanha, resumo: resumo(db, campanha) });
  }

  // cria a cobrança Pix do apoio
  if (p === '/api/contribuicoes' && req.method === 'POST') {
    const c = await corpoDe(req);
    const campanha = db.campanhas[c.campanhaId];
    if (!campanha) return json(res, 404, { erro: 'Publique a campanha antes de receber apoios.' });

    let valor = 0, cotas = 0;
    if (campanha.tipo === 'rifa') {
      cotas = Math.max(1, Math.floor(Number(c.cotas) || 1));
      const r = resumo(db, campanha);
      if (cotas > r.cotasRestantes) return json(res, 409, { erro: `Restam só ${r.cotasRestantes} cotas.` });
      valor = precoDasCotas(campanha, cotas);
    } else {
      valor = Math.round((Number(c.valor) || 0) * 100) / 100;
    }
    if (!(valor >= 1)) return json(res, 400, { erro: 'O valor mínimo é R$ 1,00.' });
    if (valor > 50000) return json(res, 400, { erro: 'Valor acima do limite desta página.' });

    const txid = novoTxid('GRW');
    const contrib = {
      txid,
      campanhaId: campanha.id,
      tipo: campanha.tipo,
      nome: String(c.nome || '').slice(0, 40) || 'Apoiador',
      msg: String(c.msg || '').slice(0, 80),
      anonimo: !!c.anonimo,
      contato: String(c.contato || '').slice(0, 40),
      valor,
      cotas,
      numeros: [],
      status: 'AGUARDANDO',
      criadaEm: Date.now(),
    };

    let cob;
    try {
      cob = await criarCobranca({
        txid,
        valor,
        solicitacao: (campanha.tipo === 'rifa' ? `${cotas} cota(s) · ` : '') + campanha.titulo,
        infoAdicionais: [{ nome: 'Campanha', valor: campanha.titulo.slice(0, 60) }],
      });
    } catch (e) {
      console.error('[bass]', e.message);
      return json(res, 502, { erro: 'Não consegui gerar o Pix agora. Tente de novo em instantes.' });
    }

    contrib.location = cob.location || '';
    db.contribuicoes.push(contrib);
    await gravar();

    return json(res, 201, {
      txid,
      valor,
      cotas,
      pixCopiaECola: cob.pixCopiaECola || '',
      expiracao: cob.calendario?.expiracao || Number(env.PIX_EXPIRACAO || 1800),
    });
  }

  // o navegador pergunta de tempos em tempos se o Pix caiu
  const mContrib = p.match(/^\/api\/contribuicoes\/([A-Za-z0-9]+)$/);
  if (mContrib && req.method === 'GET') {
    const contrib = db.contribuicoes.find(x => x.txid === mContrib[1]);
    if (!contrib) return json(res, 404, { erro: 'Cobrança não encontrada.' });
    if (contrib.status !== 'PAGO') {
      try {
        const cob = await consultarCobranca(contrib.txid);
        if (cob?.status === 'CONCLUIDA' || (cob?.pix || []).length) {
          await confirmarPagamento(contrib, cob?.pix?.[0]?.endToEndId);
        } else if (cob?.status && cob.status.startsWith('REMOVIDA')) {
          contrib.status = 'CANCELADA';
          await gravar();
        }
      } catch (e) { console.error('[bass consulta]', e.message); }
    }
    const campanha = db.campanhas[contrib.campanhaId];
    return json(res, 200, {
      status: contrib.status,
      numeros: contrib.numeros || [],
      valor: contrib.valor,
      cotas: contrib.cotas,
      resumo: campanha ? resumo(db, campanha) : null,
    });
  }

  // webhook da BassPago (evento RECEIVE) — use quando estiver em servidor público
  if (p === '/api/webhooks/bass' && req.method === 'POST') {
    const evento = await corpoDe(req).catch(() => null);
    const d = evento?.data;
    if (d && (evento.type === 'RECEIVE' || d.webhookType === 'RECEIVE') && d.status === 'LIQUIDATED') {
      const contrib = db.contribuicoes.find(x => x.txid === d.txId);
      if (contrib) await confirmarPagamento(contrib, d.endToEndId);
    }
    return json(res, 200, { recebido: true });
  }

  return json(res, 404, { erro: 'Rota inexistente.' });
}

function precoDasCotas(campanha, qtd) {
  const promos = (campanha.promos || []).filter(p => p.qtd > 0 && p.preco > 0).sort((a, b) => b.qtd - a.qtd);
  let resto = qtd, total = 0;
  for (const p of promos) {
    const n = Math.floor(resto / p.qtd);
    if (n > 0) { total += n * p.preco; resto -= n * p.qtd; }
  }
  return Math.round((total + resto * campanha.preco) * 100) / 100;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);

    const pedido = url.pathname === '/' ? '/index.html' : url.pathname;
    const alvo = join(raiz, pedido);
    if (!alvo.startsWith(raiz) || alvo.includes('.env') || alvo.includes('certs')) {
      res.writeHead(403).end('fora da pasta');
      return;
    }
    const buf = await readFile(alvo);
    res.writeHead(200, { 'Content-Type': TIPOS[extname(alvo)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) {
    if (e?.code === 'ENOENT') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('não encontrado'); return; }
    console.error('[erro]', e);
    if (!res.headersSent) json(res, 500, { erro: 'Algo quebrou aqui do lado.' });
  }
}).listen(PORTA, () => {
  const ips = Object.values(networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\n  Growdy no ar');
  console.log(`  aqui       http://localhost:${PORTA}`);
  ips.forEach(ip => console.log(`  no celular http://${ip}:${PORTA}  (mesma rede wi-fi)`));
  console.log(`  integração http://localhost:${PORTA}/api/saude\n`);
});
