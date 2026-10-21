# Runbook: proposta → contrato assinado no GHL

Passo a passo para ligar a automação do jeito que a Lilian decidiu: **proposta e ficha
dentro do GHL**, contrato assinado no D4Sign, kanban próprio para a Thalia.

Conta: `lhAxiQzL8BzjfeRRiQB2` · Levantado em 20/10/2026 (179 campos, 173 workflows, 8 funis).

## Onde estamos

| Fase | Estado |
|---|---|
| 1. Campos da ficha | ✅ 29 criados · conta foi a 208 campos |
| 2. Funil da Thalia | ✅ `Contratos (Jurídico)` com 5 fases |
| 3. Formulário da ficha | ✅ `Ficha de Contrato - Aceite da Proposta` · 23 campos, condicional PF/PJ testada |
| 4. Botão na proposta | ⬜ próxima |
| 5. E-mail da proposta | ⬜ |
| 6. Workflow do aceite | ✅ `Proposta aceita → Contrato` publicado e testado nas duas ramificações |
| 7. Contratos pendentes | 🔒 trava nas respostas da Lilian |
| 8. D4Sign | 🔒 trava no acesso de API |
| 9. Teste ponta a ponta | ⬜ |

> **Os nomes de menu do GHL mudam entre versões.** Onde o rótulo não bater exatamente,
> procure pela função descrita, não pelo texto literal.

---

## Fase 0 — Três respostas que travam passos adiante

Dá para começar sem elas, mas estes passos ficam parados:

| Pendência | Trava o quê | Quem responde |
|---|---|---|
| O plano do D4Sign tem acesso de API? | Fase 8 (assinatura volta sozinha) | Lilian |
| A partir de quantos dias o contrato está atrasado? | Fase 7 (aviso de pendentes) | Lilian |
| Quem recebe o aviso, além da Thalia? | Fase 7 | Lilian |

Sem o D4Sign por API, o fluxo **funciona igual**, só que a Thalia arrasta o card
quando a autora assinar. Não é bloqueio, é só menos automático.

---

## Fase 1 — Criar os campos da ficha

São 30 campos. Criar na mão é onde nasce campo duplicado: a conta **já tem dois CPFs
diferentes** ("CPF/CNPJ" e "Digite abaixo o seu CPF completo") exatamente por isso.

⚠️ **Rode de dentro da pasta `agente`.** O `.env` com o token mora lá e só lá. Chamando
da raiz do repositório, o script não acha `GHL_API_TOKEN` e para antes de fazer nada.

```bash
cd "C:\Users\Paulo\Documents\Agende SDR LC\agente"
```

Simulação, não escreve nada:

```bash
node scripts/criar-campos-contrato.mjs
```

Confira a lista e então aplique:

```bash
node scripts/criar-campos-contrato.mjs --aplicar
```

O script é idempotente: campo que já existe é pulado, nunca duplicado. Ao final ele
imprime os IDs. **Guarde essa saída**, você vai usar nas fases 3 e 6.

Todos levam o prefixo `Contrato - ` de propósito, para agrupar na listagem e não se
misturar com os 179 que já existem.

Dois campos da lista não estão na ficha, mas o fluxo precisa deles:

- **`Contrato - Proposta Aceita Em`** (data): é o **gatilho** do workflow da fase 6.
- **`Contrato - Documento Assinado`** (upload): onde o contrato assinado fica anexado.

### Depois de criar, arrumar a base

Na interface, em **Configurações → Campos personalizados**:

1. Decida qual CPF é o oficial. Sugestão: usar o novo `Contrato - CPF` para contrato e
   deixar os antigos quietos (não apague, tem dado de lead lá dentro).
2. Confirme que o campo de endereço antigo (`Qual o endereço para entrega...`) continua
   sendo só de **entrega de livro**. O endereço do contrato agora é `Contrato - Endereço`.

---

## Fase 2 — Criar o kanban da Thalia

A API do GHL não cria funil, isso é na interface.

**Menu lateral `Leads` → aba `Pipelines` (no topo) → criar**

> ⚠️ A conta da LC é white label e traduzida. O caminho padrão do GHL
> ("Opportunities → Pipelines") **não** existe com esse nome aqui: o menu lateral chama
> `Leads` e a aba chama `Pipelines`.

