-- Seed shared multi-athlete custom exercises.
-- Generated from verified local package. Do not run manually outside the deploy migration runner.

begin;

create extension if not exists pgcrypto;

do $$
declare
  v_payload_checksum constant text := '17d5891454c37286d223eef6ee7ed871f0ea291240b124598eac29e04a8632ee';
  v_owner_email constant text := 'predrag.bozic@rzsport.gov.rs';
  v_owner_id uuid;
  v_custom_exercises jsonb := '[{"slug":"milos-milovic-102-cleaned-2026-08-18:custom:intervalno-trcanje-12s-70m-pravolinijski-18s-pasivna-pauza-2-min-pauza-i:2572944bbe","name":"Intervalno trcanje 12s (70m pravolinijski):18s pasivna pauza. 2 min pauza između serija","instruction":"12s intervalno trčanje, 18s pasivna pauza. Ritam trčanja 12s- 70m (od 16m do 16m za 12s).","video_url":null,"image_url":"https://drive.google.com/file/d/1XlNIlBq2CvjNY8gBICiTVZCAF1RbFJWZ/view?usp=sharing","owner_scope":"user","is_active":true},{"slug":"milos-milovic-102-cleaned-2026-08-18:custom:miofasc-relaksac-aduktor:396c712eb1","name":"miofasc relaksac - aduktor","instruction":"Sporim pokretima relaksirati mišić. Ukoliko se osete odgovarajuće tačke sa povećanim tonusom na tom mestu se zadržati bez rolanja ili sa još sporijim rolanjem.","video_url":"https://drive.google.com/file/d/1CWS2V84faEuBOJgB3I8RUqd2q4juxGn7/view?usp=sharing","image_url":"https://drive.google.com/uc?id=16Zy7coWwND8HSdFW9B07_qVWsG2Qy2eK","owner_scope":"user","is_active":true},{"slug":"milos-milovic-102-cleaned-2026-08-18:custom:miofasc-relaksac-tfl:67d331c41e","name":"miofasc relaksac - TFL","instruction":"Sporim pokretima relaksirati mišić. Ukoliko se osete odgovarajuće tačke sa povećanim tonusom na tom mestu se zadržati bez rolanja ili sa još sporijim rolanjem.","video_url":"https://drive.google.com/file/d/1gS6IsthpTL2_zBEtfh0ET-bEwGwUx42l/view?usp=sharing","image_url":"https://drive.google.com/uc?id=1_ZandCp-EdE_dS0WuXp50ZxZqgfgbLhi","owner_scope":"user","is_active":true},{"slug":"milos-milovic-102-cleaned-2026-08-18:custom:rastezanje-na-velikoj-klupi-sa-pogrcenom-nogom:e86863d148","name":"Rastezanje na velikoj klupi sa pogrčenom nogom","instruction":null,"video_url":"https://drive.google.com/file/d/1UEPG2JoamM-emkEeHl0UtnSagcDy27XX/view?usp=sharing","image_url":"https://drive.google.com/uc?id=1QMr0bMjXGitAkIxmmLbmqsMjLI0taJW7","owner_scope":"user","is_active":true},{"slug":"multi-athlete-cleaned-2026-08-18:custom:miofasc-relaksac-gluteus:dc056fb0e2","name":"miofasc relaksac - gluteus","instruction":"Sporim pokretima relaksirati mišić. Ukoliko se osete odgovarajuće tačke sa povećanim tonusom na tom mestu se zadržati bez rolanja ili sa još sporijim rolanjem.","video_url":"https://drive.google.com/file/d/10t9vfYSs2LvwVYHtvHosrhwgjJiKviHy/view?usp=sharing","image_url":"https://drive.google.com/uc?id=1NmexFUnCKeLTKPM6j9JC_LKbKDwB2nvJ","owner_scope":"user","is_active":true},{"slug":"multi-athlete-cleaned-2026-08-18:custom:miofasc-relaksac-prednja-loza:7b78210115","name":"miofasc relaksac - prednja loža","instruction":"Sporim pokretima relaksirati mišić. Ukoliko se osete odgovarajuće tačke sa povećanim tonusom na tom mestu se zadržati bez rolanja ili sa još sporijim rolanjem.","video_url":"https://drive.google.com/file/d/1ZjVmDTUoxFb4FK5m4z7E2Nm8GCE9l2Ki/view?usp=sharing","image_url":"https://drive.google.com/uc?id=1FiB5N7_jnOnLUsbEYfmMMlMrCiKzXjFS","owner_scope":"user","is_active":true},{"slug":"multi-athlete-cleaned-2026-08-18:custom:miofasc-relaksac-pregibac-kuka:c65aeebed0","name":"miofasc relaksac - pregibač kuka","instruction":"Sporim pokretima relaksirati mišić. Ukoliko se osete odgovarajuće tačke sa povećanim tonusom na tom mestu se zadržati bez rolanja ili sa još sporijim rolanjem.","video_url":"https://drive.google.com/file/d/1SArbSDRIqAERfN5noe20U2Cdy1fjaZbC/view?usp=sharing","image_url":"https://drive.google.com/uc?id=1XM2h5RJBj-p3xKhwzXbCdrbwdNDJC4Hc","owner_scope":"user","is_active":true},{"slug":"multi-athlete-cleaned-2026-08-18:custom:most-sa-jednom-nogom-niska-promena:7a65818919","name":"Most sa jednom nogom - niska promena","instruction":"Zadržati gornju poziciju 1-2s posle promene nogu. Ostati prav kao daska tokom promene nogu. Gurati kukove ka plafonu. Visina slobodne noge definiše težinu vežbe. Kolena blago pogrčena, skoro ispravljena","video_url":"https://drive.google.com/file/d/13vUIfDb-MyHSRxdY6By2bz2j5IzM2jjO/view?usp=sharing","image_url":"https://drive.google.com/uc?id=1bhSQLxpCKBKvaVd61n1fT4sg8NsdPel_","owner_scope":"user","is_active":true},{"slug":"multi-athlete-cleaned-2026-08-18:custom:naizmenicno-prebacivanje-noge-preko-sa-dodirivanjem-odrucene-ruke-u-leza:cacda9f433","name":"Naizmenično prebacivanje noge preko sa dodirivanjem odručene ruke u ležanju na stomaku","instruction":null,"video_url":"https://drive.google.com/file/d/1YyZMFq5BT3DU0YhSbg5k84KPshAHzBEy/view?usp=sharing","image_url":"https://drive.google.com/uc?id=1Myho8UVyRG4k_X0bZ4ExXQh47kiYTzUy","owner_scope":"user","is_active":true},{"slug":"multi-athlete-cleaned-2026-08-18:custom:podizanje-kukova-u-lezanju-na-ledjima-druga-noga-pogrcena-i-drzi-tenisku:3066c7f658","name":"Podizanje kukova u ležanju na leđima druga noga pogrčena i drži tenisku lopticu u nivou kuka","instruction":null,"video_url":"https://drive.google.com/file/d/1x_scAt8WkaCrIVtSTOy3RBV9BsMP5jq2/view?usp=sharing","image_url":"https://drive.google.com/uc?id=1QKDy0_bJSBWajE-pHto93r23qnJy7Zwh","owner_scope":"user","is_active":true},{"slug":"multi-athlete-cleaned-2026-08-18:custom:podizanje-kukova-u-lezanju-na-ledjima-druga-noga-pogrcena-i-u-zavrsnom-p:38fdbb0081","name":"Podizanje kukova u ležanju na leđima druga noga pogrčena i u završnom položaju se opruža vertikalno","instruction":null,"video_url":"https://drive.google.com/file/d/1mC0N5Yy6EcpDgYQ8nyMSGf5uxwyBZxqj/view?usp=sharing","image_url":"https://drive.google.com/uc?id=18X0Bocoa6jZbo97y6Gcrsdr8kcCXJ-cB","owner_scope":"user","is_active":true},{"slug":"multi-athlete-cleaned-2026-08-18:custom:stride-with-torso-rotation:5bfdeebb72","name":"Stride With Torso Rotation","instruction":"Set-Up: Stand tall with one leg on an elevated surface just above the height of the knee. The hip, knee, and ankle of the up leg are all in line and the pelvis is level. The foot on the ground is pointing straight forward. Action: Put the hands over the head, inhale and exhale while rotating towards the up leg, maintain a tall spine as well as hip, knee, and ankle alignment. Return: Rotate back to the start position.","video_url":"https://drive.google.com/file/d/1qVLZPR5rcB-uTQQSgEJi5nMHrXd_Tf-x/view?usp=sharing","image_url":"https://drive.google.com/uc?id=1yDf35n-wLMQ5FMBdbl7riRoOOa4U7tQn","owner_scope":"user","is_active":true},{"slug":"multi-athlete-cleaned-2026-08-18:custom:v-sed-udarci-tegom-iznad-glave:94755b87bc","name":"V sed - udarci tegom iznad glave","instruction":"Sporo postaviti teg u uzručenje održavajući stabilnu poziciju tela poziciju tela. Zadržati krajnju poziciju 2-3s i poziciju tela tokom potiska. Izbaciti grudi tokom potiska.","video_url":"https://drive.google.com/file/d/1Ub3oNWzjF_vsTT1mVATvvWbarUMzH1Fz/view?usp=sharing","image_url":"https://drive.google.com/uc?id=1IZo3BLgq8o8yiEhh44A4jHpdKBWfHy59","owner_scope":"user","is_active":true},{"slug":"nikola-vujinivic-103-cleaned-2026-08-18:custom:prelasci-unapred-hodom-preko-prepona-jedna-noga-napada-ruke-iza-glave:0c194bc00b","name":"Prelasci unapred hodom preko prepona (jedna noga napada) - ruke iza glave","instruction":"Postaviti ruke iza glave. Biti u svakom momentu što je moguće viši na prstima i opružen i bez rotacija u gornjem delu, grudi izbačene, zadržati stabilnu pozciju ruku (da se ne pomeraju napred nazad). Prepone razmaknute 4 stope.","video_url":"https://drive.google.com/file/d/1IOa0nEnt7BksTkpUf2VBS4yaNUQpAsDx/view?usp=share_link","image_url":"https://drive.google.com/uc?id=1Lv1jN3CcJEfsy8FYGFvPHa2q1zghT8Gs","owner_scope":"user","is_active":true}]'::jsonb;
  r jsonb;
