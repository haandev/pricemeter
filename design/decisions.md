# Implementation decisions (A77–)

Decisions taken while implementing the spec (`design/spec.md`). They extend Ek A; where they conflict with the spec, this file wins.

| # | Karar | Gerekçe |
| --- | --- | --- |
| A77 | Monorepo: **bun workspaces**, docs: **Astro Starlight → GitHub Pages**, paket: npm. §10'daki pnpm / Cloudflare Pages yerine D7 geçerli | D7 kapandı |
| A78 | `package.json` exports'a `./calendar` eklendi | A72 modülü getiriyor, §10 listesi eksikti |
| A79 | `graduated` için "artmayan fiyat" kuralı **kaldırıldı** | B3 (`[0: 0, 500: p]`) artan fiyatlı; kural B3'ü imkânsız kılıyordu |
| A80 | Hold üst sınırı her modelde: en pahalı kademe (`price/per`) × adet (package: `ceil(q/size)` blok) + tüm `flatMicroUsd` + (volume `on_crossing`) `usedSoFar × (pmax − pmin)`; `perObservation.max` ile kırpılır | A79 sonrası "ilk kademe" garantisi yok; en kötü durum her konumda geçerli (özellik testi) |
| A81 | `Rated.totalMicroUsd` hacim düzeltmesini **içermez**; düzeltme `adjustmentMicroUsd`, ayrı satır `…:adj` | Usage satırı = gözlemin kendi tutarı; düzeltme ayrı idempotent kalem |
| A82 | `usedSoFar` zorunluluğu: çok kademe, `volume`, `package`, herhangi bir `flatMicroUsd`, ya da `cumulative` (carry yoksa). Tek kademeli sabit ücret de ilk girişi bilmek zorunda | "Sessiz 0 yok" (A58) |
| A83 | `cumulative`: `usedSoFar` ile `floor(T(u+q)) − floor(T(u))` (tam telescoping); `carry` verilirse `floor(carry + Δ)`. Hacim `none` modelinde `T` tanımsız → `carry` gerekir | Sapmasızlık özelliği `T` üzerinden kanıtlanıyor |
| A84 | Aynı çağrıda aynı `(meter, dims)` satırları birbirinin `usedSoFar`'ını ilerletir; aynı sayaç tekrar ederse `refId` `#2`, `#3` eki alır | Çok satırlı gözlem tek tutarlı gözlem; refId çakışması veri kaybı olurdu |
| A85 | Sıfır tutarlı satır usage'a yazılır, ledger'a yazılmaz | "sayılır, 0 yazılır" + boş ledger kalemi yok |
| A86 | Yeni hata nedenleri: `invalid_ref`, `hold_exceeded`, `hold_closed` | Ref şeması doğrulanıyor; hold değer nesnesi olduğundan kapanmış/aşılmış hold yakalanmalı |
| A87 | `Hold` değer nesnesi her çağrıda **güncellenmiş** hâliyle döner (`result.hold`); `capture` sıra numarası refId'ye girer (`…:capture:n`) | Değer nesnesi + idempotensi: aynı eski hold ile retry aynı refId'yi üretir |
| A88 | Kısmi capture'lar teleskopik: `R(u, c+q) − R(u, c)`; hold tek gözlem gibi yuvarlanır | Aksi hâlde `per_event_up` parçalı capture'da üst sınırı aşar |
| A89 | Havuz sayaçları boyutsuzdur; havuz satırı `dims: {}` | Besleyen boyutlarından havuz boyutu türetilemez |
| A90 | Havuz miktarı `ceil(q × w)` float gürültüsünden arındırılır (12 hane) | `10 × 1.1` 12 değil 11 olmalı |
| A91 | `plan.observe` sonucu `lines` (fiyatlanmış satırlar, havuzlar dahil) döner; `metering.price(lines, …, { pools })` bunları tekrar fiyatlar | DO içinde gömülü `price()` (§9) için satırların tarifesi gerekir |
| A92 | `metering.commit(fn)` adapter bağlar, `metering.commit(plan)` plan yazar (argüman türüne göre) | §7 `metering.commit(plan)` kullanıyor |
| A93 | Tip düzeyinde durum: sayaçlar `MeterEntry` interface birliği; `meter()` dönüş tipi alias'sız yazılır | Alias önceki durumu alias argümanı olarak taşıyor, ~100 sayaçta TS2589. 500 sayaç: ~0,9 sn |
| A94 | `getRate` callback'i dört parametreyi de yazmalı (`_ctx`, `_at`) | TS birlik-tuple rest parametresinde eksik parametreli callback'i reddediyor |
| A95 | `typed<T>()` işaretçisi: `.meter("x", typed<{…}>())`, `.context(typed<C>())` ya da `.context<C>()` | Kısmi generic çıkarımı yok; düz tip için değer düzeyi işaretçi |
| A96 | Pratik zincir sınırı ~800 `.meter()`: TS parser'ı 1000 zincirli çağrıda yığını taşırıyor | Katalog bölünebilir; hedef 500 |
| A97 | B22 (işlem başı sabit): her işlem kendi dönemidir → `getRate` `usedSoFar: 0` döner (`tierPeriod: "observation"`) | `flatMicroUsd` "kademeye ilk giriş"; işlem başı ücret için her gözlem yeni dönem |
