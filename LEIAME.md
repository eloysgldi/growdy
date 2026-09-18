# Growdy — Vaquinha e Rifas

Página de campanha com Pix de verdade, pela BassPago (cash-in via QR Code dinâmico).
Quem cria campanha precisa de senha. Quem recebe o link só abre e paga — sem cadastro.

## Como roda aqui

```bash
npm start            # sobe em http://localhost:4180
npm run semear       # popula as duas campanhas de demonstração
npm run teste:pix    # teste de fumaça: token + cobrança de R$ 1,00 + consulta
```

Links da demonstração:

- `http://localhost:4180/?c=demo-vaquinha` — 88% da meta, 80 apoiadores
- `http://localhost:4180/?c=demo-rifa` — 182 de 200 cotas vendidas

## Quem pode o quê

| Ação | Precisa de |
|---|---|
| Abrir o link da campanha, doar, comprar cota | nada |
| Criar campanha, subir foto | senha (`ADMIN_SENHA`) |

**Como entrar para criar:** abra o site com `?admin=1` no fim do endereço —
`https://seu-app.onrender.com/?admin=1`. Ele pede a senha uma vez, guarda neste
aparelho e some com o `?admin=1` da barra. Depois disso é só abrir o site normal.
Quem chega pelo link de uma campanha vê só a campanha: sem botão de voltar, sem
assistente, e a raiz do site mostra um aviso de que cada campanha tem o seu link.

A senha fica guardada no navegador de quem administra (`localStorage`), e é enviada
no cabeçalho `x-admin`. Sem ela, `POST /api/campanhas` e `POST /api/fotos` devolvem 401.
Se `ADMIN_SENHA` ficar vazia, o modo é aberto — serve para uso local, nunca na internet.

## Fotos

Ao escolher a foto, o navegador reduz para 1000px, manda em base64 para `POST /api/fotos`,
e o servidor grava o arquivo em `DADOS_DIR/fotos/<uuid>.jpg`. A campanha guarda só a URL
(`/fotos/<uuid>.jpg`). Limite de 4 MB por imagem, até 6 fotos por campanha, e a primeira é a capa.

## Subir no Render

1. **Repositório**: suba esta pasta. O `.gitignore` já deixa de fora `.env`, `certs/` e `dados/`.
2. **Serviço**: Web Service, runtime Node, build `npm install`, start `node app.mjs`.
   O `render.yaml` já traz tudo isso pronto se você usar Blueprint.
3. **Disco persistente** (essencial): monte um disco em `/var/data` e ponha `DADOS_DIR=/var/data`.
   Sem disco, o Render apaga o sistema de arquivos a cada deploy — campanhas, apoios e fotos somem.
   Disco exige plano pago; no free, trate tudo como descartável.
4. **Certificados** em *Secret Files* (Environment > Secret Files), com estes nomes:
   - `cashin.crt` e `cashin.key` — conteúdo de `certs/cashin/BASSPAGO_41.crt` e `.key`
   - `cashout.crt` e `cashout.key` — os de `certs/cashout/`
   O Render coloca os Secret Files em `/etc/secrets/`, que é o caminho já configurado.
5. **Variáveis de ambiente**:

   | Chave | Valor |
   |---|---|
   | `ADMIN_SENHA` | a sua senha |
   | `BASS_CLIENT_ID` | client id da BassPago |
   | `BASS_CLIENT_SECRET` | client secret |
   | `BASS_CHAVE_PIX` | chave Pix que recebe |
   | `DADOS_DIR` | `/var/data` |
   | `DEMO` | `1` no protótipo, `0` para valer |
   | `PIX_EXPIRACAO` | `1800` |

   `PORT` o Render define sozinho — o app usa o que vier.
6. **Confira**: abra `https://seu-app.onrender.com/api/saude`. Deve responder
   `{"ok":true,"bass":"autenticado"}`. Se vier `ok:false`, o problema é credencial ou certificado.
7. **Webhook** (opcional, mas melhora a confirmação): registre
   `https://seu-app.onrender.com/api/webhooks/bass` na BassPago para o evento `RECEIVE`.
   Sem ele a página ainda confirma sozinha, porque consulta `GET /cob/{txid}` a cada 3 segundos.

