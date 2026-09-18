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
let PASTA_FOTOS = join(PASTA, 'fotos');
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

export async function gravarDados(dados) {
  const texto = JSON.stringify(dados, null, 2);
  if (naNuvem) return nuvemGravar('dados.json', Buffer.from(texto, 'utf8'), 'application/json');
  await mkdir(PASTA, { recursive: true });
  await writeFile(join(PASTA, 'dados.json'), texto, 'utf8');
}

export async function guardarFoto(nome, bytes, tipo) {
  if (naNuvem) {
    await nuvemGravar('fotos/' + nome, bytes, tipo);
    return '/fotos/' + nome;
  }
  await mkdir(PASTA_FOTOS, { recursive: true });
  await writeFile(join(PASTA_FOTOS, nome), bytes);
  return '/fotos/' + nome;
}

// guarda as ultimas fotos em memoria para nao buscar na nuvem a cada visita
const lembradas = new Map();
const LIMITE_LEMBRADAS = 24;

export async function lerFoto(nome) {
  if (lembradas.has(nome)) return lembradas.get(nome);
  let bytes = null;
  if (naNuvem) bytes = await nuvemBaixar('fotos/' + nome);
  else bytes = await readFile(join(PASTA_FOTOS, nome)).catch(() => null);
  if (bytes) {
    if (lembradas.size >= LIMITE_LEMBRADAS) lembradas.delete(lembradas.keys().next().value);
    lembradas.set(nome, bytes);
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
