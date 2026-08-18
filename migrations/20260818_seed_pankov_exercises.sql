-- Seed the 32 exercise-only Pankov package prepared locally on 2026-08-18.
-- This migration intentionally does not touch users, athletes, plans, plan nodes, sections, or assignments.

do $pankov_exercise_seed$
declare
  package_label constant text := 'pankov-exercises-2026-08-18';
  package_data constant jsonb := '[
  {
    "exercise_code": "1188",
    "package_key": "1188",
    "slug": "skip-sa-ubrzanjem-1188-pankov-exercises-2026-08-18",
    "name": "Skip sa ubrzanjem",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Skip sa poskakivanjem unapred. Povećavati dužinu odskoka tokom skipa (odskok više horizontalno nego vertikalno). Kratak kontakt sa podlogom i odkočiti unapred što duže. Distancu savladavati sa što manje koraka.",
    "execution_notes": "10-15m",
    "instruction": "1",
    "video_url": "https://drive.google.com/file/d/1x4xAUn7fTPwGlFT4c4M1Y7WPtDiIbg68/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1X8eTCPpGKorTIPVjawHvDaSgK-yn_3VC/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1189",
    "package_key": "1189",
    "slug": "kontinuirano-trcanje-1189-pankov-exercises-2026-08-18",
    "name": "Kontinuirano trčanje",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Ritam trčanja 12km/h, 100m 30s, 1000m 5min.2 min pauza između serija",
    "execution_notes": null,
    "instruction": null,
    "video_url": null,
    "image_url": "https://drive.google.com/file/d/1HTUb9CUcxiXqfzDYtk_fP0qffDt8Q7RA/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Field",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1190",
    "package_key": "1190",
    "slug": "adductor-izometrijske-kontrakcije-v1-1190-pankov-exercises-2026-08-18",
    "name": "Adductor izometrijske kontrakcije V1",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Zadržati po 10s svaki položaj, intenzitet kontrakcije 30-70%",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1HphbTpoxc67amU70-H94d_E25X3j81GN/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/12gDN2k-brU4KkhQ8eDoUvhV1h72jwGt3/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1191",
    "package_key": "1191",
    "slug": "adductor-izometrijske-kontrakcije-v2-1191-pankov-exercises-2026-08-18",
    "name": "Adductor izometrijske kontrakcije V2",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Zadržati po 10s svaki položaj, intenzitet kontrakcije 30-70%",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1FTNjogASH2jpKY1dUtzspnY258NZ61g8/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1AQ1BNWIuYlp3gIsMykpKpLlH4Alpr1OF/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1192",
    "package_key": "1192",
    "slug": "adductor-izometrijske-kontrakcije-na-stomaku-sa-loptom-1192-pankov-exercises-2026-08-18",
    "name": "Adductor izometrijske kontrakcije na stomaku sa loptom",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Intenzitet kontrakcije 30-70%",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1MBVCY474EGanVU3GRi_NkD20WvVcCTyr/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1zbu4V2jEWd1QxCYiKS_PBgVtYHsyJauJ/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1193",
    "package_key": "1193",
    "slug": "adductor-izometrijska-kontrakcija-u-bocnom-planku-sa-potiskom-lopte-1193-pankov-exercises-2026-08-18",
    "name": "Adductor izometrijska kontrakcija u bočnom planku sa potiskom lopte",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Intenzitet kontrakcije 30-70%",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1Nks-KhXNAzWcEVGulXiSzlI8T_jH6Ko7/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1v-48kXFr78pMlkLlBOQuumzKF0-E1Zm3/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1194",
    "package_key": "1194",
    "slug": "aktivacija-ahil-u-poziciji-ubrzanja-sa-rotacijama-1194-pankov-exercises-2026-08-18",
    "name": "Aktivacija ahil u poziciji ubrzanja sa rotacijama",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Rotriranje trupom u poziciji ubrzanja, prednji deo stopala postavljen na balanser, skočni zglob se ne pomera, prsti stopala aktivirani, grabe podlogu. Rotirati se trupom u cilju većeg izazova. Grudi izbačene",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1VfqM6CVJ6EjNL29hPU7f-egX80eoc812/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1PGkXszX47Jqll0XhVGS6D_Se7ALwW-Ir/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1195",
    "package_key": "1195",
    "slug": "aktivacija-ahil-guranjem-zida-1195-pankov-exercises-2026-08-18",
    "name": "Aktivacija ahil guranjem zida",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Guranje zida, prednji deo stopala postavljen na balanser, skočni zglob se ne pomera, prsti stopala aktivirani, grabe podlogu. Kuk zaključan, ruka stajne noge što je moguće više podignuta",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1ojhN2GQLZB5MIFL4oc5NpNMjAGHoaDca/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1EnBDexoPuodX7Qvg2GTNn3OPWD3nur_e/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1196",
    "package_key": "1196",
    "slug": "aktivacija-ahil-stajanjem-na-jednoj-nozi-1196-pankov-exercises-2026-08-18",
    "name": "Aktivacija ahil stajanjem na jednoj nozi",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Prednji deo stopala postavljen na balanser, skočni zglob se ne pomera, prsti stopala aktivirani, grabe podlogu. Kuk zaključan, ruka stajne noge što je moguće više podignuta",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1aaNAf5gtrKrx2IzRHCO_P6sRu6nrTN4u/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/14UEofsM5iQdN6yeP3H_Z7_mfKQoMqzud/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1197",
    "package_key": "1197",
    "slug": "aktivacija-ahil-u-polucucnju-sa-pomeranjem-slobodne-noge-napred-nazad-1197-pankov-exercises-2026-08-18",
    "name": "Aktivacija ahil u polučučnju sa pomeranjem slobodne noge napred nazad",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Prednji deo stopala postavljen na balanser, skočni zglob se ne pomera, prsti stopala aktivirani, grabe podlogu.",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1oVBsc3jBd62EFJNqSVDqO5ymZ3q4HoJg/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1y8YW7aymhtW7FD7TttvaeUV3RVZ04AzY/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1198",
    "package_key": "1198",
    "slug": "aktivacija-donja-ledja-serije-1198-pankov-exercises-2026-08-18",
    "name": "Aktivacija donja leđa - serije",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Zadržati položaj trupa stabilnim bez obzira na pokrete rukama i nogama. Ukoliko je neki položaj previše izazovan, zadržati se na položajima koje je moguće izvesti",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1180PGMY699Oi11C9_DPp0XyOHUkHs1va/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1FrJifu5_0F4gTYZmbppcecHhN6sRWoZi/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1199",
    "package_key": "1199",
    "slug": "aktivacija-pregibac-kuka-u-uporu-sa-jednom-nogom-na-lopti-1199-pankov-exercises-2026-08-18",
    "name": "Aktivacija pregibač kuka u uporu sa jednom nogom na lopti",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Pregibanje slobonom nogom u različitim smerovima, napred, unutra, sa strane",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1wqajX4FZoeWE8Q3rjrcUyFEfoFDdmZXV/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1qdwqmf3iTDcI5WjRbRSgFXx46yxKqXba/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1200",
    "package_key": "1200",
    "slug": "aktivacija-pregibac-kuka-u-uporu-sa-mini-gumom-1200-pankov-exercises-2026-08-18",
    "name": "Aktivacija pregibač kuka u uporu sa mini gumom",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Pregibanje zatezanjem mini gume",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1RHSUSlUDpyxgq9vHLuAjZj5J3GLvRPUm/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/194LaQ634JEBRcCyYi2BltUCuxHaU09Es/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1201",
    "package_key": "1201",
    "slug": "aktivacija-pregibac-kuka-u-stajanju-sa-mini-gumom-1201-pankov-exercises-2026-08-18",
    "name": "Aktivacija pregibač kuka u stajanju sa mini gumom",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Pregibanje zatezanjem mini gume",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1IdOSuLBGrK6Cu4CCzyFbwyXLpD-3FicW/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1Na86kS4Y3Zjjl8TOS-i8-FSCjWkPCBY-/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1202",
    "package_key": "1202",
    "slug": "aktivacija-quad-u-obrnutom-nordik-polozaju-1202-pankov-exercises-2026-08-18",
    "name": "Aktivacija quad u obrnutom nordik položaju",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Zadrška u položaju klečanja sa trupom postavljenim unazad. u cilju većeg zahteva raditi vežbu sa medicinkom",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1ZY7sLKug_dAW6ST8UMNu4xBmAIK7I1ms/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1xAbS8j2R-AX6gSG1RLa4NkkhI-H4TSKZ/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1203",
    "package_key": "1203",
    "slug": "potisak-medicinkom-u-obrnutom-nordik-polozaju-1203-pankov-exercises-2026-08-18",
    "name": "Potisak medicinkom u obrnutom nordik položaju",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Potisak medicinkom u položaju klečanja sa trupom postavljenim unazad. Zadrška 2s",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1TeQVIa4vzyUWDNWCAqrGtiTJ2tE9J2rp/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1K8OpAbnX4mySFbLUvz9Dhq8xYvFxenxA/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1204",
    "package_key": "1204",
    "slug": "aktivacija-rectus-u-klececem-iskoraku-sa-potiskom-lopte-zadnjom-nogom-1204-pankov-exercises-2026-08-18",
    "name": "Aktivacija rectus u klečećem iskoraku sa potiskom lopte zadnjom nogom",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Pritisak zadnjom nogom na loptu, intenzitet kontrakcije 30-70%",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1q90fqg_AjvMy7_KcjL0ouoSPCD5Nj6nV/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1p1AAJ3M2EbVuS6XtCUPsXqp7QsZrXlFz/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1205",
    "package_key": "1205",
    "slug": "izo-kontrakcije-u-klececem-iskoraku-sa-potiskom-lopte-zadnjom-nogom-1205-pankov-exercises-2026-08-18",
    "name": "Izo kontrakcije u klečećem iskoraku sa potiskom lopte zadnjom nogom",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Pritisak zadnjom nogom na loptu, intenzitet kontrakcije maksimalan tokom 5s",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1CyY-KTcqbZQk39AMUk5WZcem5O4i3VPQ/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/14AvUk_uZ9YoVgDgVY6bsLPtvFE3Fn34w/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1206",
    "package_key": "1206",
    "slug": "ecc-rectus-u-iskoraku-sa-asistencijom-rukama-1206-pankov-exercises-2026-08-18",
    "name": "Ecc rectus u iskoraku sa asistencijom rukama",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Spuštanje i iskoraku sa trupom postavljenim unazad (veće optrećenje na zadnju nogu). Spuštati se tokom 5s, vraćanje unazad sa asistenicjom ruku",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/13kepy3JuGpRrRk4dFVrEYsd_6zhMT4Lo/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/14J7Lk96KAyyKcWSe4IvNIysA6Qjch8qP/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Hard",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1207",
    "package_key": "1207",
    "slug": "most-sa-obe-noge-1207-pankov-exercises-2026-08-18",
    "name": "Most sa obe noge",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Kukove podignuti i poravnati sa trupom. Zadrška 2-4s",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/10SeylFbCLBiXafxjOueB_wkYNaKzo9tV/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1mTf9hVv5Yq473Cawi94mBWt2URMopUej/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1208",
    "package_key": "1208",
    "slug": "most-sa-obe-noge-pregibanje-jednom-1208-pankov-exercises-2026-08-18",
    "name": "Most sa obe noge + pregibanje jednom",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Kukove podignuti obema i poravnati sa trupom. Nakon toga jednom nogom izvršiti pregibanje u zglobu kuka. Zadrška 2-4s",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1TpFYumPGBf50qwpxVWVwixe0T-RhU-RO/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/16OKot07L5ktlbJ6Ibop-8AzAeuIMVYQ5/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1209",
    "package_key": "1209",
    "slug": "most-sa-jednom-nogom1-1209-pankov-exercises-2026-08-18",
    "name": "Most sa jednom nogom1",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Kukove podignuti jednom nogom i poravnati sa trupom. Nakon toga jednom nogom izvršiti pregibanje u zglobu kuka. Zadrška 2-4s",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/18L2hEkbsXPvQl3JSukbJSWoOW-oZebfF/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1tHwoaCqqQSLwXRuLsxOVGUXsZ9E6it5Y/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1210",
    "package_key": "1210",
    "slug": "potisak-medicinokom-unazad-i-sa-rotaicjama-u-klececem-iskoraku-1210-pankov-exercises-2026-08-18",
    "name": "Potisak medicinokom unazad i sa rotaicjama u klečećem iskoraku",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Potisak medicinkom u položaju klečećeg iskoraka sa trupom postavljenim unazad. Udarci sa medicinkom u različitim smerovima. Zadrška 2s",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/184NcJRUaRptToKCiJFuE3CC18MRb-MEO/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1DA_eS0t_i_jtPYWh0ZFjZb8jyh7_NlLF/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1211",
    "package_key": "1211",
    "slug": "potisak-medicinokom-unazad-u-klececem-iskoraku-1211-pankov-exercises-2026-08-18",
    "name": "Potisak medicinokom unazad u klečećem iskoraku",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Potisak medicinkom u položaju klečećeg iskoraka sa trupom postavljenim unazad. Zadrška 2s",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1GQTLD7mrtSxg3VZ6Jyl7RSOH-fLzeXY3/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1JlvkUGmSvI42iMJCgtpdSICXrOl4-gra/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1212",
    "package_key": "1212",
    "slug": "potisak-medicinkom-sa-rotacijam-trupom-u-obrnutom-nordik-polozaju-1212-pankov-exercises-2026-08-18",
    "name": "Potisak medicinkom sa rotacijam trupom u obrnutom nordik položaju",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Potisak medicinkom u položaju klečanja sa trupom postavljenim unazad. Udarci sa medicinkom u različitim smerovima. Zadrška 2s",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1SvCVur2pxpoqwZ-6arbbBxaUBiI5TALG/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1gwvZTC_yOfRyCR-HjPZOGOEK0FIpSXB5/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1213",
    "package_key": "1213",
    "slug": "cucnjevi-u-iskoraku-sa-potiskom-medicinke-unazad-1213-pankov-exercises-2026-08-18",
    "name": "Čučnjevi u iskoraku sa potiskom medicinke unazad",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Spuštanje i iskoraku sa trupom postavljenim unazad (veće optrećenje na zadnju nogu) i istovremenim potiskom medicinkom. Spuštati se tokom 5s",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1hr1Kvg_oV0NYUGoHHpcq0EdOkywB7NNU/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1TQqJr_pXW-G8ACyT_cVbNuzouGb9I7Ml/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Hard",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1214",
    "package_key": "1214",
    "slug": "skok-iz-polucucnja-na-udaljenu-klupu-1214-pankov-exercises-2026-08-18",
    "name": "Skok iz polučučnja na udaljenu klupu",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Iz polučučnja, bez dodatnog zamaha na dole, skočiti na udaljenu klupu. Održati trup vertikalnijim",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1j1PGLhxqpMVVIZg2nw6ZTHhPyhDT1i97/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1ch5BeFUS6ZT5csHZmMwpkiYkwASRK5v1/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Hard",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1215",
    "package_key": "1215",
    "slug": "stolica-na-jednoj-nozi-1215-pankov-exercises-2026-08-18",
    "name": "Stolica na jednoj nozi",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Zadrška na jednoj nozi u položaju stolice",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1dVT3EHGs894oTSRHJpCwimkCHK9t-LzC/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1LDevH5qt9HKs3WWI6VxVE2RmtX1-HlCL/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1216",
    "package_key": "1216",
    "slug": "stolica-na-obe-noge-1216-pankov-exercises-2026-08-18",
    "name": "Stolica na obe noge",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Zadrška na obe noge u položaju stolice",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1pnSF465jGYTAykxebhJh1ExC4raikSqf/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1oPTeHlrP8Iu5MKnFMvJSb-v5uL2HRSfQ/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Easy",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1217",
    "package_key": "1217",
    "slug": "v-sed-serije-sa-nogama-i-rukama-1217-pankov-exercises-2026-08-18",
    "name": "V sed serije sa nogama i rukama",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "V - sed serije sa rukama i nogama",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1iBNoAwhUT3Q3UkevZdGSgnqmbfHX2OCi/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1sPFDfbPuXRW48egV0PdQO6-NGNH4DO3C/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": "1218",
    "package_key": "1218",
    "slug": "obrnuto-nordijsko-spustanje-sa-medicinkom-1218-pankov-exercises-2026-08-18",
    "name": "Obrnuto nordijsko spuštanje sa medicinkom",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Kontrolisano se spuštati ka nazad tokom 5s, vraćanje sa asistenciom medicinkom",
    "execution_notes": null,
    "instruction": null,
    "video_url": "https://drive.google.com/file/d/1HRRh_s9AIIuh6P4_mnF8udoBqITvNeFp/view?usp=drive_link",
    "image_url": "https://drive.google.com/file/d/1PQWb6DiDlorj91SMxlKP_8rn1adMU3KC/view?usp=drive_link",
    "image_mime_type": null,
    "is_active": true,
    "place": "Gym",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  },
  {
    "exercise_code": null,
    "package_key": "custom:pankov-exercises-2026-08-18:kontinuirano-trcanje-12km-h-100m-30s-1000m-5min",
    "slug": "kontinuirano-trcanje-12km-h-100m-30s-1000m-5min-custom-pankov-exercises-2026-08-18",
    "name": "Kontinuirano trčanje (12km/h, 100m 30s, 1000m 5min)",
    "owner_scope": "user",
    "owner_email": "predrag.bozic@rzsport.gov.rs",
    "created_by_email": "predrag.bozic@rzsport.gov.rs",
    "aim": "Custom vežba za Pankov import. Ritam trčanja 12km/h, 100m 30s, 1000m 5min.",
    "execution_notes": null,
    "instruction": null,
    "video_url": null,
    "image_url": null,
    "image_mime_type": null,
    "is_active": true,
    "place": "Field",
    "complexity": "Moderate",
    "starting_position": null,
    "attractor": null,
    "purposes": [],
    "qualities": [],
    "groups": [],
    "body_parts": [],
    "movement_patterns": [],
    "tags": []
  }
]'::jsonb;
  item jsonb;
  owner_user_id uuid;
  created_by_user_id uuid;
  existing_exercise_id uuid;
  existing_count integer;
  place_id uuid;
  complexity_id uuid;
  starting_position_id uuid;
  attractor_id uuid;
  inserted_exercise_id uuid;
  lookup_name text;
  lookup_id uuid;
  sort_index integer;