Nome: `Contratos (Jurídico)`

Estágios, nesta ordem:

| # | Estágio | O que significa |
|---|---|---|
| 1 | A produzir | Entrou sozinho pelo aceite da autora |
| 2 | Em produção | Thalia está redigindo |
| 3 | Enviado para assinatura | Saiu pelo D4Sign. **É aqui que o contrato encalha** |
| 4 | Assinado | Documento assinado anexado ao contato |
| 5 | Encerrado | Saiu para o fluxo de trabalho |

Na coluna **Probabilidade**, troque os padrões `20/40/60/80` por **90, 93, 96, 99, 100**.
Esse número alimenta a aba **Previsão**, e um card só chega aqui depois da venda ganha.
Deixando baixo, contrato fechado entraria na previsão como negócio incerto.

Deixe o toggle **"Usar probabilidade ao nível de oportunidade"** desligado.

### ✅ Criado em 21/10/2026

**`Contratos (Jurídico)`** → pipelineId `2bxzdsFv14M2hKCuCkxp`

| # | Fase | ID |
|---|---|---|
| 0 | A produzir | `666186b6-7c3b-4991-a1bf-d92d805c662e` |
| 1 | Em produção | `13d7e592-16a3-464f-b916-3b545237efbd` |
| 2 | Enviado para assinatura | `ab6421f1-38ad-4b0d-a50e-df600bceaefe` |
| 3 | Assinado | `ecb38e84-e628-413a-b642-e3fca576ec72` |
| 4 | Encerrado | `a3760753-7211-42aa-a4b3-ae4de46473a4` |

Para reconferir a qualquer momento, de dentro da pasta `agente`:

```bash
node scripts/levantar-proposta-ghl.mjs
```

> **Por que funil separado e não estágios no de vendas:** a Thalia veria todos os cards
> de venda. E o funil de vendas já tem "Contrato/pagamento", que é outra coisa (é o
> estágio comercial do negócio, não a produção do documento).

---

## Fase 3 — O formulário da ficha

**Sites → Formulários → Criar formulário**

Nome: `Ficha de Contrato - Aceite da Proposta`

### Campos, na ordem

**Bloco 1, identificação**
- E-mail `(campo padrão do contato)` ← **obrigatório, não pule**
- `Contrato - Tipo de Pessoa` (Pessoa Física / Pessoa Jurídica)

> **Não existe campo "Contrato - E-mail", e isso é de propósito.** O e-mail do
> contratante é o e-mail **padrão** do contato, que é o que o GHL usa para casar a ficha
> com a pessoa certa. Criar um campo só para isso daria duas verdades para o mesmo dado.
> Os outros três e-mails (responsável, testemunha, financeiro) são pessoas diferentes e
> têm campo próprio.

**Bloco 2, pessoa física** (condicional: Tipo de Pessoa = Pessoa Física)
- Nome do Contratante, CPF, RG, Data de Nascimento, Endereço, CEP, Telefone

**Bloco 3, pessoa jurídica** (condicional: Tipo de Pessoa = Pessoa Jurídica)
- Razão Social, CNPJ, Inscrição, Endereço da Empresa, CEP da Empresa,
  Responsável Legal, CPF do Responsável, Nascimento do Responsável, E-mail do Responsável

**Bloco 4, testemunha**
- Nome da Testemunha, E-mail da Testemunha

**Bloco 5, financeiro**
- Nome do Financeiro, E-mail do Financeiro, Telefone do Financeiro

**Bloco 6, aceite**
- Elemento **Termos e Condições** (ou caixa de seleção), obrigatório, com o texto:
  *"Li e aceito a proposta comercial nas condições apresentadas."*
- Se o construtor exigir vincular a um campo personalizado, avise: criamos um campo
  do tipo CHECKBOX para isso. O registro do aceite em si fica em
  `Contrato - Proposta Aceita Em`, preenchido pelo workflow da fase 6.

### Ordem exata para montar

