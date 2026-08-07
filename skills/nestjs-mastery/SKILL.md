---
name: nestjs-mastery
description: Gunakan skill ini ketika merancang arsitektur Enterprise TypeScript, Dependency Injection IoC internals, Hexagonal Ports & Adapters, Fastify Engine tuning, Prisma/Drizzle ORM performance, Microservices gRPC/Kafka/NATS, Apollo GraphQL Federation v2, Multi-Tenancy RLS, AI Scout/pgvector/LangChain, Fintech ACID 2PC, atau Zero-Trust security di NestJS.
---

# NestJS Enterprise Mastery

SSOT arsitektur backend TypeScript enterprise (36 Domain, 139 Berkas). Zero-Tolerance: DILARANG `// TODO`, secret statis di kode, dan `any` bypass.

## 🏛️ Pilar Arsitektur Mutlak

| Pilar | Hukumnya |
| :--- | :--- |
| **Fastify First** | `@nestjs/platform-fastify` adalah adapter HTTP utama. Express DILARANG jadi default — lamban dan boros I/O. |
| **Hexagonal & DDD** | Direktori WAJIB dipisah per *Bounded Context* + *Ports & Adapters*. Business logic di core, buta terhadap DB eksternal maupun protokol HTTP/gRPC. |
| **Zero `any` Bypass** | `any` / `Object` / `unknown` tanpa validasi runtime ketat (Zod, Ajv, TypeBox, atau class-validator `whitelist: true`) DILARANG. |
| **Non-Blocking Event Loop** | Komputasi CPU-bound masif (hashing, kriptografi, Excel gb-scale) WAJIB keluar dari main event loop → Piscina Worker Threads atau `napi-rs`. |
| **Zero-Trust & OWASP** | JWKS asimetris / OIDC di HTTP-Only Secure Cookie · RBAC/ABAC lewat `Reflector` · throttling Redis Valkey di pintu masuk. |

## 🚦 Protokol Eksekusi (WAJIB dibaca sesuai situasi)

> **SEBELUM membuka tabel di bawah:** Jika ini adalah proyek baru atau keputusan arsitektur besar, WAJIB lewati Master Decision Tree (`~/.gemini/config/skills/master-decision-tree/SKILL.md`) terlebih dahulu. DILARANG langsung memilih NestJS sebagai stack tanpa justifikasi dari Decision Tree.

| Situasi | WAJIB baca dulu sebelum menulis apa pun |
| :--- | :--- |
| Inisiasi project baru dari nol | `references/_protocol/greenfield.md` |
| Tambah fitur / refactor / optimasi / audit di repo eksisting | `references/_protocol/brownfield.md` |
| Keputusan arsitektur / menantang pilihan stack (Challenger Mode §4) | `references/_protocol/tradeoff.md` |
| Proyek berada di dalam repo Git — branching, atomic commit, Conventional Commits | `~/.gemini/config/skills/git-workflow/SKILL.md` (§3.9 `AGENTS.md`) |

DILARANG membuat dokumen RFC (`docs/rfc/`) atau menulis kode sebelum protokol yang relevan dibaca tuntas.

---

## 📦 Core References (WAJIB Baca Setiap Project NestJS)

Fondasi Fardu Ain — relevan di 100% produksi NestJS enterprise, apa pun bentuk tasknya.
Kolom **Rujukan Utama** menyebut nama berkas nyata di disk; jalankan `scripts/audit_references.ps1` bila curiga melenceng.

