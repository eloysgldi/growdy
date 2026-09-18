// Teste de fumaça da integração BassPago: pega token, cria uma cobrança de R$ 1,00,
// mostra o começo do copia-e-cola e consulta o status. O QR só é gerado — ninguém
// paga nada a não ser que você leia o código com o app do banco.
// Rode com: node teste-pix.mjs        (ou: node teste-pix.mjs 2.50 para outro valor)
import { tokenCashIn, criarCobranca, consultarCobranca, novoTxid, env } from './bass.mjs';

const valor = Number(process.argv[2] || 1);

console.log('\n  base       ', env.BASS_PIX_BASE);
console.log('  chave pix  ', env.BASS_CHAVE_PIX);
console.log('  valor      ', 'R$ ' + valor.toFixed(2), '\n');

try {
  const token = await tokenCashIn();
  console.log('  [1/3] token obtido        ok (' + token.length + ' caracteres)');

  const txid = novoTxid('GRWTESTE');
  const cob = await criarCobranca({ txid, valor, solicitacao: 'Teste de integração Growdy' });
  console.log('  [2/3] cobrança criada     ok');
  console.log('        txid                ' + txid);
  console.log('        status              ' + cob.status);
  console.log('        copia e cola        ' + String(cob.pixCopiaECola || '(não veio)').slice(0, 64) + '…');
  console.log('        location            ' + (cob.location || '—'));

  const conferida = await consultarCobranca(txid);
  console.log('  [3/3] consulta            ok · status ' + conferida.status + ' · valor R$ ' + conferida.valor?.original);

  console.log('\n  Integração de cash-in funcionando fim a fim.');
  console.log('  A cobrança expira sozinha em ' + (env.PIX_EXPIRACAO || 1800) + 's se ninguém pagar.\n');
} catch (e) {
  console.error('\n  FALHOU:', e.message);
  console.error('  Confira .env (client id, secret e chave pix) e os certificados em certs/cashin.\n');
  process.exitCode = 1;
}