## Painel de quem organiza

Abrindo o site com a senha (`/?admin=1`), a casa passa a ser o painel:
arrecadado, apoiadores e visitas de hoje somados; um cartão por campanha com
barra de progresso, quantas pessoas viram (hoje e no total) e os botões de
detalhes, ver página e copiar link.

Em **Detalhes**: a lista de quem apoiou (com recado, cotas e números), quantos Pix
estão aguardando, o sorteio da rifa e o botão de encerrar ou reabrir.

**Sorteio.** Na rifa, `Sortear o ganhador agora` escolhe **entre números vendidos**,
não entre pessoas — quem comprou 10 cotas tem 10 vezes mais chance, como numa
rifa de papel. O resultado fica guardado com a hora e quantas cotas concorriam.

## Notificações no celular

O app é instalável (manifest + service worker), e é assim que o push funciona
no iPhone: **Compartilhar > Adicionar à Tela de Início**, e abrir por esse ícone.
No Android e no computador, funciona direto pelo navegador.

No painel, o sino liga as notificações naquele aparelho. A partir daí chega:

- **cada apoio que cair**, com valor, quem foi e como ficou o andamento
- **o resultado do sorteio**, com número e nome
- **o resumo do dia**, à noite: quantas pessoas viram, quantas apoiaram e quanto entrou

O resumo é disparado pelo mesmo ping do cron-job, depois das 20h, uma vez por dia.
Com o sino ligado, tocar no sino de novo manda uma notificação de teste.

As chaves VAPID vão no `.env` (`VAPID_PUBLICA`, `VAPID_PRIVADA`, `VAPID_CONTATO`).
Para gerar outras:

```bash
node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
```

## Prêmio em foto ou vídeo

No passo 3 da criação dá para anexar uma foto ou um vídeo (até 25 MB) que fica
guardado no Supabase junto com o resto.

| Tipo de campanha | Quem recebe |
|---|---|
| Vaquinha | todo mundo que apoiou, num botão logo depois do Pix |
| Rifa | só o ganhador, e só depois do sorteio |

O arquivo **não é público**. Ele só abre em `/midia/<nome>?t=<txid>&k=<chave>`, com o
par que o servidor entregou a quem pagou — e, na rifa, só se o número bater. Sem
isso, o servidor devolve 403, mesmo com o endereço exato na mão. Quem organiza vê
o próprio arquivo pela senha de administrador.

A chave fica guardada no aparelho de quem apoiou, então dá para fechar a página e
voltar depois pelo link da campanha: aparece um botão *Ver o meu prêmio*.

## Visitas

Cada abertura da página pública conta uma visita, e o par visitante+dia é
reduzido a um hash em memória para a mesma pessoa não contar duas vezes no
mesmo dia. Quem organiza não conta como visita na própria campanha. Os números
por dia ficam guardados; a lista de quem já foi contado se perde no reinício.

## Como o pagamento funciona

1. A pessoa escolhe o valor (vaquinha) ou a quantidade de cotas (rifa, com as promoções aplicadas).
2. `POST /api/contribuicoes` cria a cobrança na BassPago (`PUT /cob/{txid}`) e devolve o `pixCopiaECola`.
3. A página mostra o QR Code e o código, com contagem regressiva de 30 minutos.
4. A cada 3 segundos o servidor consulta a cobrança; quando liquida, o apoio entra na lista,
   a barra sobe e — na rifa — os números são sorteados entre os que ainda estão livres.

Nada é marcado como pago sem a BassPago confirmar.

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | a página inteira (a fonte fica nos pedaços que geraram este arquivo) |
| `app.mjs` | servidor: API, senha de administrador, upload de foto, webhook |
| `bass.mjs` | cliente da BassPago (OAuth + mTLS, cobrança e consulta) |
| `semear.mjs` | popula as campanhas de demonstração |
| `teste-pix.mjs` | teste de fumaça da integração |
| `server.mjs` | versão anterior do servidor, sem senha e sem upload — pode apagar |
