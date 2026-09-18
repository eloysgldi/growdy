// Cliente da BassPago: OAuth client_credentials + mTLS.
// Cash-in (QR Codes API) usa corpo form-encoded e devolve access_token.
// Cash-out (Accounts API) usa corpo JSON e devolve accessToken. Só o cash-in é
// usado hoje; o cash-out fica pronto para o repasse ao dono da campanha.
import { request } from 'node:https';
import { Agent } from 'node:https';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = dirname(fileURLToPath(import.meta.url));
// no Render os certificados chegam como Secret Files em /etc/secrets, caminho absoluto
const caminho = c => (c.startsWith('/') || /^[A-Za-z]:/.test(c) ? c : join(raiz, c));

function carregarEnv() {
  const env = {};
  try {
    const texto = readFileSync(join(raiz, '.env'), 'utf8');
    for (const linha of texto.split(/\r?\n/)) {
      const corte = linha.indexOf('=');
      if (!linha.trim() || linha.trim().startsWith('#') || corte < 0) continue;
      env[linha.slice(0, corte).trim()] = linha.slice(corte + 1).trim();
    }
  } catch { /* sem .env: cai nas variáveis do processo */ }
  return { ...env, ...process.env };
}
export const env = carregarEnv();

function agente(certEnv, keyEnv) {
  return new Agent({
    cert: readFileSync(caminho(env[certEnv])),
    key: readFileSync(caminho(env[keyEnv])),
    keepAlive: true,
  });
}

let agenteCashIn = null;
const pegarAgenteCashIn = () => (agenteCashIn ||= agente('BASS_CERT_CASHIN', 'BASS_KEY_CASHIN'));

export function pedir({ base, metodo = 'GET', caminho, corpo, headers = {}, agent }) {
  const url = new URL(caminho, base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: metodo,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers,
        agent,
        timeout: 30000,
      },
      res => {
        let dados = '';
        res.setEncoding('utf8');
        res.on('data', p => (dados += p));
        res.on('end', () => {
          let json = null;
          try { json = dados ? JSON.parse(dados) : null; } catch { /* resposta não-JSON */ }
          resolve({ status: res.statusCode, json, texto: dados });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('tempo esgotado falando com a BassPago')));
    req.on('error', reject);
    if (corpo) req.write(corpo);
    req.end();
  });
}

let fichaCashIn = { token: null, vence: 0 };

export async function tokenCashIn() {
  if (fichaCashIn.token && Date.now() < fichaCashIn.vence) return fichaCashIn.token;
  const corpo = new URLSearchParams({
    client_id: env.BASS_CLIENT_ID,
    client_secret: env.BASS_CLIENT_SECRET,
    grant_type: 'client_credentials',
  }).toString();
  const r = await pedir({
    base: env.BASS_PIX_BASE,
    metodo: 'POST',
    caminho: '/oauth/token',
    corpo,
    agent: pegarAgenteCashIn(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(corpo),
    },
  });
  // a BassPago responde 201 neste endpoint, não 200
  if ((r.status !== 200 && r.status !== 201) || !r.json?.access_token) {
    const detalhe = r.json?.detail || r.json?.error_description || r.texto?.slice(0, 200) || '';
    throw Object.assign(new Error('BassPago recusou as credenciais (' + r.status + '): ' + detalhe), { status: 502, bass: r.status });
  }
  // guarda com folga de 60s antes do vencimento informado
  fichaCashIn = { token: r.json.access_token, vence: Date.now() + Math.max(30, (r.json.expires_in || 300) - 60) * 1000 };
  return fichaCashIn.token;
}

// txid do padrão Bacen: 26 a 35 caracteres alfanuméricos
export function novoTxid(prefixo = 'GRW') {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = prefixo.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  while (s.length < 30) s += abc[Math.floor(Math.random() * abc.length)];
  return s.slice(0, 30);
}

export async function criarCobranca({ txid, valor, solicitacao, infoAdicionais = [] }) {
  const token = await tokenCashIn();
  const corpo = JSON.stringify({
    calendario: { expiracao: Number(env.PIX_EXPIRACAO || 1800) },
    valor: { original: valor.toFixed(2), modalidadeAlteracao: 0 },
    chave: env.BASS_CHAVE_PIX,
    solicitacaoPagador: (solicitacao || '').slice(0, 140),
    ...(infoAdicionais.length ? { infoAdicionais } : {}),
  });
  const r = await pedir({
    base: env.BASS_PIX_BASE,
    metodo: 'PUT',
    caminho: '/cob/' + txid,
    corpo,
    agent: pegarAgenteCashIn(),
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(corpo),
      'x-idempotency-key': txid,
    },
  });
  if (r.status !== 200 && r.status !== 201) {
    const detalhe = r.json?.detail || r.json?.title || r.texto?.slice(0, 200) || '';
    throw Object.assign(new Error('BassPago não criou a cobrança (' + r.status + '): ' + detalhe), { status: 502, bass: r.status });
  }
  return r.json;
}

export async function consultarCobranca(txid) {
  const token = await tokenCashIn();
  const r = await pedir({
    base: env.BASS_PIX_BASE,
    caminho: '/cob/' + txid,
    agent: pegarAgenteCashIn(),
    headers: { Authorization: 'Bearer ' + token },
  });
  if (r.status !== 200) {
    throw Object.assign(new Error('BassPago não devolveu a cobrança (' + r.status + ')'), { status: 502, bass: r.status });
  }
  return r.json;
}