begin
  select id into v_owner_id from public.users where lower(email) = lower(v_owner_email) and coalesce(is_active, true) limit 2;
  if v_owner_id is null or (select count(*) from public.users where lower(email) = lower(v_owner_email) and coalesce(is_active, true)) <> 1 then
    raise exception 'Multi-athlete custom exercise seed: expected exactly one active owner user %', v_owner_email;
  end if;

  for r in select * from jsonb_array_elements(v_custom_exercises) loop
    if exists (select 1 from library.exercises where slug = r->>'slug') then
      if not exists (
        select 1 from library.exercises
        where slug = r->>'slug'
          and exercise_code is null
          and name = r->>'name'
          and owner_scope = 'user'
          and owner_user_id = v_owner_id
          and created_by_user_id = v_owner_id
          and instruction is not distinct from nullif(r->>'instruction', '')
          and video_url is not distinct from nullif(r->>'video_url', '')
          and image_url is not distinct from nullif(r->>'image_url', '')
          and coalesce(is_active, true) = coalesce((r->>'is_active')::boolean, true)
      ) then
        raise exception 'Multi-athlete custom exercise seed: slug % exists with different content/owner', r->>'slug';
      end if;
    else
      insert into library.exercises (owner_scope, owner_user_id, created_by_user_id, exercise_code, slug, name, instruction, video_url, image_url, is_active)
      values ('user', v_owner_id, v_owner_id, null, r->>'slug', r->>'name', nullif(r->>'instruction', ''), nullif(r->>'video_url', ''), nullif(r->>'image_url', ''), coalesce((r->>'is_active')::boolean, true));
    end if;
  end loop;

  if (
    select count(*) from library.exercises e
    where e.slug in (select value->>'slug' from jsonb_array_elements(v_custom_exercises) value)
      and e.owner_scope = 'user'
      and e.owner_user_id = v_owner_id
      and e.created_by_user_id = v_owner_id
      and e.exercise_code is null
      and coalesce(e.is_active, true)
  ) <> 14 then
    raise exception 'Multi-athlete custom exercise seed: expected 14 custom exercises after seed';
  end if;
end $$;

commit;
