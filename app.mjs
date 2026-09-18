// Growdy — servidor da página de vaquinha e rifa (ponto de entrada em produção).
// Substitui o server.mjs antigo: acrescenta senha de administrador para criar
// campanha, upload de fotos para disco e pasta de dados configurável (Render).
//
// Quem cria campanha precisa da senha (ADMIN_SENHA).
// Quem recebe o link só abre e paga — sem cadastro, sem login, sem nada.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomUUID, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { env, tokenCashIn, criarCobranca, consultarCobranca, novoTxid } from './bass.mjs';
import { prepararDisco, lerDados, gravarDados, guardarArquivo, lerArquivo, descreverArmazem, tocarArmazem } from './armazem.mjs';
import webpush from 'web-push';

const PUSH_LIGADO = !!(env.VAPID_PUBLICA && env.VAPID_PRIVADA);
if (PUSH_LIGADO) {
  webpush.setVapidDetails(env.VAPID_CONTATO || 'mailto:contato@growdy.app', env.VAPID_PUBLICA, env.VAPID_PRIVADA);
}

const raiz = dirname(fileURLToPath(import.meta.url));
const PORTA = Number(env.PORT || 4180);
const SENHA = env.ADMIN_SENHA || '';

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
  cache = await lerDados();
  return cache;
}
function gravar() {
  // serializa as gravações para dois pedidos simultâneos não se atropelarem, e
  // adota de volta o resultado da junção — assim esta instância já enxerga o que
  // a outra escreveu enquanto isso
  gravando = gravando
    .then(() => gravarDados(cache))
    .then(junto => { if (junto) cache = junto; })
    .catch(e => console.error('[dados] falha ao gravar:', e.message));
  return gravando;
}

// visita é o caminho mais movimentado e o menos importante: junta as gravações
let gravacaoAgendada = null;
function agendarGravacao() {
  if (gravacaoAgendada) return gravacaoAgendada;
  gravacaoAgendada = new Promise(resolve => {
    setTimeout(() => { gravacaoAgendada = null; gravar().then(resolve); }, 5000);
  });
  return gravacaoAgendada;
}

// A chave do prêmio é derivada do txid, não sorteada e guardada: assim ela não
// se perde se o arquivo de dados for sobrescrito, e continua impossível de
// adivinhar sem conhecer o txid.
const SEGREDO = env.SEGREDO_RESGATE || env.VAPID_PRIVADA || env.ADMIN_SENHA || 'growdy-sem-segredo';
const chaveDeResgate = txid => createHmac('sha256', SEGREDO).update('resgate:' + txid).digest('hex').slice(0, 20);
const chaveConfere = (contrib, chave) =>
  !!chave && (chave === contrib.resgate || chave === chaveDeResgate(contrib.txid));

/* ---------------- quem é dono da casa ---------------- */
function ehAdmin(req) {
  if (!SENHA) return true; // sem senha configurada: modo aberto, só para uso local
  const a = Buffer.from(String(req.headers['x-admin'] || ''));
  const b = Buffer.from(SENHA);
  return a.length === b.length && timingSafeEqual(a, b);
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
  // chave que abre o prêmio depois, sem precisar de conta nem senha
  contrib.resgate = chaveDeResgate(contrib.txid);
  const campanha = db.campanhas[contrib.campanhaId];
  if (campanha && campanha.tipo === 'rifa' && contrib.cotas > 0 && !contrib.numeros?.length) {
    contrib.numeros = numerosLivres(db, campanha, contrib.cotas);
  }
  await gravar();
  console.log(`  [pago] ${contrib.txid} · ${contrib.tipo} · R$ ${contrib.valor.toFixed(2)}`);

  if (campanha) {
    const r = resumo(db, campanha);
    const quem = contrib.anonimo ? 'Alguém' : contrib.nome;
    const quanto = contrib.tipo === 'rifa'
      ? `${contrib.cotas} ${contrib.cotas === 1 ? 'cota' : 'cotas'} · ${dinheiro(contrib.valor)}`
      : dinheiro(contrib.valor);
    const andamento = campanha.tipo === 'rifa'
      ? `${r.cotasVendidas} de ${campanha.cotas} cotas vendidas`
      : `${Math.round(campanha.meta > 0 ? (r.arrecadado / campanha.meta) * 100 : 0)}% da meta · ${dinheiro(r.arrecadado)} no total`;
    avisar({
      titulo: `${quanto} em ${campanha.titulo}`,
      corpo: `${quem} acabou de apoiar. ${andamento}.`,
      url: '/?painel=' + campanha.id,
      tag: 'apoio-' + campanha.id,
    });
  }
  return contrib;
}