| # | Elemento | Tipo | Obrigatório |
|---|---|---|---|
| 1 | Texto de abertura | bloco de texto | - |
| 2 | **E-mail** | campo padrão do contato | **sim** |
| 3 | Contrato - Tipo de Pessoa | lista (PF / PJ) | sim |
| 4 | Contrato - Nome do Contratante | texto | sim · *só PF* |
| 5 | Contrato - CPF | texto | sim · *só PF* |
| 6 | Contrato - RG | texto | não · *só PF* |
| 7 | Contrato - Data de Nascimento | data | sim · *só PF* |
| 8 | Contrato - Endereço | texto | sim · *só PF* |
| 9 | Contrato - CEP | texto | sim · *só PF* |
| 10 | Contrato - Telefone | telefone | sim · *só PF* |
| 11 | Contrato - Razão Social | texto | sim · *só PJ* |
| 12 | Contrato - CNPJ | texto | sim · *só PJ* |
| 13 | Contrato - Inscrição Estadual/Municipal | texto | não · *só PJ* |
| 14 | Contrato - Endereço da Empresa | texto | sim · *só PJ* |
| 15 | Contrato - CEP da Empresa | texto | sim · *só PJ* |
| 16 | Contrato - Responsável Legal | texto | sim · *só PJ* |
| 17 | Contrato - CPF do Responsável | texto | sim · *só PJ* |
| 18 | Contrato - Nascimento do Responsável | data | sim · *só PJ* |
| 19 | Contrato - E-mail do Responsável | texto | sim · *só PJ* |
| 20 | Contrato - Nome da Testemunha | texto | sim |
| 21 | Contrato - E-mail da Testemunha | texto | sim |
| 22 | Contrato - Nome do Financeiro | texto | sim |
| 23 | Contrato - E-mail do Financeiro | texto | sim |
| 24 | Contrato - Telefone do Financeiro | telefone | não |
| 25 | Termos e Condições (aceite) | checkbox | **sim** |

### A condicional (onde fica e como monta)

O botão esconde-se num ícone **no topo à esquerda, ao lado do `+`, logo abaixo de
"Voltar"**. Não está no painel do campo nem no ícone de controles do topo direito (esse
é só Estilos, Temas e CSS). Abre o painel **Condições → Show/Hide Fields**.

**Monte as regras só depois de adicionar todos os campos**: o seletor da regra lista
apenas o que já existe no formulário.

1. Marque os **16 campos condicionais** (7 de PF e 9 de PJ) como **Oculto**, na caixa ao
   lado de "Obrigatório". Sem isso, a autora abre a ficha e vê os 25 campos de uma vez.
   Testemunha, financeiro e aceite **não** são ocultos.
2. Crie duas regras, usando a ação **Exibir Campos** (plural, revela o bloco inteiro
   numa ação só):

```
Regra 1
  Se:    Você vai contratar como · Is Equal To · Pessoa Física
  Então: Exibir Campos → os 7 campos de pessoa física

Regra 2
  Se:    Você vai contratar como · Is Equal To · Pessoa Jurídica
  Então: Exibir Campos → os 9 campos de pessoa jurídica
```

As condições rodam de cima para baixo, então mantenha nessa ordem.

### ⚠️ Oculto e obrigatório são mutuamente exclusivos

Confirmado na ferramenta em 21/10: marcando um campo como **Oculto**, o GHL **não deixa**
marcar **Obrigatório**. Não há configuração que contorne.

Ou seja, **os 16 condicionais nunca serão obrigatórios**. Só dá para exigir o que nunca
fica oculto:

```
Email · Você vai contratar como · Nome da testemunha · E-mail da testemunha
Responsável pelo financeiro · E-mail do financeiro · Aceite
```

Ficha totalmente em branco não passa, mas a autora pode enviar sem CPF ou sem endereço.

**A validação de verdade fica no workflow da fase 6:**

- bloco de PF ou PJ preenchido → abre o caso da Thalia normalmente
- veio incompleto → avisa o **consultor dono do lead**, com o que faltou, em vez de
  mandar uma ficha furada para a Thalia

Isso é mais confiável que campo obrigatório, que só segura quem age de boa fé.

**Alternativas, se a LC quiser trava dura no próprio formulário:** ou abandonar a
condicional e deixar os 25 campos à mostra com títulos de seção (fica longo, aumenta
abandono), ou criar **dois formulários**, um de PF e outro de PJ, cada um com tudo
obrigatório, e dois botões na proposta. Dobra a manutenção.

