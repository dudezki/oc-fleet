--
-- PostgreSQL database dump
--

\restrict 5oF2DX9fWbb99XsnM4xrGs5YTPMGP4WMxmrUF0ehjAfB13K7cabu7ZFmaRlMkSs

-- Dumped from database version 16.13 (Ubuntu 16.13-1.pgdg24.04+1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-1.pgdg24.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'SQL_ASCII';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: agents; Type: TABLE DATA; Schema: fleet; Owner: postgres
--

INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('83e429b5-60fb-4cf4-8113-599f96b59ab5', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'RAG-Main', 'rag', 'Central memory orchestrator', 'active', '{"meta": {"emoji": "🧠", "model": "haiku", "provider": "anthropic"}}', '2026-04-03 03:47:53.63882+00', '2026-04-03 03:47:53.63882+00', NULL, NULL, NULL, NULL);
INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('a61ffd74-3a89-4b7f-b05d-31bff990b8cb', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'Gemma', 'gemma', NULL, 'active', '{"meta": {"emoji": "🤖", "model": "haiku", "provider": "anthropic"}, "port": 20040, "model": "gemma4:27b", "provider": "ollama", "telegram": "@CBFleetGemma_bot"}', '2026-04-03 22:19:42.141731+00', '2026-04-03 22:19:42.141731+00', NULL, NULL, NULL, NULL);
INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('b81c0d8a-3f76-43fe-b2e5-2537801085dc', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'Fleet-Sales', 'sales', 'Sales and lead qualification', 'active', '{"meta": {"port": 20010, "emoji": "💼", "model": "haiku", "provider": "anthropic"}, "port": 20010, "model": "claude-sonnet-4-6"}', '2026-04-03 03:47:53.63882+00', '2026-04-03 03:47:53.63882+00', 20010, '0f729f1b65c8577373f566b85315faa4ca795978d5bf5317420e67ab330929e5', '25a54882d9bd3729d4ae715446063c6c30c5c3c8ef0e49475a7ef02dbee49282', '8635294015:AAFJ-Xv6hPuON6I9y0XmTCS824HtnIZGHkU');
INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('325e5143-3c0b-4d65-b548-a34cbdba5949', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'Fleet-Support', 'support', 'Customer support and handoff resolution', 'active', '{"meta": {"port": 20020, "emoji": "🎧", "model": "haiku", "provider": "anthropic"}, "port": 20020, "model": "claude-sonnet-4-6"}', '2026-04-03 03:47:53.63882+00', '2026-04-03 03:47:53.63882+00', 20020, '8517231ec30ee981ecf613c242506aa68ce1c9111aa6c7c7b869827d7087555b', '46b43e234192c48e928a3f78feded4749e64feb672371dda4372e51b195a07f3', '8704189878:AAENJYhtN7824JJ29W5MHwitmz7xmXIslGM');
INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('82061d1c-2c79-4cfb-9e18-b8233b95a7c2', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'Fleet-Manager', 'manager', 'Org-wide memory and oversight', 'active', '{"meta": {"port": 20030, "emoji": "📊", "model": "haiku", "provider": "anthropic"}, "port": 20030, "model": "claude-sonnet-4-6"}', '2026-04-03 03:47:53.63882+00', '2026-04-03 03:47:53.63882+00', 20030, '5d0f6a531fe63db2585f33bbe972cdc9d2e27763e5d77b615f45641a11fe4fff', '5ce479280209ee55135230a826239bb83ffc8c5aa052566e55dc64540c1d3ce4', '8466627149:AAG-tSQhzFMIiggvlj8r4VwtE9TyXUL7Dlg');
INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('87a2838e-e145-4f5c-99e2-c759f0591cba', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'Fleet-Dev', 'dev', 'Software Developer agent — handles dev requests, code issues, deployments', 'active', '{"meta": {"port": 20040, "emoji": "💻", "model": "sonnet", "provider": "anthropic"}, "port": 20040, "model": "claude-sonnet-4-6"}', '2026-04-03 23:04:05.399311+00', '2026-04-03 23:04:05.399311+00', 20040, '49edaf0c2b5062a787f04f2a06d5c2772d3fe289dc0dc0eb34da460be71c54d1', 'd4bda0323788d8c4d0a085ce840863e61c61f8fa5af831c2418e4c7c7d848198', '8711513128:AAG1rumx-ragdgt5MnibQHpGJ-YJZv_fltc');
INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('20dc090b-90a3-403f-acc3-a1ac7008596d', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'Fleet-IT', 'it', 'IT Support agent — handles tech support, access, device issues', 'active', '{"meta": {"port": 20050, "emoji": "🔧", "model": "haiku", "provider": "anthropic"}, "port": 20050, "model": "claude-haiku-4-5"}', '2026-04-03 23:04:05.399311+00', '2026-04-03 23:04:05.399311+00', 20050, '98d7e2eeb8f49d14d6476a629f4408adb767e1d5f609fc25611b44a72043be2e', '9eb70b5ae99b0970e2fb369b07506256e6b6f10afe5b227127e5905dca51caa5', '8573728913:AAGfKvlnO2yb2Oa2oVLXJTtShJQtEkDuHX0');
INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('8a2ce3b0-ed67-460b-a79e-e3baeeacc51e', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'Fleet-HR', 'hr', NULL, 'active', '{"meta": {"port": 20060, "emoji": "👥", "model": "haiku", "provider": "anthropic"}, "port": 20060, "model": "claude-sonnet-4-6"}', '2026-04-04 18:26:17.543599+00', '2026-04-04 18:26:17.543599+00', 20060, NULL, 'e510545c504a40376f75cd4f199811b924122d4aeea26ec0d51447ffedbec622', '8236634172:AAEl5gZCPlCs9I3GtltzW9eVV_6DN-9CXa8');
INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('d6a557d1-6e81-4144-991d-d26c68a1f64f', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'Fleet-Finance', 'finance', NULL, 'active', NULL, '2026-04-04 19:45:16.42738+00', '2026-04-04 19:45:16.42738+00', 20070, NULL, '261535e3340ba3fa09e25bef2b0da94d7bf55212afd74aac59e957a6c505c819', '8622559201:AAGpuYe4187h8TKG9N18HuWS2xsA9FIGeZo');
INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('dc0aff14-f24a-47a0-808e-f2d437e1636d', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'Fleet-Documentor', 'documentor', NULL, 'active', '{"meta": {"port": 20070, "emoji": "📝", "model": "claude-sonnet-4-6", "provider": "anthropic"}}', '2026-04-06 07:34:11.854214+00', '2026-04-06 07:34:11.854214+00', 20070, NULL, NULL, '8617237231:AAH5BPLv1n7y3AEKF1DrJ3e_r7yswps8OiE');
INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('dc18f66c-6777-425a-8deb-452316b56e60', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'Fleet-Documentor', 'documentor', 'Knowledge Base Architect — ingests, chunks, embeds, and indexes all org content. Powered by Gemini 2.5 Pro.', 'active', '{"meta": {"port": 20070, "emoji": "📝", "model": "claude-sonnet-4-6", "provider": "anthropic"}}', '2026-04-05 11:49:23.003072+00', '2026-04-05 11:49:23.003072+00', 20070, NULL, '7a823c05fc02fe3d784347ff154a636abafcf7dcdb23901da3570fb91592d8b2', '8617237231:AAH5BPLv1n7y3AEKF1DrJ3e_r7yswps8OiE');
INSERT INTO fleet.agents (id, org_id, department_id, name, slug, description, status, config, created_at, updated_at, gateway_port, gateway_token, hooks_token, bot_token) VALUES ('5acb77f3-672b-4c70-b849-90d59cc9cf37', 'f86d92cb-db10-43ff-9ff2-d69c319d272d', NULL, 'Fleet-CS', 'cs', NULL, 'active', '{"meta": {"port": 20060, "emoji": "🤝", "model": "claude-sonnet-4-6", "provider": "anthropic"}}', '2026-04-06 08:51:37.802669+00', '2026-04-06 08:51:37.802669+00', 20060, '4b92f97a8332b02a489b25b067106f81ce1c334bbf35a7f0a913680febec3406', NULL, '8490524697:AAFbkTWeX_2KTqAnUBLKKmyO-_yfE7PsjdQ');


--
-- PostgreSQL database dump complete
--

\unrestrict 5oF2DX9fWbb99XsnM4xrGs5YTPMGP4WMxmrUF0ehjAfB13K7cabu7ZFmaRlMkSs

