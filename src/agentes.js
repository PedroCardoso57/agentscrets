// Equipe do escritório. Cada agente ganha uma mesa e um bonequinho.
// Para conectar um motor seu, use o mesmo `id` ao enviar status (ver README).
//
// atividade — o que o bonequinho faz quando está "trabalhando":
//   digitar   → digita no teclado (código, textos)
//   ler       → lê um documento nas mãos
//   telefone  → fala ao telefone (atendimento, vendas)
//   desenhar  → desenha numa mesa digitalizadora (design)
//   analisar  → mexe no mouse olhando gráficos (dados, relatórios)
//   quadro    → levanta e escreve no quadro branco (planejamento, orquestração)

export const AGENTES = [
  { id: 'orquestrador', nome: 'Orquestrador', funcao: 'Planeja e distribui tarefas', atividade: 'quadro',   cor: '#e5484d', cabelo: '#2b1d14', pele: '#f1c27d' },
  { id: 'pesquisador',  nome: 'Pesquisador',  funcao: 'Pesquisa e coleta dados',      atividade: 'ler',      cor: '#4c8dff', cabelo: '#111111', pele: '#c68642' },
  { id: 'redator',      nome: 'Redator',      funcao: 'Escreve conteúdos',            atividade: 'digitar',  cor: '#3fb27f', cabelo: '#a0522d', pele: '#ffdbac' },
  { id: 'designer',     nome: 'Designer',     funcao: 'Cria peças visuais',           atividade: 'desenhar', cor: '#b05cf0', cabelo: '#e8b04a', pele: '#f1c27d' },
  { id: 'analista',     nome: 'Analista',     funcao: 'Analisa métricas',             atividade: 'analisar', cor: '#e0b23c', cabelo: '#3b2a20', pele: '#8d5524' },
  { id: 'programador',  nome: 'Programador',  funcao: 'Automatiza e integra',         atividade: 'digitar',  cor: '#2ec4d6', cabelo: '#1a1a1a', pele: '#e0ac69' },
  { id: 'atendimento',  nome: 'Atendimento',  funcao: 'Responde clientes',            atividade: 'telefone', cor: '#f07a3a', cabelo: '#5a3825', pele: '#ffdbac' },
  { id: 'revisor',      nome: 'Revisor',      funcao: 'Revisa e aprova entregas',     atividade: 'ler',      cor: '#8e99ad', cabelo: '#9a9a9a', pele: '#c68642' },
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