Os campos de serviço (`Modelo`, `Período`, `Horas por Mês`, `Valor da Mensalidade`,
`Dia de Vencimento`) **não vão no formulário**: quem preenche é o consultor, pelo
gerador de proposta, não a autora.

### Configurações do formulário

- **Após o envio:** mensagem de agradecimento, algo como *"Recebemos seu aceite. Em
  breve o contrato chega no seu e-mail."*
- **Não** redirecionar para fora: a autora precisa ver a confirmação.

### ⚠️ O ponto que faz tudo funcionar

**O campo de e-mail é o que liga a ficha ao contato certo.** O GHL casa a submissão
com o contato existente pelo e-mail. Sem ele, cada ficha cria um contato novo e o card
da autora nunca anda.

Como o SDR já cadastrou a autora com e-mail, o casamento acontece sozinho. Se quiser
garantir, dá para mandar o e-mail já preenchido pela URL do formulário.

Deixe a caixa de aceite **obrigatória**: é ela que transforma o preenchimento em aceite.

---

## Fase 4 — Ligar a proposta ao formulário

Em cada modelo de proposta (o Press LC e os 5 que a Lilian vai montar), coloque um
botão no fim:

> **Aceitar proposta e enviar meus dados**

O botão aponta para o endereço do formulário da fase 3.

Nos modelos que a Lilian fizer dentro do GHL, isso é um botão normal do construtor.
No Press LC, é um link no rodapé da proposta, substituindo a ficha impressa de hoje.

---

## Fase 5 — Enviar a proposta por e-mail

**Automação → Workflows**

Abra **primeiro** os dois que já existem e descubra qual está em uso:

| Workflow | ID |
|---|---|
| Nota link proposta (Closers) | `c1c5469d-26bd-4a2c-a729-9c5b36a1960d` |
| Vendas LCA (Closers) \| Link para proposta | `fda46ee0-e7e0-4299-bc31-778c4c9e0ea9` |

Os dois estão **publicados**. Se os dois dispararem, a anotação sai duplicada.
Desative o que não estiver em uso antes de mexer.

No que sobrar, acrescente uma ação **Enviar e-mail** depois da que cria a anotação:

- **Para:** e-mail do contato
- **Assunto:** `Sua proposta, {{contact.first_name}}`
- **Corpo:** texto curto + botão com o mesmo link da anotação

O link carrega os dados pela própria URL, exatamente como já faz hoje:

```
?modelo=press-lc&autor={{contact.first_name}}&livro={{...}}&valor={{...}}
```

> **Confira o que a anotação monta hoje** e reaproveite igual. O link já funciona,
> não vale reinventar.

---

## Fase 6 — O aceite move tudo

Workflow novo: `Proposta aceita → Contrato`

**Gatilho:** Formulário enviado = `Ficha de Contrato - Aceite da Proposta`

**Ações, nesta ordem:**

1. **Atualizar contato:** `Contrato - Proposta Aceita Em` = data de hoje
2. **Adicionar etiqueta:** `proposta-aceita`
3. **Atualizar oportunidade** no funil Vendas LCA (Closers) → estágio **Proposta Enviada**
   `696ae817-e60f-4cae-8a79-255f3a38c874`
4. **Criar oportunidade** no funil `Contratos (Jurídico)` `2bxzdsFv14M2hKCuCkxp`
   → estágio **A produzir** `666186b6-7c3b-4991-a1bf-d92d805c662e`
   - Nome: `Contrato - {{contact.first_name}} {{contact.last_name}}`
   - Responsável: **Talya Fernanda Correa** (`dAPtgmcfFfq7P2oEz9lO`)
   - **Valor: 0** ⚠️ não repita o valor do negócio aqui. O card do funil de vendas já
     carrega esse valor; repetindo, o mesmo contrato é contado duas vezes no faturamento.
5. **Notificação interna** para a Thalia: *"Proposta aceita por {{contact.first_name}}.
   Dados do contrato já estão no cadastro."*

### Referência rápida dos estágios

Funil **Vendas LCA (Closers)** `RrFpWfwZP8ZZkkGUVqnM`:

| Estágio | ID |
|---|---|
| Proposta Enviada | `696ae817-e60f-4cae-8a79-255f3a38c874` |
| Venda Realizada | `f9fef38e-deeb-480d-a13c-63bff144336f` |
| Contrato/pagamento | `dfb7ce57-62bd-483a-879e-31433093b1c3` |
| Onboarding | `5db9bb77-99a8-4486-a6b8-93fbbfeb92e6` |

