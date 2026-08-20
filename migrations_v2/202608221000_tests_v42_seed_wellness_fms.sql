-- ============================================================
-- OPTIMOVE — Tests modul v4.2, migrations_v2 migracija (seed sadržaj)
--
-- WELLNESS (samostalan test) + FMS (baterija sa 7 osnovnih + 3 clearing
-- testa), prema v42_seed_manifest.md (jedina važeća verzija) i
-- v42_migration_plan_v3.md (legacy_import_map DDL/pravila statičkog
-- importa). Sve vrednosti ispod su stabilni, eksplicitni UUID literali
-- generisani JEDNOM pri pisanju ove migracije (build-time skripta, van
-- repozitorijuma) - migracija sama ne poziva gen_random_uuid() ni za
-- jedan seed red, sem za tests.legacy_import_map.id, čiji je surogat
-- primarni ključ isključivo interni audit-trag (ništa ga dalje ne
-- referencira) i već ima default gen_random_uuid() u šemi.
--
-- monitoring2 NIJE runtime zavisnost ove migracije - "source"/legacy
-- UUID vrednosti ispod su već unapred pretvorene, statične SQL
-- vrednosti čista provenijencija u tests.legacy_import_map, ne live upit.
--
-- Runner je jedini vlasnik BEGIN/COMMIT granice - ovaj fajl namerno ne
-- sadrži sopstvene transaction-control naredbe.
-- ============================================================

-- ------------------------------------------------------------
-- A. WELLNESS — samostalan test (v42_seed_manifest.md, odeljak A)
-- ------------------------------------------------------------

insert into tests.test (id, owner_scope, visibility) values
  ('5975d3ba-3578-49e1-9cd3-326df5e21f06', 'system', 'system');

insert into tests.test_versions (id, test_id, version_number, status, name, description) values
  ('7a386bd1-d25e-4651-9012-e76d9dc32559', '5975d3ba-3578-49e1-9cd3-326df5e21f06', 1, 'draft', 'WELLNESS',
   'Wellness questionnaire — dnevni samo-izveštaj o umoru, snu, bolnosti mišića, stresu, raspoloženju i povredi.');

insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type, minimum_value, maximum_value, decimal_places, unit) values
  ('f33abe4e-f2c2-48f7-89b0-e4c96ca0f6ea', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'fatigue', 'Fatigue', 'integer', 0, 10, 0, 'points'),
  ('bde22df8-ecaa-41db-878f-e377b236772e', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'sleep', 'Sleep', 'integer', 0, 10, 0, 'points'),
  ('82793b38-757b-48c5-a2ae-b677bf2bb653', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'soreness', 'Soreness', 'integer', 0, 10, 0, 'points'),
  ('4d71286c-911e-4a86-9541-0fd189c41e59', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'stress', 'Stress', 'integer', 0, 10, 0, 'points'),
  ('08144417-8f16-4fd5-b35f-a2c983e0f180', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'mood', 'Mood', 'integer', 0, 10, 0, 'points'),
  ('a98f2afb-b458-40ff-98a7-c6b5108bba9e', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'injury', 'Injury', 'boolean', null, null, null, 'binary');

insert into tests.test_version_derived_parameters (id, test_version_id, parameter_key, name, calculation_method, result_type, missing_input_behavior) values
  ('a342af02-52cb-4b39-83d5-3b7861fe2069', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'wellness_total', 'WELLNESS Total', 'average', 'numeric', 'error');

insert into tests.test_version_derived_parameter_inputs (id, test_version_id, derived_parameter_id, input_source_kind, source_test_parameter_id, role, weight) values
  ('38378e2a-39ad-4be4-832d-7fc1c45711d5', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'a342af02-52cb-4b39-83d5-3b7861fe2069', 'native', 'f33abe4e-f2c2-48f7-89b0-e4c96ca0f6ea', 'fatigue', 1),
  ('8f6b4f8b-1052-4cc3-a2e0-b257f0e6bd7b', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'a342af02-52cb-4b39-83d5-3b7861fe2069', 'native', 'bde22df8-ecaa-41db-878f-e377b236772e', 'sleep', 1),
  ('1d5e458a-024b-4a5d-ad3c-73d4898f9c1d', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'a342af02-52cb-4b39-83d5-3b7861fe2069', 'native', '82793b38-757b-48c5-a2ae-b677bf2bb653', 'soreness', 1),
  ('299307c8-61cc-4b04-92a9-4fc1cbf0e459', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'a342af02-52cb-4b39-83d5-3b7861fe2069', 'native', '4d71286c-911e-4a86-9541-0fd189c41e59', 'stress', 1),
  ('7376dee9-e135-4f6d-b790-22ce6814302f', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'a342af02-52cb-4b39-83d5-3b7861fe2069', 'native', '08144417-8f16-4fd5-b35f-a2c983e0f180', 'mood', 1);

-- Publish: draft -> active. Triggers validate_test_version_derived_parameters (5 numeric-compatible inputs, average, no cycle).
update tests.test_versions set status = 'active' where id = '7a386bd1-d25e-4651-9012-e76d9dc32559' and status = 'draft';

-- ------------------------------------------------------------
-- B. FMS — 7 osnovnih testova + C. 3 clearing testa (odeljci B, C)
-- ------------------------------------------------------------

-- Deep Squat
insert into tests.test (id, owner_scope, visibility) values ('a914b77e-3d01-4976-94ac-b66c5b9e7cc3', 'system', 'system');
insert into tests.test_versions (id, test_id, version_number, status, name, measures_multiple_sides) values
  ('560cf251-50b1-4728-b317-a2c38fe9107a', 'a914b77e-3d01-4976-94ac-b66c5b9e7cc3', 1, 'draft', 'Deep Squat', false);
insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type, minimum_value, maximum_value, decimal_places, unit) values
  ('3f2873b1-0453-4f4a-93d9-02c388e9efcb', '560cf251-50b1-4728-b317-a2c38fe9107a', 'score', 'FMS scale', 'ordinal', 0, 3, 0, 'points');
update tests.test_versions set status = 'active' where id = '560cf251-50b1-4728-b317-a2c38fe9107a' and status = 'draft';

-- Hurdle Step
insert into tests.test (id, owner_scope, visibility) values ('0ef19840-534f-4701-bde9-b668901d1e2e', 'system', 'system');
insert into tests.test_versions (id, test_id, version_number, status, name, measures_multiple_sides) values
  ('723c48bd-5291-4821-97b3-cd904c3d29aa', '0ef19840-534f-4701-bde9-b668901d1e2e', 1, 'draft', 'Hurdle Step', true);
insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type, minimum_value, maximum_value, decimal_places, unit) values
  ('bec032f2-e59e-4a2d-8d64-6ba881ab0d5c', '723c48bd-5291-4821-97b3-cd904c3d29aa', 'score_left', 'FMS scale', 'ordinal', 0, 3, 0, 'points'),
  ('4cd6fb82-db03-4eee-b7f2-6a59b36a212b', '723c48bd-5291-4821-97b3-cd904c3d29aa', 'score_right', 'FMS scale', 'ordinal', 0, 3, 0, 'points'),
  ('0f87462d-8f0f-4948-9039-af299451a3dc', '723c48bd-5291-4821-97b3-cd904c3d29aa', 'score_total', 'FMS scale', 'ordinal', 0, 3, 0, 'points'),
  ('8083c43b-a5d1-43a2-b375-0e0da7a0ce32', '723c48bd-5291-4821-97b3-cd904c3d29aa', 'asymmetry', 'Asymmetry detection scale', 'numeric', null, null, null, 'number');
update tests.test_versions set status = 'active' where id = '723c48bd-5291-4821-97b3-cd904c3d29aa' and status = 'draft';

-- In-line Lunge
insert into tests.test (id, owner_scope, visibility) values ('89cff0f8-8bd4-4ca8-83fc-9dccdc2cfcdf', 'system', 'system');
insert into tests.test_versions (id, test_id, version_number, status, name, measures_multiple_sides) values
  ('cb634e95-5009-43a7-abc7-c3479954d7b7', '89cff0f8-8bd4-4ca8-83fc-9dccdc2cfcdf', 1, 'draft', 'In-line Lunge', true);
insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type, minimum_value, maximum_value, decimal_places, unit) values
  ('9f125b81-c906-4cc7-a589-cd67e6ff6852', 'cb634e95-5009-43a7-abc7-c3479954d7b7', 'ankle_mobility_right', 'FMS ankle mobility scale', 'ordinal', 0, 3, 0, 'points'),
  ('a94d2799-7210-4fcc-98e8-7f46c5e32d08', 'cb634e95-5009-43a7-abc7-c3479954d7b7', 'ankle_mobility_left', 'FMS ankle mobility scale', 'ordinal', 0, 3, 0, 'points'),
  ('ae1c7d6e-a672-475a-a142-ba117cbb15f0', 'cb634e95-5009-43a7-abc7-c3479954d7b7', 'ankle_pain_right', 'Pain detection scale', 'boolean', null, null, null, 'binary'),
  ('9d0eab9f-2b70-4739-9c37-d63a06f119c3', 'cb634e95-5009-43a7-abc7-c3479954d7b7', 'ankle_pain_left', 'Pain detection scale', 'boolean', null, null, null, 'binary'),
  ('aaba0d40-472a-4c16-8f62-12d931717408', 'cb634e95-5009-43a7-abc7-c3479954d7b7', 'asymmetry', 'Asymmetry detection scale', 'numeric', null, null, null, 'number'),
  ('905a4b1b-f052-47ee-8dc8-0536de4ea8cc', 'cb634e95-5009-43a7-abc7-c3479954d7b7', 'score_left', 'FMS scale', 'ordinal', 0, 3, 0, 'points'),
  ('631cc965-955b-4d54-bb6d-fc4a3a3211e1', 'cb634e95-5009-43a7-abc7-c3479954d7b7', 'score_total', 'FMS scale', 'ordinal', 0, 3, 0, 'points'),
  ('e0ac125a-4b47-428a-a2d4-8d9ba45bd0f6', 'cb634e95-5009-43a7-abc7-c3479954d7b7', 'score_right', 'FMS scale', 'ordinal', 0, 3, 0, 'points');
update tests.test_versions set status = 'active' where id = 'cb634e95-5009-43a7-abc7-c3479954d7b7' and status = 'draft';

-- Shoulder Mobility
insert into tests.test (id, owner_scope, visibility) values ('cb96f6df-076a-44d9-868d-fef573866f3a', 'system', 'system');
insert into tests.test_versions (id, test_id, version_number, status, name, measures_multiple_sides) values
  ('1226154e-7cdb-4aaa-83d3-5884cc065a57', 'cb96f6df-076a-44d9-868d-fef573866f3a', 1, 'draft', 'Shoulder Mobility', true);
insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type, minimum_value, maximum_value, decimal_places, unit) values
  ('f389ae76-0676-4a04-986a-8f3b4ce6dd03', '1226154e-7cdb-4aaa-83d3-5884cc065a57', 'asymmetry', 'Asymmetry detection scale', 'numeric', null, null, null, 'number'),
  ('fcc6cada-03a4-4290-8dee-3a4538e93e54', '1226154e-7cdb-4aaa-83d3-5884cc065a57', 'score_right', 'FMS scale', 'ordinal', 0, 3, 0, 'points'),
  ('f2b9d909-0c07-45e1-afe3-15c54de870ea', '1226154e-7cdb-4aaa-83d3-5884cc065a57', 'score_left', 'FMS scale', 'ordinal', 0, 3, 0, 'points'),
  ('aa79eca1-45a2-480f-82be-d15fe912dc56', '1226154e-7cdb-4aaa-83d3-5884cc065a57', 'score_total', 'FMS scale', 'ordinal', 0, 3, 0, 'points');
update tests.test_versions set status = 'active' where id = '1226154e-7cdb-4aaa-83d3-5884cc065a57' and status = 'draft';

-- Active Straight Leg Raise
insert into tests.test (id, owner_scope, visibility) values ('fe76ba46-cadc-4098-add2-d9338ea14269', 'system', 'system');
insert into tests.test_versions (id, test_id, version_number, status, name, measures_multiple_sides) values
  ('89e90b7e-4408-4007-9f56-cb09a257ed7a', 'fe76ba46-cadc-4098-add2-d9338ea14269', 1, 'draft', 'Active Straight Leg Raise', true);
insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type, minimum_value, maximum_value, decimal_places, unit) values
  ('ebf5da16-ce8d-44b1-aaf4-06dde0147e6e', '89e90b7e-4408-4007-9f56-cb09a257ed7a', 'asymmetry', 'Asymmetry detection scale', 'numeric', null, null, null, 'number'),
  ('e38bf666-1c33-4394-99fd-51dacc1219c0', '89e90b7e-4408-4007-9f56-cb09a257ed7a', 'score_total', 'FMS scale', 'ordinal', 0, 3, 0, 'points'),
  ('3acd6849-bb19-4f52-af0d-6acb33e8fa9d', '89e90b7e-4408-4007-9f56-cb09a257ed7a', 'score_right', 'FMS scale', 'ordinal', 0, 3, 0, 'points'),
  ('6464e753-6674-4d8d-96ce-095309b19d1d', '89e90b7e-4408-4007-9f56-cb09a257ed7a', 'score_left', 'FMS scale', 'ordinal', 0, 3, 0, 'points');