| Domain | Referensi | Rujukan Utama yang Tersedia |
| :--- | :--- | :--- |
| **Arsitektur Inti** | `references/core_arch_patterns/` | ioc_container_internals, hexagonal_ports_adapters, domain_driven_design_bounded_context, cqrs_event_sourcing_engine, dynamic_modules_forroot_builder, interceptors_rxjs_aop |
| **HTTP Engine Fastify** | `references/http_engine_fastify/` | express_to_fastify_migration_guide, json_schema_ajv_validation_speed, fastify_multipart_streaming_big_uploads, websocket_fastify_ws_adapter |
| **DB & Persistence ORM** | `references/db_persistence_orm/` | prisma_high_performance_tuning, drizzle_orm_zero_overhead_sql, typeorm_transactional_decorators, mongodb_mongoose_schema_virtuals, redis_valkey_in_memory_persistence, zero_downtime_schema_migrations |
| **Validasi & Serialisasi** | `references/validation_serialization/` | class_validator_transformer_deep_dive, high_performance_zod_typebox_pipes, custom_decorators_async_validators, dto_security_shield_payload_stripping |
| **Konfigurasi & Env** | `references/configuration_env_management/` | zod_joi_schema_validation_env_startup, hashicorp_vault_dynamic_secret_injection, namespace_config_registeras_injection |
| **Security OWASP Zero-Trust** | `references/security_owasp_zerotrust/` | jwks_oidc_stateless_auth, rbac_abac_reflector_guards, owasp_top10_fastify_helmet, ddos_mitigation_redis_throttler, sqli_nosqli_sanitization, argon2id_password_hashing_encryption |
| **Identity, SSO & Passkeys** | `references/identity_iam_sso_mfa/` | passkeys_fido2_webauthn_biometric, oauth2_oidc_social_sso_pkce, totp_mfa_sms_otp_throttling, session_revocation_device_tracking |
| **Testing & QA** | `references/testing_quality_qa/` | jest_swc_supercharged_suite, e2e_fastify_inject_testing, mocking_di_container_overrides, mutation_testing_stryker, testcontainers_docker_qa |
| **Observability & APM** | `references/observability_apm_metrics/` | otel_distributed_tracing_grpc, prometheus_grafana_red_metrics, pino_zero_allocation_json_logger, global_exception_filter_serialization, async_local_storage_context_tracking |
| **Structured Logging** | `references/structured_logging_telemetry/` | pino_async_destination_elasticsearch, sentry_error_tracking_source_maps, winston_daily_rotate_archive_retention, audit_trail_immutable_user_activity_log |
| **Caching Strategy & CDN** | `references/caching_strategy_cdn/` | multi_tier_cache_manager_valkey, cache_stampede_dogpile_atomic_locks, tenant_tagged_cache_invalidation, cdn_stale_while_revalidate_etag |
| **File Storage & Object CDN** | `references/file_storage_object_cdn/` | s3_r2_presigned_direct_upload, multipart_chunked_resumable_streams, sharp_image_worker_pipeline, secure_acl_expiring_document_links |
| **Omnichannel Notifications** | `references/omnichannel_notifications_mail/` | email_engine_resend_ses_dkim, fcm_apns_push_notifications_batching, whatsapp_twilio_sms_otp_fallback, in_app_notification_center_inbox |
| **Concurrency & Runtime** | `references/concurrency_runtime_internals/` | v8_libuv_event_loop_phases, worker_threads_piscina_offloading, bun_runtime_dual_compatibility, memory_leak_hunting_heap_snapshots |
| **Background Jobs & Queues** | `references/background_jobs_queues/` | bullmq_advanced_queue_workers, distributed_lock_cron_scheduling, exponential_backoff_retry_dlq, queue_job_observability_arena |
| **Docker & Container** | `references/docker_container_standards/` | multi_stage_distroless_alpine, non_root_user_sigterm_graceful_shutdown, corepack_pnpm_docker_caching, k8s_terminus_health_probes, modular_3tier_container_topology |

## 🎯 Context References (Baca Sesuai Kebutuhan)

Dipicu saat sistem tumbuh ke mikroservice, event-driven, atau konkurensi tinggi.

| Konteks / Keyword | Baca Referensi | Rujukan Utama yang Tersedia |
| :--- | :--- | :--- |
| gRPC, Protobuf, deadline, circuit breaker antar-service | `references/microservices_grpc/` | protobuf_schema_evolution_tsproto, grpc_streaming_bidirectional_pipelines, deadline_propagation_circuit_breaker, transactional_outbox_pattern_grpc |
| Kafka, RabbitMQ, NATS, Redis Streams, DLQ, consumer group | `references/message_brokers_event_streaming/` | kafka_consumer_groups_commit_offset, rabbitmq_amqp_dlq_topic_routing, nats_jetstream_distributed_persistence, redis_streams_event_sourcing_log |
| GraphQL, Apollo Federation, subgraph, DataLoader, N+1 resolver | `references/api_graphql_federation/` | code_first_vs_schema_first_enterprise, apollo_federation_v2_subgraph_gateway, dataloader_nplus1_mitigation_engine |
| WebSocket, SSE, real-time, chat, streaming, heartbeat | `references/realtime_websocket_sse/` | websocket_gateway_wsguard_security, server_sent_events_sse_ai_streaming, redis_pubsub_ws_adapter_cluster, heartbeat_pingpong_connection_harvesting |
| CQRS, command/query bus, event store, read model projection | `references/cqrs_event_sourcing/` | nestjs_cqrs_command_query_bus_setup, event_store_db_append_events_stream, read_model_projection_denormalization |
| Search, katalog, faceted filter, Meilisearch, Elasticsearch, CDC | `references/search_engine_catalog_indexing/` | meilisearch_faceted_catalog_engine, elasticsearch_opensearch_aggregation, cdc_debezium_zero_downtime_sync, synonyms_relevance_prominence_scoring |
| API versioning, gateway, reverse proxy, kuota tenant, metered billing | `references/api_versioning_gateway_routing/` | enterprise_api_versioning_strategies, api_gateway_reverse_proxy_upstream, tenant_quota_metered_billing_redis |
| Saga panjang, Temporal, state machine order, kompensasi | `references/workflow_orchestration_temporal/` | temporal_io_sdk_long_running_sagas, finite_state_machines_xstate_orders, compensation_workflows_human_in_loop |
| Multi-tenant, RLS, isolasi skema per tenant, subdomain routing | `references/multi_tenancy_architecture/` | postgres_rls_row_level_security, schema_based_tenant_isolation_prisma, dedicated_database_dynamic_datasink |
| AWS Lambda, serverless, SQS/SNS, cold start | `references/serverless_aws_lambda_cloud/` | serverless_express_aws_lambda_handler, sqs_sns_lambda_worker_microservice, cold_start_mitigation_lazy_modules |
| Monorepo, Nx, shared library, affected build, boundary enforcement | `references/monorepo_nx_workspaces/` | nx_workspaces_shared_library_architecture, affected_build_test_ci_cd_caching, dependency_graph_boundary_enforcement |
| K8s, Helm, GitOps, ConfigMap reload, HPA autoscaling | `references/devops_k8s_gitops/` | helm_charts_k8s_manifest_blueprint, configmap_secret_volume_reloading, hpa_custom_metrics_prometheus_scaling |

