// Onde ficam o dados.json e as fotos.
//
// Dois modos, escolhidos sozinho:
//   nuvem  — se SUPABASE_URL e SUPABASE_CHAVE existirem. Serve para o Render
//            no plano gratuito, que nao tem disco: o que for gravado sobrevive
//            a deploy, reinicio e hibernacao.
//   disco  — o comportamento de sempre, em DADOS_DIR. Usado quando nao ha
//            Supabase configurado (maquina local, ou Render com disco pago).
//
// O balde do Supabase deve ser PRIVADO: as fotos passam por este servidor, em
// /fotos/<nome>, para ninguem alcancar o dados.json pela URL publica.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './bass.mjs';

const raiz = dirname(fileURLToPath(import.meta.url));

const ENDERECO = (env.SUPABASE_URL || '').replace(/\/+$/, '');
const CHAVE = env.SUPABASE_CHAVE || '';
const BALDE = env.SUPABASE_BALDE || 'growdy';
export const naNuvem = !!(ENDERECO && CHAVE);

const absoluto = c => c.startsWith('/') || /^[A-Za-z]:/.test(c);
let PASTA = env.DADOS_DIR ? (absoluto(env.DADOS_DIR) ? env.DADOS_DIR : join(raiz, env.DADOS_DIR)) : join(raiz, 'dados');
let PASTA_FOTOS = join(PASTA, 'fotos'); // usada no teste de escrita da subida
let discoOk = true;
let motivoDisco = '';

/* ---------------- Supabase Storage, na unha com fetch ---------------- */
const urlObjeto = caminho => `${ENDERECO}/storage/v1/object/${BALDE}/${caminho}`;
const cabecalhos = extras => ({
  Authorization: 'Bearer ' + CHAVE,
  apikey: CHAVE,
  ...extras,
});

