# Contrato de leitura retomado em 16/11/2026

Branch `codex/read-state-sync-1611`, base `19ec67b`, cherry-pick do PR #2 (`70451ee38594f13b22034c36c3e6bb13858b1587`). Os conflitos foram resolvidos preservando os participantes de grupos, o mapeamento telefone/LID e os eventos adicionados depois de setembro.

## Contrato

`GET /chat/readStateCapabilities/:instance` usa os guards de autenticação/instância das rotas de chat e devolve `{ "lastMessages": 1 }`, sem modificar chats. O CRM novo exige essa resposta antes de qualquer POST de leitura; uma Evolution antiga sem essa rota fica bloqueada, com log sanitizado no CRM. Não há fallback após falhar a consulta. A capacidade é por versão de código, não uma prova de conexão com aparelho.

`markMessageAsRead` e `markChatUnread` recebem `lastMessages`: de 1 a 500 mensagens originais, em ordem inversa, terminando na última recebida. Todos os itens anteriores devem ser enviados. São obrigatórios chave, JID único, ID único, `fromMe` booleano e timestamp inteiro em segundos, entre 100000000 (inclusive) e 100000000000 (exclusive), não crescente. Grupos recebidos exigem participante. O serviço valida antes de traduzir telefone/LID; a tradução preserva IDs, participantes e timestamps. A validação ocorre antes de chamar `chatModify` ou enviar recibos.

Não se consulta o histórico no banco para provar que o caller não omitiu mensagens: o CRM precisa fornecer a sequência original completa. A validação do fork verifica o contrato estrutural, não a autenticidade de um histórico inventado por um cliente autenticado.

## Compatibilidade e ordem

O CRM atual manda `lastMessage` isolado. **Não há compatibilidade total:** o fork aceita esse alias quando é uma mensagem recebida válida, mas rejeita cursor enviado isolado com 400 antes do SDK. Recibos legados sem cursor continuam aceitos. `markChatUnread` sem cursor só funciona se a última mensagem encontrada formar um intervalo válido; não fabrica timestamp para completar o pedido.

Desligar o flag do CRM durante a publicação; validar em homologação com números exclusivos de teste; publicar este fork primeiro e depois o CRM novo; reativar somente com aprovação do dono e gate de CI atendido. Na continuação do card, o caller de grupos do CRM também foi convertido para `lastMessages` original completo: enviada(s) seguidas da primeira recebida, com cada participante original PN/LID. O fork já suporta esse formato sem alteração de código de produção. Foram acrescentados testes de preservação de participantes, endereçamento e rejeição antes do SDK. O CRM antigo continua incompatível com cursor enviado isolado; publicar o par de branches, não apenas o fork. No rollback, suspender comandos antes de trocar o fork, evitando a janela entre consulta de capacidade e POST.

O risco do par atual não é apenas incompatibilidade HTTP: `19ec67b` aceita o cursor sintético do CRM e pode construir patch com intervalo incompleto/horário local. Nenhum acesso a produção ou aparelho foi feito nesta tarefa. O roteiro de aparelho está em `pegasus-crm/docs/reports/crm-leitura-evo-1611.md`.

## Conferência da primeira etapa

O script `npm test` aponta para `test/all.test.ts`, que não está na base. A suíte existente foi executada diretamente com `npx tsx --test test/*.test.ts`: **76 aprovados, 0 pulados, 0 falhas** na execução final. Houve uma execução intermediária com 75 aprovados e 1 falha, corrigida no fixture LID que ainda usava cursor isolado.

`npx prisma generate --schema ./prisma/postgresql-schema.prisma` gerou apenas o cliente local, sem conexão ou migração. `npm run build` (TypeScript + tsup) passou com código 0 na execução final. A primeira execução falhou com um TS2322 entre timestamp opcional do DTO legado e intervalo validado; o tipo retornado pela validação foi corrigido. Testes direcionados antes da implementação reproduziram 6 falhas no contrato novo contra a base antiga. O build e os testes não substituem validação com aparelho nem a CI bloqueada por cobrança.

## Continuação: grupos

Conferência desta continuação registrada após uma execução da suíte e uma do build. Para respeitar esse limite, os hooks locais que repetiriam build/lint no commit/push não são executados novamente; os comandos de verificação são executados explicitamente antes da publicação. Nenhuma configuração global ou hook foi alterado.

Continuação: `npx tsx --test test/*.test.ts`: **78 aprovados | 0 pulados | 0 falhas**, código 0. `npm run build`: **código 0**, TypeScript e bundles CJS/ESM concluídos. Uma execução de cada nesta continuação; o cliente Prisma foi gerado localmente, sem conexão nem migração de banco.