begin
  if jsonb_array_length(package_data) <> 32 then
    raise exception 'Pankov exercise seed expected 32 rows, got %', jsonb_array_length(package_data);
  end if;

  for item in select value from jsonb_array_elements(package_data) loop
    select count(*), min(id::text)::uuid into existing_count, existing_exercise_id
    from public.users
    where lower(email) = lower(item->>'owner_email')
      and coalesce(is_active, true);

    if existing_count <> 1 then
      raise exception 'Pankov exercise seed requires exactly one active owner user for %, found %', item->>'owner_email', existing_count;
    end if;

    owner_user_id := existing_exercise_id;

    select count(*), min(id::text)::uuid into existing_count, existing_exercise_id
    from public.users
    where lower(email) = lower(item->>'created_by_email')
      and coalesce(is_active, true);

    if existing_count <> 1 then
      raise exception 'Pankov exercise seed requires exactly one active creator user for %, found %', item->>'created_by_email', existing_count;
    end if;

    created_by_user_id := existing_exercise_id;
    existing_exercise_id := null;

    if nullif(item->>'exercise_code', '') is not null then
      select count(*), min(id::text)::uuid into existing_count, existing_exercise_id
      from library.exercises
      where exercise_code = item->>'exercise_code';
    else
      select count(*), min(id::text)::uuid into existing_count, existing_exercise_id
      from library.exercises
      where exercise_code is null
        and (slug = item->>'slug' or lower(trim(regexp_replace(name, '\s+', ' ', 'g'))) = lower(item->>'name'));
    end if;

    if existing_count > 1 then
      raise exception 'Pankov exercise seed found multiple target matches for key %', item->>'package_key';
    end if;

    if existing_count = 1 then
      if exists (
        select 1
        from library.exercises e
        left join public.users owner_user on owner_user.id = e.owner_user_id
        left join public.users creator_user on creator_user.id = e.created_by_user_id
        left join library.places p on p.id = e.place_id
        left join library.complexity_levels cl on cl.id = e.complexity_level_id
        left join library.starting_positions sp on sp.id = e.starting_position_id
        left join library.attractors a on a.id = e.attractor_id
        where e.id = existing_exercise_id
          and (
            coalesce(e.exercise_code, '') is distinct from coalesce(item->>'exercise_code', '')
            or coalesce(e.name, '') is distinct from coalesce(item->>'name', '')
            or coalesce(e.owner_scope, '') is distinct from coalesce(item->>'owner_scope', '')
            or coalesce(lower(owner_user.email), '') is distinct from coalesce(lower(item->>'owner_email'), '')
            or coalesce(lower(creator_user.email), '') is distinct from coalesce(lower(item->>'created_by_email'), '')
            or coalesce(e.aim, '') is distinct from coalesce(item->>'aim', '')
            or coalesce(e.execution_notes, '') is distinct from coalesce(item->>'execution_notes', '')
            or coalesce(e.instruction, '') is distinct from coalesce(item->>'instruction', '')
            or coalesce(e.video_url, '') is distinct from coalesce(item->>'video_url', '')
            or coalesce(e.image_url, '') is distinct from coalesce(item->>'image_url', '')
            or coalesce(e.image_mime_type, '') is distinct from coalesce(item->>'image_mime_type', '')
            or coalesce(e.is_active, true) is distinct from coalesce((item->>'is_active')::boolean, true)
            or coalesce(p.name, '') is distinct from coalesce(item->>'place', '')
            or coalesce(cl.name, '') is distinct from coalesce(item->>'complexity', '')
            or coalesce(sp.name, '') is distinct from coalesce(item->>'starting_position', '')
            or coalesce(a.name, '') is distinct from coalesce(item->>'attractor', '')
            or coalesce((select jsonb_agg(d.name order by ed.sort_order, d.name) from library.exercise_domains ed join library.domains d on d.id = ed.domain_id where ed.exercise_id = e.id), '[]'::jsonb) is distinct from coalesce(item->'purposes', '[]'::jsonb)
            or coalesce((select jsonb_agg(cat.name order by ec.sort_order, cat.name) from library.exercise_categories ec join library.categories cat on cat.id = ec.category_id where ec.exercise_id = e.id), '[]'::jsonb) is distinct from coalesce(item->'qualities', '[]'::jsonb)
            or coalesce((select jsonb_agg(s.name order by es.sort_order, s.name) from library.exercise_sections es join library.sections s on s.id = es.section_id where es.exercise_id = e.id), '[]'::jsonb) is distinct from coalesce(item->'groups', '[]'::jsonb)
            or coalesce((select jsonb_agg(bp.name order by ebp.sort_order, bp.name) from library.exercise_body_parts ebp join library.body_parts bp on bp.id = ebp.body_part_id where ebp.exercise_id = e.id), '[]'::jsonb) is distinct from coalesce(item->'body_parts', '[]'::jsonb)
            or coalesce((select jsonb_agg(mp.name order by emp.sort_order, mp.name) from library.exercise_movement_patterns emp join library.movement_patterns mp on mp.id = emp.movement_pattern_id where emp.exercise_id = e.id), '[]'::jsonb) is distinct from coalesce(item->'movement_patterns', '[]'::jsonb)
            or coalesce((select jsonb_agg(t.name order by t.name) from library.exercise_tags et join library.tags t on t.id = et.tag_id where et.exercise_id = e.id), '[]'::jsonb) is distinct from coalesce(item->'tags', '[]'::jsonb)
          )
      ) then
        raise exception 'Pankov exercise seed conflict for key %: existing exercise has different content', item->>'package_key';
      end if;

      continue;
    end if;

    if nullif(item->>'exercise_code', '') is not null and exists (
      select 1 from library.exercises
      where lower(trim(regexp_replace(name, '\s+', ' ', 'g'))) = lower(item->>'name')
        and coalesce(exercise_code, '') <> item->>'exercise_code'
    ) then
      raise exception 'Pankov exercise seed conflict for code %: name already exists under a different code', item->>'exercise_code';
    end if;

    if nullif(item->>'exercise_code', '') is null and exists (
      select 1 from library.exercises
      where lower(trim(regexp_replace(name, '\s+', ' ', 'g'))) = lower(item->>'name')
        and exercise_code is not null
    ) then
      raise exception 'Pankov exercise seed conflict for custom exercise %: name already exists with a code', item->>'name';
    end if;

    if nullif(item->>'slug', '') is not null and exists (
      select 1 from library.exercises
      where slug = item->>'slug'
        and (coalesce(exercise_code, '') <> coalesce(item->>'exercise_code', '')
             or lower(trim(regexp_replace(name, '\s+', ' ', 'g'))) <> lower(item->>'name'))
    ) then
      raise exception 'Pankov exercise seed conflict for key %: slug already belongs to another exercise', item->>'package_key';
    end if;

    place_id := null;
    if nullif(item->>'place', '') is not null then
      select id into place_id from library.places where lower(name) = lower(item->>'place') limit 1;
      if place_id is null then
        insert into library.places (name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
        values (item->>'place', lower(regexp_replace(item->>'place', '[^a-zA-Z0-9]+', '-', 'g')), 'user', owner_user_id, created_by_user_id, true)
        returning id into place_id;
      end if;
    end if;

    complexity_id := null;
    if nullif(item->>'complexity', '') is not null then
      select id into complexity_id from library.complexity_levels where lower(name) = lower(item->>'complexity') limit 1;
      if complexity_id is null then
        insert into library.complexity_levels (name, slug, rank, owner_scope, owner_user_id, created_by_user_id, is_active)
        values (item->>'complexity', lower(regexp_replace(item->>'complexity', '[^a-zA-Z0-9]+', '-', 'g')), (select coalesce(max(rank), 0) + 1 from library.complexity_levels), 'user', owner_user_id, created_by_user_id, true)
        returning id into complexity_id;
      end if;
    end if;

    starting_position_id := null;
    if nullif(item->>'starting_position', '') is not null then
      select id into starting_position_id from library.starting_positions where lower(name) = lower(item->>'starting_position') limit 1;
      if starting_position_id is null then
        insert into library.starting_positions (name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
        values (item->>'starting_position', lower(regexp_replace(item->>'starting_position', '[^a-zA-Z0-9]+', '-', 'g')), 'user', owner_user_id, created_by_user_id, true)
        returning id into starting_position_id;
      end if;
    end if;

    attractor_id := null;
    if nullif(item->>'attractor', '') is not null then
      select id into attractor_id from library.attractors where lower(name) = lower(item->>'attractor') limit 1;
      if attractor_id is null then
        insert into library.attractors (kind, name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
        values ('local', item->>'attractor', lower(regexp_replace(item->>'attractor', '[^a-zA-Z0-9]+', '-', 'g')), 'user', owner_user_id, created_by_user_id, true)
        returning id into attractor_id;
      end if;
    end if;

    insert into library.exercises (
      owner_scope, owner_user_id, owner_club_id, owner_team_id, created_by_user_id, exercise_code, slug, name,
      aim, execution_notes, instruction, video_url, image_url, image_mime_type, place_id, complexity_level_id,
      starting_position_id, attractor_id, is_active
    ) values (
      item->>'owner_scope', owner_user_id, null, null, created_by_user_id, nullif(item->>'exercise_code', ''), item->>'slug', item->>'name',
      nullif(item->>'aim', ''), nullif(item->>'execution_notes', ''), nullif(item->>'instruction', ''), nullif(item->>'video_url', ''),
      nullif(item->>'image_url', ''), nullif(item->>'image_mime_type', ''), place_id, complexity_id, starting_position_id, attractor_id,
      coalesce((item->>'is_active')::boolean, true)
    ) returning id into inserted_exercise_id;

    sort_index := 0;
    for lookup_name in select jsonb_array_elements_text(item->'purposes') loop
      select id into lookup_id from library.domains where lower(name) = lower(lookup_name) limit 1;
      if lookup_id is null then
        insert into library.domains (name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
        values (lookup_name, lower(regexp_replace(lookup_name, '[^a-zA-Z0-9]+', '-', 'g')), 'user', owner_user_id, created_by_user_id, true) returning id into lookup_id;
      end if;
      insert into library.exercise_domains (exercise_id, domain_id, is_primary, sort_order) values (inserted_exercise_id, lookup_id, sort_index = 0, sort_index) on conflict do nothing;
      sort_index := sort_index + 1;
    end loop;

    sort_index := 0;
    for lookup_name in select jsonb_array_elements_text(item->'qualities') loop
      select id into lookup_id from library.categories where lower(name) = lower(lookup_name) limit 1;
      if lookup_id is null then
        insert into library.categories (name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
        values (lookup_name, lower(regexp_replace(lookup_name, '[^a-zA-Z0-9]+', '-', 'g')), 'user', owner_user_id, created_by_user_id, true) returning id into lookup_id;
      end if;
      insert into library.exercise_categories (exercise_id, category_id, is_primary, sort_order) values (inserted_exercise_id, lookup_id, sort_index = 0, sort_index) on conflict do nothing;
      sort_index := sort_index + 1;
    end loop;

    sort_index := 0;
    for lookup_name in select jsonb_array_elements_text(item->'groups') loop
      select id into lookup_id from library.sections where lower(name) = lower(lookup_name) limit 1;
      if lookup_id is null then
        insert into library.sections (name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
        values (lookup_name, lower(regexp_replace(lookup_name, '[^a-zA-Z0-9]+', '-', 'g')), 'user', owner_user_id, created_by_user_id, true) returning id into lookup_id;
      end if;
      insert into library.exercise_sections (exercise_id, section_id, is_primary, sort_order) values (inserted_exercise_id, lookup_id, sort_index = 0, sort_index) on conflict do nothing;
      sort_index := sort_index + 1;
    end loop;

    sort_index := 0;
    for lookup_name in select jsonb_array_elements_text(item->'body_parts') loop
      select id into lookup_id from library.body_parts where lower(name) = lower(lookup_name) limit 1;
      if lookup_id is null then
        insert into library.body_parts (name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
        values (lookup_name, lower(regexp_replace(lookup_name, '[^a-zA-Z0-9]+', '-', 'g')), 'user', owner_user_id, created_by_user_id, true) returning id into lookup_id;
      end if;
      insert into library.exercise_body_parts (exercise_id, body_part_id, is_primary, sort_order) values (inserted_exercise_id, lookup_id, sort_index = 0, sort_index) on conflict do nothing;
      sort_index := sort_index + 1;
    end loop;

    sort_index := 0;
    for lookup_name in select jsonb_array_elements_text(item->'movement_patterns') loop
      select id into lookup_id from library.movement_patterns where lower(name) = lower(lookup_name) limit 1;
      if lookup_id is null then
        insert into library.movement_patterns (name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
        values (lookup_name, lower(regexp_replace(lookup_name, '[^a-zA-Z0-9]+', '-', 'g')), 'user', owner_user_id, created_by_user_id, true) returning id into lookup_id;
      end if;
      insert into library.exercise_movement_patterns (exercise_id, movement_pattern_id, is_primary, sort_order) values (inserted_exercise_id, lookup_id, sort_index = 0, sort_index) on conflict do nothing;
      sort_index := sort_index + 1;
    end loop;

    for lookup_name in select jsonb_array_elements_text(item->'tags') loop
      select id into lookup_id from library.tags where lower(name) = lower(lookup_name) limit 1;
      if lookup_id is null then
        insert into library.tags (name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
        values (lookup_name, lower(regexp_replace(lookup_name, '[^a-zA-Z0-9]+', '-', 'g')), 'user', owner_user_id, created_by_user_id, true) returning id into lookup_id;
      end if;
      insert into library.exercise_tags (exercise_id, tag_id) values (inserted_exercise_id, lookup_id) on conflict do nothing;
    end loop;
  end loop;
end
$pankov_exercise_seed$;