const dinheiro = n => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hojeISO = () => new Date().toISOString().slice(0, 10);

/* ---------------- notificações no celular de quem organiza ---------------- */
async function avisar(aviso) {
  if (!PUSH_LIGADO) return;
  const db = await ler();
  const inscritos = db.push || [];
  if (!inscritos.length) return;
  const carga = JSON.stringify(aviso);
  const mortos = [];
  await Promise.all(inscritos.map(async inscricao => {
    try {
      await webpush.sendNotification(inscricao, carga);
    } catch (e) {
      // 404 e 410 são inscrições que o navegador já descartou
      if (e.statusCode === 404 || e.statusCode === 410) mortos.push(inscricao.endpoint);
      else console.error('[push] falhou:', e.statusCode || e.message);
    }
  }));
  if (mortos.length) {
    db.push = inscritos.filter(i => !mortos.includes(i.endpoint));
    await gravar();
  }
}

/* ---------------- quantas pessoas viram a campanha ---------------- */
// o par visitante+dia fica na memória só para não contar a mesma pessoa duas
// vezes; o número em si é gravado e sobrevive a reinício
const vistosHoje = new Set();
async function contarVisita(campanhaId, req) {
  const db = await ler();
  if (!db.campanhas[campanhaId]) return null;
  const dia = hojeISO();
  const impressao = createHash('sha256')
    .update((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') + '|' + (req.headers['user-agent'] || '') + '|' + campanhaId + '|' + dia)
    .digest('hex').slice(0, 16);
  db.visitas = db.visitas || {};
  db.visitas[campanhaId] = db.visitas[campanhaId] || {};
  const doDia = db.visitas[campanhaId][dia] || { vistas: 0, pessoas: 0 };
  doDia.vistas++;
  let nova = false;
  if (!vistosHoje.has(impressao)) { vistosHoje.add(impressao); doDia.pessoas++; nova = true; }
  db.visitas[campanhaId][dia] = doDia;
  agendarGravacao();
  return { dia, ...doDia, nova };
}

function contarVisitas(db, campanhaId) {
  const porDia = (db.visitas || {})[campanhaId] || {};
  const dias = Object.keys(porDia);
  const soma = campo => dias.reduce((s, d) => s + (porDia[d][campo] || 0), 0);
  const hoje = porDia[hojeISO()] || { vistas: 0, pessoas: 0 };
  return { hoje: hoje.pessoas, hojeVistas: hoje.vistas, total: soma('pessoas'), totalVistas: soma('vistas') };
}

/* ---------------- o resumo do dia ---------------- */
async function resumoDoDia(forcar) {
  const db = await ler();
  const dia = hojeISO();
  db.avisos = db.avisos || {};
  if (!forcar && db.avisos.ultimoResumo === dia) return { enviado: false, motivo: 'o de hoje já saiu' };

  const campanhas = Object.values(db.campanhas).filter(c => !c.encerrada);
  if (!campanhas.length) return { enviado: false, motivo: 'nenhuma campanha no ar' };

  const desde = new Date(dia + 'T00:00:00').getTime();
  let pessoas = 0, apoios = 0, total = 0;
  for (const c of campanhas) {
    pessoas += contarVisitas(db, c.id).hoje;
    const pagas = pagasDe(db, c.id).filter(x => x.pagaEm >= desde);
    apoios += pagas.length;
    total += pagas.reduce((s, x) => s + x.valor, 0);
  }

  const corpo = apoios
    ? `${pessoas} ${pessoas === 1 ? 'pessoa viu' : 'pessoas viram'} · ${apoios} ${apoios === 1 ? 'apoiou' : 'apoiaram'} · ${dinheiro(total)}`
    : `${pessoas} ${pessoas === 1 ? 'pessoa viu' : 'pessoas viram'} hoje, ninguém apoiou ainda. Um empurrão no link ajuda.`;
  await avisar({ titulo: 'Growdy hoje', corpo, url: '/?painel=1', tag: 'resumo-' + dia });

  db.avisos.ultimoResumo = dia;
  await gravar();
  return { enviado: true, pessoas, apoios, total };
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

/* ---------------- semeadura de demonstração ----------------
   Protótipo de venda: com DEMO=1 a campanha nasce com histórico para a tela
   abrir cheia — perto da meta, rifa quase esgotada, muita doação pequena.
   Tudo marcado com demo:true. Em produção de verdade, DEMO=0.            */
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
    const miudo = [10, 15, 20, 25, 25, 50, 50];
    const gordo = [100, 150, 200, 300, 500];
    let soma = 0, guarda = 0;
    while (soma < alvo && guarda++ < 400) {
      const falta = alvo - soma;
      let valor = Math.random() < 0.8 ? sorteie(miudo) : sorteie(gordo);
      if (valor > falta) valor = Math.max(10, Math.round(falta));
      soma += valor;
      db.contribuicoes.push(novo({ valor }));
    }
  } else {
    const total = campanha.cotas || 0;
    if (!total) return;
    const largura = String(total).length;
    const alvo = Math.floor(total * (0.88 + Math.random() * 0.06)); // deixa de 6% a 12% das cotas na mesa
    const livres = [];
    for (let n = 1; n <= total; n++) livres.push(String(n).padStart(largura, '0'));
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
// Cortar a conexão no meio (req.destroy) faz o navegador dizer só "Load failed".
// Então, quando passa do limite, o corpo é descartado mas a leitura continua até
// o fim, para dar tempo de responder um 413 que a pessoa consiga entender.
const LIMITE_CORPO = 12e6;
const LIMITE_MIDIA = 25e6; // prêmio em vídeo precisa de mais espaço que uma foto

// corpo cru, sem JSON: é assim que o vídeo do prêmio sobe, sem inchar 33% em base64
const bytesDe = (req, limite) => new Promise((resolve, reject) => {
  const pedacos = [];
  let total = 0, grande = false;
  req.on('data', p => {
    if (grande) return;
    total += p.length;
    if (total > limite) { grande = true; pedacos.length = 0; return; }
    pedacos.push(p);
  });
  req.on('end', () => grande
    ? reject(Object.assign(new Error('arquivo grande demais'), { status: 413 }))
    : resolve(Buffer.concat(pedacos)));
  req.on('error', reject);
});
const corpoDe = req => new Promise((resolve, reject) => {
  let d = '';
  let grande = false;
  req.on('data', p => {
    if (grande) return;
    d += p;
    if (d.length > LIMITE_CORPO) { grande = true; d = ''; }
  });
  req.on('end', () => {
    if (grande) return reject(Object.assign(new Error('corpo grande demais'), { status: 413 }));
    try { resolve(d ? JSON.parse(d) : {}); } catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
  });
  req.on('error', reject);
});

async function api(req, res, url) {
  const p = url.pathname;
  const db = await ler();

  // o app pergunta se esta pessoa pode criar campanha
  if (p === '/api/eu' && req.method === 'GET') {
    return json(res, 200, { admin: ehAdmin(req), exigeSenha: !!SENHA });
  }

  // batida de coração para o serviço não hibernar; de propósito não fala com
  // a BassPago nem lê disco — é só para manter a máquina acordada
  if (p === '/api/ping') {
    const tocou = await tocarArmazem().catch(() => false);
    // o mesmo ping que mantém tudo acordado dispara o resumo do dia à noite
    const horaBrasil = new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
    let resumoEnviado;
    if (horaBrasil >= 20) resumoEnviado = (await resumoDoDia(false).catch(() => null))?.enviado || undefined;
    return json(res, 200, {
      ok: true,
      agora: new Date().toISOString(),
      armazem: tocou ? 'acordado' : undefined,
      resumo: resumoEnviado ? 'enviado' : undefined,
    });
  }

  // saúde da integração: só pede token, não cria cobrança nem move dinheiro
  if (p === '/api/saude' && req.method === 'GET') {
    const dados = descreverArmazem();
    try { await tokenCashIn(); return json(res, 200, { ok: true, bass: 'autenticado', chave: env.BASS_CHAVE_PIX, dados }); }
    catch (e) { return json(res, 200, { ok: false, erro: e.message, dados }); }
  }

  // sobe uma foto e devolve a URL dela; só o dono da casa sobe foto
  if (p === '/api/fotos' && req.method === 'POST') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    const { dados } = await corpoDe(req);
    const casa = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dados || ''));
    if (!casa) return json(res, 400, { erro: 'Imagem inválida.' });
    const bytes = Buffer.from(casa[2], 'base64');
    if (bytes.length > 4e6) return json(res, 413, { erro: 'Imagem grande demais (limite de 4 MB).' });
    const ext = casa[1] === 'png' ? '.png' : casa[1] === 'webp' ? '.webp' : '.jpg';
    const nome = randomUUID() + ext;
    try {
      const url = await guardarArquivo('fotos', nome, bytes, 'image/' + (casa[1] === 'jpg' ? 'jpeg' : casa[1]));
      return json(res, 201, { url });
    } catch (e) {
      console.error('[fotos] falha ao guardar:', e.message);
      const onde = descreverArmazem();
      return json(res, 500, {
        erro: 'Não consegui guardar a foto (' + (e.code || e.message) + '). ' +
          (onde.tipo === 'supabase'
            ? 'Confira SUPABASE_URL, SUPABASE_CHAVE e se o balde "' + onde.balde + '" existe.'
            : 'No Render sem disco, configure o Supabase (grátis) ou crie o disco em Settings > Disks.'),
      });
    }
  }

  // publica uma campanha (ou atualiza a mesma pelo id)
  if (p === '/api/campanhas' && req.method === 'POST') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
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
      fotos: (Array.isArray(c.fotos) ? c.fotos : []).filter(f => typeof f === 'string').slice(0, 6),
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
      // prêmio digital: foto ou vídeo que o apoiador (ou o ganhador) recebe
      recompensa: c.recompensa && c.recompensa.arquivo ? {
        ativa: c.recompensa.ativa !== false,
        tipo: c.recompensa.tipo === 'video' ? 'video' : 'foto',
        arquivo: String(c.recompensa.arquivo).slice(0, 200),
        titulo: String(c.recompensa.titulo || '').slice(0, 60),
        mensagem: String(c.recompensa.mensagem || '').slice(0, 200),
      } : (db.campanhas[id]?.recompensa || { ativa: false }),
      encerrada: !!(c.encerrada ?? db.campanhas[id]?.encerrada),
      criadaEm: db.campanhas[id]?.criadaEm || Date.now(),
      atualizadaEm: Date.now(), // é por este carimbo que a junção sabe qual versão vale
    };
    semearDemo(db, db.campanhas[id]);
    await gravar();
    return json(res, 201, { id, campanha: db.campanhas[id], resumo: resumo(db, db.campanhas[id]) });
  }

  // lista as campanhas — para quem administra
  if (p === '/api/campanhas' && req.method === 'GET') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    const lista = Object.values(db.campanhas)
      .sort((a, b) => b.criadaEm - a.criadaEm)
      .map(c => ({ id: c.id, tipo: c.tipo, titulo: c.titulo, criadaEm: c.criadaEm, resumo: resumo(db, c) }));
    return json(res, 200, { campanhas: lista });
  }

  const mApagar = p.match(/^\/api\/campanhas\/([\w-]+)$/);
  if (mApagar && req.method === 'DELETE') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    const id = mApagar[1];
    if (!db.campanhas[id]) return json(res, 404, { erro: 'Campanha não encontrada.' });
    const titulo = db.campanhas[id].titulo;
    delete db.campanhas[id];
    // fica anotado como apagada para não voltar pela cópia de outra instância
    db.apagadas = [...new Set([...(db.apagadas || []), id])];
    db.contribuicoes = db.contribuicoes.filter(c => c.campanhaId !== id);
    if (db.visitas) delete db.visitas[id];
    await gravar();
    console.log(`  [apagada] ${id} · ${titulo}`);
    return json(res, 200, { apagada: true });
  }

  const mCampanha = p.match(/^\/api\/campanhas\/([\w-]+)$/);
  if (mCampanha && req.method === 'GET') {
    const campanha = db.campanhas[mCampanha[1]];
    if (!campanha) return json(res, 404, { erro: 'Campanha não encontrada.' });
    return json(res, 200, { campanha, resumo: resumo(db, campanha) });
  }

  // cria a cobrança Pix do apoio — aberta, é quem apoia que chama
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
      // a chave do prêmio só sai depois de pago, e só para quem está esperando
      // esta cobrança — é ela que abre a foto ou o vídeo depois
      resgate: contrib.status === 'PAGO' ? contrib.resgate : undefined,
      premio: contrib.status === 'PAGO' && campanha ? estadoDoPremio(campanha, contrib) : undefined,
      resumo: campanha ? resumo(db, campanha) : null,
    });
  }

  // webhook da BassPago (evento RECEIVE) — registre esta URL quando estiver no ar
  if (p === '/api/webhooks/bass' && req.method === 'POST') {
    const evento = await corpoDe(req).catch(() => null);
    const d = evento?.data;
    if (d && (evento.type === 'RECEIVE' || d.webhookType === 'RECEIVE') && d.status === 'LIQUIDATED') {
      const contrib = db.contribuicoes.find(x => x.txid === d.txId);
      if (contrib) await confirmarPagamento(contrib, d.endToEndId);
    }
    return json(res, 200, { recebido: true });
  }

  /* ---------------- painel de quem organiza ---------------- */
  if (p === '/api/painel' && req.method === 'GET') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    const campanhas = Object.values(db.campanhas)
      .sort((a, b) => b.criadaEm - a.criadaEm)
      .map(c => ({
        id: c.id, tipo: c.tipo, titulo: c.titulo, criadaEm: c.criadaEm, encerrada: !!c.encerrada,
        meta: c.meta, cotas: c.cotas, preco: c.preco, capa: (c.fotos || [])[0] || '',
        recompensa: c.recompensa && c.recompensa.ativa
          ? { ativa: true, tipo: c.recompensa.tipo, titulo: c.recompensa.titulo }
          : { ativa: false },
        ganhador: c.ganhador || null,
        resumo: resumo(db, c),
        visitas: contarVisitas(db, c.id),
      }));
    const totais = campanhas.reduce((t, c) => ({
      arrecadado: t.arrecadado + c.resumo.arrecadado,
      apoiadores: t.apoiadores + c.resumo.apoiadores,
      visitasHoje: t.visitasHoje + c.visitas.hoje,
    }), { arrecadado: 0, apoiadores: 0, visitasHoje: 0 });
    return json(res, 200, { campanhas, totais, push: { ligado: PUSH_LIGADO, inscricoes: (db.push || []).length } });
  }

  const mDetalhe = p.match(/^\/api\/campanhas\/([\w-]+)\/detalhe$/);
  if (mDetalhe && req.method === 'GET') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    const campanha = db.campanhas[mDetalhe[1]];
    if (!campanha) return json(res, 404, { erro: 'Campanha não encontrada.' });
    const apoios = db.contribuicoes
      .filter(c => c.campanhaId === campanha.id && c.status === 'PAGO')
      .sort((a, b) => b.pagaEm - a.pagaEm)
      .map(c => ({
        txid: c.txid, nome: c.anonimo ? 'Anônimo' : c.nome, msg: c.msg, valor: c.valor, cotas: c.cotas,
        numeros: c.numeros || [], pagaEm: c.pagaEm, contato: c.contato || '',
        resgatadoEm: c.resgatadoEm || null, demo: !!c.demo,
      }));
    const aguardando = db.contribuicoes.filter(c => c.campanhaId === campanha.id && c.status === 'AGUARDANDO').length;
    return json(res, 200, {
      campanha, resumo: resumo(db, campanha), visitas: contarVisitas(db, campanha.id),
      apoios, aguardando, visitasPorDia: (db.visitas || {})[campanha.id] || {},
    });
  }

  const mSortear = p.match(/^\/api\/campanhas\/([\w-]+)\/sortear$/);
  if (mSortear && req.method === 'POST') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    const campanha = db.campanhas[mSortear[1]];
    if (!campanha) return json(res, 404, { erro: 'Campanha não encontrada.' });
    if (campanha.tipo !== 'rifa') return json(res, 400, { erro: 'Só rifa tem sorteio.' });
    const pagas = pagasDe(db, campanha.id).filter(c => (c.numeros || []).length);
    if (!pagas.length) return json(res, 409, { erro: 'Nenhuma cota vendida ainda.' });
    // cada número tem a mesma chance, então o sorteio é entre números, não entre pessoas
    const bolas = [];
    for (const c of pagas) for (const n of c.numeros) bolas.push({ numero: n, contrib: c });
    const premiada = bolas[Math.floor(Math.random() * bolas.length)];
    campanha.ganhador = {
      txid: premiada.contrib.txid,
      numero: premiada.numero,
      nome: premiada.contrib.anonimo ? 'Anônimo' : premiada.contrib.nome,
      contato: premiada.contrib.contato || '',
      quando: Date.now(),
      entreBolas: bolas.length,
    };
    await gravar();
    avisar({
      titulo: 'Sorteio feito · ' + campanha.titulo,
      corpo: `Número ${premiada.numero} — ${campanha.ganhador.nome}, entre ${bolas.length} cotas.`,
      url: '/?painel=' + campanha.id,
      tag: 'sorteio-' + campanha.id,
    });
    return json(res, 200, { ganhador: campanha.ganhador });
  }

  const mEncerrar = p.match(/^\/api\/campanhas\/([\w-]+)\/encerrar$/);
  if (mEncerrar && req.method === 'POST') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    const campanha = db.campanhas[mEncerrar[1]];
    if (!campanha) return json(res, 404, { erro: 'Campanha não encontrada.' });
    const { encerrada } = await corpoDe(req);
    campanha.encerrada = !!encerrada;
    await gravar();
    return json(res, 200, { encerrada: campanha.encerrada });
  }

  /* ---------------- mídia do prêmio ---------------- */
  if (p === '/api/midia' && req.method === 'POST') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    const tipo = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    const extensoes = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
      'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    };
    if (!extensoes[tipo]) return json(res, 415, { erro: 'Mande foto (jpg, png, webp) ou vídeo (mp4, webm, mov).' });
    let bytes;
    try { bytes = await bytesDe(req, LIMITE_MIDIA); }
    catch (e) { return json(res, e.status || 500, { erro: 'O arquivo passou de ' + Math.round(LIMITE_MIDIA / 1e6) + ' MB.' }); }
    if (!bytes.length) return json(res, 400, { erro: 'Arquivo vazio.' });
    const nome = randomUUID() + extensoes[tipo];
    try {
      const url = await guardarArquivo('midia', nome, bytes, tipo);
      return json(res, 201, { url, tipo: tipo.startsWith('video') ? 'video' : 'foto', tamanho: bytes.length });
    } catch (e) {
      console.error('[midia] falha ao guardar:', e.message);
      return json(res, 500, { erro: 'Não consegui guardar o arquivo (' + (e.code || e.message) + ').' });
    }
  }

  /* ---------------- prêmio de quem apoiou ---------------- */
  // quem tem o txid já provou que é dono do pagamento: é com ele que a chave é
  // recuperada quando o aparelho perde a que tinha
  const mChave = p.match(/^\/api\/premio\/([A-Za-z0-9]+)\/chave$/);
  if (mChave && req.method === 'GET') {
    const contrib = db.contribuicoes.find(c => c.txid === mChave[1]);
    if (!contrib || contrib.status !== 'PAGO') return json(res, 404, { erro: 'Apoio não encontrado.' });
    if (!contrib.resgate) { contrib.resgate = chaveDeResgate(contrib.txid); gravar(); }
    return json(res, 200, { chave: chaveDeResgate(contrib.txid) });
  }

  const mPremio = p.match(/^\/api\/premio\/([A-Za-z0-9]+)$/);
  if (mPremio && req.method === 'GET') {
    const contrib = db.contribuicoes.find(c => c.txid === mPremio[1]);
    const chave = url.searchParams.get('k') || '';
    if (!contrib || !chaveConfere(contrib, chave)) return json(res, 404, { erro: 'Prêmio não encontrado.' });
    const campanha = db.campanhas[contrib.campanhaId];
    return json(res, 200, estadoDoPremio(campanha, contrib));
  }

  const mResgatar = p.match(/^\/api\/premio\/([A-Za-z0-9]+)\/resgatar$/);
  if (mResgatar && req.method === 'POST') {
    const contrib = db.contribuicoes.find(c => c.txid === mResgatar[1]);
    const { k } = await corpoDe(req);
    if (!contrib || !chaveConfere(contrib, k)) return json(res, 404, { erro: 'Prêmio não encontrado.' });
    const campanha = db.campanhas[contrib.campanhaId];
    const estado = estadoDoPremio(campanha, contrib);
    if (!estado.liberado) return json(res, 403, estado);
    if (!contrib.resgatadoEm) { contrib.resgatadoEm = Date.now(); await gravar(); }
    return json(res, 200, { ...estadoDoPremio(campanha, contrib), midia: enderecoDaMidia(campanha, contrib) });
  }

  /* ---------------- notificações ---------------- */
  if (p === '/api/push/chave' && req.method === 'GET') {
    return json(res, 200, { ligado: PUSH_LIGADO, chave: env.VAPID_PUBLICA || '' });
  }

  if (p === '/api/push/inscrever' && req.method === 'POST') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    const inscricao = await corpoDe(req);
    if (!inscricao?.endpoint || !inscricao?.keys?.p256dh) return json(res, 400, { erro: 'Inscrição inválida.' });
    db.push = (db.push || []).filter(i => i.endpoint !== inscricao.endpoint);
    db.push.push({ endpoint: inscricao.endpoint, keys: inscricao.keys, criadoEm: Date.now() });
    await gravar();
    await avisar({ titulo: 'Notificações ligadas', corpo: 'É assim que você vai saber de cada apoio que entrar.', url: '/?painel=1', tag: 'boas-vindas' });
    return json(res, 201, { inscritos: db.push.length });
  }

  if (p === '/api/push/sair' && req.method === 'POST') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    const { endpoint } = await corpoDe(req);
    db.push = (db.push || []).filter(i => i.endpoint !== endpoint);
    await gravar();
    return json(res, 200, { inscritos: db.push.length });
  }

  if (p === '/api/push/teste' && req.method === 'POST') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    await avisar({ titulo: 'Teste do Growdy', corpo: 'Se esta chegou, as próximas também chegam.', url: '/?painel=1', tag: 'teste' });
    return json(res, 200, { enviado: (db.push || []).length });
  }

  if (p === '/api/resumo-diario' && req.method === 'POST') {
    if (!ehAdmin(req)) return json(res, 401, { erro: 'Senha de administrador necessária.' });
    return json(res, 200, await resumoDoDia(true));
  }

  /* ---------------- visitas ---------------- */
  if (p === '/api/visitas' && req.method === 'POST') {
    const { campanhaId } = await corpoDe(req);
    const conta = await contarVisita(String(campanhaId || ''), req);
    return json(res, 200, { contado: !!conta });
  }

  return json(res, 404, { erro: 'Rota inexistente.' });
}

