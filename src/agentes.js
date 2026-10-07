// Equipe do escritório. Cada agente ganha uma mesa e um bonequinho.
// Para conectar um motor seu, use o mesmo `id` ao enviar status (ver README).
//
// estilo — penteado: curto | topete | calvo | rabo | volumoso | coque | longo | baguncado
// barba — 'curta' | 'cheia' · feminina — cílios, brincos (cor em brinco) e silhueta mais fina
//
// atividade — o que o bonequinho faz quando está "trabalhando":
//   digitar   → digita no teclado (código, textos)
//   ler       → lê um documento nas mãos
//   telefone  → fala ao telefone (atendimento, vendas)
//   desenhar  → desenha numa mesa digitalizadora (design)
//   analisar  → mexe no mouse olhando gráficos (dados, relatórios)
//   quadro    → levanta e escreve no quadro branco (planejamento, orquestração)

export const AGENTES = [
  { id: 'orquestrador', nome: 'Tech Lead',     funcao: 'Arquitetura e distribuição das tarefas', atividade: 'quadro',   cor: '#e5484d', cabelo: '#2b1d14', pele: '#f1c27d', estilo: 'topete', barba: 'curta' },
  { id: 'requisitos',   nome: 'Requisitos',    funcao: 'Regras de negócio e histórias de usuário', atividade: 'ler',    cor: '#4c8dff', cabelo: '#111111', pele: '#c68642', estilo: 'volumoso', feminina: true },
  { id: 'designer',     nome: 'Designer UI/UX', funcao: 'Telas, fluxos e design system',        atividade: 'desenhar', cor: '#b05cf0', cabelo: '#e8b04a', pele: '#f1c27d', estilo: 'rabo', feminina: true },
  { id: 'frontend',     nome: 'Front-end',     funcao: 'Sites e telas (HTML, CSS, React)',       atividade: 'digitar',  cor: '#2ec4d6', cabelo: '#5a3825', pele: '#ffdbac', estilo: 'baguncado' },
  { id: 'backend',      nome: 'Back-end',      funcao: 'APIs, banco de dados e integrações',     atividade: 'digitar',  cor: '#3fb27f', cabelo: '#1a1a1a', pele: '#e0ac69', estilo: 'curto', barba: 'cheia' },
  { id: 'qa',           nome: 'QA',            funcao: 'Testes, code review e segurança',        atividade: 'analisar', cor: '#8e99ad', cabelo: '#6f6f75', pele: '#c68642', estilo: 'calvo' },
  { id: 'devops',       nome: 'DevOps',        funcao: 'Deploy, Docker, VPS e backups',          atividade: 'analisar', cor: '#f07a3a', cabelo: '#3b2a20', pele: '#8d5524', estilo: 'curto', barba: 'curta' },
  { id: 'documentador', nome: 'Documentador',  funcao: 'Documentação técnica e manuais',         atividade: 'digitar',  cor: '#e0b23c', cabelo: '#a0522d', pele: '#ffdbac', estilo: 'coque', feminina: true, brinco: '#e11d2a' },
];

// Você! O seu bonequinho fica na mesa do chefe e leva as ordens até a equipe.
export const CHEFE = { id: 'chefe', nome: 'Você', funcao: 'Chefe', cor: '#22314f', cabelo: '#2b1d14', pele: '#f1c27d' };

// Estados aceitos e a cor de cada um.
export const STATUS = {
  ocioso:      { rotulo: 'ocioso',      cor: '#8e99ad' },
  trabalhando: { rotulo: 'trabalhando', cor: '#3fb27f' },
  aguardando:  { rotulo: 'aguardando',  cor: '#e0b23c' },
  concluido:   { rotulo: 'concluído',   cor: '#4c8dff' },
  erro:        { rotulo: 'erro',        cor: '#e5484d' },
};