## 🔍 Auto-Detect Niche Domain (Scan dari Task)

Agent WAJIB mencocokkan nature of task ke domain berikut **secara proaktif**.

| Jika task melibatkan... | Otomatis baca | Rujukan Utama yang Tersedia |
| :--- | :--- | :--- |
| AI/LLM, RAG, embedding, pgvector, Pinecone, streaming jawaban | `references/ai_vector_rag_integration/` | pgvector_pinecone_langchain_ts, streaming_llm_responses_sse_websocket, embedding_batch_processor_bullmq, ai_tool_calling_decorator_reflection |
| Payment, webhook, ledger, saldo, 2PC, idempotency finansial | `references/fintech_payment_gateways/` | webhook_idempotency_signature_verification, two_phase_commit_2pc_distributed, bigint_zero_trust_currency_accounting, ledger_append_only_immutable_records |
| OpenAPI, Swagger, dokumentasi API, generate SDK client | `references/openapi_documentation/` | openapi_31_automation_cli_plugin, secure_endpoints_bearer_apikey_docs, auto_generate_client_sdk_typescript, swagger_ui_custom_theme_branding |
| i18n, multi-bahasa, ICU, format mata uang & zona waktu | `references/i18n_localization/` | nestjs_i18n_enterprise_setup, zero_copy_icu_message_formatting, localized_exception_filter_errors |
| CLI, subcommand, seeder interaktif, daemon latar | `references/cli_scripting_commander/` | nest_commander_cli_workspaces, interactive_prompts_seeding_scripts, background_daemon_orchestration |
| Native addon, napi-rs, jembatan Rust, buffer sharing, kripto cepat | `references/low_level_addons_napi/` | napi_rs_rust_binding_integration, zero_overhead_crypto_hashing_bridges, memory_buffer_ownership_sharing |
| Chaos test, fault injection, bulkhead, degradasi terkendali | `references/chaos_engineering_resilience/` | fault_injection_custom_interceptors, circuit_breaker_graceful_degradation, bulkhead_pattern_concurrency_isolation |
| Decorator kustom, Reflector, metadata, abstraksi boilerplate | `references/meta_programming_decorators/` | reflector_metadata_engine_deep_dive, custom_method_parameter_decorators, metadata_reflection_boilerplate_abstraction |

---

## 🛡️ Penegakan Mutu & Quality Gates (Zero-Tolerance)

DILARANG mengubah status task jadi `[x]` sebelum SEMUA gerbang ini lulus.

| Gerbang | Perintah | Kriteria lulus |
| :--- | :--- | :--- |
| **Global Quality Gate** | `powershell -NoProfile -ExecutionPolicy Bypass -File ~/.gemini/config/scripts/quality_gate.ps1 -Full` | nol placeholder, nol credential hardcode, test lulus |
| TypeScript | `tsc --noEmit` | nol error |
| Linter | `eslint .` | nol warning |
| Test | `jest` / SWC | nol kegagalan |

> **PENTING:** Global Quality Gate (`quality_gate.ps1`) adalah gerbang primer yang WAJIB dijalankan. Tabel bahasa di atas adalah pelengkap spesifik NestJS — tidak menggantikan global gate.

Ditolak bila ditemukan: warning kompilasi TypeScript · kegagalan ESLint · unit test Jest/SWC gagal · placeholder malas (`// TODO`, `// FIXME`) · kredensial statis yang tidak diambil dari `.env`.

> Audit mutu **berkas referensi mastery** dijalankan terpusat lewat `scripts/audit_references.ps1 -Skill nestjs-mastery`, bukan dari direktori `scripts/` di dalam bundle ini (tidak ada). Sasarannya berbeda dari `quality_gate.ps1` yang mengadili kode proyek user — DILARANG saling menggantikan.

---
*Manifes `nestjs-mastery` ini adalah Single Source of Truth (SSOT). Jadikan hukum kepatuhannya sebagai jembatan melompati kemegahan arsitektur dunia nyata!*
