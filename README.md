# agentscrets

Escritório 3D de agentes de IA. Cada agente (motor) tem a sua mesa e um bonequinho que faz a sua função: digita, lê documentos, fala ao telefone, desenha, analisa gráficos ou escreve no quadro branco. Quando um motor real manda status, o bonequinho reage na hora.

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

## Configurando a equipe

Edite `src/agentes.js`. Cada agente tem:

```js
{ id: 'redator', nome: 'Redator', funcao: 'Escreve conteúdos', atividade: 'digitar', cor: '#3fb27f', cabelo: '#a0522d', pele: '#ffdbac' }
```

As mesas são distribuídas sozinhas (8 por bloco); a sala cresce conforme a equipe aumenta.

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

### 2. WebSocket próprio

Abra `index.html?ws=ws://seu-servidor:porta` e envie as mensagens JSON pelo socket.

### 3. Na mesma página ou num iframe

```js
window.Escritorio.atualizar('designer', { status: 'trabalhando', tarefa: 'Criando carrossel' });
window.Escritorio.adicionarAgente({ id: 'financeiro', nome: 'Financeiro', atividade: 'analisar' });

// de fora de um iframe:
iframe.contentWindow.postMessage({ escritorio: { id: 'revisor', status: 'aguardando' } }, '*');
```

### Parâmetros da URL

- `?demo=1` força a simulação; `?demo=0` desliga (fica esperando status reais)
- `?ws=ws://...` conecta num WebSocket

## Estrutura

```
index.html              página
servidor.js             serve a página e recebe status (Node, sem dependências)
src/agentes.js          equipe e estados
src/escritorio.js       sala, mesas, monitores e quadro branco
src/boneco.js           bonequinho e suas animações
src/integracao.js       HTTP/SSE, WebSocket, postMessage e modo demo
src/main.js             cena 3D, câmera e painel
exemplos/               exemplo de motor enviando status
vendor/three/           Three.js r169 (licença MIT)
```