### Workflow 2: `Ficha incompleta`

Workflow **separado**, mesmo gatilho. Separado de propósito: ramificação no GHL não se
junta de volta, então embutir esta validação no workflow principal obrigaria a duplicar
toda a busca do card de vendas em cada caminho.

**Gatilho:** Formulário enviado → `Ficha de Contrato - Aceite da Proposta`

**Ação única, If/Else:**

```
Se:  Contrato - CPF   está vazio
E:   Contrato - CNPJ  está vazio
```

Uma condição cobre PF e PJ: sem nenhum dos dois documentos a ficha não serve para
redigir, qualquer que seja o tipo.

**Ramificação SIM:**
1. Adicionar tag `ficha-incompleta`
2. Notificação interna por e-mail para **Proprietários atribuídos** (o closer dono do
   lead, não a Thalia: quem tem relação com a autora resolve numa mensagem)

**Ramificação NÃO:** vazia.

> Existe porque o GHL **não deixa campo oculto ser obrigatório**, então os 16
> condicionais nunca são exigidos no envio. Esta é a validação que o formulário não
> consegue fazer.

---

## Fase 7 — Contratos que encalham

O problema que a Lilian levantou: contrato enviado que ninguém cobra.

Workflow novo: `Contrato pendente de assinatura`

- **Gatilho:** oportunidade entrou no estágio **Enviado para assinatura**
  `ab6421f1-38ad-4b0d-a50e-df600bceaefe` do funil `Contratos (Jurídico)`
  `2bxzdsFv14M2hKCuCkxp`
- **Ação 1:** Esperar `N` dias ← *valor da fase 0*
- **Ação 2:** Condição — a oportunidade **ainda está** em "Enviado para assinatura"?
  - **Sim** → notificação interna para a Thalia e quem mais a Lilian indicar, com nome
    da autora e há quantos dias está parado. Criar tarefa com vencimento para hoje.
  - **Não** → encerrar, já assinou.
- **Ação 3:** repetir a espera para cobrar de novo, se ela quiser insistência.

### A diferença entre aviso e lista

O workflow nativo manda **um aviso por contrato**, no dia em que cada um atrasa.
Resolve a cobrança, mas não é a lista diária que a Lilian descreveu.

Para a **lista consolidada** ("todos os contratos pendentes, toda manhã"), o workflow
do GHL não serve: ele roda por contato, não faz resumo. Isso sai do nosso agente, que
já tem agendador e já manda aviso no grupo todo dia. É um passo seguinte, não precisa
estar pronto para o fluxo funcionar.

---

## Fase 8 — Retorno da assinatura (depende do D4Sign)

**Se o plano tiver API:**

1. No D4Sign, cadastre um webhook de "documento assinado" apontando para o nosso agente.
2. Ao receber, o agente anexa o documento em `Contrato - Documento Assinado`, move o card
   para **Assinado** e depois para **Encerrado**, e manda o caso para Onboarding.

Essa parte é nossa, não é configuração de interface.

**Se não tiver API:** a Thalia arrasta o card de "Enviado para assinatura" para
"Assinado" e anexa o PDF no campo de upload. O resto do fluxo segue igual.

---

## Fase 9 — Testar antes de soltar

Faça com um contato de teste seu, **nunca com lead real**.

1. Crie um contato com o **seu** e-mail e telefone.
2. Mova a oportunidade para disparar o workflow da fase 5. Confirme que o e-mail chegou
   e que o link abre a proposta preenchida.
3. Abra o formulário da ficha, preencha e envie.
4. Confirme, no contato:
   - os campos `Contrato - ...` preenchidos
   - a etiqueta `proposta-aceita`
   - o card movido no funil de vendas
   - **um card novo no funil Contratos, atribuído à Thalia**
5. Confirme que a Thalia recebeu a notificação.
6. Mova o card para "Enviado para assinatura" e confira se o workflow da fase 7 agendou
   a cobrança.
7. **Apague o contato de teste** quando terminar.

### Dois lembretes antes de abrir para a equipe

