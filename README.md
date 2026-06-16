# OfferFactory.ai — interview feedback SaaS prototype

Next.js + TypeScript prototype for uploading IT interview recordings, transcribing them with AssemblyAI, running an LLM analysis through OpenAI or Anthropic, and continuing a stateful chat with explicit memory layers.

## Memory model

The implementation keeps memory layers physically separate:

- `conversation_messages`: working memory for the post-analysis chat. The prompt builder sends only the latest N messages.
- `interviews.task_memory`: task memory for one interview: company, role, target level, interview type, assets, transcript, mistakes, strengths, weaknesses and final feedback.
- `profile_memory`: long-term user memory. Writes require `confirm: true` through `/api/memory/profile`; analysis can only propose `candidateProfileMemory`.
- `knowledge_memory`: product knowledge, not bound to a user.
- `memory_audit_events`: audit trail for layer writes and rejected profile-memory writes.

Postgres stores JSONB payloads for task memory, LLM output, provider metadata and prompt variables. `profile_memory.embedding` and `knowledge_memory.embedding` are `vector(1536)` columns for future RAG.

## Main routes

- `POST /api/interviews` creates an interview task.
- `POST /api/interviews/:id/actions` handles `presign_upload`, `register_url_asset`, `mark_uploaded`, `transcribe`, `analyze` and `chat`.
- `GET/PUT /api/admin/settings` configures LLM/STT models, prompts, prompt variables, MCP and RAG placeholders.
- `GET/POST /api/memory/profile` lists and explicitly writes profile memory.
- `GET/POST /api/memory/knowledge` lists and writes knowledge memory.

## Railway deployment

1. Create a Railway project from this GitHub repository.
2. Add a PostgreSQL service.
3. Add the variables from `.env.example` to the web service.
4. Use `npm install` as the install command, `npm run build` as the build command and `npm start` as the start command.
5. Make sure the Postgres database supports the `vector` extension. The app runs `create extension if not exists vector` on first DB access.
6. Configure an S3-compatible bucket and CORS rule that allows browser `PUT` uploads from the Railway domain.

The app signs S3 URLs itself and does not require an AWS SDK. Use `S3_ENDPOINT` as the origin of an S3-compatible API endpoint; keys are signed path-style as `/bucket/key`.
