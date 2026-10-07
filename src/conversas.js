// Conversas das pausas: diálogos de verdade (um fala, o outro responde), com
// frases de cada função e assuntos do trabalho real (clientes, últimas entregas).
//
// Cada diálogo é uma lista de falas; "A" é quem puxa o assunto, "B" quem responde
// e "C" um terceiro (na mesa de reunião). Marcadores:
//   {outro}   nome de quem está ouvindo        {cliente}  um cliente cadastrado
//   {entrega} o que quem fala entregou por último
// Regras para não ficar sem sentido:
//   quem  — só puxa esse assunto quem tem essa função (ex.: o QA fala dos testes)
//   menciona — o diálogo fala dessa pessoa: não é usado se ela estiver na roda
//   precisa — 'cliente' ou 'entrega': só aparece se houver esse contexto

const DIALOGOS = [
  // gerais
  { falas: [['A', 'Café?'], ['B', 'Bora, tô precisando.'], ['A', 'Hoje o dia tá puxado.']] },
  { falas: [['A', 'E aí, {outro}, como tá aí?'], ['B', 'Corrido, mas andando. E você?'], ['A', 'Mesma coisa. Uma pausa ajuda.']] },
  { falas: [['A', 'Esse café tá mais forte hoje.'], ['B', 'Alguém exagerou no pó 😅']] },
  { falas: [['A', 'Fez o que no fim de semana?'], ['B', 'Descansei, finalmente.'], ['A', 'Merecido.']] },
  { falas: [['A', 'Tô pensando em refatorar uma parte do código.'], ['B', 'Faz em PR pequeno, fica mais fácil de revisar.'], ['A', 'Boa ideia.']] },
  { falas: [['A', 'Viu que o último deploy passou liso?'], ['B', 'Vi! Nenhum erro no log.'], ['A', 'Assim que eu gosto.']] },
  { falas: [['A', '{outro}, depois me mostra como você resolveu aquela parte?'], ['B', 'Mostro sim, é mais simples do que parece.']] },
  { falas: [['A', 'Água gelada, finalmente.'], ['B', 'O bebedouro tava quente ontem, né?']] },
  { falas: [['A', 'Qual stack você usaria num app novo hoje?'], ['B', 'Depende do cliente… mas TypeScript em tudo.'], ['A', 'Concordo.']] },
  // com o trabalho real
  { precisa: 'cliente', falas: [['A', 'O projeto {cliente} tá ficando bom, hein.'], ['B', 'Tá sim! O cliente vai gostar.']] },
  { precisa: 'cliente', falas: [['A', 'Qual a próxima etapa do projeto {cliente}?'], ['B', 'O Tech Lead vai definir na próxima rodada.']], menciona: ['orquestrador'] },
  { precisa: 'entrega', falas: [['A', 'Acabei de entregar: {entrega}.'], ['B', 'Boa! Rápido, hein.'], ['A', 'Agora é esperar o CI passar.']] },
  { precisa: 'entrega', falas: [['A', 'Terminei {entrega}.'], ['B', 'Show. Precisa de revisão?'], ['A', 'O QA já vai dar uma olhada.']], menciona: ['qa'] },
  // de cada função (quem puxa o assunto)
  { quem: 'qa', falas: [['A', '{outro}, testei sua última entrega. Ficou redondinha.'], ['B', 'Ufa! Valeu pelo cuidado.']] },
  { quem: 'qa', falas: [['A', 'Achei um caso de borda no cadastro, já pedi o ajuste.'], ['B', 'Ainda bem que você pegou antes do cliente.']] },
  { quem: 'backend', falas: [['A', 'Subi a API nova. Se precisar de algum endpoint, me chama.'], ['B', 'Valeu, vou integrar hoje.']] },
  { quem: 'backend', falas: [['A', 'Esse banco tá precisando de um índice.'], ['B', 'Tá lento?'], ['A', 'Um pouco. Resolvo depois do café.']] },
  { quem: 'frontend', falas: [['A', 'A tela nova ficou ótima no celular.'], ['B', 'Testou em tela pequena também?'], ['A', 'Testei, tá tudo certo.']] },
  { quem: 'designer', falas: [['A', '{outro}, o que achou das cores novas?'], ['B', 'Ficaram ótimas, bem mais limpo.'], ['A', 'Que bom! Deu trabalho achar o tom.']] },
  { quem: 'designer', falas: [['A', 'Tô montando o protótipo da próxima tela.'], ['B', 'Manda o link quando terminar.']] },
  { quem: 'devops', falas: [['A', 'O backup de hoje rodou certinho.'], ['B', 'Boa, dá pra dormir tranquilo.']] },
  { quem: 'devops', falas: [['A', 'O servidor tá com folga de memória.'], ['B', 'Então dá pra subir mais um projeto?'], ['A', 'Dá sim.']] },
  { quem: 'documentador', falas: [['A', 'Atualizei a documentação. Dá uma olhada quando puder.'], ['B', 'Pode deixar, eu leio hoje.']] },
  { quem: 'requisitos', falas: [['A', 'O cliente pediu mais uma tela.'], ['B', 'Clássico 😄 Já tá no backlog?'], ['A', 'Já, prioridade média.']] },
  { quem: 'requisitos', precisa: 'cliente', falas: [['A', 'Revisei as regras de negócio do projeto {cliente}.'], ['B', 'Mudou muita coisa?'], ['A', 'Só o fluxo de pagamento.']] },
  { quem: 'orquestrador', falas: [['A', 'Como estão as tarefas, {outro}?'], ['B', 'Quase tudo pronto, falta revisar.'], ['A', 'Perfeito, me avisa quando subir.']] },
  { quem: 'orquestrador', minimo: 3, falas: [['A', 'Bom trabalho essa semana, pessoal.'], ['B', 'Valeu! O time tá afiado.']] },
  // na reunião, com três
  { minimo: 3, falas: [['A', 'Bom, vamos alinhar rapidinho?'], ['B', 'Do meu lado tá tudo andando.'], ['C', 'Do meu também, sem bloqueio.'], ['A', 'Ótimo, então seguimos.']] },
  { minimo: 3, falas: [['A', 'Alguém precisa de ajuda com alguma coisa?'], ['B', 'Por enquanto não.'], ['C', 'Talvez mais tarde, com os testes.']] },
];

