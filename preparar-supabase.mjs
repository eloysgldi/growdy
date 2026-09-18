// Prepara o Supabase para o Growdy: cria o balde privado, se ainda nao existir,
// e faz um teste de ponta a ponta (grava, le, apaga). Nao mostra a chave.
// Rode com: node preparar-supabase.mjs
import { env } from './bass.mjs';

const ENDERECO = (env.SUPABASE_URL || '').replace(/\/+$/, '');
const CHAVE = env.SUPABASE_CHAVE || '';
const BALDE = env.SUPABASE_BALDE || 'growdy';

if (!ENDERECO || !CHAVE) {
  console.error('\n  Faltou configurar. Abra o .env e preencha:');
  console.error('    SUPABASE_URL   ' + (ENDERECO || '(vazio)'));
  console.error('    SUPABASE_CHAVE ' + (CHAVE ? '(preenchida)' : '(vazio) <- a service_role, em Project Settings > API'));
  console.error('');
  process.exit(1);
}

const cabecalhos = extras => ({ Authorization: 'Bearer ' + CHAVE, apikey: CHAVE, ...extras });
const passo = (texto, ok, detalhe) =>
  console.log('  ' + (ok ? '[ok]  ' : '[erro]') + ' ' + texto + (detalhe ? ' — ' + detalhe : ''));

console.log('\n  Supabase: ' + ENDERECO);
console.log('  Balde:    ' + BALDE + '\n');

try {
  // 1. a chave funciona?
  const lista = await fetch(`${ENDERECO}/storage/v1/bucket`, { headers: cabecalhos() });
  if (lista.status === 401 || lista.status === 403) {
    passo('a chave foi recusada', false, 'confira se copiou a service_role, e nao a anon');
    process.exit(1);
  }
  if (!lista.ok) {
    passo('o Supabase respondeu ' + lista.status, false, (await lista.text()).slice(0, 160));
    process.exit(1);
  }
  const baldes = await lista.json();
  passo('chave aceita', true, baldes.length + ' balde(s) na conta');

  // 2. o balde existe? se nao, cria privado
  if (baldes.some(b => b.name === BALDE)) {
    const atual = baldes.find(b => b.name === BALDE);
    passo('balde "' + BALDE + '" ja existe', true, atual.public ? 'ATENCAO: esta publico' : 'privado, como deve ser');
    if (atual.public) {
      const fecha = await fetch(`${ENDERECO}/storage/v1/bucket/${BALDE}`, {
        method: 'PUT',
        headers: cabecalhos({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ public: false }),
      });
      passo('deixando o balde privado', fecha.ok, fecha.ok ? '' : 'faca isso no painel, em Storage');
    }
  } else {
    const cria = await fetch(`${ENDERECO}/storage/v1/bucket`, {
      method: 'POST',
      headers: cabecalhos({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: BALDE, id: BALDE, public: false }),
    });
    if (!cria.ok) {
      passo('nao consegui criar o balde', false, (await cria.text()).slice(0, 160));
      process.exit(1);
    }
    passo('balde "' + BALDE + '" criado, privado', true);
  }

  // 3. grava, le e apaga um arquivo de teste
  const alvo = 'teste-do-growdy.txt';
  const conteudo = 'growdy ' + new Date().toISOString();
  const grava = await fetch(`${ENDERECO}/storage/v1/object/${BALDE}/${alvo}`, {
    method: 'POST',
    headers: cabecalhos({ 'Content-Type': 'text/plain', 'x-upsert': 'true' }),
    body: conteudo,
  });
  passo('gravacao', grava.ok, grava.ok ? '' : (await grava.text()).slice(0, 160));
  if (!grava.ok) process.exit(1);

  const le = await fetch(`${ENDERECO}/storage/v1/object/${BALDE}/${alvo}`, { headers: cabecalhos() });
  const voltou = le.ok ? await le.text() : '';
  passo('leitura', le.ok && voltou === conteudo, le.ok ? '' : 'status ' + le.status);

  const apaga = await fetch(`${ENDERECO}/storage/v1/object/${BALDE}/${alvo}`, { method: 'DELETE', headers: cabecalhos() });
  passo('limpeza do teste', apaga.ok);

  console.log('\n  Tudo certo. Agora ponha as mesmas tres variaveis no Render:');
  console.log('    SUPABASE_URL    ' + ENDERECO);
  console.log('    SUPABASE_CHAVE  (a mesma que esta no seu .env)');
  console.log('    SUPABASE_BALDE  ' + BALDE);
  console.log('\n  Depois confira em /api/saude se aparece "tipo":"supabase".\n');
} catch (e) {
  passo('falhou no meio do caminho', false, e.message);
  process.exit(1);
}