update tests.test_versions set status = 'active' where id = '89e90b7e-4408-4007-9f56-cb09a257ed7a' and status = 'draft';

-- Trunk Stability Push-Up
insert into tests.test (id, owner_scope, visibility) values ('09e81600-1f1f-42b7-8bf2-5ff7f55f6894', 'system', 'system');
insert into tests.test_versions (id, test_id, version_number, status, name, measures_multiple_sides) values
  ('a7ed6754-558f-4c28-9c0b-9d23015b15df', '09e81600-1f1f-42b7-8bf2-5ff7f55f6894', 1, 'draft', 'Trunk Stability Push-Up', false);
insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type, minimum_value, maximum_value, decimal_places, unit) values
  ('38e7f2df-aa97-48f8-a4f4-1719bc88c983', 'a7ed6754-558f-4c28-9c0b-9d23015b15df', 'score_total', 'FMS scale', 'ordinal', 0, 3, 0, 'points');
update tests.test_versions set status = 'active' where id = 'a7ed6754-558f-4c28-9c0b-9d23015b15df' and status = 'draft';

-- Rotary Stability
insert into tests.test (id, owner_scope, visibility) values ('808917ae-5a4c-4332-9ff1-4d783890fef4', 'system', 'system');
insert into tests.test_versions (id, test_id, version_number, status, name, measures_multiple_sides) values
  ('15e63985-0b4b-4f1d-951e-7f3888159cf5', '808917ae-5a4c-4332-9ff1-4d783890fef4', 1, 'draft', 'Rotary Stability', true);
insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type, minimum_value, maximum_value, decimal_places, unit) values
  ('4ddb0c0e-f281-47ec-b143-fce13e2ca3db', '15e63985-0b4b-4f1d-951e-7f3888159cf5', 'asymmetry', 'Asymmetry detection scale', 'numeric', null, null, null, 'number'),
  ('1eae6ce7-42c3-473a-9413-ab83f5db6dc6', '15e63985-0b4b-4f1d-951e-7f3888159cf5', 'score_total', 'FMS scale', 'ordinal', 0, 3, 0, 'points'),
  ('9dcd8e2a-7153-48ad-ae26-de057588581f', '15e63985-0b4b-4f1d-951e-7f3888159cf5', 'score_right', 'FMS scale', 'ordinal', 0, 3, 0, 'points'),
  ('50dc8ec3-c1ed-476d-a3ef-c4925ef3172e', '15e63985-0b4b-4f1d-951e-7f3888159cf5', 'score_left', 'FMS scale', 'ordinal', 0, 3, 0, 'points');
update tests.test_versions set status = 'active' where id = '15e63985-0b4b-4f1d-951e-7f3888159cf5' and status = 'draft';

-- Shoulder Clearing Test
insert into tests.test (id, owner_scope, visibility) values ('f64bcc15-3a3e-4a70-a70a-372e678c8871', 'system', 'system');
insert into tests.test_versions (id, test_id, version_number, status, name, measures_multiple_sides) values
  ('cf1ae144-6c77-4f31-b226-6efc70a21bc6', 'f64bcc15-3a3e-4a70-a70a-372e678c8871', 1, 'draft', 'Shoulder Clearing Test', true);
insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type, minimum_value, maximum_value, decimal_places, unit) values
  ('48519092-29e8-487f-97bd-86df5f96968f', 'cf1ae144-6c77-4f31-b226-6efc70a21bc6', 'pain_right', 'Pain detection scale', 'boolean', null, null, null, 'binary'),
  ('ca60b8ef-5b4e-4766-af37-b0b5116b5052', 'cf1ae144-6c77-4f31-b226-6efc70a21bc6', 'pain_left', 'Pain detection scale', 'boolean', null, null, null, 'binary');
update tests.test_versions set status = 'active' where id = 'cf1ae144-6c77-4f31-b226-6efc70a21bc6' and status = 'draft';

-- Spinal Extension Clearing Test
insert into tests.test (id, owner_scope, visibility) values ('317cbf6c-7ced-4d53-b71a-7b0430ee31fa', 'system', 'system');
insert into tests.test_versions (id, test_id, version_number, status, name, measures_multiple_sides) values
  ('22d52cd8-22ee-456f-b224-6c0511d14635', '317cbf6c-7ced-4d53-b71a-7b0430ee31fa', 1, 'draft', 'Spinal Extension Clearing Test', false);
insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type, minimum_value, maximum_value, decimal_places, unit) values
  ('82384ae5-30bd-4425-86c2-d29140d86ea2', '22d52cd8-22ee-456f-b224-6c0511d14635', 'pain', 'Pain detection scale', 'boolean', null, null, null, 'binary');
update tests.test_versions set status = 'active' where id = '22d52cd8-22ee-456f-b224-6c0511d14635' and status = 'draft';

-- Spinal Flexion Clearing Test
insert into tests.test (id, owner_scope, visibility) values ('dc6024a8-df73-4ef9-ba1f-b4e9f550b044', 'system', 'system');
insert into tests.test_versions (id, test_id, version_number, status, name, measures_multiple_sides) values
  ('dfa1757b-8ee9-4fb5-beb1-760e061bbf5a', 'dc6024a8-df73-4ef9-ba1f-b4e9f550b044', 1, 'draft', 'Spinal Flexion Clearing Test', false);
insert into tests.test_parameters (id, test_version_id, parameter_key, parameter, value_type, minimum_value, maximum_value, decimal_places, unit) values
  ('fa5b41bc-39c7-4213-be90-ea13fa7a8a98', 'dfa1757b-8ee9-4fb5-beb1-760e061bbf5a', 'pain', 'Pain detection scale', 'boolean', null, null, null, 'binary');
update tests.test_versions set status = 'active' where id = 'dfa1757b-8ee9-4fb5-beb1-760e061bbf5a' and status = 'draft';

-- ------------------------------------------------------------
-- D. FMS baterija ("Functional Movement Screen") (odeljak D)
-- ------------------------------------------------------------

insert into tests.test_battery (id, owner_scope, visibility) values ('2b4eb1cb-4263-41c9-b553-b547bbbdf022', 'system', 'system');
insert into tests.test_battery_versions (id, test_battery_id, version_number, status, name) values
  ('833457a3-43f0-4254-9fd4-d9ff3e5703a7', '2b4eb1cb-4263-41c9-b553-b547bbbdf022', 1, 'draft', 'Functional Movement Screen');