const sortear = (lista) => lista[Math.floor(Math.random() * lista.length)];

// grupo: ids de quem está na roda (o primeiro puxa o assunto); nomeDe(id) → nome;
// contexto: { clientes: [nomes], recentes: { id: 'o que entregou' } }
export function montarConversa(grupo, nomeDe, contexto = {}) {
  if (grupo.length < 2) return [];
  const clientes = contexto.clientes || [];
  const recentes = contexto.recentes || {};
  const papeis = { A: grupo[0], B: grupo[1], C: grupo[2] || grupo[0] };
  const opcoes = DIALOGOS.filter((d) => {
    if (d.minimo && grupo.length < d.minimo) return false;
    if (d.quem && d.quem !== papeis.A) return false;
    if (d.menciona?.some((id) => grupo.includes(id))) return false; // não fala de quem está na roda
    if (d.precisa === 'cliente' && !clientes.length) return false;
    if (d.precisa === 'entrega' && !recentes[papeis.A]) return false;
    return true;
  });
  // assuntos da função e do trabalho real têm mais chance de sair
  const pesadas = opcoes.flatMap((d) => (d.quem || d.precisa ? [d, d, d] : [d]));
  const d = sortear(pesadas.length ? pesadas : DIALOGOS.filter((x) => !x.quem && !x.precisa && !x.menciona && !x.minimo));
  const cliente = sortear(clientes) || 'o projeto';
  return d.falas.map(([papel, texto]) => {
    const quem = papeis[papel];
    const ouvinte = papel === 'A' ? papeis.B : papeis.A;
    return {
      id: quem,
      texto: texto.replaceAll('{outro}', nomeDe(ouvinte)).replaceAll('{cliente}', cliente).replaceAll('{entrega}', recentes[quem] || 'aquela tarefa'),
    };
  });
}