/* ---------------- regras do prêmio ---------------- */
function estadoDoPremio(campanha, contrib) {
  const recompensa = campanha?.recompensa;
  if (!recompensa?.ativa || !recompensa.arquivo) {
    return { existe: false, liberado: false, motivo: 'Esta campanha não tem prêmio.' };
  }
  const base = {
    existe: true,
    tipo: recompensa.tipo || 'foto',
    titulo: recompensa.titulo || 'Seu prêmio',
    mensagem: recompensa.mensagem || '',
    campanha: campanha.titulo,
    resgatadoEm: contrib.resgatadoEm || null,
  };
  if (contrib.status !== 'PAGO') return { ...base, liberado: false, motivo: 'O pagamento ainda não caiu.' };
  if (campanha.tipo === 'rifa') {
    if (!campanha.ganhador) {
      return { ...base, liberado: false, motivo: 'O sorteio ainda não foi feito.', aguardandoSorteio: true, seusNumeros: contrib.numeros || [] };
    }
    if (campanha.ganhador.txid !== contrib.txid) {
      return {
        ...base, liberado: false, ganhou: false,
        motivo: `O número sorteado foi ${campanha.ganhador.numero}.`,
        numeroSorteado: campanha.ganhador.numero, seusNumeros: contrib.numeros || [],
      };
    }
    return { ...base, liberado: true, ganhou: true, numeroSorteado: campanha.ganhador.numero };
  }
  return { ...base, liberado: true };
}

