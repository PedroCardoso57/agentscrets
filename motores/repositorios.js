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
// .env: GITHUB_TOKEN (fine-grained: Administration, Contents, Pull requests e
// Workflows em Read and write; Actions, Commit statuses e Deployments em Read-only),
// GITHUB_DONO (organização onde criar; padrão: a conta do token), GITHUB_PREFIXO
// (prefixo do nome dos repositórios).

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const API = process.env.GITHUB_API || 'https://api.github.com'; // trocável só para testes
const MAX_ARQUIVOS = 80;
const MAX_TAMANHO = 400_000;
const MAX_CORRECOES = 3;
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

  async function gravar() {
    await mkdir(dadosDir, { recursive: true });
    await writeFile(`${arquivo}.tmp`, JSON.stringify({ repos, prs: prs.slice(-500) }, null, 2));
    await rename(`${arquivo}.tmp`, arquivo);
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

  // Garante o repositório do projeto (cria privado, com README e CI, na primeira vez).
  async function garantirRepo(cliente) {
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
    try {
      const repo = await garantirRepo(ordem.cliente);
      const existente = prDaOrdem(ordem);
      const branch = existente?.branch || `agentes/${r.agente}-${ordem.id}`;
      const titulo = (ordem.ajuste?.original || ordem.texto).split('\n')[0].slice(0, 90);
      const mensagem = `${existente ? 'Ajuste' : r.agente}: ${(existente ? ordem.texto : titulo).slice(0, 72)}\n\nEntrega da ordem ${ordem.id} (${r.agente}, ${r.motor || 'IA'}).`;
      const sha = await commitar(repo, branch, repo.padrao, arquivos, mensagem);
      cacheArvore.delete(ordem.cliente);
      let pr = existente;
      if (!pr) {
        const corpo = `Entrega do agente **${r.agente}** para: ${ordem.ajuste?.original || ordem.texto}\n\nArquivos:\n${arquivos.map((a) => `- \`${a.caminho}\``).join('\n')}\n\n${repo.ci ? 'O CI roda os testes; se falharem, o agente corrige neste mesmo PR.' : ''}\n\n_Aberto pelo escritório de agentes._`;
        const novo = await gh('POST', `/repos/${repo.dono}/${repo.nome}/pulls`, { title: titulo, head: branch, base: repo.padrao, body: corpo });
        pr = { cliente: ordem.cliente, numero: novo.number, url: novo.html_url, branch, agente: r.agente, ordemId: ordem.id, indice, correcoes: 0 };
        prs.push(pr);
        informar?.(`🔀 ${r.agente} abriu o PR #${pr.numero} (${arquivos.length} arquivo(s)): ${pr.url}`);
      }
      Object.assign(pr, { sha, estado: 'testando', desde: new Date().toISOString(), ultimaOrdem: ordem.id });
      r.repo = { pr: pr.numero, url: pr.url, branch, arquivos: arquivos.map((a) => a.caminho), estado: 'testando' };
      await gravar();
      mudou(ordem);
      console.log(`[github] ${r.agente}: ${arquivos.length} arquivo(s) em ${pr.url}`);
    } catch (erro) {
      console.error(`[github] ${erro.message}`);
      r.repo = { erro: erro.message.slice(0, 200) };
      mudou(ordem);
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
      for (const r of dele) Object.assign(r.repo, { estado }, pr.preview ? { preview: pr.preview } : {});
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
      marcar(pr, 'conflito');
      avisar?.(`⚠️ Não consegui mesclar o ${pr.url} (${erro.message.slice(0, 120)}). Veja no GitHub.`);
    }
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
    const url = await enderecoDeploy(repo, pr.sha);
    if (!url) return;
    const primeiro = !pr.preview;
    pr.previewSha = pr.sha;
    marcar(pr, pr.estado, { preview: url });
    if (primeiro) informar?.(`🔎 Preview do PR #${pr.numero}: ${url}`);
    await gravar();
  }

  // Depois do merge: o endereço de produção do projeto.
  async function procurarProducao(pr, repo) {
    const url = await enderecoDeploy(repo, pr.mergeSha);
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

  // Acompanha os PRs abertos pelo escritório: CI, revisão, preview e produção.
  async function conferir() {
    for (const pr of prs) {
      const repo = repos[pr.cliente];
      if (!repo) continue;
      try {
        if (pr.estado === 'mesclado') {
          if (pr.mergeSha && pr.producaoOk === undefined) await procurarProducao(pr, repo);
          continue;
        }
        if (pr.estado === 'revisando') { await procurarPreview(pr, repo); await veredito(pr, repo); continue; }
        if (pr.estado !== 'testando') continue;
        await procurarPreview(pr, repo);
        const { check_runs: checks = [] } = await gh('GET', `/repos/${repo.dono}/${repo.nome}/commits/${pr.sha}/check-runs`);
        const minutos = (Date.now() - Date.parse(pr.desde)) / 60000;
        if (!checks.length) {
          if (minutos > SEM_CI_MIN) await revisar(pr, repo); // sem CI no repositório: segue para a revisão
          continue;
        }
        if (checks.some((c) => c.status !== 'completed')) continue;
        const falhas = checks.filter((c) => !['success', 'skipped', 'neutral'].includes(c.conclusion));
        if (!falhas.length) { await procurarPreview(pr, repo); await revisar(pr, repo); continue; }
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
    console.log(`[github] ligado: cada projeto vira um repositório${revisao ? ', o QA revisa cada PR' : ''}${autoMerge ? ', merge automático quando o CI passa' : ''}`);
  }

  const repoDe = (cliente) => repos[cliente] || null;

  return { carregar, iniciar, ativo, publicarEntrega, arvore, repoDe, conferir, garantirRepo };
}