-- D.3: 10 battery items. Redosled je eksplicitna OptiMove produktna odluka
-- (funkcionalni redosled - clearing test odmah posle testa na koji utiče),
-- NE izveden iz legacy created_at (identičan za svih 10 legacy redova).
insert into tests.test_battery_items (id, battery_version_id, test_version_id, order_index) values
  ('ccafa76a-7836-434b-84b9-6fb0f02db061', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '560cf251-50b1-4728-b317-a2c38fe9107a', 0),
  ('1b56c942-835c-4dd2-b626-ebe9d232ebb4', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '723c48bd-5291-4821-97b3-cd904c3d29aa', 1),
  ('fc52df60-3160-4bd3-84ab-d621846a6219', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'cb634e95-5009-43a7-abc7-c3479954d7b7', 2),
  ('afd67770-3f4d-48cd-bd0d-18b2a5bbf0b3', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '1226154e-7cdb-4aaa-83d3-5884cc065a57', 3),
  ('0896b151-3b37-44ee-8688-47e64d31780d', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'cf1ae144-6c77-4f31-b226-6efc70a21bc6', 4),
  ('40276516-8e0d-44b6-a5f5-a233f317bb21', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '89e90b7e-4408-4007-9f56-cb09a257ed7a', 5),
  ('c8d4ca29-d6fa-4229-bde4-5de5726293b8', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'a7ed6754-558f-4c28-9c0b-9d23015b15df', 6),
  ('7d5486de-154b-4a6c-b0cd-d0a84a857797', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '22d52cd8-22ee-456f-b224-6c0511d14635', 7),
  ('dd32ed1b-1d97-4211-82ab-93e2dfd159fd', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '15e63985-0b4b-4f1d-951e-7f3888159cf5', 8),
  ('dd718fea-2b40-440e-b5cb-bb36d659f7d9', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'dfa1757b-8ee9-4fb5-beb1-760e061bbf5a', 9);

-- D.4: 11 battery item parameter selections.
insert into tests.test_battery_item_parameter_selections (id, battery_version_id, test_version_id, battery_item_id, source_kind, test_parameter_id) values
  ('3ff3f303-d550-4305-8a61-66179305954b', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '560cf251-50b1-4728-b317-a2c38fe9107a', 'ccafa76a-7836-434b-84b9-6fb0f02db061', 'native', '3f2873b1-0453-4f4a-93d9-02c388e9efcb'),
  ('7ce832c4-6197-4c8e-aa40-98ccdd466aff', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '723c48bd-5291-4821-97b3-cd904c3d29aa', '1b56c942-835c-4dd2-b626-ebe9d232ebb4', 'native', '0f87462d-8f0f-4948-9039-af299451a3dc'),
  ('e7e35f88-d11d-4286-9daf-de32a20e4bc0', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'cb634e95-5009-43a7-abc7-c3479954d7b7', 'fc52df60-3160-4bd3-84ab-d621846a6219', 'native', '631cc965-955b-4d54-bb6d-fc4a3a3211e1'),
  ('6e6923e6-ddc5-49f2-9522-d07974117903', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '89e90b7e-4408-4007-9f56-cb09a257ed7a', '40276516-8e0d-44b6-a5f5-a233f317bb21', 'native', 'e38bf666-1c33-4394-99fd-51dacc1219c0'),
  ('92a19063-6de8-43d9-952a-f3a2ab69a475', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'cf1ae144-6c77-4f31-b226-6efc70a21bc6', '0896b151-3b37-44ee-8688-47e64d31780d', 'native', 'ca60b8ef-5b4e-4766-af37-b0b5116b5052'),
  ('07296138-cd09-4546-9abc-629e15a853fb', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'cf1ae144-6c77-4f31-b226-6efc70a21bc6', '0896b151-3b37-44ee-8688-47e64d31780d', 'native', '48519092-29e8-487f-97bd-86df5f96968f'),
  ('582e0abc-5e96-4ae4-a04d-8ccc3ac0dcd3', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '1226154e-7cdb-4aaa-83d3-5884cc065a57', 'afd67770-3f4d-48cd-bd0d-18b2a5bbf0b3', 'native', 'aa79eca1-45a2-480f-82be-d15fe912dc56'),
  ('e08b1801-8428-4f3d-8c11-df5818b80877', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '22d52cd8-22ee-456f-b224-6c0511d14635', '7d5486de-154b-4a6c-b0cd-d0a84a857797', 'native', '82384ae5-30bd-4425-86c2-d29140d86ea2'),
  ('b045aa04-3c9f-42ec-8b56-da6018f2c2be', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'a7ed6754-558f-4c28-9c0b-9d23015b15df', 'c8d4ca29-d6fa-4229-bde4-5de5726293b8', 'native', '38e7f2df-aa97-48f8-a4f4-1719bc88c983'),
  ('1ab49306-351e-4b83-af0a-b5037adc67ff', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'dfa1757b-8ee9-4fb5-beb1-760e061bbf5a', 'dd718fea-2b40-440e-b5cb-bb36d659f7d9', 'native', 'fa5b41bc-39c7-4213-be90-ea13fa7a8a98'),
  ('2351c950-cbc0-462b-83b9-def791087c48', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '15e63985-0b4b-4f1d-951e-7f3888159cf5', 'dd32ed1b-1d97-4211-82ab-93e2dfd159fd', 'native', '1eae6ce7-42c3-473a-9413-ab83f5db6dc6');

-- D.5: 4 battery-derived parameters.
insert into tests.test_battery_derived_parameters (id, battery_version_id, parameter_key, name, calculation_method, calculation_definition, result_type, missing_input_behavior) values
  ('b80ef81c-b8d7-4ff0-b798-c8e32293cc2d', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'final_shoulder_mobility', 'Final Shoulder Mobility Score', 'conditional',
   '{"version":1,"when":{"any":[{"role":"pain_left","operator":"eq","value":true},{"role":"pain_right","operator":"eq","value":true}]},"then":{"constant":0},"else":{"role":"score"}}'::jsonb,
   'ordinal', 'error'),
  ('9a3acfe0-d46d-40f2-9052-0cae82e242b4', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'final_trunk_stability_pushup', 'Final Trunk Stability Push-Up Score', 'conditional',
   '{"version":1,"when":{"any":[{"role":"pain","operator":"eq","value":true}]},"then":{"constant":0},"else":{"role":"score"}}'::jsonb,
   'ordinal', 'error'),
  ('759d27be-104e-4f71-a52f-63f320a9cf53', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'final_rotary_stability', 'Final Rotary Stability Score', 'conditional',
   '{"version":1,"when":{"any":[{"role":"pain","operator":"eq","value":true}]},"then":{"constant":0},"else":{"role":"score"}}'::jsonb,
   'ordinal', 'error'),
  ('20b7242d-39a6-4b3e-8143-19ebbdef3ee0', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'fms_total', 'FMS Total', 'sum', null, 'numeric', 'error');

