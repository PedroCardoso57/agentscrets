// Código de verdade no GitHub: cada projeto (cliente) tem um repositório privado.
//
// - Na primeira entrega com código, o repositório é criado sozinho, já com um
//   workflow de CI (instala, compila e testa no GitHub Actions — fora do VPS).
// - Os arquivos que os agentes entregam (blocos ```arquivo: caminho```) viram um
//   commit num branch e um pull request; ajustes da mesma entrega vão no mesmo PR.
// - O CI de cada PR é acompanhado: falhou → o log volta para o mesmo agente
//   corrigir (até 3 vezes); passou → o QA revisa o código do PR (GITHUB_REVISAO=0
//   desliga). Pediu mudanças → o agente corrige; aprovou → merge automático
//   (GITHUB_AUTO_MERGE=0 desliga).
// - Preview: se o repositório estiver ligado a um serviço de deploy (Vercel,
//   Netlify, Cloudflare Pages…), o endereço de cada PR e o de produção (depois do
//   merge) são lidos do GitHub e aparecem na entrega, na ficha e no Telegram.
//
// - Netlify (opcional): com NETLIFY_TOKEN e NETLIFY_INSTALACAO, cada repositório
//   novo já ganha um site no Netlify ligado a ele (previews por PR e produção).
//
// .env: GITHUB_TOKEN (fine-grained: Administration, Contents, Pull requests e
// Workflows em Read and write; Actions, Checks, Commit statuses e Deployments em Read-only),
// GITHUB_DONO (organização onde criar; padrão: a conta do token), GITHUB_PREFIXO
// (prefixo do nome dos repositórios).

import { gravarArquivo } from './gravar.js';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const API = process.env.GITHUB_API || 'https://api.github.com'; // trocável só para testes
const NETLIFY_API = process.env.NETLIFY_API || 'https://api.netlify.com/api/v1';
const MAX_ARQUIVOS = 80;
const MAX_TAMANHO = 400_000;
const MAX_CORRECOES = 3;
const MAX_CONFLITOS = 3;
// CI parado: depois desse tempo, as verificações que não terminaram não seguram mais o PR
const CI_LIMITE_MIN = Number(process.env.GITHUB_CI_LIMITE_MIN) || 30;
// conclusões que são problema do GitHub/da conta, não do código (não adianta pedir correção ao agente)
const PROBLEMA_INFRA = ['action_required', 'stale', 'startup_failure', 'cancelled', 'timed_out'];
const ehActions = (c) => !c.app?.slug || c.app.slug === 'github-actions'; // vezes que o escritório tenta resolver o conflito de um PR antes de chamar você
const REENVIO_MIN = [2, 5, 10, 30, 60]; // espera entre os reenvios de uma entrega que não subiu (depois, de hora em hora)
const REENVIO_LIMITE_MS = 48 * 3600 * 1000;
const SEM_CI_MIN = 6; // sem nenhum check depois disso: o repositório não tem CI rodando
const PRODUCAO_MIN = 20; // depois do merge, procura o deploy de produção por até 20 min
const MAX_DIFF = 40_000; // quanto do diff vai para a revisão
const DEPLOY = /vercel|netlify|cloudflare|pages|preview|deploy|render|railway/i;

const CI = `name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  testes:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - name: Node.js
        if: hashFiles('**/package.json') != ''
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Instalar, compilar e testar (Node.js)
        if: hashFiles('**/package.json') != ''
        shell: bash
        run: |
          set -e
          for dir in $(find . -name package.json -not -path '*/node_modules/*' -exec dirname {} \\; | sort); do
            echo "::group::$dir"
            cd "$dir"
            if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi
            npm run build --if-present
            npm test --if-present
            cd - > /dev/null
            echo "::endgroup::"
          done
      - name: Python
        if: hashFiles('**/requirements.txt', '**/pyproject.toml') != ''
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Instalar e testar (Python)
        if: hashFiles('**/requirements.txt', '**/pyproject.toml') != ''
        shell: bash
        run: |
          set -e
          for req in $(find . -name requirements.txt -not -path '*/.venv/*'); do pip install -r "$req"; done
          if ls **/test_*.py tests 2>/dev/null | grep -q .; then pip install pytest && pytest -q; else echo "sem testes Python"; fi
`;