async function nuvemBaixar(caminho) {
  const r = await fetch(urlObjeto(caminho), { headers: cabecalhos() });
  if (r.status === 404 || r.status === 400) return null; // ainda nao existe
  if (!r.ok) throw new Error(`Supabase recusou a leitura de ${caminho} (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

async function nuvemGravar(caminho, bytes, tipo) {
  const r = await fetch(urlObjeto(caminho), {
    method: 'POST',
    headers: cabecalhos({ 'Content-Type': tipo, 'x-upsert': 'true', 'cache-control': '3600' }),
    body: bytes,
  });
  if (!r.ok) {
    const detalhe = await r.text().catch(() => '');
    throw new Error(`Supabase recusou a gravacao de ${caminho} (${r.status}) ${detalhe.slice(0, 160)}`);
  }
}

/* ---------------- disco ---------------- */
export async function prepararDisco() {
  if (naNuvem) {
    // mesmo na nuvem, testa se o Supabase responde antes de prometer que guarda
    try {
      await nuvemBaixar('dados.json');
      return;
    } catch (e) {
      motivoDisco = 'Supabase nao respondeu: ' + e.message;
      discoOk = false;
      return;
    }
  }
  try {
    await mkdir(PASTA_FOTOS, { recursive: true });
    await writeFile(join(PASTA, '.escrita'), 'ok');
  } catch (e) {
    const alternativa = join(raiz, 'dados');
    discoOk = false;
    motivoDisco = `${PASTA} recusou escrita (${e.code || e.message})`;
    console.error('\n  [ATENCAO] nao consigo gravar em ' + PASTA + ' (' + (e.code || e.message) + ')');
    console.error('  Sem disco e sem Supabase, o que for gravado some no proximo deploy.');
    console.error('  Gratis: crie um balde no Supabase e defina SUPABASE_URL e SUPABASE_CHAVE.');
    console.error('  Pago:   Render > Disks > Add Disk, caminho /var/data.\n');
    PASTA = alternativa;
    PASTA_FOTOS = join(PASTA, 'fotos');
    try { await mkdir(PASTA_FOTOS, { recursive: true }); } catch (e2) { /* segue em memoria */ }
  }
}

/* ---------------- o que o resto do app usa ---------------- */
export async function lerDados() {
  const vazio = { campanhas: {}, contribuicoes: [] };
  try {
    if (naNuvem) {
      const buf = await nuvemBaixar('dados.json');
      return buf ? JSON.parse(buf.toString('utf8')) : vazio;
    }
    return JSON.parse(await readFile(join(PASTA, 'dados.json'), 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error('[armazem] leitura falhou:', e.message);
    return vazio;
  }
}

// Durante um deploy o Render mantém a instância velha viva enquanto a nova sobe.
// As duas têm sua própria cópia do dados.json na memória; se cada uma gravar o
// arquivo inteiro, a última apaga o que a outra acabou de escrever — foi assim
// que um pagamento confirmado perdeu a chave do prêmio. Então nunca gravamos por
// cima: lemos o que está lá, juntamos, e só então gravamos.
function juntar(remoto, local) {
  const junto = { campanhas: {}, contribuicoes: [], visitas: {}, push: [], avisos: {} };

  // campanhas: fica a versão mais recente de cada id
  for (const fonte of [remoto, local]) {
    for (const [id, c] of Object.entries(fonte.campanhas || {})) {
      const atual = junto.campanhas[id];
      if (!atual || (c.atualizadaEm || c.criadaEm || 0) >= (atual.atualizadaEm || atual.criadaEm || 0)) {
        junto.campanhas[id] = c;
      }
    }
  }
  // uma campanha apagada de propósito não pode voltar pela cópia velha
  const apagadas = new Set([...(local.apagadas || []), ...(remoto.apagadas || [])]);
  junto.apagadas = [...apagadas];
  for (const id of apagadas) delete junto.campanhas[id];

  // contribuições: união por txid, e pago sempre vence aguardando
  const porTxid = new Map();
  for (const fonte of [remoto, local]) {
    for (const c of fonte.contribuicoes || []) {
      const atual = porTxid.get(c.txid);
      if (!atual) { porTxid.set(c.txid, c); continue; }
      const valeMais = (x) => (x.status === 'PAGO' ? 2 : x.status === 'AGUARDANDO' ? 1 : 0);
      if (valeMais(c) > valeMais(atual) || (valeMais(c) === valeMais(atual) && (c.pagaEm || c.criadaEm || 0) >= (atual.pagaEm || atual.criadaEm || 0))) {
        porTxid.set(c.txid, { ...atual, ...c });
      }
    }
  }
  junto.contribuicoes = [...porTxid.values()].filter(c => !apagadas.has(c.campanhaId));

  // visitas: por campanha e por dia, fica o maior contador
  for (const fonte of [remoto, local]) {
    for (const [id, dias] of Object.entries(fonte.visitas || {})) {
      if (apagadas.has(id)) continue;
      junto.visitas[id] = junto.visitas[id] || {};
      for (const [dia, n] of Object.entries(dias)) {
        const atual = junto.visitas[id][dia] || { vistas: 0, pessoas: 0 };
        junto.visitas[id][dia] = {
          vistas: Math.max(atual.vistas || 0, n.vistas || 0),
          pessoas: Math.max(atual.pessoas || 0, n.pessoas || 0),
        };
      }
    }
  }

  // inscrições de push: união por endpoint
  const porEndpoint = new Map();
  for (const fonte of [remoto, local]) for (const i of fonte.push || []) porEndpoint.set(i.endpoint, i);
  junto.push = [...porEndpoint.values()];

  junto.avisos = { ...(remoto.avisos || {}), ...(local.avisos || {}) };
  return junto;
}

async function gravarCru(dados) {
  const texto = JSON.stringify(dados, null, 2);
  if (naNuvem) return nuvemGravar('dados.json', Buffer.from(texto, 'utf8'), 'application/json');
  await mkdir(PASTA, { recursive: true });
  await writeFile(join(PASTA, 'dados.json'), texto, 'utf8');
}

export async function gravarDados(dados) {
  let remoto = null;
  try { remoto = await lerDados(); } catch (e) { remoto = null; }
  const junto = remoto ? juntar(remoto, dados) : dados;
  await gravarCru(junto);
  return junto;
}

// pasta e 'fotos' (capa da campanha) ou 'midia' (premio em foto ou video)
export async function guardarArquivo(pasta, nome, bytes, tipo) {
  if (naNuvem) {
    await nuvemGravar(pasta + '/' + nome, bytes, tipo);
    return '/' + pasta + '/' + nome;
  }
  const destino = join(PASTA, pasta);
  await mkdir(destino, { recursive: true });
  await writeFile(join(destino, nome), bytes);
  return '/' + pasta + '/' + nome;
}

// guarda os ultimos arquivos pequenos em memoria para nao buscar na nuvem a cada
// visita; video fica de fora porque nao vale o espaco
const lembrados = new Map();
const LIMITE_LEMBRADOS = 24;
const CABE_NA_MEMORIA = 2.5e6;

export async function lerArquivo(pasta, nome) {
  const chave = pasta + '/' + nome;
  if (lembrados.has(chave)) return lembrados.get(chave);
  let bytes = null;
  if (naNuvem) bytes = await nuvemBaixar(chave);
  else bytes = await readFile(join(PASTA, pasta, nome)).catch(() => null);
  if (bytes && bytes.length <= CABE_NA_MEMORIA) {
    if (lembrados.size >= LIMITE_LEMBRADOS) lembrados.delete(lembrados.keys().next().value);
    lembrados.set(chave, bytes);
  }
  return bytes;
}

// projeto gratuito do Supabase hiberna depois de dias parado; o ping do cron
// passa por aqui de hora em hora para o balde continuar acordado
let ultimoToque = 0;
export async function tocarArmazem() {
  if (!naNuvem) return false;
  if (Date.now() - ultimoToque < 55 * 60 * 1000) return false;
  ultimoToque = Date.now();
  try { await nuvemBaixar('dados.json'); return true; }
  catch (e) { console.error('[armazem] toque falhou:', e.message); return false; }
}

export function descreverArmazem() {
  if (naNuvem) {
    return {
      tipo: 'supabase',
      balde: BALDE,
      persistente: discoOk,
      motivo: discoOk ? undefined : motivoDisco,
    };
  }
  return {
    tipo: 'disco',
    pasta: PASTA,
    persistente: discoOk,
    motivo: discoOk ? undefined : motivoDisco,
  };
}