-- D.6: 14 battery-derived parameter inputs.
insert into tests.test_battery_derived_parameter_inputs (id, battery_version_id, derived_parameter_id, input_source_kind, source_battery_item_parameter_selection_id, source_derived_parameter_id, role, weight) values
  ('e1ba86e7-4427-451f-9537-36ed8a37877b', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'b80ef81c-b8d7-4ff0-b798-c8e32293cc2d', 'battery_item_parameter_selection', '92a19063-6de8-43d9-952a-f3a2ab69a475', null, 'pain_left', 1),
  ('044eb74e-6b3b-4b4b-a33f-d2b6582cbb33', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'b80ef81c-b8d7-4ff0-b798-c8e32293cc2d', 'battery_item_parameter_selection', '07296138-cd09-4546-9abc-629e15a853fb', null, 'pain_right', 1),
  ('d1527aad-c347-46f1-b522-09bf0e228fcc', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'b80ef81c-b8d7-4ff0-b798-c8e32293cc2d', 'battery_item_parameter_selection', '582e0abc-5e96-4ae4-a04d-8ccc3ac0dcd3', null, 'score', 1),
  ('f0759001-7e01-4a2d-a7af-4cd6aaa72fb3', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '9a3acfe0-d46d-40f2-9052-0cae82e242b4', 'battery_item_parameter_selection', 'e08b1801-8428-4f3d-8c11-df5818b80877', null, 'pain', 1),
  ('d5e51f97-a9ec-40ab-992d-a3ae04335ab6', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '9a3acfe0-d46d-40f2-9052-0cae82e242b4', 'battery_item_parameter_selection', 'b045aa04-3c9f-42ec-8b56-da6018f2c2be', null, 'score', 1),
  ('4ae55f3b-cae6-48ab-a6c0-f32398a673fd', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '759d27be-104e-4f71-a52f-63f320a9cf53', 'battery_item_parameter_selection', '1ab49306-351e-4b83-af0a-b5037adc67ff', null, 'pain', 1),
  ('e1dfb9bb-3164-48bf-8c8e-a746b91877cd', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '759d27be-104e-4f71-a52f-63f320a9cf53', 'battery_item_parameter_selection', '2351c950-cbc0-462b-83b9-def791087c48', null, 'score', 1),
  ('62dbae4a-72df-48a1-98b9-ac0479bb8aae', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '20b7242d-39a6-4b3e-8143-19ebbdef3ee0', 'battery_item_parameter_selection', '3ff3f303-d550-4305-8a61-66179305954b', null, 'deep_squat', 1),
  ('1a18a85a-24ca-4694-abf0-fbd42dba53a7', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '20b7242d-39a6-4b3e-8143-19ebbdef3ee0', 'battery_item_parameter_selection', '7ce832c4-6197-4c8e-aa40-98ccdd466aff', null, 'hurdle_step', 1),
  ('21aa3bab-a1c7-4420-959d-156c620d856a', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '20b7242d-39a6-4b3e-8143-19ebbdef3ee0', 'battery_item_parameter_selection', 'e7e35f88-d11d-4286-9daf-de32a20e4bc0', null, 'inline_lunge', 1),
  ('19e372a5-4464-430d-9b11-77a624b018a1', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '20b7242d-39a6-4b3e-8143-19ebbdef3ee0', 'battery_item_parameter_selection', '6e6923e6-ddc5-49f2-9522-d07974117903', null, 'aslr', 1),
  ('1df298af-e632-4d66-8188-b58a1f94f585', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '20b7242d-39a6-4b3e-8143-19ebbdef3ee0', 'battery_derived', null, 'b80ef81c-b8d7-4ff0-b798-c8e32293cc2d', 'shoulder_final', 1),
  ('f2b7b963-acb7-415d-9597-f5c56fb52706', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '20b7242d-39a6-4b3e-8143-19ebbdef3ee0', 'battery_derived', null, '9a3acfe0-d46d-40f2-9052-0cae82e242b4', 'trunk_final', 1),
  ('891825ae-1a9b-433b-bdd1-0ff5a2fbdbc0', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', '20b7242d-39a6-4b3e-8143-19ebbdef3ee0', 'battery_derived', null, '759d27be-104e-4f71-a52f-63f320a9cf53', 'rotary_final', 1);

-- D.7: publish. Triggers validate_battery_derived_parameters (4 conditional/sum, roles resolve, no cycle).
update tests.test_battery_versions set status = 'active' where id = '833457a3-43f0-4254-9fd4-d9ff3e5703a7' and status = 'draft';

-- ------------------------------------------------------------
-- Svesno preskočeni legacy objekti (6 redova, mapping_kind='skipped') —
-- Sprint 10m x2, Sprint 30m x2, Ankle Clearing x1, Wellness Questionnaire
-- battery x1. Nijedan od ovih se NE prenosi u v4.2 (probni domeni/
-- kategorije i ostali nepotvrđeni podaci se takođe ne prenose — nemaju
-- odgovarajuće legacy_import_map redove jer manifest njihov broj
-- ograničava isključivo na ovih 6 eksplicitno imenovanih stavki).
-- ------------------------------------------------------------

insert into tests.legacy_import_map (source_system, source_schema, source_table, source_id, target_schema, target_table, target_id, mapping_kind, import_batch_key, note) values
  ('monitoring2', 'tests', 'test', 'b2c0d1f1-1c48-4a2c-9236-4ea95f088b11', null, null, null, 'skipped', 'monitoring2-fms-wellness-2026-08-22', 'SPRINT 10 m - Sprint 10m (1/2) - not part of the confirmed v4.2 seed scope'),
  ('monitoring2', 'tests', 'test', '9abf7d49-d096-48c8-97e2-610b5a09931e', null, null, null, 'skipped', 'monitoring2-fms-wellness-2026-08-22', 'Sprint 10m - Sprint 10m (2/2) - not part of the confirmed v4.2 seed scope'),
  ('monitoring2', 'tests', 'test', 'af62b4ab-a8b2-4d75-9fe0-05d1d4faebdf', null, null, null, 'skipped', 'monitoring2-fms-wellness-2026-08-22', 'SPRINT 30 m - Sprint 30m (1/2) - not part of the confirmed v4.2 seed scope'),
  ('monitoring2', 'tests', 'test', 'e1312ca8-944b-4f3a-994f-4611e0468e1a', null, null, null, 'skipped', 'monitoring2-fms-wellness-2026-08-22', 'Sprint 30m - Sprint 30m (2/2) - not part of the confirmed v4.2 seed scope'),
  ('monitoring2', 'tests', 'test', '67f66197-2b8e-44a3-9484-1c2c7f807b07', null, null, null, 'skipped', 'monitoring2-fms-wellness-2026-08-22', 'Ankle Clearing - Ankle Clearing - not part of the confirmed v4.2 seed scope'),
  ('monitoring2', 'tests', 'test_battery', 'c2a1bd15-d159-455a-9e67-77afbd4d343a', null, null, null, 'skipped', 'monitoring2-fms-wellness-2026-08-22', 'Wellness Questionnaire - Wellness Questionnaire as a separate battery - WELLNESS ships as a single test, not a battery');

-- ------------------------------------------------------------
-- tests.legacy_import_map — preostalih 105 redova (direct/transformed/generated)
-- za sav prethodno upisani v4.2 sadržaj. Ukupno sa 6 'skipped' redova
-- iznad: 111.
-- ------------------------------------------------------------

insert into tests.legacy_import_map (source_system, source_schema, source_table, source_id, target_schema, target_table, target_id, mapping_kind, import_batch_key, note) values
  ('monitoring2', 'tests', 'test', '03bac3d5-8a51-42bd-b890-702b8713a7d5', 'tests', 'test', '5975d3ba-3578-49e1-9cd3-326df5e21f06', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '03bac3d5-8a51-42bd-b890-702b8713a7d5', 'tests', 'test_versions', '7a386bd1-d25e-4651-9012-e76d9dc32559', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', 'c1a50a75-8043-456a-8e3c-270a3d362e4b', 'tests', 'test_parameters', 'f33abe4e-f2c2-48f7-89b0-e4c96ca0f6ea', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '5684c607-3ad5-4f1b-8641-31117eb297e3', 'tests', 'test_parameters', 'bde22df8-ecaa-41db-878f-e377b236772e', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '0cdc7427-4dd0-4a46-b4e7-ae89af379308', 'tests', 'test_parameters', '82793b38-757b-48c5-a2ae-b677bf2bb653', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '45d08436-8b4c-47f2-9f54-24154e37e7e6', 'tests', 'test_parameters', '4d71286c-911e-4a86-9541-0fd189c41e59', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', 'd8471513-1453-4c40-88fd-fd2a3ab3357d', 'tests', 'test_parameters', '08144417-8f16-4fd5-b35f-a2c983e0f180', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', 'f9ce026d-a37a-461a-809d-5cc58a7fc2f1', 'tests', 'test_parameters', 'a98f2afb-b458-40ff-98a7-c6b5108bba9e', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '531dcbad-5dc8-47a5-a616-5d7304f56e68', 'tests', 'test_version_derived_parameters', 'a342af02-52cb-4b39-83d5-3b7861fe2069', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_version_derived_parameter_inputs', '38378e2a-39ad-4be4-832d-7fc1c45711d5', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_version_derived_parameter_inputs', '8f6b4f8b-1052-4cc3-a2e0-b257f0e6bd7b', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_version_derived_parameter_inputs', '1d5e458a-024b-4a5d-ad3c-73d4898f9c1d', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_version_derived_parameter_inputs', '299307c8-61cc-4b04-92a9-4fc1cbf0e459', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_version_derived_parameter_inputs', '7376dee9-e135-4f6d-b790-22ce6814302f', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', 'b38a7048-1f36-4542-8ba1-ff582846394f', 'tests', 'test', 'a914b77e-3d01-4976-94ac-b66c5b9e7cc3', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', 'b38a7048-1f36-4542-8ba1-ff582846394f', 'tests', 'test_versions', '560cf251-50b1-4728-b317-a2c38fe9107a', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '4925ad56-e442-432d-ac64-73d2c089db11', 'tests', 'test_parameters', '3f2873b1-0453-4f4a-93d9-02c388e9efcb', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '59996a69-f02b-4cf1-8806-474e35facf0a', 'tests', 'test', '0ef19840-534f-4701-bde9-b668901d1e2e', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '59996a69-f02b-4cf1-8806-474e35facf0a', 'tests', 'test_versions', '723c48bd-5291-4821-97b3-cd904c3d29aa', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '07fb9253-bb11-45e0-afcf-8bd4000096ab', 'tests', 'test_parameters', 'bec032f2-e59e-4a2d-8d64-6ba881ab0d5c', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '2dca7630-7b5b-42c8-82b3-a0debb8b157e', 'tests', 'test_parameters', '4cd6fb82-db03-4eee-b7f2-6a59b36a212b', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', 'ad8f17f8-8fe9-4dd0-bf88-61509713a317', 'tests', 'test_parameters', '0f87462d-8f0f-4948-9039-af299451a3dc', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '5d364409-75d9-4409-bece-05a5553121bc', 'tests', 'test_parameters', '8083c43b-a5d1-43a2-b375-0e0da7a0ce32', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', 'f5d5e82a-d5de-42fa-b413-8bcf37721c6d', 'tests', 'test', '89cff0f8-8bd4-4ca8-83fc-9dccdc2cfcdf', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', 'f5d5e82a-d5de-42fa-b413-8bcf37721c6d', 'tests', 'test_versions', 'cb634e95-5009-43a7-abc7-c3479954d7b7', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '72f1a635-be2b-464a-b472-583465befe1c', 'tests', 'test_parameters', '9f125b81-c906-4cc7-a589-cd67e6ff6852', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '9735ed21-9241-48c3-b586-bf8b1f6c8372', 'tests', 'test_parameters', 'a94d2799-7210-4fcc-98e8-7f46c5e32d08', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', 'e0d1e8bb-002c-4b8d-b621-d455e4c2a875', 'tests', 'test_parameters', 'ae1c7d6e-a672-475a-a142-ba117cbb15f0', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '2abf91c7-ab40-4a0a-8fba-52b3a2b4c82b', 'tests', 'test_parameters', '9d0eab9f-2b70-4739-9c37-d63a06f119c3', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', 'aad586c9-e2da-4970-a599-2e991c14c5ce', 'tests', 'test_parameters', 'aaba0d40-472a-4c16-8f62-12d931717408', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '62015a7c-7489-41ec-8f06-2b3c2bacd820', 'tests', 'test_parameters', '905a4b1b-f052-47ee-8dc8-0536de4ea8cc', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '868a4bc6-c90d-4ea4-a0ff-57e961f3b023', 'tests', 'test_parameters', '631cc965-955b-4d54-bb6d-fc4a3a3211e1', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '9a353972-d1d9-4961-8095-5ba501e3bb68', 'tests', 'test_parameters', 'e0ac125a-4b47-428a-a2d4-8d9ba45bd0f6', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '4c20c50e-be25-4747-8154-6c6e84c121fa', 'tests', 'test', 'cb96f6df-076a-44d9-868d-fef573866f3a', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '4c20c50e-be25-4747-8154-6c6e84c121fa', 'tests', 'test_versions', '1226154e-7cdb-4aaa-83d3-5884cc065a57', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '063f39a7-c0f5-43cf-9085-febd74c6ad14', 'tests', 'test_parameters', 'f389ae76-0676-4a04-986a-8f3b4ce6dd03', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '17f6bed7-f011-4e6a-b1d9-73976db8aee3', 'tests', 'test_parameters', 'fcc6cada-03a4-4290-8dee-3a4538e93e54', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', 'e635f26b-e0ba-405d-9d35-f88ed6ec4809', 'tests', 'test_parameters', 'f2b9d909-0c07-45e1-afe3-15c54de870ea', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '72413d6b-c7cc-406c-ac47-b8aaae73c978', 'tests', 'test_parameters', 'aa79eca1-45a2-480f-82be-d15fe912dc56', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '786e65d6-db5b-45e5-a6f2-897f956b2be9', 'tests', 'test', 'fe76ba46-cadc-4098-add2-d9338ea14269', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '786e65d6-db5b-45e5-a6f2-897f956b2be9', 'tests', 'test_versions', '89e90b7e-4408-4007-9f56-cb09a257ed7a', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '80a328b4-d508-4e3f-b879-41ab86d2e2f3', 'tests', 'test_parameters', 'ebf5da16-ce8d-44b1-aaf4-06dde0147e6e', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '45c0e33a-1abd-4c5b-aeb3-f7125e356d1b', 'tests', 'test_parameters', 'e38bf666-1c33-4394-99fd-51dacc1219c0', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '827c23e1-b9d7-4b03-8717-b3a37fe9e9e0', 'tests', 'test_parameters', '3acd6849-bb19-4f52-af0d-6acb33e8fa9d', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '221a7e11-dda1-4d8b-8d1b-d33eb1f452d4', 'tests', 'test_parameters', '6464e753-6674-4d8d-96ce-095309b19d1d', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '4305b2c3-47da-4bba-b4e0-bf611211f3ba', 'tests', 'test', '09e81600-1f1f-42b7-8bf2-5ff7f55f6894', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '4305b2c3-47da-4bba-b4e0-bf611211f3ba', 'tests', 'test_versions', 'a7ed6754-558f-4c28-9c0b-9d23015b15df', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '274c9d74-e7e1-4e28-a599-9fabd98967e0', 'tests', 'test_parameters', '38e7f2df-aa97-48f8-a4f4-1719bc88c983', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '6aaf4e99-538f-436c-8bb3-c7fc56ffd9a2', 'tests', 'test', '808917ae-5a4c-4332-9ff1-4d783890fef4', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '6aaf4e99-538f-436c-8bb3-c7fc56ffd9a2', 'tests', 'test_versions', '15e63985-0b4b-4f1d-951e-7f3888159cf5', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '21c55ad7-0c1a-47c9-baca-2267c589b8cb', 'tests', 'test_parameters', '4ddb0c0e-f281-47ec-b143-fce13e2ca3db', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '1146786f-e917-4828-b5a6-2a736a23c0ca', 'tests', 'test_parameters', '1eae6ce7-42c3-473a-9413-ab83f5db6dc6', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '958a950c-47c5-4047-ace6-f50fc7d128f6', 'tests', 'test_parameters', '9dcd8e2a-7153-48ad-ae26-de057588581f', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '2acd2805-721b-466e-8d10-662bfc40167d', 'tests', 'test_parameters', '50dc8ec3-c1ed-476d-a3ef-c4925ef3172e', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', 'e7f0de2e-f0b5-4faf-a738-2b59baa7670e', 'tests', 'test', 'f64bcc15-3a3e-4a70-a70a-372e678c8871', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', 'e7f0de2e-f0b5-4faf-a738-2b59baa7670e', 'tests', 'test_versions', 'cf1ae144-6c77-4f31-b226-6efc70a21bc6', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '0d004ad9-69f0-4e6c-84a5-5d43a7b67ab0', 'tests', 'test_parameters', '48519092-29e8-487f-97bd-86df5f96968f', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '85ab0721-7577-43cd-9ef8-16260f6caf39', 'tests', 'test_parameters', 'ca60b8ef-5b4e-4766-af37-b0b5116b5052', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '7f65ccb0-a4f0-40d4-941e-245a0a63c428', 'tests', 'test', '317cbf6c-7ced-4d53-b71a-7b0430ee31fa', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', '7f65ccb0-a4f0-40d4-941e-245a0a63c428', 'tests', 'test_versions', '22d52cd8-22ee-456f-b224-6c0511d14635', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '5a6e8821-256b-4d27-b69a-38cd8ae7e9c0', 'tests', 'test_parameters', '82384ae5-30bd-4425-86c2-d29140d86ea2', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', 'a38020da-9ef3-4dbb-b422-f880a63dae84', 'tests', 'test', 'dc6024a8-df73-4ef9-ba1f-b4e9f550b044', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test', 'a38020da-9ef3-4dbb-b422-f880a63dae84', 'tests', 'test_versions', 'dfa1757b-8ee9-4fb5-beb1-760e061bbf5a', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_parameters', '48ce1094-b734-4ecd-860c-a62de6c41600', 'tests', 'test_parameters', 'fa5b41bc-39c7-4213-be90-ea13fa7a8a98', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_battery', '3a29daa3-a36e-409b-8117-0aad8b43f15a', 'tests', 'test_battery', '2b4eb1cb-4263-41c9-b553-b547bbbdf022', 'direct', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_battery', '3a29daa3-a36e-409b-8117-0aad8b43f15a', 'tests', 'test_battery_versions', '833457a3-43f0-4254-9fd4-d9ff3e5703a7', 'transformed', 'monitoring2-fms-wellness-2026-08-22', null),
  ('monitoring2', 'tests', 'test_structure_links', '4a8c2224-1034-4a4d-8a27-5d2dd1ad29ae', 'tests', 'test_battery_items', 'ccafa76a-7836-434b-84b9-6fb0f02db061', 'transformed', 'monitoring2-fms-wellness-2026-08-22', 'order_index is an explicit OptiMove product decision (functional order), not derived from legacy created_at'),
  ('monitoring2', 'tests', 'test_structure_links', 'ebb22956-0187-43e1-844d-3481733703d0', 'tests', 'test_battery_items', '1b56c942-835c-4dd2-b626-ebe9d232ebb4', 'transformed', 'monitoring2-fms-wellness-2026-08-22', 'order_index is an explicit OptiMove product decision (functional order), not derived from legacy created_at'),
  ('monitoring2', 'tests', 'test_structure_links', '023d0840-a539-4e1b-bce8-675f985a827b', 'tests', 'test_battery_items', 'fc52df60-3160-4bd3-84ab-d621846a6219', 'transformed', 'monitoring2-fms-wellness-2026-08-22', 'order_index is an explicit OptiMove product decision (functional order), not derived from legacy created_at'),
  ('monitoring2', 'tests', 'test_structure_links', '2a88baeb-76ff-42a4-bf00-b1c0694f7011', 'tests', 'test_battery_items', 'afd67770-3f4d-48cd-bd0d-18b2a5bbf0b3', 'transformed', 'monitoring2-fms-wellness-2026-08-22', 'order_index is an explicit OptiMove product decision (functional order), not derived from legacy created_at'),
  ('monitoring2', 'tests', 'test_structure_links', '0cf3ec85-e657-48be-b483-5b7cf396970e', 'tests', 'test_battery_items', '0896b151-3b37-44ee-8688-47e64d31780d', 'transformed', 'monitoring2-fms-wellness-2026-08-22', 'order_index is an explicit OptiMove product decision (functional order), not derived from legacy created_at'),
  ('monitoring2', 'tests', 'test_structure_links', 'a0835dd0-4cd9-47a9-8413-8d776dab534d', 'tests', 'test_battery_items', '40276516-8e0d-44b6-a5f5-a233f317bb21', 'transformed', 'monitoring2-fms-wellness-2026-08-22', 'order_index is an explicit OptiMove product decision (functional order), not derived from legacy created_at'),
  ('monitoring2', 'tests', 'test_structure_links', '02ef55f7-bc22-4e72-a181-5b2b752bff70', 'tests', 'test_battery_items', 'c8d4ca29-d6fa-4229-bde4-5de5726293b8', 'transformed', 'monitoring2-fms-wellness-2026-08-22', 'order_index is an explicit OptiMove product decision (functional order), not derived from legacy created_at'),
  ('monitoring2', 'tests', 'test_structure_links', '43d5a6e0-7439-417c-9065-8dd728b5b23a', 'tests', 'test_battery_items', '7d5486de-154b-4a6c-b0cd-d0a84a857797', 'transformed', 'monitoring2-fms-wellness-2026-08-22', 'order_index is an explicit OptiMove product decision (functional order), not derived from legacy created_at'),
  ('monitoring2', 'tests', 'test_structure_links', 'a0458e42-af55-4285-899e-9332df6df53c', 'tests', 'test_battery_items', 'dd32ed1b-1d97-4211-82ab-93e2dfd159fd', 'transformed', 'monitoring2-fms-wellness-2026-08-22', 'order_index is an explicit OptiMove product decision (functional order), not derived from legacy created_at'),
  ('monitoring2', 'tests', 'test_structure_links', '920fcd51-017f-471c-b3b7-1d27fa1a2a7c', 'tests', 'test_battery_items', 'dd718fea-2b40-440e-b5cb-bb36d659f7d9', 'transformed', 'monitoring2-fms-wellness-2026-08-22', 'order_index is an explicit OptiMove product decision (functional order), not derived from legacy created_at'),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_item_parameter_selections', '3ff3f303-d550-4305-8a61-66179305954b', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_item_parameter_selections', '7ce832c4-6197-4c8e-aa40-98ccdd466aff', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_item_parameter_selections', 'e7e35f88-d11d-4286-9daf-de32a20e4bc0', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_item_parameter_selections', '6e6923e6-ddc5-49f2-9522-d07974117903', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_item_parameter_selections', '92a19063-6de8-43d9-952a-f3a2ab69a475', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_item_parameter_selections', '07296138-cd09-4546-9abc-629e15a853fb', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_item_parameter_selections', '582e0abc-5e96-4ae4-a04d-8ccc3ac0dcd3', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_item_parameter_selections', 'e08b1801-8428-4f3d-8c11-df5818b80877', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_item_parameter_selections', 'b045aa04-3c9f-42ec-8b56-da6018f2c2be', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_item_parameter_selections', '1ab49306-351e-4b83-af0a-b5037adc67ff', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_item_parameter_selections', '2351c950-cbc0-462b-83b9-def791087c48', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameters', 'b80ef81c-b8d7-4ff0-b798-c8e32293cc2d', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameters', '9a3acfe0-d46d-40f2-9052-0cae82e242b4', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameters', '759d27be-104e-4f71-a52f-63f320a9cf53', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameters', '20b7242d-39a6-4b3e-8143-19ebbdef3ee0', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', 'e1ba86e7-4427-451f-9537-36ed8a37877b', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', '044eb74e-6b3b-4b4b-a33f-d2b6582cbb33', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', 'd1527aad-c347-46f1-b522-09bf0e228fcc', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', 'f0759001-7e01-4a2d-a7af-4cd6aaa72fb3', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', 'd5e51f97-a9ec-40ab-992d-a3ae04335ab6', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', '4ae55f3b-cae6-48ab-a6c0-f32398a673fd', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', 'e1dfb9bb-3164-48bf-8c8e-a746b91877cd', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', '62dbae4a-72df-48a1-98b9-ac0479bb8aae', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', '1a18a85a-24ca-4694-abf0-fbd42dba53a7', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', '21aa3bab-a1c7-4420-959d-156c620d856a', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', '19e372a5-4464-430d-9b11-77a624b018a1', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', '1df298af-e632-4d66-8188-b58a1f94f585', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', 'f2b7b963-acb7-415d-9597-f5c56fb52706', 'generated', 'monitoring2-fms-wellness-2026-08-22', null),
  ('optimove_seed', null, null, null, 'tests', 'test_battery_derived_parameter_inputs', '891825ae-1a9b-433b-bdd1-0ff5a2fbdbc0', 'generated', 'monitoring2-fms-wellness-2026-08-22', null);
