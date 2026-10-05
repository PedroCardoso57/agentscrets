# agentscrets

Escritório 3D de agentes de IA. Cada agente (motor) tem a sua mesa e um bonequinho que faz a sua função: digita, lê documentos, fala ao telefone, desenha, analisa gráficos ou escreve no quadro branco. **Você também está lá**: o seu bonequinho de chefe fica na mesa da frente e é por ele que você dá ordens à equipe — ele levanta, vai até a mesa do agente, fala a ordem, e o servidor entrega ao seu motor de verdade. A resposta do motor volta para o escritório.

![Escritório 3D](docs/escritorio.png)

## Rodando

Precisa só do Node 18+ (sem `npm install`; o Three.js já vem em `vendor/`).

```bash
node servidor.js          # abre em http://localhost:8787
```

Sem nenhum motor conectado, o escritório roda numa **simulação** (modo demo) para você ver tudo funcionando. Para simular motores "de verdade" mandando status via HTTP:

```bash
node exemplos/simular-motores.js
```

Controles: arraste para girar, role para dar zoom, clique num agente no painel para focar nele, `Esc` para ver o escritório inteiro.

## O que cada bonequinho faz

| Estado | Comportamento |
|---|---|
| `ocioso` | Encostado na cadeira, olhando em volta e se espreguiçando; tela em descanso |
| `trabalhando` | Faz a **atividade** dele (tabela abaixo); luz da mesa pulsa em verde |
| `aguardando` | Mão no queixo, batucando a mesa |
| `concluido` | Comemora de braços para cima e depois relaxa com as mãos atrás da cabeça |
| `erro` | Mãos no rosto, balançando a cabeça; tela e luz piscam em vermelho |

| Atividade | Quando trabalha… |
|---|---|
| `digitar` | Digita no teclado, com código/texto aparecendo no monitor |
| `ler` | Segura e lê um documento, virando páginas |
| `telefone` | Fala ao telefone; o monitor mostra a fila de clientes |
| `desenhar` | Desenha na mesa digitalizadora; o monitor mostra o desenho |
| `analisar` | Mexe no mouse diante de gráficos e às vezes para para pensar |
| `quadro` | Levanta, vai até o quadro branco e escreve o plano com post-its |

## Dando ordens (você é o chefe)

Use a barra de baixo da tela:

1. Escolha para quem é a ordem (um agente ou **todos**). Clicar num agente no painel ou na cena já seleciona ele. Também dá para começar a ordem com `@redator ...`.
2. Escreva e aperte **Enviar**.
3. O seu bonequinho levanta, vai até a mesa do agente (ou para a frente da equipe, se for para todos), fala a ordem e volta. O agente vira na cadeira para ouvir.
4. A ordem aparece em **Ordens** no painel, com o andamento: *aguardando motor* → *entregue ao motor* → *respondida*. A resposta do motor também aparece no balão do agente.

Sem o servidor rodando (ou no modo demo), os agentes simulados cumprem a ordem e respondem, marcados como *simulação*. Com `node servidor.js`, a ordem vai de verdade para os seus motores.

## Configurando a equipe

Edite `src/agentes.js`. Cada agente tem:

```js
{ id: 'redator', nome: 'Redator', funcao: 'Escreve conteúdos', atividade: 'digitar', cor: '#3fb27f', cabelo: '#a0522d', pele: '#ffdbac' }
```

As mesas são distribuídas sozinhas (8 por bloco); a sala cresce conforme a equipe aumenta.

O seu bonequinho é o `CHEFE`, no mesmo arquivo: troque `nome` (aparece como "★ Você"), cores, cabelo e pele.

## Conectando os seus motores

Todos os caminhos usam a mesma mensagem:

```json
{ "id": "redator", "status": "trabalhando", "tarefa": "Escrevendo legenda do post" }
```

`status`: `ocioso` · `trabalhando` · `aguardando` · `concluido` · `erro`. `tarefa` aparece no balão sobre o bonequinho.

### 1. HTTP (recomendado)

Com `node servidor.js` rodando, qualquer motor, em qualquer linguagem, faz um POST:

```bash
curl -X POST http://localhost:8787/api/status \
  -H 'Content-Type: application/json' \
  -d '{"id":"redator","status":"trabalhando","tarefa":"Escrevendo legenda"}'
```