- A página de preview da proposta **aponta para a conta de produção**. Quem clicar em
  "Salvar no CRM" naquele link cria contato de verdade. Confira quem tem o endereço.
- Avise a equipe que a ficha impressa no rodapé da proposta **deixou de ser usada**,
  senão vão continuar pedindo os dados no WhatsApp.

---

## Anexo — IDs dos campos criados

Criados em 20/10/2026. A conta foi de 179 para **208 campos** (29 novos).
Use na montagem do formulário (fase 3) e dos workflows (fases 6 e 7).

| Campo (`Contrato - ` + nome) | ID | Tipo |
|---|---|---|
| Tipo de Pessoa | `5VzdGWfAWxdqxPFLWTsv` | SINGLE_OPTIONS |
| Nome do Contratante | `kwdIZ0zLQA67vcR1g0tQ` | TEXT |
| CPF | `h8lozsxRItx09RyQgHSC` | TEXT |
| RG | `wsRAWMcEi1pIOMYkUxWy` | TEXT |
| Data de Nascimento | `eNVcXpib4gvE3jvvvWBW` | DATE |
| Endereço | `JX2sXjEaJXAPTJc8Ew3E` | TEXT |
| CEP | `j26Snf2qorUZUW11lVov` | TEXT |
| Telefone | `rjpISPmksP3n9YKPNrYn` | PHONE |
| Razão Social | `sNU5ZC8FWjDqDxvceRXV` | TEXT |
| CNPJ | `B10RVB6djiv1lIIQOAnU` | TEXT |
| Inscrição Estadual/Municipal | `IIbaQjUM95HxQ4wp2PKj` | TEXT |
| Endereço da Empresa | `93nRPspMmS8ZBIh6zadF` | TEXT |
| CEP da Empresa | `ZcR5vQuxXXwUcutqKjip` | TEXT |
| Responsável Legal | `pOQThB90KAw37HBBVxsa` | TEXT |
| CPF do Responsável | `35K7x3bD16jUrNDfySRJ` | TEXT |
| Nascimento do Responsável | `S6F16DMY6swQInbrllzt` | DATE |
| E-mail do Responsável | `v8KnA4zqi0VidDQid3g0` | TEXT |
| Nome da Testemunha | `GTfVQtKoZytAER6Zamfe` | TEXT |
| E-mail da Testemunha | `OvxOwWLh4AN7Ccj0u4Xx` | TEXT |
| Nome do Financeiro | `TOWIkqU9VlOIXj4FfY8G` | TEXT |
| E-mail do Financeiro | `tGviV8yl4UOeASo2fExl` | TEXT |
| Telefone do Financeiro | `NCeZd2RiAxUNQqsipkVo` | PHONE |
| Modelo | `2iRxyXnieNnfLKlcyLwz` | TEXT |
| Período | `T9lqwV229zKKRxQVw441` | TEXT |
| Horas por Mês | `873W9Adrqi9zXDwoaH0C` | NUMERICAL |
| Valor da Mensalidade | `kOVB6wRx90U4QUSyfzGK` | MONETORY |
| Dia de Vencimento | `lWXPRlGvDzFYAQBfhp72` | NUMERICAL |
| **Proposta Aceita Em** | `wnZqrR4qk8NJDfanOtdS` | DATE |
| **Documento Assinado** | `cfAiPeS2DJM2HOtKj57b` | FILE_UPLOAD |

Os dois em negrito não aparecem na ficha: são o gatilho do workflow e o anexo do PDF.

> **A API não aceita `EMAIL` como tipo de campo.** Os tipos válidos são TEXT, LARGE_TEXT,
> NUMERICAL, PHONE, MONETORY, CHECKBOX, SINGLE_OPTIONS, MULTIPLE_OPTIONS, FLOAT, TIME,
> DATE e FILE_UPLOAD. Por isso os e-mails ficaram como TEXT.

---

## Ordem recomendada

Fase 1 e 2 podem ser feitas hoje, não dependem de ninguém. A fase 3 depende da 1.
As fases 5 e 6 dependem da 3. A 7 depende das respostas da fase 0. A 8 depende do D4Sign.

Os 5 modelos de proposta da Lilian correm **em paralelo** e não travam nada: o fluxo
funciona com um modelo só e vale igual para os outros quando entrarem.