// Extrai os arquivos de uma entrega: blocos ```lang arquivo: caminho/do/arquivo``` (ou "file:"),
// ou um bloco logo depois de uma linha que é só o caminho (ex.: "### `src/app.js`").
export function extrairArquivos(texto) {
  const arquivos = new Map();
  const ok = (p) => /^[\w@.-][\w@./ -]*\.?[\w-]*$/.test(p) && !p.includes('..') && !p.startsWith('/') && !p.startsWith('.git/') && p.length < 200;
  const re = /```[^\n`]*?(?:arquivo|file|caminho|path)\s*[:=]\s*([^\n`]+)\n([\s\S]*?)\n```/gi;
  for (const m of String(texto).matchAll(re)) {
    const caminho = m[1].trim().replace(/^["'`]|["'`]$/g, '');
    if (ok(caminho)) arquivos.set(caminho, m[2] + '\n');
  }
  if (!arquivos.size) {
    const re2 = /^(?:#{1,6}\s*)?(?:\*\*)?`?([\w@.-][\w@./-]*\.[\w]+)`?(?:\*\*)?:?\s*\n+```[^\n]*\n([\s\S]*?)\n```/gm;
    for (const m of String(texto).matchAll(re2)) if (ok(m[1])) arquivos.set(m[1], m[2] + '\n');
  }
  return [...arquivos].slice(0, MAX_ARQUIVOS).filter(([, c]) => c.length <= MAX_TAMANHO).map(([caminho, conteudo]) => ({ caminho, conteudo }));
}

// O QA responde à revisão com "VEREDITO: APROVADO" ou "VEREDITO: MUDANÇAS".
export const pedeMudancas = (texto) => /VEREDITO\W*MUDAN/i.test(String(texto));
const falhou = (r) => !r || r.erro || /^(Erro:|Interrompida:)/.test(r.texto);

// pedirRevisao({ cliente, agente, numero, url, texto, anexo }) → ordem para o revisor (ou null, sem revisor)
export function criarRepositorios({ dadosDir, ordens, clientes, mudou, pedirCorrecao, pedirRevisao, avisar, informar }) {
  const token = process.env.GITHUB_TOKEN;
  const revisao = process.env.GITHUB_REVISAO !== '0';
  const arquivo = join(dadosDir, 'repositorios.json');
  const autoMerge = process.env.GITHUB_AUTO_MERGE !== '0';
  let repos = {}; // cliente → { dono, nome, url, padrao, ci }
  let prs = [];   // { cliente, numero, url, branch, sha, ordemId, indice, agente, estado, correcoes, desde }
  let conta = null;
  let relogio = null;
  const cacheArvore = new Map(); // cliente → { em, texto }

  const ativo = () => Boolean(token);
  const netlifyToken = process.env.NETLIFY_TOKEN;
  const netlifyInstalacao = Number(process.env.NETLIFY_INSTALACAO) || 0; // id da instalação do app do Netlify no GitHub
  const netlifyAtivo = () => Boolean(netlifyToken && netlifyInstalacao);

  async function netlify(metodo, caminho, corpo) {
    const r = await fetch(`${NETLIFY_API}${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${netlifyToken}`, 'User-Agent': 'escritorio-agentes', ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) {
      const erro = new Error(`Netlify ${metodo} ${caminho.split('?')[0]}: ${r.status} ${dados.message || dados.errors ? JSON.stringify(dados.errors || dados.message).slice(0, 200) : ''}`.trim());
      erro.status = r.status;
      throw erro;
    }
    return dados;
  }

  // Cria o site no Netlify ligado ao repositório (build: npm run build → dist; o netlify.toml do projeto manda mais).
  async function garantirNetlify(repo) {
    if (!netlifyAtivo() || repo.netlify) return;
    if (repo.netlifyErroEm && Date.now() - Date.parse(repo.netlifyErroEm) < 3600000) return; // tenta de novo em 1 h
    const caminho = process.env.NETLIFY_EQUIPE ? `/${process.env.NETLIFY_EQUIPE}/sites` : '/sites';
    const corpo = (nome) => ({
      name: nome,
      repo: { provider: 'github', repo: `${repo.dono}/${repo.nome}`, private: true, branch: repo.padrao, cmd: 'npm run build', dir: 'dist', installation_id: netlifyInstalacao },
    });
    try {
      let site;
      try { site = await netlify('POST', caminho, corpo(repo.nome.toLowerCase())); } catch (erro) {
        if (erro.status !== 422) throw erro; // nome já usado por outro site do Netlify: põe um sufixo
        site = await netlify('POST', caminho, corpo(`${repo.nome.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`));
      }
      repo.netlify = { id: site.id || site.site_id, url: site.ssl_url || site.url, admin: site.admin_url };
      delete repo.netlifyErroEm;
      console.log(`[netlify] site criado para ${repo.nome}: ${repo.netlify.url}`);
      informar?.(`🌐 Site no Netlify criado para ${repo.nome}: ${repo.netlify.url} (cada PR ganha um preview)`);
    } catch (erro) {
      repo.netlifyErroEm = new Date().toISOString();
      console.warn(`[netlify] não consegui criar o site de ${repo.nome}: ${erro.message}`);
    }
    await gravar();
    mudou();
  }

  // Deploy pronto de um commit no Netlify: preview do PR ou produção (endereço principal do site).
  async function deployNetlify(repo, sha, contexto) {
    if (!netlifyToken || !repo.netlify?.id || !sha) return null;
    try {
      const deploys = await netlify('GET', `/sites/${repo.netlify.id}/deploys?per_page=30`);
      const d = (deploys || []).find((x) => x.commit_ref === sha && x.state === 'ready' && (!contexto || x.context === contexto));
      if (!d) return null;
      return contexto === 'production' ? repo.netlify.url : d.deploy_ssl_url || d.links?.permalink || d.deploy_url;
    } catch { return null; }
  }

  async function gh(metodo, caminho, corpo, { texto = false } = {}) {
    const r = await fetch(`${API}${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'escritorio-agentes', ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (texto) return r.ok ? r.text() : '';
    const dados = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) {
      const erro = new Error(`GitHub ${metodo} ${caminho.split('?')[0]}: ${r.status} ${dados.message || ''}`.trim());
      erro.status = r.status;
      throw erro;
    }
    return dados;
  }

  async function carregar() {
    try { ({ repos = {}, prs = [] } = JSON.parse(await readFile(arquivo, 'utf8'))); } catch { /* primeira vez */ }
  }

  // uma gravação por vez (duas entregas ao mesmo tempo não podem disputar o mesmo arquivo)
  let fila = Promise.resolve();
  function gravar() {
    fila = gravarArquivo(arquivo, JSON.stringify({ repos, prs: prs.slice(-500) }, null, 2));
    return fila;
  }

  async function dono() {
    if (process.env.GITHUB_DONO) return process.env.GITHUB_DONO;
    conta ??= (await gh('GET', '/user')).login;
    return conta;
  }

  const nomeRepo = (cliente) => `${process.env.GITHUB_PREFIXO || ''}${cliente}`.slice(0, 90);

  // Commit de vários arquivos de uma vez num branch (cria o branch se preciso).
  async function commitar(repo, branch, base, arquivos, mensagem) {
    const caminho = `/repos/${repo.dono}/${repo.nome}`;
    let pai;
    try { pai = (await gh('GET', `${caminho}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha; } catch (erro) {
      if (erro.status !== 404) throw erro;
      pai = (await gh('GET', `${caminho}/git/ref/heads/${encodeURIComponent(base)}`)).object.sha;
      await gh('POST', `${caminho}/git/refs`, { ref: `refs/heads/${branch}`, sha: pai });
    }
    const arvoreBase = (await gh('GET', `${caminho}/git/commits/${pai}`)).tree.sha;
    const arvore = await gh('POST', `${caminho}/git/trees`, { base_tree: arvoreBase, tree: arquivos.map((a) => ({ path: a.caminho, mode: '100644', type: 'blob', content: a.conteudo })) });
    const commit = await gh('POST', `${caminho}/git/commits`, { message: mensagem, tree: arvore.sha, parents: [pai] });
    await gh('PATCH', `${caminho}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha });
    return commit.sha;
  }

  // Lê um arquivo de um branch/commit (null se não existe)
  async function lerArquivo(repo, caminho, ref) {
    try {
      const d = await gh('GET', `/repos/${repo.dono}/${repo.nome}/contents/${caminho.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
      return Buffer.from(d.content || '', d.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    } catch (erro) {
      if (erro.status === 404) return null;
      throw erro;
    }
  }

  // Refaz o PR em cima do main atual: os arquivos do PR (versão do branch) mais os que o
  // agente entregou já juntando as mudanças. O branch é do escritório, então pode ser regravado.
  async function reconstruirSobreMain(repo, pr, arquivos, mensagem) {
    const base = `/repos/${repo.dono}/${repo.nome}`;
    const mainSha = (await gh('GET', `${base}/git/ref/heads/${encodeURIComponent(repo.padrao)}`)).object.sha;
    const arvoreMain = (await gh('GET', `${base}/git/commits/${mainSha}`)).tree.sha;
    const entregues = new Map(arquivos.map((a) => [a.caminho, a.conteudo]));
    const doPR = (await gh('GET', `${base}/pulls/${pr.numero}/files?per_page=100`)).filter((f) => f.status !== 'removed');
    const arvore = [];
    for (const f of doPR) {
      if (entregues.has(f.filename)) continue;
      const conteudo = await lerArquivo(repo, f.filename, pr.branch);
      if (conteudo !== null) arvore.push({ path: f.filename, mode: '100644', type: 'blob', content: conteudo });
    }
    for (const [caminho, conteudo] of entregues) arvore.push({ path: caminho, mode: '100644', type: 'blob', content: conteudo });
    const t = await gh('POST', `${base}/git/trees`, { base_tree: arvoreMain, tree: arvore });
    const commit = await gh('POST', `${base}/git/commits`, { message: mensagem, tree: t.sha, parents: [mainSha] });
    await gh('PATCH', `${base}/git/refs/heads/${encodeURIComponent(pr.branch)}`, { sha: commit.sha, force: true });
    return commit.sha;
  }

  // Garante o repositório do projeto (cria privado, com README e CI, na primeira vez).
  const criando = new Map(); // cliente → promessa: duas entregas ao mesmo tempo não criam o repositório duas vezes
  function garantirRepo(cliente) {
    if (repos[cliente]) return Promise.resolve(repos[cliente]);
    if (!criando.has(cliente)) criando.set(cliente, criarRepo(cliente).finally(() => criando.delete(cliente)));
    return criando.get(cliente);
  }
  async function criarRepo(cliente) {
    if (repos[cliente]) return repos[cliente];
    const ficha = clientes.listar().find((c) => c.id === cliente);
    const nome = nomeRepo(cliente);
    const donoRepo = await dono();
    let r;
    try { r = await gh('GET', `/repos/${donoRepo}/${nome}`); } catch (erro) {
      if (erro.status !== 404) throw erro;
      const criar = { name: nome, private: true, auto_init: true, description: `${ficha?.nome || cliente} — ${String(ficha?.produtos || 'projeto').slice(0, 300)}` };
      r = process.env.GITHUB_DONO ? await gh('POST', `/orgs/${donoRepo}/repos`, criar) : await gh('POST', '/user/repos', criar);
      console.log(`[github] repositório criado: ${r.html_url}`);
    }
    const repo = { dono: donoRepo, nome, url: r.html_url, padrao: r.default_branch || 'main', ci: false };
    repos[cliente] = repo;
    // CI do GitHub Actions (precisa da permissão "Workflows" no token)
    try {
      await commitar(repo, repo.padrao, repo.padrao, [{ caminho: '.github/workflows/ci.yml', conteudo: CI }], 'CI: instala, compila e testa a cada pull request');
      repo.ci = true;
    } catch (erro) {
      console.warn(`[github] não consegui criar o CI (${erro.message}). Dê ao token a permissão "Workflows: Read and write" para testar os PRs.`);
    }
    await garantirNetlify(repo);
    await gravar();
    mudou();
    return repo;
  }

  // Lista de arquivos do repositório, para os agentes saberem a estrutura do projeto.
  async function arvore(cliente) {
    const repo = repos[cliente];
    if (!ativo() || !repo) return '';
    const c = cacheArvore.get(cliente);
    if (c && Date.now() - c.em < 120000) return c.texto;
    try {
      const t = await gh('GET', `/repos/${repo.dono}/${repo.nome}/git/trees/${encodeURIComponent(repo.padrao)}?recursive=1`);
      const caminhos = (t.tree || []).filter((x) => x.type === 'blob').map((x) => x.path).slice(0, 400);
      const texto = caminhos.length ? caminhos.join('\n') : '(repositório vazio)';
      cacheArvore.set(cliente, { em: Date.now(), texto });
      return texto;
    } catch { return ''; }
  }

  // Conteúdo atual dos arquivos que todo mundo mexe (package.json & cia.) e dos citados no pedido:
  // quem reescreve um arquivo inteiro precisa partir da versão atual para não apagar o trabalho dos outros.
  const CHAVE_ARQUIVO = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|tsconfig\.json|vite\.config\.\w+|netlify\.toml|docker-compose\.ya?ml|Dockerfile|\.env\.example|schema\.prisma)$/;
  async function arquivosAtuais(cliente, pedido = '') {
    const repo = repos[cliente];
    const lista = (await arvore(cliente)).split('\n').filter((p) => p && !p.startsWith('('));
    const citados = lista.filter((p) => pedido.includes(p) || (p.includes('/') && pedido.includes(p.split('/').pop()) && p.split('/').pop().length > 6));
    const escolhidos = [...new Set([...lista.filter((p) => CHAVE_ARQUIVO.test(p) && p.split('/').length <= 3), ...citados])].slice(0, 12);
    const partes = [];
    let total = 0;
    for (const caminho of escolhidos) {
      const conteudo = await lerArquivo(repo, caminho, repo.padrao).catch(() => null);
      if (conteudo == null || conteudo.length > 12000 || total + conteudo.length > 40000) continue;
      total += conteudo.length;
      partes.push(`### ${caminho}\n\`\`\`\n${conteudo}\n\`\`\``);
    }
    return partes.join('\n\n');
  }

  // O PR de uma entrega anterior (para ajustes e correções irem no mesmo branch).
  function prDaOrdem(ordem) {
    for (let o = ordem; o?.ajuste;) {
      const anterior = ordens.find((x) => x.id === o.ajuste.ordemId);
      const pr = prs.find((p) => p.ordemId === anterior?.id && p.estado !== 'mesclado');
      if (pr) return pr;
      o = anterior;
    }
    return null;
  }

  // Uma entrega com arquivos de código vira commit + PR no repositório do projeto.
  async function publicarEntrega(ordem, indice) {
    const r = ordem.respostas[indice];
    if (!ativo() || !ordem.cliente || !r || r.erro || ordem.origem?.revisaoPR) return; // revisão de PR não vira PR
    const arquivos = extrairArquivos(r.texto);
    if (!arquivos.length) return;
    const falhaAnterior = r.repo?.erro ? r.repo : null; // reenvio de uma entrega que não tinha subido
    try {
      const repo = await garantirRepo(ordem.cliente);
      const existente = prDaOrdem(ordem);
      const branch = existente?.branch || `agentes/${r.agente}-${ordem.id}`;
      const titulo = (ordem.ajuste?.original || ordem.texto).split('\n')[0].slice(0, 90);
      const mensagem = `${existente ? 'Ajuste' : r.agente}: ${(existente ? ordem.texto : titulo).slice(0, 72)}\n\nEntrega da ordem ${ordem.id} (${r.agente}, ${r.motor || 'IA'}).`;
      // resolvendo conflito: refaz o PR em cima do main atual (sem conflito); senão, commit normal no branch
      const sha = existente?.reconstruir
        ? await reconstruirSobreMain(repo, existente, arquivos, `Resolve o conflito com o ${repo.padrao}: ${(existente.reconstruir.conflitantes || []).join(', ')}`.slice(0, 200))
        : await commitar(repo, branch, repo.padrao, arquivos, mensagem);
      if (existente?.reconstruir) {
        existente.reconstruir = null;
        informar?.(`🔀 Conflito do PR #${existente.numero} resolvido por ${r.agente}: ${existente.url}`);
      }
      cacheArvore.delete(ordem.cliente);
      let pr = existente;
      if (!pr) {
        const corpo = `Entrega do agente **${r.agente}** para: ${ordem.ajuste?.original || ordem.texto}\n\nArquivos:\n${arquivos.map((a) => `- \`${a.caminho}\``).join('\n')}\n\n${repo.ci ? 'O CI roda os testes; se falharem, o agente corrige neste mesmo PR.' : ''}\n\n_Aberto pelo escritório de agentes._`;
        let novo;
        try {
          novo = await gh('POST', `/repos/${repo.dono}/${repo.nome}/pulls`, { title: titulo, head: branch, base: repo.padrao, body: corpo });
        } catch (erro) {
          // reenvio de uma entrega cujo PR já tinha sido aberto: usa o PR que já existe
          if (erro.status !== 422) throw erro;
          [novo] = await gh('GET', `/repos/${repo.dono}/${repo.nome}/pulls?state=open&head=${encodeURIComponent(`${repo.dono}:${branch}`)}`);
          if (!novo) throw erro;
        }
        pr = { cliente: ordem.cliente, numero: novo.number, url: novo.html_url, branch, agente: r.agente, ordemId: ordem.id, indice, correcoes: 0 };
        prs.push(pr);
        informar?.(`🔀 ${r.agente} abriu o PR #${pr.numero} (${arquivos.length} arquivo(s)): ${pr.url}`);
      }
      Object.assign(pr, { sha, estado: 'testando', desde: new Date().toISOString(), ultimaOrdem: ordem.id, aguardando: null, avisouCiParado: false, avisouInfra: false });
      r.repo = { pr: pr.numero, url: pr.url, branch, arquivos: arquivos.map((a) => a.caminho), estado: 'testando' };
      await gravar();
      mudou(ordem);
      console.log(`[github] ${r.agente}: ${arquivos.length} arquivo(s) em ${pr.url}`);
      if (falhaAnterior) informar?.(`🔁 A entrega de ${r.agente} que não tinha subido agora está no GitHub: ${pr.url}`);
    } catch (erro) {
      console.error(`[github] ${erro.message}`);
      // fica na fila de reenvio: tenta de novo sozinho, com espera crescente, por até 2 dias
      const tentativas = (falhaAnterior?.tentativas || 0) + 1;
      const desde = falhaAnterior?.desde || new Date().toISOString();
      const espera = REENVIO_MIN[Math.min(tentativas - 1, REENVIO_MIN.length - 1)] * 60000 * (Number(process.env.GITHUB_REENVIO_ESCALA) || 1);
      const desistiu = Date.now() - Date.parse(desde) > REENVIO_LIMITE_MS;
      r.repo = { erro: erro.message.slice(0, 200), tentativas, desde, proxima: desistiu ? null : new Date(Date.now() + espera).toISOString(), desistiu };
      if (desistiu) avisar?.(`⚠️ A entrega de ${r.agente} ("${ordem.texto.slice(0, 80)}") não conseguiu subir ao GitHub em 2 dias de tentativas: ${erro.message.slice(0, 160)}. Peça um ↩ ajuste para tentar de novo.`);
      mudou(ordem);
    }
  }

  // Reenvio: entregas que não subiram (ex.: token sem permissão) tentam de novo sozinhas.
  // As que falharam antes de o servidor subir também entram (sem "proxima": tenta já).
  let reenviando = false;
  async function reenviarPendentes() {
    if (reenviando || !ativo()) return;
    reenviando = true;
    try {
      let feitos = 0;
      for (const ordem of ordens) {
        for (const [indice, r] of ordem.respostas.entries()) {
          if (feitos >= 3) return; // poucos por vez
          if (ordem.cancelada || !r.repo?.erro || r.repo.desistiu || (r.repo.proxima && Date.parse(r.repo.proxima) > Date.now())) continue;
          feitos++;
          console.log(`[github] reenviando a entrega de ${r.agente} (ordem ${ordem.id}, tentativa ${(r.repo.tentativas || 0) + 1})`);
          await publicarEntrega(ordem, indice);
        }
      }
    } finally {
      reenviando = false;
    }
  }

  function marcar(pr, estado, extra = {}) {
    pr.estado = estado;
    Object.assign(pr, extra);
    // todas as entregas que foram para este PR (a original e as correções) mostram o mesmo estado
    for (const o of ordens) {
      if (o.cliente !== pr.cliente) continue;
      const dele = o.respostas.filter((x) => x.repo?.pr === pr.numero && x.repo.branch === pr.branch);
      if (!dele.length) continue;
      for (const r of dele) Object.assign(r.repo, { estado, aguardando: pr.aguardando || null, desde: pr.desde || null }, pr.preview ? { preview: pr.preview } : {});
      mudou(o);
    }
  }

  async function mesclar(pr, repo) {
    if (!autoMerge) { marcar(pr, 'aprovado'); return; }
    try {
      const m = await gh('PUT', `/repos/${repo.dono}/${repo.nome}/pulls/${pr.numero}/merge`, { merge_method: 'squash', commit_title: `${pr.agente}: PR #${pr.numero}` });
      if (m.sha) Object.assign(pr, { mergeSha: m.sha, mescladoEm: new Date().toISOString() });
      await gh('DELETE', `/repos/${repo.dono}/${repo.nome}/git/refs/heads/${encodeURIComponent(pr.branch)}`).catch(() => {});
      marcar(pr, 'mesclado');
      cacheArvore.delete(pr.cliente);
      informar?.(`✅ PR #${pr.numero} mesclado${pr.correcoes ? ` depois de ${pr.correcoes} correção(ões)` : ''}: ${pr.url}`);
      console.log(`[github] PR mesclado: ${pr.url}`);
    } catch (erro) {
      // 405/409: o PR não pode ser mesclado (conflito com o main): o escritório resolve
      if ([405, 409].includes(erro.status)) return resolverConflito(pr, repo);
      marcar(pr, 'conflito');
      avisar?.(`⚠️ Não consegui mesclar o ${pr.url} (${erro.message.slice(0, 120)}). Veja no GitHub.`);
    }
  }

  // O PR está em conflito com o main? (null = o GitHub ainda está calculando)
  async function emConflito(pr, repo) {
    const d = await gh('GET', `/repos/${repo.dono}/${repo.nome}/pulls/${pr.numero}`);
    if (d.merged) { marcar(pr, 'mesclado'); return false; } // alguém mesclou à mão
    if (d.state === 'closed') { marcar(pr, 'fechado'); return false; } // alguém fechou à mão
    return d.mergeable === false;
  }

  // Conflito: primeiro tenta o "atualizar branch" do GitHub (resolve quando os arquivos não se
  // cruzam); se os dois lados mexeram nos mesmos arquivos, o autor do PR recebe as duas versões
  // e entrega a final, e o PR é refeito em cima do main. Passa de novo pelo CI e pela revisão.
  async function resolverConflito(pr, repo) {
    const base = `/repos/${repo.dono}/${repo.nome}`;
    try {
      await gh('PUT', `${base}/pulls/${pr.numero}/update-branch`, {});
      pr.sha = (await gh('GET', `${base}/git/ref/heads/${encodeURIComponent(pr.branch)}`)).object.sha;
      marcar(pr, 'testando', { desde: new Date().toISOString() });
      console.log(`[github] PR #${pr.numero}: branch atualizado com o ${repo.padrao} (sem conflito de arquivo)`);
      await gravar();
      return;
    } catch (erro) {
      if (![409, 422].includes(erro.status)) throw erro;
    }
    pr.conflitos = (pr.conflitos || 0) + 1;
    if (pr.conflitos > MAX_CONFLITOS) {
      marcar(pr, 'conflito');
      avisar?.(`⚠️ O ${pr.url} continua em conflito com o ${repo.padrao} depois de ${MAX_CONFLITOS} tentativas de juntar as mudanças. Precisa de um olhar humano.`);
      await gravar();
      return;
    }
    // quais arquivos os dois lados mudaram
    const cmp = await gh('GET', `${base}/compare/${encodeURIComponent(repo.padrao)}...${encodeURIComponent(pr.branch)}`);
    const noMain = await gh('GET', `${base}/compare/${cmp.merge_base_commit.sha}...${encodeURIComponent(repo.padrao)}`);
    const mudouNoMain = new Set((noMain.files || []).map((f) => f.filename));
    const doPR = await gh('GET', `${base}/pulls/${pr.numero}/files?per_page=100`);
    const conflitantes = doPR.filter((f) => mudouNoMain.has(f.filename)).map((f) => f.filename).slice(0, 8);
    const blocos = [];
    for (const caminho of conflitantes) {
      const doMain = await lerArquivo(repo, caminho, repo.padrao);
      const seu = await lerArquivo(repo, caminho, pr.branch);
      blocos.push(`### ${caminho}\nVersão que está no ${repo.padrao} (de outro trabalho já mesclado):\n\`\`\`\n${(doMain ?? '(o arquivo foi apagado no main)').slice(0, 12000)}\n\`\`\`\nA sua versão neste PR:\n\`\`\`\n${(seu ?? '').slice(0, 12000)}\n\`\`\``);
    }
    pr.reconstruir = { conflitantes, em: new Date().toISOString() };
    marcar(pr, 'corrigindo');
    const ordem = ordens.find((x) => x.id === pr.ultimaOrdem);
    const indice = ordem ? ordem.respostas.findLastIndex((x) => x.repo?.pr === pr.numero) : -1;
    if (ordem && indice >= 0) {
      pedirCorrecao({
        ordemId: ordem.id, indice,
        texto: `O pull request #${pr.numero} ficou em conflito com o ${repo.padrao}: outro trabalho já mesclado mudou os mesmos arquivos (${conflitantes.join(', ') || 'veja abaixo'}). Junte as duas mudanças — mantenha o que o outro trabalho fez E o que você fez — e entregue a versão FINAL completa de cada um desses arquivos, no mesmo caminho. Não entregue os outros arquivos (eles já estão certos). Tentativa ${pr.conflitos} de ${MAX_CONFLITOS}.\n\n${blocos.join('\n\n')}`,
      });
      informar?.(`🔀 O PR #${pr.numero} entrou em conflito com o ${repo.padrao} (${conflitantes.join(', ')}): ${pr.agente} está juntando as mudanças.`);
    }
    console.log(`[github] PR #${pr.numero}: conflito em ${conflitantes.join(', ') || '?'}; ${pr.agente} vai juntar as mudanças`);
    await gravar();
  }

  // Endereço publicado de um commit por um serviço de deploy ligado ao repositório
  // (deployments do GitHub ou status de commit da Vercel/Netlify/Cloudflare…).
  async function enderecoDeploy(repo, sha) {
    const base = `/repos/${repo.dono}/${repo.nome}`;
    try {
      for (const d of (await gh('GET', `${base}/deployments?sha=${sha}&per_page=10`)) || []) {
        const st = await gh('GET', `${base}/deployments/${d.id}/statuses?per_page=5`);
        const ok = (st || []).find((x) => x.state === 'success' && (x.environment_url || x.target_url));
        if (ok) return ok.environment_url || ok.target_url;
      }
    } catch { /* sem permissão de Deployments ou sem deploy */ }
    try {
      const { statuses = [] } = await gh('GET', `${base}/commits/${sha}/status`);
      const ok = statuses.find((x) => x.state === 'success' && x.target_url && DEPLOY.test(x.context || ''));
      if (ok) return ok.target_url;
    } catch { /* sem status */ }
    return null;
  }

  async function procurarPreview(pr, repo) {
    if (pr.previewSha === pr.sha) return;
    const url = (await deployNetlify(repo, pr.sha, 'deploy-preview')) || (await enderecoDeploy(repo, pr.sha));
    if (!url) return;
    const primeiro = !pr.preview;
    pr.previewSha = pr.sha;
    marcar(pr, pr.estado, { preview: url });
    if (primeiro) informar?.(`🔎 Preview do PR #${pr.numero}: ${url}`);
    await gravar();
  }

  // Depois do merge: o endereço de produção do projeto.
  async function procurarProducao(pr, repo) {
    const url = (await deployNetlify(repo, pr.mergeSha, 'production')) || (await enderecoDeploy(repo, pr.mergeSha));
    if (url) {
      repo.producao = url;
      pr.producaoOk = true;
      informar?.(`🌐 ${clientes.nomeDe?.(pr.cliente) || pr.cliente} atualizado no ar: ${url}`);
      mudou();
    } else if ((Date.now() - Date.parse(pr.mescladoEm)) / 60000 > PRODUCAO_MIN) {
      pr.producaoOk = false; // não há deploy ligado ao repositório
    } else return;
    await gravar();
  }

  // O mesmo agente corrige no mesmo PR (CI falhou ou a revisão pediu mudanças).
  function corrigir(pr, motivo, detalhes) {
    if (pr.correcoes >= MAX_CORRECOES) {
      marcar(pr, 'falhou');
      avisar?.(`⚠️ ${motivo} no ${pr.url} depois de ${MAX_CORRECOES} correções. Precisa de um olhar humano.`);
      return;
    }
    pr.correcoes++;
    marcar(pr, 'corrigindo');
    const ordem = ordens.find((x) => x.id === pr.ultimaOrdem);
    const indice = ordem ? ordem.respostas.findLastIndex((x) => x.repo?.pr === pr.numero) : -1;
    if (ordem && indice >= 0) {
      pedirCorrecao({ ordemId: ordem.id, indice, texto: `${motivo} no pull request #${pr.numero} (correção ${pr.correcoes} de ${MAX_CORRECOES}). Corrija e entregue os arquivos alterados completos.\n\n${detalhes}` });
    }
  }

  // CI verde: o QA lê o diff do PR antes do merge.
  async function revisar(pr, repo) {
    if (!revisao || !pedirRevisao) return mesclar(pr, repo);
    const arquivos = await gh('GET', `/repos/${repo.dono}/${repo.nome}/pulls/${pr.numero}/files?per_page=100`);
    let diff = '';
    for (const [i, a] of (arquivos || []).entries()) {
      const bloco = `### ${a.filename} (${a.status}, +${a.additions ?? 0} -${a.deletions ?? 0})\n\`\`\`diff\n${a.patch || '(sem diff: arquivo binário ou grande demais)'}\n\`\`\`\n\n`;
      if (diff.length + bloco.length > MAX_DIFF) { diff += `(… e mais ${arquivos.length - i} arquivo(s) fora do limite)\n`; break; }
      diff += bloco;
    }
    const ordemPR = ordens.find((x) => x.id === pr.ordemId);
    const ordem = pedirRevisao({
      cliente: pr.cliente, agente: pr.agente, numero: pr.numero, url: pr.url,
      texto: `Revisão de código do PR #${pr.numero} de ${pr.agente}: "${(ordemPR?.ajuste?.original || ordemPR?.texto || '').split('\n')[0].slice(0, 200)}". O CI já passou.`,
      anexo: `Revise o diff abaixo como revisor de código antes do merge. A PRIMEIRA linha da resposta deve ser exatamente "VEREDITO: APROVADO" ou "VEREDITO: MUDANÇAS".
Peça MUDANÇAS só por problemas reais: bug, falha de segurança (injeção de SQL, segredo/senha no código, rota sem autenticação, dado sensível exposto), perda de dados, requisito do pedido não atendido ou código que não vai funcionar em produção. Estilo, nomes e melhorias opcionais vão como sugestões, sem bloquear.
Em MUDANÇAS, liste cada problema com arquivo, o porquê e como corrigir. Não reescreva os arquivos: quem corrige é o autor.

PEDIDO ORIGINAL:
${(ordemPR?.ajuste?.original || ordemPR?.texto || '').slice(0, 3000)}

DIFF DO PR ${pr.url}:
${diff}`,
    });
    if (!ordem) return mesclar(pr, repo); // sem revisor na equipe
    marcar(pr, 'revisando', { revisaoOrdem: ordem.id });
    await gravar();
  }

  // A revisão do QA voltou: comenta no PR e decide (merge ou correção).
  async function veredito(pr, repo) {
    const o = ordens.find((x) => x.id === pr.revisaoOrdem);
    const resp = o?.respostas.find((r) => !falhou(r));
    if (!resp) {
      if (!o || o.desistida) { pr.semRevisao = true; await mesclar(pr, repo); await gravar(); } // revisor fora do ar: o CI já passou
      return;
    }
    const mudancas = pedeMudancas(resp.texto);
    pr.revisaoOrdem = null;
    await gh('POST', `/repos/${repo.dono}/${repo.nome}/pulls/${pr.numero}/reviews`, {
      event: 'COMMENT',
      body: `**Revisão de código — ${resp.agente}** (${mudancas ? '🔧 pediu mudanças' : '✅ aprovado'})\n\n${resp.texto.slice(0, 60000)}`,
    }).catch((erro) => console.warn(`[github] não consegui comentar a revisão no PR #${pr.numero}: ${erro.message}`));
    if (mudancas) {
      informar?.(`🔧 ${resp.agente} pediu mudanças no PR #${pr.numero}: ${pr.url}`);
      corrigir(pr, 'A revisão de código pediu mudanças', resp.texto.slice(0, 6000));
    } else {
      await mesclar(pr, repo);
    }
    await gravar();
  }

  // Resultado dos testes de um commit. O normal é a lista de "checks" (permissão Checks);
  // sem ela, usa as execuções do GitHub Actions (permissão Actions), no mesmo formato.
  let semPermissaoChecks = 0; // quando faltou a permissão (tenta de novo a cada hora: você pode ter adicionado)
  let avisouChecks = false;
  async function verificacoes(repo, sha) {
    const base = `/repos/${repo.dono}/${repo.nome}`;
    if (Date.now() - semPermissaoChecks > 3600000) {
      try {
        return (await gh('GET', `${base}/commits/${sha}/check-runs`)).check_runs || [];
      } catch (erro) {
        if (erro.status !== 403) throw erro;
        semPermissaoChecks = Date.now();
        console.warn('[github] o token não tem a permissão "Checks": usando as execuções do GitHub Actions');
        // não é erro: o token não tem "Checks" (nem todo token oferece essa permissão); os testes vêm do Actions
        if (!avisouChecks) avisouChecks = true, console.log('[github] lendo os testes pelas execuções do GitHub Actions (permissão "Actions: Read-only")');
      }
    }
    const { workflow_runs: runs = [] } = await gh('GET', `${base}/actions/runs?head_sha=${sha}&per_page=20`);
    const lista = [];
    for (const run of runs) {
      // jobs de cada execução (o log de falha é por job)
      const { jobs = [] } = await gh('GET', `${base}/actions/runs/${run.id}/jobs?per_page=20`).catch(() => ({ jobs: [] }));
      if (jobs.length) for (const j of jobs) lista.push({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, app: { slug: 'github-actions' }, details_url: j.html_url });
      else lista.push({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, app: { slug: 'github-actions' }, details_url: run.html_url });
    }
    return lista;
  }

  // Acompanha os PRs abertos pelo escritório: CI, revisão, preview e produção.
  async function conferir() {
    await reenviarPendentes().catch((erro) => console.error(`[github] reenvio: ${erro.message}`));
    // repositórios criados antes do Netlify ser configurado também ganham o site
    for (const repo of Object.values(repos)) if (netlifyAtivo() && !repo.netlify) await garantirNetlify(repo);
    for (const pr of prs) {
      const repo = repos[pr.cliente];
      if (!repo) continue;
      try {
        if (pr.estado === 'mesclado') {
          if (pr.mergeSha && pr.producaoOk === undefined) await procurarProducao(pr, repo);
          continue;
        }
        // ordem cancelada pelo chefe: o escritório para de cuidar do PR (ele fica aberto no GitHub)
        if (pr.estado === 'cancelado') continue;
        if (['testando', 'revisando', 'corrigindo'].includes(pr.estado) && ordens.some((o) => (o.id === pr.ordemId || o.id === pr.ultimaOrdem) && o.cancelada)) { marcar(pr, 'cancelado'); await gravar(); continue; }
        if (pr.estado === 'revisando') { await procurarPreview(pr, repo); await veredito(pr, repo); continue; }
        // PRs que ficaram em "conflito" antes desta versão: o escritório tenta resolver
        if (pr.estado === 'conflito' && !pr.conflitos) { await resolverConflito(pr, repo); continue; }
        if (pr.estado !== 'testando') continue;
        if (await emConflito(pr, repo).catch(() => false)) { await resolverConflito(pr, repo); continue; } // se a consulta falhar, segue o CI normalmente
        await procurarPreview(pr, repo);
        const minutos = (Date.now() - Date.parse(pr.desde)) / 60000;
        let checks;
        try {
          checks = await verificacoes(repo, pr.sha);
        } catch (erro) {
          // não deu para ler o resultado dos testes: não fica "testando" para sempre
          if (!pr.avisouLeitura) {
            pr.avisouLeitura = true;
            avisar?.(`⚠️ Não consigo ler o resultado dos testes do ${pr.url}: ${erro.message.slice(0, 160)}. Confira se o token do GitHub tem a permissão "Actions: Read-only". ${minutos < CI_LIMITE_MIN ? `Se não resolver em ${CI_LIMITE_MIN} min, o PR segue para a revisão sem o resultado dos testes.` : 'O PR segue para a revisão sem o resultado dos testes.'}`);
            await gravar();
          }
          if (minutos >= CI_LIMITE_MIN) { pr.aguardando = null; await revisar(pr, repo); }
          continue;
        }
        if (!checks.length) {
          if (minutos > SEM_CI_MIN) await revisar(pr, repo); // sem CI no repositório: segue para a revisão
          continue;
        }
        // o que ainda não terminou aparece no cartão ("esperando: …")
        const pendentes = checks.filter((c) => c.status !== 'completed');
        const nomes = pendentes.map((c) => c.name).join(', ') || null;
        if (nomes !== (pr.aguardando || null)) { pr.aguardando = nomes; marcar(pr, pr.estado); await gravar(); }
        if (pendentes.length) {
          if (minutos < CI_LIMITE_MIN) continue;
          // passou do limite: avisa uma vez e segue só com o que terminou
          const actionsPresos = pendentes.filter(ehActions);
          if (!pr.avisouCiParado) {
            pr.avisouCiParado = true;
            avisar?.(`⏳ O CI do ${pr.url} está parado há ${Math.round(minutos)} min esperando: ${nomes}. ${actionsPresos.length
              ? 'Os testes do GitHub Actions não terminaram (veja a aba Actions do repositório: fila parada, aprovação pendente ou minutos do plano esgotados).'
              : 'São verificações de fora do GitHub (ex.: Netlify), que não decidem o merge.'} O PR segue para a revisão sem esperar mais.`);
          }
          if (actionsPresos.length && process.env.GITHUB_CI_TRAVADO === 'esperar') continue;
        }
        const terminados = checks.filter((c) => c.status === 'completed');
        // problema do GitHub/da conta (aprovação pendente, run cancelado…): avisa, mas não culpa o código
        const infra = terminados.filter((c) => PROBLEMA_INFRA.includes(c.conclusion));
        if (infra.length && !pr.avisouInfra) {
          pr.avisouInfra = true;
          avisar?.(`⚠️ No ${pr.url}, ${infra.map((c) => `"${c.name}" terminou como ${c.conclusion}`).join(', ')}: isso é do GitHub/da conta, não do código. Seguindo sem essa verificação.`);
        }
        const falhas = terminados.filter((c) => !['success', 'skipped', 'neutral', ...PROBLEMA_INFRA].includes(c.conclusion));
        if (!falhas.length) { pr.aguardando = null; await procurarPreview(pr, repo); await revisar(pr, repo); continue; }
        // o fim do log de cada falha (Actions) ou o resumo do check (Vercel, Netlify…)
        const logs = [];
        for (const c of falhas.slice(0, 2)) {
          const log = !c.app?.slug || c.app.slug === 'github-actions'
            ? await gh('GET', `/repos/${repo.dono}/${repo.nome}/actions/jobs/${c.id}/logs`, null, { texto: true }) : '';
          const resumo = [c.output?.title, c.output?.summary, c.output?.text].filter(Boolean).join('\n');
          logs.push(`### ${c.name} (${c.conclusion})${c.details_url ? ` ${c.details_url}` : ''}\n${(log || resumo || '(sem log)').slice(-3500)}`);
        }
        corrigir(pr, 'O CI falhou', `Faça os testes e o build passarem.\n\n${logs.join('\n\n')}`);
        await gravar();
      } catch (erro) {
        console.error(`[github] PR #${pr.numero}: ${erro.message}`);
      }
    }
  }

  function iniciar() {
    if (!ativo()) return;
    relogio ??= setInterval(() => conferir().catch(() => {}), Number(process.env.GITHUB_INTERVALO_MS) || 60000);
    relogio.unref?.();
    if (netlifyToken && !netlifyInstalacao) console.warn('[netlify] NETLIFY_TOKEN sem NETLIFY_INSTALACAO: coloque o número da instalação do app do Netlify no GitHub para criar os sites sozinho.');
    else if (netlifyAtivo()) console.log('[netlify] ligado: cada repositório novo ganha um site no Netlify');
    console.log(`[github] ligado: cada projeto vira um repositório${revisao ? ', o QA revisa cada PR' : ''}${autoMerge ? ', merge automático quando o CI passa' : ''}`);
  }

  const repoDe = (cliente) => repos[cliente] || null;

  return { carregar, iniciar, ativo, publicarEntrega, arvore, arquivosAtuais, repoDe, conferir, garantirRepo };
}