```python
import requests
requests.post("http://localhost:8787/api/status",
              json={"id": "analista", "status": "concluido", "tarefa": "Relatório pronto"})
```

Também aceita uma lista de status de uma vez. Um `id` que não existe cria uma **mesa nova** — mande junto `nome`, `funcao`, `atividade` e `cor` se quiser personalizar.

O navegador recebe tudo em tempo real (Server-Sent Events em `/api/eventos`); `GET /api/estado` devolve o último status de cada agente.

### Recebendo as ordens do chefe no seu motor

Escolha um dos dois jeitos:

**a) Consultar (mais simples, funciona atrás de qualquer firewall).** O motor pergunta a cada poucos segundos se há ordens para ele, e depois responde:

```bash
# ordens novas para o redator (cada ordem só é entregue uma vez)
curl http://localhost:8787/api/ordens/pendentes?agente=redator
# → [{"id":"93abe7c2","para":"redator","texto":"Escreva 3 legendas","criadaEm":"..."}]

# resposta (o "status" opcional também atualiza o bonequinho)
curl -X POST http://localhost:8787/api/ordens/93abe7c2/resposta \
  -H 'Content-Type: application/json' \
  -d '{"agente":"redator","texto":"Legendas prontas: ...","status":"concluido"}'
```

Ordens para **todos** são entregues uma vez a cada agente que consultar. Veja os exemplos prontos: `exemplos/simular-motores.js` (Node) e `exemplos/motor_exemplo.py` (Python, sem dependências — `python exemplos/motor_exemplo.py redator`).

**b) Webhook (o escritório chama o seu motor).** Copie `motores.exemplo.json` para `motores.json` e coloque a URL de cada agente (serve para n8n, Make, uma API sua etc.):

```json
{ "redator": { "webhook": "http://localhost:5000/ordem" } }
```

Cada ordem vira um `POST` com `{"ordem": {"id", "para", "texto", "criadaEm"}, "agente": "redator"}`. Se o motor responder na hora com `{"resposta": "..."}`, ela já aparece no escritório; se demorar, responda depois pela rota `/api/ordens/<id>/resposta`. O `motores.json` fica fora do git.

### 2. WebSocket próprio

Abra `index.html?ws=ws://seu-servidor:porta` e envie as mensagens JSON pelo socket. As ordens do chefe saem pelo mesmo socket como `{"tipo":"ordem","ordem":{...}}`; para mostrar a resposta, mande de volta `{"tipo":"ordem","ordem":{...mesma ordem com "respostas":[{"agente","texto"}]}}`.

### 3. Na mesma página ou num iframe

```js
window.Escritorio.atualizar('designer', { status: 'trabalhando', tarefa: 'Criando carrossel' });
window.Escritorio.adicionarAgente({ id: 'financeiro', nome: 'Financeiro', atividade: 'analisar' });
window.Escritorio.ordem('redator', 'Escreva 3 legendas');   // o chefe leva a ordem

// de fora de um iframe:
iframe.contentWindow.postMessage({ escritorio: { id: 'revisor', status: 'aguardando' } }, '*');
```

### Segurança

O servidor só aceita conexões desta máquina (`127.0.0.1`). Quem acessa a página pode dar ordens às suas IAs, então só use `HOST=0.0.0.0` numa rede de confiança ou atrás de um proxy com login.

### Parâmetros da URL

- `?demo=1` força a simulação; `?demo=0` desliga (fica esperando status reais)
- `?ws=ws://...` conecta num WebSocket

## Estrutura

```
index.html              página
servidor.js             serve a página, recebe status e entrega ordens (Node, sem dependências)
motores.exemplo.json    modelo de webhooks dos motores (copie para motores.json)
src/agentes.js          equipe e estados
src/escritorio.js       sala, mesas, monitores e quadro branco
src/boneco.js           bonequinho e suas animações
src/chefe.js            o seu bonequinho: anda até o agente e entrega a ordem
src/integracao.js       HTTP/SSE, WebSocket, postMessage, ordens e modo demo
src/main.js             cena 3D, câmera e painel
exemplos/               motores de exemplo (Node e Python) recebendo ordens e enviando status
vendor/three/           Three.js r169 (licença MIT)
```