const enderecoDaMidia = (campanha, contrib) =>
  campanha.recompensa.arquivo + '?t=' + contrib.txid + '&k=' + contrib.resgate;

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);

    // fotos da campanha: abertas, é a capa que todo mundo vê
    if (url.pathname.startsWith('/fotos/')) {
      const nome = basename(url.pathname);
      const buf = await lerArquivo('fotos', nome);
      if (!buf) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('foto não encontrada'); return; }
      res.writeHead(200, { 'Content-Type': TIPOS[extname(nome)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
      return;
    }

    // mídia do prêmio: fechada. Só abre com o txid e a chave de resgate de quem
    // pagou — e, na rifa, só para quem ganhou
    if (url.pathname.startsWith('/midia/')) {
      const db = await ler();
      const contrib = db.contribuicoes.find(c => c.txid === url.searchParams.get('t'));
      const chave = url.searchParams.get('k') || '';
      const campanha = contrib && db.campanhas[contrib.campanhaId];
      // quem organiza vê o próprio arquivo pela senha; o resto precisa do par
      // txid + chave de resgate, e na rifa ainda precisa ter ganhado
      const liberado = ehAdmin(req) || (contrib && chaveConfere(contrib, chave) &&
        campanha && estadoDoPremio(campanha, contrib).liberado &&
        campanha.recompensa.arquivo === url.pathname);
      if (!liberado) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('este prêmio não é seu'); return; }
      const nome = basename(url.pathname);
      const buf = await lerArquivo('midia', nome);
      if (!buf) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('arquivo não encontrado'); return; }
      const tipo = TIPOS[extname(nome)] || 'application/octet-stream';
      // vídeo precisa de range para o player poder arrastar a barra
      const faixa = req.headers.range;
      if (faixa && tipo.startsWith('video')) {
        const casa = /bytes=(\d*)-(\d*)/.exec(faixa) || [];
        const inicio = casa[1] ? parseInt(casa[1], 10) : 0;
        const fim = casa[2] ? parseInt(casa[2], 10) : buf.length - 1;
        const pedaco = buf.subarray(inicio, fim + 1);
        res.writeHead(206, {
          'Content-Type': tipo,
          'Content-Range': `bytes ${inicio}-${fim}/${buf.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': pedaco.length,
          'Cache-Control': 'private, max-age=600',
        });
        res.end(pedaco);
        return;
      }
      res.writeHead(200, { 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=600' });
      res.end(buf);
      return;
    }

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
    const status = e?.status || 500;
    if (status === 500) console.error('[erro]', e);
    if (!res.headersSent) {
      json(res, status, {
        erro: status === 413 ? 'A imagem é grande demais. Escolha uma foto menor.'
          : status === 400 ? 'O pedido chegou quebrado.'
            : 'Algo quebrou aqui do lado.',
      });
    }
  }
});

await prepararDisco();

servidor.listen(PORTA, () => {
  const ips = Object.values(networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  const onde = descreverArmazem();
  console.log('\n  Growdy no ar');
  console.log(`  aqui       http://localhost:${PORTA}`);
  ips.forEach(ip => console.log(`  no celular http://${ip}:${PORTA}  (mesma rede wi-fi)`));
  console.log(`  dados em   ${onde.tipo === 'supabase' ? 'Supabase, balde ' + onde.balde : onde.pasta}` +
    (onde.persistente ? '' : '  (TEMPORARIO — nada sobrevive ao proximo deploy)'));
  console.log(SENHA ? '  criação    protegida por ADMIN_SENHA' : '  criação    ABERTA — defina ADMIN_SENHA antes de subir para a internet');
  console.log('');
});
